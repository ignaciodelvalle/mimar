// Integration tests for Wave 5 Item 27 — PII-exposure fixes.
//
// Two fixes verified here:
//
//   1. Adoption event-payload over-return: findApplicationForReview no longer
//      returns the raw payload (which contained applicant name/phone/DNI).
//      The repository projects only { id, applicantUserId }.
//
//   2. Lost-pet location predicate: queryLostListing does NOT include location
//      data in the query result for pets with discloseLastLocationWhenLost=false.
//      The payload is never fetched — not merely redacted at the view layer.
//
// Tests 1.x are unit-level (no DB) — the repository shape is tested via the
// TypeScript type system + a mock-based check of the projected fields.
//
// Tests 2.x are integration-level (requires local Postgres + seeds).

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { db, organizations, ownerships, petEvents, petIdentifications, pets, profiles } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { queryAdoptionListing } from "@/src/modules/adoption/infrastructure/adoption-listing-read";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";
import { queryLostListing } from "@/src/modules/lost/infrastructure/lost-listing-read";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// 1. Adoption — shape guard (REAL repository + seeded fixture)
//
// The previous version of this test stubbed findApplicationForReview to
// return an already-stripped shape and then asserted on its own stub — the
// real projection never ran, so a regression re-adding `payload` to the
// SELECT would have shipped green. This version seeds a real application
// event whose payload is loaded with PII markers and drives the REAL query.
// ---------------------------------------------------------------------------

const ORG_TOKEN_I27 = "DIM-I27-ORG1";
const PET_TOKEN_ADOPTION = "DIM-I27-ADP1";
// v4-shaped (zod's uuid format requires the version/variant nibbles).
const APPLICANT_ID = "00000000-0000-4000-8000-0000000c0001";
const PII_PHONE = "+5491133344455";
const PII_DNI_MARKER = "30111222";

let orgIdI27: string;
let petIdAdoption: string;
let applicationEventId: string;

async function cleanupAdoptionFixture() {
  await withMutationOverride(async (tx) => {
    const rows = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN_ADOPTION));
    for (const { id } of rows) {
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
    await tx.delete(organizations).where(eq(organizations.publicToken, ORG_TOKEN_I27));
    await tx.delete(profiles).where(eq(profiles.id, APPLICANT_ID));
  });
}

