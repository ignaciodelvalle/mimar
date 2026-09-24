// Abuse-control policy for the adopter DNI confirmation check (D4, PO 2026-08-23).
//
// ZERO IMPORTS, like every file in this directory. The shape is structurally
// compatible with lib/infra/rate-limit.ts's RateLimitConfig on purpose: importing
// the type — even `import type` — would point a domain file at an infrastructure
// module whose runtime half opens the database.
//
// WHY IT IS NOT IN actions.ts ANY MORE
// ---------------------------------------------------------------------------
// It used to be `export const` in src/modules/adoption/actions.ts, which carries
// the "use server" directive. Next validates EVERY export of such a module and
// rejects anything that is not an async function, so the module threw at load —
// `A "use server" file can only export async functions, found object` — and took
// down every page whose graph reached it. Measured in production telemetry on
// deployment dpl_HhM1q7Vx2bogqPPhpxntYgyfCnuL (commit bb8dece4c): a hard 500 on
// /org/[orgToken]/mascotas/[publicToken]. `tsc` and biome both saw nothing;
// scripts/check-server-action-exports.ts is the fence that now does.
//
// WHY domain/ AND NOT AN action-support.ts SIBLING
// ---------------------------------------------------------------------------
// src/modules/events/action-support.ts is the repo's precedent for shared
// action plumbing without the directive, but it exists for plumbing SHARED
// BETWEEN two action modules (actions.ts and actions-medical.ts) that needs `db`
// and a Supabase client. Neither applies here: adoption has one action module,
// and this is a pure number with no dependencies. A ceiling on how often an
// organization may interrogate the DNI space is a POLICY of the adoption
// domain, and the module already reads value constants from this directory the
// same way (events/actions.ts ← domain/enums.ts, adoption/actions.ts ←
// domain/types.ts). Putting it here also makes the mistake unrepeatable:
// biome.json fences src/modules/*/domain/** against next, @/db and server-only,
// so this file can never acquire a directive.

/**
 * Per-ORGANIZATION ceiling on the DNI confirmation oracle.
 *
 * Calibrated against the legitimate use, which is a person at a counter
 * confirming ONE adopter — typing a DNI, maybe re-typing it after a typo, then
 * moving on to paperwork that takes minutes. Even a large shelter finalizing
 * twenty adoptions in a day stays an order of magnitude under these numbers. A
 * script walking the DNI space needs thousands per minute to be worth running
 * and hits the per-minute cap in seconds.
 *
 * Exported so the test asserts against the SAME constant the action enforces:
 * a test that hardcodes its own 8 passes forever after somebody edits the
 * ceiling to 8000.
 */
export const ADOPTER_DNI_CHECK_LIMITS = {
  maxPerMinute: 8,
  maxPerHour: 60,
  maxPerDay: 200,
} as const;
