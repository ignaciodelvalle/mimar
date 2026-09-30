// Real-DB tests for the travel writers (viajes-fase-2, design D4 / tasks 4.1-4.8).
//
// recordTrip / recordCvi / cancelTrip are shared by the web's Server Actions
// and `POST /api/v1/pets/{publicToken}/travel`; both doors are exercised here
// through the use-cases and through the v1 command runner.
//
// What each block pins:
//   · the event lands on the spine and no pets.* column moves (R6.2);
//   · a replay of the same idempotency key answers the first event, one row;
//   · trip_duplicate / cvi_duplicate refuse a second, different write;
//   · only a travel titular writes (caretaker, org path refused), never for a
//     deceased animal, never with an implausible date or an unknown airline;
//   · a cancellation is a correction — the original row is untouched and
//     deriveTrips drops the trip.

import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// amendEvent calls revalidatePath (request-scoped) after the write commits.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { db, ownerships, petEvents, pets, profiles } from "@/db";
import { OWNER_AUTHORSHIP } from "@/lib/infra/pet-access";
import { deriveTrips } from "@/lib/projections/travel-compliance";
import { isoDateInAr } from "@/lib/utils/format";
import { cancelTrip } from "@/src/modules/pets/application/travel/cancel-trip";
import { recordCvi } from "@/src/modules/pets/application/travel/record-cvi";
import { recordTrip } from "@/src/modules/pets/application/travel/record-trip";
import { loadOverlaidMovements } from "@/src/modules/pets/application/travel/travel-edge";
import type { TravelActor, TravelPet } from "@/src/modules/pets/application/travel/types";
import { runPetTravelCommand } from "../app/api/v1/pets/[publicToken]/travel/commands";
import { withMutationOverride } from "./_helpers/db-overrides";

const OWNER_ID = "33333333-4444-4555-8666-7777777700a1";
const CARETAKER_ID = "33333333-4444-4555-8666-7777777700a2";
const STRANGER_ID = "33333333-4444-4555-8666-7777777700a3";
const insertedPetIds: string[] = [];

const DAY_MS = 86_400_000;

/** An AR calendar day `offset` days from today. */
function day(offset: number): string {
  return isoDateInAr(new Date(Date.now() + offset * DAY_MS));
}

/** A fresh idempotency key. */
function key(): string {
  return crypto.randomUUID();
}

function ownerActor(): TravelActor {
  return {
    userId: OWNER_ID,
    accessPath: "owner",
    holderRole: "owner",
    eventAuthorship: OWNER_AUTHORSHIP,
  };
}

async function insertTestPet(suffix: string, status: "active" | "deceased" = "active") {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `TRAVELWR-${suffix}-${Date.now()}`,
      name: `ViajePet${suffix}`,
      species: "dog",
      sex: "female",
      status,
      jurisdictionCountry: "AR",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    })
    .returning();
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: OWNER_ID, role: "owner" });
  insertedPetIds.push(pet.id);
  return pet;
}

function travelPet(pet: Awaited<ReturnType<typeof insertTestPet>>): TravelPet {
  return { id: pet.id, publicToken: pet.publicToken, name: pet.name, status: pet.status };
}

async function movementRows(petId: string) {
  return db
    .select()
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "movement_recorded")))
    .orderBy(asc(petEvents.recordedAt));
}

async function ensureUser(id: string, label: string) {
  await db.execute(sql`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, aud, role)
    values (${id}::uuid, ${`${label}@dim-test.local`},
      'fake', now(), '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated')
    on conflict (id) do nothing
  `);
  await db
    .insert(profiles)
    .values({ id, role: "owner", accountType: "personal", displayName: label })
    .onConflictDoNothing();
}

beforeAll(async () => {
  await ensureUser(OWNER_ID, "travel-writers-owner");
  await ensureUser(CARETAKER_ID, "travel-writers-caretaker");
  await ensureUser(STRANGER_ID, "travel-writers-stranger");
});

afterAll(async () => {
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
});

