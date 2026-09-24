// Page identity + PII leak detection — the two predicates a smoke gate needs
// BEFORE it is allowed to report green.
//
// Dependency-free ON PURPOSE. Playwright specs cannot run in Vitest, so any
// logic that lives inside a `.spec.ts` is logic nobody can unit-test — and the
// two bugs this module exists to kill were both "an assertion that could not
// fail". They are pure functions here, pinned by __tests__/e2e-page-identity.test.ts,
// which parses the REAL app/**/not-found.tsx files the same way
// __tests__/seed-case-guards.test.ts parses the real migration DDL: copy and
// guard cannot drift apart in silence.
//
// ---------------------------------------------------------------------------
// Why this exists (two gates that passed without checking)
// ---------------------------------------------------------------------------
//
// P2.3 — e2e/csp-smoke.spec.ts pointed at `/p/DIM-DEMO-0001`, a token
// `pnpm db:bootstrap` never seeds. The not-found boundary is a tiny static page
// with no map, no QR and no lazy chunk: zero CSP violations. The suite printed
// GREEN for a route it never loaded. Same silent pass A7 found in
// a11y-regression (axe scoring a 404 "critical=0").
//
// A7's fix, `assertRealPage()`, matched only `/no encontramos esta página/i`.
// That is the (app) / admin / gob / root boundary copy. The `(public)` group —
// which is the group `/p/[token]` lives in, the exact route A7 was fixing —
// renders app/(public)/not-found.tsx, whose heading is
// "No encontramos esa CREDENCIAL". So the guard against the vacuous scan was
// itself vacuous on the route it guarded. That is why the pattern below is
// derived from every boundary in the tree and pinned by a parity test, and why
// BrandedNotFound also carries a copy-independent data-testid.
//
// P2.4 — e2e/synthetic-monitor.spec.ts asserted the public credential does not
// contain "Ignacio del Valle" (a demo-tier persona) while CI's owner@dim.test
// is "Lucía Tester". `not.toContain(<a name the page never had>)` is true no
// matter what the page leaks. `findPiiLeaks` takes the PII of the account
// ACTUALLY under test, resolved at runtime.

// ---------------------------------------------------------------------------
// Page identity
// ---------------------------------------------------------------------------

/**
 * Every branded not-found heading in the tree, mirrored from the `title` prop
 * of each app/**\/not-found.tsx (plus BrandedNotFound's own default).
 *
 * Keep in sync with those files — __tests__/e2e-page-identity.test.ts parses
 * them and fails if a boundary exists whose heading nothing here matches.
 */
export const BRANDED_NOT_FOUND_TITLES = [
  // app/not-found.tsx (root), app/(app), app/admin, app/gob, and the
  // BrandedNotFound default.
  "No encontramos esta página",
  // app/(public)/not-found.tsx — the credential boundary. The one A7's guard
  // missed.
  "No encontramos esa credencial",
  // app/(public)/denuncias/codigo/[code]/not-found.tsx — an unknown denuncia
  // reference code. Scoped away from the credential copy above because someone
  // holding a DEN-XXXX-XXXX code is looking for the cruelty report they filed,
  // and the shared boundary answered them about pets. This guard caught the new
  // file on its first full run, which is what it is for.
  "No encontramos ese código",
  // app/(public)/casos/[publicCode]/not-found.tsx — same scoping as the
  // denuncia code above, for CAS-XXXX-XXXX case codes (most case kinds are
  // not public by design, and the credential copy misnamed what the visitor
  // was looking for — 9-role external run, 2026-08-18).
  "No encontramos ese caso",
] as const;

/**
 * Next.js's own untranslated default, rendered when no not-found.tsx applies.
 * Not currently reachable (the root boundary catches everything) but a cheap
 * net: if someone deletes app/not-found.tsx this still refuses to measure.
 */
export const FRAMEWORK_NOT_FOUND_TITLE = "This page could not be found";

/** Matches ANY not-found boundary heading in this app. */
export const NOT_FOUND_HEADING = new RegExp(
  [...BRANDED_NOT_FOUND_TITLES, FRAMEWORK_NOT_FOUND_TITLE]
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "i",
);

/**
 * Stable, copy-independent hook on the shared 404 body. Rendered by
 * components/BrandedNotFound.tsx. Prefer this over the copy regex — a wording
 * change must never be able to disarm the guard.
 */
export const BRANDED_NOT_FOUND_TESTID = "branded-not-found";

/** Client/server error boundary text (Next.js + the app's own copy). */
export const CRASH_BOUNDARY = /application error|algo salió mal|something went wrong/i;

