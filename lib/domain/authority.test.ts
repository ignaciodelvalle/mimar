// Unit tests for lib/domain/authority.ts — the honest authority-signal seam.
//
// G7 (2026-08-02): signalAuthorityReport used to be a SILENT void no-op — a
// reportable-disease death left no durable trace that an external
// transmission was still owed. These tests pin the new contract:
//   - a pending-transmission audit_log record is written (v1_noop replay
//     marker, same convention as lib/infra/outbox-drainer.ts), and
//   - the returned marker is honest: delivered stays false until a real
//     SNVS 2.0 endpoint exists, and the result NEVER fabricates delivery.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuditValues = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/db", () => ({
  db: { insert: vi.fn(() => ({ values: mockAuditValues })) },
  auditLog: {},
}));

import {
  AUTHORITY_TARGET_SNVS,
  notifyOutbreakInvestigationOpened,
  signalAuthorityReport,
} from "@/lib/domain/authority";

const baseInput = {
  eventId: "11111111-1111-1111-1111-111111111111",
  petId: "22222222-2222-2222-2222-222222222222",
  diseaseCode: "rabies_confirmed",
  confirmedByLab: true,
  occurredAt: new Date("2026-08-01T12:00:00Z"),
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "La Plata",
  reportedByUserId: "33333333-3333-3333-3333-333333333333",
};

beforeEach(() => {
  mockAuditValues.mockClear();
  mockAuditValues.mockResolvedValue(undefined);
});

describe("signalAuthorityReport", () => {
  it("returns the honest marker instead of a silent void (fails against pre-G7 code)", async () => {
    const result = await signalAuthorityReport(baseInput);
    // Pre-G7 the function resolved to undefined — asserting the marker shape
    // is the bidirectional guard.
    expect(result).toEqual({
      delivered: false,
      v1_noop: true,
      target: AUTHORITY_TARGET_SNVS,
      auditRecorded: true,
    });
  });

  it("never claims external delivery", async () => {
    const result = await signalAuthorityReport(baseInput);
    expect(result.delivered).toBe(false);
    expect(result.v1_noop).toBe(true);
  });

  it("durably records the pending obligation with the outbox-drainer replay-marker convention", async () => {
    await signalAuthorityReport(baseInput);

    expect(mockAuditValues).toHaveBeenCalledTimes(1);
    const row = mockAuditValues.mock.calls[0][0] as {
      actorUserId: string | null;
      action: string;
      payload: Record<string, unknown>;
    };
    expect(row.action).toBe("eno_notification_emitted");
    expect(row.actorUserId).toBe(baseInput.reportedByUserId);
    expect(row.payload).toEqual(
      expect.objectContaining({
        kind: "authority_report",
        source_event_id: baseInput.eventId,
        pet_id: baseInput.petId,
        disease_code: "rabies_confirmed",
        confirmed_by_lab: true,
        jurisdiction_province: "Buenos Aires",
        jurisdiction_locality: "La Plata",
        target: AUTHORITY_TARGET_SNVS,
        v1_noop: true,
        pending_transmission: true,
      }),
    );
  });

  it("tolerates a missing actor (audit_log.actor_user_id is nullable)", async () => {
    const { reportedByUserId: _omitted, ...withoutActor } = baseInput;
    await signalAuthorityReport(withoutActor);
    const row = mockAuditValues.mock.calls[0][0] as { actorUserId: string | null };
    expect(row.actorUserId).toBeNull();
  });

  it("never throws when the audit write fails — reports auditRecorded: false instead", async () => {
    mockAuditValues.mockRejectedValueOnce(new Error("db down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await signalAuthorityReport(baseInput);

    expect(result).toEqual(
      expect.objectContaining({ delivered: false, v1_noop: true, auditRecorded: false }),
    );
    errorSpy.mockRestore();
  });
});

describe("notifyOutbreakInvestigationOpened", () => {
  it("keeps the honest v1_noop marker and now names the decided target", async () => {
    const result = await notifyOutbreakInvestigationOpened({
      casePublicCode: "BRO-2026-0001",
      caseId: "44444444-4444-4444-4444-444444444444",
      diseaseCode: "rabies_confirmed",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      openedByUserId: "33333333-3333-3333-3333-333333333333",
    });

    expect(result.delivered).toBe(false);
    expect(result.v1_noop).toBe(true);
    expect(result.target).toBe(AUTHORITY_TARGET_SNVS);
  });
});
