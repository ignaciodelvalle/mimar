// D0/D1 post-seed invariant tests.
//
// Asserts that after seed-demo-scenario runs the following hold:
//   D0-1  ≥4 distinct months in sterilization_performed series for CABA
//   D0-1  ≥4 distinct months in vaccination_administered series for CABA
//   D0-2  ≥1 jurisdiction with sterilization coverage below target (CABA)
//         (validated by: DEMO pets exist in CABA with sterilization events
//         AND at least one DEMO pet without sterilization → below-100% coverage)
//   D0-3  ≥1 event_amended for a DEMO pet
//   D0-4  ≥1 alert_subscriptions owned by admin@dim.test with metric
//         sterilization_coverage_pct + direction=below scoped to CABA
//   D0-4  ≥1 alert_firings in status=disparada for that subscription
//   D1    govt@dim.test has ≥1 govt_assignments row to CABA with revokedAt=null
//   D1    govt@dim.test profile.id ≠ admin@dim.test profile.id

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  ALERT_FIRING_OPEN_STATUSES,
  alertFirings,
  alertSubscriptions,
  db,
  govtAssignments,
  petEvents,
  pets,
} from "@/db";

// Must match FOCAL_LOCALITY in scripts/seed-demo-scenario.ts (issue #758).
const FOCAL_PROVINCE = "CABA";
const FOCAL_LOCALITY = "Palermo";

// ---------------------------------------------------------------------------
// The precondition this file forgot to declare
// ---------------------------------------------------------------------------
//
// Every assertion below is about artefacts `pnpm seed:demo:scenario` creates —
// DIM-DEMO- pets, their event series, admin's alert subscription, govt's CABA
// assignment. Nothing in `pnpm db:bootstrap` creates any of them, and this file
// creates none of them either.
//
// So `pnpm test` green was only reachable on a database where somebody had run
// the demo seed by hand: in practice one long-lived local stack. The documented
// CI recipe (supabase start → db:bootstrap → test) produced 8 red tests, and
// the Definition of Done — "paste the green output" — quietly depended on
// undeclared state. That is the suite-wide version of a green that proves
// nothing (external review, H3).
//
// The fix is a declared precondition, not a seed step in bootstrap: the demo
// scenario is demo furniture, and CI has no business building it to satisfy a
// test. When it is absent these tests SKIP, and announce it — see below for
// where the announcement had to go.
//
// PO decision D2, recommended option (dim-interno:docs/plans/2026-07-27-plan-ejecucion-ola1.md §1).
const demoPetCount = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(pets)
  .where(sql`${pets.publicToken} LIKE 'DIM-DEMO-%'`)
  .then((rows) => rows[0]?.n ?? 0)
  .catch(() => 0);

const HAS_DEMO_SEED = demoPetCount > 0;

// HOW THE SKIP ANNOUNCES ITSELF — and why not with console.warn
//
// A console.warn here does not print. Vitest buffers console output per task
// and discards it for a file whose tests are all skipped, so the "loud log"
// the review asked for would have been a silent one — the exact failure this
// file is being fixed for, in a new costume. Measured before choosing this.
//
// The reason therefore travels in the suite NAMES, which every reporter prints
// and which land in the CI log next to the `N skipped` count.
const SKIP_NOTE = HAS_DEMO_SEED
  ? ""
  : " [SKIPPED — no DIM-DEMO- pets; UNVERIFIED. Run pnpm seed:demo:scenario]";

// Lazily resolve admin+govt profile ids once per test run.
async function resolveProfileIds(): Promise<{ adminId: string; govtId: string }> {
  // We query via the Supabase admin SDK through a raw SQL call since
  // seed-demo-scenario uses auth.users not profiles directly. Profiles are
  // created by the handle_new_user trigger so we look up by display_name or
  // by matching the auth.users email via a subquery.
  const rows = (await db.execute(sql`
    SELECT p.id, p.role
    FROM profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE u.email IN ('admin@dim.test', 'govt@dim.test')
  `)) as unknown as Array<{ id: string; role: string }>;

  const adminRow = rows.find((r) => r.role === "admin");
  const govtRow = rows.find((r) => r.role === "govt");

  // Both accounts come from seed-test-users (which db:bootstrap runs), NOT from
  // the demo seed: `rg -o '[a-z]+@dim\.test' scripts/seed-test-users.ts` lists
  // govt@ among its eight. This message used to send the reader to
  // `seed:demo:scenario`, which creates the govt ASSIGNMENT to CABA, not the
  // account — so a missing profile pointed at the one command that cannot fix
  // it. Diagnostics that name the wrong command cost more than no diagnostics.
  if (!adminRow) throw new Error("admin@dim.test profile not found — run pnpm seed:test first");
  if (!govtRow) throw new Error("govt@dim.test profile not found — run pnpm seed:test first");

  return { adminId: adminRow.id, govtId: govtRow.id };
}

