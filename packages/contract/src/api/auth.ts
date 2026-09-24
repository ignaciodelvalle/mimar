// The wire shapes of the `/api/v1` auth surface — what a native client gets
// back from `POST /auth/signup`, `POST /auth/login` and `GET /me`.
//
// These are TYPES ONLY plus two frozen literals, so importing them costs a
// consumer nothing (see the note at the top of `./index.ts`). The REQUEST side
// lives in `@dim/contract/input` (`auth.ts`), which carries zod and therefore a
// runtime dependency; a client that only renders a profile never loads it.

// ---------------------------------------------------------------------------
// The session — and where refreshing it happens
// ---------------------------------------------------------------------------

/**
 * The tokens a successful login hands back, renamed from GoTrue's snake_case
 * into the camelCase every other `/api/v1` payload uses.
 *
 * WHY THERE IS NO `POST /api/v1/auth/refresh`, AND WHY THAT IS NOT AN OVERSIGHT
 * -------------------------------------------------------------------------
 * This is the field a reader will follow looking for the refresh route. There
 * isn't one, deliberately.
 *
 * A native client refreshes against GoTrue DIRECTLY with `refreshToken` — that
 * is what the Supabase mobile SDK does on its own, on a timer, and it is the
 * one thing the SDK is unambiguously better at than a hand-rolled endpoint
 * (clock skew, concurrent-refresh collapsing, retry). Proxying it would buy a
 * round-trip and a second place for the refresh-token rotation window to be got
 * wrong.
 *
 * This does NOT reopen the trap PO decision #2 closed. That decision is about
 * the DATA plane: a native client must not read or write pets, events or
 * custody through PostgREST. It was taken because 14 of 15 `ownerships`-derived
 * RLS policies carried no role predicate and the `pet_events` INSERT policy
 * checked neither role nor event type (RLS audit 2026-08-18); migration 0212
 * (2026-09-02) has since dropped that policy, leaving `pet_events` with no
 * caller-facing write surface. The decision does not depend on that hole being
 * open: direct Supabase access still hands a bearer token reach that
 * `requireLiveUser` and `requirePetAccess` are the only things bounding.
 * Refresh touches none of that: it exchanges one credential for
 * another inside GoTrue and reads no application table. Auth plane, not data
 * plane.
 *
 * What it costs, stated rather than hidden: a refresh performed against GoTrue
 * is invisible to this app, so a session cannot be revoked from here by
 * refusing to refresh it. Remote revocation and the session timebox are WU-E's
 * subject, and WU-E is where that gap is closed — not by adding a proxy route
 * whose only real function would be to sit in the path.
 */
export type AuthSessionV1 = {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token is valid for, as GoTrue reported it. */
  expiresIn: number;
  /**
   * Absolute expiry in epoch SECONDS (GoTrue's unit, not milliseconds). Null
   * when GoTrue sent none — a client must then fall back to
   * `now + expiresIn`, never treat the token as non-expiring.
   */
  expiresAt: number | null;
  /** Always `"bearer"` in practice; carried verbatim rather than assumed. */
  tokenType: string;
};

// ---------------------------------------------------------------------------
// POST /api/v1/auth/login
// ---------------------------------------------------------------------------

