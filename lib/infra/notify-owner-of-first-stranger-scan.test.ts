import { describe, expect, it, vi } from "vitest";

import {
  type FirstStrangerScanNotifyInput,
  notifyOwnerOfFirstStrangerScan,
} from "./notify-owner-of-first-stranger-scan";

function makeInput(over: Partial<FirstStrangerScanNotifyInput> = {}): FirstStrangerScanNotifyInput {
  return {
    petId: "pet-1",
    petName: "Pampa",
    petPublicToken: "DIM-PAMP-0001",
    ...over,
  };
}

describe("notifyOwnerOfFirstStrangerScan", () => {
  it("notifies the owner on a non-self scan", async () => {
    const createNotification = vi.fn().mockResolvedValue({ status: "inserted", id: "n-1" });

    const res = await notifyOwnerOfFirstStrangerScan(makeInput(), {
      findOwnerUserIds: async () => ["owner-1"],
      createNotification,
    });

    expect(createNotification).toHaveBeenCalledTimes(1);
    const arg = createNotification.mock.calls[0][0];
    expect(arg.userId).toBe("owner-1");
    expect(arg.notificationType).toBe("first_stranger_scan");
    expect(arg.title).toBe("Alguien escaneó la credencial de Pampa por primera vez");
    expect(arg.ctaUrl).toBe("/mis-mascotas/DIM-PAMP-0001");
    expect(arg.relatedPetId).toBe("pet-1");
    expect(arg.dedupeKey).toBe("first_stranger_scan:pet-1:owner-1");
    expect(res.delivered).toBe(1);
  });

  it("notifies EVERY current owner/co-owner, deduped", async () => {
    const createNotification = vi.fn().mockResolvedValue({ status: "inserted" });

    const res = await notifyOwnerOfFirstStrangerScan(makeInput(), {
      findOwnerUserIds: async () => ["owner-1", "owner-2", "owner-1"],
      createNotification,
    });

    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(res.delivered).toBe(2);
  });

  it("is idempotent per (pet, owner): a second call reuses the SAME dedupeKey and does not double-deliver", async () => {
    // Simulate the DB's ON CONFLICT (dedupe_key) DO NOTHING: first call
    // inserts, every subsequent call with the same dedupeKey is a no-op.
    const seen = new Set<string>();
    const createNotification = vi.fn(async (input: { dedupeKey: string }) => {
      if (seen.has(input.dedupeKey)) return { status: "duplicate" as const, id: null };
      seen.add(input.dedupeKey);
      return { status: "inserted" as const, id: "n-1" };
    });

    const first = await notifyOwnerOfFirstStrangerScan(makeInput(), {
      findOwnerUserIds: async () => ["owner-1"],
      createNotification,
    });
    // A second stranger scan on the same pet — the caller (log-scan.ts) calls
    // this on every non-self scan, not just the provably-first one.
    const second = await notifyOwnerOfFirstStrangerScan(makeInput(), {
      findOwnerUserIds: async () => ["owner-1"],
      createNotification,
    });

    expect(first.delivered).toBe(1);
    expect(second.delivered).toBe(0);
    expect(createNotification.mock.calls[0][0].dedupeKey).toBe(
      createNotification.mock.calls[1][0].dedupeKey,
    );
  });

  it("does nothing when the pet has no human owner (org-held)", async () => {
    const createNotification = vi.fn();

    const res = await notifyOwnerOfFirstStrangerScan(makeInput(), {
      findOwnerUserIds: async () => [],
      createNotification,
    });

    expect(createNotification).not.toHaveBeenCalled();
    expect(res.delivered).toBe(0);
  });

  it("is best-effort: a lookup failure never throws", async () => {
    const createNotification = vi.fn();

    const res = await notifyOwnerOfFirstStrangerScan(makeInput(), {
      findOwnerUserIds: async () => {
        throw new Error("db down");
      },
      createNotification,
    });

    expect(res.delivered).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });
});
