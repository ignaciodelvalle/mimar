// Re-evaluation helper for PPP classification (breed list + weight
// threshold, admin-rules-console ADR-3).
// Spec 2026-05-19-govt-business-rules-poc-design §4.5 + BR9.
//
// When admin creates / updates / deletes a `ppp_breed_list` OR
// `ppp_weight_threshold` row, all pets within the affected jurisdiction get
// re-evaluated via the SAME composed classifier the write-path uses
// (resolvePppClassificationForJurisdiction). The flag
// `pets.potentially_dangerous_breed` is flipped to match the new ruling
// and the human owners receive an urgent notification if the flag turned
// true (a false→true flip is the direction we surface — see the notif type
// comment below for why the reverse isn't).
//
// IMPORTANT: this is idempotent — running it twice produces the same end
// state. Safe to call from a cron OR inline after the rule write. Registered
// as the reevalHook for BOTH ppp_breed_list and ppp_weight_threshold in
// lib/infra/rule-types-effects.ts — either rule type changing triggers the
// SAME full re-evaluation (a pet's classification depends on both rules
// together, so a breed-list change can also need a weight re-check and
// vice versa).

import { and, asc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";

import { db, ownerships, petEvents, pets } from "@/db";

import { validateEventPayload } from "@/lib/events/event-schemas";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import {
  type PppRules,
  classifyPpp,
  resolvePppRulesForJurisdiction,
} from "@/lib/infra/ppp-classification";

export interface ReevalCounters {
  scanned: number;
  flippedToPpp: number;
  flippedToNonPpp: number;
  notified: number;
}

export interface ReevalResult extends ReevalCounters {
  /**
   * Keyset resume point when the sweep stopped early (deadline hit): the last
   * pet id processed. `null` when the scope was fully drained. Callers that
   * want cross-invocation resume can persist this and pass it back as
   * `afterPetId`; the cron route currently only uses it as an early-stop signal
   * (scope-level resume already re-covers the scope idempotently).
   */
  nextPetId: string | null;
}

export interface JurisdictionScope {
  country?: string;
  province?: string | null;
  locality?: string | null;
}

export interface ReevalOptions {
  /** Keyset cursor: process pets whose id sorts after this value. */
  afterPetId?: string | null;
  /**
   * Absolute wall-clock deadline (Date.now() ms). When set, the keyset loop
   * stops after the current batch once the deadline passes, bounding a single
   * huge scope's time so it can't blow the function budget. Omit (inline
   * callers) to run to completion — the write-path reeval MUST fully flip all
   * affected pets, so it never passes a deadline.
   */
  deadlineMs?: number;
}

// Keyset page size for the in-scope pet sweep (review 23 item 10): the scope
// used to load its ENTIRE matching population into memory in one query. Now
// paged, so memory is bounded regardless of scope size.
const PETS_BATCH_SIZE = 500;

/**
 * Re-evaluate the PPP flag for every dog whose jurisdiction matches `scope`.
 * The match uses the most-specific non-null field of `scope`:
 *   - scope.locality set → match pets with that exact locality
 *   - scope.province set → match pets with that province (regardless of locality)
 *   - scope.country set  → match pets with that country (regardless of province)
 *
 * Returns counts for observability + a list of notified user IDs for tests.
 */
export async function reEvaluatePppClassificationChange(
  scope: JurisdictionScope,
  options?: ReevalOptions,
): Promise<ReevalResult> {
  const country = scope.country ?? "AR";
  const province = scope.province ?? null;
  const locality = scope.locality ?? null;

  // Select dogs in scope (PPP applies to dogs only today) that have EITHER a
  // breed OR a weight on file — a dog with NEITHER can never classify as PPP
  // under either rule (breedInList needs a breed, weightHits needs a
  // weight), so scanning it is pure waste. This is a real scale concern, not
  // a micro-optimization: unlike the pre-weight-enforcement predecessor
  // (isNotNull(breed) only), a naive "all dogs in scope" scan blows up on
  // datasets where most dogs have neither field populated (the shared local
  // DB has ~36k dogs in AR but only ~32 with breed OR weight set — a
  // province-scoped sweep without this filter timed out scanning 11k+ rows
  // it could never flip).
  const baseConditions = [
    eq(pets.jurisdictionCountry, country),
    eq(pets.species, "dog"),
    or(isNotNull(pets.breed), isNotNull(pets.estimatedWeightKg)),
  ];
  if (province !== null) {
    baseConditions.push(eq(pets.jurisdictionProvince, province));
  }
  if (locality !== null) {
    baseConditions.push(eq(pets.jurisdictionLocality, locality));
  }

  const counters: ReevalResult = {
    scanned: 0,
    flippedToPpp: 0,
    flippedToNonPpp: 0,
    notified: 0,
    nextPetId: null,
  };

  // Cache resolved rules per DISTINCT (province, locality) tuple — a sweep
  // frequently covers many pets sharing the same jurisdiction, and
  // classification now needs 2 rules (breed + weight, up from 1
  // pre-weight-enforcement). Without this cache a country-wide sweep would
  // re-resolve both rules once PER PET instead of once per distinct
  // jurisdiction, which measurably slowed the reeval sweep in practice.
  // classifyPpp itself stays pure/sync — see lib/infra/ppp-classification.ts.
  const rulesCache = new Map<string, Promise<PppRules>>();
  function rulesFor(jurisdiction: {
    country: string;
    province: string | null;
    locality: string | null;
  }): Promise<PppRules> {
    const key = `${jurisdiction.country}|${jurisdiction.province ?? ""}|${jurisdiction.locality ?? ""}`;
    let cached = rulesCache.get(key);
    if (!cached) {
      cached = resolvePppRulesForJurisdiction(jurisdiction);
      rulesCache.set(key, cached);
    }
    return cached;
  }

  let cursor: string | null = options?.afterPetId ?? null;

  for (;;) {
    const rows = await db
      .select({
        id: pets.id,
        name: pets.name,
        breed: pets.breed,
        estimatedWeightKg: pets.estimatedWeightKg,
        publicToken: pets.publicToken,
        potentiallyDangerousBreed: pets.potentiallyDangerousBreed,
        jurisdictionCountry: pets.jurisdictionCountry,
        jurisdictionProvince: pets.jurisdictionProvince,
        jurisdictionLocality: pets.jurisdictionLocality,
      })
      .from(pets)
      .where(and(...baseConditions, ...(cursor ? [gt(pets.id, cursor)] : [])))
      .orderBy(asc(pets.id))
      .limit(PETS_BATCH_SIZE);

    if (rows.length === 0) break;

    for (const pet of rows) {
      cursor = pet.id;
      counters.scanned += 1;

      const weightKg =
        pet.estimatedWeightKg !== null ? Number.parseFloat(pet.estimatedWeightKg) : null;
      const rules = await rulesFor({
        country: pet.jurisdictionCountry,
        province: pet.jurisdictionProvince,
        locality: pet.jurisdictionLocality,
      });
      const nowPpp = classifyPpp("dog", pet.breed, Number.isNaN(weightKg) ? null : weightKg, rules);
      if (nowPpp === pet.potentiallyDangerousBreed) continue;

      // Flip the flag AND emit the paired fact in ONE tx: the pets.* column is a
      // dual-write cache, so a flip with no corresponding pet_events row would
      // violate event-pairing (Invariant #3) — the classification change would
      // exist only in the cache, unauditable and non-replayable. The event is a
      // system-authored pet_profile_updated carrying the single flag change. The
      // notify below stays OUTSIDE this tx on purpose: the flag must COMMIT
      // before the notify so a failed insert dead-letters (ARCH-P) rather than
      // rolling back the flip and losing the urgent alert forever.
      const flipEventPayload = validateEventPayload("pet_profile_updated", {
        changes: [
          {
            field: "potentially_dangerous_breed",
            old: pet.potentiallyDangerousBreed,
            new: nowPpp,
          },
        ],
        photo_replaced: false,
      });
      const flipNow = new Date();
      await db.transaction(async (tx) => {
        await tx.update(pets).set({ potentiallyDangerousBreed: nowPpp }).where(eq(pets.id, pet.id));
        await tx.insert(petEvents).values({
          petId: pet.id,
          eventType: "pet_profile_updated",
          occurredAt: flipNow,
          recordedAt: flipNow,
          recordedByUserId: null,
          authorRole: "system",
          payload: flipEventPayload,
        });
      });

      if (nowPpp) counters.flippedToPpp += 1;
      else counters.flippedToNonPpp += 1;

      if (nowPpp) {
        // Notify each active human owner of this pet. Copy is breed-flavored
        // when the breed drove the flip and weight-flavored when weight did
        // (or a generic message when both apply) — see notificationCopyFor.
        const breedLabel = (pet.breed ?? "").trim();
        const { notificationType, body } = notificationCopyFor(pet.name, breedLabel);

        const owners = await db
          .select({ userId: ownerships.ownerUserId })
          .from(ownerships)
          .where(and(eq(ownerships.petId, pet.id), isNull(ownerships.endedAt)));
        const userIds = owners
          .map((o) => o.userId)
          .filter((id): id is string => typeof id === "string");
        if (userIds.length > 0) {
          // Route through the canonical write path (createNotificationsBulk) rather
          // than a raw db.insert. This closes an ARCH-P silent-loss gap that was
          // specific to this sweep: the flag UPDATE above COMMITS before the notify,
          // so if a raw insert threw, the NEXT reeval run would see
          // `nowPpp === pet.potentiallyDangerousBreed` and `continue` — the urgent
          // PPP alert was lost forever, never retried. The service instead
          // dead-letters a failed insert (recoverable via the
          // drain-notification-dead-letter cron), and the stable dedupe key
          // `ppp-flip:${petId}:${userId}` makes a repeat sweep idempotent
          // (ON CONFLICT DO NOTHING) instead of re-notifying on every run.
          const result = await createNotificationsBulk(
            userIds.map((userId) => ({
              userId,
              notificationType,
              severity: "warning" as const,
              title: `Cambio en la regulación PPP que afecta a ${pet.name}`,
              body,
              relatedPetId: pet.id,
              ctaLabel: "Ver requisitos",
              ctaUrl: `/mis-mascotas/${pet.publicToken}`,
              dedupeKey: `ppp-flip:${pet.id}:${userId}`,
            })),
          );
          counters.notified += result.insertedCount;
        }
      }
    }

    if (rows.length < PETS_BATCH_SIZE) break; // fully drained → nextPetId stays null
    if (options?.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
      // Stopped early to protect the function budget. Report the resume point;
      // the scope is re-covered idempotently on a later run.
      counters.nextPetId = cursor;
      break;
    }
  }

  return counters;
}

/**
 * Best-effort notification copy selection. We don't know definitively WHICH
 * rule caused the flip without re-deriving both branches separately (the
 * composed resolver returns only the final boolean) — as a pragmatic
 * approximation, breed-list-driven copy is used whenever the pet's breed is
 * on file (the common case, matches pre-weight-enforcement copy exactly),
 * and the weight-specific notification type otherwise.
 */
function notificationCopyFor(
  petName: string,
  breedLabel: string,
): { notificationType: string; body: string } {
  if (breedLabel.length > 0) {
    return {
      // no-cta: copy fragment only — the caller's insert attaches
      // ctaLabel/ctaUrl ("Ver requisitos" → the pet profile).
      notificationType: "ppp_breed_list_updated_now_applies",
      body: `La raza de ${petName} (${breedLabel}) ahora figura en la lista de Animales Potencialmente Peligrosos de tu jurisdicción. Conocé los requisitos legales y, si corresponde, registrá la atestación.`,
    };
  }
  return {
    // no-cta: copy fragment only — the caller's insert attaches
    // ctaLabel/ctaUrl ("Ver requisitos" → the pet profile).
    notificationType: "ppp_weight_threshold_updated_now_applies",
    body: `El peso de ${petName} ahora supera el umbral de peso PPP de tu jurisdicción. Conocé los requisitos legales y, si corresponde, registrá la atestación.`,
  };
}
