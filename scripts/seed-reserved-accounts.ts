// Reserved seed accounts — accounts whose VALUE IS WHAT THEY DO NOT HAVE.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// e2e/owner-ia-p6.spec.ts test 6 verifies the owner ZERO-PET landing: the empty
// state a citizen sees the first time they log in, before registering anything.
// That test needs an owner with no pets, and the spec named `carla@dim.test`.
//
// By 2026-07-30 Carla owned four pets and NO personal owner in the database had
// zero. Two independent mechanisms had eaten the account, which is the whole
// lesson here:
//
//   1. scripts/seed-demo-polish.ts round-robins owner@'s surplus pets across a
//      REASSIGN_EMAILS list that included carla@dim.test. It gave her
//      DIM-DEMO-0002 and DIM-DEMO-0008 on 2026-07-26. A seed script did this,
//      on purpose, to an account another spec depended on for its emptiness.
//   2. A QA wizard run on 2026-07-17 registered QA7-Luna and QA7-Estrella while
//      logged in as her. Nothing scripted that; a human/agent picked "some
//      owner" from the seed list.
//
// Neither is a bug in isolation. The bug is that "zero pets" was an OBSERVED
// property of a general-purpose demo persona instead of a DECLARED property of
// a dedicated account. An observed property drifts; the drift is silent; the
// test that depended on it went red for a reason that looked like a product
// regression.
//
// THE CONTRACT
// ---------------------------------------------------------------------------
// The email literals below appear EXACTLY ONCE in the repository — here. Every
// consumer imports the constant:
//
//   - scripts/seed-test-users.ts creates the account. That script is what
//     `pnpm db:bootstrap` runs (step 4), so the account is part of the baseline
//     a fresh CI database has, not demo furniture somebody seeded by hand
//     (the distinction __tests__/seed-precondition-contract.test.ts enforces).
//   - scripts/seed-demo-polish.ts filters its reassignment recipients through
//     `rejectReservedAccounts` — a list that grows can no longer reach them.
//   - scripts/check-seed-hygiene.ts fails when a reserved account has acquired
//     a pet or an org membership, and __tests__/seed-hygiene.test.ts runs that
//     check against the local DB in `pnpm test`. That is the part a QA wizard
//     cannot route around: a manual registration under this account turns the
//     suite red and NAMES the account, instead of silently breaking one e2e
//     assertion a month later.
//   - __tests__/seed-reserved-accounts.test.ts is the static fence that keeps
//     the literal from being re-hardcoded somewhere that then drifts.
//
// So: pick a DIFFERENT account for anything that needs a pet. This one's only
// job is to be empty.

/**
 * The guaranteed zero-pet personal owner. Owns no pets, holds no organization
 * membership, and no seed script may give it either.
 *
 * The local part is deliberately not a first name: every human-named seed
 * persona (carla, noeli, graciela, ignacio…) is fair game for demo furniture,
 * and a name reads as "available". `zero-pets` reads as a constraint.
 */
export const ZERO_PET_OWNER_EMAIL = "zero-pets@dim.test";

/**
 * Display name for that account. A plausible es-AR person name, NOT a marker
 * like "Reserved" or "Sin mascotas": profiles.display_name is a renderable
 * column (scripts/hygiene-rules.ts), and seed plumbing must never surface to a
 * funcionario or a citizen. The reservation is enforced by code, not by copy.
 */
export const ZERO_PET_OWNER_DISPLAY_NAME = "Marina Sosa";

/** Every reserved account, by email. Compared case-insensitively. */
export const RESERVED_ACCOUNT_EMAILS: readonly string[] = [ZERO_PET_OWNER_EMAIL];

/** True when `email` names a reserved account. Trims and lowercases. */
export function isReservedAccount(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return RESERVED_ACCOUNT_EMAILS.some((reserved) => reserved.toLowerCase() === normalized);
}

/**
 * Drop reserved accounts from a list of pet recipients.
 *
 * Seed scripts that hand pets to "some owner" call this on their recipient list
 * so adding an email to that list can never reach a reserved account. Logs the
 * removal rather than throwing: a seed run must still converge, and a silent
 * filter would hide the mistake from whoever widened the list.
 */
export function rejectReservedAccounts<T extends string>(
  emails: readonly T[],
  context: string,
  warn: (message: string) => void = (message) => console.warn(message),
): T[] {
  const kept: T[] = [];
  for (const email of emails) {
    if (isReservedAccount(email)) {
      warn(
        `[WARN] ${context}: refusing to assign pets to the reserved account ${email} — it exists to stay empty (scripts/seed-reserved-accounts.ts). Skipped.`,
      );
      continue;
    }
    kept.push(email);
  }
  return kept;
}
