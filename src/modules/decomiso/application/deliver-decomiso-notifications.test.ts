// Unit tests for deliver-decomiso-notifications.ts.
//
// THE DEFECT THIS PINS
// ---------------------------------------------------------------------------
// All five decomiso actions used to insert notifications in a try/catch that
// logged to console and returned `{ ok: true }` regardless. There is no email
// channel anywhere in this product, so an in-app row is the entire notification
// instrument: a swallowed failure means the person whose animal was seized — or
// the refugio with seven days to accept a handoff — is simply never told, while
// the operator is shown success.
//
// Two properties, both load-bearing:
//   1. a delivery failure NEVER reads as unqualified success (a warning comes
//      back, in es-AR, naming how many people were not reached);
//   2. a clean delivery produces NO warning, so the signal cannot be ignored as
//      background noise.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NewNotification } from "../domain/types";

const createNotificationsBulk = vi.fn();
vi.mock("@/lib/infra/notification-service", () => ({
  createNotificationsBulk: (...args: unknown[]) => createNotificationsBulk(...args),
}));

const { deliverDecomisoNotifications } = await import("./deliver-decomiso-notifications");

function notif(overrides: Partial<NewNotification> = {}): NewNotification {
  return {
    userId: "user-1",
    notificationType: "decomiso_owner_lost_custody",
    title: "Custodia oficial transferida",
    body: "…",
    severity: "urgent",
    ...overrides,
  };
}

beforeEach(() => {
  createNotificationsBulk.mockReset();
});

describe("deliverDecomisoNotifications", () => {
  it("returns NO warning when everything is delivered", async () => {
    createNotificationsBulk.mockResolvedValue({
      insertedCount: 2,
      duplicateCount: 0,
      deadLetteredCount: 0,
    });
    const result = await deliverDecomisoNotifications([notif(), notif({ userId: "user-2" })], {
      casePublicCode: "CAS-0001-0001",
      stage: "executed",
    });
    expect(result.warning).toBeNull();
    expect(result.delivered).toBe(2);
  });

  it("returns a warning naming how many were NOT reached when a payload is dead-lettered", async () => {
    createNotificationsBulk.mockResolvedValue({
      insertedCount: 1,
      duplicateCount: 0,
      deadLetteredCount: 2,
    });
    const result = await deliverDecomisoNotifications(
      [notif(), notif({ userId: "user-2" }), notif({ userId: "user-3" })],
      { casePublicCode: "CAS-0001-0001", stage: "executed" },
    );
    expect(result.deadLettered).toBe(2);
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain("2 de 3");
    // The act itself is NOT reported as failed — undoing a recorded seizure over
    // a delivery blip would be worse than the blip.
    expect(result.warning).toContain("quedó registrado");
  });

  it("builds a dedupe key that is stable per recipient and distinct per stage", async () => {
    createNotificationsBulk.mockResolvedValue({
      insertedCount: 1,
      duplicateCount: 0,
      deadLetteredCount: 0,
    });
    await deliverDecomisoNotifications([notif()], {
      casePublicCode: "CAS-0001-0001",
      stage: "executed",
    });
    const first = createNotificationsBulk.mock.calls[0][0] as Array<{ dedupeKey: string }>;
    expect(first[0].dedupeKey).toBe(
      "decomiso:CAS-0001-0001:executed:decomiso_owner_lost_custody:user-1",
    );

    await deliverDecomisoNotifications([notif()], {
      casePublicCode: "CAS-0001-0001",
      stage: "returned_to_owner",
    });
    const second = createNotificationsBulk.mock.calls[1][0] as Array<{ dedupeKey: string }>;
    expect(second[0].dedupeKey).not.toBe(first[0].dedupeKey);
  });

  it("does not touch the delivery path for an empty list", async () => {
    const result = await deliverDecomisoNotifications([], {
      casePublicCode: "CAS-0001-0001",
      stage: "executed",
    });
    expect(createNotificationsBulk).not.toHaveBeenCalled();
    expect(result.warning).toBeNull();
  });
});
