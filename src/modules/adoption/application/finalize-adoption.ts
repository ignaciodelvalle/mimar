// Use-case: finalize an adoption.
//
// This is the composite custody event. Migrated from app/actions/adoption.ts::finalizeAdoptionAction.
// Auth (adoption.finalize capability) is handled by the caller (thin action).
//
// Orchestrates:
//   1. Input validation (domain rules: DNI path or foster-shortcut path)
//   2. Pet lookup + eligibility gate
//   3. Active foster lookup
//   4. Adopter resolution (approved application, foster-shortcut, or DNI
//      lookup against REGISTERED accounts — stub creation removed, org-pilot-pack)
//   5. Pre-tx: find open custody case
//   6. Atomic transaction (via repo.insertAdoptionFinalized):
//      - Close shelter_custody
//      - Close foster + foster_placement case (if any)
//      - Insert owner row
//      - Insert adoption_finalized event
//      - Close custody_episode case
//      - Auto-reject pending applications cascade
//   7. Collect post-tx best-effort notifications
//   8. Return UseCaseResult with notifications array (action flushes)
//
// NOT handled here (stays in the action):
//   - requireCapability("adoption.finalize")
//   - Parsing formData
//   - Storage upload (pre-tx, before this use-case is called)
//   - revalidatePath / redirect
//   - Flushing pendingNotifications (post-tx, best-effort)

import {
  type EndedCaretakerGrant,
  notifyCaretakersOfHandoff,
} from "@/lib/infra/end-pet-ownerships";

import { validateFinalizationInput } from "../domain/finalize-rules";
import type { FinalizationInput } from "../domain/types";
import type { AdoptionRepository } from "../infrastructure/adoption-repository";
import type { NewNotification, UseCaseResult } from "./set-adoption-eligibility";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
  organization: {
    id: string;
    publicToken: string;
    verified: boolean;
    displayName: string;
  };
};

