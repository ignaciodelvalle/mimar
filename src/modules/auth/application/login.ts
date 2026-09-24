// Use-case: login — password credential check + role-based landing
// (strangler migration 26/61; decoupled from the web request in WU-A).
//
// WHAT MOVED, AND WHAT DID NOT
// ---------------------------------------------------------------------------
// This file used to take `FormData`, read `headers()` for the caller IP and
// build its own cookie-backed Supabase client. All three were the web request
// leaking into a use-case, and together they were why `login.ts` sat on the
// application-fence exemption list (ADR 2026-07-18, Decision 1). They now live
// at the ACTION edge (`src/modules/auth/actions.ts`) and at the `/api/v1`
// adapter, which pass plain data and one injected port.
//
// NOTHING ELSE MOVED. The order of operations, the two rate-limit budgets and
// their keys, the refusal copy and the landing decision are the same
// statements in the same sequence — the diff is the boundary, not the
// behaviour, and the tests that pinned the old shape still pin this one.
//
// THE ORDER IS THE SECURITY PROPERTY, AND IT IS FIRST-CLASS HERE
// ---------------------------------------------------------------------------
// The limiter runs BEFORE GoTrue and before any profile lookup. A limiter
// placed after a credential check bounds nothing that matters: the expensive,
// oracle-bearing work has already happened by the time it refuses. Because
// BOTH transports call this function, an attacker cannot get a fresh budget by
// switching from the form to the API — the buckets and the keys are these, and
// there is only one of them.
//
// NAV CONTRACT N3: this use-case RETURNS a landing path; it does not call
// next/navigation's redirect(). See AuthFormState.redirectTo for the mechanism
// and lib/ui/full-page-action-nav.ts for the evidence. lint:action-redirect
// keeps it that way.
//
// @no-auth-required: login is by definition pre-authentication.

import { and, eq, isNull } from "drizzle-orm";

import { db, organizationMemberships, profiles } from "@/db";
import { RateLimitError, emailRateLimitKey, enforceRateLimit } from "@/lib/infra/rate-limit";
import {
  isDeactivatedInstitutional,
  pathForRole,
  resolveVetLanding,
  safeReturnTo,
} from "@/lib/infra/role-landing";

import type { AuthSessionV1 } from "@dim/contract/api";

import { type LoginAuthPort, toAuthSessionV1 } from "./gotrue-port";
import { LOGIN_EMAIL_LIMIT, LOGIN_IP_LIMIT } from "./login-limits";

// Friendly, non-enumerating message shown when either the per-IP or per-email
// login budget is exceeded. Deliberately identical regardless of which budget
// tripped, so it never signals whether the email is a known account.
const TOO_MANY_ATTEMPTS = "Demasiados intentos. Esperá un momento y volvé a probar.";

/**
 * Plain-data input. `callerIp` is resolved by the caller from the request
 * (`callerIp(headers)`) and is NOT client-supplied: it is the trusted edge IP
 * (x-real-ip / last XFF hop), never the spoofable first XFF segment.
 */
export type LoginInput = {
  email: string;
  password: string;
  /** Web-only. Sanitized here with `safeReturnTo` no matter who sent it. */
  returnTo?: string | null;
  callerIp: string;
};

export type LoginDeps = {
  /**
   * Builds the GoTrue client, and is called ONLY after validation and both
   * rate-limit budgets have passed. A factory rather than an already-built
   * client on purpose: the web edge's factory reads cookies, and constructing
   * it eagerly would move a request-bound side effect ahead of the gates that
   * are supposed to run first.
   */
  auth: () => Promise<LoginAuthPort>;
};

/** Machine-readable failure branches (api-invariants.md §3's shape). */
export type LoginErrorCode =
  | "missing_fields"
  | "rate_limited"
  | "invalid_credentials"
  | "account_deactivated";

