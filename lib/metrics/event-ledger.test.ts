// Integration tests for lib/metrics/event-ledger (WS-L — Libro de eventos).
// Requires a running local Postgres (local Supabase stack).
//
// Coverage:
//   1. Scope — admin sees events from any province; govt only its jurisdictions
//      (cross-jurisdiction isolation).
//   2. Keyset pagination — two consecutive pages do not overlap or skip; the
//      (occurredAt DESC, id DESC) order is deterministic on equal timestamps.
//   3. Filters — eventTypes / province / from-to narrow the result set.
//   4. hasAmendment — an event referenced by an event_amended row is flagged
//      true; one without an amendment is false.
//   5. PII gating — rows expose no owner personal data, only the pet public token.
//   6. Audit — every list view writes a pii_queried row with surface=event_ledger.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, ownerships, petEvents, pets } from "@/db";
import { buildProjectionContext } from "@/lib/metrics";
import { fetchEventLedger, logEventLedgerView } from "@/lib/metrics/event-ledger";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "../../__tests__/_helpers/db-overrides";

const PREFIX = "ELT-"; // event-ledger test
const PROV_A = "Santa Fe";
const LOC_A = "Rosario";
const PROV_B = "Córdoba";
const LOC_B = "Córdoba";

const period = windows.trailing12m();

// Stable base timestamp; individual events are offset from here so the keyset
// order is deterministic across runs.
//
// We bound every query with a tight [FROM, TO] window around the fixtures so
// the page is not flooded by unrelated dev-DB events (the default page size is
// finite and ordered DESC, so a wide window would surface only recent real
// data and starve the fixtures). BASE sits in 2019 — well BEFORE the seed
// corpus (which starts 2025-02), so the window contains ONLY our fixtures.
// onlyFixtures() still isolates by prefix as a second guard.
const BASE = new Date("2019-06-01T12:00:00.000Z").getTime();
const HOUR = 60 * 60 * 1000;
const FROM = new Date(BASE);
const TO = new Date(BASE + 12 * HOUR);

// Surface marker used so audit fixtures never collide with real pii_queried rows.
const TEST_SURFACE = "event_ledger_test";

let petAId = "";
let petBId = "";
let petMovedId = "";
let driftEventId = "";
let createdPetIds: string[] = [];
let createdEventIds: string[] = [];

async function insertPet(
  token: string,
  opts: { province: string; locality: string },
): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `${PREFIX}${token}`,
      species: "dog",
      status: "active",
      jurisdictionProvince: opts.province,
      jurisdictionLocality: opts.locality,
    })
    .returning({ id: pets.id });
  createdPetIds.push(row.id);
  return row.id;
}

/**
 * Insert a pet_events row carrying the jurisdiction in its payload (the same
 * fields petEventsScopeClause reads). Returns the new event id.
 */
async function insertEvent(opts: {
  petId: string;
  eventType: string;
  occurredAt: Date;
  province: string;
  locality: string;
  amendsEventId?: string;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    payload_version: 1,
    pet_jurisdiction_country: "AR",
    pet_jurisdiction_province: opts.province,
    pet_jurisdiction_locality: opts.locality,
  };
  if (opts.amendsEventId) {
    payload.target_event_id = opts.amendsEventId;
    payload.reason = "Corrección de prueba";
    payload.changes = [{ field: "note", old: "a", new: "b" }];
    payload.actor_role = "owner";
  }
  const [row] = await db
    .insert(petEvents)
    .values({
      petId: opts.petId,
      eventType: opts.eventType,
      occurredAt: opts.occurredAt,
      recordedAt: opts.occurredAt,
      authorRole: "owner",
      payload,
    })
    .returning({ id: petEvents.id });
  createdEventIds.push(row.id);
  return row.id;
}

async function cleanup() {
  // NB: audit_log is append-only (enforce_audit_log_append_only) — the
  // pii_queried rows from logEventLedgerView cannot be deleted. The audit test
  // tolerates accumulation by reading the most recent matching row.
  //
  // Delete by token PREFIX (not by in-memory ids) so a prior crashed run's
  // orphan fixtures are also removed.
  const fixturePets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(sql`${pets.publicToken} LIKE ${`${PREFIX}%`}`);
  const ids = fixturePets.map((p) => p.id);
  if (ids.length > 0) {
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
    });
    await db.delete(ownerships).where(inArray(ownerships.petId, ids));
    await db.delete(pets).where(inArray(pets.id, ids));
  }
  createdPetIds = [];
  createdEventIds = [];
}

