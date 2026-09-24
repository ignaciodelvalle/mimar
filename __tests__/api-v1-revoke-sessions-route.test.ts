// POST /api/v1/me/revoke-sessions — the handler's contract (B11).
//
// SCOPE, AND WHY IT IS NOT THE END-TO-END SHAPE OF api-v1-me-route.test.ts
// ---------------------------------------------------------------------------
// That file seeds real users and takes real GoTrue tokens because it is proving
// that a bearer request resolves AT ALL — a claim nothing else had exercised.
// That claim is now established and this route reuses the very same two links
// (`createClientFromBearer` → `requireLiveUser`), so re-proving it here would be
// re-testing someone else's contract with a slower test.
//
// What is genuinely this handler's own is the mapping: which status and which
// code come out of each branch, the ORDER the limiters run in, and the one rule
// that separates this endpoint from every other on the surface — a revocation
// that did not happen must never answer 200. Those are what is pinned.
//
// The revocation mechanics (raw token, global scope, the bearer no-op trap, the
// audit row) belong to the use-case and live in __tests__/revoke-sessions.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  live: null as unknown,
  revokeResult: { ok: true } as
    | { ok: true }
    | { ok: false; reason: "rate_limited" | "failed"; error: string },
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  limiterThrowsOn: null as string | null,
  revokeCalls: [] as Array<{ accessToken: string; userId: string; surface: string }>,
  /** Every act, in order, so the ORDER of the two revocations can be asserted. */
  trace: [] as string[],
  pushTargetUserIds: [] as string[],
  pushRevokeThrows: false,
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
      if (control.limiterThrowsOn === endpoint) {
        throw new actual.RateLimitError(new Date(), "test");
      }
    },
  };
});

vi.mock("@/src/modules/auth/application/revoke-sessions", () => ({
  revokeAllSessions: async (input: { accessToken: string; userId: string; surface: string }) => {
    control.revokeCalls.push(input);
    control.trace.push("sessions");
    return control.revokeResult;
  },
}));

// The native delivery targets. Mocked as a SEAM — its own rules are tested
// against real Postgres in __tests__/push-target-store.test.ts — and it records
// the user id it was handed rather than only that it was reached, because
// revoking the wrong person's phones is the failure this stub has to be able to
// see.
vi.mock("@/lib/infra/push-target-store", () => ({
  revokeAllPushTargetsForUser: async (userId: string) => {
    control.pushTargetUserIds.push(userId);
    control.trace.push("push-targets");
    if (control.pushRevokeThrows) throw new Error("db unavailable");
    return 2;
  },
}));

const reportErrorMock = vi.fn();
vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

import { POST } from "@/app/api/v1/me/revoke-sessions/route";

const TOKEN = "aaa.bbb.ccc";

function request(authorization: string | null = `Bearer ${TOKEN}`) {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.9" });
  if (authorization) headers.set("authorization", authorization);
  return new Request("https://mimar.test/api/v1/me/revoke-sessions", { method: "POST", headers });
}

function liveUser(id = "user-001") {
  return { ok: true, supabase: {}, user: { id }, profile: null, sessionStartedAt: new Date() };
}

beforeEach(() => {
  control.live = liveUser();
  control.revokeResult = { ok: true };
  control.limits = [];
  control.limiterThrowsOn = null;
  control.revokeCalls = [];
  control.trace = [];
  control.pushTargetUserIds = [];
  control.pushRevokeThrows = false;
  reportErrorMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("POST /api/v1/me/revoke-sessions — the door", () => {
  it("answers 401 auth_required when no header is sent, without touching a limiter", async () => {
    const res = await POST(request(null));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "auth_required" });
    // A client that forgot the header costs the platform no counter write.
    expect(control.limits).toHaveLength(0);
  });

  it("answers 401 auth_expired for an unusable header", async () => {
    const res = await POST(request("Basic abc"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "auth_expired" });
  });
});

