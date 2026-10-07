// GET /api/v1/me — the FIRST bearer-authenticated endpoint in this repo, and
// the proof the M2 native gate was waiting for.
//
// WHY THIS FILE IS THE CONTRACT
// ---------------------------------------------------------------------------
// `lib/supabase/bearer.ts` shipped on 2026-08-19 with zero callers, and
// `requireLiveUser`'s injected-client option was written for exactly this and
// never exercised. "A bearer request and a cookie request are gated by the SAME
// guard" was, until this route, a claim in a docblock. These tests are where it
// becomes measurable — and they are deliberately END-TO-END against the local
// stack: real GoTrue tokens obtained by a real `signInWithPassword`, validated
// by real `auth.getUser()`, with the liveness decision read from real rows.
// A mocked `getUser` would have proved the handler's `switch` and nothing about
// whether a bearer token resolves at all.
//
// THE PIN THAT MATTERS MOST: NO COOKIE FALLBACK
// ---------------------------------------------------------------------------
// Both cookie doors — `@/lib/supabase/server` and `next/headers` — are mocked to
// THROW. Not to return null: to throw, loudly, recording that they were
// touched. A handler that quietly fell back to the cookie session would answer
// 200 to a browser tab holding a session while the bearer header it was given
// was garbage, which is a token check that silently is not one. Every case in
// this file runs under that trap, and one case asserts it directly.
//
// SEEDING. Four ephemeral users, one per liveness branch, torn down after.
// Separate users rather than one mutated between cases: `getProfileCached` is a
// React `cache()` (a passthrough outside a render, but that is an
// implementation detail of React's dispatcher, not a promise), and a test that
// depends on it staying a passthrough is a test that breaks on a React upgrade
// for reasons nobody will connect to auth.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  /** Set by either cookie door. Must stay false for the whole file. */
  cookieDoorTouched: false,
  /** When set, the limiter throws it. */
  limiterThrows: null as null | (() => never),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
}));

// THE TRAP. Not a stub that returns nothing — a door that screams if opened.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    control.cookieDoorTouched = true;
    throw new Error(
      "GET /api/v1/me read the COOKIE client — it must resolve identity from the Authorization header only",
    );
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => {
    control.cookieDoorTouched = true;
    throw new Error("GET /api/v1/me read cookies() — bearer only");
  },
  headers: () => {
    control.cookieDoorTouched = true;
    throw new Error(
      "GET /api/v1/me read next/headers headers() — it must read the REQUEST's own headers",
    );
  },
}));

// No-op by default so the route does not write a counter per case; the two
// cases that are ABOUT the limiter drive it explicitly.
vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limits.push({ endpoint, identifier });
      control.limiterThrows?.();
    },
  };
});

import { db, profiles } from "@/db";
import { RateLimitError } from "@/lib/infra/rate-limit";

import { GET as meRoute } from "@/app/api/v1/me/route";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_KEY = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const PASS = "MeRoute_2026!";
const EMAILS = {
  owner: "meroute-owner@dim-test.local",
  erased: "meroute-erased@dim-test.local",
  deactivated: "meroute-deact@dim-test.local",
  noProfile: "meroute-noprofile@dim-test.local",
  provisional: "meroute-provisional@dim-test.local",
  firstAccess: "meroute-first-access@dim-test.local",
} as const;

/**
 * The real name signup step 2 writes for the `owner` fixture.
 *
 * It has to be set EXPLICITLY, and that is the point of this constant. Until
 * 2026-09-04 this fixture kept whatever `handle_new_user` derived from its email
 * and the file asserted `profilePending: false` for it — so the case that was
 * supposed to prove "a completed profile is reported completed" was in fact a
 * PROVISIONAL profile, and the assertion pinned the D1 defect in place. A
 * fixture that never completes step 2 cannot certify the completed arm.
 */
const OWNER_REAL_NAME = "Ana Pérez";

const ids: Record<keyof typeof EMAILS, string> = {
  owner: "",
  erased: "",
  deactivated: "",
  noProfile: "",
  provisional: "",
  firstAccess: "",
};
const tokens: Record<keyof typeof EMAILS, string> = {
  owner: "",
  erased: "",
  deactivated: "",
  noProfile: "",
  provisional: "",
  firstAccess: "",
};

