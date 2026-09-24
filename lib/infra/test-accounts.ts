// Test / smoke account detection for the identity consoles (/admin/usuarios,
// /admin/govts).
//
// WHY: local + staging environments accumulate ephemeral accounts from genesis
// cold-start runs and e2e smoke suites (handles like `govt-gen-abcd@dim.test`,
// `uc-cd-admin`, `govt-dashboard-export`). Dozens of them bury the handful of
// real operators, making the roster unusable. These consoles default such rows
// OUT of the primary view behind a "mostrar cuentas de prueba" toggle.
//
// This is a UI-LEVEL filter, deliberately not a seed/schema change: production
// carries no such rows, so the filter is harmless there, and it never mutates
// data (safer than editing seeds — see the console pages' toggle wiring).
//
// The patterns match the handles the seed/e2e scripts generate — a real operator
// account never carries them:
//   - `-gen-`               genesis cold-start churn (govt-gen-*, lucia-gen-*, …)
//   - `uc-cd-` prefix       cursor-driven smoke accounts (uc-cd-admin, …)
//   - `govt-dashboard-export` the dashboard-export e2e fixture
//   - `+cursor-`            plus-addressed bulk-load accounts (2026-08-01)
//
// The `-gen-` match is intentionally broad: for this filter's purpose a false
// NEGATIVE (a test account left in the roster) defeats the goal, while a false
// positive (a rare real handle hidden) is fully recoverable via the "mostrar
// cuentas de prueba" toggle. No real operator handle carries `-gen-` today.
//
// `+cursor-` added 2026-08-01. The QA team's staging load runs as
// qa-maintainer+cursor-ownerN@example.com (scripts/bulk-cursor-pets-staging.mjs),
// and those accounts also carry the signup trigger's provisional display_name —
// the email local part. None of the three patterns above matched them, so the
// roster a funcionario is about to be shown listed "qa-maintainer+cursor-owner2"
// as a person's name in a national registry. Both identifiers hit this pattern:
// the email directly, and the display name because it IS the local part.
//
// Plus-addressing is the deliberate anchor. It is a routing suffix on somebody
// else's mailbox, never how a real titular writes their own address, and it is
// how every generation of these harnesses has named itself.

const TEST_ACCOUNT_PATTERNS: readonly RegExp[] = [
  /-gen-/i,
  /^uc-cd-/i,
  /govt-dashboard-export/i,
  /\+cursor-/i,
];

/**
 * True when ANY of the provided identifiers (display name, email, …) matches a
 * known test/smoke-account pattern. Null/undefined values are ignored, so a
 * caller can pass `isTestAccount(displayName, email)` without pre-filtering.
 */
export function isTestAccount(...values: (string | null | undefined)[]): boolean {
  return values.some(
    (v) => typeof v === "string" && TEST_ACCOUNT_PATTERNS.some((re) => re.test(v)),
  );
}

/**
 * Roster-filter variant: same detection, but a console NEVER hides the person
 * reading it (cold-start review RA-6, finding 4).
 *
 * The `-gen-` pattern above is deliberately broad because it names genesis
 * cold-start churn — which is exactly what the FIRST admin of a cold-start
 * deployment is. That admin opened /admin/admins and was told "No hay
 * administradores activos", while logged in as one. The comment above argues a
 * false positive is "fully recoverable via the toggle"; that only holds for
 * OTHER people's rows. Hide the reader and the toggle reads as being about
 * somebody else, so nobody clicks it.
 */
export function isHiddenTestAccount(account: {
  isSelf?: boolean;
  displayName?: string | null;
  email?: string | null;
}): boolean {
  if (account.isSelf) return false;
  return isTestAccount(account.displayName, account.email);
}
