// P0c integration tests — sightingsCount + unified feed for lost_pet_episode.
//
// Pure Zod unit tests for the noteAdded schema live in
// __tests__/lost-mode-sightings-unit.test.ts.
//
// This file covers DB-dependent tests only:
//   - Create a pet + open episode + insert sighting notes, assert
//     sightingsCount === 3 and that the unified feed contains both scan and
//     sighting kinds.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { fetchLostEpisodeForPet, fetchLostScanEvents } from "@/lib/infra/lost-mode";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Integration tests — real COUNT + feed queries
// ---------------------------------------------------------------------------

const PET_TOKEN = "DIM-P0C-SIGHTING-1";

let petId: string;
let caseId: string;
let episodeOpenedAt: Date;

beforeAll(async () => {
  // Clean up any leftover fixture rows.
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  });

  // Create the pet.
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "SightingTestDog",
      species: "dog",
      sex: "unknown",
      status: "lost",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;

  episodeOpenedAt = new Date();

  // Open a lost_pet_episode case + insert the originating status_changed event.
  await db.transaction(async (tx) => {
    const caseRow = await openCase(
      {
        kind: "lost_pet_episode",
        primarySubjectKind: "registered_pet",
        primaryPetId: petId,
        openedReason: {
          code: "pet_marked_lost",
          petPublicToken: null,
          ownerNote: "fixture de avistamiento",
        },
      },
      tx,
    );
    caseId = caseRow.id;

    const statusPayload = validateEventPayload("status_changed", {
      from_status: "active",
      to_status: "lost",
      location_description: null,
      reason: null,
      disclosure_prefs_snapshot: {
        first_name: true,
        phone: false,
        email: false,
        last_location: true,
        finder_form: true,
      },
    });
    await tx.insert(petEvents).values({
      petId,
      eventType: "status_changed",
      occurredAt: episodeOpenedAt,
      recordedAt: episodeOpenedAt,
      authorRole: "owner",
      payload: statusPayload,
      caseId: caseRow.id,
    });
  });

  // Insert 3 sighting note_added events AFTER episodeOpenedAt.
  const sightingBase = {
    petId,
    // Scope to the open case — production (reportPetSightingAction) sets this,
    // and fetchLostEpisodeForPet counts sightings via eq(petEvents.caseId, ...).
    caseId,
    eventType: "note_added" as const,
    recordedAt: new Date(),
    authorRole: "scanner" as const,
    authorVerified: false,
    recordedByUserId: null,
  };

  for (let i = 0; i < 3; i++) {
    const sightingPayload = validateEventPayload("note_added", {
      category: "otro" as const,
      text: `Vi al perro cerca del parque. Avistaje ${i + 1}.`,
      kind: "sighting" as const,
    });
    await db.insert(petEvents).values({
      ...sightingBase,
      occurredAt: new Date(episodeOpenedAt.getTime() + (i + 1) * 60_000),
      payload: sightingPayload,
      locationLat: "-34.900" as unknown as null, // numeric column accepts string
      locationLng: "-57.950" as unknown as null,
    });
  }

  // Insert 1 credential_scanned event (non-self) after episode opened.
  const scanPayload = validateEventPayload("credential_scanned", {
    is_self_scan: false,
    viewer_authenticated: false,
  });
  await db.insert(petEvents).values({
    petId,
    eventType: "credential_scanned",
    occurredAt: new Date(episodeOpenedAt.getTime() + 5 * 60_000),
    recordedAt: new Date(),
    authorRole: "scanner",
    payload: scanPayload,
  });

  // Insert 1 finder_in_possession event (the handoff crux — UI-4 fix 2).
  // Occurs BEFORE the sightings so we can also assert it sorts to the TOP.
  const possessionPayload = validateEventPayload("note_added", {
    category: "otro" as const,
    text: "Tengo a este perro en casa.",
    kind: "finder_in_possession" as const,
    finderName: "Vecina Ana",
    finderContact: "11-5555-9999",
    photoStoragePath: null,
    location: {
      localityName: "La Plata",
      provinceCode: "BA",
      provinceName: "Buenos Aires",
    },
    petCondition: "bien" as const,
    canKeepUntil: null,
    canKeepIndefinite: true,
    message: "Está tranquilo, lo tengo a salvo.",
  });
  await db.insert(petEvents).values({
    ...sightingBase,
    occurredAt: new Date(episodeOpenedAt.getTime() + 30_000), // earlier than sightings
    payload: possessionPayload,
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
    if (caseId) {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${caseId}`);
    }
    await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
  });
});

describe("fetchLostEpisodeForPet — sightingsCount", () => {
  it("returns sightingsCount === 3 for 3 sighting note_added events after episode open", async () => {
    const episode = await fetchLostEpisodeForPet(petId);
    expect(episode).not.toBeNull();
    expect(episode!.sightingsCount).toBe(3);
  });
});

describe("fetchLostScanEvents — unified feed", () => {
  it("returns items of both 'scan' and 'sighting' kinds when both exist", async () => {
    const items = await fetchLostScanEvents(petId, episodeOpenedAt);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("scan");
    expect(kinds).toContain("sighting");
  });

  it("returns exactly 3 sighting items", async () => {
    const items = await fetchLostScanEvents(petId, episodeOpenedAt);
    const sightings = items.filter((i) => i.kind === "sighting");
    expect(sightings).toHaveLength(3);
  });

  it("returns exactly 1 scan item", async () => {
    const items = await fetchLostScanEvents(petId, episodeOpenedAt);
    const scans = items.filter((i) => i.kind === "scan");
    expect(scans).toHaveLength(1);
  });

  it("items are sorted DESC by at within the non-finder group", async () => {
    const items = await fetchLostScanEvents(petId, episodeOpenedAt);
    const nonFinder = items.filter((i) => i.kind !== "finder");
    for (let i = 1; i < nonFinder.length; i++) {
      expect(nonFinder[i - 1].at.getTime()).toBeGreaterThanOrEqual(nonFinder[i].at.getTime());
    }
  });

  it("includes the finder_in_possession event mapped to a 'finder' item", async () => {
    const items = await fetchLostScanEvents(petId, episodeOpenedAt);
    const finders = items.filter((i) => i.kind === "finder");
    expect(finders).toHaveLength(1);
    const finder = finders[0] as Extract<
      Awaited<ReturnType<typeof fetchLostScanEvents>>[number],
      { kind: "finder" }
    >;
    expect(finder.finderName).toBe("Vecina Ana");
    expect(finder.finderContact).toBe("11-5555-9999");
    expect(finder.petCondition).toBe("bien");
    expect(finder.localityLabel).toBe("La Plata, Buenos Aires");
    expect(finder.availabilityLabel).toBe("indefinido");
    expect(finder.message).toContain("a salvo");
  });

  it("sorts finder_in_possession to the TOP even when it is older than sightings", async () => {
    const items = await fetchLostScanEvents(petId, episodeOpenedAt);
    expect(items[0].kind).toBe("finder");
  });
});