function meRequest(authorization?: string) {
  return new Request("http://localhost:3000/api/v1/me", {
    headers: {
      "x-real-ip": "203.0.113.11",
      ...(authorization ? { authorization } : {}),
    },
  });
}

async function purge(email: string) {
  const { data } = await supabaseAdmin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  if (!found) return;
  await db.delete(profiles).where(eq(profiles.id, found.id));
  await supabaseAdmin.auth.admin.deleteUser(found.id);
}

/** Creates the user and signs in through the ANON key, exactly as a phone would. */
async function seed(key: keyof typeof EMAILS) {
  await purge(EMAILS[key]);
  const created = await createFreshTestUser(supabaseAdmin, {
    email: EMAILS[key],
    password: PASS,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`createUser ${key}: ${created.error?.message}`);
  }
  ids[key] = created.data.user.id;

  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  });
  const signedIn = await anon.auth.signInWithPassword({ email: EMAILS[key], password: PASS });
  if (signedIn.error || !signedIn.data.session) {
    throw new Error(`signIn ${key}: ${signedIn.error?.message}`);
  }
  tokens[key] = signedIn.data.session.access_token;
}

beforeAll(async () => {
  if (!ANON_KEY) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY is unset. This file signs in through the anon key on purpose — a bearer test that skips the real token proves nothing.",
    );
  }
  for (const key of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) await seed(key);

  // Signup step 2, applied to the fixture that stands for a FINISHED
  // registration. `handle_new_user` seeded every row above with the email local
  // part; completeIdentityAction is what overwrites it with a real First Last,
  // and this is that write. The `provisional` fixture deliberately does NOT get
  // it — it is the account that stopped after step 1.
  await db.update(profiles).set({ displayName: OWNER_REAL_NAME }).where(eq(profiles.id, ids.owner));

  // The erased subject (Ley 25.326 art. 16): the profile is soft-deleted while
  // the access token stays valid until it expires on its own.
  await db.update(profiles).set({ deletedAt: new Date() }).where(eq(profiles.id, ids.erased));

  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional", deactivatedAt: new Date() })
    .where(eq(profiles.id, ids.deactivated));

  // The mid-signup window: auth.users exists, profiles does not yet.
  await db.delete(profiles).where(eq(profiles.id, ids.noProfile));

  // An institutional account that still owes its first password (pilot T1-P3).
  // The flag is armed AFTER the token was minted, the way a credential reset
  // re-arms it on an account that already had a session: it is read from
  // GoTrue on every request, not from the token.
  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional" })
    .where(eq(profiles.id, ids.firstAccess));
  const armed = await supabaseAdmin.auth.admin.updateUserById(ids.firstAccess, {
    app_metadata: { password_setup_pending: true },
  });
  if (armed.error) throw new Error(`arm first access: ${armed.error.message}`);
}, 60_000);

afterAll(async () => {
  for (const email of Object.values(EMAILS)) await purge(email);
});

beforeEach(() => {
  control.limiterThrows = null;
  control.limits = [];
});

// ---------------------------------------------------------------------------
// The header is the ONLY identity source
// ---------------------------------------------------------------------------

