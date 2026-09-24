// Use-case: submit an adoption application (applicant/public user flow).
//
// Receives the applicant user id (already validated by the action) and the
// input DTO. Does NOT call requireCapability — applicants are public users
// and the action verifies they are logged in before calling this use-case.
//
// Orchestrates:
//   1. Profile check (institutional blocked)
//   2. Pet + org lookup + listability check
//   3. Duplicate-pending check
//   4. Consent gate
//   5. Per-applicant rate limit — see below
//   6. Atomic: insert application event (inside tx)
//   7. Returns notifications for fan-out (action flushes post-tx, best-effort)
//
// The caller (thin action) is responsible for:
//   - Auth check (user logged in)
//   - Parsing/casting the raw form input
//   - Flushing returned notifications post-transaction
//
// THE RATE LIMIT IS IN HERE AND NOT IN A ROUTE (WU-U, 2026-08-30)
// ---------------------------------------------------------------------------
// The board's WU-U row says "the application flow earns its own rate limit
// here", and FLOW is the operative word: neither door had one before, and a
// ceiling placed on the bearer endpoint alone would be a ceiling a caller
// escapes by opening the web form. So it lives at the joint both doors already
// pass through, exactly as `revokeAllSessions` and `eraseSubjectDataFor` do.
// The derivation — and why the abuse this bounds is BREADTH rather than
// hammering — is in `adoption-application-limits.ts`.
//
// IT FAILS CLOSED, and that is the opposite of what the erasure decided.
// `eraseSubjectDataFor` fails OPEN because "an abuse control must not stand
// between a person and a legal right"; there is no legal right to apply for an
// adoption, nothing leaves the caller's control by waiting, and what a limiter
// outage would otherwise open is unmetered writes into every shelter's review
// queue. Same instrument, opposite direction, and the difference is which side
// pays for being wrong.

import { SYNTHETIC_PET_WRITE_REFUSED, isSyntheticPet } from "@/lib/domain/synthetic-pet";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";

import { validateApplicationInput } from "../domain/application-rules";
import { isListable } from "../domain/listing-rules";
import type { ApplicationInput } from "../domain/types";
import type { AdoptionRepository } from "../infrastructure/adoption-repository";
import {
  ADOPTION_APPLICATION_RATE_LIMITED_COPY,
  ADOPTION_APPLICATION_USER_BUCKET,
  ADOPTION_APPLICATION_USER_LIMIT,
} from "./adoption-application-limits";
import type { NewNotification, UseCaseResult } from "./set-adoption-eligibility";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Applicant = { userId: string } | null;

/** `"denied"` covers both an exhausted budget and a limiter that could not answer. */
export type ApplicantBudgetVerdict = "ok" | "denied";

type Deps = {
  repo: typeof AdoptionRepository;
  applicant: Applicant;
  /** db.transaction — injected so unit tests can swap for a fake. */
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  /**
   * Spend the applicant's own budget. Injected for the reason `transaction` is:
   * the unit tests run with no Postgres and a limiter is a DB write.
   *
   * OPTIONAL, AND THE DEFAULT IS THE REAL LIMITER. That direction is the whole
   * safety of the seam — a door that forgets to pass one gets the ceiling
   * rather than an exemption, so the only way to opt out is to write a fake on
   * purpose. `spendApplicantBudget` below is what production runs.
   */
  spendApplicantBudget?: (userId: string) => Promise<ApplicantBudgetVerdict>;
};

/**
 * The real budget, spent against `rate_limit_buckets`.
 *
 * FAILS CLOSED, which inverts what every other limiter in this repo does, and
 * the inversion is the point: `eraseSubjectDataFor` fails open because "an abuse
 * control must not stand between a person and a legal right", and `/me/
 * notifications` fails open because refusing would empty a person's own inbox
 * over rows that are only ever theirs. Neither reason holds here. Nobody has a
 * legal right to apply for an adoption, nothing of the applicant's is withheld
 * by waiting, and what an outage would otherwise open is unmetered writes into
 * every shelter's review queue — the one thing on this surface that is not the
 * caller's own.
 */
export async function spendApplicantBudget(userId: string): Promise<ApplicantBudgetVerdict> {
  try {
    await enforceRateLimit(
      ADOPTION_APPLICATION_USER_BUCKET,
      userId,
      ADOPTION_APPLICATION_USER_LIMIT,
    );
    return "ok";
  } catch (err) {
    if (!(err instanceof RateLimitError)) {
      reportError("adoption/submit-application-limit", err, { userId });
    }
    return "denied";
  }
}

