// Integration test — the SQL amendment overlays fold EVERY correction, and
// agree with the TypeScript overlay on the same rows (custody audit C1,
// 2026-09-26).
//
// A correction carries only the fields it changed (the web form and the API v1
// amend route diff against the already-corrected payload). The old overlays
// kept only the LATEST amendment per target, so a second correction on a
// different field silently erased the first everywhere. The three overlays —
// overlayAmendments (TS), amendedPayloadText (SQL) and rabiesDoseQualifies
// (SQL, inline) — must now all answer "per field, the latest amendment that
// touches it", ignore an amendment filed on another pet, and agree.
//
// Requires the local Supabase Postgres (127.0.0.1:54322).

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { overlayAmendments } from "@/lib/infra/amendment";
import { amendedPayloadText } from "@/lib/infra/amendment-sql";
import { rabiesDoseQualifies } from "@/lib/metrics/rabies";
import { withMutationOverride } from "./_helpers/db-overrides";

const TOKEN_A = "AMEND-FOLD-A01";
const TOKEN_B = "AMEND-FOLD-B01";
const DAY = 24 * 60 * 60 * 1000;

let petA: string;
let petB: string;
let doseId: string;

async function cleanupFixtures() {
  // pet_events is append-only (db/triggers.sql) — deletes need the override.
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`
      DELETE FROM pet_events
      WHERE pet_id IN (SELECT id FROM pets WHERE public_token IN (${TOKEN_A}, ${TOKEN_B}))
    `);
    await tx.execute(sql`DELETE FROM pets WHERE public_token IN (${TOKEN_A}, ${TOKEN_B})`);
  });
}

async function amend(
  petId: string,
  targetEventId: string,
  occurredAt: Date,
  changes: Array<{ field: string; old: unknown; new: unknown }>,
  recordedAt?: Date,
) {
  await db.insert(petEvents).values({
    petId,
    eventType: "event_amended",
    occurredAt,
    ...(recordedAt ? { recordedAt } : {}),
    payload: { payload_version: 1, target_event_id: targetEventId, reason: null, changes },
    authorRole: "vet",
    recordedByUserId: null,
  });
}

beforeAll(async () => {
  await cleanupFixtures();
  const inserted = await db
    .insert(pets)
    .values(
      [TOKEN_A, TOKEN_B].map((token) => ({
        publicToken: token,
        name: `AmendFold-${token.slice(-3)}`,
        species: "dog",
        status: "active" as const,
      })),
    )
    .returning({ id: pets.id, publicToken: pets.publicToken });
  petA = inserted.find((p) => p.publicToken === TOKEN_A)?.id as string;
  petB = inserted.find((p) => p.publicToken === TOKEN_B)?.id as string;

  const now = Date.now();
  // Raw dose: NOT a rabies vaccine by name, and its booster date has passed.
  const [dose] = await db
    .insert(petEvents)
    .values({
      petId: petA,
      eventType: "vaccination_administered",
      occurredAt: new Date(now - 30 * DAY),
      payload: {
        payload_version: 1,
        vaccine_name: "Polivalente",
        next_due_at: "2020-01-01",
        lot_number: "L1",
      },
      authorRole: "vet",
      recordedByUserId: null,
    })
    .returning({ id: petEvents.id });
  doseId = dose.id;

  // 1st correction: the name only.
  await amend(petA, doseId, new Date(now - 20 * DAY), [
    { field: "vaccine_name", old: "Polivalente", new: "Antirrábica" },
    { field: "lot_number", old: "L1", new: "L2" },
  ]);
  // 2nd correction: the booster date only — must NOT hide the 1st.
  await amend(petA, doseId, new Date(now - 10 * DAY), [
    { field: "next_due_at", old: "2020-01-01", new: "2099-01-01" },
  ]);
  // Two corrections of the lot at the SAME occurred_at: recorded_at decides.
  const tieAt = new Date(now - 5 * DAY);
  await amend(
    petA,
    doseId,
    tieAt,
    [{ field: "lot_number", old: "L2", new: "L-late" }],
    new Date(now - 4 * DAY),
  );
  await amend(
    petA,
    doseId,
    tieAt,
    [{ field: "lot_number", old: "L2", new: "L-early" }],
    new Date(now - 5 * DAY),
  );
  // ONE amendment listing the same field twice: its LAST entry wins.
  await amend(petA, doseId, new Date(now - 3 * DAY), [
    { field: "brand", old: null, new: "B-first" },
    { field: "brand", old: "B-first", new: "B-last" },
  ]);
  // Filed on ANOTHER pet, newest of all, pointing at pet A's dose: inert.
  await amend(petB, doseId, new Date(now - 1 * DAY), [
    { field: "vaccine_name", old: "Antirrábica", new: "Hijack" },
    { field: "next_due_at", old: "2099-01-01", new: "2020-01-01" },
  ]);
});

