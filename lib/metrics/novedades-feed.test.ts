// Integration tests for lib/metrics/novedades-feed (viz-suite Wave 1 — Novedades).
// Requires a running local Postgres (local Supabase stack).
//
// Coverage (watermark semantics are the verification-contract item — pinned):
//   1. Watermark boundary — STRICTLY greater-than (an event AT the watermark is
//      already seen, excluded); events after it are included.
//   2. Type-set filter — a non-feed event type is excluded even when it is the
//      newest event in the window.
//   3. Ordering — (recorded_at DESC, id DESC): newest first, id tiebreak on
//      equal timestamps.
//   4. Limit — caps the page to the N newest rows.
//   5. First-visit fallback — no watermark → last 7 days (inclusive), older
//      events excluded; sinceWatermark=false.
//   6. Authz scope — admin sees any province; govt sees ONLY its jurisdictions
//      (cross-jurisdiction isolation); govt with no jurisdictions sees nothing.
//   7. getFeedWatermark + fetchNovedadesFeed — the watermark table round-trips
//      and drives the convenience fetcher.
//
// FIXTURE ISOLATION
// -----------------
// Watermark-based cases use fixtures dated in 2099 and a 2099 watermark, so the
// eligible set (recorded_at > 2099) is EXACTLY our fixtures — real/seed data
// (all < 2099) is excluded by the watermark itself, no starvation possible. The
// first-visit case uses recent fixtures (now−3d / now−10d) with a large limit
// and onlyFixtures() so real data cannot crowd them out. Provinces Mendoza /
// Salta with suite-unique synthetic localities avoid cross-suite collisions on
// the shared dev DB (the govt jurisdiction pair only ever matches our pets).

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, operatorFeedWatermarks, ownerships, petEvents, pets } from "@/db";
import { buildProjectionContext } from "@/lib/metrics";
import {
  FEED_EVENT_TYPES,
  fetchNovedadesFeed,
  fetchNovedadesFeedRows,
  fetchNovedadesGroups,
  getFeedWatermark,
} from "@/lib/metrics/novedades-feed";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "../../__tests__/_helpers/db-overrides";

const PREFIX = "NVD-"; // novedades-feed test
const PROV_A = "Mendoza";
const LOC_A = "NVD-Mza-A"; // suite-unique synthetic locality
const PROV_B = "Salta";
const LOC_B = "NVD-Sal-B";

const period = windows.trailing12m();

// Watermark instant + future fixtures (2099) so the eligible set is ONLY ours.
const WM = new Date("2099-06-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Fixture event ids, resolved in beforeAll.
let eA_atWm = ""; // outbreak_signal @ WM exactly (strictly-greater boundary)
let eA1 = ""; // outbreak_signal @ WM+1h
let eA2 = ""; // incident_reported @ WM+2h (ties eB2 on timestamp)
let eA3 = ""; // disease_reported @ WM+3h
let eA_weight = ""; // weight_recorded @ WM+5h — NON-feed type, newest
let eB2 = ""; // custody_dispute_raised @ WM+2h (Salta)
let eB4 = ""; // rabies_observation_started @ WM+4h (Salta)
let eC_recent = ""; // outbreak_signal @ now−3d (first-visit in-window)
let eC_old = ""; // disease_reported @ now−10d (first-visit out-of-window)

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

async function insertEvent(opts: {
  petId: string;
  eventType: string;
  recordedAt: Date;
}): Promise<string> {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId: opts.petId,
      eventType: opts.eventType,
      // The feed keys on recorded_at; occurred_at is irrelevant here so we mirror it.
      occurredAt: opts.recordedAt,
      recordedAt: opts.recordedAt,
      authorRole: "owner",
      payload: { payload_version: 1 },
    })
    .returning({ id: petEvents.id });
  createdEventIds.push(row.id);
  return row.id;
}

