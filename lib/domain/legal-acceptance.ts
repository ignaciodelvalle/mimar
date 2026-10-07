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

// ---------------------------------------------------------------------------
// SERVER ENFORCEMENT (security review of textos-legales-v14, 2026-10-07)
// ---------------------------------------------------------------------------
// The screens are not the boundary: `requireLiveUser` refuses an account that
// owes an acceptance (lib/infra/live-user.ts), so a write cannot slip past the
// re-acceptance screen by calling a server action or `/api/v1` directly.
//
// THE ONE EXCEPTION IS THE v13 ANDROID BUILD, and it is temporary. v13 predates
// the circuit: it has no screen to send anybody to, so refusing it would lock
// every v13 user out of the app until v14 is installed. It is recognised by the
// ABSENCE of the `x-app-version` header, which v14 and later always send, and it
// is let through until `LEGAL_V13_SUNSET` (an ISO date; unset = no sunset yet —
// the PO intends "v14 production date + 14 days"). After it, the same request
// gets 426 and "Actualizá la app desde Google Play". The web never qualifies.

/** The header v14+ sends on every `/api/v1` request. Its PRESENCE is what counts. */
export const APP_VERSION_HEADER = "x-app-version";

export type LegalGateVerdict = "refuse" | "allow-legacy-client" | "upgrade-required";

/**
 * What to do with a request from an account that owes an acceptance.
 *
 * `bearer` is true on the native path (a bearer token), false on the web's
 * cookie path. `sunset` is the raw `LEGAL_V13_SUNSET` value; anything that does
 * not parse as a date reads as "no sunset yet", which is the documented default
 * and the safe one for v13 users.
 */
export function legalGateVerdict(input: {
  bearer: boolean;
  appVersion: string | null | undefined;
  sunset: string | null | undefined;
  now: Date;
}): LegalGateVerdict {
  if (!input.bearer) return "refuse";
  if (input.appVersion !== null && input.appVersion !== undefined && input.appVersion !== "") {
    return "refuse";
  }
  const raw = input.sunset?.trim();
  if (!raw) return "allow-legacy-client";
  const sunset = new Date(raw);
  if (Number.isNaN(sunset.getTime())) return "allow-legacy-client";
  return input.now.getTime() >= sunset.getTime() ? "upgrade-required" : "allow-legacy-client";
}
