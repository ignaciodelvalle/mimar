// Parity tests for src/modules/pets/actions.ts thin controllers.
//
// These are module-level unit tests — they mock Next.js, Supabase, and the
// use-cases so we can verify the action's orchestration logic without a DB:
//   - Auth guard fires first (createPet: getUser; updatePet: requireTitularAccess)
//   - Pre-tx chip cross-check 3-way: lost→redirect / active→warn+forceToken / deceased→error
//   - Jurisdiction error propagated from resolveCanonicalJurisdiction
//   - Use-case error propagated to caller
//   - Notifications are flushed post-tx (db.insert called after use-case ok)
//
// TDD cycle: RED written before src/modules/pets/actions.ts exists.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (must be at top level before imports)
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error(`REDIRECT:${url}`), { digest: `NEXT_REDIRECT:${url}` });
  }),
}));

// requireLiveUser (T1.2) resolves profiles.deleted_at / deactivated_at from the
// DATABASE — the guard is deliberately not claim-based. These action tests mock
// the Supabase client but not the profile read, so without this the guard would
// issue a real query with a fixture user id. A healthy profile keeps every
// assertion below testing what it was written to test.
vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: vi.fn(async (id: string) => ({
    id,
    role: "owner" as const,
    displayName: "Fixture",
    accountType: "personal" as const,
    deactivatedAt: null,
    deletedAt: null,
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        remove: vi.fn().mockResolvedValue({ error: null }),
      }),
    },
  }),
}));

vi.mock("@/lib/infra/pet-access", () => ({
  requireTitularAccess: vi.fn().mockResolvedValue({
    ok: true,
    user: { id: "user-1" },
    supabase: {
      storage: { from: vi.fn().mockReturnValue({ remove: vi.fn() }) },
    },
    pet: {
      id: "pet-existing",
      name: "Luna",
      species: "perro",
      sex: "female",
      breed: "labrador",
      dateOfBirth: "2022-01-01",
      color: "negro",
      // ARCH-S: microchipId / microchipCountryCode / microchipImplantedAt /
      // microchipImplantedBy / microchipLocation columns dropped from pets table.
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
      emergencyInfoVisible: false,
      permanentConditions: [],
      permanentConditionsOther: null,
      discloseConditionsPublicly: false,
    },
    eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
    accessPath: "owner",
  }),
}));

vi.mock("@/lib/infra/uploads", () => ({
  uploadAttachmentIfPresent: vi.fn().mockResolvedValue({
    uploadedPath: null,
    mimeType: null,
    size: null,
    error: null,
  }),
}));

// TWO CATALOGUE ROWS WITH THE SAME NAME, which is what makes the L2-8 case
// below observable: the INDEC catalogue carries 68 (province, locality)
// collisions, the name lookup settles them with `.orderBy(departmentName)
// .limit(1)`, and only the id says which one the person picked. The two mocked
// resolvers therefore answer with the same NAMES and different ROWS.
vi.mock("@/lib/infra/jurisdiction-validation", () => ({
  JurisdictionValidationError: class JurisdictionValidationError extends Error {},
  resolveCanonicalJurisdiction: vi.fn().mockResolvedValue({
    province: { name: "Buenos Aires" },
    locality: { localityName: "La Plata", id: "loc-BY-NAME" },
  }),
  resolveCanonicalJurisdictionById: vi.fn().mockResolvedValue({
    province: { name: "Buenos Aires" },
    locality: { localityName: "La Plata", id: "loc-BY-ID" },
  }),
}));

vi.mock("@/lib/domain/microchip-validation", () => ({
  validateMicrochipId: vi.fn().mockReturnValue({ ok: true, normalized: "724123456789012" }),
}));

vi.mock("@/lib/infra/chip-lookup", () => ({
  lookupByChip: vi.fn().mockResolvedValue(null),
}));

// Soft same-owner dedupe (gate P2) — orchestration tests default to "no
// duplicate" so createPetAction proceeds to registerPet, same posture as the
// chip-lookup mock above.
vi.mock("@/lib/infra/owner-pet-dedupe", () => ({
  findSameOwnerDuplicatePet: vi.fn().mockResolvedValue(null),
}));

