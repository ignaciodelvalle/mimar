// Refresh the denormalized `pets.*` cache after an amendment (Invariant #3).
//
// WHY THIS EXISTS (F4 re-audit, review 22/1d):
// An amendment inserts an append-only `event_amended` row that overrides the
// CURRENT value of an earlier event's field (via overlayAmendments at every
// read boundary). But several `pets.*` columns are DENORMALIZED caches that
// writers dual-write in the same tx as the originating event. When the earlier
// event is corrected, those caches must be re-derived from the AMENDED stream
// in the SAME transaction — otherwise a correction supersedes in every
// projection EXCEPT the cache, which drifts invisibly from the spine.
//
// This is the single "refresh affected pet cache after amendment" mechanism,
// keyed by the ROOT (amended) event's type. Adding a new amendable type whose
// value lands in a pets cache column means adding one entry to REFRESH_BY_TYPE
// here — the dispatch is centralized so a new type can't silently skip it.
//
// The four cache-bearing amendable types today:
//   - weight_recorded          → pets.estimatedWeightKg  (replayPetWeight)
//   - clinical_info_logged     → pets.pregnancyStatus    (replayPetPregnancy,
//                                 no-op unless sub_kind=pregnancy)
//   - movement_recorded        → pets.jurisdiction*       (latest jurisdiction_changed
//                                 destination, canonicalized)
//   - vaccination_administered → reminders.due_at (K5)   (refreshVaccinationReminder,
//                                 no-op unless the amended payload's next_due_at
//                                 changed — the linked OPEN reminder's dueAt is
//                                 re-derived so pet-compliance.ts's deriveRabies
//                                 stops reading a stale reminder row)
// The other amendable types (deworming, vet visit, medication, note,
// sterilization) have NO pets cache column, so they map to nothing.

import { and, asc, eq, isNull } from "drizzle-orm";

