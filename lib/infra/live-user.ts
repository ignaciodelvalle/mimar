// requireLiveUser() — the ONE result-shaped liveness guard.
//
// WHAT "LIVE" MEANS
// ---------------------------------------------------------------------------
// A caller is live when all six of these hold:
//   1. the platform is accepting traffic  (maintenance kill-switch off)
//   2. a Supabase session resolves        (NO_SESSION otherwise)
//   3. the account was not erased         (profiles.deleted_at, Ley 25.326 art. 16)
//   4. the account was not deactivated    (either an operator switching an
//      institutional account off, or a person self-deactivating a personal one
//      from /cuenta — both are `profiles.deactivated_at`, both refuse writes)
//   5. the account does not still owe its first password (pilot T1-P3;
//      refused as NO_SESSION with `passwordSetupPending`, see the check)
//   6. an INSTITUTIONAL principal is still inside its 8-hour shift (B9)
//
// WHY IT EXISTS — this is a live web bug, not native prep
// ---------------------------------------------------------------------------
// Before this module those four checks lived in four different places and none
// of them covered a WRITE:
//   - maintenance:  four layouts (app/(app), app/gob, app/admin, app/org/[t]).
//     A layout gates a RENDER. A Server Action POST executes its body BEFORE any
//     layout re-renders, so a maintenance window never stopped an in-flight
//     write — the mutation committed and the user was then shown the
//     maintenance screen. Measured, not inferred.
//   - erasure:      requireUserOrRedirect + requirePetAccess, plus five
//     hand-copied inline `profile?.deletedAt != null` snippets. 19 exported
//     server actions resolved identity on a bare `auth.getUser()` with NO
//     erasure check of any kind (enumerated with the repo's own
//     scripts/check-authz-guards.ts discovery — see the T1.2 report).
//   - deactivation: only inside loadActiveInstitutionalProfile, i.e. only on the
//     /admin and /gob page guards.
//
// THE INVARIANT THIS PROTECTS
// ---------------------------------------------------------------------------
// Authorization is 100% DB-resolved (zero `auth.jwt()` across 276 RLS policies).
// This guard never reads a claim out of the token to decide WHAT A CALLER MAY
// DO: the token (cookie or bearer) answers WHO, and `getProfileCached` — a
// database read — answers WHETHER THEY MAY STILL ACT. That is what makes the
// bearer entry point (lib/supabase/bearer.ts, Track 2's first caller) cheap and
// safe: swapping the credential transport changes nothing about how authority is
// resolved.
//
// B9 ADDED EXACTLY ONE READ FROM THE TOKEN, and narrowed the sentence above from
// "never reads a claim to decide anything" to what it always meant. The shift
// check needs to know WHEN THIS SESSION WAS AUTHENTICATED, and that is a fact
// about the credential, not about the account — our database has no row for it
// (GoTrue owns `auth.sessions`, which PostgREST does not expose). The role that
// selects the policy is still read from `profiles`; only the credential's own age
// comes from the credential, only after `auth.getUser()` has had GoTrue validate
// that exact token, and never from a client clock. lib/infra/operator-shift.ts
// carries the full argument and the measurements behind it.
//
// AND WHAT IT DOES NOT COVER
// ---------------------------------------------------------------------------
// This is an APP-LAYER guard. Drizzle connects with postgres-js and bypasses
// RLS, so for server-side writes it is the boundary. It is NOT a substitute for
// RLS on anything a PostgREST caller could reach directly with the same bearer
// token: 14 of 15 `ownerships`-derived policies carry no role predicate and
// `pet_events` INSERT checks neither role nor event type (RLS audit 2026-08-18).
// A bearer client that talks to Supabase directly is not gated by this file at
// all. Track 2's decision — native talks to our own /api/v1, never to Supabase
// directly — is what keeps that gap closed, and it is a deployment invariant,
// not something this module can enforce.

import { isMaintenanceMode } from "@/lib/domain/maintenance-mode";
import {
  OPERATOR_SHIFT_EXPIRED_MESSAGE,
  isOperatorShiftExpired,
  sessionStartFromClaims,
} from "@/lib/infra/operator-shift";
import { reportError } from "@/lib/infra/report-error";
import { type CachedProfile, getProfileCached } from "@/lib/infra/request-cache";
import { assuranceLevel, verifiedSessionClaims } from "@/lib/infra/verified-token-claims";
import { createClient } from "@/lib/supabase/server";
import { isPasswordSetupPending } from "@/src/modules/auth/domain/first-access";
import {
  MFA_CHALLENGE_MESSAGE,
  MFA_ENROL_MESSAGE,
  type MfaFactorLike,
  mfaRequirement,
} from "@/src/modules/auth/domain/mfa-policy";