describe("recordTrip", () => {
  it("appends one transport_recorded with airline and modality, and moves no pets.* column", async () => {
    const pet = await insertTestPet("TRIP");
    const result = await recordTrip({
      pet: travelPet(pet),
      actor: ownerActor(),
      input: {
        corridorId: "chile",
        travelDate: day(20),
        mode: null,
        airlineId: "latam",
        intendedModality: "cabin",
      },
      clientIdempotencyKey: key(),
    });
    expect(result).toMatchObject({ ok: true, replayed: false });

    const rows = await movementRows(pet.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      sub_kind: "transport_recorded",
      corridor_id: "chile",
      travel_date: day(20),
      // An airline implies an air trip (D4).
      mode: "air",
      airline_id: "latam",
      intended_modality: "cabin",
    });
    expect(rows[0].payload).not.toHaveProperty("cancelled");

    const [after] = await db.select().from(pets).where(eq(pets.id, pet.id));
    expect(after.jurisdictionProvince).toBe("CABA");
    expect(after.jurisdictionLocality).toBe("Palermo");
  });

  it("a replay of the same key answers the first event and appends nothing", async () => {
    const pet = await insertTestPet("REPLAY");
    const k = key();
    const params = {
      pet: travelPet(pet),
      actor: ownerActor(),
      input: {
        corridorId: "uruguay" as const,
        travelDate: day(10),
        mode: "land" as const,
        airlineId: null,
        intendedModality: null,
      },
      clientIdempotencyKey: k,
    };
    const first = await recordTrip(params);
    const second = await recordTrip(params);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.eventId).toBe(first.eventId);
    expect(second.replayed).toBe(true);
    expect(await movementRows(pet.id)).toHaveLength(1);
  });

  it("refuses the same corridor and day under a different key: trip_duplicate", async () => {
    const pet = await insertTestPet("DUP");
    const input = {
      corridorId: "brasil" as const,
      travelDate: day(15),
      mode: null,
      airlineId: null,
      intendedModality: null,
    };
    const first = await recordTrip({
      pet: travelPet(pet),
      actor: ownerActor(),
      input,
      clientIdempotencyKey: key(),
    });
    expect(first.ok).toBe(true);
    const second = await recordTrip({
      pet: travelPet(pet),
      actor: ownerActor(),
      input,
      clientIdempotencyKey: key(),
    });
    expect(second).toMatchObject({ ok: false, code: "trip_duplicate" });
    expect(await movementRows(pet.id)).toHaveLength(1);
  });

  it("refuses a caretaker, the org path, and a user-held custody row", async () => {
    const pet = await insertTestPet("AUTHZ");
    const input = {
      corridorId: "chile" as const,
      travelDate: day(5),
      mode: null,
      airlineId: null,
      intendedModality: null,
    };
    for (const actor of [
      { ...ownerActor(), holderRole: "caretaker" },
      { ...ownerActor(), holderRole: "shelter_custody" },
      { ...ownerActor(), accessPath: "org" as const, holderRole: null },
    ]) {
      const result = await recordTrip({
        pet: travelPet(pet),
        actor,
        input,
        clientIdempotencyKey: key(),
      });
      expect(result).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(await movementRows(pet.id)).toHaveLength(0);
  });

  it("admits a co-owner and a foster", async () => {
    const pet = await insertTestPet("COOWN");
    for (const [i, role] of (["co_owner", "foster"] as const).entries()) {
      const result = await recordTrip({
        pet: travelPet(pet),
        actor: { ...ownerActor(), holderRole: role },
        input: {
          corridorId: "usa",
          travelDate: day(30 + i),
          mode: null,
          airlineId: null,
          intendedModality: null,
        },
        clientIdempotencyKey: key(),
      });
      expect(result.ok, role).toBe(true);
    }
  });

  it("refuses a deceased animal, an implausible date and an unknown airline", async () => {
    const dead = await insertTestPet("DEAD", "deceased");
    const deadResult = await recordTrip({
      pet: travelPet(dead),
      actor: ownerActor(),
      input: {
        corridorId: "chile",
        travelDate: day(5),
        mode: null,
        airlineId: null,
        intendedModality: null,
      },
      clientIdempotencyKey: key(),
    });
    expect(deadResult).toMatchObject({ ok: false, code: "pet_deceased" });

    const pet = await insertTestPet("PLAUS");
    const base = {
      corridorId: "chile" as const,
      mode: null,
      airlineId: null,
      intendedModality: null,
    };
    for (const input of [
      { ...base, travelDate: day(-2) },
      { ...base, travelDate: day(366) },
      { ...base, travelDate: "2026-02-31" },
      { ...base, travelDate: day(5), airlineId: "not-an-airline" },
      { ...base, travelDate: day(5), airlineId: "latam", mode: "land" as const },
    ]) {
      const result = await recordTrip({
        pet: travelPet(pet),
        actor: ownerActor(),
        input,
        clientIdempotencyKey: key(),
      });
      expect(result, JSON.stringify(input)).toMatchObject({ ok: false, code: "input_invalid" });
    }
    // Yesterday is inside the window: the owner registering on arrival.
    const yesterday = await recordTrip({
      pet: travelPet(pet),
      actor: ownerActor(),
      input: { ...base, travelDate: day(-1) },
      clientIdempotencyKey: key(),
    });
    expect(yesterday.ok).toBe(true);
    expect(await movementRows(pet.id)).toHaveLength(1);
  });
});

