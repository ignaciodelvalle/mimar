// The 8-hour operator shift — enforced HERE, in the app, because GoTrue cannot.
//
// ===========================================================================
// B9 — WHY THIS FILE EXISTS AT ALL
// ===========================================================================
// PO decision (B9): a CITIZEN session becomes long-lived — weeks, rotating
// refresh, revocable. An INSTITUTIONAL operator (govt / admin / org staff) keeps
// the one-workday boundary that `[auth.sessions] timebox` used to give everyone.
// The reasoning is not symmetrical and should not be made to look it: a wallet
// that logs you out mid-field-visit is not a wallet, and an operator console on
// a shared municipal desk must not still be authenticated the next morning.
//
// GoTrue's `timebox` is GLOBAL. It is one duration for the whole project and it
// cannot discriminate by role — there is no per-user, per-role or per-audience
// variant of it in any version of the setting. So "long for citizens, 8h for
// operators" is not expressible in Supabase configuration, and the split has to
// happen where the ACCOUNT is already known. That is `requireLiveUser`
// (lib/infra/live-user.ts), which has resolved the profile from the database
// before it returns, and `resolveLiveActor` in the org capability path.
//
// ===========================================================================
// WHERE "WHEN DID THIS SESSION START" HONESTLY COMES FROM
// ===========================================================================
// Three candidates were measured against a real local GoTrue (v2.188.1) rather
// than reasoned about, and two of them are wrong:
//
//   `iat`                  — the ACCESS token's issue time. It moves on every
//                            refresh, roughly hourly. A session's age computed
//                            from it is never more than one refresh interval, so
//                            the shift would never expire. Useless.
//
//   `user.last_sign_in_at` — WRONG IN THE EXACT CASE THIS CONTROL EXISTS FOR,
//                            and it is the plausible-looking option, so it is
//                            worth being explicit. It is PER-USER, not
//                            per-session. Measured: open session A, wait, sign
//                            in again elsewhere creating session B, then re-read
//                            the user object through session A's own token — it
//                            reports session B's timestamp. An operator who
//                            signs in on a second terminal silently rejuvenates
//                            the first terminal's shift clock, which is the
//                            shared-desk scenario B9 is about. (Careful when
//                            re-checking this by hand: GoTrue returns nanosecond
//                            precision on sign-in and microsecond on re-read, so
//                            a naive string compare of the two says "different"
//                            and hides the rejuvenation. Compare instants.)
//
//   `amr[].timestamp`      — CORRECT. The Authentication Method References claim
//                            records when each authentication method was used
//                            for THIS session. Measured: it survives
//                            `grant_type=refresh_token` unchanged, and two
//                            concurrent sessions of the same user carry two
//                            different values. That is a per-session
//                            authentication time, which is what a shift is.
//
// `auth.sessions.created_at` in Postgres is equally authoritative and is not
// used: it is GoTrue's own schema, it is not exposed through PostgREST, and
// reading it would add a database round-trip to every institutional request to
// learn something the request already carries.
//
// ===========================================================================
// IS READING A CLAIM A BREACH OF "AUTHORIZATION IS 100% DB-RESOLVED"?
// ===========================================================================
// No, and the distinction is worth stating because live-user.ts's header makes
// the stronger-sounding claim that it "never reads a claim out of the token to
// decide anything".
//
// That invariant is about AUTHORITY: what a caller may do is answered by the
// database (`profiles`, memberships, grants), never by a self-asserted claim,
// because a claim describes what was true when the token was minted. Nothing
// here changes that — the role that selects this policy is still read from
// `profiles`.
//
// What is read from the token is the CREDENTIAL'S OWN AGE, and the credential is
// the only thing that can answer that. Our database has no row for it. The claim
// is also not self-asserted in the way that phrase usually means: it is signed by
// GoTrue, and `verifiedSessionStart` below may only be called with a token that
// `auth.getUser()` has already round-tripped to GoTrue for validation. GoTrue
// vouches for the signature AND for the session still being live; decoding
// afterwards reads what was just verified. Decoding an unvalidated cookie would
// be trusting the client, which is why the function is named for the
// precondition and why the precondition is spelled out at its call site.
//
// A client clock is never consulted, in either direction.
//
// ===========================================================================
// SAFE WHETHER OR NOT THE HOSTED TIMEBOX HAS BEEN CHANGED YET
// ===========================================================================
// `supabase/config.toml` configures the LOCAL Docker stack only. Relaxing the
// hosted (staging/prod) timebox is a dashboard change and a PO errand, and this
// code must be correct on both sides of it:
//
//   · hosted timebox STILL 8h — GoTrue already ends every session at 8h,
//     citizens included. This module refuses institutional principals at the
//     same 8h, so it adds no friction anyone was not already getting. Citizens
//     are never evaluated here at all.
//   · hosted timebox RELAXED — citizens get the long session B9 asked for, and
//     institutional principals still meet 8h, here.
//
// The app never shortens a citizen session and never extends anyone's beyond
// what GoTrue already allows. It only ever refuses EARLIER than GoTrue, and only
// for operators.