describe.skipIf(!HAS_DEMO_SEED)(`D0 — focal CABA series invariants${SKIP_NOTE}`, () => {
  it("D0-1: ≥4 distinct months of sterilization_performed events in CABA (DEMO- pets)", async () => {
    const demoPets = await db
      .select({ id: pets.id })
      .from(pets)
      .where(
        and(
          eq(pets.jurisdictionProvince, FOCAL_PROVINCE),
          sql`${pets.publicToken} LIKE 'DIM-DEMO-%'`,
        ),
      );

    expect(demoPets.length).toBeGreaterThan(0);

    const petIds = demoPets.map((p) => p.id);

    const [row] = await db
      .select({
        buckets: sql<number>`count(distinct date_trunc('month', ${petEvents.occurredAt}))::int`,
      })
      .from(petEvents)
      .where(
        and(
          inArray(petEvents.petId, petIds),
          eq(petEvents.eventType, "sterilization_performed"),
          sql`${petEvents.payload}->>'source' = 'seed-demo-scenario'`,
        ),
      );

    expect(Number(row?.buckets ?? 0)).toBeGreaterThanOrEqual(4);
  });

  it("D0-1: ≥4 distinct months of vaccination_administered events in CABA (DEMO- pets)", async () => {
    const demoPets = await db
      .select({ id: pets.id })
      .from(pets)
      .where(
        and(
          eq(pets.jurisdictionProvince, FOCAL_PROVINCE),
          sql`${pets.publicToken} LIKE 'DIM-DEMO-%'`,
        ),
      );

    const petIds = demoPets.map((p) => p.id);

    const [row] = await db
      .select({
        buckets: sql<number>`count(distinct date_trunc('month', ${petEvents.occurredAt}))::int`,
      })
      .from(petEvents)
      .where(
        and(
          inArray(petEvents.petId, petIds),
          eq(petEvents.eventType, "vaccination_administered"),
          sql`${petEvents.payload}->>'source' = 'seed-demo-scenario'`,
        ),
      );

    expect(Number(row?.buckets ?? 0)).toBeGreaterThanOrEqual(4);
  });

  it("D0-2: DEMO- pets in CABA are registered (coverage denominator) with only some sterilized (below target)", async () => {
    const demoPets = await db
      .select({ id: pets.id })
      .from(pets)
      .where(
        and(
          eq(pets.jurisdictionProvince, FOCAL_PROVINCE),
          sql`${pets.publicToken} LIKE 'DIM-DEMO-%'`,
        ),
      );

    expect(demoPets.length).toBeGreaterThanOrEqual(5);

    const petIds = demoPets.map((p) => p.id);

    const sterilized = await db
      .selectDistinct({ petId: petEvents.petId })
      .from(petEvents)
      .where(
        and(inArray(petEvents.petId, petIds), eq(petEvents.eventType, "sterilization_performed")),
      );

    // Coverage < 100% means at least one pet is not sterilized → CABA below target.
    expect(sterilized.length).toBeGreaterThan(0);
    expect(sterilized.length).toBeLessThan(demoPets.length);
  });

  it("D0-3: ≥1 event_amended for a DEMO pet in CABA", async () => {
    const demoPets = await db
      .select({ id: pets.id })
      .from(pets)
      .where(
        and(
          eq(pets.jurisdictionProvince, FOCAL_PROVINCE),
          sql`${pets.publicToken} LIKE 'DIM-DEMO-%'`,
        ),
      );

    const petIds = demoPets.map((p) => p.id);

    const amended = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(inArray(petEvents.petId, petIds), eq(petEvents.eventType, "event_amended")))
      .limit(1);

    expect(amended.length).toBeGreaterThanOrEqual(1);
  });

  it("D0-4: alert_subscriptions for admin@dim.test scoped to CABA sterilization_coverage_pct below threshold", async () => {
    const { adminId } = await resolveProfileIds();

    const subs = await db
      .select({ id: alertSubscriptions.id, direction: alertSubscriptions.direction })
      .from(alertSubscriptions)
      .where(
        and(
          eq(alertSubscriptions.actorUserId, adminId),
          eq(alertSubscriptions.metricKey, "sterilization_coverage_pct"),
          eq(alertSubscriptions.direction, "below"),
          eq(alertSubscriptions.jurisdictionProvince, FOCAL_PROVINCE),
          eq(alertSubscriptions.isActive, true),
        ),
      );

    expect(subs.length).toBeGreaterThanOrEqual(1);
  });

  it("D0-4: ≥1 alert_firings in open status for the CABA sterilization subscription", async () => {
    const { adminId } = await resolveProfileIds();

    const [sub] = await db
      .select({ id: alertSubscriptions.id })
      .from(alertSubscriptions)
      .where(
        and(
          eq(alertSubscriptions.actorUserId, adminId),
          eq(alertSubscriptions.metricKey, "sterilization_coverage_pct"),
          eq(alertSubscriptions.direction, "below"),
          eq(alertSubscriptions.jurisdictionProvince, FOCAL_PROVINCE),
          eq(alertSubscriptions.isActive, true),
        ),
      )
      .limit(1);

    expect(sub).toBeDefined();

    const firings = await db
      .select({ id: alertFirings.id, status: alertFirings.status })
      .from(alertFirings)
      .where(
        and(
          eq(alertFirings.subscriptionId, sub.id),
          inArray(alertFirings.status, [...ALERT_FIRING_OPEN_STATUSES]),
        ),
      );

    expect(firings.length).toBeGreaterThanOrEqual(1);
    expect(firings[0].status).toBe("disparada");
  });
});

