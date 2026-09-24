"use server";

// lost-mode.ts — thin shim (strangler migration 61/61, 2026-06-30).
//
// Business logic moved to:
//   src/modules/pets/application/lost-mode/
//
// CRITICAL: Every runtime export in a "use server" file must be an async function.

import type { DisclosurePrefs } from "@/components/pet-profile/LostDisclosureCard";
import { requirePetAccess, requireTitularAccess } from "@/lib/infra/pet-access";
import { disclosureKeyRequiresTitular } from "@/src/modules/pets/application/lost-mode/disclosure-scope";
import { setPetDisclosurePrefs } from "@/src/modules/pets/application/lost-mode/set-pet-disclosure-prefs";

export async function setPetDisclosurePrefsAction(
  publicToken: string,
  key: keyof DisclosurePrefs,
  next: boolean,
): Promise<void> {
  // PER-KEY GUARD, not a blanket tightening (custodia-temporal T9.17).
  //
  // The five original toggles keep `requirePetAccess`, which a caretaker
  // passes. That is pre-existing behaviour over the TITULAR's own name, phone,
  // email and last-seen location, and narrowing it would also change what a
  // foster and a shelter_custody holder can do — a different decision.
  //
  // `discloseCaretakerContactWhenLost` is KEY 1 of the two-key public-contact
  // model: neither party can publish the other's contact alone — the caretaker
  // consents at accept (key 2), the titular decides whether to publish (key 1).
  // A caretaker who could flip key 1 would hold both, and key 2 would stop
  // meaning anything. The UI hides the row; this survives a hand-crafted call.
  const access = disclosureKeyRequiresTitular(key)
    ? await requireTitularAccess(publicToken)
    : await requirePetAccess(publicToken);
  if (!access.ok) throw new Error(access.error);
  // AWAITED, not returned: the writer answers whether it wrote (WU-M) and a
  // `"use server"` export's shape is a wire contract nobody asked to widen.
  await setPetDisclosurePrefs(access.pet.id, publicToken, key, next);
}