async function cleanup() {
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

  const petAId = await insertPet(`${PREFIX}PET-A`, { province: PROV_A, locality: LOC_A });
  const petBId = await insertPet(`${PREFIX}PET-B`, { province: PROV_B, locality: LOC_B });
  const petCId = await insertPet(`${PREFIX}PET-C`, { province: PROV_A, locality: LOC_A });

  // Pet A (Mendoza) — feed + boundary + non-feed fixtures.
  eA_atWm = await insertEvent({ petId: petAId, eventType: "outbreak_signal", recordedAt: WM });
  eA1 = await insertEvent({
    petId: petAId,
    eventType: "outbreak_signal",
    recordedAt: new Date(WM.getTime() + 1 * HOUR),
  });
  eA2 = await insertEvent({
    petId: petAId,
    eventType: "incident_reported",
    recordedAt: new Date(WM.getTime() + 2 * HOUR),
  });
  eA3 = await insertEvent({
    petId: petAId,
    eventType: "disease_reported",
    recordedAt: new Date(WM.getTime() + 3 * HOUR),
  });
  eA_weight = await insertEvent({
    petId: petAId,
    eventType: "weight_recorded", // NOT a feed type — must be excluded despite being newest
    recordedAt: new Date(WM.getTime() + 5 * HOUR),
  });

  // Pet B (Salta) — cross-jurisdiction + timestamp tie with eA2.
  eB2 = await insertEvent({
    petId: petBId,
    eventType: "custody_dispute_raised",
    recordedAt: new Date(WM.getTime() + 2 * HOUR),
  });
  eB4 = await insertEvent({
    petId: petBId,
    eventType: "rabies_observation_started",
    recordedAt: new Date(WM.getTime() + 4 * HOUR),
  });

  // Pet C (Mendoza) — recent fixtures for the first-visit 7-day fallback.
  eC_recent = await insertEvent({
    petId: petCId,
    eventType: "outbreak_signal",
    recordedAt: new Date(Date.now() - 3 * DAY),
  });
  eC_old = await insertEvent({
    petId: petCId,
    eventType: "disease_reported",
    recordedAt: new Date(Date.now() - 10 * DAY),
  });
});

afterAll(cleanup);

/** Restrict to fixture rows (created ids) so the dev DB's real data is ignored. */
function onlyFixtures<T extends { id: string }>(rows: T[]): T[] {
  const ids = new Set(createdEventIds);
  return rows.filter((r) => ids.has(r.id));
}

const adminCtx = () => buildProjectionContext({ role: "admin" }, [], period);
const govtCtxA = () =>
  buildProjectionContext({ role: "govt" }, [{ province: PROV_A, locality: LOC_A }], period);

// ---------------------------------------------------------------------------
// 1. Watermark boundary — strictly greater-than
// ---------------------------------------------------------------------------