beforeAll(async () => {
  await cleanup();

  petAId = await insertPet(`${PREFIX}PET-A`, { province: PROV_A, locality: LOC_A });
  petBId = await insertPet(`${PREFIX}PET-B`, { province: PROV_B, locality: LOC_B });

  // Pet A (PROV_A): 2 weight events + 1 vaccination (the one that gets amended).
  await insertEvent({
    petId: petAId,
    eventType: "weight_recorded",
    occurredAt: new Date(BASE + 1 * HOUR),
    province: PROV_A,
    locality: LOC_A,
  });
  await insertEvent({
    petId: petAId,
    eventType: "weight_recorded",
    occurredAt: new Date(BASE + 2 * HOUR),
    province: PROV_A,
    locality: LOC_A,
  });
  const amendedTargetId = await insertEvent({
    petId: petAId,
    eventType: "vaccination_administered",
    occurredAt: new Date(BASE + 3 * HOUR),
    province: PROV_A,
    locality: LOC_A,
  });

  // Pet B (PROV_B): one event SHARING BASE+2h to exercise the id-DESC tiebreak.
  await insertEvent({
    petId: petBId,
    eventType: "weight_recorded",
    occurredAt: new Date(BASE + 2 * HOUR),
    province: PROV_B,
    locality: LOC_B,
  });
  await insertEvent({
    petId: petBId,
    eventType: "deworming_administered",
    occurredAt: new Date(BASE + 4 * HOUR),
    province: PROV_B,
    locality: LOC_B,
  });

  // Amendment: an event_amended row referencing amendedTargetId.
  await insertEvent({
    petId: petAId,
    eventType: "event_amended",
    occurredAt: new Date(BASE + 5 * HOUR),
    province: PROV_A,
    locality: LOC_A,
    amendsEventId: amendedTargetId,
  });

  // Drift fixture (scope-security review 2026-07-04 A1): the event payload
  // says PROV_A (snapshot at event time), but the pet has since MOVED — its
  // CURRENT pets.jurisdiction_* is PROV_B. A govt viewer scoped to PROV_A must
  // NOT see this pet's public token.
  petMovedId = await insertPet(`${PREFIX}PET-MOVED`, { province: PROV_B, locality: LOC_B });
  driftEventId = await insertEvent({
    petId: petMovedId,
    eventType: "weight_recorded",
    occurredAt: new Date(BASE + 6 * HOUR),
    province: PROV_A,
    locality: LOC_A,
  });
});

afterAll(cleanup);

/** Only count fixture rows (prefix-scoped) so the dev DB's real data is ignored. */
function onlyFixtures<T extends { id: string }>(rows: T[]): T[] {
  const ids = new Set(createdEventIds);
  return rows.filter((r) => ids.has(r.id));
}

// ---------------------------------------------------------------------------
// 1. Scope
// ---------------------------------------------------------------------------

describe("fetchEventLedger — scope", () => {
  it("admin sees events from any province", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], period);
    const { rows } = await fetchEventLedger(ctx, { from: FROM, to: TO });
    const fixture = onlyFixtures(rows);
    const provinces = new Set(fixture.map((r) => r.province));
    expect(provinces).toContain(PROV_A);
    expect(provinces).toContain(PROV_B);
  });

  it("govt scoped to PROV_A sees only PROV_A events (cross-jurisdiction isolation)", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: PROV_A, locality: LOC_A }],
      period,
    );
    const { rows } = await fetchEventLedger(ctx, { from: FROM, to: TO });
    const fixture = onlyFixtures(rows);
    expect(fixture.length).toBeGreaterThan(0);
    for (const r of fixture) {
      expect(r.province).toBe(PROV_A);
    }
    const provinces = new Set(fixture.map((r) => r.province));
    expect(provinces).not.toContain(PROV_B);
  });

  it("govt with no jurisdictions sees nothing", async () => {
    const ctx = buildProjectionContext({ role: "govt" }, [], period);
    const { rows } = await fetchEventLedger(ctx, { from: FROM, to: TO });
    expect(onlyFixtures(rows)).toHaveLength(0);
  });

  it("govt does NOT see an event whose payload claims its jurisdiction but whose pet moved away (payload/pets drift)", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: PROV_A, locality: LOC_A }],
      period,
    );
    const { rows } = await fetchEventLedger(ctx, { from: FROM, to: TO });
    const fixture = onlyFixtures(rows);
    // The drifted event's payload says PROV_A, so it WOULD match a payload-only
    // scope — but the pet now lives in PROV_B, so it must be excluded.
    expect(fixture.map((r) => r.id)).not.toContain(driftEventId);
    expect(fixture.map((r) => r.petPublicToken)).not.toContain(`${PREFIX}PET-MOVED`);
    // Pets that CURRENTLY live in PROV_A are still visible (no over-restriction).
    expect(fixture.length).toBeGreaterThan(0);
  });

  it("admin still sees the drifted event (universal scope preserved)", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], period);
    const { rows } = await fetchEventLedger(ctx, { from: FROM, to: TO });
    expect(onlyFixtures(rows).map((r) => r.id)).toContain(driftEventId);
  });
});

// ---------------------------------------------------------------------------
// 2. Keyset pagination
// ---------------------------------------------------------------------------