describe("POST /api/v1/me/revoke-sessions — success", () => {
  it("answers 200 with a BARE payload and no-store", async () => {
    const res = await POST(request());

    expect(res.status).toBe(200);
    // Bare, per the write convention: no envelope fields on something that has
    // no staleness, and no wrapper key.
    await expect(res.json()).resolves.toEqual({ revoked: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("revokes with the caller's OWN validated token and the resolved user id", async () => {
    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(control.revokeCalls).toEqual([
      { accessToken: TOKEN, userId: "user-001", surface: "api_v1" },
    ]);
  });

  // THE ROUTE OWNS EXACTLY ONE LIMITER NOW (2026-08-25). The per-user budget
  // moved into the shared use-case so the WEB button spends it too — it had no
  // limiter at all, which made the ceiling a property of the transport and the
  // button the way around the endpoint. `revokeAllSessions` is mocked here, so
  // the use-case's bucket is not visible in `control.limits` by construction;
  // __tests__/revoke-sessions.test.ts is where it is pinned.
  it("runs the IP limiter, and ONLY the IP limiter, before auth", async () => {
    await POST(request());

    expect(control.limits.map((l) => l.endpoint)).toEqual(["api_v1_me_revoke_sessions_ip"]);
    // Keyed on the request, never on a middleware-stamped header.
    expect(control.limits[0].identifier).toBe("203.0.113.9");
  });
});

describe("POST /api/v1/me/revoke-sessions — refusals", () => {
  it("answers 429 when the IP budget is spent, before resolving anyone", async () => {
    control.limiterThrowsOn = "api_v1_me_revoke_sessions_ip";

    const res = await POST(request());

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "rate_limited" });
    expect(control.revokeCalls).toHaveLength(0);
  });

  // The per-user budget is spent INSIDE the use-case now, so the route learns
  // about the breach from the result rather than from its own limiter. What is
  // this handler's own contract is the MAPPING: a throttle is 429, never the 503
  // that a failed revocation gets. Answering 503 to a throttle would tell a
  // client the platform is broken while it works exactly as designed.
  it("answers 429 when the per-user budget is spent inside the use-case", async () => {
    control.revokeResult = { ok: false, reason: "rate_limited", error: "esperá un momento" };

    const res = await POST(request());

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "rate_limited" });
  });

  const refusals = [
    ["NO_SESSION", 401, "auth_expired"],
    ["ACCOUNT_ERASED", 403, "account_erased"],
    ["DEACTIVATED", 403, "account_deactivated"],
    ["SHIFT_EXPIRED", 401, "session_shift_expired"],
    ["MAINTENANCE", 503, "temporarily_unavailable"],
  ] as const;

  for (const [reason, status, code] of refusals) {
    it(`maps ${reason} to ${status} ${code}`, async () => {
      control.live = { ok: false, supabase: {}, user: null, reason, error: "nope" };

      const res = await POST(request());

      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toEqual({ error: code });
      expect(control.revokeCalls).toHaveLength(0);
    });
  }

  it("FAILS CLOSED — a revocation that did not happen never answers 200", async () => {
    control.revokeResult = { ok: false, reason: "failed", error: "no anduvo" };

    const res = await POST(request());

    // The whole point. Every limiter above fails OPEN; this must not, because
    // the user's next move — stop worrying about the phone they lost — depends
    // on believing this response.
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(res.headers.get("retry-after")).toBe("5");
  });
});

// ---------------------------------------------------------------------------
// The push targets — the half of "cerrar sesión en todos los dispositivos" that
// was missing, and the reason it matters.
//
// Killing the SESSIONS stops a lost phone from READING anything. It does nothing
// about `push_targets`, which the send path reads server-side with no session
// involved — so before this, the phone somebody was trying to cut off kept
// receiving every urgent notification on its lock screen. These pin both the act
// and its ORDER.
// ---------------------------------------------------------------------------

describe("POST /api/v1/me/revoke-sessions — native delivery targets", () => {
  it("revokes every push target the person has, for that person", async () => {
    control.live = liveUser("user-042");

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(control.pushTargetUserIds).toEqual(["user-042"]);
  });

  it("revokes the targets BEFORE it kills the sessions", async () => {
    await POST(request());

    // If this reversed, the failure arm below could no longer leave the person
    // in a recoverable state: the sessions would already be gone while the phone
    // kept ringing, which is exactly the situation the button exists to end.
    expect(control.trace).toEqual(["push-targets", "sessions"]);
  });

  it("answers 503 and leaves every session ALIVE when the target revoke fails", async () => {
    control.pushRevokeThrows = true;

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    // Not attempted at all: a person told "no pudimos" must find their
    // situation unchanged, not half-changed in the direction that cannot be
    // undone.
    expect(control.revokeCalls).toHaveLength(0);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0][0]).toBe("api-v1-me-revoke-sessions/push-targets");
  });

  it("does not touch the targets when the caller never got past the guard", async () => {
    control.live = { ok: false, reason: "ACCOUNT_ERASED" };

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(control.pushTargetUserIds).toHaveLength(0);
  });
});
