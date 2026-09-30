// `GET /api/v1/pets/{publicToken}/travel` against a real DB (viajes-fase-2,
// tasks 5.1 / 5.5 / 5.7).
//
// What each block pins:
//   · the v1 body carries the SAME reading loadTravelView gives the web page —
//     trips, CVIs, the semáforo and every obligation — so web and phone
//     cannot disagree about a trip (spec mobile-travel-screen);
//   · `?trip=` picks the trip; the default is the next one; a cancelled trip
//     is gone from the list;
//   · a caretaker gets travel_forbidden, a stranger not_found (design D8);
//   · nothing on the wire promises, and the disclaimers always ride along.
// The pure trip selection is pinned at the bottom without a database.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// amendEvent (behind cancelTrip) calls revalidatePath after it commits.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { db, ownerships, pets, profiles } from "@/db";
import { TRAVEL_FORBIDDEN_COPY, TRAVEL_SEMAFORO_LABELS } from "@/lib/domain/travel-copy";
import { OWNER_AUTHORSHIP } from "@/lib/infra/pet-access";
import type { TravelTrip } from "@/lib/projections/travel-compliance";
import { isoDateInAr } from "@/lib/utils/format";
import { cancelTrip } from "@/src/modules/pets/application/travel/cancel-trip";
import { loadTravelView, selectTrip } from "@/src/modules/pets/application/travel/load-travel-view";
import { recordCvi } from "@/src/modules/pets/application/travel/record-cvi";
import { recordTrip } from "@/src/modules/pets/application/travel/record-trip";
import type { TravelActor } from "@/src/modules/pets/application/travel/types";
import type { PetTravelV1 } from "@dim/contract/api";
import { readPetTravel } from "../app/api/v1/pets/[publicToken]/travel/payload";
import { withMutationOverride } from "./_helpers/db-overrides";

const OWNER_ID = "33333333-4444-4555-8666-7777777700b1";
const CARETAKER_ID = "33333333-4444-4555-8666-7777777700b2";
const STRANGER_ID = "33333333-4444-4555-8666-7777777700b3";
const insertedPetIds: string[] = [];

const DAY_MS = 86_400_000;

function day(offset: number): string {
  return isoDateInAr(new Date(Date.now() + offset * DAY_MS));
}

const OWNER: TravelActor = {
  userId: OWNER_ID,
  accessPath: "owner",
  holderRole: "owner",
  eventAuthorship: OWNER_AUTHORSHIP,
};

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

async function insertTestPet(suffix: string) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `TRAVELRD-${suffix}-${Date.now()}`,
      name: `LecturaViaje${suffix}`,
      species: "dog",
      sex: "female",
      status: "active",
      jurisdictionCountry: "AR",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    })
    .returning();
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: OWNER_ID, role: "owner" });
  insertedPetIds.push(pet.id);
  return pet;
}

type TestPet = Awaited<ReturnType<typeof insertTestPet>>;

async function addTrip(pet: TestPet, corridorId: "chile" | "uruguay", offset: number) {
  const result = await recordTrip({
    pet,
    actor: OWNER,
    input: {
      corridorId,
      travelDate: day(offset),
      mode: null,
      airlineId: corridorId === "chile" ? "latam" : null,
      intendedModality: corridorId === "chile" ? "cabin" : null,
    },
    clientIdempotencyKey: crypto.randomUUID(),
  });
  if (!result.ok) throw new Error(`fixture: recordTrip refused (${result.code})`);
  return result.eventId;
}

async function read(pet: TestPet, userId: string, tripId: string | null = null) {
  const res = await readPetTravel({ publicToken: pet.publicToken, userId, tripId });
  return { status: res.status, body: (await res.json()) as PetTravelV1 & { error?: string } };
}

beforeAll(async () => {
  await ensureUser(OWNER_ID, "travel-read-owner");
  await ensureUser(CARETAKER_ID, "travel-read-caretaker");
  await ensureUser(STRANGER_ID, "travel-read-stranger");
});

afterAll(async () => {
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
});