// ARCH-S: updatePetAction now calls fetchActiveIdentifications to get canonical chip presence.
vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: vi.fn().mockResolvedValue({ microchip: null, tattoo: null }),
}));

// Append-only trace for a redeemed ACTIVE-match receipt. A use-case like any
// other here — mocked so these orchestration tests stay DB-free.
vi.mock("@/src/modules/pets/application/chip-match/record-chip-dispute", () => ({
  recordChipDisputeAgainstActivePet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/infra/microchip-force-token", () => ({
  generateForceToken: vi.fn().mockReturnValue("force-tok-abc"),
  validateForceToken: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/infra/breeds-server", () => ({
  isPotentiallyDangerousBreedForJurisdiction: vi.fn().mockResolvedValue(false),
}));

// F1 (adversarial review 2026-08-14): the update path must classify PPP with
// the PERSISTED species, never the submitted one. Mocked so the regression
// tests below can assert the call arguments without touching the
// business-rules resolver (which needs a DB).
vi.mock("@/lib/infra/ppp-classification", () => ({
  resolvePppClassificationForJurisdiction: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/db", () => ({
  db: {
    transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => cb({})),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  },
  notifications: { $inferInsert: {} },
}));

vi.mock("@/src/modules/pets/application/register-pet", () => ({
  registerPet: vi.fn().mockResolvedValue({
    ok: true,
    value: { petId: "new-pet-id", eventId: "new-event-id" },
    notifications: [],
  }),
}));

vi.mock("@/src/modules/pets/application/update-pet", () => ({
  updatePet: vi.fn().mockResolvedValue({
    ok: true,
    notifications: [],
  }),
}));

