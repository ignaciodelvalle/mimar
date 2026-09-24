// POST /api/v1/auth/login and POST /api/v1/auth/signup — the two adapters that
// let a client with no cookie jar establish a session.
//
// WHAT THIS FILE HAS TO PROVE, AND WHY EACH PART EXISTS
// ---------------------------------------------------------------------------
// The use-cases' own behaviour (gate ORDER, fail-closed, the enumeration
// masquerade) is proved without a web request in
// src/modules/auth/application/__tests__/auth-use-cases.test.ts. This file
// proves the things that are the ROUTE's own:
//
//   1. THE ENVELOPE. Status codes, the single-key `{ error }` body, and
//      `cache-control: no-store` on EVERY branch. §4: no-store is NOT inherited
//      — middleware stamps it from a path-prefix allowlist `/api/…` is not on —
//      so a test that checks the happy path only would certify exactly the
//      branch nobody forgets. These bodies carry session TOKENS.
//   2. NON-ENUMERATION AS EQUALITY. An unknown email and a wrong password must
//      produce the same status, the same body AND the same headers. Asserted as
//      one equality, not as two "looks generic enough" checks.
//   3. THE SHARED BUDGET. The bucket names and keys this route spends are the
//      form's — `auth_login_ip` and `auth_login_email` keyed on the SHA-256 of
//      the normalized email. If they ever diverge, an attacker gets a second
//      budget by switching transport, and nothing else in the suite would see
//      it.
//   4. THE WIRE SHAPE a native client consumes: camelCase, `expiresAt` in
//      SECONDS, and no web landing path anywhere in the payload.
//
// HOW THE MOCKING WORKS
// ---------------------------------------------------------------------------
// GoTrue is replaced (there is no local user to sign in as, and the point here
// is the mapping, not Supabase's password check). EVERYTHING ELSE IS REAL: the
// real schemas, the real use-cases, the real profile and membership queries
// against the local database — a random UUID simply resolves to no rows, which
// is the "brand new account" path. The limiter is mocked to a no-op by default
// so the routes do not write counters for every case; the cases that are ABOUT
// the limiter drive it explicitly.

import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  /** GoTrue's answer for the next call. */
  answer: null as null | Record<string, unknown>,
  /** Every collaborator the route reached, in order. */
  calls: [] as string[],
  /** Buckets + keys handed to the limiter, in order. */
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  /**
   * The CEILINGS handed to the limiter, in order — recorded separately from
   * `limits` so the existing `toEqual` assertions on bucket+key keep their
   * exact shape. This is what catches a call site that goes back to writing an
   * object literal instead of spending the derived constant.
   */
  limitConfigs: [] as unknown[],
  /** When set, the limiter throws it. */
  limiterThrows: null as null | (() => never),
}));

vi.mock("@/lib/supabase/anon", () => ({
  createAnonClient: () => {
    control.calls.push("anon-client");
    return {
      auth: {
        signInWithPassword: async () => {
          control.calls.push("signInWithPassword");
          return control.answer;
        },
        signUp: async () => {
          control.calls.push("signUp");
          return control.answer;
        },
        signOut: async () => {
          control.calls.push("signOut");
          return { error: null };
        },
      },
    };
  },
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string, config: unknown) => {
      control.limits.push({ endpoint, identifier });
      control.limitConfigs.push(config);
      control.limiterThrows?.();
    },
  };
});

import { db, profiles } from "@/db";
import { RateLimitError, emailRateLimitKey } from "@/lib/infra/rate-limit";
import {
  LOGIN_EMAIL_LIMIT,
  LOGIN_IP_LIMIT,
  LOGIN_SIMULTANEOUS_CALLERS,
} from "@/src/modules/auth/application/login-limits";
import {
  HOURS_PER_DAY,
  SIGNUP_ATTEMPTS_PER_PERSON,
  SIGNUP_DRIVES_PER_HOUR,
  SIGNUP_DRIVE_SIZE,
  SIGNUP_IP_LIMIT,
  SIGNUP_SUPERSEDED_HOURLY_IP_CEILING,
} from "@/src/modules/auth/application/signup-limits";

import { POST as loginRoute } from "@/app/api/v1/auth/login/route";
import { POST as signupRoute } from "@/app/api/v1/auth/signup/route";

const IP = "203.0.113.7";

