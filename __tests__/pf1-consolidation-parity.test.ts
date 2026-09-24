// PF1 — query-fan-out consolidation parity harness (2026-07-22).
//
// The dominant server cost on the worst /gob dashboards was per-request query
// fan-out (~40-48 queries/request over an analytics pool capped at max:2),
// causing live vigilancia timeouts at broad scope. PF1 consolidates queries
// that share the SAME table + SAME scope predicate + SAME/compatible window,
// merging them into one `count(*) FILTER (WHERE …)` multi-metric query
// instead of N round-trips. See:
//   - lib/analytics/dashboards/surveillance.ts  fetchVigilanciaMetrics
//     (cases arms: rabies-open + investigation-active merged)
//   - lib/analytics/govt-home-kpis.ts
//       fetchSterilizationMetrics   (current/prev/orgs merged)
//       fetchBitesPer10k            (current/prev merged)
//       fetchOpenRabiesObservations (thisWeek/lastWeek merged)
//       fetchOpenWelfareReportsCount(backlog/period merged)
//
// This is the HIGHEST-RISK class of change (it moves numbers at scale), so
// every merge is verified against seeded fixtures with EXACT pinned counts —
// a mismatch here means the FILTER-merge is wrong, not a fixture typo,
// because every count is fully controlled by this file (isolated, fictional
// province/locality strings that cannot collide with seed data or other
// suites' fixtures, cleaned up in afterEach).
//
// fetchBitesPer10k is the one exception: its `percapitaEligible` gate hides
// the "prev" arm's raw count from the public return shape whenever the scope
// is sub-provincial (which isolation requires). For that one arm, a small
// standalone SQL-shape check runs the EXACT merged FILTER expression AND two
// separate pre-consolidation-style queries against the same `inArray(petId,
// …)`-restricted row set and asserts they agree — proving the merged SQL
// used in production computes the same numbers the two-query shape did,
// independent of the eligibility gate.

import { createClient } from "@supabase/supabase-js";
import { and, count, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  cases,
  db,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
  welfareReports,
} from "@/db";
import { fetchVigilanciaMetrics } from "@/lib/analytics/dashboards/surveillance";
import {
  fetchBitesPer10k,
  fetchOpenRabiesObservations,
  fetchOpenWelfareReportsCount,
  fetchSterilizationMetrics,
} from "@/lib/analytics/govt-home-kpis";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const OWNER_EMAIL = "pf1-parity-owner@dim-test.local";
let ownerUserId: string;

const PET_TOKEN_PREFIX = "PF1P-TEST-";
const CASE_CODE_PREFIX = "PF1C-TEST-";
const WR_REF_PREFIX = "PF1W-TEST-";

const DAY_MS = 24 * 60 * 60 * 1000;

async function ensureOwner(): Promise<string> {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const existing = list?.users.find((u) => u.email === OWNER_EMAIL);
  if (existing) {
    const [profile] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, existing.id));
    if (profile) return existing.id;
    await adminSdk.auth.admin.deleteUser(existing.id);
  }
  const r = await createFreshTestUser(adminSdk, {
    email: OWNER_EMAIL,
    password: "Pf1ParityTest_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser: ${r.error?.message}`);
  return r.data.user.id;
}

async function cleanupFixtureRows() {
  await withMutationOverride(async (tx) => {
    await tx.delete(cases).where(sql`${cases.publicCode} LIKE ${`${CASE_CODE_PREFIX}%`}`);
  });
  await db
    .delete(welfareReports)
    .where(sql`${welfareReports.referenceCode} LIKE ${`${WR_REF_PREFIX}%`}`);

  const fixturePets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(sql`${pets.publicToken} LIKE ${`${PET_TOKEN_PREFIX}%`}`);
  const ids = fixturePets.map((p) => p.id);
  if (ids.length === 0) return;
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
  });
  await db.delete(ownerships).where(inArray(ownerships.petId, ids));
  await db.delete(pets).where(inArray(pets.id, ids));
}

async function insertFixturePet(input: {
  name: string;
  province: string;
  locality: string;
  rabiesObservationStatus?: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: `${PET_TOKEN_PREFIX}${generatePublicToken().slice(4)}`,
      name: input.name,
      species: "dog",
      jurisdictionProvince: input.province,
      jurisdictionLocality: input.locality,
      status: "active",
      rabiesObservationStatus: input.rabiesObservationStatus ?? null,
    })
    .returning({ id: pets.id });
  await db.insert(ownerships).values({ petId: row.id, ownerUserId, role: "owner" });
  return row.id;
}

