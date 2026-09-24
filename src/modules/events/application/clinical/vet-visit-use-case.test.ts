// Use-case test: createVetVisit
//
// RED → GREEN TDD. Tests cover:
//   - Happy path: idempotent insert with per-event jurisdiction fields.
//   - Replay / noop: wasNoop=true → attachment skipped.
//   - Attachment: uploaded path triggers insertAttachment.
//   - Jurisdiction fields (province/locality) embedded in payload.

import { describe, expect, it, vi } from "vitest";
import type { EventsRepository } from "../../infrastructure/events-repository";
import { createVetVisit } from "./vet-visit-use-case";

function makeRepo(
  overrides: Partial<EventsRepository> = {},
): Pick<EventsRepository, "insertEventIdempotent" | "insertAttachment"> {
  return {
    insertEventIdempotent: vi.fn().mockResolvedValue({ event: { id: "ev-1" }, wasNoop: false }),
    insertAttachment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTx() {
  return <T>(cb: (tx: unknown) => Promise<T>) => cb({} as unknown);
}

const BASE_INPUT = {
  pet: { id: "pet-1" },
  user: { id: "user-1" },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  reason: "Control anual",
  occurredAt: new Date("2024-04-10"),
  diagnosis: "Sano",
  vetName: "Dr. López",
  clinic: "Clínica Mascotas",
  notes: "Sin novedades",
  eventJurisdictionProvince: "Buenos Aires",
  eventJurisdictionLocality: "La Plata",
  uploadedPath: null,
  uploadedMimeType: null,
  uploadedSize: null,
  clientIdempotencyKey: "vet-key-1",
};

describe("createVetVisit", () => {
  it("inserts vet_visit_logged with jurisdiction fields and returns eventId", async () => {
    const repo = makeRepo();
    const result = await createVetVisit(BASE_INPUT, { repo, transaction: makeTx() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.eventId).toBe("ev-1");

    const [insertArg] = (repo.insertEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(insertArg.eventType).toBe("vet_visit_logged");
    expect(insertArg.petId).toBe("pet-1");
    expect(insertArg.clientIdempotencyKey).toBe("vet-key-1");
    expect(insertArg.payload.reason).toBe("Control anual");
    expect(insertArg.payload.jurisdiction_province).toBe("Buenos Aires");
    expect(insertArg.payload.jurisdiction_locality).toBe("La Plata");
  });

  it("skips attachment on noop replay", async () => {
    const repo = makeRepo({
      insertEventIdempotent: vi.fn().mockResolvedValue({ event: { id: "ev-1" }, wasNoop: true }),
    });

    const result = await createVetVisit(BASE_INPUT, { repo, transaction: makeTx() });

    expect(result.ok).toBe(true);
    expect(repo.insertAttachment).not.toHaveBeenCalled();
  });

  it("inserts attachment when uploadedPath is provided", async () => {
    const repo = makeRepo();
    await createVetVisit(
      {
        ...BASE_INPUT,
        uploadedPath: "path/receipt.jpg",
        uploadedMimeType: "image/jpeg",
        uploadedSize: 800,
      },
      { repo, transaction: makeTx() },
    );

    expect(repo.insertAttachment).toHaveBeenCalledOnce();
    const [att] = (repo.insertAttachment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(att.storagePath).toBe("path/receipt.jpg");
    expect(att.petId).toBe("pet-1");
  });

  it("omits jurisdiction fields when null", async () => {
    const repo = makeRepo();
    await createVetVisit(
      { ...BASE_INPUT, eventJurisdictionProvince: null, eventJurisdictionLocality: null },
      { repo, transaction: makeTx() },
    );

    const [insertArg] = (repo.insertEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(insertArg.payload.jurisdiction_province).toBeNull();
    expect(insertArg.payload.jurisdiction_locality).toBeNull();
  });

  it("returns ok:true with notifications:[] on success", async () => {
    const repo = makeRepo();
    const result = await createVetVisit(BASE_INPUT, { repo, transaction: makeTx() });
    expect(result).toMatchObject({ ok: true, notifications: [] });
  });
});
