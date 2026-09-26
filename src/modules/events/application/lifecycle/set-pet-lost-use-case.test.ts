// Test: setPetLostWriter (WU-6 lifecycle)
//
// TDD RED phase — tests written BEFORE implementation.
// Parity contract: byte-for-byte behavior vs app/actions/events.ts::setPetLostWriter.
//
// Invariants under test:
//   - status=lost → error "ya perdida" (guard).
//   - status=deceased → error "no se puede" (guard).
//   - PLAIN insert of status_changed event with disclosure_prefs_snapshot + optional lost_description.
//   - pets projection: status=lost + 5 disclosure cols + optional color/distinguishingFeatures.
//   - openCase called for lost_pet_episode BEFORE status_changed insert.
//   - Retroactive microchip: if validatedRetroChipId && !canonicalIds.microchip → insert microchip_implanted + insertIdentification.
//     ARCH-S: guard reads from fetchActiveIdentifications (canonical), not legacy petMicrochipId param.
//   - Retroactive tattoo: if tattooCode && !canonicalIds.tattoo → insert tattoo_recorded + insertIdentification.
//     ARCH-S: guard reads from fetchActiveIdentifications (canonical), not legacy petTattooCode param.
//   - ARCH-R: updateMicrochipBackfill removed; canonical rows via insertIdentification only.
//   - INVALID_MICROCHIP_FORMAT returned BEFORE any DB write.
//   - broadcastLostPet called post-tx (best-effort) when petPublicToken provided.
//   - Result: { error: null } on success.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockValidateMicrochipId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domain/microchip-validation", () => ({
  validateMicrochipId: mockValidateMicrochipId,
}));

const mockNormalizeTattooCode = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/tattoo-lookup", () => ({
  normalizeTattooCode: mockNormalizeTattooCode,
}));

const mockWritePoint = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domain/location", () => ({
  writePoint: mockWritePoint,
}));

const mockOpenCase = vi.hoisted(() => vi.fn());
const mockCloseCase = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/case-helpers", () => ({
  openCase: mockOpenCase,
  closeCase: mockCloseCase,
  findOpenCaseForPetAndKind: vi.fn(),
}));

const mockBroadcastLostPet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/lost-pet-broadcast", () => ({
  broadcastLostPet: mockBroadcastLostPet,
}));

const mockValidateEventPayload = vi.hoisted(() => vi.fn());
vi.mock("@/lib/events/event-schemas", () => ({
  validateEventPayload: mockValidateEventPayload,
}));

// ARCH-S: fetchActiveIdentifications replaces legacy petMicrochipId / petTattooCode params.
const mockFetchActiveIdentifications = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: mockFetchActiveIdentifications,
}));

