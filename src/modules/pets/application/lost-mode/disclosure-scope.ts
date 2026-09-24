// Which lost-mode disclosure preferences are the TITULAR's alone.
//
// Pure, dependency-light, and separate from `set-pet-disclosure-prefs.ts` on
// purpose: the writer runs behind a guard, and the guard needs to consult the
// rule BEFORE deciding which guard to be. A predicate living inside the writer
// would be consulted too late to matter.
//
// WHY ANY OF THEM ARE TITULAR-ONLY
// ---------------------------------------------------------------------------
// `setPetDisclosurePrefsAction` gates on `requirePetAccess`, which a caretaker
// passes — they hold a Path-1 ownership row. That is fine for the five original
// toggles: they govern the TITULAR's own name, phone, email and last-known
// location, they predate this change, and narrowing them would also change what
// a foster or a shelter_custody holder can do today. Not this change's call.
//
// `discloseCaretakerContactWhenLost` is different in kind. It is KEY 1 of a
// TWO-KEY decision (PO decision 2, 2026-08-19) whose entire purpose is that
// neither party can publish the other's contact alone: the caretaker consents
// at invitation accept (key 2), the titular decides whether to actually publish
// (key 1). A caretaker who could flip key 1 would hold both, and the second key
// would stop meaning anything at all.

import type { DisclosurePrefs } from "@/components/pet-profile/LostDisclosureCard";

export type DisclosurePrefKey = keyof DisclosurePrefs;

/**
 * Disclosure keys a `caretaker` must not write.
 *
 * Keep this list minimal and justified. Every entry costs a caretaker a
 * legitimate affordance, and a list that grows by reflex ends up re-litigating
 * the five original toggles by accident.
 */
export const TITULAR_ONLY_DISCLOSURE_KEYS: readonly DisclosurePrefKey[] = [
  "discloseCaretakerContactWhenLost",
] as const;

const TITULAR_ONLY_SET: ReadonlySet<string> = new Set(TITULAR_ONLY_DISCLOSURE_KEYS);

export function disclosureKeyRequiresTitular(key: DisclosurePrefKey): boolean {
  return TITULAR_ONLY_SET.has(key);
}
