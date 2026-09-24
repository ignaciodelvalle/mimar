// QA 2026-08-03 — "Última dirección aparece como no determinada incluso
// cuando sí se la seteó al perderse y luego una vez más en editar".
//
// Root cause: "actualizar última ubicación" appends a note_added(kind=
// 'sighting') event (append-only invariant), but fetchLostEpisodeForPet only
// read the originating status_changed event — so owner edits never surfaced.
// These integration tests pin the overlay:
//   - the latest OWNER-authored update carrying location data wins over the
//     origin event; anonymous finder sightings (authorRole='scanner') never do;
//   - the replacement is ATOMIC (fresh-review F4): place, coords and
//     timestamp all come from the chosen event — a text-only update must not
//     relabel the origin pin, and a pin-only update must not resurrect a
//     superseded address.
//
// Sibling of __tests__/lost-mode-sightings.test.ts (same fixture pattern);
// separate file because the overlay fixtures need their own event timelines.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { fetchLostEpisodeForPet } from "@/lib/infra/lost-mode";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-QA-OVERLAY-1";
// Atomic-replacement fixtures (fresh-review F4): text-only and pin-only
// owner updates must replace the last-seen record as a UNIT, never mix
// fields across events.
const PET_TOKEN_TEXT_ONLY = "DIM-QA-OVERLAY-2";
const PET_TOKEN_PIN_ONLY = "DIM-QA-OVERLAY-3";
const ALL_TOKENS = [PET_TOKEN, PET_TOKEN_TEXT_ONLY, PET_TOKEN_PIN_ONLY];

let petId: string;
let episodeOpenedAt: Date;
let ownerUpdateAt: Date;
let textOnlyPetId: string;
let pinOnlyPetId: string;
const cleanupPetIds: string[] = [];
const cleanupCaseIds: string[] = [];

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function createLostPet(
  token: string,
  origin: { address: string | null; lat?: string; lng?: string; reason?: string },
  openedAt: Date,
): Promise<{ petId: string; caseId: string }> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `OverlayTestDog-${token.slice(-1)}`,
      species: "dog",
      sex: "unknown",
      status: "lost",
      potentiallyDangerousBreed: false,
    })
    .returning();

  let createdCaseId = "";
  await db.transaction(async (tx) => {
    const caseRow = await openCase(
      {
        kind: "lost_pet_episode",
        primarySubjectKind: "registered_pet",
        primaryPetId: pet.id,
        openedReason: {
          code: "pet_marked_lost",
          petPublicToken: null,
          ownerNote: "fixture de overlay",
        },
      },
      tx,
    );
    createdCaseId = caseRow.id;

    const statusPayload = validateEventPayload("status_changed", {
      from_status: "active",
      to_status: "lost",
      location_description: origin.address,
      reason: origin.reason ?? null,
      disclosure_prefs_snapshot: {
        first_name: true,
        phone: false,
        email: false,
        last_location: true,
        finder_form: true,
      },
    });
    await tx.insert(petEvents).values({
      petId: pet.id,
      eventType: "status_changed",
      occurredAt: openedAt,
      recordedAt: openedAt,
      authorRole: "owner",
      payload: statusPayload,
      caseId: caseRow.id,
      locationLat: (origin.lat ?? null) as unknown as null,
      locationLng: (origin.lng ?? null) as unknown as null,
    });
  });

  cleanupPetIds.push(pet.id);
  cleanupCaseIds.push(createdCaseId);
  return { petId: pet.id, caseId: createdCaseId };
}