// ---------------------------------------------------------------------------
// PII leak detection
// ---------------------------------------------------------------------------

/**
 * The owner PII a public surface must never carry, resolved at runtime from the
 * account under test.
 *
 * SCOPE, and why it stops where it stops (AGENTS.md § Privacidad y manejo de
 * datos, and the disclosure contract in app/(public)/p/[publicToken]/page.tsx):
 *
 *  · displayName — never on the credential in ANY state. Always asserted.
 *  · email       — leaves the DB only when `pets.disclose_email_when_lost` is
 *                  true AND the pet is lost AND there is no custody dispute.
 *  · phone       — same, behind `pets.disclose_phone_when_lost`.
 *
 * So email/phone are CONDITIONAL disclosures, not absolute secrets: the caller
 * must assert the pet is in the baseline (non-lost) state before treating their
 * presence as a leak. `findPiiLeaks` does not know the pet's state — the spec
 * that calls it does, and says so.
 *
 * DELIBERATELY OUT OF SCOPE:
 *  · DNI — invariant #5: no plaintext DNI is stored at all (migration 0106
 *    dropped profiles.dni_number). There is no plaintext value that COULD leak.
 *    `dni_last4` is four digits and is operator-UI-only; matching four digits
 *    against an HTML body is a false-positive generator, not a check.
 *  · Address / jurisdiction — profiles carry only coarse province + locality,
 *    and the PET's own province/locality is legitimately printed on the public
 *    credential. Asserting on them would flag correct behaviour as a leak.
 */
export interface OwnerPii {
  displayName: string;
  email: string;
  /** null when the account under test has no phone on file. */
  phone: string | null;
}

export interface PiiLeak {
  field: "displayName" | "email" | "phone";
  /** What was found, for the failure message. */
  needle: string;
  /** How it was matched — literal substring, or digits-only for phones. */
  match: "literal" | "digits";
}

/** Digits only, so `+54 9 11 5555-1001` matches `tel:+5491155551001`. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Phones shorter than this are not matched digit-wise — too short to be
 * distinguishable from an id, a date or a price in an HTML body.
 */
const MIN_PHONE_DIGITS = 8;

/**
 * Owner PII present in `body`. Empty array means clean.
 *
 * Every needle is REQUIRED to be non-empty: a blank display name would make
 * `body.includes("")` true for every page, turning a leak detector into a
 * permanent false alarm — and a blank email would do the reverse if the check
 * were inverted. Blanks are a fixture bug, so they throw rather than silently
 * degrade the assertion (the exact failure mode this module exists to prevent).
 */
export function findPiiLeaks(body: string, pii: OwnerPii): PiiLeak[] {
  if (!pii.displayName.trim()) {
    throw new Error("findPiiLeaks: displayName is blank — resolve it before asserting.");
  }
  if (!pii.email.trim()) {
    throw new Error("findPiiLeaks: email is blank — resolve it before asserting.");
  }

  const leaks: PiiLeak[] = [];
  const haystack = body.toLowerCase();

  if (haystack.includes(pii.displayName.trim().toLowerCase())) {
    leaks.push({ field: "displayName", needle: pii.displayName, match: "literal" });
  }
  if (haystack.includes(pii.email.trim().toLowerCase())) {
    leaks.push({ field: "email", needle: pii.email, match: "literal" });
  }

  // A "phone" with fewer than MIN_PHONE_DIGITS digits is skipped ENTIRELY —
  // literal path included. Four digits match an order number, a year or a
  // price, and a leak detector that cries wolf gets muted, which is the same
  // outcome as one that cannot fire.
  const phoneDigits = pii.phone ? digitsOf(pii.phone) : "";
  if (pii.phone?.trim() && phoneDigits.length >= MIN_PHONE_DIGITS) {
    if (haystack.includes(pii.phone.trim().toLowerCase())) {
      leaks.push({ field: "phone", needle: pii.phone, match: "literal" });
    } else if (digitsOf(body).includes(phoneDigits)) {
      // Formatting-independent: catches tel: hrefs and any re-rendering that
      // drops the spaces and dashes the profile stores.
      leaks.push({ field: "phone", needle: phoneDigits, match: "digits" });
    }
  }

  return leaks;
}

/** One-line, greppable description of what leaked. */
export function describePiiLeaks(leaks: readonly PiiLeak[]): string {
  return leaks.map((l) => `${l.field} (${l.match}): ${l.needle}`).join("; ");
}
