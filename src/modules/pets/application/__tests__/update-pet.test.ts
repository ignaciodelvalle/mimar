// Unit tests for the UpdatePet use-case.
//
// Uses a fake PetsRepository — no DB, no Next.js.
// Covers: no-op short-circuit, flag-only (no event), content diff event,
// becamePPP owner queues / org suppresses, chipNewlyAdded, rollback.
//
// TDD cycle: RED written before update-pet.ts exists.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExistingCanonicalIds, ExistingPetSnapshot } from "../../domain/pet-diff";
import type { ParsedPet, UpdatePetInput } from "../../domain/types";
import type { PetsRepository } from "../../infrastructure/pets-repository";

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------

function makeFakeRepo(overrides?: Partial<typeof PetsRepository>): typeof PetsRepository {
  return {
    generatePublicToken: vi.fn().mockResolvedValue("DIM-TEST-0001"),
    insertPetRegistered: vi
      .fn()
      .mockResolvedValue({ petId: "pet-uuid-1", eventId: "event-uuid-1" }),
    updatePetProfile: vi.fn().mockResolvedValue({ eventId: "event-uuid-update-1" }),
    ...overrides,
  } as unknown as typeof PetsRepository;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExistingPet(overrides?: Partial<ExistingPetSnapshot>): ExistingPetSnapshot {
  return {
    name: "Luna",
    species: "perro",
    sex: "female",
    breed: "labrador",
    dateOfBirth: "2022-01-01",
    color: "negro",
    estimatedWeightKg: null,
    favouriteFoods: null,
    knownAllergies: null,
    trainingLevel: null,
    potentiallyDangerousBreed: false,
    insuranceCompany: null,
    insurancePolicyNumber: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    acquisitionMethod: "adopted",
    permanentConditions: [],
    permanentConditionsOther: null,
    discloseConditionsPublicly: false,
    emergencyInfoVisible: false,
    ...overrides,
  };
}

function makeParsedPet(overrides?: Partial<ParsedPet>): ParsedPet {
  return {
    name: "Luna",
    species: "perro",
    sex: "female",
    breed: "labrador",
    dateOfBirth: "2022-01-01",
    birthDateIsEstimated: false,
    color: "negro",
    microchipId: null,
    microchipCountryCode: null,
    microchipImplantedAt: null,
    microchipImplantedBy: null,
    microchipLocation: null,
    estimatedWeightKg: null,
    favouriteFoods: [],
    knownAllergies: [],
    trainingLevel: null,
    insuranceCompany: null,
    insurancePolicyNumber: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    acquisitionMethod: "adopted",
    emergencyInfoVisible: false,
    permanentConditions: [],
    permanentConditionsOther: null,
    discloseConditionsPublicly: false,
    custodyKind: "owner",
    ...overrides,
  };
}

function makeInput(overrides?: Partial<UpdatePetInput>): UpdatePetInput {
  return {
    petId: "pet-uuid-existing",
    parsed: makeParsedPet(),
    potentiallyDangerousBreed: false,
    uploadedPath: null,
    uploadMimeType: null,
    uploadSize: null,
    ...overrides,
  };
}

type EventAuthorship = {
  authorRole: "owner" | "scanner" | "finder" | "vet" | "shelter" | "govt" | "system";
  authorOrganizationId: string | null;
  authorVerified: boolean;
};

function makeActor(overrides?: {
  accessPath?: "owner" | "org";
  eventAuthorship?: Partial<EventAuthorship>;
  existingCanonicalIds?: Partial<ExistingCanonicalIds>;
}): {
  user: { id: string };
  accessPath: "owner" | "org";
  eventAuthorship: EventAuthorship;
  existingPet: ExistingPetSnapshot;
  existingCanonicalIds: ExistingCanonicalIds;
} {
  const authorship: EventAuthorship = {
    authorRole: "owner",
    authorOrganizationId: null,
    authorVerified: false,
    ...overrides?.eventAuthorship,
  };
  return {
    user: { id: "user-1" },
    accessPath: (overrides?.accessPath ?? "owner") as "owner" | "org",
    eventAuthorship: authorship,
    existingPet: makeExistingPet(),
    existingCanonicalIds: { hasMicrochip: false, ...overrides?.existingCanonicalIds },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updatePet", () => {
  let updatePet: typeof import("../update-pet").updatePet;

  beforeEach(async () => {
    const mod = await import("../update-pet");
    updatePet = mod.updatePet;
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("no-op short-circuit", () => {
    it("returns ok:true without calling updatePetProfile when nothing changed", async () => {
      const repo = makeFakeRepo();
      const result = await updatePet(makeInput(), {
        repo,
        actor: makeActor(),
        transaction: async (cb) => await cb({} as never),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.notifications).toHaveLength(0);
      expect(repo.updatePetProfile).not.toHaveBeenCalled();
    });
  });

  describe("flag-only change", () => {
    it("calls updatePetProfile but emits no event (returns no notifications) when only flag changed", async () => {
      // Flag differs from existing pet (existing: false, parsed: true).
      const repo = makeFakeRepo({
        updatePetProfile: vi.fn().mockResolvedValue({ eventId: null }),
      });

      const result = await updatePet(
        makeInput({
          parsed: makeParsedPet({ emergencyInfoVisible: true }),
        }),
        {
          repo,
          actor: makeActor(),
          transaction: async (cb) => await cb({} as never),
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(repo.updatePetProfile).toHaveBeenCalledTimes(1);
      const [args] = (repo.updatePetProfile as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args.hasContentChanges).toBe(false);
      expect(args.flagChanged).toBe(true);
      expect(result.notifications).toHaveLength(0);
    });
  });

  describe("content diff", () => {
    it("calls updatePetProfile with hasContentChanges=true when name changed", async () => {
      const repo = makeFakeRepo();

      const result = await updatePet(makeInput({ parsed: makeParsedPet({ name: "Lulú" }) }), {
        repo,
        actor: makeActor(),
        transaction: async (cb) => await cb({} as never),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(repo.updatePetProfile).toHaveBeenCalledTimes(1);
      const [args] = (repo.updatePetProfile as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args.hasContentChanges).toBe(true);
      const nameChange = args.changes.find((c: { field: string }) => c.field === "name");
      expect(nameChange).toBeDefined();
      expect(nameChange.old).toBe("Luna");
      expect(nameChange.new).toBe("Lulú");
    });

    it("treats photo upload as content change", async () => {
      const repo = makeFakeRepo();

      await updatePet(
        makeInput({
          uploadedPath: "pet-photos/photo.jpg",
          uploadMimeType: "image/jpeg",
          uploadSize: 1024,
        }),
        {
          repo,
          actor: makeActor(),
          transaction: async (cb) => await cb({} as never),
        },
      );

      const [args] = (repo.updatePetProfile as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args.hasContentChanges).toBe(true);
    });
  });

  describe("PPP notification", () => {
    it("queues ppp_registration_reminder when becamePPP and accessPath=owner", async () => {
      const repo = makeFakeRepo();
      const actor = makeActor({ accessPath: "owner" });
      actor.existingPet = makeExistingPet({ potentiallyDangerousBreed: false, name: "Luna" });

      const result = await updatePet(
        makeInput({
          parsed: makeParsedPet({ name: "Lulú" }),
          potentiallyDangerousBreed: true,
        }),
        {
          repo,
          actor,
          transaction: async (cb) => await cb({} as never),
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0].notificationType).toBe("ppp_registration_reminder");
      expect(result.notifications[0].userId).toBe("user-1");
    });

    it("suppresses PPP notification when accessPath=org", async () => {
      const repo = makeFakeRepo();
      const actor = makeActor({ accessPath: "org" });
      actor.existingPet = makeExistingPet({ potentiallyDangerousBreed: false });

      const result = await updatePet(
        makeInput({
          parsed: makeParsedPet({ name: "Lulú" }),
          potentiallyDangerousBreed: true,
        }),
        {
          repo,
          actor,
          transaction: async (cb) => await cb({} as never),
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.notifications).toHaveLength(0);
    });
  });

  describe("chip newly added", () => {
    it("passes chipNewlyAdded=true when chip was absent and is now present", async () => {
      const repo = makeFakeRepo();
      // ARCH-S: chip presence is tracked via existingCanonicalIds, not existingPet.microchipId.
      const actor = makeActor({ existingCanonicalIds: { hasMicrochip: false } });

      await updatePet(
        makeInput({
          parsed: makeParsedPet({ microchipId: "724123456789012" }),
        }),
        {
          repo,
          actor,
          transaction: async (cb) => await cb({} as never),
        },
      );

      const [args] = (repo.updatePetProfile as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args.chipNewlyAdded).toBe(true);
    });

    it("passes chipNewlyAdded=false when chip was already present (name also changed to force tx)", async () => {
      const repo = makeFakeRepo();
      // ARCH-S: existingCanonicalIds.hasMicrochip=true signals pet already had a chip.
      const actor = makeActor({ existingCanonicalIds: { hasMicrochip: true } });

      // Change the name too so there IS a content diff and the tx runs.
      await updatePet(
        makeInput({
          parsed: makeParsedPet({ microchipId: "724123456789012", name: "Lulú" }),
        }),
        {
          repo,
          actor,
          transaction: async (cb) => await cb({} as never),
        },
      );

      expect(repo.updatePetProfile).toHaveBeenCalledTimes(1);
      const [args] = (repo.updatePetProfile as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args.chipNewlyAdded).toBe(false);
    });
  });

  describe("rollback / error path", () => {
    it("returns ok:false with error message when transaction throws", async () => {
      const repo = makeFakeRepo({
        updatePetProfile: vi.fn().mockRejectedValue(new Error("constraint violated")),
      });

      const result = await updatePet(makeInput({ parsed: makeParsedPet({ name: "Lulú" }) }), {
        repo,
        actor: makeActor(),
        transaction: async (cb) => await cb({} as never),
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toMatch(/No se pudo actualizar/);
    });
  });
});