afterAll(cleanupFixtures);

async function sqlFieldValues() {
  const [row] = await db
    .select({
      vaccineName: sql<string | null>`${amendedPayloadText("vaccine_name")}`,
      nextDueAt: sql<string | null>`${amendedPayloadText("next_due_at")}`,
      lotNumber: sql<string | null>`${amendedPayloadText("lot_number")}`,
      brand: sql<string | null>`${amendedPayloadText("brand")}`,
    })
    .from(petEvents)
    .where(eq(petEvents.id, doseId));
  return row;
}

describe("amendment overlays fold every correction (custody audit C1)", () => {
  it("amendedPayloadText: each field takes the latest amendment that touches it", async () => {
    const values = await sqlFieldValues();
    // The 1st correction survives the 2nd (different field)…
    expect(values.vaccineName).toBe("Antirrábica");
    // …the 2nd applies…
    expect(values.nextDueAt).toBe("2099-01-01");
    // …and on an occurred_at tie the newer recorded_at wins.
    expect(values.lotNumber).toBe("L-late");
  });

  it("amendedPayloadText: a field listed twice in ONE amendment takes its last entry", async () => {
    const values = await sqlFieldValues();
    expect(values.brand).toBe("B-last");
  });

  it("amendedPayloadText under an alias honours the same-pet fence", async () => {
    const rows = await db.execute<{ vaccine_name: string | null }>(sql`
      SELECT ${amendedPayloadText("vaccine_name", {
        id: sql`pe.id`,
        payload: sql`pe.payload`,
        petId: sql`pe.pet_id`,
      })} AS vaccine_name
      FROM pet_events pe
      WHERE pe.id = ${doseId}
    `);
    expect(rows[0]?.vaccine_name).toBe("Antirrábica");
  });

  it("rabiesDoseQualifies reads the corrected name AND the corrected date", async () => {
    // Before the fix the latest amendment (the date) hid the name correction,
    // so the dose was not a rabies dose at all; the other pet's amendment,
    // newest of all, would have expired it again.
    const now = Date.now();
    const [row] = await db
      .select({
        qualifies: rabiesDoseQualifies(
          {
            id: sql`${petEvents.id}`,
            payload: sql`${petEvents.payload}`,
            occurredAt: sql`${petEvents.occurredAt}`,
            petId: sql`${petEvents.petId}`,
          },
          { since: new Date(now - 365 * DAY), until: new Date(now) },
        ),
      })
      .from(petEvents)
      .where(eq(petEvents.id, doseId));
    expect(row.qualifies).toBe(true);
  });

  it("parity: the TS overlay projects exactly what the SQL twin reads", async () => {
    const stream = await db
      .select({
        id: petEvents.id,
        petId: petEvents.petId,
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        recordedAt: petEvents.recordedAt,
        payload: petEvents.payload,
      })
      .from(petEvents)
      .where(inArray(petEvents.petId, [petA, petB]));
    const projected = overlayAmendments(stream).find((e) => e.id === doseId)?.payload as Record<
      string,
      unknown
    >;
    const values = await sqlFieldValues();
    expect(projected.vaccine_name).toBe(values.vaccineName);
    expect(projected.next_due_at).toBe(values.nextDueAt);
    expect(projected.lot_number).toBe(values.lotNumber);
    expect(projected.brand).toBe(values.brand);
    expect(projected.brand).toBe("B-last");
  });
});
