// Trip privacy, asserted NEGATIVE on every surface that could leak it
// (viajes-fase-2, design D8). Runs against the local Postgres.
//
// A trip (`transport_recorded`) and a CVI (`cvi_issued`) say when a household
// will be away and where it is going. The titular reads them; nobody else does.
// This file writes one of each through the real movement writer, plus a
// correction of the trip (which carries the old and new travel date), and then
// reads the pet through every door a non-titular has:
//
//   · the libreta face as a CARETAKER      → no trip, no CVI, no correction
//   · the event detail by id, not visible  → null, the same as a missing record
//   · the walk-in libreta an org reads     → no correction keyed by a trip
//   · the shared-libreta link a vet opens  → no trip correction
//   · the bare SQL clause                  → drops exactly the three travel rows
//   · the correction writer as a caretaker → refused, with the not-found sentence
//   · notifications and the ENO outbox     → zero rows for any of it
//
// and POSITIVE for the titular, so a clause that hid everything from everyone
// could not pass. The gob count's small-cell rule is in lib/metrics/movement.test.ts;
// which reads carry the clause at all is __tests__/travel-private-read-coverage.test.ts.

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// amendEvent revalidates Next paths after its commit; outside a request scope
// that throws, so it is stubbed.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// getLibretaFaceData imports the cookie-bound Supabase client for attachment
// signing; no fixture here carries a file.
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) as unknown }));