/**
 * A successful login (HTTP 200).
 *
 * `user` IS `MeV1User` — the same type `GET /api/v1/me` returns, not a
 * look-alike. That is the fix for a real inconsistency the pre-push review of
 * the WU-A range found, and it is worth stating because the original shape
 * looked perfectly reasonable:
 *
 *   · This payload used to be `{ id, role: string }`, and `role` was the
 *     use-case's LANDING role — which defaults to `"owner"` when the account has
 *     no profile row yet. So a login by an account mid-signup answered
 *     `role: "owner"` while `/me`, for the same account in the same second,
 *     answered `profilePending: true` and deliberately declined to name one
 *     ("'owner' is a bad guess to make about a person who has not finished
 *     registering"). Two endpoints, one account, two different answers, and the
 *     one that guessed was the one a client sees FIRST.
 *   · It is not theoretical. `POST /api/v1/auth/signup` parks native accounts in
 *     exactly that window, because identity completion has no `/api/v1` door
 *     yet — so "logged in, no profile" is the NORMAL state of a brand-new native
 *     user, not an edge case.
 *   · The types disagreed too: `role: string` here against a four-member union
 *     there. A client could not write one exhaustive switch over both, which is
 *     the whole promise of shipping the vocabulary in this package.
 *
 * The profile still rides along rather than forcing a `/me` round-trip — the
 * use-case already read it for the deactivation check. It remains a CONVENIENCE,
 * never an authorization claim: nothing a client sends back about its own role
 * is ever believed, and every subsequent request is re-resolved from the
 * database against the bearer token.
 *
 * NO web landing path is returned. `redirectTo` is the web form's N3 contract
 * (see `AuthFormState`) and means nothing to a client that owns its own
 * navigation stack; shipping it would invite a native app to hard-code
 * `/inicio`.
 */
export type LoginV1 = {
  user: MeV1User;
  session: AuthSessionV1;
};

// ---------------------------------------------------------------------------
// POST /api/v1/auth/signup
// ---------------------------------------------------------------------------

/**
 * A successful signup (HTTP 201).
 *
 * `session` is NULLABLE and both cases are normal:
 *   · a genuine new account, with email confirmations OFF (the current posture,
 *     PO decision 2026-07-10), gets a session immediately and is logged in;
 *   · the account-enumeration masquerade — a signup for an email that already
 *     exists returns this same success shape with NO session, so the response
 *     is not an oracle for which emails are registered (audit 28-#3).
 *
 * A client MUST therefore treat `session: null` as "go to the login screen",
 * never as an error. The residual is stated in `signup.ts` and is the same on
 * both transports: a genuine signup receives a credential and a duplicate does
 * not, which the web leaks through the presence of a session cookie and this
 * leaks through the presence of this field. Identical information, identical
 * cost to probe. Closing it needs email confirmations turned ON in the Supabase
 * dashboard (PO-gated), not a different response shape here.
 */
export type SignupV1 = {
  session: AuthSessionV1 | null;
};

// ---------------------------------------------------------------------------
// POST /api/v1/auth/password-reset
// ---------------------------------------------------------------------------

/**
 * The answer to a recovery request (HTTP 202).
 *
 * A CONSTANT, AND ITS CONSTANCY IS THE ENTIRE PAYLOAD. There is one inhabitant
 * of this type, so the body for an address that has an account and one that does
 * not is the same bytes — not "two generic strings that happen to match today",
 * which is the shape a later edit widens by adding one honest-looking field.
 * `__tests__/api-v1-auth-password-reset-route.test.ts` asserts the equality of
 * the two responses rather than trusting this paragraph.
 *
 * 202 AND NOT 200, deliberately. 200 would claim the request was completed; what
 * actually happened is that it was ACCEPTED and everything downstream of that —
 * whether a token was minted, whether a mail was handed to a provider, whether it
 * arrives — is information this endpoint declines to have. 202 is the status that
 * says so, and it is the same status for both addresses.
 *
 * WHAT A CLIENT DOES WITH IT: show the person the "si existe una cuenta…"
 * sentence and move to the redemption step. It must NEVER render a branch on
 * whether the account exists, because it was not told, and inventing one is how
 * the enumeration oracle gets rebuilt on the phone out of helpfulness (the same
 * failure `LoginV1`'s single `invalid_credentials` exists to prevent).
 *
 * NO PAYLOAD VERSION, NO `issuedAt`, NO `staleAfter`. Those three are §6's
 * envelope for a READ — a snapshot a client may cache and must know the age of.
 * This is an acknowledgement of a command; there is nothing here to go stale, and
 * a client that cached it would be caching the word "ok".
 */
