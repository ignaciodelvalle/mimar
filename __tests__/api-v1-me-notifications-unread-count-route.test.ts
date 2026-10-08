// `/api/v1/me/notifications/unread-count` — the number on the app's bell.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. AUTHORIZATION, the parent route's exactly: no bearer, an unusable one, a
//      caller the liveness guard refuses — including the legal re-acceptance
//      gate, which this route does not opt out of — answered with the codes
//      every sibling uses.
//   2. THE NUMBER IS THE INBOX'S. The aggregate is asked for the caller's own id
//      and with NO category: the bell counts the whole inbox.
//   3. A FAILED READ IS NOT A ZERO. A degraded pooler answers 503, never
//      `unreadCount: 0` — the client hides its badge on the first and would draw
//      a lie from the second.
//   4. THE LIMITERS. Two buckets of its own, IP before the guard and user after,
//      so the bell cannot spend the inbox's counter.
//   5. THE ENVELOPE AND THE CONTRACT'S BADGE RULE (`notificationBadgeLabel`).

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  limiterThrows: null as null | ((endpoint: string) => void),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  unread: null as null | ((userId: string, category?: string) => unknown),
  unreadCalls: [] as Array<{ userId: string; category: string | undefined }>,
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live
        ? control.live()
        : { ok: true, supabase: {}, user: { id: OWNER_ID }, profile: null },
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

vi.mock("@/lib/analytics/owner-dashboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/owner-dashboard")>();
  return {
    ...actual,
    fetchUnreadNotificationCount: async (userId: string, category?: string) => {
      control.unreadCalls.push({ userId, category });
      return control.unread ? control.unread(userId, category) : 0;
    },
  };
});

import { API_V1_IP_BUCKET_FAMILIES } from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError } from "@/lib/infra/db-budget";
import { RateLimitError } from "@/lib/infra/rate-limit";
import {
  MY_UNREAD_NOTIFICATIONS_PAYLOAD_VERSION,
  type MyUnreadNotificationsV1,
  notificationBadgeLabel,
} from "@dim/contract/api";

import { GET } from "@/app/api/v1/me/notifications/unread-count/route";

function req(init: { authorization?: string | null } = {}) {
  const headers: Record<string, string> = { "x-real-ip": "203.0.113.22" };
  const value = init.authorization === undefined ? "Bearer test-token" : init.authorization;
  if (value) headers.authorization = value;
  return new Request("http://localhost:3000/api/v1/me/notifications/unread-count", { headers });
}

beforeEach(() => {
  control.live = null;
  control.limiterThrows = null;
  control.limits = [];
  control.unread = null;
  control.unreadCalls = [];
});

describe("GET /api/v1/me/notifications/unread-count — authorization", () => {
  it("refuses a request with no Authorization header at all", async () => {
    const res = await GET(req({ authorization: null }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(control.unreadCalls).toEqual([]);
  });

  it("refuses a header that is not a usable bearer", async () => {
    const res = await GET(req({ authorization: "Basic abc" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_expired" });
  });

  it.each([
    ["NO_SESSION", 401, "auth_expired"],
    ["ACCOUNT_ERASED", 403, "account_erased"],
    ["DEACTIVATED", 403, "account_deactivated"],
    ["SHIFT_EXPIRED", 401, "session_shift_expired"],
    ["LEGAL_ACCEPTANCE_REQUIRED", 403, "legal_acceptance_required"],
    ["CLIENT_UPGRADE_REQUIRED", 426, "client_upgrade_required"],
  ])("maps %s to %i %s and never reads the count", async (reason, status, code) => {
    control.live = () => ({ ok: false, reason });
    const res = await GET(req());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
    expect(control.unreadCalls).toEqual([]);
  });

  it("answers 503 with a retry-after while the platform is in maintenance", async () => {
    control.live = () => ({ ok: false, reason: "MAINTENANCE" });
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });
});

describe("GET /api/v1/me/notifications/unread-count — the number", () => {
  it("answers the caller's whole-inbox count inside the envelope", async () => {
    control.unread = () => 7;
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as MyUnreadNotificationsV1;
    expect(body.payloadVersion).toBe(MY_UNREAD_NOTIFICATIONS_PAYLOAD_VERSION);
    expect(body.unreadCount).toBe(7);
    expect(Date.parse(body.staleAfter)).toBeGreaterThan(Date.parse(body.issuedAt));
    // Exactly the payload, nothing the inbox carries beside it.
    expect(Object.keys(body).sort()).toEqual(
      ["issuedAt", "payloadVersion", "staleAfter", "unreadCount"].sort(),
    );
    // The caller's own id, and NO category — the bell is the whole inbox.
    expect(control.unreadCalls).toEqual([{ userId: OWNER_ID, category: undefined }]);
  });

  it("answers a real zero as zero", async () => {
    control.unread = () => 0;
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(((await res.json()) as MyUnreadNotificationsV1).unreadCount).toBe(0);
  });

  it("answers 503, never a zero, when the count cannot be read in budget", async () => {
    control.unread = () => {
      throw new DbBudgetExceededError("api-v1-me-notifications-unread-count", 8_000);
    };
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
    expect(res.headers.get("retry-after")).toBe("5");
  });
});

describe("GET /api/v1/me/notifications/unread-count — the limiters", () => {
  it("spends its own IP bucket before the guard and its own user bucket after", async () => {
    await GET(req());
    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_notifications_unread_ip", identifier: "203.0.113.22" },
      { endpoint: "api_v1_me_notifications_unread_user", identifier: OWNER_ID },
    ]);
  });

  it("refuses with 429 once the IP bucket is spent, before reaching the guard", async () => {
    control.limiterThrows = (endpoint) => {
      if (endpoint === "api_v1_me_notifications_unread_ip") {
        throw new RateLimitError(new Date("2026-10-07T00:01:00.000Z"), "minute");
      }
    };
    control.live = () => {
      throw new Error("the guard must not run once the IP bucket refused");
    };
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("refuses with 429 once the user bucket is spent, without reading the count", async () => {
    control.limiterThrows = (endpoint) => {
      if (endpoint === "api_v1_me_notifications_unread_user") {
        throw new RateLimitError(new Date("2026-10-07T00:01:00.000Z"), "minute");
      }
    };
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(control.unreadCalls).toEqual([]);
  });

  it("files its IP bucket under the authenticated-read family", () => {
    expect(API_V1_IP_BUCKET_FAMILIES.api_v1_me_notifications_unread_ip).toBe("authenticated-read");
  });
});

describe("notificationBadgeLabel — what the bell shows", () => {
  it.each([
    [null, null],
    [0, null],
    [-1, null],
    [Number.NaN, null],
    [1, "1"],
    [9, "9"],
    [10, "9+"],
    [250, "9+"],
  ])("labels %s as %s", (count, label) => {
    expect(notificationBadgeLabel(count)).toBe(label);
  });
});
