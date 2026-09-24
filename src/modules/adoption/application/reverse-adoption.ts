// Use-case: reverse a finalized adoption.
//
// This is the retraction of the composite custody event finalizeAdoption
// created. Emits `adoption_reversed` (append-only — the original
// `adoption_finalized` event is NEVER edited or deleted) and moves custody
// back to the ORG that finalized the adoption. PO-locked semantics
// (2026-07-21): custody reverts to the finalizing org's shelter_custody, and
// the listing does NOT auto-reopen — the pet lands back in the org's
// custody, UN-LISTED, and the org must explicitly re-publish it
// (setAdoptionListingStatusAction) to list it again.
//
// Mirrors finalizeAdoption's shape, in reverse:
//   finalize: close shelter_custody  -> insert owner row         -> adoption_finalized
//   reverse:  close owner row        -> insert shelter_custody   -> adoption_reversed
//
// Orchestrates:
//   1. Input validation (domain rules: reason length — pure)
//   2. Pet lookup (NO org-ownership constraint — the finalizing org may no
//      longer hold any active ownership row on this pet at all; that is
//      exactly what a finalized adoption does)
//   3. Reversibility gate (repo.findReversibleAdoption): finds the LATEST
//      adoption_finalized event authored by THIS org for this pet and
//      rejects when there is none / it was already reversed / custody has
//      since moved off that adopter. This is also what makes a double-
//      reverse a rejection rather than a silent no-op or duplicate event.
//   4. Atomic transaction (via repo.insertAdoptionReversed):
//      - Close the adopter's `owner` ownership row
//      - Insert a fresh `shelter_custody` ownership row for the org
//      - Force pets.adoption_listed_at / adoption_listing_paused_at to null
//      - Insert the adoption_reversed event
//   5. Collect a best-effort notification to the (former) adopter
//
// NOT handled here (stays in the action):
//   - requireCapabilityForOrgToken("adoption.finalize") — same capability as
//     finalize itself; an org admin's implicit grant already covers "or
//     admin" from the PO semantics.
//   - Parsing the raw input
//   - revalidatePath
//   - Flushing pendingNotifications (post-tx, best-effort)

import { ORG_CUSTODY_TAKEN_ERROR, isOrgCustodyCollision } from "@/lib/infra/org-custody";

import { validateReversalInput } from "../domain/reversal-rules";
import type { ReversalInput } from "../domain/types";
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

export type ReverseAdoptionInput = ReversalInput & {
  petPublicToken: string;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function reverseAdoption(
  input: ReverseAdoptionInput,
  deps: Deps,
): Promise<UseCaseResult<{ eventId: string }>> {
  const { repo, actor, transaction } = deps;
  const { user, organization } = actor;

  // 1. Input validation (domain rules — pure).
  const validation = validateReversalInput({ reason: input.reason });
  if (!validation.ok) return { ok: false, error: validation.error };

  // 2. Load pet — no org-ownership constraint (see doc comment above).
  const petRow = await repo.findPetByToken(input.petPublicToken);
  if (!petRow) {
    return { ok: false, error: "Mascota no encontrada." };
  }

  // 3. Reversibility gate: this org finalized it, not yet reversed, custody
  // still sits with that same adopter.
  const reversible = await repo.findReversibleAdoption(petRow.id, organization.id);
  if (!reversible.ok) return { ok: false, error: reversible.error };

  const now = new Date();
  let eventId = "";

  // 4. Atomic transaction.
  try {
    await transaction(async (tx) => {
      const { eventId: insertedEventId } = await repo.insertAdoptionReversed(
        {
          petId: petRow.id,
          userId: user.id,
          orgId: organization.id,
          orgVerified: organization.verified,
          adopterOwnershipId: reversible.adopterOwnershipId,
          finalizeEventId: reversible.finalizeEventId,
          reason: input.reason,
          now,
        },
        tx as Parameters<typeof repo.insertAdoptionReversed>[1],
      );
      eventId = insertedEventId;
    });
  } catch (err) {
    // One live ORG custody per pet (0195): the gate in findReversibleAdoption
    // is a pre-transaction read, so another org's intake can still commit
    // before the insert. The index is the last line; map it to the gate's
    // own sentence instead of the raw query text.
    if (isOrgCustodyCollision(err)) return { ok: false, error: ORG_CUSTODY_TAKEN_ERROR };
    return {
      ok: false,
      error: `No se pudo revertir la adopción: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  // 5. Post-tx: best-effort notification to the former adopter.
  const pendingNotifications: NewNotification[] = [];
  if (reversible.adopterUserId) {
    pendingNotifications.push({
      userId: reversible.adopterUserId,
      notificationType: "adoption_reversed",
      category: "adoption",
      title: `La adopción de ${reversible.petName} fue revertida`,
      body: `${organization.displayName} revirtió la adopción. La custodia de ${reversible.petName} volvió a la organización.`,
      severity: "warning",
      ctaLabel: "Ver detalles",
      ctaUrl: "/mis-mascotas",
      relatedPetId: petRow.id,
      relatedEventId: eventId,
    });
  }

  return { ok: true, value: { eventId }, notifications: pendingNotifications };
}
