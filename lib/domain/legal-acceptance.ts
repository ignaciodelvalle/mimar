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
//            AND  tos_accepted_at IS NOT NULL
//            AND  tos_version <> LEGAL_VERSION
//
// · PERSONAL ONLY. Institutional accounts (admin, govt, national) are created
//   by an administrator and never saw a consent sentence; their data is
//   processed under the employment/agreement relationship, and the transfer for
//   them is the model-clauses question of review row P12 (a PO and counsel
//   decision), not a box. They are not gated.
// · A RECORDED ACCEPTANCE ONLY. `tos_accepted_at IS NULL` means the account
//   never went through a recorded signup: accounts older than migration 0087,
//   seed and demo accounts, and a brand-new account between signup step 1 and
//   step 2 (step 2 records the acceptance — gating that window would send a
//   person who is mid-signup to a second consent screen). Those are not gated
//   either. PO-DECISION: personal accounts older than 0087 with a completed
//   identity hold no recorded acceptance at all; gating them too means
//   stamping every seed account first, or every e2e and demo login lands on
//   this screen.
// · ANY VERSION OTHER THAN THE CURRENT ONE — not "older than". A version this
//   build does not know is not evidence of a newer acceptance; it is a value
//   nothing should have written, and asking again is the safe answer.
//
// Absent fields (`undefined`) read as "not pending". Callers that do not load
// the two consent columns — test doubles, older selects — must never gate
// anybody by accident; the columns are loaded by `getProfileCached` and by the
// login query, which are the two readers that decide.

import { LEGAL_VERSION } from "@/lib/reference/legal-version";

export type LegalAcceptanceFacts = {
  accountType: "personal" | "institutional";
  tosAcceptedAt?: Date | string | null;
  tosVersion?: string | null;
};

export function isLegalAcceptancePending(facts: LegalAcceptanceFacts): boolean {
  if (facts.accountType !== "personal") return false;
  if (facts.tosAcceptedAt === undefined || facts.tosAcceptedAt === null) return false;
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