import {
  type Pet,
  db,
  eventNotificationOutbox,
  notifications,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { loadSharedLibretaEvents } from "@/lib/infra/libreta-share-events";
import { canAccessTravel } from "@/lib/infra/pet-access";
import { isTravelPrivateEvent, notTravelPrivateClause } from "@/lib/infra/travel-private-events";
import { amendEvent } from "@/src/modules/events/application/amendment/amend-event";
import { readEventRow } from "@/src/modules/events/application/read/load-pet-event-detail";
import { recordMovementWriter } from "@/src/modules/pets/application/movement/record-movement";
import { getLibretaFaceData } from "@/src/modules/pets/application/tab-data/get-libreta-face-data";
import { getWalkInLibreta } from "@/src/modules/pets/application/tab-data/get-walk-in-libreta";
import { withMutationOverride } from "./_helpers/db-overrides";

const OWNER_ID = "7a5e0f1e-0000-4000-8000-00000000a001";
const CARETAKER_ID = "7a5e0f1e-0000-4000-8000-00000000a002";
const PET_TOKEN = `TRAVELPRIV-${Date.now()}`;

const OWNER_AUTHORSHIP = {
  authorRole: "owner" as const,
  authorOrganizationId: null,
  authorVerified: false,
};

let pet: Pet;
let transportId: string;
let cviId: string;
let tripCorrectionId: string;
let vaccinationId: string;

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

function isTravelRowOrItsCorrection(row: { id: string; eventType: string; payload: unknown }) {
  if (isTravelPrivateEvent(row.eventType, row.payload)) return true;
  const target = (row.payload as Record<string, unknown> | null)?.target_event_id;
  return row.eventType === "event_amended" && (target === transportId || target === cviId);
}

beforeAll(async () => {
  await ensureUser(OWNER_ID, "travel-privacy-owner");
  await ensureUser(CARETAKER_ID, "travel-privacy-caretaker");

  [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Viajera",
      species: "dog",
      sex: "female",
      status: "active",
      jurisdictionCountry: "AR",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    })
    .returning();
  await db.insert(ownerships).values([
    { petId: pet.id, ownerUserId: OWNER_ID, role: "owner" },
    { petId: pet.id, ownerUserId: CARETAKER_ID, role: "caretaker" },
  ]);

  const base = {
    pet,
    recordedByUserId: OWNER_ID,
    eventAuthorship: OWNER_AUTHORSHIP,
    occurredAt: new Date(),
    notes: null,
  };
  const trip = await recordMovementWriter({
    ...base,
    movement: {
      sub_kind: "transport_recorded",
      corridor_id: "uruguay",
      direction: "outbound_from_ar",
      travel_date: "2026-12-20",
      mode: "air",
      purpose: null,
    },
  });
  const cvi = await recordMovementWriter({
    ...base,
    movement: {
      sub_kind: "cvi_issued",
      origin_country: "AR",
      cvi_number: "CVI-TRAVELPRIV-0001",
      issuing_authority: "SENASA",
      issued_date: "2026-12-10",
      chip_iso_country_code: null,
    },
  });
  if (!trip.ok || !cvi.ok) throw new Error("travel fixture: the movement writer refused");
  transportId = trip.eventId;
  cviId = cvi.eventId;

  // A libreta event that must stay visible to everyone — the control.
  const [vaccination] = await db
    .insert(petEvents)
    .values({
      petId: pet.id,
      eventType: "vaccination_administered",
      occurredAt: new Date(),
      recordedAt: new Date(),
      recordedByUserId: OWNER_ID,
      ...OWNER_AUTHORSHIP,
      payload: {
        payload_version: 1,
        vaccine_name: "Antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
    })
    .returning({ id: petEvents.id });
  vaccinationId = vaccination.id;

  // The titular corrects the trip's date through the real writer.
  const corrected = await amendEvent(
    { id: OWNER_ID },
    { id: pet.id, name: pet.name, publicToken: pet.publicToken },
    OWNER_AUTHORSHIP,
    {
      publicToken: pet.publicToken,
      targetEventId: transportId,
      reason: null,
      changes: [{ field: "travel_date", old: "2026-12-20", new: "2026-12-22" }],
    },
  );
  if (!corrected.ok) throw new Error(`travel fixture: correction refused (${corrected.code})`);
  tripCorrectionId = corrected.amendmentEventId;
});

afterAll(async () => {
  if (!pet) return;
  await withMutationOverride(async (tx) => {
    await tx.delete(pets).where(eq(pets.id, pet.id));
  });
});

describe("canAccessTravel — who may read a trip", () => {
  it("admits the person-path titulars", () => {
    expect(canAccessTravel("owner", "owner")).toBe(true);
    expect(canAccessTravel("owner", "co_owner")).toBe(true);
    expect(canAccessTravel("owner", "foster")).toBe(true);
  });

  it("refuses a caretaker, the org path, and an unresolved role", () => {
    expect(canAccessTravel("owner", "caretaker")).toBe(false);
    expect(canAccessTravel("org", null)).toBe(false);
    expect(canAccessTravel("owner", null)).toBe(false);
    expect(canAccessTravel(null, null)).toBe(false);
  });
});

describe("notTravelPrivateClause — the one definition", () => {
  it("drops the trip, the CVI and the trip's correction, and nothing else", async () => {
    const all = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(eq(petEvents.petId, pet.id));
    const visible = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), notTravelPrivateClause()));

    const hidden = all.map((r) => r.id).filter((id) => !visible.some((v) => v.id === id));
    expect(hidden.sort()).toEqual([transportId, cviId, tripCorrectionId].sort());
    expect(visible.map((r) => r.id)).toContain(vaccinationId);
  });

  it("keeps a jurisdiction_changed move — it is not a travel fact", async () => {
    const rows = (await db.execute(sql`
      select ${notTravelPrivateClause()} as visible
      from (select
        'movement_recorded'::text as event_type,
        '{"sub_kind":"jurisdiction_changed"}'::jsonb as payload,
        ${pet.id}::uuid as pet_id) as pet_events
    `)) as unknown as Array<{ visible: boolean }>;
    expect(rows[0]?.visible).toBe(true);
  });
});

