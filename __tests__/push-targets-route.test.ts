// `/api/v1/me/push-targets` — the door a phone knocks on, and who it turns away.
//
// This is §7 item 7 of dim-interno:docs/handoff/push-notifications.md: "an unauthenticated
// call, an expired token, and the limit being hit".
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. AUTHORIZATION, with the same codes every sibling on `/me` uses, so a
//      native client writes ONE handler for the whole auth failure space. An
//      absent header and an unusable one are DIFFERENT answers on purpose:
//      `auth_required` means "sign in", `auth_expired` means "refresh".
//   2. THE TWO LIMITER BUCKETS, in order: IP before the guard, user after. The
//      order is the security property — spending the user bucket first would
//      require identifying the caller before rate-limiting them, which is an
//      unauthenticated round trip to GoTrue per request.
//   3. THE COMMANDS reach the store with the CALLER's id, never a body field.
//      A `userId` accepted from the request would let anybody register a
//      delivery address against somebody else's account.
//   4. `revoked: false` IS A 200. Revoking a device that was never registered
//      changed nothing, and answering 404 would make an ordinary sign-out look
//      like a failure to the phone.
//
// The store is mocked: what it does to Postgres is `push-target-store.test.ts`'s
// business, against a real database. What is asserted here is what the ROUTE
// does with the answer.

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "0f2b1f3c-4d5e-4a6b-8c7d-9e0f1a2b3c4d";
const TOKEN = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

const control = vi.hoisted(() => ({
  bearer: null as null | (() => unknown),
  live: null as null | (() => unknown),
  limiterThrows: null as null | ((endpoint: string) => void),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  writes: [] as Array<{ fn: string; args: unknown[] }>,
  registerThrows: false,
  revokedRows: 1,
}));

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      control.bearer
        ? control.bearer()
        : header === null
          ? { ok: false, reason: "MISSING" }
          : { ok: true, supabase: {}, token: "test-token" },
  };
});

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live ? control.live() : { ok: true, supabase: {}, user: { id: OWNER_ID } },
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limits.push({ endpoint, identifier });
      control.limiterThrows?.(endpoint);
    },
  };
});

vi.mock("@/lib/infra/push-target-store", () => ({
  registerPushTarget: async (...args: unknown[]) => {
    control.writes.push({ fn: "registerPushTarget", args });
    if (control.registerThrows) throw new Error("pooler is down");
  },
  revokePushTarget: async (...args: unknown[]) => {
    control.writes.push({ fn: "revokePushTarget", args });
    return control.revokedRows;
  },
}));

import { RateLimitError } from "@/lib/infra/rate-limit";

import { POST } from "@/app/api/v1/me/push-targets/route";