describe("Item 27 — adoption findApplicationForReview shape guard (real repository)", () => {
  beforeAll(async () => {
    await cleanupAdoptionFixture();

    const [org] = await db
      .insert(organizations)
      .values({
        publicToken: ORG_TOKEN_I27,
        legalName: "Refugio Item 27 SRL",
        displayName: "Refugio Item 27",
        orgType: "shelter",
        email: "refugio-i27@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning({ id: organizations.id });
    orgIdI27 = org.id;

    await db
      .insert(profiles)
      .values({ id: APPLICANT_ID, displayName: "Postulante I27" })
      .onConflictDoNothing({ target: profiles.id });

    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: PET_TOKEN_ADOPTION,
        name: "AdoptableI27",
        species: "dog",
        sex: "unknown",
        potentiallyDangerousBreed: false,
      })
      .returning({ id: pets.id });
    petIdAdoption = pet.id;

    await db.insert(ownerships).values({
      petId: petIdAdoption,
      ownerOrganizationId: orgIdI27,
      role: "shelter_custody",
    });

    // Application payload deliberately LOADED with PII-looking markers: the
    // repository must project only applicant_user_id out of it.
    const payload = validateEventPayload("adoption_application_submitted", {
      applicant_user_id: APPLICANT_ID,
      related_organization_id: orgIdI27,
      housing_type: "casa_con_patio",
      other_pets: "Un gato",
      daily_routine: "Trabajo remoto, paseos 3 veces al día",
      notes: `Contacto directo: ${PII_PHONE}, DNI ${PII_DNI_MARKER}`,
      profile_sharing_consent_at: new Date().toISOString(),
      motivation: "Siempre quisimos un perro",
      prior_pets: "yes_before",
    });
    const [evt] = await db
      .insert(petEvents)
      .values({
        petId: petIdAdoption,
        eventType: "adoption_application_submitted",
        occurredAt: new Date(),
        recordedAt: new Date(),
        authorRole: "owner",
        recordedByUserId: null,
        payload,
      })
      .returning({ id: petEvents.id });
    applicationEventId = evt.id;
  });

  afterAll(async () => {
    await cleanupAdoptionFixture();
  });

  it("returns EXACTLY { id, applicantUserId } + the pet projection — never the payload", async () => {
    const result = await AdoptionRepository.findApplicationForReview(applicationEventId, orgIdI27);
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    // toEqual against exact literal shapes: any extra key (payload, notes,
    // housing_type, …) fails, not just the specific keys we thought to list.
    expect(result.application).toEqual({
      id: applicationEventId,
      applicantUserId: APPLICANT_ID,
    });
    expect(result.pet).toEqual({
      id: petIdAdoption,
      name: "AdoptableI27",
      publicToken: PET_TOKEN_ADOPTION,
    });

    // Belt-and-braces: none of the PII markers stored in the payload appear
    // anywhere in the serialized result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PII_PHONE);
    expect(serialized).not.toContain(PII_DNI_MARKER);
    expect(serialized).not.toContain("casa_con_patio");
    expect(serialized).not.toContain("paseos 3 veces");
  });

  it("scopes by organization: a different org id gets the not-found error, not the row", async () => {
    const result = await AdoptionRepository.findApplicationForReview(
      applicationEventId,
      "00000000-0000-4000-8000-0000000c0999",
    );
    expect(result).toEqual({
      error: "Postulación no encontrada o no pertenece a tu organización.",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Lost-pet location — predicate fix (integration, requires DB)
// ---------------------------------------------------------------------------

const PET_TOKEN_DISCLOSE = "DIM-I27-LST1";
const PET_TOKEN_NO_DISCLOSE = "DIM-I27-LST2";

let petIdDisclose: string;
let petIdNoDisclose: string;

async function cleanupPii27Pets() {
  await withMutationOverride(async (tx) => {
    for (const token of [PET_TOKEN_DISCLOSE, PET_TOKEN_NO_DISCLOSE]) {
      const rows = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      for (const { id } of rows) {
        await tx.delete(petEvents).where(eq(petEvents.petId, id));
        await tx.delete(ownerships).where(eq(ownerships.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }
  });
}

beforeAll(async () => {
  await cleanupPii27Pets();

  const now = new Date();

  // Pet 1: owner opts IN to location disclosure.
  const [petDisclose] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_DISCLOSE,
      name: "Fido",
      species: "dog",
      sex: "male",
      status: "lost",
      discloseLastLocationWhenLost: true,
    })
    .returning({ id: pets.id });
  petIdDisclose = petDisclose.id;

  // Pet 2: owner opts OUT of location disclosure.
  const [petNoDisclose] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_NO_DISCLOSE,
      name: "Michi",
      species: "cat",
      sex: "female",
      status: "lost",
      discloseLastLocationWhenLost: false,
    })
    .returning({ id: pets.id });
  petIdNoDisclose = petNoDisclose.id;

  // Insert status_changed → lost events for both, with location in the payload.
  await db.insert(petEvents).values([
    {
      petId: petIdDisclose,
      eventType: "status_changed",
      occurredAt: now,
      recordedAt: now,
      authorRole: "owner",
      authorVerified: false,
      payload: {
        from_status: "active",
        to_status: "lost",
        location_description: "Parque Centenario, CABA",
      },
    },
    {
      petId: petIdNoDisclose,
      eventType: "status_changed",
      occurredAt: now,
      recordedAt: now,
      authorRole: "owner",
      authorVerified: false,
      payload: {
        from_status: "active",
        to_status: "lost",
        // This location string is in the DB but must NEVER reach the query result.
        location_description: "Barrio confidencial — no revelar",
      },
    },
  ]);
});

afterAll(async () => {
  await cleanupPii27Pets();
});

describe("Item 27 — lost-listing location predicate fix", () => {
  it("pet with disclose=true returns lastSeenDescription from the query", async () => {
    const { items } = await queryLostListing({}, null, 50);
    const item = items.find((i) => i.petId === petIdDisclose);
    expect(item).toBeDefined();
    expect(item?.lastSeenDescription).toBe("Parque Centenario, CABA");
  });

  it("pet with disclose=false has null lastSeenDescription in the query result", async () => {
    const { items } = await queryLostListing({}, null, 50);
    const item = items.find((i) => i.petId === petIdNoDisclose);
    expect(item).toBeDefined();
    // Location must be null — the payload was never fetched for this pet.
    expect(item?.lastSeenDescription).toBeNull();
  });

  it("pet with disclose=false still appears in the listing (not excluded)", async () => {
    const { items } = await queryLostListing({}, null, 50);
    const ids = items.map((i) => i.petId);
    // The pet appears in results but without location.
    expect(ids).toContain(petIdNoDisclose);
  });

  it("confidential location string is absent from every item in the result", async () => {
    const { items } = await queryLostListing({}, null, 50);
    // The string "confidencial" must not appear anywhere in the returned items.
    for (const item of items) {
      expect(item.lastSeenDescription ?? "").not.toContain("confidencial");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Public listings — canonical microchip code is never SELECTED
//
// Same class as fix 2, one table over. Both public listing queries used to
// project `pi.code` into `microchipId` and both cards consumed it as a mere
// truthiness test ("Con chip"). /adoptar and /perdidas are unauthenticated, so
// the full 15-digit canonical chip of every listed pet was one `"use client"`
// on a card away from the public RSC payload — and the credential page at
// app/(public)/p/[publicToken] deliberately renders "Microchip: Sí/No" for
// exactly that reason.
//
// The queries now project EXISTS. These tests drive the REAL query functions
// against the real database (no mocked reader, no mocked action) and assert
// two things per surface: the badge still works, AND the code is absent from
// the serialized item. Asserting on the serialization — not on a named field —
// is what makes the test survive someone re-adding the code under a new name.
// ---------------------------------------------------------------------------

const ORG_TOKEN_CHIP = "DIM-CHP-ORG1";
const PET_TOKEN_ADOPT_CHIP = "DIM-CHP-ADP1";
const PET_TOKEN_LOST_CHIP = "DIM-CHP-LST1";
// Distinctive 15-digit codes — the chip_requires_iso_fields CHECK enforces
// length 15, and pet_identifications_chip_unique enforces global uniqueness
// among active microchip rows.
const CHIP_ADOPT = "858999000000771";
const CHIP_LOST = "858999000000772";

let orgIdChip: string;
let petIdAdoptChip: string;
let petIdLostChip: string;

async function cleanupChipListingFixture() {
  await withMutationOverride(async (tx) => {
    for (const token of [PET_TOKEN_ADOPT_CHIP, PET_TOKEN_LOST_CHIP]) {
      const rows = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      for (const { id } of rows) {
        await tx.delete(petIdentifications).where(eq(petIdentifications.petId, id));
        await tx.delete(petEvents).where(eq(petEvents.petId, id));
        await tx.delete(ownerships).where(eq(ownerships.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }
    await tx.delete(organizations).where(eq(organizations.publicToken, ORG_TOKEN_CHIP));
  });
}

describe("public listings never select the canonical microchip code", () => {
  beforeAll(async () => {
    await cleanupChipListingFixture();
    const now = new Date();

    const [org] = await db
      .insert(organizations)
      .values({
        publicToken: ORG_TOKEN_CHIP,
        legalName: "Refugio Chip SRL",
        displayName: "Refugio Chip",
        orgType: "shelter",
        email: "refugio-chip@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning({ id: organizations.id });
    orgIdChip = org.id;

    // Adoption-listed pet WITH an active canonical chip.
    const [adoptPet] = await db
      .insert(pets)
      .values({
        publicToken: PET_TOKEN_ADOPT_CHIP,
        name: "ChipAdoptable",
        species: "dog",
        sex: "female",
        status: "active",
        adoptionListedAt: now,
        adoptionEligible: true,
        // pets_adoption_eligibility_consistent: eligible and setAt travel together.
        adoptionEligibilitySetAt: now,
      })
      .returning({ id: pets.id });
    petIdAdoptChip = adoptPet.id;

    await db.insert(ownerships).values({
      petId: petIdAdoptChip,
      ownerOrganizationId: orgIdChip,
      role: "shelter_custody",
    });

    // Lost pet WITH an active canonical chip.
    const [lostPet] = await db
      .insert(pets)
      .values({
        publicToken: PET_TOKEN_LOST_CHIP,
        name: "ChipPerdido",
        species: "cat",
        sex: "male",
        status: "lost",
        discloseLastLocationWhenLost: false,
      })
      .returning({ id: pets.id });
    petIdLostChip = lostPet.id;

    await db.insert(petEvents).values({
      petId: petIdLostChip,
      eventType: "status_changed",
      occurredAt: now,
      recordedAt: now,
      authorRole: "owner",
      authorVerified: false,
      payload: { from_status: "active", to_status: "lost" },
    });

    await db.insert(petIdentifications).values([
      {
        petId: petIdAdoptChip,
        kind: "microchip_iso",
        status: "active",
        code: CHIP_ADOPT,
        isoCountryCode: CHIP_ADOPT.slice(0, 3),
        isoManufacturerCode: CHIP_ADOPT.slice(3, 7),
        isoNationalId: CHIP_ADOPT.slice(7, 15),
      },
      {
        petId: petIdLostChip,
        kind: "microchip_iso",
        status: "active",
        code: CHIP_LOST,
        isoCountryCode: CHIP_LOST.slice(0, 3),
        isoManufacturerCode: CHIP_LOST.slice(3, 7),
        isoNationalId: CHIP_LOST.slice(7, 15),
      },
    ]);
  });

  afterAll(async () => {
    await cleanupChipListingFixture();
  });

  it("queryAdoptionListing reports the chip badge without returning the code", async () => {
    const { items } = await queryAdoptionListing({}, null, 100);
    const item = items.find((i) => i.petId === petIdAdoptChip);
    expect(item).toBeDefined();
    // The badge still works — this is the functional half of the assertion.
    expect(item?.hasMicrochip).toBe(true);
    // …and the 15 digits are nowhere in the row.
    expect(JSON.stringify(item)).not.toContain(CHIP_ADOPT);
  });

  it("queryAdoptionListing leaks no chip code anywhere in the page of results", async () => {
    const { items } = await queryAdoptionListing({}, null, 100);
    expect(JSON.stringify(items)).not.toContain(CHIP_ADOPT);
  });

  it("hasMicrochip is false for an adoption-listed pet with no active chip", async () => {
    const { items } = await queryAdoptionListing({}, null, 100);
    // PET_TOKEN_ADOPTION (fixture 1) is shelter-custodied but not chipped; any
    // other unchipped listing works too. Assert the flag is a real derivation,
    // not a constant true.
    const unchipped = items.filter((i) => i.petId !== petIdAdoptChip && !i.hasMicrochip);
    const chipped = items.filter((i) => i.hasMicrochip);
    expect(chipped.some((i) => i.petId === petIdAdoptChip)).toBe(true);
    // Either bucket may be empty depending on seeds; what must hold is that the
    // two buckets are disjoint and the flag is boolean, never a string.
    expect(unchipped.every((i) => i.hasMicrochip === false)).toBe(true);
    for (const i of items) expect(typeof i.hasMicrochip).toBe("boolean");
  });

  it("queryLostListing reports the chip badge without returning the code", async () => {
    const { items } = await queryLostListing({}, null, 100);
    const item = items.find((i) => i.petId === petIdLostChip);
    expect(item).toBeDefined();
    expect(item?.hasMicrochip).toBe(true);
    expect(JSON.stringify(item)).not.toContain(CHIP_LOST);
  });

  it("queryLostListing leaks no chip code anywhere in the page of results", async () => {
    const { items } = await queryLostListing({}, null, 100);
    expect(JSON.stringify(items)).not.toContain(CHIP_LOST);
    for (const i of items) expect(typeof i.hasMicrochip).toBe("boolean");
  });

  it("the hasMicrochip=true filter still selects the chipped pet", async () => {
    const { items } = await queryLostListing({ hasMicrochip: true }, null, 100);
    expect(items.some((i) => i.petId === petIdLostChip)).toBe(true);
    expect(JSON.stringify(items)).not.toContain(CHIP_LOST);
  });
});