export type PasswordResetRequestedV1 = {
  requested: true;
};

// ---------------------------------------------------------------------------
// GET /api/v1/me
// ---------------------------------------------------------------------------

/** Bump when a field is removed or changes meaning. Adding one is additive. */
export const ME_PAYLOAD_VERSION = 1;

/**
 * How long a cached `/me` may be presented as current. Five minutes, matching
 * the public credential: role and account flags change through an operator
 * action the holder did not perform (an institutional deactivation, an erasure
 * request), so a shell rendered from a stale copy is showing authority the
 * account may no longer have.
 */
export const ME_STALE_AFTER_MS = 5 * 60_000;

/**
 * The MINIMUM a native client needs to render its shell, and nothing else.
 *
 * WHAT IS DELIBERATELY ABSENT, because this is the payload a stolen access
 * token buys and the list is the whole defence:
 *   · no DNI, hashed or last-4 — the shell never displays one (invariant #5);
 *   · no email — `requireLiveUser` exposes it for a nav-avatar fallback on the
 *     web, where it never leaves the server render; putting it on a wire that a
 *     device caches to disk is a different decision, and this is not the change
 *     that takes it;
 *   · no phone, address, locality or jurisdiction;
 *   · no pet list, no counts — those are reads, and reads are WU-B.
 *
 * `displayName` IS here: it is what the shell greets the user with, and the
 * `handle_new_user` trigger guarantees it is never null (it falls back to the
 * email local-part). It used to be able to BE that local-part on the wire — the
 * one PII-adjacent thing this payload carried. It no longer can: a name equal
 * to the local-part is exactly what marks an identity as still provisional, and
 * such an account is answered on the `profilePending: true` arm, which carries
 * no name at all. The narrowing is a side effect of the D1 fix rather than its
 * goal, and it is worth stating because the old sentence is the reason a reader
 * would expect otherwise.
 */
export type MeV1User =
  | {
      /**
       * SIGNUP IS NOT FINISHED. A client sees this between step 1 and step 2
       * and should send the user to complete their identity rather than render
       * an empty shell.
       *
       * TWO STATES COLLAPSE INTO THIS ARM, and the reason the wire does not
       * distinguish them is that a client does the same thing for both:
       *
       *   · no `profiles` row at all (`requireLiveUser` returns `profile: null`
       *     and it is a SUCCESS — the caller is live, they simply have no
       *     profile);
       *   · a `profiles` row still carrying the PROVISIONAL, email-derived name
       *     that `handle_new_user` writes, meaning step 2 was never completed.
       *
       * This docblock used to name only the first, and every server that read
       * it built the arm by testing row existence — which is why a brand-new
       * native account walked straight into the pet list under a name nobody
       * had entered (native QA batch 1, D1). The row is created by a trigger
       * INSIDE the transaction that creates `auth.users`, so the first state is
       * not what a fresh signup produces; the second is. Both servers now
       * answer this arm through one projection,
       * `toMeV1User` in `lib/domain/identity-completeness.ts`.
       *
       * A DISCRIMINATED arm rather than a flag beside optional fields: the
       * alternative is a payload whose `role` is a placeholder someone will
       * eventually render, and "owner" is a bad guess to make about a person
       * who has not finished registering — which is precisely the value a
       * provisional row holds, since the trigger hard-codes it.
       */
      profilePending: true;
      id: string;
    }
  | {
      profilePending: false;
      id: string;
      displayName: string;
      role: "owner" | "vet" | "govt" | "admin" | "national";
      accountType: "personal" | "institutional";
    };

export type MeV1 = {
  payloadVersion: typeof ME_PAYLOAD_VERSION;
  /** ISO-8601 — when the server built this snapshot. */
  issuedAt: string;
  /** ISO-8601 — after this, the snapshot must not be shown as current. */
  staleAfter: string;
  user: MeV1User;
};