vi.mock("@/src/modules/pets/infrastructure/pets-repository", () => ({
  PetsRepository: {
    generatePublicToken: vi.fn(),
    insertPetRegistered: vi.fn(),
    updatePetProfile: vi.fn(),
    correctSpecies: vi.fn().mockResolvedValue({ eventId: "event-1" }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCreateFormData(overrides?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.append("name", "Luna");
  fd.append("species", "perro");
  fd.append("sex", "female");
  fd.append("localityName", "La Plata");
  fd.append("provinceCode", "AR-B");
  for (const [k, v] of Object.entries(overrides ?? {})) {
    fd.set(k, v);
  }
  return fd;
}

function makeUpdateFormData(overrides?: Record<string, string>): FormData {
  return makeCreateFormData(overrides);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPetAction", () => {
  let createPetAction: typeof import("../actions").createPetAction;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../actions");
    createPetAction = mod.createPetAction;

    vi.clearAllMocks();
    // Reset mocks to defaults
    (await import("@/lib/supabase/server")).createClient = vi.fn().mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }),
      },
      storage: {
        from: vi.fn().mockReturnValue({ remove: vi.fn().mockResolvedValue({ error: null }) }),
      },
    });
    (await import("@/lib/infra/chip-lookup")).lookupByChip = vi.fn().mockResolvedValue(null);
    // The two resolvers answer with the SAME names and DIFFERENT rows — see the
    // module mock's note. `id` is the value that reaches `pets.locality_id`.
    (await import("@/lib/infra/jurisdiction-validation")).resolveCanonicalJurisdiction = vi
      .fn()
      .mockResolvedValue({
        province: { name: "Buenos Aires" },
        locality: { localityName: "La Plata", id: "loc-BY-NAME" },
      });
    (await import("@/lib/infra/jurisdiction-validation")).resolveCanonicalJurisdictionById = vi
      .fn()
      .mockResolvedValue({
        province: { name: "Buenos Aires" },
        locality: { localityName: "La Plata", id: "loc-BY-ID" },
      });
    (await import("@/src/modules/pets/application/register-pet")).registerPet = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        value: { petId: "new-pet-id", eventId: "new-event-id", publicToken: "DIM-TEST-0001" },
        notifications: [],
      });
  });

  describe("auth guard", () => {
    it("returns error when no Supabase session", async () => {
      const supaClient = {
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
        storage: { from: vi.fn() },
      };
      const { createClient } = await import("@/lib/supabase/server");
      (createClient as ReturnType<typeof vi.fn>).mockResolvedValueOnce(supaClient);

      const result = (await createPetAction({ error: null }, makeCreateFormData())) as {
        error: string;
      };
      expect(result.error).toMatch(/Sesión expirada/);
    });
  });

  describe("chip cross-check (found_stray)", () => {
    it("redirects to match page when chip match status=lost", async () => {
      const { lookupByChip } = await import("@/lib/infra/chip-lookup");
      (lookupByChip as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        pet: { status: "lost", publicToken: "DIM-LOST-0001" },
      });

      // N3 (B.2 migration): the action RETURNS the match page rather than
      // redirect()ing to it. The old comment defending this call — "request-edge:
      // redirect stays here" — never said why it would be immune to a defect
      // that hits every other one.
      const state = await createPetAction(
        { error: null },
        makeCreateFormData({ acquisitionMethod: "found_stray", microchipId: "724123456789012" }),
      );
      // ?chip= is the match page's authorization (chip-oracle fix): that page
      // and its confirm action both require proof the caller knows the code.
      expect(state.redirectTo).toBe("/mis-mascotas/nueva/match/DIM-LOST-0001?chip=724123456789012");
    });

    it("returns CHIP_MATCH_ACTIVE warning when match status=active and no forceToken", async () => {
      const { lookupByChip } = await import("@/lib/infra/chip-lookup");
      (lookupByChip as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        pet: { status: "active", publicToken: "DIM-ACTIVE-0001" },
      });

      const result = (await createPetAction(
        { error: null },
        makeCreateFormData({ acquisitionMethod: "found_stray", microchipId: "724123456789012" }),
      )) as { warning: string; matchedPetToken: string; forceToken: string };

      expect(result.warning).toBe("CHIP_MATCH_ACTIVE");
      expect(result.matchedPetToken).toBe("DIM-ACTIVE-0001");
      expect(result.forceToken).toBeDefined();
    });

    it("falls through to registerPet when match status=active and forceToken is valid", async () => {
      const { lookupByChip } = await import("@/lib/infra/chip-lookup");
      (lookupByChip as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        pet: { status: "active", publicToken: "DIM-ACTIVE-0001" },
      });

      const { validateForceToken } = await import("@/lib/infra/microchip-force-token");
      (validateForceToken as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

      const { registerPet } = await import("@/src/modules/pets/application/register-pet");

      // The action should NOT return a warning/error state — it falls through to
      // registerPet and returns redirectTo (N3 contract).
      const result = (await createPetAction(
        { error: null },
        makeCreateFormData({
          acquisitionMethod: "found_stray",
          microchipId: "724123456789012",
          forceToken: "valid-force-token",
        }),
      )) as { error: null; redirectTo: string };

      expect(result.redirectTo).toBe("/mis-mascotas/nueva/DIM-TEST-0001/credencial");
      expect(registerPet).toHaveBeenCalledOnce();

      // Redeeming the receipt is an adjudication against an existing
      // credential's globally-unique identifier — it must reach the spine.
      const { recordChipDisputeAgainstActivePet } = await import(
        "@/src/modules/pets/application/chip-match/record-chip-dispute"
      );
      expect(recordChipDisputeAgainstActivePet).toHaveBeenCalledWith({
        disputedChipCode: "724123456789012",
        actorUserId: "user-1",
      });
    });

    it("returns deceased chip error when match status=deceased", async () => {
      const { lookupByChip } = await import("@/lib/infra/chip-lookup");
      (lookupByChip as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        pet: { status: "deceased", publicToken: "DIM-DEAD-0001" },
      });

      const result = (await createPetAction(
        { error: null },
        makeCreateFormData({ acquisitionMethod: "found_stray", microchipId: "724123456789012" }),
      )) as { error: string };

      expect(result.error).toMatch(/fallecida/);
    });
  });

  describe("success", () => {
    it("returns redirectTo to credencial aha page on successful register", async () => {
      const result = (await createPetAction({ error: null }, makeCreateFormData())) as {
        error: null;
        redirectTo: string;
      };
      expect(result.error).toBeNull();
      expect(result.redirectTo).toBe("/mis-mascotas/nueva/DIM-TEST-0001/credencial");
    });
  });

  describe("error propagation", () => {
    it("propagates use-case error to caller", async () => {
      const { registerPet } = await import("@/src/modules/pets/application/register-pet");
      (registerPet as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        error: "No se pudo crear la mascota: DB failure",
      });

      const result = (await createPetAction({ error: null }, makeCreateFormData())) as {
        error: string;
      };
      expect(result.error).toMatch(/No se pudo crear la mascota/);
    });
  });

  describe("data-quality gates", () => {
    it("P1: threads clientIdempotencyKey to registerPet", async () => {
      const { registerPet } = await import("@/src/modules/pets/application/register-pet");
      await createPetAction(
        { error: null },
        makeCreateFormData({ clientIdempotencyKey: "11111111-1111-4111-8111-111111111111" }),
      );
      expect(registerPet).toHaveBeenCalledWith(
        expect.objectContaining({
          clientIdempotencyKey: "11111111-1111-4111-8111-111111111111",
        }),
        expect.anything(),
      );
    });

    it("L2-8: resolves the locality BY THE ID the picker sent, not by its name", async () => {
      // `LocationFields` writes a hidden `localityNameIndecId` on every catalog
      // selection, `parsePetForm` reads it — and this action passed
      // `localityIndecId: null` to the normalizer regardless. So the web alta
      // settled a homonym alphabetically while the bearer registration and the
      // mudanza, which both send the id, settled it correctly: two doors onto
      // `pets.locality_id` disagreeing about the same animal.
      const { registerPet } = await import("@/src/modules/pets/application/register-pet");
      const { resolveCanonicalJurisdictionById } = await import(
        "@/lib/infra/jurisdiction-validation"
      );

      await createPetAction({ error: null }, makeCreateFormData({ localityNameIndecId: "060658" }));

      expect(resolveCanonicalJurisdictionById).toHaveBeenCalledWith({ indecId: "060658" });
      expect(registerPet).toHaveBeenCalledWith(
        expect.objectContaining({ parsed: expect.objectContaining({ localityId: "loc-BY-ID" }) }),
        expect.anything(),
      );
    });

    it("L2-8: still resolves by NAME when the form sent no id", async () => {
      // NON-VACUITY: the two resolvers really are distinguishable here, so the
      // assertion above is about which one ran and not about the mock.
      const { registerPet } = await import("@/src/modules/pets/application/register-pet");
      await createPetAction({ error: null }, makeCreateFormData());
      expect(registerPet).toHaveBeenCalledWith(
        expect.objectContaining({ parsed: expect.objectContaining({ localityId: "loc-BY-NAME" }) }),
        expect.anything(),
      );
    });

    it("P1: resolves a double-submit to the existing pet without re-flushing", async () => {
      const { registerPet } = await import("@/src/modules/pets/application/register-pet");
      (registerPet as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        value: { petId: "", eventId: "", publicToken: "DIM-DUPE-0001", wasDuplicate: true },
        notifications: [],
      });

      const result = (await createPetAction({ error: null }, makeCreateFormData())) as {
        error: null;
        redirectTo: string;
      };
      expect(result.redirectTo).toBe("/mis-mascotas/nueva/DIM-DUPE-0001/credencial");
    });

    it("P2: returns a duplicatePrompt and skips registerPet on a same-owner match", async () => {
      const { findSameOwnerDuplicatePet } = await import("@/lib/infra/owner-pet-dedupe");
      (findSameOwnerDuplicatePet as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        publicToken: "DIM-MINE-0001",
        name: "Luna",
        species: "perro",
        sex: "female",
      });
      const { registerPet } = await import("@/src/modules/pets/application/register-pet");

      const result = (await createPetAction({ error: null }, makeCreateFormData())) as {
        error: null;
        duplicatePrompt: { publicToken: string; name: string };
      };
      expect(result.duplicatePrompt.publicToken).toBe("DIM-MINE-0001");
      expect(registerPet).not.toHaveBeenCalled();
    });

    it("P2: duplicateOverride=1 skips the dedupe check and proceeds", async () => {
      const { findSameOwnerDuplicatePet } = await import("@/lib/infra/owner-pet-dedupe");
      const { registerPet } = await import("@/src/modules/pets/application/register-pet");

      const result = (await createPetAction(
        { error: null },
        makeCreateFormData({ duplicateOverride: "1" }),
      )) as { redirectTo: string };
      expect(findSameOwnerDuplicatePet).not.toHaveBeenCalled();
      expect(registerPet).toHaveBeenCalledOnce();
      expect(result.redirectTo).toBe("/mis-mascotas/nueva/DIM-TEST-0001/credencial");
    });

    it("P3: blocks a non-found_stray chip already registered elsewhere", async () => {
      const { lookupByChip } = await import("@/lib/infra/chip-lookup");
      (lookupByChip as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        pet: { id: "other-pet", status: "active", publicToken: "DIM-OTHER-0001" },
      });
      const { registerPet } = await import("@/src/modules/pets/application/register-pet");

      const result = (await createPetAction(
        { error: null },
        makeCreateFormData({ acquisitionMethod: "adopted", microchipId: "724123456789012" }),
      )) as { error: string };
      expect(result.error).toMatch(/ya figura registrado/i);
      expect(registerPet).not.toHaveBeenCalled();
    });
  });
});

