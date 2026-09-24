"use server";

// sessions.ts — the web entry point for B11, "cerrar sesión en todos los
// dispositivos".
//
// WHY THIS IS NOT IN app/actions/auth.ts, WHERE IT OBVIOUSLY BELONGS
// ---------------------------------------------------------------------------
// It was, for about an hour, and the test suite rejected it — for a reason that
// is a real production cost rather than a test artefact, which is why it now
// lives in a file of its own instead of being fixed with a wider mock.
//
// `app/actions/auth.ts` is the barrel that signup, login and complete-identity
// are imported from. `revokeAllSessionsAction` needs `requireLiveUser`, and the
// import chain behind that is:
//
//     live-user.ts → request-cache.ts → notification-reconcile.ts → `notifications`
//
// `notification-reconcile.ts` builds a Drizzle `sql` template at MODULE SCOPE,
// so merely importing it evaluates a reference to the `notifications` table.
// Re-exporting the action from the barrel therefore pulled that whole subtree
// into every consumer of the barrel — including `signup-enumeration.test.ts` and
// `signup-no-session-guard.test.ts`, which mock `@/db` and had no reason to
// declare `notifications`. Both files stopped running entirely (a mock error is
// a file that never ran, not a test that failed).
//
// The tests were the messenger. A signup flow does not need the notification
// reconciliation query, the profile request-cache, or the liveness guard in its
// module graph, and a "use server" barrel is exactly the place where that kind
// of accretion is invisible: nobody importing `signupAction` reads what else the
// file re-exports. Widening the two mocks would have made the symptom go away
// and left the coupling.
//
// So the rule this file encodes: a server-action barrel groups actions that
// share a DEPENDENCY FOOTPRINT, not merely a topic. Session revocation is
// "auth" by topic and is not by footprint.

import { revokeAllSessionsAction as _revokeAllSessionsAction } from "@/src/modules/auth/application/revoke-sessions-action";

// @no-auth-required: authorization happens INSIDE the delegated use-case, whose
// first statement is requireLiveUser() and which refuses without a live session.
// B11 — revokes every session of the caller, this browser's included.
export async function revokeAllSessionsAction(
  ...args: Parameters<typeof _revokeAllSessionsAction>
) {
  return _revokeAllSessionsAction(...args);
}
