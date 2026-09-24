// Use-case: set adoption eligibility for a pet.
//
// Receives a trusted actor context (auth already resolved by the action layer).
// Orchestrates: input validation → pet lookup → atomic DB write (pets update +
// adoption_eligibility_set event). Returns UseCaseResult<void>.
//
// The caller (thin action) is responsible for:
//   - requireCapability("intake.create")
//   - Parsing/casting the raw form input
//   - Flushing the returned notifications (none in this use-case)

import { validateEligibilityInput } from "../domain/eligibility-rules";
import type { EligibilityInput } from "../domain/types";
import type { AdoptionRepository } from "../infrastructure/adoption-repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
  organization: { id: string; publicToken: string; verified: boolean };
};

type Deps = {
  repo: typeof AdoptionRepository;
  actor: Actor;
  /** db.transaction — injected so unit tests can swap it for a fake. */
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type SetEligibilityInput = EligibilityInput & {
  petPublicToken: string;
};

export type UseCaseResult<T> =
  | { ok: true; value?: T; notifications: NewNotification[] }
  | { ok: false; error: string };

// Minimal notification shape (matches notifications.$inferInsert).
export type NewNotification = {
  userId: string;
  notificationType: string;
  title: string;
  body: string;
  /**
   * THE FOUR MEMBERS `notification_severity` ACTUALLY HAS. This union used to
   * carry a fifth, `"error"`, which the pgEnum in `db/schema.ts` does not: a row
   * built with it would have been rejected by Postgres at INSERT time, and the
   * raw insert this module used to flush through swallowed the rejection in a
   * `catch` that only logged. Nothing in the module ever produced one — the three
   * values in use are `info`, `success` and `warning` — so narrowing it is a
   * type error nobody can hit rather than a behaviour change, and it is what lets
   * the fan-out hand these rows to `notification-service.ts` without a cast.
   */
  severity: "info" | "success" | "warning" | "urgent";
  // Tab filter category for /notificaciones. Adoption-module notifications set
  // "adoption" so they surface in the adoption tab (the page groups by this
  // column; a null category is counted in "all" only and never in a tab).
  category?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  relatedPetId?: string | null;
  relatedEventId?: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function setAdoptionEligibility(
  input: SetEligibilityInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, actor, transaction } = deps;
  const { user, organization } = actor;

  // 1. Input validation (domain rules — pure).
  const domainInput: EligibilityInput = {
    eligible: input.eligible,
    ineligibleReason: input.ineligibleReason,
    ineligibleReasonNotes: input.ineligibleReasonNotes,
    ineligibleUntilIso: input.ineligibleUntilIso,
  };
  const validation = validateEligibilityInput(domainInput);
  if (!validation.ok) return { ok: false, error: validation.error };

  // 2. Load pet (repo lookup — no auth, auth was done at the action edge).
  const petRow = await repo.findShelterPet(input.petPublicToken, organization.id);
  if (!petRow) {
    return {
      ok: false,
      error: "Mascota no encontrada o no está bajo custodia de tu organización.",
    };
  }

  // 3. Snapshot previous state BEFORE writing (spec: event payload must carry previous_state).
  const previousState = {
    eligible: petRow.adoptionEligible,
    reason: petRow.adoptionIneligibleReason ?? null,
  };

  const now = new Date();
  const ineligibleUntil = input.ineligibleUntilIso ? new Date(input.ineligibleUntilIso) : null;

  // Idempotency guard (projection-writes audit §6): a double-submit posts the
  // exact same desired state twice. If the pet already holds that state, the
  // second write would only duplicate the adoption_eligibility_set event — so
  // it is a no-op, not a new event (desired-state semantics, same contract as
  // the disclosure/tier2 toggles).
  const desiredReason = input.eligible ? null : (input.ineligibleReason ?? null);
  const desiredNotes = input.eligible ? null : input.ineligibleReasonNotes?.trim() || null;
  const desiredUntilMs = input.eligible ? null : (ineligibleUntil?.getTime() ?? null);
  const currentUntilMs = petRow.adoptionIneligibleUntil
    ? new Date(petRow.adoptionIneligibleUntil).getTime()
    : null;
  const alreadyInDesiredState =
    petRow.adoptionEligible === input.eligible &&
    (petRow.adoptionIneligibleReason ?? null) === desiredReason &&
    (petRow.adoptionIneligibleReasonNotes ?? null) === desiredNotes &&
    currentUntilMs === desiredUntilMs;

  if (alreadyInDesiredState) {
    return { ok: true, notifications: [] };
  }

  // 4. Atomic write inside a transaction.
  await transaction(async (tx) => {
    await repo.setEligibility(
      {
        petId: petRow.id,
        eligible: input.eligible,
        ineligibleReason: input.eligible ? null : (input.ineligibleReason ?? null),
        ineligibleReasonNotes: input.eligible ? null : input.ineligibleReasonNotes?.trim() || null,
        ineligibleUntil: input.eligible ? null : ineligibleUntil,
        now,
        userId: user.id,
        orgId: organization.id,
        orgVerified: organization.verified,
        previousState,
      },
      tx as Parameters<typeof repo.setEligibility>[1],
    );
  });

  // No notifications for eligibility updates.
  return { ok: true, notifications: [] };
}
