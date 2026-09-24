// Integration test: org intake with chip + tattoo inserts canonical pet_identifications rows.
//
// createIntakeAction is a Next.js server action that requires a live Supabase
// auth session (requireCapability), so we cannot call it directly. Instead we
// replicate the inner transaction logic that the action performs once auth
// passes — the same pattern used in custody-episode-intake-open.test.ts and
// chip-match.test.ts (section 4).
//
// What we cover (the gap from #495 review):
//   - Org intake with microchipId → canonical microchip_iso row in pet_identifications
//   - Org intake with tattooCode → canonical tattoo row in pet_identifications
//   - Both together in a single intake
//
// DB integration — requires running local Supabase stack (pnpm supabase start).

import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, petIdentifications, pets } from "@/db";
import { chipImplantSiteFromLocation } from "@/lib/domain/microchip-implant-site";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { withMutationOverride } from "../_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHIP_INTAKE = "858000000099001";
const TATTOO_INTAKE = "K9-INTAKE-2026";

// Stable fake org ID — we use a real organization seeded by seed-test-users.ts
// if one exists, otherwise we skip the org FK (intake doesn't gate on org type).
// For simplicity: use a uuid that doesn't need to exist as a FK isn't enforced
// on all paths. We use ownerUserId (seeded owner) to satisfy recordedByUserId.

let petWithChipId: string;
let petWithTattooId: string;
let petWithBothId: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