describe("fetchNovedadesFeedRows — watermark boundary (strictly greater-than)", () => {
  it("excludes an event recorded AT the watermark; includes events after it", async () => {
    const feed = await fetchNovedadesFeedRows(adminCtx(), { watermark: WM, limit: 500 });
    const ids = feed.rows.map((r) => r.id);
    // AT the watermark → already seen → excluded.
    expect(ids).not.toContain(eA_atWm);
    // Strictly after → included.
    expect(ids).toContain(eA1);
    expect(ids).toContain(eA3);
    expect(feed.sinceWatermark).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Type-set filter
// ---------------------------------------------------------------------------

describe("fetchNovedadesFeedRows — type-set filter", () => {
  it("excludes a non-feed event type even when it is the newest in the window", async () => {
    const feed = await fetchNovedadesFeedRows(adminCtx(), { watermark: WM, limit: 500 });
    const ids = feed.rows.map((r) => r.id);
    // weight_recorded @ WM+5h is the newest timestamp, but not a feed type.
    expect(ids).not.toContain(eA_weight);
    // Every returned row is one of the declared feed types.
    for (const r of onlyFixtures(feed.rows)) {
      expect(FEED_EVENT_TYPES as readonly string[]).toContain(r.eventType);
    }
    // A real feed type after WM+5h's neighbourhood is still present (window ok).
    expect(ids).toContain(eB4);
  });
});

// ---------------------------------------------------------------------------
// 3. Ordering — recorded_at DESC, id DESC
// ---------------------------------------------------------------------------

describe("fetchNovedadesFeedRows — ordering", () => {
  it("orders newest recorded_at first, with an id-DESC tiebreak on equal timestamps", async () => {
    const feed = await fetchNovedadesFeedRows(adminCtx(), { watermark: WM, limit: 500 });
    const fixture = onlyFixtures(feed.rows);

    // Strictly non-increasing recorded_at across the whole page.
    for (let i = 1; i < fixture.length; i++) {
      expect(fixture[i - 1].recordedAt.getTime()).toBeGreaterThanOrEqual(
        fixture[i].recordedAt.getTime(),
      );
    }

    // The two WM+2h rows (eA2, eB2) must be adjacent and ordered id DESC.
    const tied = fixture.filter((r) => r.recordedAt.getTime() === WM.getTime() + 2 * HOUR);
    expect(tied.map((r) => r.id).sort()).toEqual([eA2, eB2].sort());
    const idxFirst = fixture.findIndex((r) => r.id === tied[0].id);
    const idxSecond = fixture.findIndex((r) => r.id === tied[1].id);
    const earlier = idxFirst < idxSecond ? fixture[idxFirst] : fixture[idxSecond];
    const later = idxFirst < idxSecond ? fixture[idxSecond] : fixture[idxFirst];
    expect(earlier.id > later.id).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Limit
// ---------------------------------------------------------------------------

describe("fetchNovedadesFeedRows — limit", () => {
  it("caps the page to the N newest rows", async () => {
    // watermark=WM isolates our 2099 fixtures; the two newest feed rows are
    // eB4 (WM+4h) then eA3 (WM+3h).
    const feed = await fetchNovedadesFeedRows(adminCtx(), { watermark: WM, limit: 2 });
    expect(feed.rows.length).toBe(2);
    expect(feed.rows.map((r) => r.id)).toEqual([eB4, eA3]);
  });
});

// ---------------------------------------------------------------------------
// 5. First-visit fallback — last 7 days
// ---------------------------------------------------------------------------

describe("fetchNovedadesFeedRows — first-visit fallback", () => {
  it("with no watermark shows the last 7 days and excludes older events", async () => {
    // The limit is deliberately larger than the seeded window. This asserts the
    // WINDOW, not the ranking: the feed is global and recency-ordered, and a
    // seeded DB carries ~18k events inside 7 days, so the fixture's own now−3d
    // event has no chance of surviving a top-500 recency cut. At limit 500 this
    // passed only while the local DB happened to be thin — a full re-seed made it
    // red without a line of product code changing (QA 2026-07-16).
    //
    // The exclusion below holds at ANY limit, because now−10d is outside the
    // window rather than merely outranked. That asymmetry is the tell: one
    // assertion tests the contract, the other tested the seed volume.
    const feed = await fetchNovedadesFeedRows(adminCtx(), { watermark: null, limit: 50_000 });
    const ids = feed.rows.map((r) => r.id);
    expect(feed.sinceWatermark).toBe(false);
    expect(ids).toContain(eC_recent); // now−3d → inside the 7-day window
    expect(ids).not.toContain(eC_old); // now−10d → outside
  });
});

// ---------------------------------------------------------------------------
// 6. Authz scope
// ---------------------------------------------------------------------------

describe("fetchNovedadesFeedRows — authz scope", () => {
  it("admin sees events from any province", async () => {
    const feed = await fetchNovedadesFeedRows(adminCtx(), { watermark: WM, limit: 500 });
    const provinces = new Set(onlyFixtures(feed.rows).map((r) => r.province));
    expect(provinces).toContain(PROV_A);
    expect(provinces).toContain(PROV_B);
  });

  it("govt scoped to Mendoza sees only its jurisdiction (cross-jurisdiction isolation)", async () => {
    const feed = await fetchNovedadesFeedRows(govtCtxA(), { watermark: WM, limit: 500 });
    const fixture = onlyFixtures(feed.rows);
    expect(fixture.length).toBeGreaterThan(0);
    for (const r of fixture) {
      expect(r.province).toBe(PROV_A);
    }
    const ids = fixture.map((r) => r.id);
    expect(ids).not.toContain(eB2); // Salta
    expect(ids).not.toContain(eB4); // Salta
  });

  it("govt with no jurisdictions sees nothing", async () => {
    const ctx = buildProjectionContext({ role: "govt" }, [], period);
    const feed = await fetchNovedadesFeedRows(ctx, { watermark: WM, limit: 500 });
    expect(onlyFixtures(feed.rows)).toHaveLength(0);
  });

  // H17 (external red-team 2026-07-30). "Sees nothing" above was the ONLY
  // thing pinned, and it is satisfied identically by "we queried and found
  // nothing" and by "we never queried". The card rendered the same
  // "Sin novedades…" sentence for both — a claim about the world from a screen
  // that had not looked. The grouped fetcher now carries WHICH it is.
  it("reports an un-queried scope as scopeEmpty, distinct from a measured zero", async () => {
    const noScope = buildProjectionContext({ role: "govt" }, [], period);
    const unqueried = await fetchNovedadesGroups(noScope, { watermark: WM, limit: 500 });
    expect(unqueried.groups).toHaveLength(0);
    expect(unqueried.scopeEmpty).toBe(true);

    // A REAL scope that was queried reports scopeEmpty=false whether or not it
    // found anything — asserted on the same call shape so the flag cannot be
    // passing by simply always being true.
    const queried = await fetchNovedadesGroups(govtCtxA(), { watermark: WM, limit: 500 });
    expect(queried.scopeEmpty).toBe(false);

    // …including when the query legitimately comes back empty: a watermark far
    // in the future excludes every row that exists.
    const farFuture = new Date("2999-01-01T00:00:00Z");
    const measuredZero = await fetchNovedadesGroups(govtCtxA(), {
      watermark: farFuture,
      limit: 500,
    });
    expect(measuredZero.groups).toHaveLength(0);
    expect(measuredZero.scopeEmpty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Watermark table round-trip + convenience fetcher
// ---------------------------------------------------------------------------

describe("getFeedWatermark + fetchNovedadesFeed", () => {
  it("round-trips the watermark row and drives the convenience fetcher", async () => {
    const actorId = await resolveAdminActorId();
    try {
      await db
        .insert(operatorFeedWatermarks)
        .values({ userId: actorId, lastSeenRecordedAt: WM })
        .onConflictDoUpdate({
          target: operatorFeedWatermarks.userId,
          set: { lastSeenRecordedAt: WM, updatedAt: new Date() },
        });

      const stored = await getFeedWatermark(actorId);
      expect(stored?.getTime()).toBe(WM.getTime());

      // fetchNovedadesFeed resolves the watermark internally, then queries.
      const feed = await fetchNovedadesFeed(adminCtx(), actorId, 500);
      expect(feed.sinceWatermark).toBe(true);
      const ids = feed.rows.map((r) => r.id);
      expect(ids).toContain(eA1); // after WM
      expect(ids).not.toContain(eA_atWm); // AT WM
    } finally {
      await db.delete(operatorFeedWatermarks).where(eq(operatorFeedWatermarks.userId, actorId));
    }
  });

  it("returns null for an operator that has never marked the feed", async () => {
    // A random uuid that is not a real profile — getFeedWatermark reads only,
    // so no FK insert is attempted; it must simply return null.
    const stored = await getFeedWatermark("00000000-0000-0000-0000-000000000000");
    expect(stored).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Grouped feed — dedup + grouping (Cowork M2)
// ---------------------------------------------------------------------------

describe("fetchNovedadesGroups — dedup + grouping", () => {
  const LOC_DUP = "NVD-Dup-Loc"; // suite-unique locality, isolated from other cases
  // Runs after the earlier describes' tests, so these extra rows never leak into
  // their assertions; the top-level afterAll cleans them by PREFIX.
  beforeAll(async () => {
    const p1 = await insertPet(`${PREFIX}DUP-1`, { province: PROV_A, locality: LOC_DUP });
    const p2 = await insertPet(`${PREFIX}DUP-2`, { province: PROV_A, locality: LOC_DUP });
    // p1 has TWO incident_reported events (a same-subject duplicate).
    await insertEvent({
      petId: p1,
      eventType: "incident_reported",
      recordedAt: new Date(WM.getTime() + 6 * HOUR),
    });
    await insertEvent({
      petId: p1,
      eventType: "incident_reported",
      recordedAt: new Date(WM.getTime() + 7 * HOUR),
    });
    // p2 has one incident_reported in the SAME locality.
    await insertEvent({
      petId: p2,
      eventType: "incident_reported",
      recordedAt: new Date(WM.getTime() + 8 * HOUR),
    });
  });

  it("collapses same-type + same-locality rows into one group with a DISTINCT-subject count", async () => {
    const feed = await fetchNovedadesGroups(adminCtx(), { watermark: WM, limit: 500 });
    const group = feed.groups.find(
      (g) => g.eventType === "incident_reported" && g.locality === LOC_DUP,
    );
    expect(group).toBeDefined();
    // 2 distinct pets — NOT 3 raw events. The duplicate incident on p1 is deduped
    // by COUNT(DISTINCT pet_id), so the tally is honest.
    expect(group?.count).toBe(2);
    expect(group?.province).toBe(PROV_A);
    expect(feed.sinceWatermark).toBe(true);
  });
});

async function resolveAdminActorId(): Promise<string> {
  const rows = (await db.execute(sql`
    select p.id::text as id
    from public.profiles p
    join auth.users u on u.id = p.id
    where u.email = 'admin@dim.test'
    limit 1
  `)) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw new Error("admin@dim.test profile not found; run seeds first");
  return id;
}