export type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Why a caller is not live. Ordered by the precedence requireLiveUser applies:
 * MAINTENANCE → NO_SESSION → ACCOUNT_ERASED → DEACTIVATED → SHIFT_EXPIRED.
 */
export type LiveUserFailureReason =
  | "NO_SESSION"
  | "ACCOUNT_ERASED"
  | "MAINTENANCE"
  | "DEACTIVATED"
  | "SHIFT_EXPIRED";

export type LiveUserSuccess = {
  ok: true;
  supabase: SupabaseServerClient;
  // email is exposed for display fallbacks (nav avatar) — never as the PRINCIPAL
  // an authorization decision keys on. That rule stands: an address is mutable
  // and reassignable, `id` is not, so a guard that asked "is this caller allowed"
  // by e-mail would be asking the wrong question.
  //
  // ONE EXCEPTION EXISTS, and it is recorded here rather than left to be
  // rediscovered as a contradiction: an ADDRESSEE match is not a principal
  // check. `pet_transfers` and `pet_caretaker_grants` can be addressed to
  // somebody who has no account yet, so the row stores an e-mail and
  // `validateRecipientMatch` (transfers/domain/owner-transfer-rules.ts) compares
  // it — id when `to_owner_id` resolved, e-mail only when it did not. The web's
  // own actions already feed that comparison from `supabase.auth.getUser()`,
  // i.e. this same verified value, and `app/api/v1/me/transfers/route.ts` reads
  // it here instead of paying a second GoTrue round-trip for the identical
  // answer.
  //
  // WHAT "VERIFIED" DOES AND DOES NOT MEAN HERE, corrected 2026-09-02 (audit
  // A09-1). This value being verified means GoTrue vouched for the TOKEN it came
  // out of — never a request body or header. It does NOT mean anybody proved the
  // ADDRESS belongs to this person: an account can be created with any address
  // and the token will then carry it. The paragraph above used to stop at
  // "verified" and read as if that cleared the addressee arm; it does not, and
  // an unproved address on the e-mail arm is what moves titularidad. That is why
  // `emailConfirmed` travels beside it and why every consumer of the addressee
  // rule now has to state it.
  user: { id: string; email?: string; emailConfirmed: boolean };
  // Already-resolved profile, so a caller that needs the role does not pay a
  // second round-trip. Null only in the mid-signup window where auth.users
  // exists and the profile row does not yet.
  profile: CachedProfile | null;
  /**
   * When THIS session was authenticated, from the GoTrue-signed `amr` claim of
   * the token this call just had validated. Null when the token carried no
   * usable timestamp — which is NOT a licence to conclude the session is fresh;
   * operator-shift.ts explains why that case fails open and reports.
   *
   * Resolved for EVERY caller, not only institutional ones, and the cost is why
   * that is affordable: on the bearer path the token is already in hand, and on
   * the cookie path `getSession()` is a cookie read plus a JSON parse — the
   * network round-trip belongs to `getUser()`, which has already happened.
   *
   * It is resolved unconditionally because the org capability path
   * (authz-resolver.ts) needs it for a caller this file cannot recognise: an org
   * staffer may hold a PERSONAL profile, so the institutional check below does
   * not fire for them, yet an org console is an operator surface under B9.
   * Making the field conditional would make `null` mean two different things.
   */
  sessionStartedAt: Date | null;
};

