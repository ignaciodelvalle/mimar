// POST /api/v1/me/reactivate — D4, the handler's contract.
//
// SHAPE: THE GUARD AND THE LIMITERS ARE SEAMS, THE USE-CASE IS REAL
// ---------------------------------------------------------------------------
// `createClientFromBearer` → `requireLiveUser` is proven end-to-end in
// api-v1-me-route.test.ts and is mocked here the way
// api-v1-revoke-sessions-route.test.ts mocks it: what matters is which refusal
// the guard hands this route, and a mock is the only way to hand it a
// deactivated INSTITUTIONAL account or an erasure that raced the guard.
//
// The use-case is NOT mocked, and that is the point of this file. The claim D4
// makes is "the app runs the web's reactivation, unchanged" — so what is asserted
// is the database: `deactivated_at` cleared or untouched, and the
// `personal_self_reactivated` audit row written or absent. A mocked use-case
// would pin the mapping and prove nothing about what the phone actually does to
// somebody's account.

import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { auditLog, db, profiles } from "@/db";
import { selfDeactivatePersonalAccountForUser } from "@/src/modules/pets/application/profile/self-deactivate-personal-account";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser, deleteTestUser } from "./_helpers/fresh-test-user";

const control = vi.hoisted(() => ({
  live: null as unknown,
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  /** Endpoint whose limiter answers "over the ceiling". */
  limiterRefuses: null as string | null,
  /** Endpoint whose limiter cannot answer at all. */
  limiterBreaks: null as string | null,
}));

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null | undefined) => {
      if (!header) return { ok: false, reason: "MISSING" as const };
      if (!header.startsWith("Bearer ")) return { ok: false, reason: "MALFORMED" as const };
      return { ok: true, supabase: {} as never, token: header.slice(7) };
    },
  };
});

vi.mock("@/lib/infra/live-user", () => ({
  requireLiveUser: async () => control.live,
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limits.push({ endpoint, identifier });
      if (control.limiterRefuses === endpoint) {
        throw new actual.RateLimitError(new Date(), "test");
      }
      if (control.limiterBreaks === endpoint) throw new Error("rate_limits unavailable");
    },
  };
});

vi.mock("@/lib/infra/report-error", () => ({ reportError: () => undefined }));

import { POST } from "@/app/api/v1/me/reactivate/route";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const SELF_EMAIL = "reactivate-route-self@dim-test.local";
const INSTITUTIONAL_EMAIL = "reactivate-route-institutional@dim-test.local";
const ERASED_EMAIL = "reactivate-route-erased@dim-test.local";
const LIVE_EMAIL = "reactivate-route-live@dim-test.local";
const EMAILS = [SELF_EMAIL, INSTITUTIONAL_EMAIL, ERASED_EMAIL, LIVE_EMAIL];

const ids: Record<string, string> = {};

async function purge(email: string) {
  const { data } = await adminSdk.auth.admin.listUsers({ perPage: 1000 });
  const found = data?.users.find((u) => u.email === email);
  if (found) {
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.actorUserId, found.id));
      await tx.delete(auditLog).where(eq(auditLog.targetUserId, found.id));
    });
  }
  await deleteTestUser(adminSdk, db, email);
}

async function create(email: string): Promise<string> {
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: "Reactivate_D4_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

async function stateOf(userId: string) {
  const [row] = await db
    .select({ deactivatedAt: profiles.deactivatedAt, deletedAt: profiles.deletedAt })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return row;
}

async function reactivationRows(userId: string) {
  return db
    .select({ id: auditLog.id, targetUserId: auditLog.targetUserId })
    .from(auditLog)
    .where(and(eq(auditLog.actorUserId, userId), eq(auditLog.action, "personal_self_reactivated")));
}

function request(authorization: string | null = "Bearer aaa.bbb.ccc") {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.44" });
  if (authorization) headers.set("authorization", authorization);
  return new Request("https://mimar.test/api/v1/me/reactivate", { method: "POST", headers });
}

/** The refusal requireLiveUser gives a deactivated account — any account type. */
function deactivated(id: string) {
  return {
    ok: false,
    supabase: {},
    user: { id, email: "x@dim-test.local" },
    reason: "DEACTIVATED",
    error: "Tu cuenta está desactivada.",
  };
}

beforeAll(async () => {
  for (const email of EMAILS) await purge(email);
  ids.self = await create(SELF_EMAIL);
  ids.institutional = await create(INSTITUTIONAL_EMAIL);
  ids.erased = await create(ERASED_EMAIL);
  ids.live = await create(LIVE_EMAIL);

  // Self-deactivated through the web's OWN writer — the real precondition, with
  // its real `personal_self_deactivated` row, not a hand-set column.
  const down = await selfDeactivatePersonalAccountForUser(ids.self, "Me tomo un descanso");
  if ("error" in down) throw new Error(`self-deactivate: ${down.error}`);

  // Deactivated BY AN OPERATOR. Every admin-side writer of `deactivated_at`
  // (deactivate-govt, deactivate-admin, reset-institutional-credentials)
  // requires `account_type = 'institutional'`, so this is the shape any
  // non-self deactivation has in the database.
  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional", deactivatedAt: new Date() })
    .where(eq(profiles.id, ids.institutional));

  // Erased after deactivating. The route never reaches the use-case for this
  // account through the ordinary guard (ACCOUNT_ERASED outranks DEACTIVATED);
  // the test below hands the route a DEACTIVATED refusal anyway, which is the
  // shape an erasure committing between the guard and the write would take.
  await db
    .update(profiles)
    .set({ deactivatedAt: new Date(), deletedAt: new Date() })
    .where(eq(profiles.id, ids.erased));
}, 60_000);

afterAll(async () => {
  for (const email of EMAILS) await purge(email);
}, 60_000);

beforeEach(() => {
  control.live = null;
  control.limits = [];
  control.limiterRefuses = null;
  control.limiterBreaks = null;
});

describe("POST /api/v1/me/reactivate — the door", () => {
  it("answers 401 auth_required with no header, before any counter write", async () => {
    const res = await POST(request(null));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "auth_required" });
    expect(control.limits).toHaveLength(0);
  });

  it("answers 401 auth_expired when the guard finds no session", async () => {
    control.live = { ok: false, supabase: {}, user: null, reason: "NO_SESSION", error: "x" };
    const res = await POST(request());
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "auth_expired" });
  });
});

