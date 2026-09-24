// Unit tests for the push subscription server actions
// (app/actions/push-subscriptions.ts).
//
// Verifies:
//   1. A valid subscription upserts scoped to the SESSION user (auth-guarded),
//      with re-activation (revoked_at = null) on endpoint conflict.
//   2. Invalid inputs (non-https endpoint, missing keys) are rejected without
//      touching the DB.
//   3. A DB failure fails soft: es-AR error + reportError, never a throw.
//   4. Revocation soft-revokes scoped to (endpoint, session user) — one user
//      can never revoke another user's registration.
//   5. The liveness read is scoped the same way and FAILS TOWARDS OFF.
//
// DB and auth are fully mocked so no local stack is required.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: auth guard — the action must resolve the user from the session.
// ---------------------------------------------------------------------------

const SESSION_USER_ID = "user-0000-0000-0000-000000000042";
const requireUserMock = vi.fn(async () => ({ user: { id: SESSION_USER_ID } }));
vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: () => requireUserMock(),
}));

// ---------------------------------------------------------------------------
// Mock: next/headers (user-agent capture)
// ---------------------------------------------------------------------------

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "user-agent" ? "test-browser/1.0" : null),
  })),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/infra/report-error
// ---------------------------------------------------------------------------

const reportErrorMock = vi.fn();
vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

// ---------------------------------------------------------------------------
// Mock: @/db — capture upsert + update payloads. pushSubscriptions is the REAL
// schema export so drizzle operators receive real columns.
// ---------------------------------------------------------------------------

type InsertCall = {
  values?: Record<string, unknown>;
  conflict?: { set?: Record<string, unknown> };
};
const insertCalls: InsertCall[] = [];
const updateSetCalls: Array<Record<string, unknown>> = [];
const selectCalls: boolean[] = [];
let selectRows: Array<{ id: string }> = [];
let dbShouldThrow = false;

vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  return {
    pushSubscriptions: schema.pushSubscriptions,
    db: {
      insert: vi.fn(() => {
        const call: InsertCall = {};
        insertCalls.push(call);
        return {
          values: (values: Record<string, unknown>) => {
            call.values = values;
            return {
              onConflictDoUpdate: async (conflict: { set?: Record<string, unknown> }) => {
                call.conflict = conflict;
                if (dbShouldThrow) throw new Error("db unavailable");
              },
            };
          },
        };
      }),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCalls.push(true);
              if (dbShouldThrow) throw new Error("db unavailable");
              return selectRows;
            },
          }),
        }),
      })),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          updateSetCalls.push(values);
          return {
            where: async () => {
              if (dbShouldThrow) throw new Error("db unavailable");
            },
          };
        },
      })),
    },
  };
});

import {
  isPushSubscriptionActiveAction,
  revokePushSubscriptionAction,
  savePushSubscriptionAction,
} from "@/app/actions/push-subscriptions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_INPUT = {
  endpoint: "https://push.example.com/reg/abc123",
  keys: { p256dh: "client-public-key", auth: "client-auth-secret" },
};

beforeEach(() => {
  insertCalls.length = 0;
  updateSetCalls.length = 0;
  selectCalls.length = 0;
  selectRows = [];
  dbShouldThrow = false;
  requireUserMock.mockClear();
  reportErrorMock.mockReset();
});

// ---------------------------------------------------------------------------
// savePushSubscriptionAction
// ---------------------------------------------------------------------------