export type LiveUserFailure = {
  ok: false;
  // Null on MAINTENANCE: the kill-switch answers before any client is built, so
  // there is deliberately nothing to hand back. Callers must not depend on it.
  supabase: SupabaseServerClient | null;
  // Populated on every refusal that got as far as resolving a session, so the
  // page-level wrapper can hand a tolerated refusal (DEACTIVATED) back as a
  // complete session instead of reconstructing one.
  user: { id: string; email?: string } | null;
  reason: LiveUserFailureReason;
  // Ready-to-render es-AR copy, identical to liveUserMessage(reason) — except
  // where a refusal carries a more specific string (DEACTIVATED by account type,
  // NO_SESSION for a first access; see PASSWORD_SETUP_PENDING_MESSAGE).
  error: string;
  /**
   * Set only on the NO_SESSION refusal of a session that still owes its first
   * password (pilot T1-P3). The REASON stays NO_SESSION on purpose — see the
   * check in requireLiveUser — so this flag is how the page-level wrapper tells
   * "send them to /primer-acceso" apart from "send them to log in".
   */
  passwordSetupPending?: true;
  /**
   * Set only on the NO_SESSION refusal of an INSTITUTIONAL session that has not
   * met the second-factor policy (T2-S6, src/modules/auth/domain/mfa-policy.ts):
   * "enrol" when the account has no verified TOTP factor, "challenge" when it
   * has one and this session has not reached aal2. Rides on NO_SESSION for the
   * reason `passwordSetupPending` does — every write boundary and the /api/v1
   * wire contract already know how to refuse it — and requireUserOrRedirect
   * reads it to send a page load to /mfa or /mfa/configurar instead of to a
   * login the person has already completed.
   */
  mfaPending?: "enrol" | "challenge";
};

export type LiveUserResult = LiveUserSuccess | LiveUserFailure;

export type RequireLiveUserOptions = {
  /**
   * Credential source. Omit for the cookie path (Server Components, Server
   * Actions, cookie-authenticated Route Handlers). Track 2 passes the client
   * built by createClientFromBearer() so a bearer request is resolved by this
   * exact guard rather than by a parallel one.
   */
  supabase?: SupabaseServerClient;
  /**
   * The raw access token, when the caller has one — i.e. the bearer path, where
   * `createClientFromBearer` returns it alongside the client.
   *
   * Handed straight to `auth.getUser(jwt)` so validating THIS token is what the
   * code says rather than what an supabase-js internal happens to do. See the
   * note at the call site. Omit on the cookie path.
   *
   * It is never logged, never decoded here, and never used to decide anything:
   * the answer to "who is this" comes from GoTrue validating it, and the answer
   * to "what may they do" comes from the database.
   */
  accessToken?: string;
};

const MESSAGES: Record<LiveUserFailureReason, string> = {
  // Byte-identical to the strings already hand-copied across the write
  // boundaries this guard replaces, so the migration is invisible on screen.
  NO_SESSION: "Sesión expirada.",
  ACCOUNT_ERASED: "Tu cuenta fue eliminada.",
  MAINTENANCE:
    "miMAR está en mantenimiento. Tu cambio no se registró — probá de nuevo en unos minutos.",
  // TRUE FOR BOTH ACCOUNT TYPES, and that is a correction rather than a
  // rewording. This string used to say "institucional" to everybody, which was
  // accurate only because the predicate below refused nobody else. Now that a
  // deactivated PERSONAL account is refused too, a caller that knows only the
  // REASON must not name an account type it has not looked at.
  //
  // The two account types get different, specific copy at the refusal site
  // (DEACTIVATED_MESSAGE_*) because the remedies genuinely differ: an
  // institutional deactivation was done TO the account by an operator, a
  // personal one was done BY the person and they can undo it themselves.
  DEACTIVATED: "Tu cuenta está desactivada. Mientras esté así no podemos registrar cambios.",
  // Says what happened AND what to do. "Sesión expirada." would be a lie by
  // omission here: the token has not expired, the workday has, and an operator
  // told the former will refresh and be refused again.
  SHIFT_EXPIRED: OPERATOR_SHIFT_EXPIRED_MESSAGE,
};

/**
 * The DEACTIVATED copy an INSTITUTIONAL account gets. Byte-identical to the
 * string login.ts already shows for the same case, and to what this guard said
 * to everybody before personal accounts were brought inside the refusal.
 *
 * It ends in "contactá al equipo" and NOT in a link to a self-service screen,
 * because for this account type there is no self-service screen to link to:
 * an operator switched the account off and only an operator switches it back
 * on. It also must not say "entrá a Mi cuenta" — /cuenta is under the citizen
 * layout, which bounces an `admin`/`govt` role to its own portal, and that
 * portal's guard bounces a deactivated one to `/`. The surface is genuinely not
 * reachable for them, so the copy does not pretend it is.
 */
export const DEACTIVATED_MESSAGE_INSTITUTIONAL =
  "Tu cuenta institucional está desactivada. Contactá al equipo de miMAR.";