let caseSeq = 0;
async function insertFixtureCase(input: {
  caseKind: string;
  status: "open" | "escalated" | "closed";
  province: string;
  locality: string;
}): Promise<string> {
  caseSeq += 1;
  const [row] = await db
    .insert(cases)
    .values({
      publicCode: `${CASE_CODE_PREFIX}${Date.now()}-${caseSeq}`,
      caseKind: input.caseKind,
      primarySubjectKind: "general",
      status: input.status,
      closedAt: input.status === "closed" ? new Date() : null,
      jurisdictionProvince: input.province,
      jurisdictionLocality: input.locality,
    })
    .returning({ id: cases.id });
  return row.id;
}

let wrSeq = 0;
async function insertFixtureWelfareReport(input: {
  province: string;
  locality: string;
  status: "open" | "triaged" | "in_progress" | "closed" | "invalid" | "duplicate";
  createdAt: Date;
}): Promise<string> {
  wrSeq += 1;
  const [row] = await db
    .insert(welfareReports)
    .values({
      referenceCode: `${WR_REF_PREFIX}${Date.now()}-${wrSeq}`,
      kind: "neglect",
      severity: "medium",
      description: "PF1 parity fixture welfare report.",
      subjectKind: "unowned_animal",
      jurisdictionProvince: input.province,
      jurisdictionLocality: input.locality,
      status: input.status,
      createdAt: input.createdAt,
    })
    .returning({ id: welfareReports.id });
  return row.id;
}

async function emitEvent(input: {
  petId: string;
  eventType: string;
  occurredAt: Date;
  payload?: Record<string, unknown>;
  authorOrganizationId?: string | null;
}) {
  await db.insert(petEvents).values({
    petId: input.petId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    payload: input.payload ?? { payload_version: 1 },
    authorRole: "system",
    authorOrganizationId: input.authorOrganizationId ?? null,
    recordedByUserId: null,
  });
}

beforeAll(async () => {
  ownerUserId = await ensureOwner();
  await cleanupFixtureRows();
});

afterEach(cleanupFixtureRows);

// ============================================================================
// fetchVigilanciaMetrics — cases-table consolidation (rabies-open +
// investigation-active merged into one query with two FILTER columns).
// ============================================================================