type Deps = {
  repo: typeof AdoptionRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type FinalizeAdoptionInput = FinalizationInput & {
  petPublicToken: string;
  /** Pre-uploaded contract attachment id (or null). Upload happens before tx. */
  contractAttachmentId: string | null;
  /** Supabase Storage path returned by the upload helper (null when no file). */
  contractStoragePath: string | null;
  /** MIME type returned by the upload helper (null when no file). */
  contractMimeType: string | null;
  /** Byte size of the stored file returned by the upload helper (null when no file). */
  contractFileSize: number | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeDni(raw: string): string {
  return raw.replace(/\D/g, "");
}

// Server backstop for the registered-adopter requirement (org-pilot-pack).
// The pre-submit check in FinalizeAdoptionForm surfaces the full refusal panel
// (QR + guidance); this string is the honest fallback rendered in the existing
// error box if the form is bypassed. It must never promise stub creation.
const ADOPTER_ACCOUNT_REQUIRED_MSG =
  "No encontramos una cuenta miMAR registrada con ese DNI. La persona adoptante tiene que registrarse en miMAR con su DNI antes de finalizar la adopción.";

// The custody row finalize read before its transaction is gone by the time the
// transaction locks it — a titular's withdraw (rehome-by-titular) or another
// hand-off committed in between. Said as what happened and what to do, not as
// a wrapped Postgres message.
const CUSTODY_GONE_MSG =
  "La custodia de esta mascota terminó antes de completar la adopción: el titular dio de baja el acompañamiento o la custodia cambió de manos. Recargá la página para ver el estado actual.";

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function finalizeAdoption(
  input: FinalizeAdoptionInput,
  deps: Deps,
): Promise<UseCaseResult<{ eventId: string }>> {
  const { repo, actor, transaction } = deps;
  const { user, organization } = actor;

  // 1. Load pet from shelter custody (repo lookup — no auth inside use-case).
  const petRow = await repo.findShelterPet(input.petPublicToken, organization.id);
  if (!petRow) {
    return {
      ok: false,
      error: "Mascota no encontrada o no está bajo custodia de tu organización.",
    };
  }

  // 2. Eligibility gate.
  if (petRow.adoptionEligible !== true) {
    if (petRow.adoptionEligible === false) {
      const reasonLabel = petRow.adoptionIneligibleReason ?? "sin motivo registrado";
      return {
        ok: false,
        error: `Esta mascota está marcada como no apta para adopción (motivo: ${reasonLabel}). Resolvé el motivo desde el perfil del pet antes de finalizar.`,
      };
    }
    return {
      ok: false,
      error:
        "Esta mascota no fue evaluada para adopción todavía. Marcala como apta desde su perfil antes de finalizar.",
    };
  }

  // 3. Active foster lookup (optional).
  const fosterRow = await repo.findActiveFoster(petRow.id);
  const fosterUserId = fosterRow?.ownerUserId ?? null;

  // 4. Input validation (domain rules: application / DNI / foster-shortcut path).
  const domainInput: FinalizationInput = {
    applicationEventId: input.applicationEventId,
    adopterUserId: input.adopterUserId,
    adopterDni: input.adopterDni,
    adopterDisplayName: input.adopterDisplayName,
    adopterPhone: input.adopterPhone,
    followupMonths: input.followupMonths,
    notes: input.notes,
  };
  const validation = validateFinalizationInput(domainInput, fosterRow);
  if (!validation.ok) return { ok: false, error: validation.error };

  // 5. Resolve adopter identity. EVERY branch below lands on a REAL registered
  // account — stub creation is gone (see the manual-DNI branch), so there is no
  // longer a "stub adopter" mode for downstream writes to special-case.
  let adopterUserId: string;
  // Set only on the approved-application path — links the finalization back to
  // the online application in the event log.
  let adoptedFromApplicationId: string | null = null;

  if (input.applicationEventId) {
    // Approved-application path: transfer ownership to the applicant's real
    // account (they applied logged-in — we already have their user id). This
    // is what closes the 100%-digital adoption loop: the pet lands in the
    // adopter's /mis-mascotas, not on a typed-DNI stub profile.
    const approved = await repo.findApprovedApplicationForFinalize(
      input.applicationEventId,
      organization.id,
      petRow.id,
    );
    if ("error" in approved) return { ok: false, error: approved.error };
    adopterUserId = approved.applicantUserId;
    adoptedFromApplicationId = input.applicationEventId;
  } else if (input.adopterUserId) {
    // Foster-shortcut: adopterUserId is the foster's profile id.
    // validateFinalizationInput already confirmed the foster match; now validate profile.
    const adopterProfile = await repo.findApplicantProfile(input.adopterUserId);
    if (!adopterProfile) {
      return { ok: false, error: "No encontramos el perfil del adoptante." };
    }
    if (
      adopterProfile.accountType !== "personal" ||
      adopterProfile.role !== "owner" ||
      !adopterProfile.dniVerified
    ) {
      return {
        ok: false,
        error:
          "El adoptante debe ser una cuenta personal con DNI verificado para usar el atajo de tránsito.",
      };
    }
    adopterUserId = adopterProfile.id;
  } else {
    // Manual DNI path — REGISTERED accounts only (org-pilot-pack).
    //
    // Match contract (spec-reconciliation ruling): dniHash equality AND a
    // corresponding auth.users row EXISTS. dniVerified is NOT required — a
    // walk-in adopter who registered on the spot has dniVerified=false and
    // must still match. A legacy stub profile (matching hash, no auth row)
    // REFUSES: adopting onto an unclaimable profile is the dead-end this
    // change removes. Stub creation (randomUUID + a stub-profile insert) is
    // gone for good — the branch is removed, not feature-flagged.
    const rawDni = input.adopterDni ?? "";
    const dni = normalizeDni(rawDni);

    const account = await repo.findAdopterAccountByDni(dni);
    if (!account || !account.hasAuthAccount) {
      return { ok: false, error: ADOPTER_ACCOUNT_REQUIRED_MSG };
    }
    adopterUserId = account.id;
  }

  // 6. Pre-tx: find open custody_episode case (null if never intaked).
  const custodyCase = await repo.findOpenCustodyCase(petRow.id);
  const custodyCaseId = custodyCase?.id ?? null;

  const now = new Date();
  const followupMonths =
    input.followupMonths !== null ? Math.min(36, Math.max(0, input.followupMonths)) : null;

  const pendingNotifications: NewNotification[] = [];
  // Filled inside the transaction, flushed after it commits (ARCH-P). A
  // caretaker whose arrangement this finalize ended lost write access and the
  // pet dropped off their list; without this they are never told the title
  // moved, and they may still physically have the animal.
  let endedGrants: EndedCaretakerGrant[] = [];
  let eventId = "";
  let custodyGone = false;

  // 7. Atomic transaction.
  try {
    await transaction(async (tx) => {
      // The pet advisory lock FIRST (WU5 review, lock order): the titular's
      // withdraw takes the same lock before ITS row locks, so the custody-row
      // lock below and the owner-row close inside insertAdoptionFinalized can
      // no longer deadlock against the withdraw's owner-row lock + custody close.
      await repo.acquirePetAdvisoryLock(
        petRow.id,
        tx as Parameters<typeof repo.acquirePetAdvisoryLock>[1],
      );

      // The custody row, LOCKED, before anything is written (rehome-by-titular,
      // WU5 carry-forward 3). Step 1's read is pre-transaction and stale by
      // construction; the titular's withdraw ends this exact row in its own
      // transaction and the spec gives that withdraw the right of way (REQ-8).
      // Locked here, the withdraw either waits behind this finalize or has
      // already committed — in which case the row is ended, nothing below may
      // run, and the org reads a sentence instead of an adoption over a closed
      // custody (or two contradictory `rehome_sponsorship_ended` events).
      const lockedCustody = await repo.lockLiveCustodyRow(
        petRow.custodyOwnershipId,
        tx as Parameters<typeof repo.lockLiveCustodyRow>[1],
      );
      if (!lockedCustody) {
        custodyGone = true;
        return;
      }

      const { eventId: insertedEventId, endedCaretakerGrants } = await repo.insertAdoptionFinalized(
        {
          petId: petRow.id,
          userId: user.id,
          orgId: organization.id,
          orgVerified: organization.verified,
          custodyOwnershipId: petRow.custodyOwnershipId,
          adopterUserId,
          fosterRow,
          fosterUserId,
          custodyCaseId,
          contractAttachmentId: input.contractAttachmentId,
          contractStoragePath: input.contractStoragePath,
          contractMimeType: input.contractMimeType,
          contractFileSize: input.contractFileSize,
          followupMonths,
          notes: input.notes,
          adoptedFromApplicationId,
          orgDisplayName: organization.displayName,
          petName: petRow.name,
          now,
        },
        tx as Parameters<typeof repo.insertAdoptionFinalized>[1],
      );
      eventId = insertedEventId;
      endedGrants = endedCaretakerGrants;

      // Auto-rejection cascade for pending applications.
      const pendingApps = await repo.findPendingApplicationsExcluding(
        petRow.id,
        adopterUserId,
        tx as Parameters<typeof repo.findPendingApplicationsExcluding>[2],
      );

      for (const app of pendingApps) {
        await repo.resolveApplication(
          {
            petId: petRow.id,
            applicationEventId: app.applicationId,
            outcome: "rejected",
            reviewerUserId: user.id,
            orgId: organization.id,
            orgVerified: organization.verified,
            reason: "another_application_finalized",
            autoGenerated: true,
            notes: null,
            now,
          },
          tx as Parameters<typeof repo.resolveApplication>[1],
        );
        pendingNotifications.push({
          userId: app.applicantUserId,
          notificationType: "adoption_application_closed",
          category: "adoption",
          title: `${petRow.name} encontró hogar`,
          body: `${petRow.name} fue adoptado/a por otra postulación. Sabemos que es decepcionante. ${organization.displayName} tiene otras mascotas en adopción.`,
          severity: "info",
          ctaLabel: "Ver otras en adopción",
          ctaUrl: "/adoptar",
          relatedPetId: petRow.id,
        });
      }
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo finalizar la adopción: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }
  if (custodyGone) return { ok: false, error: CUSTODY_GONE_MSG };

  // 8. Post-tx: collect additional notifications (not flushed here — action does it).
  // The adopter always has a real account, so this notification always has a
  // reachable inbox (it used to be skipped for stub adopters).
  pendingNotifications.push({
    userId: adopterUserId,
    notificationType: "adoption_finalized",
    category: "adoption",
    title: `Adoptaste a ${petRow.name}`,
    body: `${organization.displayName} te registró como dueño/a de ${petRow.name}. Bienvenida a la familia.`,
    severity: "success",
    ctaLabel: "Ver mascota",
    ctaUrl: "/mis-mascotas",
    relatedPetId: petRow.id,
  });

  if (fosterUserId && fosterUserId !== adopterUserId) {
    pendingNotifications.push({
      userId: fosterUserId,
      notificationType: "foster_ended_by_adoption",
      category: "adoption",
      title: `${petRow.name} fue adoptado/a`,
      body: `El tránsito que tenías a cargo se cerró: ${petRow.name} encontró un hogar permanente.`,
      severity: "success",
      ctaLabel: "Ver detalles",
      ctaUrl: "/mis-mascotas",
      relatedPetId: petRow.id,
    });
  }

  // Same courtesy the foster above already gets, for the same reason: someone
  // who was looking after this animal just lost access to it. Sent directly
  // rather than pushed onto pendingNotifications because the copy and the
  // dedupe family belong with the hand-off primitive — the expiry cron uses the
  // same keys and must not be able to double-notify.
  if (endedGrants.length > 0) {
    await notifyCaretakersOfHandoff(endedGrants, {
      name: petRow.name,
      publicToken: input.petPublicToken,
    });
  }

  return { ok: true, value: { eventId }, notifications: pendingNotifications };
}
