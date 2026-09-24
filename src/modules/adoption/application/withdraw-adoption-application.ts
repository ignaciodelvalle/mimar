// Use-case: withdraw (retract) an adoption application — applicant flow.
//
// The APPLICANT retracts their own still-pending application. Receives the
// applicant user id (already validated by the action) and the application
// event id. Does NOT call requireCapability — applicants are public users
// and the action verifies they are logged in before calling this use-case.
//
// Orchestrates:
//   1. Auth check — must have an active session.
//   2. Load + guard: the application exists, belongs to THIS applicant, and is
//      still unresolved (no approved/rejected/closed/withdrawn resolution, and
//      the pet is not finalized). Same pending-derivation the postulaciones
//      list and the org review query use.
//   3. Atomic: insert adoption_application_resolved (outcome=withdrawn) inside
//      the tx — authored by the applicant (owner role, no org).
//   4. Collect an org-side notification for best-effort flush by the action.
//
// The caller (thin action) is responsible for:
//   - Auth check (user logged in)
//   - Flushing returned notifications post-transaction
//   - revalidatePath of the applicant + org surfaces

import type { AdoptionRepository } from "../infrastructure/adoption-repository";
import type { NewNotification, UseCaseResult } from "./set-adoption-eligibility";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Applicant = { userId: string } | null;

type Deps = {
  repo: typeof AdoptionRepository;
  applicant: Applicant;
  /** db.transaction — injected so unit tests can swap for a fake. */
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type WithdrawApplicationInput = {
  applicationEventId: string;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function withdrawAdoptionApplication(
  input: WithdrawApplicationInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, applicant, transaction } = deps;

  // 1. Auth check — must have an active session.
  if (!applicant) {
    return { ok: false, error: "Necesitás iniciar sesión para retirar tu postulación." };
  }

  // 2. Load + guard (applicant ownership + still-pending).
  const loaded = await repo.findApplicationForWithdrawal(
    input.applicationEventId,
    applicant.userId,
  );
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const { application, pet, org } = loaded;

  const now = new Date();
  const pendingNotifications: NewNotification[] = [];

  // 3. Atomic write — applicant-authored withdrawal resolution event.
  await transaction(async (tx) => {
    await repo.withdrawApplication(
      {
        petId: pet.id,
        applicationEventId: application.id,
        applicantUserId: applicant.userId,
        now,
      },
      tx as Parameters<typeof repo.withdrawApplication>[1],
    );

    // 4. Notify the shelter's admins/coordinators so the org knows a pending
    //    application disappeared (and isn't left wondering). Best-effort flush
    //    by the action.
    const orgMembers = await repo.findOrgMembersForNotify(
      org.id,
      tx as Parameters<typeof repo.findOrgMembersForNotify>[1],
    );
    for (const member of orgMembers) {
      pendingNotifications.push({
        userId: member.userId,
        notificationType: "adoption_application_withdrawn",
        category: "adoption",
        title: `Una postulación para ${pet.name} fue retirada`,
        body: "La persona retiró su postulación. Ya no aparece en las postulaciones pendientes.",
        severity: "info",
        ctaLabel: "Ver postulaciones",
        ctaUrl: `/org/${org.publicToken}/adopciones`,
        relatedPetId: pet.id,
        relatedEventId: application.id,
      });
    }
  });

  return { ok: true, notifications: pendingNotifications };
}
