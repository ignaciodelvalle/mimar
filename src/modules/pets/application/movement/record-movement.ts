// Writer: recordMovementWriter (movilidad-jurisdiccional Fase 1, Capability 6).
//
// Fork 4 — highest blast radius in the change. Write order (R6.1):
// ONE transaction, event INSERT first, then the pets.jurisdiction*
// denormalization. Event-insert failure prevents the column update — no
// denormalized state without a corresponding event. This is the same
// event-first-then-denormalize shape as recordPregnancyStartedWriter
// (pregnancyStatus) and prevents a microchipHeroTag-class divergence: two
// surfaces reading one fact from two stores after a partial write.
//
// Denormalization gate (R6.2): pets.jurisdictionCountry/Province/Locality are
// updated EXCLUSIVELY for sub_kind === "jurisdiction_changed". cvi_issued and
// transport_recorded MUST NOT touch those columns under any circumstance —
// every resolveBusinessRule call site keys off them (locality → province →
// country fallback), so a travel/CVI event writing them would retroactively
// shift the domestic 4-card compliance, the PPP jurisdiction gate, and every
// other jurisdiction-keyed read path. Regression-locked by
// __tests__/movement-writer.test.ts (S10).

import { eq, sql } from "drizzle-orm";

import { db, pets } from "@/db";
import { normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { findExistingByKey, insertEventIdempotent } from "@/lib/events/event-idempotency";
import { validateEventPayload } from "@/lib/events/event-schemas";

import type { MovementInput, RecordMovementParams, RecordMovementResult } from "./types";

/**
 * Canonicalize the destination jurisdiction of a jurisdiction_changed move
 * against the INDEC catalog BEFORE it is persisted (review 14 item 11). The
 * denormalized pets.jurisdiction* columns are read by every resolveBusinessRule
 * call site, so an un-canonicalized locality here would fork the PPP gate and
 * the domestic compliance cards off a spelling the catalog doesn't know.
 *
 * Only AR destinations with both province and locality present are resolved.
 * "soft" mode (never throws) is used deliberately: canonicalization must not
 * introduce a NEW hard rejection that breaks the atomic event-first write —
 * an off-catalog pair falls through as-is, exactly as before this hardening.
 * The action edge (recordMoveAction) applies the strict, user-facing rejection.
 *
 * THE EDGE'S ANSWER WINS WHEN THERE IS ONE (L2-2). A caller that already
 * resolved the destination — both of them do, strictly, and one of them can do
 * it by INDEC id — hands its `localityId` in and this function does not resolve
 * again. Re-resolving by NAME is not a harmless second opinion: `localityByName`
 * is province-scoped and settles a homonym alphabetically, so for the only case
 * an id can decide (two same-named localities of one province) the second
 * opinion silently overrules the first and `pets.locality_id` lands on the wrong
 * department.
 */
async function canonicalizeMovement(
  movement: MovementInput,
  resolvedLocalityId: string | null | undefined,
): Promise<{ movement: MovementInput; localityId: string | null }> {
  if (
    movement.sub_kind !== "jurisdiction_changed" ||
    movement.to_country !== "AR" ||
    !movement.to_province ||
    !movement.to_locality
  ) {
    return { movement, localityId: null };
  }

  // The caller resolved. Its names came from the same resolution (see
  // RecordMovementParams.resolvedLocalityId), so there is nothing left to
  // canonicalize and nothing to second-guess.
  if (resolvedLocalityId !== undefined) {
    return { movement, localityId: resolvedLocalityId };
  }

  const normalized = await normalizeLocationForWrite(
    {
      province: movement.to_province,
      provinceCode: null,
      locality: movement.to_locality,
      localityIndecId: null,
      lat: null,
      lng: null,
      address: null,
    },
    { locality: "soft" },
  );

  return {
    movement: {
      ...movement,
      to_province: normalized.province,
      to_locality: normalized.locality,
    },
    // Structural locality-attribution FK (migration 0147) for the denormalized
    // pets.locality_id — resolved from the same soft canonicalization. Null on a
    // soft miss, keeping the denormalization additive.
    localityId: normalized.localityId,
  };
}

/** A domain refusal raised inside the transaction — rolls it back, not an incident. */
class MovementRefusedError extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
  }
}

export async function recordMovementWriter(
  params: RecordMovementParams,
): Promise<RecordMovementResult> {
  const now = params.now ?? new Date();
  const key = params.clientIdempotencyKey ?? null;

  let eventId = "";
  let replayed = false;
  try {
    // Canonicalize the destination jurisdiction before both the event payload
    // and the denormalization so they never diverge (review 14 item 11).
    const { movement, localityId } = await canonicalizeMovement(
      params.movement,
      params.resolvedLocalityId,
    );

    // THE EVENT RECORDS THE ROW, NOT ONLY THE TWO NAMES (L2-3). `to_locality_id`
    // is stamped here, from the SAME variable the denormalization below writes
    // into `pets.locality_id`, so the spine and the cache cannot disagree about
    // which of two same-named localities this move landed on — and a
    // rederivation never has to re-resolve a homonym by name.
    const recorded: MovementInput =
      movement.sub_kind === "jurisdiction_changed"
        ? { ...movement, to_locality_id: localityId }
        : movement;

    // Validate BEFORE opening the transaction: an invalid payload (e.g. the
    // S2 no-op move) writes nothing at all.
    const payload = validateEventPayload("movement_recorded", recorded);

    await db.transaction(async (tx) => {
      // (0) viajes-fase-2 D4. A REPLAY answers the first write before any
      // domain refusal runs: the same request sent twice is not a duplicate of
      // itself. Then the refusal, under a per-pet lock so two different keys
      // racing for the same trip see each other.
      if (key) {
        const existing = await findExistingByKey(params.pet.id, "movement_recorded", key, tx);
        if (existing) {
          eventId = existing.id;
          replayed = true;
          return;
        }
      }
      if (params.refuseIf) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`movement:${params.pet.id}`}))`,
        );
        const refusal = await params.refuseIf(tx);
        if (refusal) throw new MovementRefusedError(refusal);
      }

      // (1) Event row FIRST — the immutable fact. Through the idempotency path
      // when the caller brought a key (a concurrent twin that slipped past the
      // lookup above lands on the unique index and answers the same row).
      const { event, wasNoop } = await insertEventIdempotent(
        {
          petId: params.pet.id,
          eventType: "movement_recorded",
          occurredAt: params.occurredAt,
          recordedAt: now,
          recordedByUserId: params.recordedByUserId,
          ...params.eventAuthorship,
          payload,
          notes: params.notes,
          clientIdempotencyKey: key,
        },
        tx as Parameters<typeof insertEventIdempotent>[1],
      );
      eventId = event.id;
      replayed = wasNoop;
      if (wasNoop) return;

      // (2) Denormalize ONLY for jurisdiction_changed (R6.2) — using the
      // canonicalized destination resolved above.
      if (movement.sub_kind === "jurisdiction_changed") {
        await tx
          .update(pets)
          .set({
            jurisdictionCountry: movement.to_country,
            jurisdictionProvince: movement.to_province,
            jurisdictionLocality: movement.to_locality,
            localityId,
          })
          .where(eq(pets.id, params.pet.id));
      }
    });
  } catch (err) {
    if (err instanceof MovementRefusedError) {
      return { ok: false, error: err.refusal, refusal: err.refusal };
    }
    return { ok: false, error: err instanceof Error ? err.message : "error desconocido" };
  }

  return { ok: true, eventId, replayed };
}