export type LoginValue = {
  userId: string;
  /**
   * The address GoTrue holds for the account that just authenticated, or null
   * if it holds none (a phone-only account is representable in GoTrue even
   * though nothing in this product mints one).
   *
   * IT IS NOT THE ADDRESS THE CALLER TYPED, and that is the whole reason it
   * exists. `POST /api/v1/auth/login` needs an e-mail to compute
   * `profilePending` — `isIdentityPending` compares the display name against
   * the address's local part — and it was passing `parsed.data.email`, i.e. a
   * REQUEST BODY field, into that predicate. The two agree today (GoTrue matches
   * addresses case-insensitively and the predicate lowercases both sides), so
   * this is a shape fix rather than a live hole; a value the client controls
   * must not be an input to a server-side decision, because the next reader of
   * that line has to re-derive why it is safe.
   *
   * Never an authorization key: see `LiveUserSuccess.user.email` for why an
   * address answers WHO ONLY as a display fallback and never WHETHER.
   */
  email: string | null;
  /**
   * The role used to resolve `landingPath`, DEFAULTED to "owner" when the
   * account has no profile row yet.
   *
   * That default is correct for its one job — a person mid-signup still has to
   * land somewhere, and the owner shell is where they finish registering — and
   * it is exactly wrong as an answer to "what role is this account". Read
   * `profile` for that. Nothing may put this field on a wire: `GET /api/v1/me`
   * deliberately declines to name a role for a profile-less account ("'owner' is
   * a bad guess to make about a person who has not finished registering"), and
   * `LoginV1` reporting one anyway is the inconsistency the pre-push review of
   * the WU-A range found.
   */
  role: string;
  /**
   * The account's REAL profile, or null in the mid-signup window where
   * `auth.users` exists and `profiles` does not yet.
   *
   * Null is a normal, reachable state and not an error: `POST /api/v1/auth/signup`
   * parks a native account in exactly that window, because identity completion
   * (first name, last name, DNI) has no `/api/v1` door yet. Already read for the
   * deactivation check above, so carrying it costs no extra round-trip.
   */
  profile: {
    role: "owner" | "vet" | "govt" | "admin" | "national";
    accountType: "personal" | "institutional";
    displayName: string;
  } | null;
  /**
   * Where the WEB should land. Resolved here because resolving it needs the
   * role this function already read, and a second reader would be a second
   * round-trip. A native caller ignores it — see `LoginV1`, which does not
   * carry it onto the wire.
   */
  landingPath: string;
  /**
   * The tokens GoTrue issued. The web edge drops them (the cookie client has
   * already persisted the session); `/api/v1` returns them, because a native
   * client has no cookie jar and this is the only moment it can receive them.
   */
  session: AuthSessionV1 | null;
};

export type LoginResult =
  | { ok: true; value: LoginValue }
  // `message` is the es-AR copy each surface renders; `code` is what a client
  // switches on (ADR 2026-07-18, Decision 2). Both travel together so the two
  // transports cannot drift into different words for the same refusal.
  | { ok: false; error: { code: LoginErrorCode; message: string } };

function refuse(code: LoginErrorCode, message: string): LoginResult {
  return { ok: false, error: { code, message } };
}

