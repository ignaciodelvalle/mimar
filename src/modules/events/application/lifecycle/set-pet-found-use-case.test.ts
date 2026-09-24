// Test: setPetFound (WU-6 lifecycle)
//
// TDD RED phase — tests written BEFORE implementation.
// Parity contract: byte-for-byte behavior vs app/actions/events.ts::setPetFoundAction.
//
// Invariants under test:
//   - status=deceased → throw with "fallecida".
//   - status≠lost → idempotent early return { ok: true, alreadyActive: true } (NO write).
//   - Normal path: insert status_changed(lost→active) + update pets.status=active + closeCase.
//   - closeCase called when a lostCase is found.
//   - Result: { ok: true, alreadyActive: false } on actual write.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockOpenCase = vi.hoisted(() => vi.fn());
const mockCloseCase = vi.hoisted(() => vi.fn());
const mockFindOpenCaseForPetAndKind = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/case-helpers", () => ({
  openCase: mockOpenCase,
  closeCase: mockCloseCase,
  findOpenCaseForPetAndKind: mockFindOpenCaseForPetAndKind,
}));

const mockValidateEventPayload = vi.hoisted(() => vi.fn());
vi.mock("@/lib/events/event-schemas", () => ({
  validateEventPayload: mockValidateEventPayload,
}));