/**
 * The refusal a session gets while its account still owes the first password
 * (pilot T1-P3). Rides on NO_SESSION — see requireLiveUser — so every caller
 * that already renders `live.error` shows this instead of "Sesión expirada.",
 * which would send the person to a login they have no password for.
 */
export const PASSWORD_SETUP_PENDING_MESSAGE =
  "Antes de seguir tenés que elegir tu contraseña. Abrí el link de acceso que te llegó por mail.";

/**
 * The DEACTIVATED copy a PERSONAL account gets.
 *
 * Says what happened, WHO did it, and where the way back is — in that order,
 * and without a word that reads like a system error. This account state is not
 * a failure: the person chose it in "Zona de riesgo" on /cuenta, and /cuenta is
 * where they undo it (ReactivateAccountCard). Telling them to "contactar al
 * soporte" — which is what they were told before this existed — would be
 * sending somebody to ask a stranger for permission to undo their own decision.
 */
export const DEACTIVATED_MESSAGE_PERSONAL =
  "Desactivaste tu cuenta, así que por ahora no podemos registrar cambios. Podés volver a activarla vos desde Mi cuenta.";

/**
 * es-AR refusal copy for a liveness failure.
 *
 * Reason-only, so the DEACTIVATED string it returns is the one that is true for
 * BOTH account types. A caller holding the profile should prefer the `error`
 * field of the refusal itself, which carries the account-type-specific copy.
 */
export function liveUserMessage(reason: LiveUserFailureReason): string {
  return MESSAGES[reason];
}

export type OptionalLiveUserSuccess = {
  ok: true;
  supabase: SupabaseServerClient;
  // Null means "no session, and that is allowed here".
  user: { id: string; email?: string } | null;
  profile: CachedProfile | null;
};

export type OptionalLiveUserResult =
  | OptionalLiveUserSuccess
  | (LiveUserFailure & { reason: Exclude<LiveUserFailureReason, "NO_SESSION"> })
  | (LiveUserFailure & { reason: "NO_SESSION"; passwordSetupPending: true })
  | (LiveUserFailure & { reason: "NO_SESSION"; mfaPending: "enrol" | "challenge" });

/**
 * Same guard, for the three write boundaries where an ANONYMOUS caller is
 * legitimate: the anonymous denuncia (createWelfareReportAction) and the two
 * adoption-application actions, all of which pass `applicant: user ? … : null`
 * into their use-case.
 *
 * "Anonymous is allowed" is not the same claim as "erased, deactivated and
 * mid-maintenance are allowed", which is what a bare `auth.getUser()` gave them.
 * NO_SESSION becomes `user: null`; every other refusal is still a refusal.
 *
 * Deliberately NOT "fall back to anonymous" for an erased account: that would
 * launder a submission from a subject whose PII has already been hashed into an
 * apparently-anonymous one. Refusing says what happened.
 */
export async function resolveOptionalLiveUser(
  options?: RequireLiveUserOptions,
): Promise<OptionalLiveUserResult> {
  const live = await requireLiveUser(options);
  if (live.ok) return live;
  // A session that still owes its first password is NOT anonymous: somebody is
  // holding an institutional account's access link. Laundering that into an
  // anonymous submission is the same mistake as laundering an erased one.
  if (live.reason === "NO_SESSION" && live.passwordSetupPending) {
    return live as OptionalLiveUserResult;
  }
  // Same for an operator who has signed in but not passed the second factor:
  // an identified institutional account, not an anonymous visitor.
  if (live.reason === "NO_SESSION" && live.mfaPending) {
    return live as OptionalLiveUserResult;
  }
  if (live.reason === "NO_SESSION" && live.supabase) {
    return { ok: true, supabase: live.supabase, user: null, profile: null };
  }
  return live as OptionalLiveUserResult;
}

/**
 * Is the platform-wide maintenance kill-switch on?
 *
 * ONE authority for "which env var, read how". The four portal layouts read
 * `process.env.NEXT_PUBLIC_MAINTENANCE_MODE` directly and each decided for
 * itself; four copies of a kill-switch is three chances for one of them to be
 * missed when the variable is renamed, and it is exactly why nothing enforced
 * maintenance on the WRITE path.
 *
 * Layouts still call this and RENDER their portal's screen — that is a layout's
 * job, and rendering in place keeps the URL and costs no round-trip. What moved
 * into requireLiveUser is the ENFORCEMENT: a layout gates a render, and a render
 * is not what a server action performs.
 */