describe("non-titular surfaces show nothing of the trip", () => {
  it("the libreta face read as a caretaker", async () => {
    const result = await getLibretaFaceData(
      {
        user: { id: CARETAKER_ID },
        pet,
        accessPath: "owner",
        organization: null,
        holderRole: "caretaker",
      },
      { signAttachments: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.past.filter(isTravelRowOrItsCorrection)).toEqual([]);
    expect(result.data.past.map((e) => e.id)).toContain(vaccinationId);
  });

  it("the event detail by id, when the caller may not read trips", async () => {
    expect(await readEventRow(pet.id, transportId, false)).toBeNull();
    expect(await readEventRow(pet.id, cviId, false)).toBeNull();
    expect(await readEventRow(pet.id, tripCorrectionId, false)).toBeNull();
    // Non-travel records still open for the same caller.
    expect((await readEventRow(pet.id, vaccinationId, false))?.id).toBe(vaccinationId);
  });

  it("the walk-in libreta a clinic reads in Atender", async () => {
    const walkIn = await getWalkInLibreta(pet.id);
    expect(walkIn.past.filter(isTravelRowOrItsCorrection)).toEqual([]);
    expect(Object.keys(walkIn.correctionAuthors)).not.toContain(transportId);
  });

  it("the shared libreta a vet opens from a link", async () => {
    const shared = await loadSharedLibretaEvents(pet.id);
    expect(shared.filter(isTravelRowOrItsCorrection)).toEqual([]);
  });

  it("the correction writer refuses a caretaker with the not-found sentence", async () => {
    const result = await amendEvent(
      { id: CARETAKER_ID },
      { id: pet.id, name: pet.name, publicToken: pet.publicToken },
      OWNER_AUTHORSHIP,
      {
        publicToken: pet.publicToken,
        targetEventId: transportId,
        reason: null,
        changes: [{ field: "travel_date", old: "2026-12-22", new: "2027-01-05" }],
      },
    );
    expect(result).toEqual({
      ok: false,
      code: "travel_private_target",
      error: "Evento no encontrado.",
    });
  });
});

describe("the titular still reads the trip", () => {
  it("the libreta face read as the owner carries the trip and the CVI", async () => {
    const result = await getLibretaFaceData(
      { user: { id: OWNER_ID }, pet, accessPath: "owner", organization: null, holderRole: "owner" },
      { signAttachments: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.data.past.map((e) => e.id);
    expect(ids).toContain(transportId);
    expect(ids).toContain(cviId);
  });

  it("the event detail by id, when the caller may read trips", async () => {
    expect((await readEventRow(pet.id, transportId, true))?.id).toBe(transportId);
  });
});

describe("no push, no outbox", () => {
  it("writing and correcting a trip notifies nobody and enqueues nothing", async () => {
    const pushed = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.relatedPetId, pet.id));
    expect(pushed).toEqual([]);

    const enqueued = await db
      .select({ id: eventNotificationOutbox.id })
      .from(eventNotificationOutbox)
      .where(
        inArray(eventNotificationOutbox.sourceEventId, [transportId, cviId, tripCorrectionId]),
      );
    expect(enqueued).toEqual([]);
  });
});

describe("a correction cannot turn a move into a trip", () => {
  it("refuses jurisdiction_changed → cvi_issued, so the clause may read sub_kind raw", async () => {
    const move = await recordMovementWriter({
      pet,
      recordedByUserId: OWNER_ID,
      eventAuthorship: OWNER_AUTHORSHIP,
      occurredAt: new Date(),
      notes: null,
      movement: {
        sub_kind: "jurisdiction_changed",
        from_country: "AR",
        from_province: "CABA",
        from_locality: "Palermo",
        to_country: "AR",
        to_province: "Buenos Aires",
        to_locality: "La Plata",
        effective_date: "2026-07-01",
        reason: null,
      },
    });
    if (!move.ok) throw new Error("fixture: the jurisdiction move was refused");

    const result = await amendEvent(
      { id: OWNER_ID },
      { id: pet.id, name: pet.name, publicToken: pet.publicToken },
      OWNER_AUTHORSHIP,
      {
        publicToken: pet.publicToken,
        targetEventId: move.eventId,
        reason: null,
        changes: [{ field: "sub_kind", old: "jurisdiction_changed", new: "cvi_issued" }],
      },
    );
    expect(result).toEqual({
      ok: false,
      code: "discriminator_locked",
      error: "No se puede cambiar el tipo de registro de un movimiento.",
    });
  });
});