describe("updatePetAction", () => {
  let updatePetAction: typeof import("../actions").updatePetAction;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../actions");
    updatePetAction = mod.updatePetAction;
    vi.clearAllMocks();

    (await import("@/lib/infra/pet-access")).requireTitularAccess = vi.fn().mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
      supabase: { storage: { from: vi.fn().mockReturnValue({ remove: vi.fn() }) } },
      pet: {
        id: "pet-existing",
        name: "Luna",
        species: "perro",
        sex: "female",
        breed: "labrador",
        dateOfBirth: "2022-01-01",
        color: "negro",
        // ARCH-S: microchipId / microchipCountryCode / microchipImplantedAt /
        // microchipImplantedBy / microchipLocation columns dropped from pets table.
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
        emergencyInfoVisible: false,
        permanentConditions: [],
        permanentConditionsOther: null,
        discloseConditionsPublicly: false,
      },
      eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
      accessPath: "owner",
    });
    // The two resolvers answer with the SAME names and DIFFERENT rows — see the
    // module mock's note. `id` is the value that reaches `pets.locality_id`.
    (await import("@/lib/infra/jurisdiction-validation")).resolveCanonicalJurisdiction = vi
      .fn()
      .mockResolvedValue({
        province: { name: "Buenos Aires" },
        locality: { localityName: "La Plata", id: "loc-BY-NAME" },
      });
    (await import("@/lib/infra/jurisdiction-validation")).resolveCanonicalJurisdictionById = vi
      .fn()
      .mockResolvedValue({
        province: { name: "Buenos Aires" },
        locality: { localityName: "La Plata", id: "loc-BY-ID" },
      });
    (await import("@/src/modules/pets/application/update-pet")).updatePet = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        notifications: [],
      });
  });

  describe("auth guard", () => {
    it("returns error when requireTitularAccess fails", async () => {
      const { requireTitularAccess } = await import("@/lib/infra/pet-access");
      (requireTitularAccess as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        error: "Acceso denegado.",
      });

      const result = (await updatePetAction(
        "DIM-TEST-0001",
        { error: null },
        makeUpdateFormData(),
      )) as { error: string };
      expect(result.error).toBe("Acceso denegado.");
    });
  });

  describe("error propagation", () => {
    it("propagates use-case error to caller", async () => {
      const { updatePet } = await import("@/src/modules/pets/application/update-pet");
      (updatePet as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        error: "No se pudo actualizar: constraint",
      });

      const result = (await updatePetAction(
        "DIM-TEST-0001",
        { error: null },
        makeUpdateFormData(),
      )) as { error: string };
      expect(result.error).toMatch(/No se pudo actualizar/);
    });
  });

  describe("data-quality gate P3 (edit path)", () => {
    it("blocks adding a chip already registered on another pet", async () => {
      const { lookupByChip } = await import("@/lib/infra/chip-lookup");
      (lookupByChip as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        pet: { id: "other-pet", status: "active", publicToken: "DIM-OTHER-0001" },
      });
      const { updatePet } = await import("@/src/modules/pets/application/update-pet");

      const result = (await updatePetAction(
        "DIM-TEST-0001",
        { error: null },
        makeUpdateFormData({ microchipId: "724123456789012" }),
      )) as { error: string };
      expect(result.error).toMatch(/ya figura registrado/i);
      expect(updatePet).not.toHaveBeenCalled();
    });
  });

  describe("persisted-species validation (adversarial review 2026-08-14)", () => {
    // updatePetProfile never writes species (FULL-LOCK, PO decision #40), so
    // the submitted species is free input with no corresponding write. Both
    // the breed catalog gate and the PPP classification must therefore run
    // against existingPet.species — the persisted truth.

    function mockPetAccessOnce(petOverrides: Record<string, unknown>) {
      return vi.fn().mockResolvedValue({
        ok: true,
        user: { id: "user-1" },
        supabase: { storage: { from: vi.fn().mockReturnValue({ remove: vi.fn() }) } },
        pet: {
          id: "pet-existing",
          name: "Luna",
          species: "dog",
          sex: "female",
          breed: "Labrador",
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
          emergencyInfoVisible: false,
          permanentConditions: [],
          permanentConditionsOther: null,
          discloseConditionsPublicly: false,
          ...petOverrides,
        },
        eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
        accessPath: "owner",
      });
    }

    it("attack A: species=cat&breed=Persa on a dog is rejected against the DOG catalog", async () => {
      const petAccessMod = await import("@/lib/infra/pet-access");
      petAccessMod.requireTitularAccess = mockPetAccessOnce({ species: "dog", breed: "Labrador" });
      const { updatePet } = await import("@/src/modules/pets/application/update-pet");

      const result = (await updatePetAction(
        "DIM-TEST-0001",
        { error: null },
        makeUpdateFormData({ species: "cat", breed: "Persa" }),
      )) as { error: string };

      // "Persa" resolves — but only in the CAT catalog. The persisted species
      // is dog, so the gate must reject; the submitted species must not pick
      // the catalog.
      expect(result.error).toBe("Elegí una raza de la lista.");
      expect(updatePet).not.toHaveBeenCalled();
    });

    it("attack B: species=cat with the unchanged PPP breed still classifies as a DOG (flag not cleared)", async () => {
      const petAccessMod = await import("@/lib/infra/pet-access");
      petAccessMod.requireTitularAccess = mockPetAccessOnce({
        species: "dog",
        breed: "Pit Bull Terrier",
        potentiallyDangerousBreed: true,
      });
      const { resolvePppClassificationForJurisdiction } = await import(
        "@/lib/infra/ppp-classification"
      );
      (resolvePppClassificationForJurisdiction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        true,
      );
      const { updatePet } = await import("@/src/modules/pets/application/update-pet");

      const state = await updatePetAction(
        "DIM-TEST-0001",
        { error: null },
        makeUpdateFormData({ species: "cat", breed: "Pit Bull Terrier" }),
      );
      expect(state.redirectTo).toBe("/mis-mascotas/DIM-TEST-0001");

      // The classification must run with the persisted species ("dog"), not
      // the submitted "cat" — otherwise the legally load-bearing flag clears.
      expect(resolvePppClassificationForJurisdiction).toHaveBeenCalledWith(
        "dog",
        "Pit Bull Terrier",
        null,
        expect.objectContaining({ country: "AR" }),
      );
      expect(updatePet).toHaveBeenCalledWith(
        expect.objectContaining({ potentiallyDangerousBreed: true }),
        expect.anything(),
      );
    });
  });

  describe("notifications flush", () => {
    it("calls db.insert with notifications when use-case returns them", async () => {
      const { updatePet } = await import("@/src/modules/pets/application/update-pet");
      (updatePet as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        notifications: [
          {
            userId: "user-1",
            notificationType: "ppp_registration_reminder",
            title: "PPP reminder",
            body: "Register your pet",
            severity: "warning",
          },
        ],
      });

      const { db } = await import("@/db");
      const insertSpy = db.insert as ReturnType<typeof vi.fn>;

      // updatePetAction succeeds and RETURNS its destination (N3) — the
      // notifications must already be flushed by then.
      const state = await updatePetAction("DIM-TEST-0001", { error: null }, makeUpdateFormData());
      expect(state.redirectTo).toBe("/mis-mascotas/DIM-TEST-0001");

      expect(insertSpy).toHaveBeenCalled();
    });
  });
});

