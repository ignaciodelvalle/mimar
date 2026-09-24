// Use-case test: createClinicalInfo
//
// RED → GREEN TDD. Tests cover:
//   - Happy path: idempotent insert with sub_kind enum.
//   - Replay / noop: wasNoop=true → attachment skipped.
//   - Attachment: uploaded path triggers insertAttachment.
//   - Sub_kind validation: use-case trusts caller validation (caller validates
//     sub_kind ∈ CLINICAL_SUB_KINDS before calling use-case).
//   - Per-event jurisdiction fields embedded in payload.

import { describe, expect, it, vi } from "vitest";
import type { EventsRepository } from "../../infrastructure/events-repository";
import { createClinicalInfo } from "./clinical-info-use-case";

function makeRepo(
  overrides: Partial<EventsRepository> = {},
): Pick<EventsRepository, "insertEventIdempotent" | "insertAttachment"> {
  return {
    insertEventIdempotent: vi.fn().mockResolvedValue({ event: { id: "ev-2" }, wasNoop: false }),
    insertAttachment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTx() {
  return <T>(cb: (tx: unknown) => Promise<T>) => cb({} as unknown);
}

const BASE_INPUT = {
  pet: { id: "pet-2" },
  user: { id: "user-2" },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  subKind: "lab_work" as const,
  title: "Hemograma completo",
  details: "Leucocitos 8000",
  performedBy: "Lab. Central",
  occurredAt: new Date("2024-05-01"),
  notes: null,
  eventJurisdictionProvince: "CABA",
  eventJurisdictionLocality: null,
  uploadedPath: null,
  uploadedMimeType: null,
  uploadedSize: null,
  clientIdempotencyKey: "clinical-key-1",
};

describe("createClinicalInfo", () => {
  it("inserts clinical_info_logged with sub_kind and returns eventId", async () => {
    const repo = makeRepo();
    const result = await createClinicalInfo(BASE_INPUT, { repo, transaction: makeTx() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.eventId).toBe("ev-2");

    const [insertArg] = (repo.insertEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(insertArg.eventType).toBe("clinical_info_logged");
    expect(insertArg.petId).toBe("pet-2");
    expect(insertArg.clientIdempotencyKey).toBe("clinical-key-1");
    expect(insertArg.payload.sub_kind).toBe("lab_work");
    expect(insertArg.payload.title).toBe("Hemograma completo");
    expect(insertArg.payload.jurisdiction_province).toBe("CABA");
    expect(insertArg.payload.jurisdiction_locality).toBeNull();
  });

  it("skips attachment on noop replay", async () => {
    const repo = makeRepo({
      insertEventIdempotent: vi.fn().mockResolvedValue({ event: { id: "ev-2" }, wasNoop: true }),
    });

    const result = await createClinicalInfo(BASE_INPUT, { repo, transaction: makeTx() });

    expect(result.ok).toBe(true);
    expect(repo.insertAttachment).not.toHaveBeenCalled();
  });

  it("inserts attachment when uploadedPath is provided", async () => {
    const repo = makeRepo();
    await createClinicalInfo(
      {
        ...BASE_INPUT,
        uploadedPath: "path/result.pdf",
        uploadedMimeType: "application/pdf",
        uploadedSize: 4096,
      },
      { repo, transaction: makeTx() },
    );

    expect(repo.insertAttachment).toHaveBeenCalledOnce();
    const [att] = (repo.insertAttachment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(att.storagePath).toBe("path/result.pdf");
    expect(att.petId).toBe("pet-2");
  });

  it("returns ok:true with notifications:[] on success", async () => {
    const repo = makeRepo();
    const result = await createClinicalInfo(BASE_INPUT, { repo, transaction: makeTx() });
    expect(result).toMatchObject({ ok: true, notifications: [] });
  });
});