async function addOwnerUpdate(
  targetPetId: string,
  targetCaseId: string,
  occurredAt: Date,
  update: { text: string; address?: string | null; lat?: string; lng?: string },
): Promise<void> {
  await db.insert(petEvents).values({
    petId: targetPetId,
    caseId: targetCaseId,
    eventType: "note_added",
    occurredAt,
    recordedAt: new Date(),
    authorRole: "owner",
    authorVerified: false,
    payload: validateEventPayload("note_added", {
      category: "otro",
      text: update.text,
      kind: "sighting",
      location_description: update.address ?? null,
    }),
    locationLat: (update.lat ?? null) as unknown as null,
    locationLng: (update.lng ?? null) as unknown as null,
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const token of ALL_TOKENS) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${token}`);
    }
  });

  episodeOpenedAt = new Date();

  // Pet 1 — the QA scenario: origin address (no pin), an older text-only
  // update (no location data at all), a newer full update (address + pin),
  // and an even newer ANONYMOUS finder sighting with a pin.
  const p1 = await createLostPet(
    PET_TOKEN,
    { address: "Plaza Italia", reason: "Se escapó del patio" },
    episodeOpenedAt,
  );
  petId = p1.petId;

  await addOwnerUpdate(p1.petId, p1.caseId, new Date(episodeOpenedAt.getTime() + 60_000), {
    text: "Sigue sin aparecer.",
  });

  ownerUpdateAt = new Date(episodeOpenedAt.getTime() + 120_000);
  await addOwnerUpdate(p1.petId, p1.caseId, ownerUpdateAt, {
    text: "Parque Saavedra — la vieron cerca del lago",
    address: "Parque Saavedra",
    lat: "-34.910",
    lng: "-57.940",
  });

  // Newer ANONYMOUS finder sighting with a pin — must never become the
  // headline location (unvetted).
  await db.insert(petEvents).values({
    petId: p1.petId,
    caseId: p1.caseId,
    eventType: "note_added",
    occurredAt: new Date(episodeOpenedAt.getTime() + 180_000),
    recordedAt: new Date(),
    authorRole: "scanner",
    authorVerified: false,
    recordedByUserId: null,
    payload: validateEventPayload("note_added", {
      category: "otro",
      text: "Vi un perro parecido por el centro.",
      kind: "sighting",
    }),
    locationLat: "-34.600" as unknown as null,
    locationLng: "-58.380" as unknown as null,
  });

  // Pet 2 — F4(a): origin has address + PIN; the newest owner update carries
  // an address but NO pin. Atomic replacement → coords must become null, not
  // keep the origin pin under the new label.
  const p2 = await createLostPet(
    PET_TOKEN_TEXT_ONLY,
    { address: "Plaza Moreno", lat: "-34.921", lng: "-57.954" },
    episodeOpenedAt,
  );
  textOnlyPetId = p2.petId;
  await addOwnerUpdate(p2.petId, p2.caseId, new Date(episodeOpenedAt.getTime() + 60_000), {
    text: "Estación Once",
    address: "Estación Once",
  });

  // Pet 3 — F4(b): an address-carrying update followed by a NEWER pin-only
  // update. Atomic replacement → placeName must become null (the superseded
  // address must not be resurrected), coords come from the pin-only update.
  const p3 = await createLostPet(PET_TOKEN_PIN_ONLY, { address: "Plaza Rocha" }, episodeOpenedAt);
  pinOnlyPetId = p3.petId;
  await addOwnerUpdate(p3.petId, p3.caseId, new Date(episodeOpenedAt.getTime() + 60_000), {
    text: "Calle Falsa 123",
    address: "Calle Falsa 123",
  });
  await addOwnerUpdate(p3.petId, p3.caseId, new Date(episodeOpenedAt.getTime() + 120_000), {
    text: "El dueño actualizó la última ubicación conocida.",
    lat: "-34.700",
    lng: "-58.100",
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const id of cleanupPetIds) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${id}`);
    }
    for (const id of cleanupCaseIds) {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${id}`);
    }
    for (const id of cleanupPetIds) {
      await tx.execute(sql`DELETE FROM pets WHERE id = ${id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchLostEpisodeForPet — owner last-seen overlay", () => {
  it("overlays placeName with the latest owner update that carries an address", async () => {
    const episode = await fetchLostEpisodeForPet(petId);
    expect(episode).not.toBeNull();
    expect(episode!.placeName).toBe("Parque Saavedra");
  });

  it("overlays coords from the owner update, ignoring the newer anonymous sighting", async () => {
    const episode = await fetchLostEpisodeForPet(petId);
    expect(Number(episode!.lastSeenLat)).toBeCloseTo(-34.91, 2);
    expect(Number(episode!.lastSeenLng)).toBeCloseTo(-57.94, 2);
  });

  it("moves lastSeenAt to the owner update's occurredAt", async () => {
    const episode = await fetchLostEpisodeForPet(petId);
    // Postgres timestamp precision can shave sub-millisecond detail.
    expect(Math.abs(episode!.lastSeenAt.getTime() - ownerUpdateAt.getTime())).toBeLessThan(1000);
  });

  it("keeps the origin ownerNote (the overlay only replaces location fields)", async () => {
    const episode = await fetchLostEpisodeForPet(petId);
    expect(episode!.ownerNote).toBe("Se escapó del patio");
  });
});

describe("fetchLostEpisodeForPet — atomic replacement (fresh-review F4)", () => {
  it("text-only address update replaces the record as a unit: origin pin is dropped", async () => {
    const episode = await fetchLostEpisodeForPet(textOnlyPetId);
    expect(episode).not.toBeNull();
    expect(episode!.placeName).toBe("Estación Once");
    // The origin pin must NOT survive under the new address's label.
    expect(episode!.lastSeenLat).toBeNull();
    expect(episode!.lastSeenLng).toBeNull();
  });

  it("pin-only update wins as a unit: the superseded address is not resurrected", async () => {
    const episode = await fetchLostEpisodeForPet(pinOnlyPetId);
    expect(episode).not.toBeNull();
    expect(episode!.placeName).toBeNull();
    expect(Number(episode!.lastSeenLat)).toBeCloseTo(-34.7, 2);
    expect(Number(episode!.lastSeenLng)).toBeCloseTo(-58.1, 2);
  });
});