describe("POST /api/v1/me/reactivate — who may undo a deactivation", () => {
  it("refuses an account deactivated by an operator, and changes nothing", async () => {
    control.live = deactivated(ids.institutional);
    const before = await stateOf(ids.institutional);

    const res = await POST(request());

    expect(res.status).toBe(403);
    // The refusal every other door already gives this account — nothing new.
    await expect(res.json()).resolves.toEqual({ error: "account_deactivated" });
    const after = await stateOf(ids.institutional);
    expect(after.deactivatedAt).not.toBeNull();
    expect(after.deactivatedAt?.getTime()).toBe(before.deactivatedAt?.getTime());
    expect(await reactivationRows(ids.institutional)).toHaveLength(0);
  });

  it("refuses an erased account the guard already refuses, without reaching the write", async () => {
    control.live = {
      ok: false,
      supabase: {},
      user: { id: ids.erased },
      reason: "ACCOUNT_ERASED",
      error: "x",
    };
    const res = await POST(request());
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "account_erased" });
    expect((await stateOf(ids.erased)).deactivatedAt).not.toBeNull();
  });

  it("keeps an erased account erased even when an erasure raced the guard", async () => {
    control.live = deactivated(ids.erased);

    const res = await POST(request());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "account_erased" });
    const after = await stateOf(ids.erased);
    expect(after.deletedAt).not.toBeNull();
    expect(after.deactivatedAt).not.toBeNull();
    expect(await reactivationRows(ids.erased)).toHaveLength(0);
  });

  it("answers a live account with a no-op, without asking the use-case", async () => {
    control.live = {
      ok: true,
      supabase: {},
      user: { id: ids.live },
      profile: null,
      sessionStartedAt: new Date(),
    };

    const res = await POST(request());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reactivated: false });
    expect((await stateOf(ids.live)).deactivatedAt).toBeNull();
    expect(await reactivationRows(ids.live)).toHaveLength(0);
  });

  it("reactivates a SELF-deactivated personal account, with the web's audit row", async () => {
    control.live = deactivated(ids.self);
    expect((await stateOf(ids.self)).deactivatedAt).not.toBeNull();

    const res = await POST(request());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reactivated: true });
    expect((await stateOf(ids.self)).deactivatedAt).toBeNull();
    const rows = await reactivationRows(ids.self);
    expect(rows).toHaveLength(1);
    expect(rows[0].targetUserId).toBe(ids.self);
  });

  it("answers a repeated call with a no-op and no second audit row", async () => {
    // The phone's session is still the deactivated-era one if the first 200 was
    // lost on the way back; the guard would then answer ok, but the anti-race
    // UPDATE is what makes a DEACTIVATED-looking retry harmless too.
    control.live = deactivated(ids.self);

    const res = await POST(request());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reactivated: false });
    expect(await reactivationRows(ids.self)).toHaveLength(1);
  });
});

describe("POST /api/v1/me/reactivate — rate limits, both failing closed", () => {
  it("spends the per-IP bucket on the caller's address and the per-user one on the GoTrue id", async () => {
    control.live = deactivated(ids.institutional);
    await POST(request());
    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_reactivate_ip", identifier: "203.0.113.44" },
      { endpoint: "api_v1_me_reactivate_user", identifier: ids.institutional },
    ]);
  });

  it("answers 429 when the per-IP ceiling is reached, before the guard", async () => {
    control.limiterRefuses = "api_v1_me_reactivate_ip";
    control.live = deactivated(ids.institutional);
    const res = await POST(request());
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "rate_limited" });
    expect(control.limits).toHaveLength(1);
  });

  it("answers 429 when the per-user ceiling is reached, and changes nothing", async () => {
    await db.update(profiles).set({ deactivatedAt: new Date() }).where(eq(profiles.id, ids.live));
    control.limiterRefuses = "api_v1_me_reactivate_user";
    control.live = deactivated(ids.live);

    const res = await POST(request());

    expect(res.status).toBe(429);
    expect((await stateOf(ids.live)).deactivatedAt).not.toBeNull();
    expect(await reactivationRows(ids.live)).toHaveLength(0);
  });

  it("FAILS CLOSED when the per-IP limiter cannot answer", async () => {
    control.limiterBreaks = "api_v1_me_reactivate_ip";
    control.live = deactivated(ids.live);
    const res = await POST(request());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect((await stateOf(ids.live)).deactivatedAt).not.toBeNull();
  });

  it("FAILS CLOSED when the per-user limiter cannot answer", async () => {
    control.limiterBreaks = "api_v1_me_reactivate_user";
    control.live = deactivated(ids.live);
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect((await stateOf(ids.live)).deactivatedAt).not.toBeNull();
    expect(await reactivationRows(ids.live)).toHaveLength(0);
  });
});