export function isPlatformInMaintenance(): boolean {
  return isMaintenanceMode(process.env.NEXT_PUBLIC_MAINTENANCE_MODE);
}

/**
 * Resolve the caller as a LIVE user, or say why not.
 *
 * Precedence is deliberate:
 *   1. MAINTENANCE — an env read, evaluated before any client or query. The
 *      four portal layouts already short-circuit here for the same reason: the
 *      kill-switch has to work when the DATABASE is the thing being maintained,
 *      so it must not depend on a round-trip.
 *   2. NO_SESSION
 *   3. ACCOUNT_ERASED — outranks deactivation: an erased account has no identity
 *      left to be "merely deactivated".
 *   4. DEACTIVATED
 *   5. SHIFT_EXPIRED — LAST, and the order is the point. It is the mildest
 *      refusal and the only recoverable one: the remedy is to sign in again. An
 *      erased or deactivated account must not be told "your shift ended", which
 *      would invite it to retry forever against an account that will never work.
 *
 * Between DEACTIVATED and SHIFT_EXPIRED sit two refusals that ride on NO_SESSION
 * with a flag instead of owning a reason: a first access that still owes its
 * password (`passwordSetupPending`), and — institutional principals only — a
 * session that has not met the second-factor policy (`mfaPending`, T2-S6).
 */
