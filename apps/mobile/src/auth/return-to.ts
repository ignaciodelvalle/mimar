// Where a deep link goes when it finds no session, and where sign-in sends it
// back to.
//
// WHY THIS IS A MODULE AND NOT TWO HELPERS IN TWO SCREENS
// ---------------------------------------------------------------------------
// The two halves have to agree, and they are written in different files:
// `useGate` decides what to PUT in `next`, `ingreso` decides what to DO with it.
// A disagreement between them is not a crash — it is somebody signing in and
// landing somewhere they did not ask for, which is the exact failure this pair
// exists to fix. Both halves also have a security shape worth testing directly
// rather than through a rendered screen.
//
// WHAT THE PAIR IS FOR
// ---------------------------------------------------------------------------
// Until deep links resolved (WU-O), every protected screen was reached by
// tapping through from the pet list, so a signed-out person sent to sign-in came
// back to a stack they could walk again in two taps. Losing the destination cost
// almost nothing.
//
// A deep link changes that. Somebody taps "Ver propuesta" in a notification, the
// app opens at `/transferencias/PTR-…`, the stored session has expired, and they
// land on sign-in — and after signing in they arrive at their pet list with no
// idea what the link was for. The proposal is still there and still expiring,
// and the only route back is the notification they already dismissed.

import type { SessionEndReason } from "../api/client";
import { ROUTES } from "../ui/routes";

/**
 * The three ways a session ends BECAUSE THE PERSON SAID SO — and the reason
 * `next` must not survive them (NAV-2, confirmed on a device 2026-09-05:
 * signing out from Ajustes and signing back in landed on Ajustes).
 *
 * `next` exists for a session that was TAKEN from somebody mid-task: the link
 * they followed is still where they were going, so sign-in returns them to it.
 * A deliberate sign-out is the opposite fact. "Cerrar sesión" is a person
 * saying they are done with that screen, and handing it back to them at the
 * next sign-in re-opens a page they closed — from Ajustes, the very screen
 * whose button they pressed.
 *
 * Erasing the account is the sharpest case: `next` would name a screen that no
 * longer has anything behind it.
 *
 * The router-side attempts do not close this. `ajustes.tsx` already replaced
 * the route with `/` after awaiting `signOut`, and the bug was still reproduced
 * on the device, because the gate's own `<Redirect>` renders from the same
 * store flip and can commit after that replace. The cure has to be that the
 * destination is never built, not that something overwrites it afterwards.
 */
const DELIBERATE_END: ReadonlySet<SessionEndReason> = new Set<SessionEndReason>([
  "user_action",
  "revoked_all",
  "account_erased",
]);

/** Whether the person ended this session themselves. `null` = we do not know. */
export function endedByThePerson(reason: SessionEndReason | null): boolean {
  return reason !== null && DELIBERATE_END.has(reason);
}

/**
 * The `endedAt` for a sign-out whose whole purpose is to come BACK to the screen
 * it was pressed on — the deep-link "this is not for this account" arms
 * (A4-custodia-11).
 *
 * `signedOutHref` suppresses `next` for the pathname the person was standing on,
 * because "Cerrar sesión" normally means they are done with that screen. On an
 * invitation or a proposal opened with the wrong address that reasoning inverts:
 * the screen is the one thing they are trying to reach, and swallowing its
 * destination is the failure the button exists to fix. Naming the empty string
 * rather than writing `""` at the call site is what keeps that inversion
 * legible — a bare `""` reads like a caller that had nothing to pass.
 */
export const KEEP_DESTINATION_ON_SIGN_OUT = "";

/**
 * Where a signed-out visitor goes — the ONE decision the gate makes, composed
 * here rather than in the switch so it can be tested without a router.
 *
 * THE SUPPRESSION IS SCOPED TO THE SCREEN THE SIGN-OUT HAPPENED ON, and that
 * scope is the whole point of this function. `reason` is STICKY: `signOut()`
 * writes "user_action" into the store and nothing clears it until the next
 * sign-in, so a rule that read the reason alone kept suppressing `next` for the
 * entire signed-out session. The failure that fell out of it is not
 * hypothetical: somebody signs out in Ajustes, stays in the app, taps a
 * transfer-proposal notification, and lands on sign-in with NO destination —
 * so after signing in they arrive at their pet list, and the proposal they were
 * answering is gone from view while it goes on expiring.
 *
 * So a deliberate end erases exactly one destination: the pathname the person
 * was standing on when they pressed the button. That is precisely the screen
 * NAV-2 is about ("handing it back re-opens a page they closed"), and it leaves
 * every other destination — including one they deliberately asked for
 * afterwards — carried the way it is for anybody else.
 *
 * The other half of the invariant is unchanged and still pinned by the tests:
 * an EXPIRED session at that same screen keeps its destination, because nobody
 * closed anything.
 */
