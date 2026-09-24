// Test: updateLostLastSeen (WU-6 lifecycle)
//
// Regression coverage for the "ACTUALIZAR" dead-end fix: /perdida used to
// unconditionally redirect away whenever status='lost', so LostCaseBlock's
// "actualizar" link (which only renders for status='lost') bounced straight
// back to the profile. See page.tsx + LostCaseBlock.tsx.
//
// Invariants under test:
//   - status !== 'lost' → error, no write (guards against stale form resubmits).
//   - no OPEN lost_pet_episode case → error, no write (episode auto-closed,
//     ADR-18 stale cron — page-level guard can be stale between render/submit).
//   - happy path → note_added event, kind="sighting", scoped to the open
//     case's id, category="otro".
//   - does NOT emit status_changed under any circumstance (append-only
//     invariant — lost→lost is not a real transition).
//   - blank/whitespace-only text falls back to a generic note instead of
//     writing an empty payload.text (schema requires text: string).
//   - clientIdempotencyKey passthrough for idempotent replay.
//   - P4 item 3: the insert runs inside deps.transaction (advisory lock
//     inside insertEventIdempotent requires an active transaction).

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockFindOpenCaseForPetAndKind = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/case-helpers", () => ({
  findOpenCaseForPetAndKind: mockFindOpenCaseForPetAndKind,
}));

const mockValidateEventPayload = vi.hoisted(() => vi.fn());
vi.mock("@/lib/events/event-schemas", () => ({
  validateEventPayload: mockValidateEventPayload,
}));

import type { EventsRepository } from "../../infrastructure/events-repository";
import { updateLostLastSeen } from "./update-lost-last-seen-use-case";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  return {
    insertEventIdempotent: vi.fn().mockResolvedValue({
      event: { id: randomUUID() },
      wasNoop: false,
    }),
  };
}

// P4 item 3: the use-case now wraps the insert in a transaction (advisory
// lock inside insertEventIdempotent requires one) — same fake-tx pattern the
// sibling medical/lifecycle use-case tests already use.
function makeTransaction() {
  return vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb("fake-tx"));
}

function makeDeps(repo: ReturnType<typeof makeRepo>) {
  return {
    repo: repo as unknown as Pick<EventsRepository, "insertEventIdempotent">,
    transaction: makeTransaction(),
  };
}

const petId = randomUUID();
const userId = randomUUID();
const caseId = randomUUID();

const baseParams = {
  petId,
  petStatus: "lost",
  recordedByUserId: userId,
  eventAuthorship: {
    authorRole: "owner" as const,
    authorOrganizationId: null,
    authorVerified: false,
  },
  text: "La vi cerca de la plaza San Martín",
  locationDescription: "Plaza San Martín",
  locationLat: "-34.6037",
  locationLng: "-58.3816",
  clientIdempotencyKey: "update-key-1",
  now: new Date("2026-06-15T10:00:00Z"),
};

describe("updateLostLastSeen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateEventPayload.mockImplementation((_type: string, payload: unknown) => payload);
    mockFindOpenCaseForPetAndKind.mockResolvedValue({ id: caseId });
  });

  it("returns an error and does not write when pet status is not 'lost'", async () => {
    const repo = makeRepo();
    const result = await updateLostLastSeen({ ...baseParams, petStatus: "active" }, makeDeps(repo));

    expect(result.error).toBe("Esta mascota no está marcada como perdida.");
    expect(repo.insertEventIdempotent).not.toHaveBeenCalled();
  });

  it("returns an error and does not write when there is no open lost_pet_episode case", async () => {
    mockFindOpenCaseForPetAndKind.mockResolvedValue(null);
    const repo = makeRepo();
    const result = await updateLostLastSeen(baseParams, makeDeps(repo));

    expect(result.error).toContain("ya no está activa");
    expect(repo.insertEventIdempotent).not.toHaveBeenCalled();
  });

  it("emits a note_added event with kind='sighting' scoped to the open case id", async () => {
    const repo = makeRepo();
    const deps = makeDeps(repo);
    const result = await updateLostLastSeen(baseParams, deps);

    expect(result.error).toBeNull();
    expect(mockFindOpenCaseForPetAndKind).toHaveBeenCalledWith(petId, "lost_pet_episode");
    expect(deps.transaction).toHaveBeenCalledOnce();

    expect(repo.insertEventIdempotent).toHaveBeenCalledOnce();
    const [insertArg, txArg] = repo.insertEventIdempotent.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ];
    expect(insertArg.eventType).toBe("note_added");
    expect(insertArg.petId).toBe(petId);
    expect(insertArg.caseId).toBe(caseId);
    expect(insertArg.locationLat).toBe(baseParams.locationLat);
    expect(insertArg.locationLng).toBe(baseParams.locationLng);
    expect(insertArg.clientIdempotencyKey).toBe("update-key-1");
    // Passed inside the injected transaction callback, not the bare `db`.
    expect(txArg).toBe("fake-tx");

    const payload = insertArg.payload as Record<string, unknown>;
    expect(payload.kind).toBe("sighting");
    expect(payload.category).toBe("otro");
    expect(payload.text).toBe(baseParams.text);
    // The address travels as its own field so fetchLostEpisodeForPet can
    // overlay it as placeName (QA 2026-08-03 last-seen fix).
    expect(payload.location_description).toBe("Plaza San Martín");
  });

  it("never emits a status_changed event (append-only — lost→lost is not a real transition)", async () => {
    const repo = makeRepo();
    await updateLostLastSeen(baseParams, makeDeps(repo));

    const [insertArg] = repo.insertEventIdempotent.mock.calls[0] as [Record<string, unknown>];
    expect(insertArg.eventType).not.toBe("status_changed");
  });

  it("falls back to a generic note when text is blank", async () => {
    const repo = makeRepo();
    await updateLostLastSeen({ ...baseParams, text: "   " }, makeDeps(repo));

    const [insertArg] = repo.insertEventIdempotent.mock.calls[0] as [Record<string, unknown>];
    const payload = insertArg.payload as Record<string, unknown>;
    expect(payload.text).toBe("El dueño actualizó la última ubicación conocida.");
  });

  it("falls back to a generic note when text is null", async () => {
    const repo = makeRepo();
    await updateLostLastSeen({ ...baseParams, text: null }, makeDeps(repo));

    const [insertArg] = repo.insertEventIdempotent.mock.calls[0] as [Record<string, unknown>];
    const payload = insertArg.payload as Record<string, unknown>;
    expect(payload.text).toBe("El dueño actualizó la última ubicación conocida.");
  });

  it("passes null location through when the owner does not drop a pin", async () => {
    const repo = makeRepo();
    await updateLostLastSeen(
      { ...baseParams, locationLat: null, locationLng: null },
      makeDeps(repo),
    );

    const [insertArg] = repo.insertEventIdempotent.mock.calls[0] as [Record<string, unknown>];
    expect(insertArg.locationLat).toBeNull();
    expect(insertArg.locationLng).toBeNull();
  });
});