export async function requireLiveUser(options?: RequireLiveUserOptions): Promise<LiveUserResult> {
  if (isPlatformInMaintenance()) {
    return {
      ok: false,
      supabase: null,
      user: null,
      reason: "MAINTENANCE",
      error: MESSAGES.MAINTENANCE,
    };
  }

  const supabase = options?.supabase ?? (await createClient());
  // The token is passed EXPLICITLY on the bearer path, and that is a hardening,
  // not a style preference (pre-push review, WU-A range).
  //
  // A bare `getUser()` on a client built by `createClientFromBearer` works today
  // only because supabase-js sets an internal `hasCustomAuthorizationHeader`
  // flag when a custom `Authorization` header is present, and auth-js
  // special-cases that flag to validate the header's token instead of looking
  // for a stored session. Nothing in the public API says so. An SDK downgrade —
  // or a refactor inside auth-js — turns every bearer request into a permanent
  // 401 with no other symptom, on the one code path a native client cannot work
  // around. `getUser(jwt)` is the DECLARED way to ask the same question, so the
  // behaviour stops being incidental.
  //
  // The cookie path passes nothing and is byte-identical to before: there is no
  // token in hand there, and `getUser()` reading the SSR client's stored session
  // is exactly what it is documented to do.
  const {
    data: { user },
  } = await supabase.auth.getUser(options?.accessToken);
  if (!user) {
    return { ok: false, supabase, user: null, reason: "NO_SESSION", error: MESSAGES.NO_SESSION };
  }

  // DB-resolved, never claim-resolved. Request-memoized, so a render pass that
  // also hits a layout guard and a page pays exactly one round-trip.
  const profile = await getProfileCached(user.id);

  // LOOSE `!= null`, deliberately — byte-for-byte the predicate the guards this
  // module absorbs already used (`profile?.deletedAt != null` in
  // requireUserOrRedirect and requirePetAccess). lib/infra/role-landing.ts's
  // isErasedAccount/isDeactivatedInstitutional use STRICT `!== null`, which
  // treats a profile shape that simply omits the column as erased. Production
  // never sees that (getProfileCached always selects both columns) but the
  // difference is real and this guard is not the place to change it — see the
  // adjacent finding in the T1.2 report.
  if (profile?.deletedAt != null) {
    return {
      ok: false,
      supabase,
      user: { id: user.id },
      reason: "ACCOUNT_ERASED",
      error: MESSAGES.ACCOUNT_ERASED,
    };
  }

  // EVERY ACCOUNT TYPE, as of this change. The predicate used to be
  // institutional-only, matching isDeactivatedInstitutional, and the comment
  // that stood here refused the one-line widening on the correct grounds:
  //
  //   "`deactivated_at` on a PERSONAL account is today a bookkeeping flag that
  //    nothing reads for access — self-deactivating a personal account
  //    currently costs the user nothing, and closing that needs a landing
  //    screen to bounce to, not a one-line predicate widening here."
  //
  // That was right, and the condition it set is what this change satisfies
  // rather than skips. `DeactivateAccountDialog` promised a person "esta acción
  // es irreversible desde el panel" and then cost them nothing at all: the
  // column was written and no boundary ever read it. Widening the predicate
  // ALONE would have converted that lie into a dead end — every write refused,
  // with copy telling the user to contact support about a decision they made
  // themselves and can perfectly well reverse.
  //
  // So the surface came with it, and it is NOT a landing screen to bounce to.
  // A bounce is exactly the shape DEACTIVATED must never take: requireUserOrRedirect
  // tolerates this refusal on purpose (auth-guards.ts) because bouncing a
  // deactivated account off every surface is the 2026-07-04
  // ERR_TOO_MANY_REDIRECTS incident. The surface is therefore IN PLACE —
  // a persistent banner in the citizen shell and a reactivation card on /cuenta
  // — and it needs no redirect to be reached, which is the property that keeps
  // this safe. Reads stay open; writes stop; the way back is one click.
  if (profile?.deactivatedAt != null) {
    const institutional = profile.accountType === "institutional";
    return {
      ok: false,
      supabase,
      // email carried here (and NOT on the erased branch) because this is the
      // one refusal a page-level caller is allowed to tolerate — see
      // requireUserOrRedirect. An erased account has no identity left to hand back.
      user: { id: user.id, email: user.email },
      reason: "DEACTIVATED",
      // Account-type-specific, because the two remedies are different acts by
      // different people. The REASON stays one value: the wire contract
      // (`account_deactivated`, 403) and every consumer of it are unchanged,
      // and a native client still has exactly one code to handle.
      error: institutional ? DEACTIVATED_MESSAGE_INSTITUTIONAL : DEACTIVATED_MESSAGE_PERSONAL,
    };
  }

  // FIRST ACCESS (pilot T1-P3). A session minted by an institutional account's
  // access link, before the person has chosen a password, may do exactly one
  // thing: choose it, at /primer-acceso (whose action does not come through
  // here — it reads GoTrue directly and REQUIRES this flag). Page loads were
  // already sent there by requireUserOrRedirect; this closes the rest — every
  // server action and every /api/v1 bearer route — which used to act freely
  // with the unfinished session.
  //
  // WHY IT RIDES ON NO_SESSION instead of a sixth reason: every write boundary
  // already knows how to render NO_SESSION (`{ error: live.error }` on the web,
  // `auth_expired` 401 on /api/v1), and the ~20 exhaustive refusal switches in
  // app/api/v1 plus the native client's wire contract stay untouched. For the
  // purpose of acting, "no session yet" is what this is: the account is not
  // usable until the password step is done. The specific copy travels in
  // `error`, and `passwordSetupPending` lets requireUserOrRedirect send the
  // person to /primer-acceso rather than to a login they cannot complete.
  //
  // AFTER erased/deactivated on purpose: those are the truer answers and
  // requireUserOrRedirect's DEACTIVATED tolerance must keep working.
  // `user` is what getUser() just fetched from GoTrue, so the flag is the
  // server's, never a stale token claim.
  if (isPasswordSetupPending(user)) {
    return {
      ok: false,
      supabase,
      user: { id: user.id, email: user.email },
      reason: "NO_SESSION",
      error: PASSWORD_SETUP_PENDING_MESSAGE,
      passwordSetupPending: true,
    };
  }

  // B9 + T2-S6. The token was validated by `getUser()` immediately above, which
  // is the precondition `verifiedSessionClaims` documents — this is the one place
  // in the codebase that reads the session's age and assurance level for a
  // guard, and it is a few lines from the proof.
  const claims = await verifiedSessionClaims(supabase, options?.accessToken);
  const sessionStartedAt = sessionStartFromClaims(claims);

  if (isInstitutionalPrincipal(profile)) {
    // SECOND FACTOR (T2-S6), BEFORE the shift: an operator who has not passed
    // it has not finished signing in, so "your shift ended" would be the wrong
    // sentence. `user.factors` is GoTrue's answer from the getUser() above, the
    // aal claim is from the token that same call validated — never client state.
    const mfa = mfaRequirement({
      factors: (user as { factors?: MfaFactorLike[] }).factors,
      aal: assuranceLevel(claims),
    });
    if (mfa === "enrol" || mfa === "challenge") {
      return {
        ok: false,
        supabase,
        user: { id: user.id, email: user.email },
        reason: "NO_SESSION",
        error: mfa === "enrol" ? MFA_ENROL_MESSAGE : MFA_CHALLENGE_MESSAGE,
        mfaPending: mfa,
      };
    }
    // FAILS OPEN and reports — the operator-shift reasoning, see mfa-policy.ts.
    // ONE report per degraded token: when the session start is unknown too, the
    // shift check below reports the same unreadable token, and a second row for
    // it would double every alert about one fault.
    if (mfa === "unknown" && sessionStartedAt !== null) {
      reportError(
        "mfa-policy/live-user",
        new Error(
          "Institutional session carried no readable aal claim; the second-factor " +
            "requirement could not be evaluated for this request.",
        ),
      );
    }

    if (isOperatorShiftExpired({ sessionStartedAt, context: "live-user" })) {
      return {
        ok: false,
        supabase,
        // Carried, like DEACTIVATED: the caller that translates this refusal has
        // to sign the operator out, and signing out is something you do to a
        // known identity.
        user: { id: user.id, email: user.email },
        reason: "SHIFT_EXPIRED",
        error: MESSAGES.SHIFT_EXPIRED,
      };
    }
  }

  return { ok: true, supabase, user: withEmailConfirmed(user), profile, sessionStartedAt };
}