export function signedOutHref(args: {
  reason: SessionEndReason | null;
  /** The path the deliberate end happened on. Absent when it was not one. */
  endedAt: string | undefined;
  /** `usePathname()` — where the visitor is NOW. */
  pathname: string;
}): string | { pathname: string; params: { next: string } } {
  // AN ERASED ACCOUNT SUPPRESSES EVERY DESTINATION, not just the one it was
  // erased from (A6-cuenta-resiliencia-06, the third NAV-2 site). The scoping
  // rule below is right for a sign-out — the person closed ONE screen and the
  // rest of the app is still theirs — and wrong for a supresión: there is no
  // account left for any destination to be about. The measured shape was
  // `next=/cuenta/privacidad` surviving into the next sign-in, so the first
  // thing the next person to use that phone saw was the deletion screen; but
  // the same leak carries any pathname the gate happens to render on after the
  // erasure lands, which is why the cure is the reason and not the path.
  if (args.reason === "account_erased") return ROUTES.ingreso;
  const closed = args.endedAt?.trim() ?? "";
  if (endedByThePerson(args.reason) && closed !== "" && closed === args.pathname.trim()) {
    return ROUTES.ingreso;
  }
  return signInHref(args.pathname);
}

/**
 * Where to send a signed-out visitor, carrying where they were going.
 *
 * The caller passes `usePathname()` — the path the ROUTER already resolved —
 * never a value read out of the link itself. That is the security of this half:
 * the router only produces paths it has a screen for.
 *
 * NO PARAMETER for the paths that would loop or mean nothing. Sign-in itself and
 * the gate are obvious; the pet list is the DEFAULT landing, so carrying it
 * would add a parameter that changes nothing while making every ordinary
 * sign-in look like a redirect chain.
 */
export function signInHref(
  pathname: string,
): string | { pathname: string; params: { next: string } } {
  const next = pathname.trim();
  if (!worthCarrying(next)) return ROUTES.ingreso;
  return { pathname: ROUTES.ingreso, params: { next } };
}

/**
 * The paths that are not a destination: sign-in and the identity gate would
 * loop, the pet list is where a `next`-less sign-in lands anyway, and an empty
 * string is not a path.
 */
function worthCarrying(next: string): boolean {
  return (
    next !== "" &&
    next !== "/" &&
    next !== ROUTES.ingreso &&
    next !== ROUTES.misMascotas &&
    next !== ROUTES.identidadPendiente
  );
}

/**
 * Where a signed-in visitor whose IDENTITY is still pending goes — carrying
 * where they were going.
 *
 * THE ARM THE DESTINATION WAS MISSING FROM (A4-custodia-03). `signedOutHref`
 * has carried `next` since WU-O, and the gate has four other arms; this is the
 * one a first-time user actually hits. Somebody taps a caretaker invitation in
 * their mail, installs the app, creates an account, completes step 2 — and lands
 * on their (empty) pet list, because the redirect to this screen dropped the
 * link. The invitation is still expiring and the only way back is the mail they
 * already opened.
 *
 * Same shape and same security as `signInHref`: the caller passes
 * `usePathname()`, a path the ROUTER resolved, and `returnHref` re-checks it
 * before anything navigates to it.
 */
export function pendingIdentityHref(
  pathname: string,
): string | { pathname: string; params: { next: string } } {
  const next = pathname.trim();
  if (!worthCarrying(next)) return ROUTES.identidadPendiente;
  return { pathname: ROUTES.identidadPendiente, params: { next } };
}

/**
 * Where to go after a successful sign-in — the interrupted destination, or the
 * gate.
 *
 * `next` IS RE-CHECKED HERE AND NOT TRUSTED, even though `signInHref` produced
 * it from a resolved pathname. Two reasons, and the second is the one that
 * matters:
 *
 *   · A path parameter can legally repeat, so the type is `string | string[]`
 *     and the array case has to be resolved rather than stringified into
 *     `"/a,/b"`.
 *   · The sign-in screen is itself ADDRESSABLE. `mimar://ingreso?next=…` is a
 *     url anybody can compose and send, so by the time the value is read here it
 *     is untrusted input in a way it was not one component ago.
 *
 * It is deliberately a SHAPE check and not an allow-list of routes. An allow-list
 * would have to be maintained beside `ROUTES` and would silently drop a
 * legitimate destination the day somebody adds a screen and forgets — failing in
 * the direction this whole change exists to fix. What must be impossible is
 * leaving the app, and `//` and a scheme are the two ways to do that.
 */
export function returnHref(next: string | string[] | undefined): string {
  const value = (Array.isArray(next) ? next[0] : next)?.trim() ?? "";
  if (value.length === 0) return ROUTES.root;
  // A single leading slash and no scheme. `//host` is protocol-relative and
  // `mimar:` / `https:` name another app or the browser.
  if (!value.startsWith("/") || value.startsWith("//") || value.includes(":")) return ROUTES.root;
  return value;
}
