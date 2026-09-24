// Use-case test: createMicrochip
//
// RED → GREEN TDD. Tests cover:
//   - Happy path: idempotent insert + canonical insertIdentification when pet has no chip.
//   - Replay / noop: wasNoop=true → insertIdentification NOT called, attachment skipped.
//   - Same chip re-submitted: event appended, canonical NOT rewritten (re-sync).
//   - Different chip: REJECTED before the event is appended.
//   - Attachment: uploaded path triggers insertAttachment.
//   - Auth parity: requireAlivePetAccess is the guard (tested in actions layer;
//     use-case itself is auth-agnostic by design).
//   - ARCH-R: updateMicrochipBackfill removed; legacy pets.microchipId no longer written.
//   - ARCH-S: pet.microchipId field replaced by pet.canonicalChipNumber: string | null.
//
// WHAT THE OLD "canonical skip" TEST ASSERTED, AND WHY IT WAS A LIE
// ---------------------------------------------------------------------------
// One test used to stand here named "skips canonical write when pet already has
// a canonical chip (petHasCanonicalChip=true)". It fed the pet a boolean, fed
// the use-case chip 985121025800001, and asserted:
//
//     expect(repo.insertEventIdempotent).toHaveBeenCalledOnce();
//     expect(repo.insertIdentification).not.toHaveBeenCalled();
//
// Read against the boolean, that looks like prudence: don't overwrite a chip
// that is already there. But a boolean cannot tell "the same chip, submitted
// twice" from "a DIFFERENT chip". The test only ever exercised the first
// reading while the production callers hit both — so what it actually froze as
// contract was: a verified vet may append `microchip_implanted { chip B }` to
// the append-only spine of a pet whose credential says chip A, and the write
// succeeds with nothing written, nothing flagged, nobody told. The credential
// asserts an identity its own log contradicts, which is the one thing the pet-
// is-the-credential invariant exists to prevent.
//
// It is replaced by the two tests the boolean was hiding: same chip → re-sync
// (the behaviour that test believed it was protecting), different chip →
// rejected before anything reaches the spine.

import { CHIP_CONFLICTS_WITH_CANONICAL_ERROR } from "@/lib/domain/microchip-validation";
import { describe, expect, it, vi } from "vitest";
import type { EventsRepository } from "../../infrastructure/events-repository";
import { createMicrochip } from "./microchip-use-case";

// ---------------------------------------------------------------------------
// Minimal mock factory
// ---------------------------------------------------------------------------