export async function login(input: LoginInput, deps: LoginDeps): Promise<LoginResult> {
  const email = input.email.trim();
  const password = input.password;

  if (!email || !password) {
    return refuse("missing_fields", "Faltan datos.");
  }

  // Rate limit BEFORE touching GoTrue. Two independent budgets:
  //   - per-IP:    caps credential-stuffing volume from one source.
  //   - per-email: caps a distributed (botnet) brute-force against ONE account,
  //                which the per-IP budget alone cannot stop.
  // Keyed off the trusted edge IP the caller resolved (never the spoofable
  // first XFF segment). A non-RateLimitError propagates → fail closed.
  //
  // The NUMBERS live in ./login-limits.ts with the argument that chose them —
  // they used to be object literals right here, where the per-IP ceiling sat at
  // twice the per-email one and nobody had to meet a paragraph to move it.
  try {
    await enforceRateLimit("auth_login_ip", input.callerIp, LOGIN_IP_LIMIT);
    await enforceRateLimit("auth_login_email", emailRateLimitKey(email), LOGIN_EMAIL_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) return refuse("rate_limited", TOO_MANY_ATTEMPTS);
    throw err;
  }

  const auth = await deps.auth();
  const { data: signInData, error } = await auth.signInWithPassword({ email, password });

  if (error || !signInData.user) {
    // ONE refusal for "no such account" and "wrong password". The two must stay
    // indistinguishable or this becomes the account-enumeration oracle that
    // audit 28-#3 closed on the signup form.
    //
    // The `!signInData.user` half is new and is the ONE behavioural difference
    // from the pre-WU-A version, which read `signInData.user.id` straight after
    // checking `error`. GoTrue's own type says that shape is impossible
    // (no error ⇒ a user), so this is unreachable today; if it ever happens the
    // old code threw a TypeError out of a login form and this refuses. Refusing
    // is the honest answer to "the provider said yes and named nobody".
    return refuse("invalid_credentials", "Correo o contraseña incorrectos.");
  }

  const userId = signInData.user.id;
  // GoTrue's own record for the account it just authenticated, not the string
  // the caller sent. See `LoginValue.email`.
  const accountEmail = signInData.user.email ?? null;

  // returnTo wins over role-based landing when it's a safe same-origin path
  // (set by the apply-intent flow on the login form). For institutional
  // accounts we still fall through to the role landing — the (app) layout
  // would bounce them off anyway, this just shortens the loop.
  const returnTo = safeReturnTo(input.returnTo ?? "");

  // Fetch role for landing-page resolution (+ deactivation status, task #39).
  const [profile] = await db
    .select({
      role: profiles.role,
      accountType: profiles.accountType,
      // Added for `LoginValue.profile` (pre-push review, WU-A range): the same
      // field `GET /api/v1/me` returns, on the same query that was already
      // running. A native client that logs in should not have to call `/me`
      // immediately to learn the name to greet the user with.
      displayName: profiles.displayName,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  // A deactivated institutional account must not hold a session: every portal
  // guard bounces it to `/`, whose role-redirect would send it back — an
  // infinite 307 loop that ends in a browser error page with no feedback and
  // no logout surface (observed live 2026-07-04). Sign the session back out
  // and surface a real error instead.
  //
  // The sign-out matters on BOTH transports and for different reasons: on the
  // web it clears the cookie the SSR client just wrote; over `/api/v1` it
  // revokes the tokens GoTrue just minted, which this function is about to
  // refuse to hand back. Skipping it there would leave a live credential for an
  // account the app just declared unusable.
  if (isDeactivatedInstitutional(profile)) {
    await auth.signOut();
    return refuse(
      "account_deactivated",
      "Tu cuenta institucional está desactivada. Contactá al equipo de miMAR.",
    );
  }

  // The LANDING role. Defaulting to "owner" is right for choosing a destination
  // and wrong as a claim about the account — see `LoginValue.role`. The honest
  // answer travels beside it, and is null when there is no profile row.
  const role = profile?.role ?? "owner";
  const resolvedProfile: LoginValue["profile"] = profile
    ? {
        role: profile.role,
        accountType: profile.accountType,
        displayName: profile.displayName,
      }
    : null;
  const session = toAuthSessionV1(signInData.session);

  // Institutional roles ignore returnTo here: their portal guard restores the
  // attempted deep link itself (x-full-path, lib/infra/auth-guards.ts).
  if (returnTo && role !== "admin" && role !== "govt" && role !== "national") {
    return {
      ok: true,
      value: {
        userId,
        email: accountEmail,
        role,
        profile: resolvedProfile,
        landingPath: returnTo,
        session,
      },
    };
  }

  if (role === "vet") {
    return {
      ok: true,
      value: {
        userId,
        email: accountEmail,
        role,
        profile: resolvedProfile,
        landingPath: await resolveVetLanding(userId),
        session,
      },
    };
  }

  // For owners: check whether they hold an active admin membership in any org
  // so we can drop them directly into the org portal.
  let hasOrgAdminMembership = false;
  if (role === "owner") {
    const [membership] = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.role, "admin"),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    hasOrgAdminMembership = !!membership;
  }

  return {
    ok: true,
    value: {
      userId,
      email: accountEmail,
      role,
      profile: resolvedProfile,
      landingPath: pathForRole(role, { hasOrgAdminMembership }),
      session,
    },
  };
}