describe("recordCvi", () => {
  it("appends one cvi_issued with valid_until, then refuses the same number: cvi_duplicate", async () => {
    const pet = await insertTestPet("CVI");
    const first = await recordCvi({
      pet: travelPet(pet),
      actor: ownerActor(),
      input: { cviNumber: "ar 123 456", issuedDate: day(-2), validUntil: day(8) },
      clientIdempotencyKey: key(),
    });
    expect(first).toMatchObject({ ok: true, replayed: false });

    const rows = await movementRows(pet.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      sub_kind: "cvi_issued",
      cvi_number: "ar 123 456",
      issuing_authority: "SENASA",
      origin_country: "AR",
      issued_date: day(-2),
      valid_until: day(8),
    });

    // Same certificate, spelled without spaces and in upper case.
    const twin = await recordCvi({
      pet: travelPet(pet),
      actor: ownerActor(),
      input: { cviNumber: "AR123456", issuedDate: day(-1), validUntil: null },
      clientIdempotencyKey: key(),
    });
    expect(twin).toMatchObject({ ok: false, code: "cvi_duplicate" });
    expect(await movementRows(pet.id)).toHaveLength(1);
  });

  it("refuses a future issue date, a year-old one, and a valid-until before issue", async () => {
    const pet = await insertTestPet("CVIPLAUS");
    for (const input of [
      { cviNumber: "X1", issuedDate: day(1), validUntil: null },
      { cviNumber: "X2", issuedDate: day(-400), validUntil: null },
      { cviNumber: "X3", issuedDate: day(-3), validUntil: day(-4) },
      { cviNumber: "   ", issuedDate: day(-3), validUntil: null },
    ]) {
      const result = await recordCvi({
        pet: travelPet(pet),
        actor: ownerActor(),
        input,
        clientIdempotencyKey: key(),
      });
      expect(result, JSON.stringify(input)).toMatchObject({ ok: false, code: "input_invalid" });
    }
    expect(await movementRows(pet.id)).toHaveLength(0);
  });

  it("refuses a caretaker", async () => {
    const pet = await insertTestPet("CVICARE");
    const result = await recordCvi({
      pet: travelPet(pet),
      actor: { ...ownerActor(), holderRole: "caretaker" },
      input: { cviNumber: "C1", issuedDate: day(-1), validUntil: null },
      clientIdempotencyKey: key(),
    });
    expect(result).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("cancelTrip", () => {
  it("appends a correction, keeps the original row, and deriveTrips drops the trip", async () => {
    const pet = await insertTestPet("CANCEL");
    const input = {
      corridorId: "ue_espana" as const,
      travelDate: day(40),
      mode: null,
      airlineId: null,
      intendedModality: null,
    };
    const trip = await recordTrip({
      pet: travelPet(pet),
      actor: ownerActor(),
      input,
      clientIdempotencyKey: key(),
    });
    expect(trip.ok).toBe(true);
    if (!trip.ok) return;
    const [original] = await db.select().from(petEvents).where(eq(petEvents.id, trip.eventId));

    const cancelled = await cancelTrip({
      pet: travelPet(pet),
      actor: ownerActor(),
      tripEventId: trip.eventId,
      clientIdempotencyKey: key(),
    });
    expect(cancelled).toEqual({ ok: true, tripEventId: trip.eventId, changed: true });

    // Append-only: the original row is byte-identical, the correction is new.
    const [still] = await db.select().from(petEvents).where(eq(petEvents.id, trip.eventId));
    expect(still.payload).toEqual(original.payload);
    const amendments = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "event_amended")));
    expect(amendments).toHaveLength(1);
    expect(amendments[0].payload).toMatchObject({
      target_event_id: trip.eventId,
      changes: [{ field: "cancelled", new: true }],
    });

    expect(deriveTrips(await loadOverlaidMovements(pet.id))).toEqual([]);

    // A second cancel is idempotent on the state.
    const again = await cancelTrip({
      pet: travelPet(pet),
      actor: ownerActor(),
      tripEventId: trip.eventId,
      clientIdempotencyKey: key(),
    });
    expect(again).toEqual({ ok: true, tripEventId: trip.eventId, changed: false });

    // And the same trip may be recorded again — a cancelled trip is no twin.
    const rebooked = await recordTrip({
      pet: travelPet(pet),
      actor: ownerActor(),
      input,
      clientIdempotencyKey: key(),
    });
    expect(rebooked.ok).toBe(true);
  });

  it("answers trip_not_found for a CVI or an unknown id, and refuses a caretaker", async () => {
    const pet = await insertTestPet("CANCELNF");
    const cvi = await recordCvi({
      pet: travelPet(pet),
      actor: ownerActor(),
      input: { cviNumber: "NF1", issuedDate: day(-1), validUntil: null },
      clientIdempotencyKey: key(),
    });
    if (!cvi.ok) throw new Error("setup: CVI not recorded");
    for (const tripEventId of [cvi.eventId, crypto.randomUUID()]) {
      const result = await cancelTrip({
        pet: travelPet(pet),
        actor: ownerActor(),
        tripEventId,
        clientIdempotencyKey: key(),
      });
      expect(result).toMatchObject({ ok: false, code: "trip_not_found" });
    }
    const caretaker = await cancelTrip({
      pet: travelPet(pet),
      actor: { ...ownerActor(), holderRole: "caretaker" },
      tripEventId: cvi.eventId,
      clientIdempotencyKey: key(),
    });
    expect(caretaker).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("POST /api/v1/pets/{token}/travel — command runner", () => {
  it("records a trip for the owner and replays under the same key", async () => {
    const pet = await insertTestPet("V1");
    const k = key();
    const ctx = {
      publicToken: pet.publicToken,
      userId: OWNER_ID,
      idempotencyKey: k,
      input: {
        command: "record_trip" as const,
        corridorId: "chile" as const,
        travelDate: day(12),
        mode: null,
        airlineId: null,
        intendedModality: null,
      },
    };
    const first = await runPetTravelCommand(ctx);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ command: "record_trip", replayed: false });

    const second = await runPetTravelCommand(ctx);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ...firstBody, replayed: true });

    const dup = await runPetTravelCommand({ ...ctx, idempotencyKey: key() });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "trip_duplicate" });
  });

  it("answers travel_forbidden to a caretaker and not_found to a stranger", async () => {
    const pet = await insertTestPet("V1AUTHZ");
    await db
      .insert(ownerships)
      .values({ petId: pet.id, ownerUserId: CARETAKER_ID, role: "caretaker" });
    const input = {
      command: "record_cvi" as const,
      cviNumber: "V1-1",
      issuedDate: day(-1),
      validUntil: null,
    };

    const caretaker = await runPetTravelCommand({
      publicToken: pet.publicToken,
      userId: CARETAKER_ID,
      idempotencyKey: key(),
      input,
    });
    expect(caretaker.status).toBe(403);
    expect(await caretaker.json()).toEqual({ error: "travel_forbidden" });

    const stranger = await runPetTravelCommand({
      publicToken: pet.publicToken,
      userId: STRANGER_ID,
      idempotencyKey: key(),
      input,
    });
    expect(stranger.status).toBe(404);
    expect(await movementRows(pet.id)).toHaveLength(0);
  });
});