function req(body: unknown, init: { authorization?: string | null } = {}) {
  const headers: Record<string, string> = {
    "x-real-ip": "203.0.113.22",
    "content-type": "application/json",
  };
  const value = init.authorization === undefined ? "Bearer test-token" : init.authorization;
  if (value) headers.authorization = value;
  return new Request("http://localhost:3000/api/v1/me/push-targets", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const RESET_AT = new Date("2026-09-11T12:00:00.000Z");

const REGISTER = {
  command: "register",
  deviceId: DEVICE_ID,
  expoPushToken: TOKEN,
  platform: "android",
  appVersion: "1.4.2",
};

beforeEach(() => {
  control.bearer = null;
  control.live = null;
  control.limiterThrows = null;
  control.limits = [];
  control.writes = [];
  control.registerThrows = false;
  control.revokedRows = 1;
});

describe("POST /api/v1/me/push-targets — authorization", () => {
  it("refuses a request with no bearer at all", async () => {
    const res = await POST(req(REGISTER, { authorization: null }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
    // A registration is a write about one person; nothing about it may be
    // cached anywhere between the phone and here.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses an EXPIRED bearer with a different code than a missing one", async () => {
    control.bearer = () => ({ ok: false, reason: "EXPIRED" });

    const res = await POST(req(REGISTER));

    // The distinction is the whole point: `auth_required` sends a person to the
    // sign-in screen, `auth_expired` tells the client to refresh and retry. One
    // code for both would log somebody out for a token that only needed rotating.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_expired" });
  });

  it("never reaches the store when the bearer resolves to nobody", async () => {
    control.live = () => ({ ok: false, reason: "NO_SESSION" });

    const res = await POST(req(REGISTER));

    expect(res.status).toBe(401);
    expect(control.writes).toHaveLength(0);
  });

  it("turns an erased account away without writing a row", async () => {
    // The real reason string from `LiveUserFailureReason`, not an invented one:
    // `liveUserRefusal` throws on anything outside that union, so a plausible
    // guess here would pass for the wrong reason.
    control.live = () => ({ ok: false, reason: "ACCOUNT_ERASED" });

    const res = await POST(req(REGISTER));

    // Registering a delivery address for an account that no longer exists would
    // re-create, one row at a time, data an erasure was legally obliged to remove.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(control.writes).toHaveLength(0);
  });
});

describe("POST /api/v1/me/push-targets — the limiters", () => {
  it("spends the IP bucket BEFORE the guard and the user bucket after", async () => {
    await POST(req(REGISTER));

    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_push_targets_ip", identifier: "203.0.113.22" },
      { endpoint: "api_v1_me_push_targets_user", identifier: OWNER_ID },
    ]);
  });

  it("answers 429 when the IP bucket is spent, without identifying the caller", async () => {
    control.limiterThrows = (endpoint) => {
      if (endpoint === "api_v1_me_push_targets_ip") throw new RateLimitError(RESET_AT, endpoint);
    };
    control.live = () => {
      throw new Error("the guard must not run for a caller already over the IP limit");
    };

    const res = await POST(req(REGISTER));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("answers 429 when the USER bucket is spent, and writes nothing", async () => {
    control.limiterThrows = (endpoint) => {
      if (endpoint === "api_v1_me_push_targets_user") throw new RateLimitError(RESET_AT, endpoint);
    };

    const res = await POST(req(REGISTER));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(control.writes).toHaveLength(0);
  });

  it("fails OPEN when the limiter infrastructure itself is broken", async () => {
    // Matching every sibling limiter: an outage in the counter must not stop
    // people signing in. A closed failure here would take push registration
    // down for everybody because Redis blinked.
    control.limiterThrows = () => {
      throw new Error("redis unreachable");
    };

    const res = await POST(req(REGISTER));

    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/me/push-targets — the two commands", () => {
  it("registers with the CALLER's id, never one from the body", async () => {
    const res = await POST(req({ ...REGISTER, userId: "99999999-9999-4999-8999-999999999999" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registered: true });
    // The id in the body is ignored. Honouring it would let anybody point a
    // delivery address at somebody else's account.
    expect(control.writes[0]).toEqual({
      fn: "registerPushTarget",
      args: [
        {
          userId: OWNER_ID,
          deviceId: DEVICE_ID,
          expoPushToken: TOKEN,
          platform: "android",
          appVersion: "1.4.2",
        },
      ],
    });
  });

  it("passes a missing appVersion through as null rather than dropping the field", async () => {
    const { appVersion: _omitted, ...withoutVersion } = REGISTER;
    await POST(req(withoutVersion));

    expect(control.writes[0]?.args[0]).toMatchObject({ appVersion: null });
  });

  it("revokes scoped to the caller AND the device", async () => {
    const res = await POST(req({ command: "revoke", deviceId: DEVICE_ID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(control.writes[0]).toEqual({
      fn: "revokePushTarget",
      args: [OWNER_ID, DEVICE_ID],
    });
  });

  it("answers 200 with revoked:false for a device that was never registered", async () => {
    control.revokedRows = 0;

    const res = await POST(req({ command: "revoke", deviceId: DEVICE_ID }));

    // NOT a 404. A sign-out on a phone that never got a token is an ordinary
    // event, and a 404 would make it read as a failure the client should retry.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false });
  });
});

describe("POST /api/v1/me/push-targets — refusing a bad body", () => {
  it("refuses a body that is not JSON at all", async () => {
    const res = await POST(req("not json"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toHaveLength(0);
  });

  it("refuses a token without the Expo prefix", async () => {
    const res = await POST(req({ ...REGISTER, expoPushToken: "fcm-raw-token" }));

    // The phone checks this first so the round trip is never spent; this is the
    // backstop for a client out of step with the contract.
    expect(res.status).toBe(400);
    expect(control.writes).toHaveLength(0);
  });

  it("refuses a platform the column's CHECK does not admit", async () => {
    const res = await POST(req({ ...REGISTER, platform: "web" }));

    expect(res.status).toBe(400);
    expect(control.writes).toHaveLength(0);
  });

  // A STRING A CLIENT CONTROLS IS A ROW A CLIENT CONTROLS THE SIZE OF — the
  // sentence `appVersion`'s cap was written for, applied to the two fields that
  // were still uncapped. `deviceId` is "shape only, never a format assertion",
  // which was an argument about SPELLING and was being read as an argument
  // about LENGTH; `expoPushToken` had a prefix check, and a prefix says nothing
  // about a tail. Both writes are authenticated, so this is a storage bound
  // rather than an authorization one — which is exactly what makes it the kind
  // of thing nobody notices is missing.

  it("refuses a device id longer than the contract's cap", async () => {
    const res = await POST(req({ ...REGISTER, deviceId: "d".repeat(201) }));

    expect(res.status).toBe(400);
    expect(control.writes).toHaveLength(0);
  });

  it("still accepts a device id at exactly the cap", async () => {
    // The boundary in the other direction: a cap that refuses its own limit is
    // an off-by-one nobody sees until a client mints a longer id.
    const res = await POST(req({ ...REGISTER, deviceId: "d".repeat(200) }));

    expect(res.status).toBe(200);
    expect(control.writes).toHaveLength(1);
  });

  it("refuses a well-prefixed token that is a megabyte long", async () => {
    // `ExponentPushToken[` plus anything passes the prefix check. That is the
    // gap: the shape assertion and the size assertion are different questions.
    const res = await POST(
      req({ ...REGISTER, expoPushToken: `ExponentPushToken[${"x".repeat(600)}]` }),
    );

    expect(res.status).toBe(400);
    expect(control.writes).toHaveLength(0);
  });

  it("refuses a command it does not know", async () => {
    const res = await POST(req({ command: "delete_everything", deviceId: DEVICE_ID }));

    expect(res.status).toBe(400);
    expect(control.writes).toHaveLength(0);
  });
});

describe("POST /api/v1/me/push-targets — a write that fails", () => {
  it("answers 503 with a retry-after rather than a 500", async () => {
    control.registerThrows = true;

    const res = await POST(req(REGISTER));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
    // The phone retries on its next session transition; telling it when is
    // cheaper than letting it guess.
    expect(res.headers.get("retry-after")).toBe("5");
  });
});