export type SubmitApplicationInput = ApplicationInput & {
  petPublicToken: string;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function submitAdoptionApplication(
  input: SubmitApplicationInput,
  deps: Deps,
): Promise<UseCaseResult<{ eventId: string }>> {
  const { repo, applicant, transaction } = deps;

  // 1. Auth check — must have an active session.
  if (!applicant) {
    return { ok: false, error: "Necesitás iniciar sesión para postularte." };
  }

  // 2. Profile check — institutional accounts blocked.
  const profile = await repo.findApplicantProfile(applicant.userId);
  const applicantProfile = profile
    ? { accountType: profile.accountType }
    : { accountType: "personal" };
  const profileValidation = validateApplicationInput(
    { ...input },
    applicantProfile,
    null, // dup check is separate — done after listability
  );
  if (!profileValidation.ok && profileValidation.error.includes("institucional")) {
    return { ok: false, error: profileValidation.error };
  }

  // 3. Pet + org lookup and listability check.
  const petWithOrg = await repo.findPetForApplication(input.petPublicToken);
  if (!petWithOrg) {
    return { ok: false, error: "La mascota no existe o ya no está bajo custodia de un refugio." };
  }
  const { pet, org } = petWithOrg;
  // A seeded pet records no real act (lib/domain/synthetic-pet.ts). It is
  // never listed, but the token can still be posted to by hand.
  if (isSyntheticPet(pet)) return { ok: false, error: SYNTHETIC_PET_WRITE_REFUSED };

  const petSnapshot = {
    adoptionListedAt: pet.adoptionListedAt,
    adoptionListingPausedAt: pet.adoptionListingPausedAt,
    status: pet.status,
    adoptionEligible: pet.adoptionEligible,
    inCustodyDispute: pet.inCustodyDispute,
    rabiesObservationStatus: pet.rabiesObservationStatus,
  };
  const orgSnapshot = {
    verified: org.verified,
    orgType: org.orgType,
  };

  if (!isListable(petSnapshot, orgSnapshot)) {
    return { ok: false, error: `${pet.name} ya no está disponible para adopción.` };
  }

  // 4. Duplicate-pending check.
  const existing = await repo.findExistingApplication(pet.id, applicant.userId);

  // 5. Full application validation (consent + duplicate + text lengths).
  const fullValidation = validateApplicationInput(input, applicantProfile, existing);
  if (!fullValidation.ok) return { ok: false, error: fullValidation.error };

  // 6. The applicant's budget, spent LAST among the refusals and FIRST among
  //    the writes.
  //
  //    AFTER VALIDATION, deliberately, which is the order `eraseSubjectDataFor`
  //    reached for its own reason and this one reaches for a different one:
  //    every check above is free and refuses without touching the queue, so a
  //    person who mistyped a form, or tapped through to a pet that went off
  //    listing while they wrote, has spent nothing. The budget bounds LETTERS
  //    DELIVERED, and a refused submission delivers none.
  //
  //    A DUPLICATE COSTS NOTHING EITHER, and that matters more than it looks:
  //    `findExistingApplication` already makes a second application for the
  //    same animal impossible, so if this were spent first, the one thing a
  //    person is most likely to do twice — tap "Enviar" again after a timeout
  //    they could not see the result of — would be the thing that burns the
  //    budget they need for the next animal.
  const budget = deps.spendApplicantBudget ?? spendApplicantBudget;
  if ((await budget(applicant.userId)) === "denied") {
    return { ok: false, error: ADOPTION_APPLICATION_RATE_LIMITED_COPY };
  }

  // 7. Atomic insert (event only — org member fan-out notification data collected,
  //    actual DB insert is returned to the caller for post-tx flush).
  const now = new Date();
  let eventId = "";
  const pendingNotifications: NewNotification[] = [];

  await transaction(async (tx) => {
    const { eventId: insertedEventId } = await repo.insertApplication(
      {
        petId: pet.id,
        userId: applicant.userId,
        orgId: org.id,
        housingType: input.housingType,
        otherPets: input.otherPets ? input.otherPets.trim() || null : null,
        dailyRoutine: input.dailyRoutine ? input.dailyRoutine.trim() || null : null,
        notes: input.notes ? input.notes.trim() || null : null,
        motivation: input.motivation ? input.motivation.trim() || null : null,
        priorPets: input.priorPets ?? null,
        now,
      },
      tx as Parameters<typeof repo.insertApplication>[1],
    );
    eventId = insertedEventId;

    // Collect org member notifications (built inside tx so eventId is available,
    // but the actual DB insert happens outside the tx for best-effort semantics).
    const orgMembers = await repo.findOrgMembersForNotify(
      org.id,
      tx as Parameters<typeof repo.findOrgMembersForNotify>[1],
    );
    for (const member of orgMembers) {
      pendingNotifications.push({
        userId: member.userId,
        notificationType: "adoption_application_received",
        category: "adoption",
        title: `Nueva postulación para ${pet.name}`,
        body: "Una persona se postuló para adoptar. Entrá para revisar la historia y decidir.",
        severity: "info",
        ctaLabel: "Revisar postulación",
        ctaUrl: `/org/${org.publicToken}/adopciones/${insertedEventId}`,
        relatedPetId: pet.id,
        relatedEventId: insertedEventId,
      });
    }
  });

  return { ok: true, value: { eventId }, notifications: pendingNotifications };
}
