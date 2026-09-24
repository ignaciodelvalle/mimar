// Wiring test: the decomiso notification flush goes through the canonical
// notification write path, and a failed delivery does NOT read as success.
//
// HISTORY. This file used to pin the old shape directly: the action inserted
// rows with `db.insert(notifications)` and then called the Web Push seam, and
// the second test asserted — approvingly — that a failed insert still returned
// `{ ok: true, publicCode }` with nothing else. That was the defect (PO fix
// list 2026-08-17, item 2e), not the contract: this product has NO email
// channel, so a lost in-app row means the person is never told, and the
// operator was shown plain success either way.
//
// The action now delivers through createNotificationsBulk, which owns BOTH legs
// this file cares about — the Web Push call and the dead-letter on failure — and
// returns counts the action turns into an operator-visible warning.
//
// Everything is mocked — no DB, no auth session.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type DeliveredRow = { userId: string; dedupeKey: string };
const mockCreateNotificationsBulk = vi.hoisted(() =>
  vi.fn(async (_rows: unknown[]) => ({
    insertedCount: 1,
    duplicateCount: 0,
    deadLetteredCount: 0,
  })),
);
vi.mock("@/lib/infra/notification-service", () => ({
  createNotificationsBulk: mockCreateNotificationsBulk,
}));

const PENDING_ROWS = [
  {
    userId: "govt-user-1",
    notificationType: "decomiso_handoff_rejected",
    severity: "urgent" as const,
    title: "Handoff de decomiso rechazado",
    body: "La organización destinataria rechazó la custodia.",
    ctaUrl: "/gob/decomisos",
  },
];

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ id: "org-1" }]),
        })),
      })),
    })),
    transaction: vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  },
  notifications: {},
  organizations: { publicToken: "publicToken" },
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireDecomisoPrincipal: vi.fn(),
}));

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  requireCapability: vi.fn(async () => ({
    error: null,
    user: { id: "org-user-1" },
    organization: { id: "org-1", publicToken: "ORG-TOKEN-1", displayName: "Refugio Test" },
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/src/modules/decomiso/application/resolve-govt-org", () => ({
  resolveGovtOrgForUser: vi.fn(),
}));

vi.mock("@/src/modules/decomiso/application/execute-decomiso", () => ({
  executeDecomiso: vi.fn(),
  validateExecuteDecomiso: vi.fn(),
}));

vi.mock("@/src/modules/decomiso/application/accept-decomiso-handoff", () => ({
  acceptDecomisoHandoffInTx: vi.fn(),
  validateAcceptDecomisoHandoff: vi.fn(),
}));

vi.mock("@/src/modules/decomiso/application/reassign-decomiso", () => ({
  reassignDecomisoInTx: vi.fn(),
  validateReassignDecomiso: vi.fn(),
}));

const mockValidateReject = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true as const,
    caseRow: { id: "case-1", publicCode: "DEC-0001" },
    govtOrgId: "govt-org-1",
    reasonNote: null,
  })),
);
const mockRejectInTx = vi.hoisted(() =>
  vi.fn(async () => ({ pendingNotifications: PENDING_ROWS })),
);
vi.mock("@/src/modules/decomiso/application/reject-decomiso-handoff", () => ({
  rejectDecomisoHandoffInTx: mockRejectInTx,
  validateRejectDecomisoHandoff: mockValidateReject,
}));

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("rejectDecomisoHandoffAction — notification delivery", () => {
  beforeEach(() => {
    mockCreateNotificationsBulk
      .mockClear()
      .mockResolvedValue({ insertedCount: 1, duplicateCount: 0, deadLetteredCount: 0 });
  });

  it("delivers through the canonical path (which owns the push + dead-letter legs)", async () => {
    const { rejectDecomisoHandoffAction } = await import("@/app/actions/decomiso");

    const result = await rejectDecomisoHandoffAction({
      receiverOrgToken: "ORG-TOKEN-1",
      casePublicCode: "DEC-0001",
    });

    expect(result).toEqual({ ok: true, publicCode: "DEC-0001", warning: null });
    expect(mockCreateNotificationsBulk).toHaveBeenCalledOnce();
    const delivered = mockCreateNotificationsBulk.mock.calls[0][0] as DeliveredRow[];
    expect(delivered).toHaveLength(1);
    expect(delivered[0].userId).toBe("govt-user-1");
    // Idempotent across a retry of the SAME act.
    expect(delivered[0].dedupeKey).toBe(
      "decomiso:DEC-0001:handoff_rejected:decomiso_handoff_rejected:govt-user-1",
    );
  });

  it("a dead-lettered delivery surfaces a warning instead of plain success", async () => {
    mockCreateNotificationsBulk.mockResolvedValueOnce({
      insertedCount: 0,
      duplicateCount: 0,
      deadLetteredCount: 1,
    });

    const { rejectDecomisoHandoffAction } = await import("@/app/actions/decomiso");
    const result = await rejectDecomisoHandoffAction({
      receiverOrgToken: "ORG-TOKEN-1",
      casePublicCode: "DEC-0001",
    });

    // The act still stands — it was committed, and undoing it over a delivery
    // blip would be worse. But it is NO LONGER indistinguishable from a run
    // where everybody was reached.
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.publicCode).toBe("DEC-0001");
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain("1 de 1");
  });
});