import type { EventsRepository } from "../../infrastructure/events-repository";
import { setPetFound } from "./set-pet-found-use-case";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  return {
    insertEvent: vi.fn().mockResolvedValue({ id: randomUUID() }),
    updateStatusProjection: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTransaction() {
  return vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
}

const petId = randomUUID();
const userId = randomUUID();
const ownerUserId = randomUUID();
const caseId = randomUUID();

const baseParams = {
  petId,
  petStatus: "lost",
  petPublicToken: "abc123",
  petName: "Firulais",
  petSex: "male" as const,
  recordedByUserId: userId,
  ownerUserId,
  eventAuthorship: {
    authorRole: "owner" as const,
    authorOrganizationId: null,
    authorVerified: false,
  },
  now: new Date("2026-06-01T12:00:00Z"),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setPetFound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateEventPayload.mockImplementation((_type: string, payload: unknown) => payload);
    mockCloseCase.mockResolvedValue(undefined);
    mockFindOpenCaseForPetAndKind.mockResolvedValue(null);
  });

  it("throws when pet is deceased", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    await expect(
      setPetFound(
        { ...baseParams, petStatus: "deceased" },
        {
          repo: repo as unknown as Pick<EventsRepository, "insertEvent" | "updateStatusProjection">,
          transaction: tx,
        },
      ),
    ).rejects.toThrow("fallecida");
  });

  it("returns alreadyActive=true without write when pet is not lost", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    const result = await setPetFound(
      { ...baseParams, petStatus: "active" },
      {
        repo: repo as unknown as Pick<EventsRepository, "insertEvent" | "updateStatusProjection">,
        transaction: tx,
      },
    );
    expect(result).toEqual({ ok: true, alreadyActive: true });
    expect(repo.insertEvent).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });

  it("inserts status_changed(lost→active), updates pets.status, and closes case when case found", async () => {
    mockFindOpenCaseForPetAndKind.mockResolvedValue({ id: caseId });

    const repo = makeRepo();
    const tx = makeTransaction();
    const result = await setPetFound(baseParams, {
      repo: repo as unknown as Pick<EventsRepository, "insertEvent" | "updateStatusProjection">,
      transaction: tx,
    });

    expect(result).toEqual({ ok: true, alreadyActive: false });

    // status_changed inserted once
    expect(repo.insertEvent).toHaveBeenCalledTimes(1);
    const [insertArg] = repo.insertEvent.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(insertArg.eventType).toBe("status_changed");
    expect(insertArg.caseId).toBe(caseId);

    // pets.status updated to active
    expect(repo.updateStatusProjection).toHaveBeenCalledWith(
      petId,
      "active",
      baseParams.now,
      expect.anything(),
    );

    // case closed
    expect(mockCloseCase).toHaveBeenCalledWith(
      expect.objectContaining({ caseId, reason: "resolved" }),
      expect.anything(),
    );
  });

  it("inserts status_changed without caseId when no case found", async () => {
    mockFindOpenCaseForPetAndKind.mockResolvedValue(null);

    const repo = makeRepo();
    const tx = makeTransaction();
    await setPetFound(baseParams, {
      repo: repo as unknown as Pick<EventsRepository, "insertEvent" | "updateStatusProjection">,
      transaction: tx,
    });

    const [insertArg] = repo.insertEvent.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(insertArg.caseId).toBeNull();
    expect(mockCloseCase).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Recovery notifications (UI-4 fix 3)
  // -------------------------------------------------------------------------

  it("emits an owner confirmation notification on found", async () => {
    mockFindOpenCaseForPetAndKind.mockResolvedValue({ id: caseId });
    const repo = makeRepo();
    const tx = makeTransaction();
    const flushNotifications = vi.fn().mockResolvedValue(undefined);

    await setPetFound(baseParams, {
      repo: repo as unknown as Pick<EventsRepository, "insertEvent" | "updateStatusProjection">,
      transaction: tx,
      flushNotifications,
    });

    expect(flushNotifications).toHaveBeenCalledTimes(1);
    const [pending] = flushNotifications.mock.calls[0] as [Array<Record<string, unknown>>];
    const ownerNotif = pending.find((n) => n.notificationType === "lost_episode_resolved_owner");
    expect(ownerNotif).toBeDefined();
    expect(ownerNotif?.userId).toBe(ownerUserId);
    // Must carry a CTA (notification-cta-fitness convention).
    expect(ownerNotif?.ctaUrl).toBe(`/mis-mascotas/${baseParams.petPublicToken}`);
    expect(ownerNotif?.title).toContain("encontrado"); // sex=male
  });

  it("notifies the original broadcast recipients (dedup owner) with a CTA", async () => {
    mockFindOpenCaseForPetAndKind.mockResolvedValue({ id: caseId });
    const repo = makeRepo();
    const tx = makeTransaction();
    const flushNotifications = vi.fn().mockResolvedValue(undefined);
    const memberA = randomUUID();
    const memberB = randomUUID();
    // Include the owner in the recipients to assert dedup.
    const findBroadcastRecipientUserIds = vi
      .fn()
      .mockResolvedValue([memberA, memberB, ownerUserId]);

    await setPetFound(baseParams, {
      repo: repo as unknown as Pick<EventsRepository, "insertEvent" | "updateStatusProjection">,
      transaction: tx,
      flushNotifications,
      findBroadcastRecipientUserIds,
    });

    expect(findBroadcastRecipientUserIds).toHaveBeenCalledWith(petId);
    const [pending] = flushNotifications.mock.calls[0] as [Array<Record<string, unknown>>];
    const broadcastNotifs = pending.filter(
      (n) => n.notificationType === "lost_episode_resolved_broadcast",
    );
    // memberA + memberB, but NOT the owner (deduped).
    expect(broadcastNotifs).toHaveLength(2);
    const recipientIds = broadcastNotifs.map((n) => n.userId);
    expect(recipientIds).toContain(memberA);
    expect(recipientIds).toContain(memberB);
    expect(recipientIds).not.toContain(ownerUserId);
    for (const n of broadcastNotifs) {
      expect(n.ctaUrl).toBe(`/p/${baseParams.petPublicToken}`);
    }
  });

  it("still recovers when the broadcast recipient lookup throws (non-fatal)", async () => {
    mockFindOpenCaseForPetAndKind.mockResolvedValue({ id: caseId });
    const repo = makeRepo();
    const tx = makeTransaction();
    const flushNotifications = vi.fn().mockResolvedValue(undefined);
    const findBroadcastRecipientUserIds = vi.fn().mockRejectedValue(new Error("db down"));

    const result = await setPetFound(baseParams, {
      repo: repo as unknown as Pick<EventsRepository, "insertEvent" | "updateStatusProjection">,
      transaction: tx,
      flushNotifications,
      findBroadcastRecipientUserIds,
    });

    expect(result).toEqual({ ok: true, alreadyActive: false });
    // Owner confirmation still flushed despite the recipient lookup failing.
    const [pending] = flushNotifications.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(pending.some((n) => n.notificationType === "lost_episode_resolved_owner")).toBe(true);
  });

  it("uses the neutral participle when sex is unknown", async () => {
    mockFindOpenCaseForPetAndKind.mockResolvedValue(null);
    const repo = makeRepo();
    const tx = makeTransaction();
    const flushNotifications = vi.fn().mockResolvedValue(undefined);

    await setPetFound(
      { ...baseParams, petSex: "unknown" },
      {
        repo: repo as unknown as Pick<EventsRepository, "insertEvent" | "updateStatusProjection">,
        transaction: tx,
        flushNotifications,
      },
    );

    const [pending] = flushNotifications.mock.calls[0] as [Array<Record<string, unknown>>];
    const ownerNotif = pending.find((n) => n.notificationType === "lost_episode_resolved_owner");
    expect(ownerNotif?.title).toContain("encontrada/o");
  });
});
