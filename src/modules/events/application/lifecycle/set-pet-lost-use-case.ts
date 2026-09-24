// Use-case: setPetLost (writer + types)
//
// Migrated from app/actions/events.ts::setPetLostWriter + setPetLostAction.
//
// AUTH: requirePetAccess (accepts deceased/lost) at the action layer.
//   This writer is auth-agnostic (exported for integration tests without Next.js).
//
// Parity:
//   - Guard: status=lost → error "ya perdida"; status=deceased → error "fallecida".
//   - openCase(lost_pet_episode) INSIDE tx.
//   - PLAIN insert of status_changed with disclosure_prefs_snapshot + optional lost_description.
//   - updatePetLostProjection: status=lost + 5 disclosure cols + optional color/distinguishingFeatures.
//   - Retroactive microchip: ONLY when validatedRetroChipId && pet has no active canonical chip.
//     Guard reads from canonical pet_identifications (ARCH-S: legacy petMicrochipId param removed).
//     Validation via validateMicrochipId BEFORE the tx (error before any write).
//   - Retroactive tattoo: ONLY when rawTattooCode && pet has no active canonical tattoo.
//     Guard reads from canonical pet_identifications (ARCH-S: legacy petTattooCode param removed).
//   - broadcastLostPet post-tx (best-effort) when petPublicToken is provided.
//   - Result: { error: null | string }

import { writePoint } from "@/lib/domain/location";
import { validateMicrochipId } from "@/lib/domain/microchip-validation";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { normalizeTattooCode } from "@/lib/infra/tattoo-lookup";

import type { DisclosurePrefsInput } from "../../domain/disclosure-prefs";
import { parseDisclosurePrefsSnapshot } from "../../domain/disclosure-prefs";
import type { EventsRepository } from "../../infrastructure/events-repository";

type CaseExecutor = Parameters<typeof openCase>[1];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { DisclosurePrefsInput };

export type EnrichedLostDescriptionInput = {
  color: string | null;
  distinguishingFeatures: string | null;
  accessoriesWhenLost: string | null;
  behaviorNotes: string | null;
  lastSeenContext: string | null;
  microchipId: string | null;
  tattooCode?: string | null;
  tattooLocation?: string | null;
  tattooDescription?: string | null;
};

export type SetPetLostWriterParams = {
  petId: string;
  petPublicToken?: string;
  petName?: string;
  petStatus: string;
  petSpecies?: string | null;
  petBreed?: string | null;
  petColor?: string | null;
  petJurisdictionProvince?: string | null;
  petJurisdictionLocality?: string | null;
  ownerUserId?: string;
  ownerDisplayName?: string;
  fromStatus: string;
  recordedByUserId: string;
  eventAuthorship: Record<string, unknown>;
  locationDescription: string | null;
  locationLat: string | null;
  locationLng: string | null;
  /**
   * WHERE THE ANIMAL WENT MISSING, canonicalised, when the caller knows it.
   *
   * The case this use case opens is routed on these, and so is the alert
   * fan-out below. They default to the ANIMAL'S HOME jurisdiction, which is
   * what every caller got before 2026-09-11 and what a caller that cannot ask
   * still gets — but a dog lost in Córdoba is Córdoba's problem even when it
   * lives in CABA.
   *
   * WHAT THIS PAIR DOES AND DOES NOT REACH, measured rather than assumed. An
   * earlier version of this comment claimed `/gob/perdidas` and the panorama
   * cube read it. THEY DO NOT, and the claim was written without checking:
   *   · `lib/analytics/dashboards/perdidas.ts` scopes on
   *     `pets.jurisdictionProvince / jurisdictionLocality`.
   *   · `src/modules/lost/infrastructure/lost-listing-read.ts` filters the
   *     public listing on the same pet columns.
   *   · the lost KPIs count `pets.status`, not cases.
   * So this pair decides the CASE and the ALERTS; the lost listings and
   * counters still follow the animal's home address. That split is the bite
   * work unit's split too — it is the system's current shape, not something
   * introduced here — and closing it is a separate unit, because it also has
   * to answer an RLS question: `cases` RLS matches the case pair
   * (0034_cases_rls_expanded.sql) while pet-scoped RLS matches the pet pair
   * (0105_rls_defense_in_depth.sql), so an incident-jurisdiction official can
   * hold a case whose animal they cannot read.
   *
   * BOTH OR NEITHER. The fallback is a PAIR and not two independent defaults:
   * a province with no locality would route the case to (new province, pet's
   * locality), which names nowhere. `refineEventJurisdiction` in the contract
   * refuses the partial trio upstream; this is the same rule at the writer,
   * where a caller that never reads the contract still lands.
   */
  eventJurisdictionProvince?: string | null;
  eventJurisdictionLocality?: string | null;
  reason: string | null;
  disclosurePrefs: DisclosurePrefsInput;
  enrichedDescription?: EnrichedLostDescriptionInput | null;
  now?: Date;
};

