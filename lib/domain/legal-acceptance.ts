// Legal re-acceptance — does this account owe an acceptance of the CURRENT
// legal version before it may keep using the product?
//
// WHY THIS EXISTS (2026-10-07, legal review 2026-10-02 rows P10/P11 and D5;
// PO decision D2 = b, conservative interim)
// ---------------------------------------------------------------------------
// Two findings needed the same mechanism:
//   · P11/D5 — "we may update these terms and will notify you by email" is an
//     abusive clause (Disp. 377/2026, inc. b). A substantive change needs a NEW
//     acceptance, so the product needs a screen that asks for one.
//   · P10 — accounts created before 2026-10-07 consented to the international
//     transfer inside the same box that accepted the Terms, which may not meet
//     Dec. 1558/2001 art. 5 inc. 1 ("expresa y destacada"). The re-acceptance
//     screen asks them for the separate transfer box (and the 18+ declaration,
//     review row P9), so they end up holding what a new account holds.
//
// WHO OWES IT
// ---------------------------------------------------------------------------
//   pending  <=>  account_type = 'personal'
//            AND  tos_version IS DISTINCT FROM LEGAL_VERSION   (NULL included)
//
// · PERSONAL ONLY. Institutional accounts (admin, govt, national) are created
//   by an administrator; their transfer rests on the providers' model clauses
//   (review rows P12/T3-2, a PO provider-contract action), not on a box. Not
//   gated.
// · NO RECORDED ACCEPTANCE IS NOT AN EXCEPTION (PO 2026-10-07). An account
//   older than migration 0087 never accepted anything, so it enters the
//   circuit like any other. Seed and e2e personas are stamped with the current
//   version by the seeds themselves (scripts/lib/seed-legal-acceptance.ts) so
//   they do not.
// · A PENDING IDENTITY IS THE CALLERS' TO EXCLUDE. Between signup step 1 and
//   step 2 the version is still NULL (step 2 records it); sending that person
//   to a second consent screen mid-signup would be wrong, so every caller that
//   gates checks `isIdentityPending` first (the (app) layout, login, and
//   `toMeV1User`, which answers the pending arm before this).
// · ANY VERSION OTHER THAN THE CURRENT ONE — not "older than". A version this
//   build does not know is not evidence of a newer acceptance.
//
// `tosVersion: undefined` (the column was NOT LOADED — a test double, an
// older select) reads as "nothing owed", never as a false gate. `null` (loaded,
// nothing recorded) is owed.

import { LEGAL_VERSION } from "@/lib/reference/legal-version";

export type LegalAcceptanceFacts = {
  accountType: "personal" | "institutional";
  tosAcceptedAt?: Date | string | null;
  tosVersion?: string | null;
};

export function isLegalAcceptancePending(facts: LegalAcceptanceFacts): boolean {
  if (facts.accountType !== "personal") return false;
  if (facts.tosVersion === undefined) return false;
  return facts.tosVersion !== LEGAL_VERSION;
}

/** The web route of the re-acceptance screen. Outside the `(app)` group, so the
 * layout that sends people there cannot also send them away from it. */
export const LEGAL_ACCEPTANCE_PATH = "/aceptar-condiciones";

/**
 * The re-acceptance URL carrying where the person was going. `returnTo` must
 * already be a safe same-origin path; the page re-checks it with
 * `safeReturnTo` before using it.
 */
export function legalAcceptanceHref(returnTo: string | null | undefined): string {
  if (!returnTo || returnTo === LEGAL_ACCEPTANCE_PATH) return LEGAL_ACCEPTANCE_PATH;
  return `${LEGAL_ACCEPTANCE_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}