async function cleanupPet(petId: string | undefined) {
  if (!petId) return;
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}::uuid`);
    await tx.execute(sql`DELETE FROM pet_identifications WHERE pet_id = ${petId}::uuid`);
    await tx.delete(ownerships).where(eq(ownerships.petId, petId));
    await tx.delete(pets).where(eq(pets.id, petId));
  });
}

afterEach(async () => {
  // Purge between each it() so canonical indexes don't conflict across cases.
  await cleanupPet(petWithChipId);
  await cleanupPet(petWithTattooId);
  await cleanupPet(petWithBothId);
  petWithChipId = "";
  petWithTattooId = "";
  petWithBothId = "";
});

// ---------------------------------------------------------------------------
// Helper: simulate the inner DB transaction of createIntakeAction
// ---------------------------------------------------------------------------

async function simulateIntake(opts: {
  microchipId: string | null;
  tattooCode: string | null;
  userId?: string;
}): Promise<string> {
  const publicToken = `INTAKE-DW-${generatePublicToken()}`.slice(0, 30);
  const now = new Date();

  // Resolve a real userId from seeded data. MUST be an owner-role profile:
  // the bare `LIMIT 1` (no role filter, no ORDER BY) picked an ARBITRARY row,
  // and whenever the heap handed back an institutional profile — or one some
  // concurrently-running test had flipped to govt — the DB trigger
  // enforce_institutional_no_pets rejected the ownership insert. Three
  // phantom failures in a full run, 5/5 green standalone (2026-08-18).
  // ORDER BY makes the pick stable; the role filter makes it valid.
  let userId = opts.userId;
  if (!userId) {
    const rows = (await db.execute(sql`
      SELECT id::text as id FROM public.profiles
      WHERE role = 'owner' AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC LIMIT 1
    `)) as Array<{ id: string }>;
    userId = rows[0]?.id;
    if (!userId) throw new Error("No owner-role profile found — run seed-test-users.ts first");
  }

  await db.transaction(async (tx) => {
    const [newPet] = await tx
      .insert(pets)
      .values({
        publicToken,
        name: `Intake DW Test ${Date.now()}`,
        species: "dog",
        sex: "unknown",
        status: "active",
      })
      .returning();

    await tx.insert(ownerships).values({
      petId: newPet.id,
      ownerUserId: userId,
      role: "shelter_custody",
    });

    const registeredPayload = validateEventPayload("pet_registered", {
      name: newPet.name,
      species: "dog",
      sex: "unknown",
      breed: null,
      date_of_birth: null,
      birth_date_is_estimated: false,
      color: null,
      microchip_id: opts.microchipId,
      microchip_country_code: null,
      microchip_implanted_at: null,
      microchip_implanted_by: null,
      microchip_location: null,
      estimated_weight_kg: null,
      favourite_foods: [],
      known_allergies: [],
      training_level: null,
      insurance_company: null,
      insurance_policy_number: null,
      jurisdiction_province: null,
      jurisdiction_locality: null,
      potentially_dangerous_breed: false,
      acquisition_method: null,
      has_photo: false,
      has_microchip: opts.microchipId !== null,
      custody_kind: "shelter_custody_by_org",
    });

    await tx.insert(petEvents).values({
      petId: newPet.id,
      eventType: "pet_registered",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: userId!,
      authorRole: "shelter",
      authorVerified: true,
      payload: registeredPayload,
    });

    // Canonical dual-write — same code path as createIntakeAction.
    if (opts.microchipId) {
      const chipCode = opts.microchipId;
      const implantSite = chipImplantSiteFromLocation(null);
      // EVENT FIRST — validate + insert the microchip_implanted event exactly as
      // create-intake.ts does. Regression guard (QA 2026-07-08): the intake
      // payload MUST carry country_code / implanted_by / location_on_body as
      // explicit (nullable) keys, or the strict schema rejects it with
      // invalid_type and the intake crashes with a raw zod error.
      const microchipEventPayload = validateEventPayload("microchip_implanted", {
        chip_number: chipCode,
        country_code: null,
        implanted_by: null,
        location_on_body: null,
        implant_date_known: false,
      });
      await tx.insert(petEvents).values({
        petId: newPet.id,
        eventType: "microchip_implanted",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: userId!,
        authorRole: "shelter",
        authorVerified: true,
        payload: microchipEventPayload,
      });
      await tx.insert(petIdentifications).values({
        petId: newPet.id,
        kind: "microchip_iso",
        code: chipCode,
        recordedAt: now.toISOString().slice(0, 10),
        recordedByUserId: userId,
        isoCountryCode: chipCode.slice(0, 3),
        isoManufacturerCode: chipCode.slice(3, 7),
        isoNationalId: chipCode.slice(7, 15),
        isoCompliant: true,
        implantationSite: implantSite ?? undefined,
      });
    }

    if (opts.tattooCode) {
      await tx.insert(petIdentifications).values({
        petId: newPet.id,
        kind: "tattoo",
        code: opts.tattooCode,
        recordedAt: now.toISOString().slice(0, 10),
        recordedByUserId: userId,
      });
    }

    // Assign back so afterEach can clean up.
    if (opts.microchipId && !opts.tattooCode) petWithChipId = newPet.id;
    else if (opts.tattooCode && !opts.microchipId) petWithTattooId = newPet.id;
    else petWithBothId = newPet.id;
  });

  // Return the pet id — query it from the token.
  const [row] = await db
    .select({ id: pets.id })
    .from(pets)
    .where(eq(pets.publicToken, publicToken));
  return row.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("intake canonical dual-write — microchip only", () => {
  it("inserts an active microchip_iso row in pet_identifications", async () => {
    const petId = await simulateIntake({ microchipId: CHIP_INTAKE, tattooCode: null });

    const rows = await db
      .select()
      .from(petIdentifications)
      .where(eq(petIdentifications.petId, petId));

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("microchip_iso");
    expect(rows[0].code).toBe(CHIP_INTAKE);
    expect(rows[0].status).toBe("active");
    expect(rows[0].isoCountryCode).toBe(CHIP_INTAKE.slice(0, 3));
    expect(rows[0].isoManufacturerCode).toBe(CHIP_INTAKE.slice(3, 7));
    expect(rows[0].isoNationalId).toBe(CHIP_INTAKE.slice(7, 15));
    expect(rows[0].isoCompliant).toBe(true);
  });
});

describe("intake canonical dual-write — tattoo only", () => {
  it("inserts an active tattoo row in pet_identifications", async () => {
    const petId = await simulateIntake({ microchipId: null, tattooCode: TATTOO_INTAKE });

    const rows = await db
      .select()
      .from(petIdentifications)
      .where(eq(petIdentifications.petId, petId));

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("tattoo");
    expect(rows[0].code).toBe(TATTOO_INTAKE);
    expect(rows[0].status).toBe("active");
  });
});

describe("intake canonical dual-write — chip + tattoo", () => {
  it("inserts both microchip_iso and tattoo rows in pet_identifications", async () => {
    const petId = await simulateIntake({
      microchipId: CHIP_INTAKE,
      tattooCode: TATTOO_INTAKE,
    });

    const rows = await db
      .select()
      .from(petIdentifications)
      .where(eq(petIdentifications.petId, petId));

    expect(rows).toHaveLength(2);
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["microchip_iso", "tattoo"]);

    const chipRow = rows.find((r) => r.kind === "microchip_iso")!;
    expect(chipRow.code).toBe(CHIP_INTAKE);
    expect(chipRow.status).toBe("active");
    expect(chipRow.isoCountryCode).toBe(CHIP_INTAKE.slice(0, 3));

    const tattooRow = rows.find((r) => r.kind === "tattoo")!;
    expect(tattooRow.code).toBe(TATTOO_INTAKE);
    expect(tattooRow.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// microchip_implanted payload schema — pure regression (no DB)
//
// QA 2026-07-08: org intake WITH a chip crashed with a raw zod error
// ("country_code/implanted_by/location_on_body invalid_type") because the
// intake writer omitted those nullable-but-required keys. These pure asserts
// pin the exact contract so the fix cannot silently regress.
// ---------------------------------------------------------------------------

describe("intake microchip_implanted payload — schema contract", () => {
  it("passes when the nullable keys are present (the intake shape)", () => {
    expect(() =>
      validateEventPayload("microchip_implanted", {
        chip_number: CHIP_INTAKE,
        country_code: null,
        implanted_by: null,
        location_on_body: null,
        implant_date_known: false,
      }),
    ).not.toThrow();
  });

  it("throws when country_code / implanted_by / location_on_body are omitted (the pre-fix bug)", () => {
    expect(() =>
      validateEventPayload("microchip_implanted", {
        chip_number: CHIP_INTAKE,
        implant_date_known: false,
      }),
    ).toThrow(/invalid_type|country_code|implanted_by|location_on_body/);
  });
});