export type SetPetLostWriterResult = { error: string | null };

// broadcastLostPet accepts typed PetForBroadcast; we pass any-typed shapes from
// the writer, so the params are intentionally loose. Aliasing `any` once keeps
// the single suppression valid even when the formatter wraps the signature.
// biome-ignore lint/suspicious/noExplicitAny: writer passes loosely-typed shapes to broadcastLostPet
type AnyBroadcastArg = any;
type BroadcastFn = (
  db: AnyBroadcastArg,
  pet: AnyBroadcastArg,
  owner: AnyBroadcastArg,
  lastLocation: AnyBroadcastArg,
  opts?: { episodeKey?: string | null },
) => Promise<AnyBroadcastArg>;

type Deps = {
  repo: Pick<EventsRepository, "insertEvent" | "updatePetLostProjection" | "insertIdentification">;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  broadcastLostPet: BroadcastFn;
};

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Core write path for marking a pet as lost.
 * Exported so integration tests can call it without the Next.js request context.
 * Same logic as setPetLostAction minus auth + form parsing + redirect.
 */
export async function setPetLostWriter(
  params: SetPetLostWriterParams,
  deps: Deps,
): Promise<SetPetLostWriterResult> {
  const {
    petId,
    petPublicToken = "",
    petName = "",
    petStatus,
    petSpecies = null,
    petBreed = null,
    petColor = null,
    petJurisdictionProvince = null,
    petJurisdictionLocality = null,
    ownerUserId = "",
    ownerDisplayName = "",
    fromStatus,
    recordedByUserId,
    eventAuthorship,
    locationDescription,
    locationLat,
    locationLng,
    eventJurisdictionProvince = null,
    eventJurisdictionLocality = null,
    reason,
    disclosurePrefs,
    enrichedDescription = null,
    now = new Date(),
  } = params;

  // THE PAIR, resolved once. See the note on the two input fields: the fallback
  // is all-or-nothing, so a caller that knows only the province gets the
  // animal's home pair rather than a province glued to somebody else's locality.
  const hasEventJurisdiction =
    eventJurisdictionProvince !== null && eventJurisdictionLocality !== null;
  const caseProvince = hasEventJurisdiction ? eventJurisdictionProvince : petJurisdictionProvince;
  const caseLocality = hasEventJurisdiction ? eventJurisdictionLocality : petJurisdictionLocality;

  if (petStatus === "lost") return { error: "Esta mascota ya está marcada como perdida." };
  if (petStatus === "deceased")
    return { error: "No se puede cambiar el estado de una mascota fallecida." };

  const {
    discloseFirstNameWhenLost,
    disclosePhoneWhenLost,
    discloseEmailWhenLost,
    discloseLastLocationWhenLost,
    allowFinderFormWhenLost,
  } = disclosurePrefs;

  const disclosurePrefsSnapshot = parseDisclosurePrefsSnapshot(disclosurePrefs);

  const { locationLat: latVal, locationLng: lngVal } = writePoint(
    locationLat && locationLng
      ? { lat: Number.parseFloat(locationLat), lng: Number.parseFloat(locationLng) }
      : null,
  );

  // Build lost_description if at least one incident snapshot field is provided.
  const hasIncidentSnapshot =
    enrichedDescription?.accessoriesWhenLost ||
    enrichedDescription?.behaviorNotes ||
    enrichedDescription?.lastSeenContext;

  const lostDescription = hasIncidentSnapshot
    ? {
        accessories_when_lost: enrichedDescription?.accessoriesWhenLost ?? null,
        behavior_notes: enrichedDescription?.behaviorNotes ?? null,
        last_seen_context: enrichedDescription?.lastSeenContext ?? null,
      }
    : null;

  // Validate retroactive chip format BEFORE the transaction (error before any DB write).
  const rawRetroChipId = enrichedDescription?.microchipId?.trim() || null;
  let validatedRetroChipId: string | null = null;
  if (rawRetroChipId) {
    const chipValidation = validateMicrochipId(rawRetroChipId);
    if (!chipValidation.ok) {
      return { error: "INVALID_MICROCHIP_FORMAT" };
    }
    validatedRetroChipId = chipValidation.normalized;
  }

  // Read canonical identifiers once — both retroactive guards use these results.
  // ARCH-S: legacy petMicrochipId / petTattooCode params removed; guard now reads
  // from the canonical pet_identifications table so the check is always accurate.
  const canonicalIds =
    rawRetroChipId || enrichedDescription?.tattooCode
      ? await fetchActiveIdentifications(petId)
      : { microchip: null, tattoo: null };

  // Captured inside the tx, read post-tx to key the broadcast fan-out so a
  // retry of THIS lost episode re-notifies nobody (review B.1). Each episode
  // opens a fresh case, so a genuinely new lost episode gets a new key.
  let episodeCaseId: string | null = null;

  try {
    await deps.transaction(async (tx) => {
      // Open a lost_pet_episode case atomically with the status_changed event.
      const caseRow = await openCase(
        {
          kind: "lost_pet_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          // WHERE IT HAPPENED, falling back to where the animal lives. This
          // used to read `petJurisdiction*` unconditionally, so every lost case
          // in the system claimed to have happened at the animal's address.
          jurisdictionProvince: caseProvince,
          jurisdictionLocality: caseLocality,
          openedByUserId: recordedByUserId,
          openedReason: {
            code: "pet_marked_lost",
            // Public token only. The prose falls back to the internal pet UUID
            // when there is no token (audit channel, byte-identical as ever);
            // the LABEL omits the id entirely instead of showing a UUID.
            petPublicToken: petPublicToken || null,
            ownerNote: reason || null,
          },
          openedReasonAudit: { petId },
        },
        tx as CaseExecutor,
      );
      episodeCaseId = caseRow.id;

      const eventPayload = validateEventPayload("status_changed", {
        from_status: fromStatus as "active" | "lost" | "deceased",
        to_status: "lost",
        location_description: locationDescription,
        reason,
        disclosure_prefs_snapshot: disclosurePrefsSnapshot,
        ...(lostDescription !== null ? { lost_description: lostDescription } : {}),
      });

      await deps.repo.insertEvent(
        {
          petId,
          eventType: "status_changed",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId,
          ...(eventAuthorship as object),
          locationLat: latVal,
          locationLng: lngVal,
          payload: eventPayload,
          caseId: caseRow.id,
        } as Parameters<typeof deps.repo.insertEvent>[0],
        tx as Parameters<typeof deps.repo.insertEvent>[1],
      );

      // Update status + 5 disclosure preference columns + optional identity fields.
      await deps.repo.updatePetLostProjection(
        petId,
        {
          status: "lost",
          discloseFirstNameWhenLost,
          disclosePhoneWhenLost,
          discloseEmailWhenLost,
          discloseLastLocationWhenLost,
          allowFinderFormWhenLost,
          ...(enrichedDescription?.color != null
            ? { color: enrichedDescription.color || null }
            : {}),
          ...(enrichedDescription?.distinguishingFeatures != null
            ? { distinguishingFeatures: enrichedDescription.distinguishingFeatures || null }
            : {}),
        },
        now,
        tx as Parameters<typeof deps.repo.updatePetLostProjection>[3],
      );

      // Retroactive microchip capture — only when validated chip AND pet has no active canonical chip.
      if (validatedRetroChipId && !canonicalIds.microchip) {
        const newChipId = validatedRetroChipId;
        const microchipPayload = validateEventPayload("microchip_implanted", {
          chip_number: newChipId,
          country_code: null,
          implanted_by: null,
          location_on_body: null,
        });

        await deps.repo.insertEvent(
          {
            petId,
            eventType: "microchip_implanted",
            occurredAt: now,
            recordedAt: now,
            recordedByUserId,
            ...(eventAuthorship as object),
            payload: microchipPayload,
          } as Parameters<typeof deps.repo.insertEvent>[0],
          tx as Parameters<typeof deps.repo.insertEvent>[1],
        );

        // Insert canonical microchip row in pet_identifications.
        // Legacy pets.microchipId write removed in ARCH-R.
        await deps.repo.insertIdentification(
          {
            petId,
            kind: "microchip_iso",
            code: newChipId,
            recordedAt: now.toISOString().slice(0, 10),
            recordedByUserId,
            isoCountryCode: newChipId.slice(0, 3),
            isoManufacturerCode: newChipId.slice(3, 7),
            isoNationalId: newChipId.slice(7, 15),
            isoCompliant: true,
          },
          tx as Parameters<typeof deps.repo.insertIdentification>[1],
        );
      }

      // Retroactive tattoo capture — only when code provided AND pet has no active canonical tattoo.
      const rawRetroTattooCode = enrichedDescription?.tattooCode?.trim() || null;
      if (rawRetroTattooCode && !canonicalIds.tattoo) {
        const normalizedTattoo = normalizeTattooCode(rawRetroTattooCode);
        if (normalizedTattoo) {
          const rawLoc = enrichedDescription?.tattooLocation ?? null;
          const validLocations: readonly string[] = [
            "inner_ear_left",
            "inner_ear_right",
            "inner_thigh",
            "belly",
            "other",
          ];
          const tattooLoc = rawLoc && validLocations.includes(rawLoc) ? rawLoc : null;
          const tattooDesc = enrichedDescription?.tattooDescription?.trim() || null;

          const tattooPayload = validateEventPayload("tattoo_recorded", {
            tattoo_code: normalizedTattoo,
            location_on_body: tattooLoc as
              | "inner_ear_left"
              | "inner_ear_right"
              | "inner_thigh"
              | "belly"
              | "other"
              | null,
            description: tattooDesc,
            recorded_by: null,
            recorded_at: null,
            tattoo_date_known: false,
          });

          await deps.repo.insertEvent(
            {
              petId,
              eventType: "tattoo_recorded",
              occurredAt: now,
              recordedAt: now,
              recordedByUserId,
              ...(eventAuthorship as object),
              payload: tattooPayload,
            } as Parameters<typeof deps.repo.insertEvent>[0],
            tx as Parameters<typeof deps.repo.insertEvent>[1],
          );

          // Canonical write to pet_identifications.
          // Legacy pets.tattooCode write removed in ARCH-R.
          const { petIdentifications } = await import("@/db");
          await (tx as { insert: typeof import("@/db").db.insert })
            .insert(petIdentifications)
            .values({
              petId,
              kind: "tattoo",
              code: normalizedTattoo,
              recordedAt: now.toISOString().slice(0, 10),
              recordedByUserId: recordedByUserId,
              tattooLocation: tattooLoc,
              tattooDescription: tattooDesc,
            });
        }
      }
    });
  } catch (err) {
    return {
      error: `No se pudo marcar como perdida: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  // Broadcast post-tx — best-effort (failure non-fatal).
  if (petPublicToken) {
    const broadcastColor =
      enrichedDescription?.color != null ? enrichedDescription.color || null : petColor;

    try {
      const { db } = await import("@/db");
      await deps.broadcastLostPet(
        db,
        {
          id: petId,
          publicToken: petPublicToken,
          name: petName,
          species: petSpecies,
          breed: petBreed,
          color: broadcastColor,
          jurisdictionProvince: petJurisdictionProvince,
          jurisdictionLocality: petJurisdictionLocality,
        },
        { id: ownerUserId, displayName: ownerDisplayName },
        // THE FAN-OUT FOLLOWS THE CASE, and this argument is the reason the
        // parameter exists: `broadcastLostPet` reads
        // `lastLocation?.province ?? pet.jurisdictionProvince`. It was being
        // passed `null`, so every alert went to the animal's HOME province.
        //
        // The first version of the incident-jurisdiction change moved the case
        // and left this line alone, which is worse than either end state: a dog
        // registered in CABA and lost in Villa Carlos Paz opened a Córdoba case
        // while only CABA organisations were told. Nobody in Córdoba would go
        // and look, and a Córdoba official would hold a case nobody there had
        // been alerted to. Caught in review before it shipped.
        //
        // Falls back on its own: when nobody said where, `caseProvince` IS the
        // pet's pair, so this reads exactly as it did before.
        { province: caseProvince, locality: caseLocality },
        { episodeKey: episodeCaseId },
      );
    } catch (err) {
      console.error("[setPetLost] broadcast failed (non-fatal):", err);
    }
  }

  return { error: null };
}
