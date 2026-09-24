// Unit tests for the RegisterPet use-case.
//
// Uses a fake PetsRepository — no DB, no Next.js.
// Covers: success path, PPP notification queue/suppress, atomic write delegation,
// no-op paths (notifications empty on foster_in_transit).
//
// TDD cycle: RED written before register-pet.ts exists.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedPet } from "../../domain/types";
import type { RegisterPetInput } from "../../domain/types";
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
    updatePetProfile: vi.fn().mockResolvedValue({ eventId: null }),
    ...overrides,
  } as unknown as typeof PetsRepository;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeInput(overrides?: Partial<RegisterPetInput>): RegisterPetInput {
  return {
    parsed: makeParsedPet(),
    potentiallyDangerousBreed: false,
    uploadedPath: null,
    uploadMimeType: null,
    uploadSize: null,
    clientIdempotencyKey: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerPet", () => {
  // Import lazily so the module doesn't need to exist yet during RED phase.
  let registerPet: typeof import("../register-pet").registerPet;

  beforeEach(async () => {
    const mod = await import("../register-pet");
    registerPet = mod.registerPet;
    vi.clearAllMocks();
  });

  describe("success path", () => {
    it("returns ok:true with petId and eventId on successful registration", async () => {
      const repo = makeFakeRepo();
      const result = await registerPet(makeInput(), {
        repo,
        actor: { user: { id: "user-1" } },
        transaction: async (cb) => await cb({} as never),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value?.petId).toBe("pet-uuid-1");
      expect(result.value?.eventId).toBe("event-uuid-1");
    });

    it("calls repo.generatePublicToken once", async () => {
      const repo = makeFakeRepo();
      await registerPet(makeInput(), {
        repo,
        actor: { user: { id: "user-1" } },
        transaction: async (cb) => await cb({} as never),
      });

      expect(repo.generatePublicToken).toHaveBeenCalledTimes(1);
    });

    it("calls insertPetRegistered inside the transaction with the generated token", async () => {
      const repo = makeFakeRepo();
      let capturedTx: unknown;

      await registerPet(makeInput(), {
        repo,
        actor: { user: { id: "user-1" } },
        transaction: async (cb) => {
          capturedTx = {};
          return await cb(capturedTx as never);
        },
      });

      expect(repo.insertPetRegistered).toHaveBeenCalledTimes(1);
      const [args, tx] = (repo.insertPetRegistered as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args.publicToken).toBe("DIM-TEST-0001");
      expect(args.userId).toBe("user-1");
      expect(tx).toBe(capturedTx);
    });

    it("returns empty notifications when PPP is false", async () => {
      const repo = makeFakeRepo();
      const result = await registerPet(makeInput({ potentiallyDangerousBreed: false }), {
        repo,
        actor: { user: { id: "user-1" } },
        transaction: async (cb) => await cb({} as never),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.notifications).toHaveLength(0);
    });
  });

  describe("PPP notification", () => {
    it("queues ppp_registration_reminder when PPP=true and custodyKind=owner", async () => {
      const repo = makeFakeRepo();
      const result = await registerPet(
        makeInput({
          potentiallyDangerousBreed: true,
          parsed: makeParsedPet({ custodyKind: "owner", name: "Rex", breed: "pitbull" }),
        }),
        {
          repo,
          actor: { user: { id: "user-1" } },
          transaction: async (cb) => await cb({} as never),
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0].notificationType).toBe("ppp_registration_reminder");
      expect(result.notifications[0].userId).toBe("user-1");
      expect(result.notifications[0].relatedPetId).toBe("pet-uuid-1");
      expect(result.notifications[0].relatedEventId).toBe("event-uuid-1");
    });

    it("suppresses PPP notification when custodyKind=foster_in_transit", async () => {
      const repo = makeFakeRepo();
      const result = await registerPet(
        makeInput({
          potentiallyDangerousBreed: true,
          parsed: makeParsedPet({ custodyKind: "foster_in_transit" }),
        }),
        {
          repo,
          actor: { user: { id: "user-1" } },
          transaction: async (cb) => await cb({} as never),
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.notifications).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotent replay (WU-B review FB-4)
  // -------------------------------------------------------------------------
  //
  // THE PROPERTY THE WHOLE MECHANISM EXISTS FOR — "a retry creates no second
  // animal" — WAS PROVEN NOWHERE. The route test mocks `registerPet` entirely,
  // so it cannot see a write; this file had no replay case at all. Between them
  // the two layers asserted that a replay RENDERS correctly and never that it
  // WRITES nothing, which is the half a user would notice.
  //
  // This is the layer that can prove it: the fake repository reports a prior
  // registration, and `insertPetRegistered` must not be reached.
  describe("idempotent replay", () => {
    const KEY = "1c2f9a6e-5b3d-4f80-91a2-b3c4d5e6f708";

    function replayRepo() {
      return makeFakeRepo({
        findDuplicateRegistration: vi
          .fn()
          .mockResolvedValue({ publicToken: "DIM-FIRST-0001", name: "Luna" }),
      });
    }

    it("creates NO second animal when the key matches a prior registration", async () => {
      const repo = replayRepo();

      const result = await registerPet(makeInput({ clientIdempotencyKey: KEY }), {
        repo,
        actor: { user: { id: "user-1" } },
        transaction: async (cb) => await cb({} as never),
      });

      // THE ASSERTION. Everything else in this describe is context for it.
      expect(repo.insertPetRegistered).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value?.wasDuplicate).toBe(true);
      // The FIRST attempt's token, not the one generated for this attempt.
      expect(result.value?.publicToken).toBe("DIM-FIRST-0001");
    });

    it("queues no notifications on a replay", async () => {
      // A PPP reminder fired again on every retry would be a push notification
      // per flaky connection, about a pet the owner already registered.
      const repo = replayRepo();

      const result = await registerPet(
        makeInput({ clientIdempotencyKey: KEY, potentiallyDangerousBreed: true }),
        {
          repo,
          actor: { user: { id: "user-1" } },
          transaction: async (cb) => await cb({} as never),
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.notifications).toHaveLength(0);
    });

    // FB-3. The key is a client's private retry token, not a global name. The
    // lookup used to be keyed on (event_type, key) alone, so two users
    // presenting the same string meant the second one silently received the
    // FIRST one's publicToken with a 201 and no pet of their own — negligible
    // under random UUIDv4, real under any deterministic key derivation, which
    // this repo already does elsewhere (`deriveBulkIdempotencyKey`).
    it("scopes the lookup to the OWNER, not to the key alone", async () => {
      const repo = replayRepo();

      await registerPet(makeInput({ clientIdempotencyKey: KEY }), {
        repo,
        actor: { user: { id: "user-1" } },
        transaction: async (cb) => await cb({} as never),
      });

      expect(repo.findDuplicateRegistration).toHaveBeenCalledTimes(1);
      const [key, ownerId] = (repo.findDuplicateRegistration as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(key).toBe(KEY);
      expect(ownerId).toBe("user-1");
    });

    // NON-VACUITY for the three above: without a hit, the write must happen.
    it("writes normally when the key matches nothing", async () => {
      const repo = makeFakeRepo({ findDuplicateRegistration: vi.fn().mockResolvedValue(null) });

      const result = await registerPet(makeInput({ clientIdempotencyKey: KEY }), {
        repo,
        actor: { user: { id: "user-1" } },
        transaction: async (cb) => await cb({} as never),
      });

      expect(repo.insertPetRegistered).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value?.wasDuplicate).toBe(false);
      expect(result.value?.publicToken).toBe("DIM-TEST-0001");
    });

    it("does not consult the lookup at all when no key was supplied", async () => {
      const repo = makeFakeRepo({ findDuplicateRegistration: vi.fn() });

      await registerPet(makeInput({ clientIdempotencyKey: null }), {
        repo,
        actor: { user: { id: "user-1" } },
        transaction: async (cb) => await cb({} as never),
      });

      expect(repo.findDuplicateRegistration).not.toHaveBeenCalled();
      expect(repo.insertPetRegistered).toHaveBeenCalledTimes(1);
    });
  });

  describe("error path", () => {
    it("returns ok:false when transaction throws", async () => {
      const repo = makeFakeRepo({
        insertPetRegistered: vi.fn().mockRejectedValue(new Error("DB exploded")),
      });

      const result = await registerPet(makeInput(), {
        repo,
        actor: { user: { id: "user-1" } },
        transaction: async (cb) => await cb({} as never),
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toMatch(/No se pudo crear la mascota/);
    });

    it("translates a pet_identifications_chip_unique race into friendly chip guidance, not the raw driver string", async () => {
      // Defense-in-depth for the residual race: the action cross-checks the chip
      // before the tx, but a concurrent write can claim the code between that
      // check and the insert, tripping the partial unique index. The unwrapped
      // pg error lives on `.cause` (drizzle 0.45), which matchesDbError walks.
      const raceError = Object.assign(new Error("Failed query: insert into pet_identifications"), {
        cause: {
          code: "23505",
          constraint_name: "pet_identifications_chip_unique",
          message:
            'duplicate key value violates unique constraint "pet_identifications_chip_unique"',
        },
      });
      const repo = makeFakeRepo({
        insertPetRegistered: vi.fn().mockRejectedValue(raceError),
      });

      const result = await registerPet(makeInput(), {
        repo,
        actor: { user: { id: "user-1" } },
        transaction: async (cb) => await cb({} as never),
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      // The friendly copy, NOT the generic "No se pudo crear la mascota: …"
      // wrapper and NOT the raw "duplicate key value …" driver text.
      expect(result.error).toMatch(/microchip ya figura registrado/i);
      expect(result.error).not.toMatch(/No se pudo crear la mascota/);
      expect(result.error).not.toMatch(/duplicate key/i);
    });

    it("does NOT call insertPetRegistered when generatePublicToken throws", async () => {
      const repo = makeFakeRepo({
        generatePublicToken: vi.fn().mockRejectedValue(new Error("token gen failed")),
      });

      await expect(
        registerPet(makeInput(), {
          repo,
          actor: { user: { id: "user-1" } },
          transaction: async (cb) => await cb({} as never),
        }),
      ).rejects.toThrow("token gen failed");

      expect(repo.insertPetRegistered).not.toHaveBeenCalled();
    });
  });
});