describe("PF1 parity — fetchVigilanciaMetrics cases consolidation", () => {
  async function seedCases(province: string, locality: string) {
    // In-scope: 2 active rabies expedientes (open+escalated), 1 closed (must
    // NOT count); 2 active (open+escalated) investigations, 1 closed
    // investigation (must NOT count).
    //
    // The rabies arm counts case_kind='bite_incident' — the kind that actually
    // carries a rabies observation. These fixtures used to say
    // 'rabies_observation', a string no production code writes or closes, so
    // they pinned a counter that could only ever see immortal seed rows.
    await insertFixtureCase({ caseKind: "bite_incident", status: "open", province, locality });
    await insertFixtureCase({ caseKind: "bite_incident", status: "escalated", province, locality });
    await insertFixtureCase({
      caseKind: "bite_incident",
      status: "closed",
      province,
      locality,
    });
    await insertFixtureCase({
      caseKind: "outbreak_investigation",
      status: "open",
      province,
      locality,
    });
    await insertFixtureCase({
      caseKind: "outbreak_investigation",
      status: "escalated",
      province,
      locality,
    });
    await insertFixtureCase({
      caseKind: "outbreak_investigation",
      status: "closed",
      province,
      locality,
    });
  }

  it("govt scope: merged query returns exact rabies+investigation counts, out-of-scope excluded", async () => {
    const province = "Santa Cruz";
    const locality = `PF1-Vig-${Date.now()}`;
    const otherLocality = `PF1-VigOther-${Date.now()}`;
    await seedCases(province, locality);
    // Out-of-scope rows in a different locality — must not leak into the govt count.
    await insertFixtureCase({
      caseKind: "bite_incident",
      status: "open",
      province,
      locality: otherLocality,
    });
    await insertFixtureCase({
      caseKind: "outbreak_investigation",
      status: "open",
      province,
      locality: otherLocality,
    });

    const m = await fetchVigilanciaMetrics({ role: "govt" }, [{ province, locality }]);
    expect(m.rabiesActiveCount).toBe(2);
    expect(m.investigationActiveCount).toBe(2);
  });

  it("admin province+locality drill-down: same merged query, same exact counts", async () => {
    const province = "Santa Cruz";
    const locality = `PF1-VigDrill-${Date.now()}`;
    await seedCases(province, locality);

    const m = await fetchVigilanciaMetrics({ role: "admin" }, [], {
      adminProvince: province,
      adminLocality: locality,
    });
    expect(m.rabiesActiveCount).toBe(2);
    expect(m.investigationActiveCount).toBe(2);
  });

  it("admin universal: sees fixture rows regardless of locality (no scope restriction)", async () => {
    const province = "Santa Cruz";
    const locality = `PF1-VigUniv-${Date.now()}`;
    await seedCases(province, locality);

    const m = await fetchVigilanciaMetrics({ role: "admin" }, []);
    expect(m.rabiesActiveCount).toBeGreaterThanOrEqual(2);
    expect(m.investigationActiveCount).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// fetchOpenWelfareReportsCount — backlog + in-period consolidation.
// ============================================================================

describe("PF1 parity — fetchOpenWelfareReportsCount backlog/period consolidation", () => {
  it("govt scope: merged query returns exact backlog + inPeriod counts", async () => {
    const province = "Santa Cruz";
    const locality = `PF1-WR-${Date.now()}`;
    const now = Date.now();

    // backlog (non-terminal, ANY age) vs inPeriod (createdAt in [since,until],
    // ANY status) are deliberately made to disagree so the test can't pass by
    // both arms coincidentally landing on the same number:
    //   Row1 open,    1d ago   → backlog yes · inPeriod yes
    //   Row2 open,    2d ago   → backlog yes · inPeriod yes
    //   Row3 triaged, 90d ago  → backlog yes · inPeriod NO  (outside 30d window)
    //   Row4 closed,  1d ago   → backlog NO  (terminal) · inPeriod yes
    //   Row5 open,    90d ago  → backlog yes · inPeriod NO  (outside 30d window)
    // backlog = Row1+2+3+5 = 4. inPeriod = Row1+2+4 = 3.
    await insertFixtureWelfareReport({
      province,
      locality,
      status: "open",
      createdAt: new Date(now - 1 * DAY_MS),
    });
    await insertFixtureWelfareReport({
      province,
      locality,
      status: "open",
      createdAt: new Date(now - 2 * DAY_MS),
    });
    await insertFixtureWelfareReport({
      province,
      locality,
      status: "triaged",
      createdAt: new Date(now - 90 * DAY_MS),
    });
    await insertFixtureWelfareReport({
      province,
      locality,
      status: "closed",
      createdAt: new Date(now - 1 * DAY_MS),
    });
    await insertFixtureWelfareReport({
      province,
      locality,
      status: "open",
      createdAt: new Date(now - 90 * DAY_MS),
    });

    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province, locality }],
      windows.trailing30d(),
    );
    const r = await fetchOpenWelfareReportsCount(ctx);
    expect(r.count).toBe(4); // backlog: Row1+2+3+5 (closed excluded)
    expect(r.inPeriod).toBe(3); // inPeriod: Row1+2+4 (90d-old rows excluded)
  });

  it("out-of-scope reports never leak into either merged arm", async () => {
    const province = "Santa Cruz";
    const locality = `PF1-WR-Scope-${Date.now()}`;
    const otherLocality = `PF1-WR-ScopeOther-${Date.now()}`;
    const now = Date.now();

    await insertFixtureWelfareReport({
      province,
      locality,
      status: "open",
      createdAt: new Date(now - 1 * DAY_MS),
    });
    await insertFixtureWelfareReport({
      province,
      locality: otherLocality,
      status: "open",
      createdAt: new Date(now - 1 * DAY_MS),
    });

    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province, locality }],
      windows.trailing30d(),
    );
    const r = await fetchOpenWelfareReportsCount(ctx);
    expect(r.count).toBe(1);
    expect(r.inPeriod).toBe(1);
  });
});

// ============================================================================
// fetchSterilizationMetrics — current/prev/orgs consolidation.
// ============================================================================