import { arLocalities, type db, petEvents, pets, reminders } from "@/db";
import { normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { overlayAmendments } from "@/lib/infra/amendment";
import { replayPetPregnancy } from "@/lib/projections/pet-pregnancy";
import { replayPetWeight } from "@/lib/projections/pet-weight";
import type { AmendmentOverlaid } from "@/lib/projections/types";
import { provinceByCode } from "@/lib/reference/ar-provincias";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Event stream row shape that both overlayAmendments and the pure projections
// accept (id + eventType + occurredAt + recordedAt + payload).
type StreamEvent = {
  id: string;
  eventType: string;
  occurredAt: Date | string;
  recordedAt: Date | string;
  payload: unknown;
};

type OverlaidEvent = StreamEvent & { amendedAt: Date | string | null };
type OverlaidStream = AmendmentOverlaid<OverlaidEvent>;

/** Canonical uuid shape — see `refreshJurisdiction`'s `to_locality_id` guard. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Refresher = (
  tx: Tx,
  petId: string,
  overlaid: OverlaidStream,
  amendedEventId: string,
) => Promise<void>;

// Keyed by the ROOT (amended) event's type. Types absent from this map carry no
// denormalized pets cache and are intentional no-ops.
const REFRESH_BY_TYPE: Record<string, Refresher> = {
  weight_recorded: refreshWeight,
  clinical_info_logged: refreshPregnancy,
  movement_recorded: refreshJurisdiction,
  vaccination_administered: refreshVaccinationReminder,
};

/**
 * Re-derive the pets cache column(s) affected by an amendment, in the SAME tx
 * as the amendment insert. `amendedEventId` is the RESOLVED root event id (the
 * chain is always flattened to the root by amend-event.ts), so this also covers
 * amendment-of-amendment: the root event's type — read from the stream itself —
 * selects the refresher.
 */
export async function refreshPetCacheAfterAmendment(
  tx: Tx,
  petId: string,
  amendedEventId: string,
): Promise<void> {
  // Fetch the full stream once (includes the just-inserted event_amended row).
  const stream: StreamEvent[] = await tx
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(eq(petEvents.petId, petId))
    .orderBy(asc(petEvents.occurredAt), asc(petEvents.recordedAt), asc(petEvents.id));

  const root = stream.find((e) => e.id === amendedEventId);
  if (!root) return;

  const refresh = REFRESH_BY_TYPE[root.eventType];
  if (!refresh) return;

  // Project the amended payload onto its target event, then derive off that.
  const overlaid = overlayAmendments(stream);
  await refresh(tx, petId, overlaid, amendedEventId);
}

// ---------------------------------------------------------------------------
// Per-column refreshers
// ---------------------------------------------------------------------------

async function refreshWeight(tx: Tx, petId: string, overlaid: OverlaidStream): Promise<void> {
  const { estimatedWeightKg } = replayPetWeight(overlaid);
  await tx.update(pets).set({ estimatedWeightKg }).where(eq(pets.id, petId));
}

async function refreshPregnancy(tx: Tx, petId: string, overlaid: OverlaidStream): Promise<void> {
  const { pregnancyStatus } = replayPetPregnancy(overlaid);
  await tx.update(pets).set({ pregnancyStatus }).where(eq(pets.id, petId));
}

/**
 * K5: a vaccination_administered amendment that changes next_due_at must move
 * the linked reminder's dueAt too — otherwise pet-compliance.ts's deriveRabies
 * keeps reading the stale value it was created with (reminders.due_at is set
 * once, at vaccination-use-case.ts's insertReminders call, and never re-derived
 * on its own — see that use-case's `nextDueAt` block for the creation side).
 *
 * Lookup key: reminders.sourceEventId === the amended root event's id. This is
 * the SAME link vaccination-use-case.ts stamps at creation (`sourceEventId:
 * event.id`) — direct and unambiguous, no title/date matching needed. Only an
 * OPEN reminder (completedAt IS NULL) is touched: a reminder already completed
 * (dose since administered, or superseded by a later vaccination) must not be
 * revived by a correction to an older event.
 */
async function refreshVaccinationReminder(
  tx: Tx,
  petId: string,
  overlaid: OverlaidStream,
  amendedEventId: string,
): Promise<void> {
  const root = overlaid.find((e) => e.id === amendedEventId);
  if (!root) return;
  const payload = (root.payload ?? {}) as Record<string, unknown>;
  const nextDueRaw = typeof payload.next_due_at === "string" ? payload.next_due_at : null;
  if (!nextDueRaw) return;
  const nextDue = new Date(nextDueRaw);
  if (Number.isNaN(nextDue.getTime())) return;

  await tx
    .update(reminders)
    .set({ dueAt: nextDue })
    .where(
      and(
        eq(reminders.petId, petId),
        eq(reminders.reminderType, "vaccine"),
        eq(reminders.sourceEventId, amendedEventId),
        isNull(reminders.completedAt),
      ),
    );
}

/**
 * Jurisdiction cache = the destination of the LATEST movement_recorded whose
 * sub_kind is jurisdiction_changed (cvi_issued / transport_recorded never touch
 * it — R6.2). When the amended event is NOT the latest jurisdiction_changed move
 * (or there is none at all), the cache correctly stays at the true latest / the
 * registration value: this derivation always reflects the current head of the
 * amended stream. The destination is canonicalized against the INDEC catalog
 * exactly as recordMovementWriter does on the write path, so an off-catalog
 * amended locality can't fork the jurisdiction-keyed read paths.
 *
 * THE EVENT'S OWN ROW WINS OVER A NAME LOOKUP (L2-3, closed here 2026-09-07).
 * This runs on ANY amendment to ANY movement_recorded — the dispatch above is
 * keyed by the ROOT event's type, not by which field moved — so correcting a
 * `reason`, which is free text and legitimately editable from both surfaces, used
 * to re-resolve the destination BY NAME with `localityIndecId: null`.
 * `localityByName` settles a homonym alphabetically (`.orderBy(departmentName)
 * .limit(1)`, its own comment says so) and the INDEC catalogue ships 68
 * (province, name) collisions — four "San Pedro"s in Santiago del Estero. So a
 * correction that touched nothing about the destination silently relocated the
 * animal to the alphabetically first department: a different responding
 * authority, a different PPP regime, a different epidemiological unit.
 *
 * `recordMovementWriter` was fixed for this on the WRITE path (it stamps
 * `to_locality_id` from the same variable it writes into `pets.locality_id`);
 * this path was not, so it overruled the write on every later amendment. It now
 * reads that id and writes `pets.locality_id` from the row the EVENT names. Only
 * that column moves: the three TEXT columns stay derived by name, because a
 * homonym's names are identical anyway and `rederivePetCache` checks them against
 * the same name-based canonicalization — the id is the only thing a name lookup
 * cannot answer, and the only thing taken from it here.
 *
 * THE NAMES ARE CROSS-CHECKED, NOT OVERRULED — the posture `resolveByIndecId`
 * already takes for a claimed province. An amendment can move `to_locality` text
 * without moving the id (the web's form edits raw keys one at a time), and a
 * cache built from a row the payload no longer names would contradict the text
 * columns that `rederivePetCache` checks. When they disagree, the id is stale for
 * this purpose and the name path runs exactly as before.
 */
async function refreshJurisdiction(tx: Tx, petId: string, overlaid: OverlaidStream): Promise<void> {
  let latest: Record<string, unknown> | null = null;
  for (let i = overlaid.length - 1; i >= 0; i--) {
    const e = overlaid[i];
    if (e.eventType !== "movement_recorded") continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    if (payload.sub_kind !== "jurisdiction_changed") continue;
    latest = payload;
    break;
  }
  // No jurisdiction move in the stream → leave the registration jurisdiction.
  if (!latest) return;

  const toCountry = typeof latest.to_country === "string" ? latest.to_country : "AR";
  const toProvince = typeof latest.to_province === "string" ? latest.to_province : null;
  const toLocality = typeof latest.to_locality === "string" ? latest.to_locality : null;
  // SHAPE-CHECKED BEFORE IT REACHES A QUERY. The schema says `.uuid()`, but an
  // AMENDED payload is never re-validated — that is the defect this whole change
  // is about — and a non-uuid string here would make Postgres throw INSIDE the
  // amendment's transaction, turning a bad correction into a failed one.
  const toLocalityId =
    typeof latest.to_locality_id === "string" && UUID.test(latest.to_locality_id)
      ? latest.to_locality_id
      : null;

  let province = toProvince;
  let locality = toLocality;
  // Structural locality-attribution FK (migration 0147): re-derived here so the
  // denormalized pets.locality_id tracks the amended jurisdiction alongside the
  // free-text columns. Null when the destination does not resolve.
  let localityId: string | null = null;

  // (1) Mirror recordMovementWriter.canonicalizeMovement: only AR destinations
  // with both fields present are resolved; "soft" mode never throws (an
  // off-catalog pair falls through as-is). This settles the TEXT columns, which
  // is all it is trusted for.
  if (toCountry === "AR" && toProvince && toLocality) {
    const normalized = await normalizeLocationForWrite(
      {
        province: toProvince,
        provinceCode: null,
        locality: toLocality,
        localityIndecId: null,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "soft" },
    );
    province = normalized.province;
    // A within-province homonym comes back from "soft" with NO locality
    // (localidades-por-id A9: a name two municipalities share is not a place).
    // The text column keeps the event's own spelling, exactly as
    // `rederivePetCache` falls back to it (`normalized.locality ?? raw`) — so
    // the two sides of the drift check stay identical — and the ROW, which the
    // name cannot tell, comes only from the event's id in step (2).
    locality = normalized.locality ?? toLocality;
    localityId = normalized.localityId;
  }

  // (2) IDENTITY COMES FROM THE EVENT, not from the name lookup above. The
  // comparison is between two CANONICAL strings — the catalogue produced both,
  // so no second normalizer is needed and none is written here. A homonym passes
  // it by construction (that is what a homonym is), which is exactly the case the
  // id exists to settle; a destination whose text was amended to a different
  // locality fails it and keeps the name path's answer. Events predating
  // `to_locality_id` carry none and skip this entirely.
  if (toCountry === "AR" && toLocalityId) {
    const named = await localityRowById(tx, toLocalityId);
    if (
      named &&
      named.localityName === locality &&
      (provinceByCode(named.provinceCode)?.name ?? null) === province
    ) {
      localityId = named.id;
    }
  }

  await tx
    .update(pets)
    .set({
      jurisdictionCountry: toCountry,
      jurisdictionProvince: province,
      jurisdictionLocality: locality,
      localityId,
    })
    .where(eq(pets.id, petId));
}

/**
 * One `ar_localities` row by its uuid PK, read inside the amendment's tx.
 *
 * `lib/infra/ar-localidades.ts` has `localityByIndecId` and `localityByName` and
 * nothing keyed on the PK, because until now no read path held one: the id is
 * what write paths PRODUCE. `to_locality_id` is that same uuid (recordMovementWriter
 * stamps it from the variable it writes into `pets.locality_id`), so this is the
 * lookup that turns it back into a row. Removed rows are excluded — the catalogue
 * soft-deletes, and a destination whose row is gone must fall back to the name
 * path rather than re-point the cache at a retired locality.
 */
async function localityRowById(
  tx: Tx,
  localityId: string,
): Promise<{ id: string; provinceCode: string; localityName: string } | null> {
  const [row] = await tx
    .select({
      id: arLocalities.id,
      provinceCode: arLocalities.provinceCode,
      localityName: arLocalities.localityName,
    })
    .from(arLocalities)
    .where(and(eq(arLocalities.id, localityId), isNull(arLocalities.removedAt)))
    .limit(1);
  return row ?? null;
}