describe.skipIf(!HAS_DEMO_SEED)(`D1 — focal govt account invariants${SKIP_NOTE}`, () => {
  it("D1: govt@dim.test has role=govt in profiles", async () => {
    const rows = (await db.execute(sql`
      SELECT p.role
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      WHERE u.email = 'govt@dim.test'
    `)) as unknown as Array<{ role: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe("govt");
  });

  it("D1: govt@dim.test has ≥1 active govt_assignments to CABA", async () => {
    const { govtId } = await resolveProfileIds();

    const assignments = await db
      .select({ id: govtAssignments.id })
      .from(govtAssignments)
      .where(
        and(
          eq(govtAssignments.userId, govtId),
          eq(govtAssignments.jurisdictionProvince, FOCAL_PROVINCE),
          eq(govtAssignments.jurisdictionLocality, FOCAL_LOCALITY),
          isNull(govtAssignments.revokedAt),
        ),
      );

    expect(assignments.length).toBeGreaterThanOrEqual(1);
  });

  it("D1: govt@dim.test profile.id is distinct from admin@dim.test", async () => {
    const { adminId, govtId } = await resolveProfileIds();
    expect(govtId).not.toBe(adminId);
  });
});

describe.skipIf(!HAS_DEMO_SEED)(
  `B2 — compliance coverage populated (no metric reads 0% universal)${SKIP_NOTE}`,
  () => {
    it("microchip_iso coverage is non-zero in CABA and Buenos Aires", async () => {
      const rows = (await db.execute(sql`
      SELECT p.jurisdiction_province AS prov,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM pet_identifications pi
               WHERE pi.pet_id = p.id AND pi.kind = 'microchip_iso' AND pi.status = 'active'
             )) AS chipped
      FROM pets p
      WHERE p.status IN ('active', 'lost')
        AND p.jurisdiction_province IN ('CABA', 'Buenos Aires')
      GROUP BY p.jurisdiction_province
    `)) as unknown as Array<{ prov: string; chipped: number }>;

      expect(rows.length).toBe(2);
      for (const r of rows) {
        expect(Number(r.chipped)).toBeGreaterThan(0);
      }
    });

    it("rabies coverage (dogs, vaccine_name) is non-zero in CABA", async () => {
      const rows = (await db.execute(sql`
      SELECT count(DISTINCT pe.pet_id) AS vacc
      FROM pet_events pe
      JOIN pets p ON p.id = pe.pet_id
      WHERE pe.event_type = 'vaccination_administered'
        AND (pe.payload->>'vaccine_name') ~* '(antirr[áa]bica|rabies)'
        AND p.species = 'dog'
        AND p.jurisdiction_province = 'CABA'
    `)) as unknown as Array<{ vacc: number }>;

      expect(Number(rows[0]?.vacc ?? 0)).toBeGreaterThan(0);
    });
  },
);