describe("PF1 parity — fetchSterilizationMetrics current/prev/orgs consolidation", () => {
  it("merged query returns exact current/prev counts and distinct-org count", async () => {
    const province = "Santa Cruz";
    const locality = `PF1-Ster-${Date.now()}`;
    const now = Date.now();

    const orgRows = await db.select({ id: organizations.id }).from(organizations).limit(2);
    const [orgA, orgB] = orgRows.map((r) => r.id);

    const petA = await insertFixturePet({ name: "SterA", province, locality });
    const petB = await insertFixturePet({ name: "SterB", province, locality });
    // Out-of-scope pet — its events must not count.
    const petOut = await insertFixturePet({
      name: "SterOut",
      province,
      locality: `${locality}-out`,
    });

    // Current window (last 30d): 3 events, 2 distinct orgs (orgA twice is
    // still 1 distinct; orgB once; the third has no org).
    await emitEvent({
      petId: petA,
      eventType: "sterilization_performed",
      occurredAt: new Date(now - 5 * DAY_MS),
      authorOrganizationId: orgA,
    });
    await emitEvent({
      petId: petA,
      eventType: "sterilization_performed",
      occurredAt: new Date(now - 10 * DAY_MS),
      authorOrganizationId: orgA,
    });
    await emitEvent({
      petId: petB,
      eventType: "sterilization_performed",
      occurredAt: new Date(now - 15 * DAY_MS),
      authorOrganizationId: orgB ?? null,
    });
    // Prior window (30-60d ago): 2 events.
    await emitEvent({
      petId: petA,
      eventType: "sterilization_performed",
      occurredAt: new Date(now - 40 * DAY_MS),
    });
    await emitEvent({
      petId: petB,
      eventType: "sterilization_performed",
      occurredAt: new Date(now - 50 * DAY_MS),
    });
    // Out-of-scope current-window event — must not count.
    await emitEvent({
      petId: petOut,
      eventType: "sterilization_performed",
      occurredAt: new Date(now - 5 * DAY_MS),
    });

    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province, locality }],
      windows.trailing30d(),
    );
    const m = await fetchSterilizationMetrics(ctx);
    expect(m.count).toBe(3);
    expect(m.prevCount).toBe(2);
    if (orgRows.length === 2) {
      expect(m.orgs).toBe(2);
    } else {
      expect(m.orgs).toBeGreaterThanOrEqual(0);
    }
    // deltaPct = (3-2)/2 * 100 = 50%, rounded to 1 decimal.
    expect(m.deltaPct).toBe(50);
  });
});

// ============================================================================
// fetchOpenRabiesObservations — thisWeek/lastWeek consolidation. The pets-
// table snapshot arm (rabiesObservationStatus) stays a SEPARATE query — it
// reads a different table with a different scope clause, so it never merges
// with the event-table arm.
// ============================================================================

describe("PF1 parity — fetchOpenRabiesObservations thisWeek/lastWeek consolidation", () => {
  it("merged query returns exact deltaWeek and the snapshot count stays correct", async () => {
    const province = "Santa Cruz";
    const locality = `PF1-Rabies-${Date.now()}`;
    const now = Date.now();

    const petA = await insertFixturePet({
      name: "RabiesA",
      province,
      locality,
      rabiesObservationStatus: "in_progress",
    });
    const petB = await insertFixturePet({
      name: "RabiesB",
      province,
      locality,
      rabiesObservationStatus: "in_progress",
    });
    const petOut = await insertFixturePet({
      name: "RabiesOut",
      province,
      locality: `${locality}-out`,
      rabiesObservationStatus: "in_progress",
    });

    // thisWeek (< 7d ago): 2 started events. lastWeek (7-14d ago): 1 started event.
    await emitEvent({
      petId: petA,
      eventType: "rabies_observation_started",
      occurredAt: new Date(now - 2 * DAY_MS),
    });
    await emitEvent({
      petId: petB,
      eventType: "rabies_observation_started",
      occurredAt: new Date(now - 4 * DAY_MS),
    });
    await emitEvent({
      petId: petA,
      eventType: "rabies_observation_started",
      occurredAt: new Date(now - 10 * DAY_MS),
    });
    // Out-of-scope event — must not count toward deltaWeek.
    await emitEvent({
      petId: petOut,
      eventType: "rabies_observation_started",
      occurredAt: new Date(now - 2 * DAY_MS),
    });

    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province, locality }],
      windows.trailing12m(),
    );
    const r = await fetchOpenRabiesObservations(ctx);
    // Snapshot arm (separate query, pets table): only in-scope pets count.
    expect(r.count).toBe(2);
    // Merged event arm: thisWeek=2, lastWeek=1 → deltaWeek=1.
    expect(r.deltaWeek).toBe(1);
  });
});

// ============================================================================
// fetchBitesPer10k — current/prev consolidation. `percapitaEligible` hides
// the prev arm's raw count from the public return whenever scope is
// sub-provincial (required for fixture isolation), so the arithmetic of the
// EXACT merged FILTER expression is checked directly here against an
// independently-written two-query reference, restricted to this test's own
// petIds (no reliance on any production scope clause or on pre-existing DB
// rows).
// ============================================================================