/**
 * The GoTrue user, plus the one bit the addressee rules need (A09-1).
 *
 * `email_confirmed_at` is GoTrue's own column and the ONLY server-side record
 * that somebody read the address on the account. It is folded into a boolean
 * here so no caller has to reach into a snake_case SDK field, and so the whole
 * codebase asks the question in one shape.
 *
 * IT IS NOT A MAILBOX PROOF ON ITS OWN. A project with `enable_confirmations`
 * OFF auto-confirms at signup and stamps this column itself, so the flag is
 * always true there. It closes the shapes a project WITH confirmations on can
 * still produce — an admin-created account, an identity imported from a provider
 * that did not verify the address — and it is a second lock, never the setting's
 * replacement. The premise and its limit are written up in
 * `docs/architecture/mobile-contract.md` section 1.4.
 */
function withEmailConfirmed<T extends { email_confirmed_at?: string | null }>(
  user: T,
): T & { emailConfirmed: boolean } {
  return { ...user, emailConfirmed: user.email_confirmed_at != null };
}

// The session's claims come from `verifiedSessionClaims`
// (lib/infra/verified-token-claims.ts): the bearer path hands its token in, the
// cookie path reads it back with `getSession()` after `getUser()` accepted the
// same cookie. It swallows its own failure and answers null, which the shift
// reads as "start unknown" (fail open, report) and the second-factor policy as
// "unknown" (fail open, report). Letting it throw would turn a degraded
// hardening into a total outage of every authenticated surface.

/**
 * Does the 8-hour shift apply to this profile? (B9)
 *
 * An OR over role and accountType, not an AND, and not a check of either one
 * alone. The DB-level `profiles_account_type_role_match` CHECK was added in
 * migration 0015 and DROPPED in 0016 in favour of app-layer enforcement, so
 * nothing in Postgres guarantees the two columns agree. A `govt` row that says
 * `personal`, or an `institutional` row still carrying `owner`, is a shape the
 * database permits — and either one is an operator account. The union is the
 * predicate that survives that looseness; requiring both would let a single
 * mismatched column silently opt an operator out of the boundary.
 *
 * The platform roles are admin, govt AND national (migration 0214's read-only
 * institutional role). Its database twin is `public.caller_meets_institutional_aal()`
 * (migration 0231): account_type = 'institutional' OR role IN ('admin', 'govt',
 * 'national'). The two must name the same set — a `national` on a personal
 * account that this predicate missed would never be asked for the second
 * factor, while RLS would refuse its aal1 token everywhere.
 *
 * Exported for the org capability path, which applies the same policy to a
 * principal this predicate cannot see (org staff on a personal profile), and
 * for the MFA gate (src/modules/auth/application/mfa/mfa-session.ts).
 *
 * A null profile — the mid-signup window, where auth.users exists and the
 * profile row does not — is NOT institutional. There is no operator yet, and
 * refusing there would break signup for everybody.
 */
export function isInstitutionalPrincipal(profile: CachedProfile | null): boolean {
  if (!profile) return false;
  return (
    profile.accountType === "institutional" ||
    profile.role === "govt" ||
    profile.role === "admin" ||
    profile.role === "national"
  );
}