describe("correctPetSpeciesAction", () => {
  let correctPetSpeciesAction: typeof import("../actions").correctPetSpeciesAction;

  function mockPetAccess(petOverrides: Record<string, unknown>) {
    return vi.fn().mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
      supabase: { storage: { from: vi.fn().mockReturnValue({ remove: vi.fn() }) } },
      pet: {
        id: "pet-existing",
        name: "Luna",
        species: "dog",
        sex: "female",
        breed: "Labrador",
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
        emergencyInfoVisible: false,
        permanentConditions: [],
        permanentConditionsOther: null,
        discloseConditionsPublicly: false,
        ...petOverrides,
      },
      eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
      accessPath: "owner",
    });
  }

  function makeSpeciesFormData(species: string): FormData {
    const fd = new FormData();
    fd.append("species", species);
    return fd;
  }

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../actions");
    correctPetSpeciesAction = mod.correctPetSpeciesAction;
    vi.clearAllMocks();
  });

  // F2 (adversarial review 2026-08-14): a species correction must not leave a
  // breed behind that is off-catalog for the NEW species — the grandfather
  // rule (QA A5) would then preserve it through every later edit, forever.

  it("clears a breed that does not resolve in the NEW species' catalog", async () => {
    const petAccessMod = await import("@/lib/infra/pet-access");
    petAccessMod.requireTitularAccess = mockPetAccess({ species: "dog", breed: "Labrador" });
    const { PetsRepository } = await import("@/src/modules/pets/infrastructure/pets-repository");

    const state = await correctPetSpeciesAction(
      "DIM-TEST-0001",
      { error: null },
      makeSpeciesFormData("cat"),
    );
    expect(state.redirectTo).toBe("/mis-mascotas/DIM-TEST-0001");

    expect(PetsRepository.correctSpecies).toHaveBeenCalledWith(
      expect.objectContaining({
        oldSpecies: "dog",
        newSpecies: "cat",
        oldBreed: "Labrador",
        newBreed: null,
      }),
      expect.anything(),
    );
  });

  it("keeps a special option — it resolves in every species' catalog", async () => {
    const petAccessMod = await import("@/lib/infra/pet-access");
    petAccessMod.requireTitularAccess = mockPetAccess({ species: "dog", breed: "Mixto / Cruza" });
    const { PetsRepository } = await import("@/src/modules/pets/infrastructure/pets-repository");

    const state = await correctPetSpeciesAction(
      "DIM-TEST-0001",
      { error: null },
      makeSpeciesFormData("cat"),
    );
    expect(state.redirectTo).toBe("/mis-mascotas/DIM-TEST-0001");

    expect(PetsRepository.correctSpecies).toHaveBeenCalledWith(
      expect.objectContaining({ newSpecies: "cat", newBreed: "Mixto / Cruza" }),
      expect.anything(),
    );
  });

  it("recomputes PPP with the new species AND the possibly-cleared breed", async () => {
    const petAccessMod = await import("@/lib/infra/pet-access");
    petAccessMod.requireTitularAccess = mockPetAccess({ species: "cat", breed: "Persa" });
    const { resolvePppClassificationForJurisdiction } = await import(
      "@/lib/infra/ppp-classification"
    );

    // cat "Persa" corrected to dog: "Persa" does not resolve in the dog
    // catalog, so classification must see (dog, null) — never (dog, "Persa").
    await correctPetSpeciesAction("DIM-TEST-0001", { error: null }, makeSpeciesFormData("dog"));

    expect(resolvePppClassificationForJurisdiction).toHaveBeenCalledWith(
      "dog",
      null,
      null,
      expect.objectContaining({ country: "AR" }),
    );
  });
});
