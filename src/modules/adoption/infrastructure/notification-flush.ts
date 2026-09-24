// Post-transaction notification fan-out for the ADOPTION BEARER DOOR.
//
// ===========================================================================
// IT IS THE SERVICE PATH, AND THE COOKIE DOOR IS DELIBERATELY NOT MOVED
// ===========================================================================
// `src/modules/adoption/actions.ts` still ends its four operator actions with a
// private `flushNotifications` doing a raw `db.insert(notifications)`. That
// insert is BASELINED debt (`scripts/check-notifications-service.ts`), and this
// file does not share it: `POST /api/v1/adoptions/{petToken}` is new code, and
// new code on the raw path is what that fence exists to refuse.
//
// The first attempt at this door DID share it — the private helper was lifted
// into this file verbatim so both doors ran one implementation — and that is the
// version the integration gate turned back, for two reasons that are the same
// reason twice:
//
//   1. `lint:notifications` went red, because "one implementation" was achieved
//      by making the RAW one the shared one. The fence's stated intent is to
//      MIGRATE call sites onto the service, not to grow the baseline.
//   2. `lint:audit-log` went red as a SIDE EFFECT, and the mechanism is worth
//      recording because nothing about it is obvious. That fence follows one hop
//      out of an operator action into every repo-internal module the action
//      CALLS, and flags a mutation with no reachable `writeAuditLog`. While the
//      raw insert sat inside `actions.ts` as a private function it was invisible
//      to that walk — `findCandidates` scans the EXPORTED action's body, and a
//      module-level helper is not in it. Extracting it into an imported module,
//      and aliasing it back with `const flushNotifications =
//      flushAdoptionNotifications;`, put `db.insert(notifications)` one
//      resolvable hop from all seven operator actions for the first time. The
//      alias resolves exactly as designed (`importedIdentifiers` follows
//      `const alias = imported`); what it resolves INTO is a file that mutates
//      and writes no audit row. Seven actions went red without one line of their
//      own changing.
//
// So the migration this repo wants happens HERE, where it is one new call site
// with no web behaviour behind it, and `actions.ts` is left byte-for-byte as it
// was. That is the same shape the editar door landed in (WU-R, `ecc835aa4`):
// "the endpoint sends notifications through lib/infra/notification-service.ts
// rather than the raw insert the neighbouring cookie door still uses."
//
// ===========================================================================
// WHY IT NEVER THROWS
// ===========================================================================
// The rows are collected INSIDE the use-case's transaction (the spine event id
// has to exist first) and written OUTSIDE it, on purpose: an application that
// landed on the append-only spine must not be rolled back because a notification
// row failed. `createNotificationsBulk` is a stronger version of that promise
// than the raw insert's `try/catch` was — a chunk that throws is dead-lettered
// row by row and a retry cron can replay it, instead of the payload being lost
// to a `console.error`.
//
// NO PUSH IS SENT FROM HERE, and that is not a decision this file makes: the
// Web Push leg is `severity === "urgent"` only, and every row the adoption
// module builds is `info`, `success` or `warning`. Stated so that a future
// `urgent` adoption notification is understood to be opting INTO a push rather
// than inheriting silence.

import { createNotificationsBulk } from "@/lib/infra/notification-service";

import type { NewNotification } from "../application/set-adoption-eligibility";

/**
 * The idempotency key for one adoption notification.
 *
 * SHAPE: `adoption:{type}:{eventId}:{userId}` — the "event-derived" form
 * `notification-service.ts` recommends by name, with the module prefix so an
 * adoption key can never collide with another module's.
 *
 * WHAT IT PROMISES: a retry of the same logical fan-out collapses to one row per
 * recipient. Two applications to the SAME animal by different people do not
 * collapse, because the spine event id differs — and neither do two applications
 * by the same person, for the same reason.
 *
 * WHAT IT DOES NOT PROMISE, said out loud because the fallback is the dangerous
 * half of any dedupe key: a row with NO `relatedEventId` keys on the pet instead,
 * and two genuinely distinct notifications of one type about one pet to one
 * person would then collapse into one. That case is unreachable on this door —
 * every row `submitAdoptionApplication` builds carries the inserted event id, and
 * `submit-adoption-application.test.ts` pins it — but the fallback is written
 * rather than left to `undefined`, because a key containing the string
 * "undefined" is a key that collapses everything it touches.
 */
export function adoptionNotificationDedupeKey(pending: NewNotification): string {
  const anchor = pending.relatedEventId ?? pending.relatedPetId ?? "no-anchor";
  return `adoption:${pending.notificationType}:${anchor}:${pending.userId}`;
}

/** Flush notifications post-tx, best-effort. Never throws. */
export async function flushAdoptionNotifications(pending: NewNotification[]): Promise<void> {
  if (pending.length === 0) return;
  await createNotificationsBulk(
    pending.map((row) => ({
      userId: row.userId,
      notificationType: row.notificationType,
      title: row.title,
      body: row.body,
      severity: row.severity,
      category: row.category ?? null,
      ctaLabel: row.ctaLabel ?? null,
      ctaUrl: row.ctaUrl ?? null,
      relatedPetId: row.relatedPetId ?? null,
      relatedEventId: row.relatedEventId ?? null,
      dedupeKey: adoptionNotificationDedupeKey(row),
    })),
  );
}