const GOTRUE_SESSION = {
  access_token: "access-token-value",
  refresh_token: "refresh-token-value",
  expires_in: 3600,
  expires_at: 1_800_000_000,
  token_type: "bearer",
};

function post(path: string, body: unknown, init?: { raw?: string }) {
  return new Request(`http://localhost:3000/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": IP },
    body: init?.raw ?? JSON.stringify(body),
  });
}

/** Status + body + the headers a client can observe, as one comparable value. */
async function fingerprint(res: Response) {
  return {
    status: res.status,
    body: await res.json(),
    cacheControl: res.headers.get("cache-control"),
    contentType: res.headers.get("content-type"),
    retryAfter: res.headers.get("retry-after"),
  };
}

beforeEach(() => {
  control.answer = null;
  control.calls = [];
  control.limits = [];
  control.limitConfigs = [];
  control.limiterThrows = null;
});

// ---------------------------------------------------------------------------
// The envelope, on every branch
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/login — the envelope", () => {
  it("sets cache-control: no-store on a REFUSAL as well as a success", async () => {
    // A login response carries either a reason to retry or a pair of session
    // tokens. Neither may ever sit in a shared cache.
    control.answer = { data: { user: null, session: null }, error: { message: "Invalid" } };
    const refusal = await loginRoute(post("/auth/login", { email: "a@b.co", password: "x" }));
    expect(refusal.headers.get("cache-control")).toBe("no-store");

    control.answer = {
      data: { user: { id: randomUUID() }, session: GOTRUE_SESSION },
      error: null,
    };
    const success = await loginRoute(post("/auth/login", { email: "a@b.co", password: "x" }));
    expect(success.headers.get("cache-control")).toBe("no-store");
    expect(success.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("answers invalid_request for a body that is not JSON at all", async () => {
    const res = await loginRoute(post("/auth/login", null, { raw: "not json{" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    // A malformed body costs the platform no counter, and reveals nothing.
    expect(control.limits).toEqual([]);
    expect(control.calls).toEqual([]);
  });

  it("answers invalid_request when the body misses a required field", async () => {
    const res = await loginRoute(post("/auth/login", { email: "a@b.co" }));
    expect(res.status).toBe(400);
    // Single-key envelope (§2): no field detail. The client validated with the
    // same schema before sending and already has per-field codes locally.
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });
});

// ---------------------------------------------------------------------------
// Non-enumeration
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/login — refusals are not an oracle", () => {
  it("answers an unknown email and a wrong password IDENTICALLY", async () => {
    // Same status, same body, same headers. Two hand-written generic messages
    // drift apart; one equality assertion cannot.
    control.answer = {
      data: { user: null, session: null },
      error: { message: "Invalid login credentials" },
    };
    const unknownEmail = await fingerprint(
      await loginRoute(post("/auth/login", { email: "nadie@example.com", password: "x" })),
    );

    control.answer = {
      data: { user: null, session: null },
      error: { message: "Invalid login credentials" },
    };
    const wrongPassword = await fingerprint(
      await loginRoute(post("/auth/login", { email: "existe@example.com", password: "mala" })),
    );

    expect(unknownEmail).toEqual(wrongPassword);
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual({ error: "invalid_credentials" });
  });

  it("never leaks the submitted email back in the body", async () => {
    // The web form echoes the email so React 19's post-action reset does not
    // wipe it. There is no form here, and a body that repeated the address
    // would make a 401 quotable as proof somebody tried that account.
    control.answer = { data: { user: null, session: null }, error: { message: "Invalid" } };
    const res = await loginRoute(
      post("/auth/login", { email: "secreto@example.com", password: "x" }),
    );
    expect(JSON.stringify(await res.json())).not.toContain("secreto@example.com");
  });

  it("carries NO retry-after on the 429 — only one branch could be honest", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "auth_login_ip");
    };
    const res = await loginRoute(post("/auth/login", { email: "a@b.co", password: "x" }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    // A header on the per-IP branch and not the per-email one would make the
    // two 429s distinguishable (api-invariants.md §10).
    expect(res.headers.get("retry-after")).toBeNull();
    // And GoTrue was never reached — not even the client was built.
    expect(control.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shared budget
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/login — the budget is the web form's", () => {
  it("spends auth_login_ip then auth_login_email, keyed on IP and the HASHED email", async () => {
    control.answer = { data: { user: null, session: null }, error: { message: "Invalid" } };
    await loginRoute(post("/auth/login", { email: "  ANA@Example.com ", password: "x" }));

    // Identical buckets and identical keys to the form's. This is what stops an
    // attacker from getting a fresh budget by switching transport — and the
    // only place in the suite where that equivalence is checked from the API
    // side.
    expect(control.limits).toEqual([
      { endpoint: "auth_login_ip", identifier: IP },
      { endpoint: "auth_login_email", identifier: emailRateLimitKey("ana@example.com") },
    ]);
    // The raw address never becomes a bucket key: rate_limit_buckets is
    // readable by every worker and an email is PII (Ley 25.326).
    expect(control.limits[1]?.identifier).not.toContain("ana@example.com");
  });

  it("keys the per-IP budget on the trusted edge IP, not a spoofable one", async () => {
    control.answer = { data: { user: null, session: null }, error: { message: "Invalid" } };
    const req = new Request("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The FIRST x-forwarded-for segment is client-controlled. callerIp
        // takes the LAST hop, and x-real-ip outranks both.
        "x-forwarded-for": "1.2.3.4, 198.51.100.9",
      },
      body: JSON.stringify({ email: "a@b.co", password: "x" }),
    });
    await loginRoute(req);
    expect(control.limits[0]).toEqual({ endpoint: "auth_login_ip", identifier: "198.51.100.9" });
  });

  it("spends the derived ceilings themselves, not a literal at the call site", async () => {
    // The two ceilings lived as object literals inside `login.ts` until the
    // per-IP one was re-derived (see login-limits.ts). A literal at the call
    // site is how the old number got to be twice the per-email one without ever
    // meeting an argument, so the route is held to spending the CONSTANTS —
    // which is what makes the relationship assertions below mean anything about
    // what actually runs, rather than about two numbers nobody reads.
    //
    // `toBe` AND NOT `toEqual`, WHICH IS THE ENTIRE ASSERTION. This test claimed
    // to catch "a call site that went back to an object literal" while comparing
    // STRUCTURALLY, so `{ maxPerMinute: 60, maxPerHour: 240 }` re-inlined in
    // `login.ts` passed it — the exact edit the test names, sailing through the
    // test that names it. Identity is what "spends the CONSTANT" means: the
    // limiter records the object it was handed, so only the shared reference
    // satisfies this. A re-inlined literal now fails on the first spend.
    control.answer = { data: { user: null, session: null }, error: { message: "Invalid" } };
    await loginRoute(post("/auth/login", { email: "a@b.co", password: "x" }));

    expect(control.limitConfigs).toHaveLength(2);
    expect(control.limitConfigs[0]).toBe(LOGIN_IP_LIMIT);
    expect(control.limitConfigs[1]).toBe(LOGIN_EMAIL_LIMIT);
  });

  it("keeps the per-EMAIL anchor where the brute-force argument put it", async () => {
    // The non-vacuity floor for the two assertions after this one. They are
    // equalities against a product, and `0 === 0 * 12` is true — an anchor
    // silently zeroed would make both of them pass while the ceiling they
    // describe collapsed. It is also the assertion a change to the per-account
    // brute-force ceiling has to walk past on purpose: this bucket is what
    // stops a distributed attack on ONE account, and it is spent on failed
    // attempts too.
    expect(LOGIN_EMAIL_LIMIT.maxPerMinute).toBe(5);
    expect(LOGIN_EMAIL_LIMIT.maxPerHour).toBe(20);
  });

  it("sizes the per-IP ceiling at N callers at their own per-email ceiling, per MINUTE", async () => {
    // The IP bucket's only job is to stay far enough above the email bucket that
    // the EMAIL one is the binding constraint for any plausible crowd behind one
    // address. At the old 10/min it was not: two people at their own ceiling
    // exhausted the whole gateway, which is the shape api-v1-limits.ts named as
    // upside down for the authenticated-write family and fixed there first.
    expect(LOGIN_IP_LIMIT.maxPerMinute).toBe(
      (LOGIN_EMAIL_LIMIT.maxPerMinute ?? 0) * LOGIN_SIMULTANEOUS_CALLERS,
    );
  });

  it("sizes it at the same N per HOUR, and pins that window separately", async () => {
    // PINNED SEPARATELY on purpose, the way password-reset's pair is: the two
    // windows are only multiplied by the same factor here because login's
    // per-email anchor happens to have both. A reader who assumes one factor is
    // structural would "tidy" one of these away, and the hour is the window a
    // whole nightly run — or a whole carrier at 03:00 — actually spends.
    expect(LOGIN_IP_LIMIT.maxPerHour).toBe(
      (LOGIN_EMAIL_LIMIT.maxPerHour ?? 0) * LOGIN_SIMULTANEOUS_CALLERS,
    );
  });
});

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/login — what a native client receives", () => {
  it("reports profilePending — it does NOT fabricate a role — for an account with no profile row", async () => {
    const userId = randomUUID();
    control.answer = { data: { user: { id: userId }, session: GOTRUE_SESSION }, error: null };

    const res = await loginRoute(post("/auth/login", { email: "a@b.co", password: "x" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      // THE REGRESSION THIS PINS (pre-push review of the WU-A range). A UUID with
      // no profile row is the brand-new-account path, and it is the NORMAL state
      // of a native user: signup parks them there, and they leave it through
      // `POST /api/v1/me/identity` — which landed 2026-09-05, so this comment's
      // "identity completion has no /api/v1 door yet" is no longer the reason the
      // state exists; it is simply the state between step 1 and step 2. Nothing
      // about the assertion changes: a brand-new account is still
      // `profilePending: true` here. This endpoint used to answer `role: "owner"`
      // for it —
      // the use-case's LANDING default, which exists to pick a web destination —
      // while `GET /api/v1/me`, for the same account in the same second, answered
      // `profilePending: true` and deliberately declined to name a role. Two
      // endpoints, one account, two answers, and the guess came first.
      //
      // `user` is now `MeV1User` on both, so a client writes ONE exhaustive
      // switch. The real profile lookup is the use-case's and is exercised
      // against seeded rows in __tests__/auth-actions.test.ts.
      user: { profilePending: true, id: userId },
      session: {
        accessToken: "access-token-value",
        refreshToken: "refresh-token-value",
        expiresIn: 3600,
        // SECONDS, GoTrue's unit. A silent conversion to milliseconds is a bug
        // that only surfaces at the moment a session should have been refreshed.
        expiresAt: 1_800_000_000,
        tokenType: "bearer",
      },
    });
  });

  it("carries NO web landing path — a native client owns its navigation", async () => {
    control.answer = {
      data: { user: { id: randomUUID() }, session: GOTRUE_SESSION },
      error: null,
    };
    const res = await loginRoute(
      // Even when the caller supplies one. `returnTo` is the form's N3 hint and
      // is deliberately not forwarded; shipping it would invite a native app to
      // hard-code "/inicio".
      post("/auth/login", { email: "a@b.co", password: "x", returnTo: "/mascotas" }),
    );
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("redirectTo");
    expect(body).not.toContain("landingPath");
    expect(body).not.toContain("/mascotas");
  });

  it("refuses rather than returning a 200 with no session", async () => {
    // Impossible per GoTrue's own types. A 200 carrying `session: null` would
    // be a "success" a native client cannot act on — there is no cookie here to
    // have quietly carried the credential.
    control.answer = { data: { user: { id: randomUUID() }, session: null }, error: null };
    const res = await loginRoute(post("/auth/login", { email: "a@b.co", password: "x" }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
    expect(res.headers.get("retry-after")).toBe("5");
  });

  // -------------------------------------------------------------------------
  // Identity completeness — the D1 blocker (native QA batch 1)
  // -------------------------------------------------------------------------
  // The profile query below is REAL, against a row this file inserts. That is
  // the only way to reach the branch: a random UUID resolves to no rows, which
  // is the state the cases above use and is NOT what a native signup produces.
  // `handle_new_user` writes a profile row in the same transaction as the
  // `auth.users` row, so the account this endpoint actually meets on a
  // first-ever sign-in HAS a row — one holding the trigger's provisional,
  // email-derived name.
  describe("with a real profiles row", () => {
    const provisionalId = randomUUID();
    const completedId = randomUUID();
    const EMAIL = "d1-provisional@dim-test.local";

    beforeAll(async () => {
      await db.insert(profiles).values([
        {
          id: provisionalId,
          role: "owner",
          accountType: "personal",
          // Exactly what the trigger writes: split_part(email, '@', 1).
          displayName: EMAIL.split("@")[0],
        },
        { id: completedId, role: "owner", accountType: "personal", displayName: "Ana Pérez" },
      ]);
    });

    afterAll(async () => {
      await db.delete(profiles).where(inArray(profiles.id, [provisionalId, completedId]));
    });

    it("reports profilePending for a row still carrying the provisional name", async () => {
      // THE BLOCKER. This endpoint tested row EXISTENCE, so it answered
      // `profilePending: false` here — and `signIn`
      // (apps/mobile/src/auth/session-store.ts) seeds its session state from
      // THIS payload, not from a later `/me`. So the native gate sent a person
      // who had never entered a name straight to "Mis mascotas", where pets can
      // be registered under it.
      control.answer = {
        data: { user: { id: provisionalId, email: EMAIL }, session: GOTRUE_SESSION },
        error: null,
      };

      const res = await loginRoute(post("/auth/login", { email: EMAIL, password: "x" }));

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: unknown };
      expect(body.user).toEqual({ profilePending: true, id: provisionalId });
    });

    it("computes it from GOTRUE's address, not from the one in the request body", async () => {
      // Nit F5, 2026-09-04. `isIdentityPending` compares the display name
      // against an address's local part, and this route used to feed it
      // `parsed.data.email` — a request-body field. Production cannot make the
      // two disagree (GoTrue resolved the account BY that address), which is
      // exactly why the mock does: what is being pinned is the SOURCE, so the
      // next edit cannot quietly put a client-supplied string back into a
      // server-side decision.
      //
      // The discriminator is sharp. Read off the body ("otro"), the provisional
      // name "d1-provisional" does not match and the answer is
      // `profilePending: false` — the D1 blocker, back. Read off GoTrue, it
      // matches and the answer is `true`.
      control.answer = {
        data: { user: { id: provisionalId, email: EMAIL }, session: GOTRUE_SESSION },
        error: null,
      };

      const res = await loginRoute(
        post("/auth/login", { email: "otro@dim-test.local", password: "x" }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: unknown };
      expect(body.user).toEqual({ profilePending: true, id: provisionalId });
    });

    it("reports the full shell once step 2 has written a real name", async () => {
      // The other side of the same predicate, so the case above cannot be
      // satisfied by an endpoint that simply stopped reporting profiles.
      control.answer = {
        data: { user: { id: completedId, email: EMAIL }, session: GOTRUE_SESSION },
        error: null,
      };

      const res = await loginRoute(post("/auth/login", { email: EMAIL, password: "x" }));

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: unknown };
      expect(body.user).toEqual({
        profilePending: false,
        id: completedId,
        displayName: "Ana Pérez",
        role: "owner",
        accountType: "personal",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/signup", () => {
  const VALID = {
    email: "nueva@example.com",
    password: "supersecreta",
    confirmPassword: "supersecreta",
    tosAccepted: true,
  };

  it("answers 201 with the session for a genuine new account", async () => {
    control.answer = {
      data: { user: { id: randomUUID() }, session: GOTRUE_SESSION },
      error: null,
    };
    const res = await signupRoute(post("/auth/signup", VALID));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      session: {
        accessToken: "access-token-value",
        refreshToken: "refresh-token-value",
        expiresIn: 3600,
        expiresAt: 1_800_000_000,
        tokenType: "bearer",
      },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(control.limits).toEqual([{ endpoint: "auth_signup_ip", identifier: IP }]);
  });

  it("answers 201 with session:null for an email that already exists", async () => {
    // The masquerade. A distinguishable "ya existe" is the account-enumeration
    // oracle audit 28-#3 closed on the web form; the status and the key set are
    // the same as a genuine signup's, so a client cannot branch on existence.
    control.answer = {
      data: { user: null, session: null },
      error: { message: "User already registered" },
    };
    const res = await signupRoute(post("/auth/signup", { ...VALID, email: "existe@example.com" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ session: null });
  });

  it("answers 422 weak_password when the provider refused the password", async () => {
    // INVERTED ON 2026-09-11 from "never surfaces the provider's own text on
    // any other failure", which used this exact fixture and demanded the
    // generic 400. A person putting in an easy password was told to come back
    // in a few minutes — advice that cannot work for a problem they could fix
    // on the spot. The provider's string still never crosses; only the code
    // does, and the app owns the sentence.
    control.answer = {
      data: { user: null, session: null },
      error: {
        message: "Password is known to be weak and easy to guess, please choose a different one.",
      },
    };
    const res = await signupRoute(post("/auth/signup", VALID));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "weak_password" });
  });

  it("never surfaces the provider's own text on any OTHER failure", async () => {
    // The generic arm, with a message that has nothing to do with a password —
    // otherwise the branch above swallows this case and the guard tests itself.
    control.answer = {
      data: { user: null, session: null },
      error: { message: "smtp relay refused: 550 mailbox unavailable" },
    };
    const res = await signupRoute(post("/auth/signup", VALID));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "signup_failed" });
  });

  it("rejects an unaccepted TOS before spending anything", async () => {
    // A legal acceptance is never defaulted into being, and the schema is where
    // that is enforced for both transports.
    const res = await signupRoute(post("/auth/signup", { ...VALID, tosAccepted: false }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(control.limits).toEqual([]);
    expect(control.calls).toEqual([]);
  });

  it("answers 429 without reaching GoTrue when the per-IP budget refuses", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "auth_signup_ip");
    };
    const res = await signupRoute(post("/auth/signup", VALID));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(control.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The signup budget's derivation
// ---------------------------------------------------------------------------
//
// The sibling of the login block above, and the reason it is a separate block
// rather than four more assertions in that one: login's per-IP ceiling is
// derived from a per-EMAIL anchor, and signup has none to derive from. It
// creates the identity, so a per-email counter reads 1 for a citizen and 1 for a
// farm alike. `signup-limits.ts` carries the whole argument; what is pinned here
// is the arithmetic that argument produced, so that moving a number has to walk
// past the sentence that chose it.

describe("auth_signup_ip — the only bucket this act has", () => {
  const VALID = {
    email: "otra@example.com",
    password: "supersecreta",
    confirmPassword: "supersecreta",
    tosAccepted: true,
  };

  it("spends the derived ceiling itself, not a literal at the call site", async () => {
    // `toBe` AND NOT `toEqual`, for the reason the login sibling spells out: a
    // structural comparison passes for `{ maxPerMinute: 60, ... }` re-inlined in
    // `signup.ts`, which is the exact edit this test exists to catch. Identity is
    // what "spends the CONSTANT" means. The limiter records the object it was
    // handed, so only the shared reference satisfies this.
    //
    // It matters more here than it does for login. This bucket's number lived as
    // an inline literal for its whole life — `login-limits.ts` says so by name
    // ("`auth_signup_ip` is the one still stated as a literal at its own
    // `enforceRateLimit` call site") — and a literal is how a ceiling gets to be
    // whatever somebody typed without meeting an argument.
    control.answer = {
      data: { user: { id: randomUUID() }, session: GOTRUE_SESSION },
      error: null,
    };
    await signupRoute(post("/auth/signup", VALID));

    expect(control.limitConfigs).toHaveLength(1);
    expect(control.limitConfigs[0]).toBe(SIGNUP_IP_LIMIT);
  });

  it("keeps the anchors the derivation is written against", async () => {
    // The non-vacuity floor for every assertion below — they are equalities
    // against products, and `0 === 0 * 3` is true. It is also the assertion a
    // change has to walk past on purpose: TWENTY is not a number invented in
    // `signup-limits.ts`, it is the plaza registration drive `api-v1-limits.ts`
    // sized `/api/v1/localities` against and `app/api/v1/pets/route.ts` sized
    // `api_v1_pets_register_ip` against. Three endpoints, one event, and signup
    // is the door the other two sit downstream of.
    expect(SIGNUP_DRIVE_SIZE).toBe(20);
    expect(SIGNUP_ATTEMPTS_PER_PERSON).toBe(3);
    expect(SIGNUP_DRIVES_PER_HOUR).toBe(3);
  });

  it("sizes the per-MINUTE ceiling at one whole drive, retries included", async () => {
    // 20 people × 3 attempts. The realistic drive spreads over ten minutes or
    // more, so this is the pathological compression rather than the modelled
    // peak — deliberately, because the ceiling api-v1-limits.ts replaced had been
    // sized AT the modelled peak and refused people doing nothing wrong.
    expect(SIGNUP_IP_LIMIT.maxPerMinute).toBe(SIGNUP_DRIVE_SIZE * SIGNUP_ATTEMPTS_PER_PERSON);
  });

  it("sizes the per-HOUR ceiling at three drives, and pins that window separately", async () => {
    // PINNED SEPARATELY on purpose, the way login's and password-reset's pairs
    // are: the two windows are not multiplied by one structural factor, and a
    // reader who assumes they are would "tidy" one of them away.
    expect(SIGNUP_IP_LIMIT.maxPerHour).toBe(
      (SIGNUP_IP_LIMIT.maxPerMinute ?? 0) * SIGNUP_DRIVES_PER_HOUR,
    );
  });

  it("has a per-DAY window at all — the one a patient farm can hit", async () => {
    // THE REGRESSION THIS NAMES IS A DELETION. Before 2026-08-29 this bucket had
    // only short windows, so a farm at exactly the hourly ceiling, all day, every
    // day, from one address tripped nothing. Dropping this window while keeping
    // the two raises above would restore that hole twelvefold.
    //
    // THIS ASSERTION IS REDUNDANCY, NOT AN INDEPENDENT DETECTOR, and the first
    // draft of this comment claimed the opposite — "every other assertion in this
    // block would still pass". That is false, and it was counting four detectors
    // as strength when they are one fact checked four times. Removing `maxPerDay`
    // also fails the three tests that read it: the equality against 15 × 24 reads
    // `undefined`, both comparisons in the sub-linearity test receive `undefined`,
    // and the whole-drive floor gets 0 through its `?? 0`. (The oracle-multiplier
    // test at the end of the block does not read it and stays green — it is the
    // one assertion here that is about the hour rather than the day.) There is no
    // mutation that breaks THIS line alone, because the equality that follows is
    // strictly stronger than `> 0`.
    //
    // It is kept for its NAME rather than its coverage: a deletion should fail a
    // test whose title says the day window is gone, not only one whose title says
    // 360 is not 360. That is a readability argument and it is worth being honest
    // that it is the only one.
    expect(SIGNUP_IP_LIMIT.maxPerDay).toBeGreaterThan(0);
  });

  it("sets the day ceiling at what the SUPERSEDED hourly one already yielded", async () => {
    // THE LOAD-BEARING ASSERTION OF THE WHOLE CHANGE, and the reason
    // `SIGNUP_SUPERSEDED_HOURLY_IP_CEILING` is kept in the file as a constant
    // instead of as a number in a paragraph: `signup-limits.ts` claims that
    // raising the minute and the hour costs NOTHING in daily abuse yield per
    // address, and that claim is only checkable if both sides of it are here.
    //
    //   15/hr × 24 h = 360 accounts per address per day, available before this
    //   change to anyone patient enough to take them slowly.
    //
    // So the day ceiling is not a new allowance; it is the old emergent maximum
    // promoted to a stated one. A future edit that raises it is welcome to — but
    // it has to fail this line first, and the sentence it then has to write is
    // "the daily abuse yield per address is going up", which is the sentence the
    // constant exists to force somebody to say out loud.
    expect(SIGNUP_IP_LIMIT.maxPerDay).toBe(SIGNUP_SUPERSEDED_HOURLY_IP_CEILING * HOURS_PER_DAY);
  });

  it("keeps the day ceiling far below what the hourly one would yield if sustained", async () => {
    // THE MECHANISM, asserted as a relationship rather than as two numbers. The
    // gap between "what an hour allows" and "what a day allows" is the entire
    // instrument: a burst spends its budget and stops, a sustained rate hits the
    // wall. 360 is a twelfth of 24 × 180.
    //
    // THIS LINE IS UNFALSIFIABLE AND THE COMMENT USED TO CLAIM OTHERWISE. It said
    // "this one exists so that a large raise to the hour cannot quietly carry the
    // day along with it", which is wrong twice over.
    //
    // First, the hour is already pinned to one exact value three ways above — the
    // anchors as literals, the minute as their product, the hour as minute ×
    // drives — so a raise to the hour fails one of THOSE, and would sail past this
    // line anyway: at 360/hr with the day scaled to 720, `720 < 360 × 24 / 4`
    // still holds.
    //
    // Second, and this is the part that only became true when the oracle-multiplier
    // test at the end of this block was added: there is now no mutation of these
    // constants that fails this assertion at all. The equality below forces
    // `maxPerDay = SUPERSEDED × HOURS_PER_DAY`; that test forces
    // `SUPERSEDED = maxPerHour / 12`, i.e. 15; so this line reads `15·H < 45·H`,
    // true for every positive H. Its one former bite was a moved
    // `SIGNUP_SUPERSEDED_HOURLY_IP_CEILING`, and that constant is pinned now.
    // Measured, not reasoned: `SUPERSEDED = 45` with `maxPerDay = 1080` fails this
    // line AND the oracle test, so this line owns nothing; `HOURS_PER_DAY = 72`
    // with `maxPerDay = 1080` fails nothing, because H is on both sides here.
    //
    // KEPT ANYWAY, on the same terms as the `> 0` assertion above: it states the
    // mechanism in the one place a reader looks for the mechanism, and a dead
    // assertion that is LABELLED dead costs nothing. What is not allowed is
    // letting it be counted as coverage.
    const sustainedDailyYieldOfTheHourlyCeiling = (SIGNUP_IP_LIMIT.maxPerHour ?? 0) * HOURS_PER_DAY;
    expect(SIGNUP_IP_LIMIT.maxPerDay).toBeLessThan(sustainedDailyYieldOfTheHourlyCeiling / 4);

    // And the other side of it, so the day window stays a BACKSTOP rather than
    // becoming the binding constraint on an ordinary afternoon: a day must still
    // hold more than an hour.
    //
    // THIS ONE IS REDUNDANCY, in the same way the `> 0` assertion above is, and
    // for the same reason it is worth saying out loud: the next test requires
    // `maxPerDay >= 300` and this requires `> 180`, so no value fails here and
    // passes there. There is no mutation this line detects alone. It is kept for
    // the sentence, not for the coverage.
    expect(SIGNUP_IP_LIMIT.maxPerDay).toBeGreaterThan(SIGNUP_IP_LIMIT.maxPerHour ?? 0);
  });

  it("leaves a whole drive comfortably inside the day", async () => {
    // The citizen-facing floor. Everything above bounds the attacker; this bounds
    // the refusal that started the work — twenty neighbours behind one cell
    // tower, of whom five were locked out at 15/hr. A drive with all its retries
    // is 60 requests, and the day has to hold several of them or the plaza is
    // back where it was one window later.
    //
    // THIS IS THE ONE INEQUALITY IN THE BLOCK THAT STILL OWNS A MUTATION, and it
    // is worth saying which, because the two above it own none. Against a change
    // to `maxPerDay` ALONE it detects nothing — the equality two tests up pins
    // that constant exactly and is strictly stronger than any floor. It bites
    // where that equality still passes and the oracle test still passes, which
    // leaves exactly one free constant: `HOURS_PER_DAY`. Measured:
    // `HOURS_PER_DAY = 19` with `maxPerDay = 285` fails THIS line and nothing
    // else in the file.
    //
    // That is the edit worth catching, too, and not a contrived one: it is
    // "re-justify a lower day ceiling by rewriting the other side of its
    // derivation", which is how a floor gets lowered without anybody writing down
    // that the plaza no longer fits. The citizen-facing floor is the last thing
    // standing between that edit and the refusal this whole change exists to end.
    const oneDrive = SIGNUP_DRIVE_SIZE * SIGNUP_ATTEMPTS_PER_PERSON;
    expect(SIGNUP_IP_LIMIT.maxPerDay ?? 0).toBeGreaterThanOrEqual(oneDrive * 5);
  });

  it("pins how much faster the enumeration oracle can be worked per hour", async () => {
    // THE SECURITY NUMBER, and the one assertion in this block that is not about
    // capacity. `auth_signup_ip` is the ONLY meter on the account-enumeration
    // oracle audit 28-#3 found and `enable_confirmations=false` leaves open on the
    // session-presence channel: a probe and an account creation are literally the
    // same request against the same counter, so this bucket's hourly ceiling IS
    // how many of a citizen's-addresses list one address may test per hour.
    // Raising 15 → 180 multiplies that by twelve. `signup-limits.ts` cost 6 is the
    // paragraph this line belongs to, with the latency table and the squatting
    // side effect.
    //
    // WHAT IT CATCHES THAT NOTHING ELSE HERE DOES.
    // `SIGNUP_SUPERSEDED_HOURLY_IP_CEILING` is history and no assertion in this
    // block pins it: the day equality reads it, but only as one side of a product,
    // so it can move freely as long as `maxPerDay` moves with it. Setting it to 30
    // and `maxPerDay` to 720 passes every other line in this file and quietly
    // re-baselines both "the daily yield is unchanged" and this multiplier against
    // a past that never happened. It fails here, because 180/30 is 6 and not 12.
    expect((SIGNUP_IP_LIMIT.maxPerHour ?? 0) / SIGNUP_SUPERSEDED_HOURLY_IP_CEILING).toBe(12);
  });
});
