// Unit tests for the adoption bulk-action server actions.
//
// These are pure-logic tests: the inner per-item actions are mocked so no DB
// or Supabase connection is needed. We verify:
//   (a) bulk approve transitions each selected application via the canonical action.
//   (b) bulk reject requires a reason (≥5 chars) before calling any canonical action.
//   (c) partial failure: when one item fails, the others still succeed and the
//       failure is recorded — not a full-or-nothing rollback.
//   (d) a shared bulkActionId is present in every result.
//   (e) reason validation fails fast (before touching any items) to produce clean UX.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the canonical single-item adoption actions so tests never touch the DB.
// ---------------------------------------------------------------------------

const mockApprove = vi.fn();
const mockReject = vi.fn();

vi.mock("@/src/modules/adoption/actions", () => ({
  approveAdoptionApplicationAction: (...args: unknown[]) => mockApprove(...args),
  rejectAdoptionApplicationAction: (...args: unknown[]) => mockReject(...args),
}));

// revalidatePath is a Next.js server function — stub it in the test environment.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// The bulk wrappers call requireOrgAccessByToken for a fail-fast membership check
// before looping; stub it so these pure-logic tests don't need a DB/Supabase.
vi.mock("@/lib/infra/auth-guards", () => ({
  requireOrgAccessByToken: vi.fn().mockResolvedValue(undefined),
}));

import {
  bulkApproveAdoptionApplicationsAction,
  bulkRejectAdoptionApplicationsAction,
} from "@/app/actions/bulk-adoption-actions";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const ORG_TOKEN = "org-test-tok";
const IDS = ["app-evt-1", "app-evt-2", "app-evt-3"];

// ---------------------------------------------------------------------------
// Bulk approve
// ---------------------------------------------------------------------------

describe("bulkApproveAdoptionApplicationsAction", () => {
  beforeEach(() => {
    mockApprove.mockReset();
  });

  it("calls approveAdoptionApplicationAction for every selected id", async () => {
    mockApprove.mockResolvedValue({ ok: true });

    await bulkApproveAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: IDS,
    });

    expect(mockApprove).toHaveBeenCalledTimes(IDS.length);
    for (const id of IDS) {
      expect(mockApprove).toHaveBeenCalledWith(
        ORG_TOKEN,
        expect.objectContaining({ applicationEventId: id }),
      );
    }
  });

  it("returns all ids in succeeded when all actions succeed", async () => {
    mockApprove.mockResolvedValue({ ok: true });

    const result = await bulkApproveAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: IDS,
    });

    expect(result.succeeded).toEqual(IDS);
    expect(result.failed).toHaveLength(0);
  });

  it("includes a shared bulkActionId in the result", async () => {
    mockApprove.mockResolvedValue({ ok: true });

    const result = await bulkApproveAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: IDS,
    });

    // bulkActionId must be a non-empty string (UUID format from node:crypto).
    expect(result.bulkActionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("partial failure — one item fails, others still succeed (c)", async () => {
    mockApprove
      .mockResolvedValueOnce({ ok: true }) // app-evt-1 succeeds
      .mockResolvedValueOnce({ error: "Postulación ya resuelta." }) // app-evt-2 fails
      .mockResolvedValueOnce({ ok: true }); // app-evt-3 succeeds

    const result = await bulkApproveAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: IDS,
    });

    expect(result.succeeded).toEqual(["app-evt-1", "app-evt-3"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      id: "app-evt-2",
      reason: "Postulación ya resuelta.",
    });
    // The batch still ran all three items despite the middle failure.
    expect(mockApprove).toHaveBeenCalledTimes(3);
  });

  it("partial failure — thrown errors are captured per-item, not rethrown", async () => {
    mockApprove
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("DB timeout"))
      .mockResolvedValueOnce({ ok: true });

    const result = await bulkApproveAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: IDS,
    });

    expect(result.succeeded).toEqual(["app-evt-1", "app-evt-3"]);
    expect(result.failed[0]).toMatchObject({ id: "app-evt-2", reason: "DB timeout" });
  });

  it("forwards optional notes to the canonical action", async () => {
    mockApprove.mockResolvedValue({ ok: true });

    await bulkApproveAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: ["app-evt-1"],
      notes: "Aprobación en lote",
    });

    expect(mockApprove).toHaveBeenCalledWith(
      ORG_TOKEN,
      expect.objectContaining({ notes: "Aprobación en lote" }),
    );
  });

  it("returns empty succeeded/failed lists when given no ids", async () => {
    const result = await bulkApproveAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: [],
    });

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(mockApprove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bulk reject
// ---------------------------------------------------------------------------

describe("bulkRejectAdoptionApplicationsAction", () => {
  beforeEach(() => {
    mockReject.mockReset();
  });

  it("requires a reason of at least 5 characters (b)", async () => {
    const result = await bulkRejectAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: IDS,
      reason: "abc", // too short
    });

    // No items should have been processed.
    expect(mockReject).not.toHaveBeenCalled();
    // All items reported as failed with the validation message.
    expect(result.failed).toHaveLength(IDS.length);
    for (const f of result.failed) {
      expect(f.reason).toMatch(/mínimo 5 caracteres|al menos 5 caracteres/i);
    }
    expect(result.succeeded).toHaveLength(0);
  });

  it("rejects empty reason", async () => {
    const result = await bulkRejectAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: ["app-evt-1"],
      reason: "   ", // whitespace only
    });

    expect(mockReject).not.toHaveBeenCalled();
    expect(result.failed).toHaveLength(1);
  });

  it("calls rejectAdoptionApplicationAction for every id when reason is valid", async () => {
    mockReject.mockResolvedValue({ ok: true });

    await bulkRejectAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: IDS,
      reason: "No cumple los requisitos mínimos",
    });

    expect(mockReject).toHaveBeenCalledTimes(IDS.length);
    for (const id of IDS) {
      expect(mockReject).toHaveBeenCalledWith(
        ORG_TOKEN,
        expect.objectContaining({
          applicationEventId: id,
          notes: "No cumple los requisitos mínimos",
        }),
      );
    }
  });

  it("includes a shared bulkActionId in the result (d)", async () => {
    mockReject.mockResolvedValue({ ok: true });

    const result = await bulkRejectAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: IDS,
      reason: "Sin capacidad para más adopciones este mes",
    });

    // bulkActionId must be a non-empty UUID string.
    expect(result.bulkActionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("partial failure — one authorization failure does not abort others (c)", async () => {
    mockReject
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ error: "No tenés acceso a esta organización." })
      .mockResolvedValueOnce({ ok: true });

    const result = await bulkRejectAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: IDS,
      reason: "No cumple los requisitos de la organización",
    });

    expect(result.succeeded).toEqual(["app-evt-1", "app-evt-3"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      id: "app-evt-2",
      reason: "No tenés acceso a esta organización.",
    });
    expect(mockReject).toHaveBeenCalledTimes(3);
  });

  it("partial failure — thrown errors captured, batch continues (c)", async () => {
    mockReject
      .mockRejectedValueOnce(new Error("Connection reset"))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    const result = await bulkRejectAdoptionApplicationsAction({
      orgToken: ORG_TOKEN,
      applicationEventIds: IDS,
      reason: "No cumple los requisitos de la organización",
    });

    expect(result.succeeded).toEqual(["app-evt-2", "app-evt-3"]);
    expect(result.failed[0]).toMatchObject({ id: "app-evt-1", reason: "Connection reset" });
  });
});