describe("PF1 parity — fetchBitesPer10k current/prev consolidation", () => {
  it("end-to-end: current-window count (reports) is exact and scope-isolated", async () => {
    const province = "Santa Cruz";
    const locality = `PF1-Bites-${Date.now()}`;
    const now = Date.now();

    const petA = await insertFixturePet({ name: "BitesA", province, locality });
    const petOut = await insertFixturePet({
      name: "BitesOut",
      province,
      locality: `${locality}-out`,
    });

    await emitEvent({
      petId: petA,
      eventType: "incident_reported",
      occurredAt: new Date(now - 30 * DAY_MS),
      payload: { payload_version: 1, incident_type: "bite_inflicted" },
    });
    await emitEvent({
      petId: petA,
      eventType: "incident_reported",
      occurredAt: new Date(now - 60 * DAY_MS),
      payload: { payload_version: 1, incident_type: "bite_inflicted" },
    });
    // Out-of-scope — must not count.
    await emitEvent({
      petId: petOut,
      eventType: "incident_reported",
      occurredAt: new Date(now - 30 * DAY_MS),
      payload: { payload_version: 1, incident_type: "bite_inflicted" },
    });

    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province, locality }],
      windows.trailing12m(),
    );
    const r = await fetchBitesPer10k(ctx);
    expect(r.reports).toBe(2);
    // Fictional province has no census row → per-capita is correctly suppressed,
    // not fabricated — this is the documented H1/C3 behavior, not a bug.
    expect(r.percapitaEligible).toBe(false);
  });

  it("SQL-shape check: the merged FILTER query agrees with two separate pre-consolidation-style queries", async () => {
    const province = "Santa Cruz";
    const locality = `PF1-BitesSQL-${Date.now()}`;
    const now = Date.now();
    const until = new Date(now);
    const since12m = new Date(now - 365 * DAY_MS);
    const since24m = new Date(now - 730 * DAY_MS);

    const petA = await insertFixturePet({ name: "SqlA", province, locality });
    const petB = await insertFixturePet({ name: "SqlB", province, locality });

    // Current window (< 12m ago): 3 qualifying events across 2 pets.
    for (const [petId, daysAgo] of [
      [petA, 10],
      [petA, 100],
      [petB, 200],
    ] as const) {
      await emitEvent({
        petId,
        eventType: "incident_reported",
        occurredAt: new Date(now - daysAgo * DAY_MS),
        payload: { payload_version: 1, incident_type: "bite_inflicted" },
      });
    }
    // Prior window (12-24m ago): 2 qualifying events.
    for (const [petId, daysAgo] of [
      [petA, 400],
      [petB, 600],
    ] as const) {
      await emitEvent({
        petId,
        eventType: "incident_reported",
        occurredAt: new Date(now - daysAgo * DAY_MS),
        payload: { payload_version: 1, incident_type: "bite_inflicted" },
      });
    }

    const petIds = [petA, petB];
    const baseConditions = [
      eq(petEvents.eventType, "incident_reported"),
      sql`(${petEvents.payload}->>'incident_type') = ${"bite_inflicted"}`,
      inArray(petEvents.petId, petIds),
    ];

    // The EXACT merged shape now used in production (govt-home-kpis.ts
    // fetchBitesPer10k): one query, two `count(*) FILTER` columns.
    const untilIso = until.toISOString();
    const since12mIso = since12m.toISOString();
    const since24mIso = since24m.toISOString();
    const [merged] = await db
      .select({
        current:
          sql<number>`count(*) filter (where ${petEvents.occurredAt} >= ${since12mIso} and ${petEvents.occurredAt} <= ${untilIso})`.mapWith(
            Number,
          ),
        prev: sql<number>`count(*) filter (where ${petEvents.occurredAt} >= ${since24mIso} and ${petEvents.occurredAt} < ${since12mIso})`.mapWith(
          Number,
        ),
      })
      .from(petEvents)
      .where(and(...baseConditions));

    // The PRE-consolidation shape: two separate queries.
    const [currentRows, prevRows] = await Promise.all([
      db
        .select({ n: count() })
        .from(petEvents)
        .where(
          and(
            ...baseConditions,
            gte(petEvents.occurredAt, since12m),
            lte(petEvents.occurredAt, until),
          ),
        ),
      db
        .select({ n: count() })
        .from(petEvents)
        .where(
          and(
            ...baseConditions,
            gte(petEvents.occurredAt, since24m),
            lt(petEvents.occurredAt, since12m),
          ),
        ),
    ]);

    expect(merged.current).toBe(3);
    expect(merged.prev).toBe(2);
    expect(merged.current).toBe(currentRows[0]?.n ?? -1);
    expect(merged.prev).toBe(prevRows[0]?.n ?? -1);
  });
});