describe("savePushSubscriptionAction", () => {
  it("upserts a valid subscription scoped to the session user", async () => {
    const result = await savePushSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: true });
    expect(requireUserMock).toHaveBeenCalledTimes(1);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toMatchObject({
      userId: SESSION_USER_ID,
      endpoint: VALID_INPUT.endpoint,
      p256dh: VALID_INPUT.keys.p256dh,
      auth: VALID_INPUT.keys.auth,
      userAgent: "test-browser/1.0",
    });
    // Endpoint conflict re-activates and re-owns the row.
    expect(insertCalls[0].conflict?.set).toMatchObject({
      userId: SESSION_USER_ID,
      revokedAt: null,
    });
  });

  it("rejects a non-https endpoint without touching the DB", async () => {
    const result = await savePushSubscriptionAction({
      ...VALID_INPUT,
      endpoint: "http://insecure.example.com/reg/abc",
    });

    expect(result.ok).toBe(false);
    expect(insertCalls).toHaveLength(0);
  });

  it("rejects a subscription with missing keys without touching the DB", async () => {
    const result = await savePushSubscriptionAction({
      endpoint: VALID_INPUT.endpoint,
      keys: { p256dh: "", auth: "" },
    });

    expect(result.ok).toBe(false);
    expect(insertCalls).toHaveLength(0);
  });

  it("fails soft with reportError when the DB insert throws", async () => {
    dbShouldThrow = true;

    const result = await savePushSubscriptionAction(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No pudimos activar/);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0][0]).toBe("push/subscribe");
  });
});

// ---------------------------------------------------------------------------
// revokePushSubscriptionAction
// ---------------------------------------------------------------------------

describe("revokePushSubscriptionAction", () => {
  it("soft-revokes (revoked_at) the endpoint for the session user", async () => {
    const result = await revokePushSubscriptionAction(VALID_INPUT.endpoint);

    expect(result).toEqual({ ok: true });
    expect(requireUserMock).toHaveBeenCalledTimes(1);
    expect(updateSetCalls).toHaveLength(1);
    expect(updateSetCalls[0]).toHaveProperty("revokedAt");
    expect(updateSetCalls[0].revokedAt).toBeInstanceOf(Date);
  });

  it("rejects an empty endpoint without touching the DB", async () => {
    const result = await revokePushSubscriptionAction("");

    expect(result.ok).toBe(false);
    expect(updateSetCalls).toHaveLength(0);
  });

  it("fails soft with reportError when the DB update throws", async () => {
    dbShouldThrow = true;

    const result = await revokePushSubscriptionAction(VALID_INPUT.endpoint);

    expect(result.ok).toBe(false);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0][0]).toBe("push/revoke");
  });
});

// ---------------------------------------------------------------------------
// isPushSubscriptionActiveAction
// ---------------------------------------------------------------------------
//
// THE BUG THIS COVERS. The /cuenta toggle rendered ON from the BROWSER alone —
// `pushManager.getSubscription()` plus a granted permission — and never asked
// the server. But `revoked_at` has a second writer: the delivery path sets it
// when the push service answers 410/404 for a dead endpoint. In that case the
// browser still holds its subscription object and permission is still granted,
// so the switch read ON forever while the server had stopped sending. Someone
// waiting to hear that their lost pet was seen was being promised, by their own
// settings screen, that they would be.

describe("isPushSubscriptionActiveAction", () => {
  it("reports active when the session user owns a live row", async () => {
    selectRows = [{ id: "sub-1" }];
    const result = await isPushSubscriptionActiveAction(VALID_INPUT.endpoint);
    expect(result.active).toBe(true);
    expect(selectCalls).toHaveLength(1);
    expect(requireUserMock).toHaveBeenCalled();
  });

  it("reports inactive when the server has revoked the endpoint", async () => {
    // The predicate carries `revoked_at IS NULL`, so a revoked row simply is
    // not returned — this is the 410-pruned case, and the whole point.
    selectRows = [];
    const result = await isPushSubscriptionActiveAction(VALID_INPUT.endpoint);
    expect(result.active).toBe(false);
  });

  it("reports inactive for an empty endpoint without touching the DB", async () => {
    const result = await isPushSubscriptionActiveAction("");
    expect(result.active).toBe(false);
    expect(selectCalls).toHaveLength(0);
  });

  it("FAILS TOWARDS OFF when the DB read throws", async () => {
    // Direction is load-bearing. Answering "active" because the check itself
    // broke is the exact lie this action exists to stop telling.
    dbShouldThrow = true;
    const result = await isPushSubscriptionActiveAction(VALID_INPUT.endpoint);
    expect(result.active).toBe(false);
    expect(reportErrorMock).toHaveBeenCalled();
  });
});
