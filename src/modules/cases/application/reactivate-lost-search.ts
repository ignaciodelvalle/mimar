// Use-case: reactivateLostSearch (pet-document-redesign ADR-18).
//
// Narrow carve-out for the STALE lost state: a lost_pet_episode was
// auto-closed by the >365d/60d-inactivity cron, but the closer deliberately
// leaves pets.status untouched (design decision — an auto-close must never
// silently declare the pet found). So the pet can sit with status='lost'
// and NO open episode. The normal setPetLostWriter can't reach this case —
// it early-returns "ya está marcada como perdida" for status='lost' — so
// reactivation opens a brand-new lost_pet_episode case directly, without a
// status_changed event (pets.status is already 'lost', nothing to change).
//
// This intentionally bypasses the general manualOpenAllowed=false rule for
// lost_pet_episode: that flag guards ad-hoc manual case creation by
// admins/govt with no triggering signal, not this kind-specific,
// owner-only, single-purpose reactivation path.
//
// Auth: enforced by the caller (app/actions/reactivate-lost-search.ts),
// which gates to the owner via requirePetAccess.

import { findOpenCaseForPetAndKind, openCase } from "@/lib/infra/case-helpers";

export type ReactivateLostSearchParams = {
  petId: string;
  petPublicToken: string;
  petStatus: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  openedByUserId: string;
};

export type ReactivateLostSearchResult =
  | { ok: true; caseId: string; alreadyOpen: false }
  | { ok: true; caseId: string; alreadyOpen: true }
  | { ok: false; error: string };

export async function reactivateLostSearch(
  params: ReactivateLostSearchParams,
): Promise<ReactivateLostSearchResult> {
  const {
    petId,
    petPublicToken,
    petStatus,
    jurisdictionProvince,
    jurisdictionLocality,
    openedByUserId,
  } = params;

  if (petStatus !== "lost") {
    return {
      ok: false,
      error: "Solo se puede reactivar una búsqueda para una mascota marcada como perdida.",
    };
  }

  // Anti-race guard (design risk note): if a concurrent request or a cron
  // sweep already reopened/left an open episode, don't open a second one —
  // lost_pet_episode has no reopen path, so duplicate opens would fork the
  // search into two untracked cases.
  const existing = await findOpenCaseForPetAndKind(petId, "lost_pet_episode");
  if (existing) {
    return { ok: true, caseId: existing.id, alreadyOpen: true };
  }

  const caseRow = await openCase({
    kind: "lost_pet_episode",
    primarySubjectKind: "registered_pet",
    primaryPetId: petId,
    jurisdictionProvince,
    jurisdictionLocality,
    openedByUserId,
    // The one writer that already spoke es-AR — it rendered correctly BY
    // ACCIDENT, via the free-text passthrough, with no rule at all. Naming a
    // code makes that deliberate and drops the English "pet" its prose carries.
    openedReason: { code: "lost_search_reactivated", petPublicToken },
  });

  return { ok: true, caseId: caseRow.id, alreadyOpen: false };
}