describe("GET /api/v1/pets/{token}/travel — the web loader's reading, on the wire", () => {
  it("answers the same trips, CVIs, semáforo and obligations loadTravelView gives /viaje", async () => {
    const pet = await insertTestPet("SAME");
    const chile = await addTrip(pet, "chile", 20);
    await addTrip(pet, "uruguay", 60);
    const cvi = await recordCvi({
      pet,
      actor: OWNER,
      input: { cviNumber: "AR 123", issuedDate: day(0), validUntil: null },
      clientIdempotencyKey: crypto.randomUUID(),
    });
    expect(cvi.ok).toBe(true);

    const { status, body } = await read(pet, OWNER_ID);
    expect(status).toBe(200);

    const web = await loadTravelView({
      pet,
      viewer: { accessPath: "owner", holderRole: "owner" },
    });
    if (!web.ok) throw new Error("the owner must read the view");

    expect(body.payloadVersion).toBe(1);
    expect(body.selectedTripEventId).toBe(chile);
    expect(body.trips.map((t) => t.tripEventId)).toEqual(web.view.trips.map((t) => t.eventId));
    expect(body.trips[0]).toMatchObject({
      corridorId: "chile",
      corridorLabel: "Chile",
      airlineId: "latam",
      airlineName: "LATAM",
      intendedModality: "cabin",
      mode: "air",
    });
    expect(body.cvis).toEqual([
      { eventId: expect.any(String), cviNumber: "AR 123", issuedDate: day(0), validUntil: null },
    ]);

    const compliance = web.view.compliance;
    if (!compliance || !body.compliance) throw new Error("a selected trip has a reading");
    expect(body.compliance.semaforo).toBe(compliance.semaforo);
    expect(body.compliance.semaforoLabel).toBe(TRAVEL_SEMAFORO_LABELS[compliance.semaforo]);
    expect(body.compliance.obligations.map((o) => [o.id, o.requirementLevel, o.state])).toEqual(
      compliance.obligations.map((o) => [o.id, o.requirementLevel, o.state]),
    );
    // An airline was chosen, so its block is on the wire.
    expect(body.compliance.obligations.some((o) => o.group === "aerolinea")).toBe(true);
    expect(body.exportWebUrl).toMatch(new RegExp(`/mis-mascotas/${pet.publicToken}/viaje$`));
    expect(body.capabilities).toEqual({ canRecord: true });
  });

  it("?trip= reads the trip asked for", async () => {
    const pet = await insertTestPet("PICK");
    await addTrip(pet, "chile", 20);
    const uruguay = await addTrip(pet, "uruguay", 60);

    const { body } = await read(pet, OWNER_ID, uruguay);
    expect(body.selectedTripEventId).toBe(uruguay);
    expect(body.compliance?.corridors.map((c) => c.id)).toEqual(["uruguay"]);
    // No airline on that trip: no airline block (spec: only corridor rules).
    expect(body.compliance?.obligations.some((o) => o.group === "aerolinea")).toBe(false);
  });

  it("a cancelled trip leaves the list, and no trip means no reading", async () => {
    const pet = await insertTestPet("CANCEL");
    const trip = await addTrip(pet, "uruguay", 15);
    const cancelled = await cancelTrip({
      pet,
      actor: OWNER,
      tripEventId: trip,
      clientIdempotencyKey: crypto.randomUUID(),
    });
    expect(cancelled.ok).toBe(true);

    const { status, body } = await read(pet, OWNER_ID);
    expect(status).toBe(200);
    expect(body.trips).toEqual([]);
    expect(body.selectedTripEventId).toBeNull();
    expect(body.compliance).toBeNull();
  });

  it("answers travel_forbidden to a caretaker and not_found to a stranger", async () => {
    const pet = await insertTestPet("AUTHZ");
    await addTrip(pet, "uruguay", 15);
    await db
      .insert(ownerships)
      .values({ petId: pet.id, ownerUserId: CARETAKER_ID, role: "caretaker" });

    const caretaker = await read(pet, CARETAKER_ID);
    expect(caretaker.status).toBe(403);
    expect(caretaker.body).toEqual({ error: "travel_forbidden" });

    const stranger = await read(pet, STRANGER_ID);
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual({ error: "not_found" });
  });

  it("never promises, and always carries the SENASA and airline disclaimers", async () => {
    const pet = await insertTestPet("COPY");
    await addTrip(pet, "chile", 20);
    const { body } = await read(pet, OWNER_ID);

    const texts = [
      body.compliance?.semaforoLabel ?? "",
      ...(body.compliance?.obligations ?? []).flatMap((o) => [o.label, o.state, o.detail ?? ""]),
      ...body.disclaimers,
    ];
    for (const text of texts) expect(text).not.toMatch(TRAVEL_FORBIDDEN_COPY);
    expect(body.disclaimers.join(" ")).toContain("SENASA");
    expect(body.disclaimers.join(" ")).toContain("Verificá con tu aerolínea");
  });
});

describe("selectTrip — which trip the semáforo reads", () => {
  const now = new Date("2026-10-01T15:00:00Z");
  const trip = (eventId: string, travelDate: string): TravelTrip => ({
    eventId,
    corridorId: "uruguay",
    travelDate,
    mode: null,
    airlineId: null,
    intendedModality: null,
  });

  it("defaults to the next trip, not the earliest recent one", () => {
    const past = trip("a", "2026-09-25");
    const next = trip("b", "2026-10-10");
    expect(selectTrip([past, next], null, now).selectedTrip?.eventId).toBe("b");
  });

  it("falls back to the latest recent trip when none is ahead", () => {
    const past = trip("a", "2026-09-25");
    expect(selectTrip([past], null, now).selectedTrip?.eventId).toBe("a");
  });

  it("drops a trip older than the recent window", () => {
    const old = trip("a", "2026-08-01");
    expect(selectTrip([old], null, now)).toEqual({ trips: [], selectedTrip: null });
  });

  it("honours an asked-for trip, and ignores an unknown id", () => {
    const one = trip("a", "2026-10-10");
    const two = trip("b", "2026-11-10");
    expect(selectTrip([one, two], "b", now).selectedTrip?.eventId).toBe("b");
    expect(selectTrip([one, two], "zzz", now).selectedTrip?.eventId).toBe("a");
  });
});