import type { EventsRepository } from "../../infrastructure/events-repository";
import { setPetLostWriter } from "./set-pet-lost-use-case";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  return {
    insertEvent: vi.fn().mockResolvedValue({ id: randomUUID() }),
    updatePetLostProjection: vi.fn().mockResolvedValue(undefined),
    insertIdentification: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTransaction() {
  return vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
}

const petId = randomUUID();
const userId = randomUUID();
const caseId = randomUUID();

const baseDisclosurePrefs = {
  discloseFirstNameWhenLost: true,
  disclosePhoneWhenLost: false,
  discloseEmailWhenLost: true,
  discloseLastLocationWhenLost: false,
  allowFinderFormWhenLost: true,
};

const baseParams = {
  petId,
  petPublicToken: "abc123",
  petName: "Rex",
  petStatus: "active",
  petSpecies: "dog",
  petBreed: "Labrador",
  petColor: "yellow",
  petJurisdictionProvince: "Buenos Aires",
  petJurisdictionLocality: "La Plata",
  ownerUserId: userId,
  ownerDisplayName: "Jane Doe",
  fromStatus: "active",
  recordedByUserId: userId,
  eventAuthorship: {
    authorRole: "owner" as const,
    authorOrganizationId: null,
    authorVerified: false,
  },
  locationDescription: null as string | null,
  locationLat: null as string | null,
  locationLng: null as string | null,
  reason: null as string | null,
  disclosurePrefs: baseDisclosurePrefs,
  enrichedDescription: null as null | {
    color: string | null;
    distinguishingFeatures: string | null;
    accessoriesWhenLost: string | null;
    behaviorNotes: string | null;
    lastSeenContext: string | null;
    microchipId: string | null;
    tattooCode?: string | null;
    tattooLocation?: string | null;
    tattooDescription?: string | null;
  },
  now: new Date("2026-06-01T12:00:00Z"),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setPetLostWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWritePoint.mockReturnValue({ locationLat: null, locationLng: null });
    mockOpenCase.mockResolvedValue({ id: caseId });
    mockValidateEventPayload.mockImplementation((_type: string, payload: unknown) => payload);
    mockBroadcastLostPet.mockResolvedValue(undefined);
  });

  it("returns error when pet is already lost", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    const result = await setPetLostWriter(
      { ...baseParams, petStatus: "lost" },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "updatePetLostProjection" | "insertIdentification"
        >,
        transaction: tx,
        broadcastLostPet: mockBroadcastLostPet,
      },
    );
    expect(result.error).toContain("perdida");
    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it("returns error when pet is deceased", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    const result = await setPetLostWriter(
      { ...baseParams, petStatus: "deceased" },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "updatePetLostProjection" | "insertIdentification"
        >,
        transaction: tx,
        broadcastLostPet: mockBroadcastLostPet,
      },
    );
    expect(result.error).toContain("fallecida");
    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it("returns INVALID_MICROCHIP_FORMAT before any DB write when chip is invalid", async () => {
    mockValidateMicrochipId.mockReturnValue({ ok: false });
    const repo = makeRepo();
    const tx = makeTransaction();
    const result = await setPetLostWriter(
      {
        ...baseParams,
        enrichedDescription: {
          color: null,
          distinguishingFeatures: null,
          accessoriesWhenLost: null,
          behaviorNotes: null,
          lastSeenContext: null,
          microchipId: "BAD",
        },
      },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "updatePetLostProjection" | "insertIdentification"
        >,
        transaction: tx,
        broadcastLostPet: mockBroadcastLostPet,
      },
    );
    expect(result.error).toBe("INVALID_MICROCHIP_FORMAT");
    expect(tx).not.toHaveBeenCalled();
  });

  describe("the case is opened WHERE IT HAPPENED, not where the animal lives", () => {
    // THE PRODUCT DECISION UNDER TEST, and it is the same one the bite work
    // unit settled: a dog that disappears in Córdoba while registered in CABA is
    // Córdoba's problem. The pair decides which jurisdiction OWNS the case and
    // which organisations get the alert — the lost listings still scope on the
    // pet's own columns, which the writer's docblock measures and names.
    //
    // Until 2026-09-11 `openCase` read `petJurisdiction*` unconditionally, so
    // EVERY lost case in the system claimed the animal's home address.

    async function run(params: Record<string, unknown>) {
      const repo = makeRepo();
      await setPetLostWriter({ ...baseParams, ...params } as typeof baseParams, {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "updatePetLostProjection" | "insertIdentification"
        >,
        transaction: makeTransaction(),
        broadcastLostPet: mockBroadcastLostPet,
      });
      const [caseArg] = mockOpenCase.mock.calls[0] as [Record<string, unknown>, unknown];
      return {
        province: caseArg.jurisdictionProvince,
        locality: caseArg.jurisdictionLocality,
        localityId: caseArg.localityId ?? null,
      };
    }

    it("uses the jurisdiction of the disappearance when it is given", async () => {
      expect(
        await run({
          eventJurisdictionProvince: "Córdoba",
          eventJurisdictionLocality: "Villa Carlos Paz",
        }),
      ).toEqual({ province: "Córdoba", locality: "Villa Carlos Paz", localityId: null });
    });

    // localidades-por-id A1: the catalogue row travels with the place it names.
    it("stamps the case with the incident's catalogue row, and only with it", async () => {
      expect(
        await run({
          eventJurisdictionProvince: "Córdoba",
          eventJurisdictionLocality: "Villa Carlos Paz",
          eventLocalityId: "loc-vcp",
        }),
      ).toEqual({ province: "Córdoba", locality: "Villa Carlos Paz", localityId: "loc-vcp" });
      mockOpenCase.mockClear();
      // The home fallback carries no id from here: the id names the INCIDENT.
      expect(await run({ eventLocalityId: "loc-vcp" })).toEqual({
        province: "Buenos Aires",
        locality: "La Plata",
        localityId: null,
      });
    });

    it("falls back to the animal's home jurisdiction when nobody said", async () => {
      // "No sé exactamente dónde" is a real answer from somebody in a panic, and
      // the fallback is defined behaviour rather than a hole.
      expect(await run({})).toEqual({
        province: "Buenos Aires",
        locality: "La Plata",
        localityId: null,
      });
    });

    it("sends the ALERT to where it was lost, not to where the animal lives", async () => {
      // THE HALF THE FIRST VERSION FORGOT, and forgetting it was worse than
      // changing nothing: the case moved to Córdoba while `broadcastLostPet`
      // still got `null` for `lastLocation`, so it fell back to the pet's home
      // pair and told CABA. A Córdoba official would have held a case that no
      // Córdoba rescue organisation was ever alerted to, and nobody near the
      // animal would go and look.
      const repo = makeRepo();
      await setPetLostWriter(
        {
          ...baseParams,
          eventJurisdictionProvince: "Córdoba",
          eventJurisdictionLocality: "Villa Carlos Paz",
        } as typeof baseParams,
        {
          repo: repo as unknown as Pick<
            EventsRepository,
            "insertEvent" | "updatePetLostProjection" | "insertIdentification"
          >,
          transaction: makeTransaction(),
          broadcastLostPet: mockBroadcastLostPet,
        },
      );
      // `broadcastLostPet(db, pet, owner, lastLocation, opts)` — the fourth
      // argument is the override the fan-out reads before the pet's own pair.
      const lastLocation = mockBroadcastLostPet.mock.calls[0]?.[3];
      // localityId null: the incident place carried no catalogue id, so on the
      // id path it is unresolved (localidades-por-id D5).
      expect(lastLocation).toEqual({
        province: "Córdoba",
        locality: "Villa Carlos Paz",
        localityId: null,
      });
    });

    it("the alert carries the incident's catalogue row when it resolved (D5)", async () => {
      const repo = makeRepo();
      const LOCALITY_ID = "b0000000-0000-4000-8000-0000000000d5";
      await setPetLostWriter(
        {
          ...baseParams,
          eventJurisdictionProvince: "Córdoba",
          eventJurisdictionLocality: "Villa Carlos Paz",
          eventLocalityId: LOCALITY_ID,
        } as typeof baseParams,
        {
          repo: repo as unknown as Pick<
            EventsRepository,
            "insertEvent" | "updatePetLostProjection" | "insertIdentification"
          >,
          transaction: makeTransaction(),
          broadcastLostPet: mockBroadcastLostPet,
        },
      );
      expect(mockBroadcastLostPet.mock.calls.at(-1)?.[3]).toEqual({
        province: "Córdoba",
        locality: "Villa Carlos Paz",
        localityId: LOCALITY_ID,
      });
    });

    // localidades-por-id A8: the status_changed event keeps where it was lost,
    // as entered and as resolved — the case's pair alone says neither.
    it("keeps the incident's place on the status_changed payload", async () => {
      const repo = makeRepo();
      const place = {
        entered: { province: "AR-X", locality: "Villa María", indec_id: "14042170" },
        resolved: {
          locality_id: "00000000-0000-4000-8000-0000000014e2",
          province_code: "AR-X",
          method: "indec_id" as const,
        },
      };
      await setPetLostWriter(
        {
          ...baseParams,
          eventJurisdictionProvince: "Córdoba",
          eventJurisdictionLocality: "Villa María",
          eventPlace: place,
        } as typeof baseParams,
        {
          repo: repo as unknown as Pick<
            EventsRepository,
            "insertEvent" | "updatePetLostProjection" | "insertIdentification"
          >,
          transaction: makeTransaction(),
          broadcastLostPet: mockBroadcastLostPet,
        },
      );
      const [insertArg] = repo.insertEvent.mock.calls[0] as [{ payload: Record<string, unknown> }];
      expect(insertArg.payload.place).toEqual(place);
    });

    // Stage A review, BLOCKER 2: a report that carried a pin no province could
    // be read from is UNRESOLVED — the case has no jurisdiction and no alert
    // goes to the animal's home.
    it("an unresolved pin is never filed, or broadcast, at the animal's home", async () => {
      expect(
        await run({
          eventPlace: {
            entered: { province: null, locality: null, indec_id: null },
            resolved: null,
            candidates: ["00000000-0000-4000-8000-0000000000c1"],
          },
        }),
      ).toEqual({
        province: null,
        locality: null,
        localityId: null,
      });
      const lastLocation = mockBroadcastLostPet.mock.calls.at(-1)?.[3];
      expect(lastLocation).toEqual({ province: null, locality: null });
    });

    it("never falls back field by field", async () => {
      // THE ASSERTION THAT EARNS ITS KEEP. A province with no locality must not
      // produce (Córdoba, La Plata) — a place that does not exist, on a record
      // an authority acts on, that nothing downstream would notice.
      //
      // Since localidades-por-id A1 it is a PROVINCE-LEVEL case instead: the
      // web's map now resolves where the animal went missing, and a pin whose
      // locality cannot be named honestly (a homonym, a geocoder that said only
      // the province) still says which province. Córdoba's authority sees it;
      // the animal's home is not where it was lost.
      expect(await run({ eventJurisdictionProvince: "Córdoba" })).toEqual({
        province: "Córdoba",
        locality: null,
        localityId: null,
      });
      mockOpenCase.mockClear();
      // A locality with no province names nowhere to route: the home pair,
      // whole — never (home province, Villa Carlos Paz).
      expect(await run({ eventJurisdictionLocality: "Villa Carlos Paz" })).toEqual({
        province: "Buenos Aires",
        locality: "La Plata",
        localityId: null,
      });
    });
  });

  it("inserts status_changed and updates pets projection on success", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    const result = await setPetLostWriter(baseParams, {
      repo: repo as unknown as Pick<
        EventsRepository,
        "insertEvent" | "updatePetLostProjection" | "insertIdentification"
      >,
      transaction: tx,
      broadcastLostPet: mockBroadcastLostPet,
    });

    expect(result).toEqual({ error: null });

    // openCase called
    expect(mockOpenCase).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "lost_pet_episode" }),
      expect.anything(),
    );

    // status_changed inserted once
    expect(repo.insertEvent).toHaveBeenCalledTimes(1);
    const [insertArg] = repo.insertEvent.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(insertArg.eventType).toBe("status_changed");
    expect(insertArg.caseId).toBe(caseId);

    // projection updated
    expect(repo.updatePetLostProjection).toHaveBeenCalledTimes(1);
    const [projArg] = repo.updatePetLostProjection.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Date,
      unknown,
    ];
    expect(projArg).toBe(petId);
  });

  it("inserts microchip_implanted + canonical identification when retroactive chip provided and pet had none", async () => {
    const normalizedChip = "982000123456789";
    mockValidateMicrochipId.mockReturnValue({ ok: true, normalized: normalizedChip });
    // ARCH-S: use-case fetches canonical ids internally; mock to return no chip.
    mockFetchActiveIdentifications.mockResolvedValue({ microchip: null, tattoo: null });

    const repo = makeRepo();
    const tx = makeTransaction();
    const result = await setPetLostWriter(
      {
        ...baseParams,
        enrichedDescription: {
          color: null,
          distinguishingFeatures: null,
          accessoriesWhenLost: null,
          behaviorNotes: null,
          lastSeenContext: null,
          microchipId: normalizedChip,
        },
      },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "updatePetLostProjection" | "insertIdentification"
        >,
        transaction: tx,
        broadcastLostPet: mockBroadcastLostPet,
      },
    );

    expect(result).toEqual({ error: null });

    // status_changed + microchip_implanted = 2 inserts
    expect(repo.insertEvent).toHaveBeenCalledTimes(2);
    const calls = repo.insertEvent.mock.calls as [Record<string, unknown>, unknown][];
    const microchipCall = calls.find(([arg]) => arg.eventType === "microchip_implanted");
    expect(microchipCall).toBeDefined();

    // Canonical identification inserted (ARCH-R: legacy pets.microchipId backfill removed).
    expect(repo.insertIdentification).toHaveBeenCalledTimes(1);
  });

  it("skips retroactive microchip when pet already has a chip", async () => {
    const normalizedChip = "982000123456789";
    mockValidateMicrochipId.mockReturnValue({ ok: true, normalized: normalizedChip });
    // ARCH-S: mock canonical read to simulate a pet that already has a chip.
    mockFetchActiveIdentifications.mockResolvedValue({
      microchip: { code: "existing-chip", recordedAt: null },
      tattoo: null,
    });

    const repo = makeRepo();
    const tx = makeTransaction();
    await setPetLostWriter(
      {
        ...baseParams,
        enrichedDescription: {
          color: null,
          distinguishingFeatures: null,
          accessoriesWhenLost: null,
          behaviorNotes: null,
          lastSeenContext: null,
          microchipId: normalizedChip,
        },
      },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "updatePetLostProjection" | "insertIdentification"
        >,
        transaction: tx,
        broadcastLostPet: mockBroadcastLostPet,
      },
    );

    // Only status_changed, no microchip
    expect(repo.insertEvent).toHaveBeenCalledTimes(1);
    expect(repo.insertIdentification).not.toHaveBeenCalled();
  });

  it("inserts tattoo_recorded when retroactive tattoo provided and pet had none", async () => {
    const normalizedTattoo = "ABC-123";
    mockNormalizeTattooCode.mockReturnValue(normalizedTattoo);
    // ARCH-S: mock canonical read to simulate a pet with no tattoo.
    mockFetchActiveIdentifications.mockResolvedValue({ microchip: null, tattoo: null });

    const repo = makeRepo();
    const tx = makeTransaction();
    await setPetLostWriter(
      {
        ...baseParams,
        enrichedDescription: {
          color: null,
          distinguishingFeatures: null,
          accessoriesWhenLost: null,
          behaviorNotes: null,
          lastSeenContext: null,
          microchipId: null,
          tattooCode: "abc-123",
          tattooLocation: "inner_ear_left",
          tattooDescription: "Blue tattoo",
        },
      },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "updatePetLostProjection" | "insertIdentification"
        >,
        transaction: tx,
        broadcastLostPet: mockBroadcastLostPet,
      },
    );

    const calls = repo.insertEvent.mock.calls as [Record<string, unknown>, unknown][];
    const tattooCall = calls.find(([arg]) => arg.eventType === "tattoo_recorded");
    expect(tattooCall).toBeDefined();
  });

  it("calls broadcastLostPet post-tx when petPublicToken is provided", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    await setPetLostWriter(baseParams, {
      repo: repo as unknown as Pick<
        EventsRepository,
        "insertEvent" | "updatePetLostProjection" | "insertIdentification"
      >,
      transaction: tx,
      broadcastLostPet: mockBroadcastLostPet,
    });
    expect(mockBroadcastLostPet).toHaveBeenCalledTimes(1);
  });

  it("does NOT broadcast when petPublicToken is empty", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    await setPetLostWriter(
      { ...baseParams, petPublicToken: "" },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "updatePetLostProjection" | "insertIdentification"
        >,
        transaction: tx,
        broadcastLostPet: mockBroadcastLostPet,
      },
    );
    expect(mockBroadcastLostPet).not.toHaveBeenCalled();
  });
});