function makeRepo(
  overrides: Partial<EventsRepository> = {},
): Pick<EventsRepository, "insertEventIdempotent" | "insertAttachment" | "insertIdentification"> {
  return {
    insertEventIdempotent: vi.fn().mockResolvedValue({
      event: { id: "ev-1" },
      wasNoop: false,
    }),
    insertAttachment: vi.fn().mockResolvedValue(undefined),
    insertIdentification: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTx() {
  return <T>(cb: (tx: unknown) => Promise<T>) => cb({} as unknown);
}

const CHIP_ON_RECORD = "985121025800001";
const A_DIFFERENT_CHIP = "985121025809999";

const BASE_INPUT = {
  // ARCH-S: microchipId replaced by the canonical chip code (pre-resolved from
  // pet_identifications by the caller). null = the pet carries no chip yet.
  pet: { id: "pet-1", canonicalChipNumber: null as string | null },
  user: { id: "user-1" },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  chipNumber: CHIP_ON_RECORD,
  countryCode: "AR",
  implantedBy: "Dr. García",
  locationOnBody: "interscapular",
  occurredAt: new Date("2024-01-15"),
  notes: null,
  uploadedPath: null,
  uploadedMimeType: null,
  uploadedSize: null,
  clientIdempotencyKey: "key-1",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMicrochip", () => {
  it("inserts the event and writes canonical identification when pet has no chip", async () => {
    const repo = makeRepo();
    const result = await createMicrochip(BASE_INPUT, { repo, transaction: makeTx() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.eventId).toBe("ev-1");

    expect(repo.insertEventIdempotent).toHaveBeenCalledOnce();
    const [insertArg] = (repo.insertEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(insertArg.eventType).toBe("microchip_implanted");
    expect(insertArg.petId).toBe("pet-1");
    expect(insertArg.clientIdempotencyKey).toBe("key-1");

    // Canonical row inserted because canonicalChipNumber=null (ARCH-S).
    expect(repo.insertIdentification).toHaveBeenCalledOnce();
    const [identArg] = (repo.insertIdentification as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(identArg.petId).toBe("pet-1");
    expect(identArg.kind).toBe("microchip_iso");
    expect(identArg.code).toBe(CHIP_ON_RECORD);
    expect(identArg.isoCompliant).toBe(true);
  });

  it("re-submitting the chip already on record appends the event and rewrites nothing", async () => {
    const repo = makeRepo();
    const result = await createMicrochip(
      { ...BASE_INPUT, pet: { id: "pet-1", canonicalChipNumber: CHIP_ON_RECORD } },
      { repo, transaction: makeTx() },
    );

    expect(result.ok).toBe(true);
    // The event still lands: a second attestation of the SAME chip is real
    // provenance (a vet confirming what the owner declared), and the spine is
    // append-only.
    expect(repo.insertEventIdempotent).toHaveBeenCalledOnce();
    // Nothing to write canonically — the row already says exactly this.
    expect(repo.insertIdentification).not.toHaveBeenCalled();
  });

  it("compares chips by digits, so separators alone are not a conflict", async () => {
    const repo = makeRepo();
    const result = await createMicrochip(
      {
        ...BASE_INPUT,
        pet: { id: "pet-1", canonicalChipNumber: CHIP_ON_RECORD },
        chipNumber: "985 121-025 800 001",
      },
      { repo, transaction: makeTx() },
    );

    // Same implant, typed with the separators people actually use. Rejecting
    // this would be a false accusation in front of whoever holds the animal.
    expect(result.ok).toBe(true);
    expect(repo.insertIdentification).not.toHaveBeenCalled();
  });

  it("rejects a chip that disagrees with the canonical one, writing NOTHING", async () => {
    const repo = makeRepo();
    const result = await createMicrochip(
      {
        ...BASE_INPUT,
        pet: { id: "pet-1", canonicalChipNumber: CHIP_ON_RECORD },
        chipNumber: A_DIFFERENT_CHIP,
      },
      { repo, transaction: makeTx() },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // Pinned to the exact copy, not just "some error": the message is what
    // routes a genuine chip change to microchip_replaced instead of leaving
    // the person guessing, and a generic assertion would survive it degrading
    // into any other failure string.
    expect(result.error).toBe(CHIP_CONFLICTS_WITH_CANONICAL_ERROR);

    // The whole point. Nothing may reach the append-only spine: an event
    // claiming chip B on a pet whose credential says chip A cannot be retracted
    // once written, and it is exactly what made the divergence silent.
    expect(repo.insertEventIdempotent).not.toHaveBeenCalled();
    expect(repo.insertIdentification).not.toHaveBeenCalled();
    expect(repo.insertAttachment).not.toHaveBeenCalled();
  });

  it("rejects the conflicting chip even when an attachment was uploaded", async () => {
    const repo = makeRepo();
    const result = await createMicrochip(
      {
        ...BASE_INPUT,
        pet: { id: "pet-1", canonicalChipNumber: CHIP_ON_RECORD },
        chipNumber: A_DIFFERENT_CHIP,
        uploadedPath: "path/to/scan.jpg",
        uploadedMimeType: "image/jpeg",
        uploadedSize: 1024,
      },
      { repo, transaction: makeTx() },
    );

    expect(result.ok).toBe(false);
    // The caller cleans the orphaned upload on !ok; the use-case must not
    // attach it to an event it refused to write.
    expect(repo.insertAttachment).not.toHaveBeenCalled();
  });

  it("skips all side-effects on noop replay (wasNoop=true)", async () => {
    const repo = makeRepo({
      insertEventIdempotent: vi.fn().mockResolvedValue({
        event: { id: "ev-1" },
        wasNoop: true,
      }),
    });

    const result = await createMicrochip(BASE_INPUT, { repo, transaction: makeTx() });

    expect(result.ok).toBe(true);
    expect(repo.insertAttachment).not.toHaveBeenCalled();
    expect(repo.insertIdentification).not.toHaveBeenCalled();
  });

  it("inserts attachment when uploadedPath is provided", async () => {
    const repo = makeRepo();
    const result = await createMicrochip(
      {
        ...BASE_INPUT,
        uploadedPath: "path/to/file.jpg",
        uploadedMimeType: "image/jpeg",
        uploadedSize: 1024,
      },
      { repo, transaction: makeTx() },
    );

    expect(result.ok).toBe(true);
    expect(repo.insertAttachment).toHaveBeenCalledOnce();
    const [att] = (repo.insertAttachment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(att.storagePath).toBe("path/to/file.jpg");
    expect(att.petId).toBe("pet-1");
    expect(att.eventId).toBe("ev-1");
  });

  it("does not insert attachment when uploadedPath is null", async () => {
    const repo = makeRepo();
    await createMicrochip(BASE_INPUT, { repo, transaction: makeTx() });
    expect(repo.insertAttachment).not.toHaveBeenCalled();
  });

  it("returns ok:true with notifications:[] on success", async () => {
    const repo = makeRepo();
    const result = await createMicrochip(BASE_INPUT, { repo, transaction: makeTx() });
    expect(result).toMatchObject({ ok: true, notifications: [] });
  });
});