describe("GET /api/v1/me — refusals carry a code, never a redirect", () => {
  it("answers 401 auth_required when there is NO Authorization header", async () => {
    const res = await meRoute(meRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Distinct from auth_expired on purpose: a missing header is a client BUG,
    // and answering "expired" is how a refresh loop gets written for a request
    // that never carried a token.
    expect(control.cookieDoorTouched).toBe(false);
    // Free to refuse: no counter spent on a request that carried nothing.
    expect(control.limits).toEqual([]);
  });

  it("answers 401 auth_expired for a header with the wrong scheme", async () => {
    const res = await meRoute(meRequest("Basic dXNlcjpwYXNz"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_expired" });
  });

  it("answers 401 auth_expired for a token GoTrue does not recognise", async () => {
    // A REAL round-trip to the local GoTrue, which is the point: this is the
    // branch that proves the token is actually validated rather than parsed.
    const res = await meRoute(meRequest("Bearer not-a-real-jwt"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_expired" });
    expect(control.cookieDoorTouched).toBe(false);
  });

  it("NEVER falls back to the cookie session, even holding a valid token", async () => {
    // The direct assertion. Both cookie doors throw on contact and record it;
    // if this handler ever grows an `else` that reaches for createClient(), the
    // whole file goes red at once.
    const res = await meRoute(meRequest(`Bearer ${tokens.owner}`));
    expect(res.status).toBe(200);
    expect(control.cookieDoorTouched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The live caller
// ---------------------------------------------------------------------------

describe("GET /api/v1/me — a live caller", () => {
  it("resolves the profile FROM THE DATABASE against a real bearer token", async () => {
    const res = await meRoute(meRequest(`Bearer ${tokens.owner}`));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      payloadVersion: number;
      issuedAt: string;
      staleAfter: string;
      user: Record<string, unknown>;
    };

    expect(body.user).toEqual({
      profilePending: false,
      id: ids.owner,
      // The name signup step 2 wrote. NOT the email local-part: that value is
      // what marks an identity as still provisional, and it is answered on the
      // other arm now (see the provisional case below).
      displayName: OWNER_REAL_NAME,
      role: "owner",
      accountType: "personal",
    });

    // §6's three envelope fields. `staleAfter` is not a cache directive — the
    // response is no-store regardless — it is the explicit expiry a native
    // client holding a copy needs, having no CDN to invalidate.
    expect(body.payloadVersion).toBe(1);
    const drift = Date.parse(body.staleAfter) - Date.parse(body.issuedAt);
    expect(drift).toBe(5 * 60_000);
  });

  it("carries NOTHING beyond the four shell fields — no email, no DNI, no pets", async () => {
    // Measured against the response a REAL row produced, because the point is
    // what the projection does with data that exists, not what a fixture
    // happened to omit. This payload is what a stolen access token buys.
    const res = await meRoute(meRequest(`Bearer ${tokens.owner}`));
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toContain(EMAILS.owner);
    expect(raw).not.toContain("@dim-test.local");
    expect(raw.toLowerCase()).not.toContain("dni");
    expect(raw.toLowerCase()).not.toContain("phone");
    expect(raw.toLowerCase()).not.toContain("deletedat");
    expect(raw.toLowerCase()).not.toContain("token");
  });

  it("reports profilePending for the mid-signup window instead of guessing a role", async () => {
    // auth.users exists, profiles does not yet. A discriminated arm rather than
    // a placeholder role: "owner" is a bad guess to make about somebody who has
    // not finished registering.
    const res = await meRoute(meRequest(`Bearer ${tokens.noProfile}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user).toEqual({ profilePending: true, id: ids.noProfile });
  });

  it("reports profilePending for a row still carrying the TRIGGER'S provisional name", async () => {
    // THE D1 REGRESSION (native QA batch 1). This account is what every native
    // signup produces: step 1 completed, `handle_new_user` inserted a profile
    // row inside the same transaction, and step 2 — the web form that collects
    // a real name, the DNI and the Ley 25.326 consent — was never done.
    //
    // The row EXISTS, so the old `live.profile ? … : …` answered
    // `profilePending: false` and `useGate` (apps/mobile/src/auth/useGate.tsx)
    // let the account into "Mis mascotas", where it could register a pet under
    // a name nobody had entered. The comments in session-store.ts and
    // CrearCuentaScreen.tsx that predicted `profilePending: true` here were
    // right about the intent and wrong about the mechanism: they said "a
    // brand-new account has no profile row", and the trigger has always written
    // one.
    const res = await meRoute(meRequest(`Bearer ${tokens.provisional}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user).toEqual({ profilePending: true, id: ids.provisional });
  });

  it("names no role and no display name for a pending identity, even though the row has both", async () => {
    // The row this reads carries role='owner' and the email local part, because
    // that is what the trigger writes for every account (migration 0134
    // hard-codes the role). Reporting either would be handing a client the
    // trigger's DEFAULT dressed as an answer about a person — the exact
    // fabrication the discriminated union exists to prevent — and the local
    // part is PII this payload is otherwise careful not to carry.
    const res = await meRoute(meRequest(`Bearer ${tokens.provisional}`));
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toContain("owner");
    expect(raw).not.toContain(EMAILS.provisional.split("@")[0]);
  });
});

// ---------------------------------------------------------------------------
// The liveness refusals — the whole reason the guard is shared
// ---------------------------------------------------------------------------

describe("GET /api/v1/me — the SAME guard the cookie path uses", () => {
  it("refuses an ERASED account with 403, not 401", async () => {
    // The token is fine and will keep refreshing; a 401 would produce a refresh
    // loop that succeeds forever against an account that no longer exists.
    // This is the case a bare `auth.getUser()` would have waved through — it
    // never consults profiles.deleted_at.
    const res = await meRoute(meRequest(`Bearer ${tokens.erased}`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_erased" });
  });

  it("refuses a DEACTIVATED institutional account with 403", async () => {
    const res = await meRoute(meRequest(`Bearer ${tokens.deactivated}`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_deactivated" });
  });

  // Security review item 4: the first-access step used to be enforced on page
  // loads only, so the session an access link minted could use the API freely.
  it("refuses a session that still owes its first password with 401 auth_expired", async () => {
    const res = await meRoute(meRequest(`Bearer ${tokens.firstAccess}`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_expired" });
    expect(control.cookieDoorTouched).toBe(false);
  });

  it("answers 503 during a maintenance window, before any token check", async () => {
    // The kill-switch is an env read evaluated before any client or query, so
    // it works when the DATABASE is the thing being maintained.
    const previous = process.env.NEXT_PUBLIC_MAINTENANCE_MODE;
    process.env.NEXT_PUBLIC_MAINTENANCE_MODE = "true";
    try {
      const res = await meRoute(meRequest(`Bearer ${tokens.owner}`));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
      expect(res.headers.get("retry-after")).toBe("5");
    } finally {
      // Restored to "" rather than deleted: `delete` on process.env is banned
      // (lint/performance/noDelete) and assigning `undefined` would leave the
      // literal string "undefined" behind. isMaintenanceMode accepts only "1"
      // and "true", so "" is off — the same answer an absent variable gives.
      process.env.NEXT_PUBLIC_MAINTENANCE_MODE = previous ?? "";
    }
  });
});

// ---------------------------------------------------------------------------
// The limiter
// ---------------------------------------------------------------------------

describe("GET /api/v1/me — bounded, on its own buckets", () => {
  // TWO buckets since WU-EAS-2, and the ORDER is the assertion. The per-IP one
  // runs before the GoTrue round-trip so an unauthenticated hammer is refused
  // cheaply; the per-USER one runs after the guard, because there is no user id
  // until the guard answers — and because an unauthenticated hammer must never
  // write into the per-user keyspace at all.
  //
  // This case pinned a ONE-element array until 2026-08-26, which is what made it
  // worth writing: `/me` was the endpoint every native client calls first and it
  // had no per-account bound whatsoever, so a script signed in as one user could
  // spend the whole gateway's budget and this test called that correct.
  it("spends the per-IP bucket, then the per-USER one once the caller is known", async () => {
    await meRoute(meRequest(`Bearer ${tokens.owner}`));
    expect(control.limits).toEqual([
      { endpoint: "api_v1_me", identifier: "203.0.113.11" },
      { endpoint: "api_v1_me_user", identifier: ids.owner },
    ]);
  });

  it("answers 429 when the bucket is exhausted", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "api_v1_me");
    };
    const res = await meRoute(meRequest(`Bearer ${tokens.owner}`));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("FAILS OPEN when the limiter itself is broken", async () => {
    // Direction, stated and tested. The limiter is a DB write; if it cannot
    // answer, refusing here would log every user out of their app shell over an
    // abuse control on a read that discloses only the caller's own profile. The
    // guard below it fails CLOSED — that is the one that must.
    control.limiterThrows = () => {
      throw new Error("rate_limit_buckets is unreachable");
    };
    const res = await meRoute(meRequest(`Bearer ${tokens.owner}`));
    expect(res.status).toBe(200);
  });
});