import { reportError } from "@/lib/infra/report-error";
import { verifiedTokenClaims } from "@/lib/infra/verified-token-claims";

/**
 * One workday. The duration `[auth.sessions] timebox` used to impose on
 * everybody, kept for the principals it was actually written for.
 */
export const OPERATOR_SHIFT_MS = 8 * 60 * 60 * 1000;

/** es-AR copy for a shift that ran out. Says what happened and what to do. */
export const OPERATOR_SHIFT_EXPIRED_MESSAGE =
  "Tu turno de trabajo terminó. Por seguridad cerramos la sesión — volvé a iniciar sesión para seguir.";

type AmrEntry = { method?: unknown; timestamp?: unknown };

// The decode-without-verify lives in ./verified-token-claims.ts, shared with the
// recovery form and MFA enforcement. It is still reachable only through entry
// points that name the precondition: a token `getUser()` has just validated.

/**
 * The instant this session was authenticated, from the `amr` claim.
 *
 * Exported for the tests, which need to pin the claim shape without minting a
 * real token. Production callers want `verifiedSessionStart`.
 *
 * `amr` has two documented shapes: RFC-8176's plain `string[]` (no timestamps at
 * all) and GoTrue's `{ method, timestamp }[]`. Only the second can answer this,
 * and the first is handled by returning null rather than by guessing.
 *
 * When several entries carry a timestamp — a session that was stepped up with a
 * second factor records both — the EARLIEST wins. The shift began when the
 * operator first authenticated, not when they later satisfied MFA; taking the
 * latest would let a step-up silently extend the workday.
 */
export function sessionStartFromClaims(claims: Record<string, unknown> | null): Date | null {
  if (!claims) return null;
  const amr = claims.amr;
  if (!Array.isArray(amr)) return null;

  let earliest: number | null = null;
  for (const entry of amr) {
    if (typeof entry !== "object" || entry === null) continue;
    const timestamp = (entry as AmrEntry).timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) continue;
    if (earliest === null || timestamp < earliest) earliest = timestamp;
  }

  // GoTrue emits seconds since the epoch; JS wants milliseconds.
  return earliest === null ? null : new Date(earliest * 1000);
}

/**
 * When the session behind `accessToken` was authenticated, or null if the token
 * does not say.
 *
 * PRECONDITION, and it is the whole safety argument: `accessToken` MUST be a
 * token `supabase.auth.getUser()` has just validated. This function does not
 * verify the signature and must never be handed a raw cookie value.
 */
export function verifiedSessionStart(accessToken: string | null | undefined): Date | null {
  return sessionStartFromClaims(verifiedTokenClaims(accessToken));
}

export type OperatorShiftInput = {
  /** From `verifiedSessionStart`. Null when the token carried no usable claim. */
  sessionStartedAt: Date | null;
  /** Injected so the tests do not race a real clock. */
  now?: Date;
  /** For the fail-open report, so an operator log says which surface saw it. */
  context?: string;
};

/**
 * Has this operator's workday run out?
 *
 * FAILS OPEN when the session start is unknown, and the direction is a real
 * decision rather than an oversight.
 *
 * Failing CLOSED would mean: the day a GoTrue upgrade changes the `amr` claim
 * shape, every operator in the country is locked out of every console at once,
 * with no warning and no workaround, over a control that is a REFINEMENT of a
 * backstop that still exists. Failing open means: in that same scenario
 * operators fall back to whatever `[auth.sessions] timebox` allows — which is
 * exactly the protection they had before this file was written — and the anomaly
 * is reported so somebody looks.
 *
 * The residual is honest and worth naming: once the hosted timebox is relaxed
 * for citizens, that fallback is the RELAXED duration, not 8h. So a silent claim
 * regression degrades the operator boundary to the citizen one instead of to
 * nothing. That is why it reports rather than shrugs, and why the report is not
 * conditional on anything.
 *
 * `user.last_sign_in_at` is deliberately NOT used as a fallback: the header
 * explains that it rejuvenates old sessions, so it would not be a degraded
 * answer, it would be a wrong one that looks like an answer.
 */
export function isOperatorShiftExpired({
  sessionStartedAt,
  now = new Date(),
  context = "unknown",
}: OperatorShiftInput): boolean {
  if (sessionStartedAt === null) {
    reportError(
      `operator-shift/${context}`,
      new Error(
        "Institutional session carried no usable amr timestamp; the 8h shift could not be " +
          "evaluated and GoTrue's global timebox is the only remaining bound.",
      ),
    );
    return false;
  }

  const age = now.getTime() - sessionStartedAt.getTime();

  // A NEGATIVE age means the token says it was authenticated in the future —
  // clock skew between GoTrue and this process, or a token from somewhere else.
  // It is not an expired shift, and treating it as one would refuse a session
  // that has barely started. Bounded by GoTrue's own validation either way.
  if (age < 0) return false;

  return age >= OPERATOR_SHIFT_MS;
}