describe("fetchEventLedger — keyset pagination", () => {
  it("two consecutive pages do not overlap or skip rows", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], period);

    const page1 = await fetchEventLedger(ctx, { from: FROM, to: TO }, undefined, 3);
    expect(page1.rows.length).toBe(3);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await fetchEventLedger(
      ctx,
      { from: FROM, to: TO },
      page1.nextCursor ?? undefined,
      3,
    );

    const ids1 = page1.rows.map((r) => r.id);
    const ids2 = page2.rows.map((r) => r.id);
    for (const id of ids2) {
      expect(ids1).not.toContain(id);
    }
    // Combined order is strictly descending on (occurredAt, id) — no skip.
    const combined = [...page1.rows, ...page2.rows];
    for (let i = 1; i < combined.length; i++) {
      const prevKey = `${combined[i - 1].occurredAt.toISOString()}|${combined[i - 1].id}`;
      const curKey = `${combined[i].occurredAt.toISOString()}|${combined[i].id}`;
      expect(prevKey > curKey).toBe(true);
    }
  });

  it("deterministic order on equal timestamps (id DESC tiebreak)", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], period);
    const { rows } = await fetchEventLedger(ctx, { from: FROM, to: TO });
    const tied = onlyFixtures(rows).filter((r) => r.occurredAt.getTime() === BASE + 2 * HOUR);
    expect(tied.length).toBe(2);
    // Their relative order in the full list must be id-descending.
    const idxA = rows.findIndex((r) => r.id === tied[0].id);
    const idxB = rows.findIndex((r) => r.id === tied[1].id);
    const earlier = idxA < idxB ? rows[idxA] : rows[idxB];
    const later = idxA < idxB ? rows[idxB] : rows[idxA];
    expect(earlier.id > later.id).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Filters
// ---------------------------------------------------------------------------

describe("fetchEventLedger — filters", () => {
  it("eventTypes filter narrows to the requested types", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], period);
    const { rows } = await fetchEventLedger(ctx, {
      from: FROM,
      to: TO,
      eventTypes: ["vaccination_administered"],
    });
    const fixture = onlyFixtures(rows);
    expect(fixture.length).toBeGreaterThan(0);
    for (const r of fixture) {
      expect(r.eventType).toBe("vaccination_administered");
    }
  });

  it("province filter narrows to the requested province", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], period);
    const { rows } = await fetchEventLedger(ctx, { from: FROM, to: TO, province: PROV_B });
    const fixture = onlyFixtures(rows);
    expect(fixture.length).toBeGreaterThan(0);
    for (const r of fixture) {
      expect(r.province).toBe(PROV_B);
    }
  });

  it("from/to window narrows the result set", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], period);
    // Window that only contains the BASE+1h event.
    const { rows } = await fetchEventLedger(ctx, {
      from: FROM,
      to: new Date(BASE + 1 * HOUR + 1),
    });
    const fixture = onlyFixtures(rows);
    expect(fixture.length).toBe(1);
    expect(fixture[0].occurredAt.getTime()).toBe(BASE + 1 * HOUR);
  });
});

// ---------------------------------------------------------------------------
// 4. hasAmendment
// ---------------------------------------------------------------------------

describe("fetchEventLedger — hasAmendment flag", () => {
  it("flags the amended event true and a non-amended event false", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], period);
    const { rows } = await fetchEventLedger(ctx, { from: FROM, to: TO });
    const fixture = onlyFixtures(rows);

    const amended = fixture.find((r) => r.eventType === "vaccination_administered");
    expect(amended).toBeDefined();
    expect(amended?.hasAmendment).toBe(true);

    const notAmended = fixture.find(
      (r) => r.eventType === "weight_recorded" && r.province === PROV_B,
    );
    expect(notAmended).toBeDefined();
    expect(notAmended?.hasAmendment).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. PII gating
// ---------------------------------------------------------------------------

describe("fetchEventLedger — PII gating", () => {
  it("rows expose the pet public token, never the raw petId or owner data", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], period);
    const { rows } = await fetchEventLedger(ctx, { from: FROM, to: TO });
    const fixture = onlyFixtures(rows);
    expect(fixture.length).toBeGreaterThan(0);
    for (const r of fixture) {
      expect(r.petPublicToken).toMatch(/^ELT-/);
      expect(r).not.toHaveProperty("ownerName");
      expect(r).not.toHaveProperty("ownerDni");
      expect(r).not.toHaveProperty("petId");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Audit
// ---------------------------------------------------------------------------

describe("logEventLedgerView — audit", () => {
  it("writes a pii_queried row with surface marker and result_count", async () => {
    const actorId = await resolveAdminActorId();
    await logEventLedgerView(actorId, { eventTypes: ["weight_recorded"] }, 7, TEST_SURFACE);

    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "pii_queried"),
          eq(auditLog.actorUserId, actorId),
          sql`${auditLog.payload}->>'surface' = ${TEST_SURFACE}`,
        ),
      )
      .orderBy(desc(auditLog.performedAt))
      .limit(1);

    expect(rows.length).toBe(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.surface).toBe(TEST_SURFACE);
    expect(payload.result_count).toBe(7);
    expect(payload.filters).toBeDefined();
  });
});

async function resolveAdminActorId(): Promise<string> {
  const rows = (await db.execute(sql`
    select p.id::text as id
    from public.profiles p
    join auth.users u on u.id = p.id
    where u.email = 'admin@dim.test'
    limit 1
  `)) as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw new Error("admin@dim.test profile not found; run seeds first");
  return id;
}
