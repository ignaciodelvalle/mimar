// Tests for the maltrato SQL-queue refactor (E4 followup).
//
// Three groups:
//   1. Unit tests for buildMaltratoListConditions — verifies the returned
//      Drizzle SQL object shape is deterministic and correct without a DB call.
//   2. Integration tests for queue predicates — inserts fixture welfare_reports
//      rows and asserts the right rows come back for urgent / mine / overdue.
//   3. Jurisdiction scope regression — mirrors gob-locality-scope.test.ts but
//      wires through buildMaltratoListConditions + an actual DB query to confirm
//      a govt user scoped to province A gets zero rows for province B.

import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { WELFARE_SLA_DAYS } from "@/app/gob/maltrato/_lib/welfare-sla";
import { db, welfareReports } from "@/db";
import {
  type MaltratoListFilters,
  type ModerationQueueFilters,
  buildMaltratoListConditions,
  buildModerationQueueConditions,
  fetchWelfareMetrics,
} from "@/lib/analytics/govt-dashboards";
import { TERMINAL_STATUSES } from "@/src/modules/welfare/domain/welfare-status-rules";

import { assertKpiListParity } from "./helpers/kpi-list-parity";

// ============================================================================
// Unit tests — no DB required
// ============================================================================

/**
 * The predicate a condition ACTUALLY compiles to: the WHERE clause, with its
 * bound parameters substituted back where their placeholders stood.
 *
 * REPLACES an `extractLiterals` walker that recursed the Drizzle condition's
 * object tree collecting every string and number it found. That tree holds a
 * reference to the whole `PgTable`, so EVERY column name and EVERY pgEnum value
 * of welfare_reports appeared in the extracted string whether the predicate
 * mentioned them or not.
 *
 * Measured 2026-07-31 on `queue: "all"` — a predicate that filters on none of
 * them — the extractor returned a 7 015-character string containing
 * "assigned_to_user_id", "created_at", "closed", "invalid", "duplicate",
 * "critical", "high", "neglect", "medium", "hoarding" and "abandonment". Every
 * assertion in this block that probed a column name or an enum value was
 * therefore passing VACUOUSLY, and any negative assertion over it could not
 * have failed at all. Only the `mine` queue's UUID probe and the length
 * comparison were measuring anything.
 *
 * `.toSQL()` renders only what the WHERE actually says and issues no query.
 * Same reasoning, and the same shape, as `whereSql` in
 * __tests__/geocoding-fallback-jurisdiccion.test.ts.
 */
function whereSql(filters: MaltratoListFilters): string {
  const { sql: text, params } = db
    .select({ id: welfareReports.id })
    .from(welfareReports)
    .where(buildMaltratoListConditions(filters))
    .toSQL();
  const at = text.indexOf(" where ");
  // A predicate that vanished entirely would silently satisfy every negative
  // assertion below, so refuse to hand one back.
  expect(at, `the condition compiled to no WHERE clause: ${text}`).toBeGreaterThan(-1);
  return text.slice(at + " where ".length).replace(/\$(\d+)/g, (_m, n: string) => {
    const v = params[Number(n) - 1];
    return typeof v === "string" ? `'${v}'` : String(v);
  });
}

describe("buildMaltratoListConditions — unit", () => {
  const BASE: MaltratoListFilters = {
    actor: { role: "govt" },
    filteredJurisdictions: [{ province: "Córdoba", locality: "Córdoba" }],
    queue: "all",
    currentUserId: "00000000-0000-0000-0000-000000000001",
  };

  // The DEFAULT predicate, kept as the shared negative witness. Every "queue X
  // adds predicate P" test below pairs its assertion with the absence of P
  // here — that pairing is what proves the probe discriminates, and it is
  // exactly what the object-tree extractor could never do (it reported every
  // probe present on this very predicate).
  const noQueuePredicate = () => whereSql({ ...BASE, queue: "all" });

  it("returns sql`false` for govt with no assignments", () => {
    expect(whereSql({ ...BASE, filteredJurisdictions: [] })).toBe("false");
  });

  it("returns a truthy, still-moderation-gated condition for admin with no jurisdictions", () => {
    const where = whereSql({
      ...BASE,
      actor: { role: "admin" },
      filteredJurisdictions: [],
      queue: "all",
    });
    // Unscoped is not unfiltered: admin drops the jurisdiction clause but keeps
    // the moderation gate. `toBeDefined()` (the old assertion) could not tell
    // those two apart.
    expect(where).not.toBe("false");
    expect(where).not.toContain('"jurisdiction_province"');
    expect(where).toContain('"flagged_at" IS NULL');
  });

  it("includes severity + status predicates for urgent queue", () => {
    const where = whereSql({ ...BASE, queue: "urgent" });
    // urgent queue embeds the severity values and excludes the terminal statuses.
    expect(where).toContain('"severity" in');
    expect(where).toContain("'critical'");
    expect(where).toContain("'high'");
    for (const terminal of TERMINAL_STATUSES) {
      expect(where, `terminal status ${terminal} must be excluded`).toContain(`'${terminal}'`);
    }

    const otherwise = noQueuePredicate();
    expect(otherwise).not.toContain('"severity"');
    expect(otherwise).not.toContain("'critical'");
    expect(otherwise).not.toContain("'closed'");
  });

  it("includes assigned_to_user_id NULL check + terminal statuses for unassigned queue", () => {
    const where = whereSql({ ...BASE, queue: "unassigned" });
    // The unassigned queue mirrors the "Sin asignar" KPI predicate:
    // assigned_to_user_id IS NULL AND status NOT IN (terminal states).
    expect(where).toContain('"assigned_to_user_id" is null');
    expect(where).toContain('not "welfare_reports"."status" in');
    for (const terminal of TERMINAL_STATUSES) {
      expect(where).toContain(`'${terminal}'`);
    }
    // …and it does NOT narrow by severity, which `urgent` does.
    expect(where).not.toContain('"severity"');
    expect(noQueuePredicate()).not.toContain('"assigned_to_user_id"');
  });

  it("includes assignedToUserId predicate for mine queue", () => {
    const userId = "00000000-0000-0000-0000-000000000099";
    const where = whereSql({ ...BASE, queue: "mine", currentUserId: userId });
    expect(where).toContain(`"assigned_to_user_id" = '${userId}'`);
    expect(noQueuePredicate()).not.toContain(userId);
  });

  // The overdue queue used to be `status = 'open' AND createdAt < now() - 7d`,
  // and this test pinned that literal "open". Live review 2026-07-28 measured
  // what the flat rule cost: the tab said 5 while seven rows carried a VENCIDO
  // badge, hiding a *crítica* report three days past its 1-day SLA — because the
  // badge uses the severity tiers from app/gob/maltrato/_lib/welfare-sla.ts and
  // the tab never migrated. It also went the other way: `open` is not the only
  // non-terminal status, so a row inside the tab could read "SIN SLA ACTIVO".
  it("the overdue queue applies the SEVERITY-TIERED SLA, not a flat 7-day window", () => {
    const where = whereSql({ ...BASE, queue: "overdue" });

    // Each severity is PAIRED with its own tier inside the CASE, sourced from
    // the shared map so a tier change cannot move the badge and leave the tab
    // behind. The old assertion only checked that both tokens appeared
    // somewhere in the extracted soup — it could not see the pairing, and in
    // fact saw both on a predicate with no CASE in it at all.
    for (const [severity, days] of Object.entries(WELFARE_SLA_DAYS)) {
      expect(where, `SLA tier for ${severity} (${days} day(s)) missing from the clause`).toMatch(
        new RegExp(`'${severity}'::text\\s+THEN\\s+${days}\\b`),
      );
    }
    expect(where).toContain('"created_at" <');
    expect(where).toContain("INTERVAL '1 day'");

    // The default queue has no SLA window at all — the witness that makes the
    // assertions above capable of failing.
    const otherwise = noQueuePredicate();
    expect(otherwise).not.toContain('"created_at"');
    expect(otherwise).not.toContain("INTERVAL");
  });

  it("the overdue queue excludes TERMINAL statuses, not just non-open ones", () => {
    const where = whereSql({ ...BASE, queue: "overdue" });
    // A closed report has nothing left to escalate and must never be "atrasada".
    expect(where).toContain('not "welfare_reports"."status" in');
    for (const terminal of TERMINAL_STATUSES) {
      expect(where, `terminal status ${terminal} must be excluded`).toContain(`'${terminal}'`);
    }
    expect(noQueuePredicate()).not.toContain('"status"');
  });

  it("includes kind value when kind filter is set", () => {
    expect(whereSql({ ...BASE, kind: "neglect" })).toContain("\"kind\" = 'neglect'");
    expect(noQueuePredicate()).not.toContain('"kind"');
  });

  it("includes severity value when severity filter is set", () => {
    expect(whereSql({ ...BASE, severity: "medium" })).toContain("\"severity\" = 'medium'");
    expect(noQueuePredicate()).not.toContain('"severity"');
  });
});

// ============================================================================
// Integration tests — DB required
// ============================================================================

const WR_PREFIX = "SQLQ-TEST-";
let seqN = 0;

// Resolved once per suite — must reference a real profile for the
// assignedToUserId FK. We use admin@dim.test (seeded by db:bootstrap).
let adminUserId: string;

async function resolveAdminUserId(): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT p.id::text AS id FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE u.email = 'admin@dim.test' LIMIT 1`,
  )) as Array<{ id: string }>;
  const first = rows[0];
  if (!first?.id)
    throw new Error("admin@dim.test profile not found. Run `pnpm db:bootstrap` first.");
  return first.id;
}

async function insertReport(input: {
  province?: string;
  locality?: string;
  status?: "open" | "triaged" | "in_progress" | "closed" | "invalid" | "duplicate";
  severity?: "low" | "medium" | "high" | "critical";
  kind?: "neglect" | "physical_abuse" | "abandonment" | "hoarding" | "other";
  assignedToUserId?: string | null;
  closedAt?: Date | null;
  createdAt?: Date;
  flaggedAt?: Date | null;
  flagReasons?: string[] | null;
  moderationResolvedAt?: Date | null;
  moderationEscalatedAt?: Date | null;
}): Promise<string> {
  seqN += 1;
  const [row] = await db
    .insert(welfareReports)
    .values({
      referenceCode: `${WR_PREFIX}${Date.now()}-${seqN}`,
      kind: input.kind ?? "neglect",
      severity: input.severity ?? "medium",
      description: "SQL queue test fixture.",
      subjectKind: "unowned_animal",
      jurisdictionProvince: input.province ?? "Buenos Aires",
      jurisdictionLocality: input.locality ?? "La Plata",
      status: input.status ?? "open",
      assignedToUserId: input.assignedToUserId ?? null,
      closedAt: input.closedAt ?? null,
      // Only set moderation columns when provided — flag_reasons is NOT NULL
      // with a DB default, so omitting lets the default apply.
      ...(input.flaggedAt !== undefined ? { flaggedAt: input.flaggedAt } : {}),
      ...(input.flagReasons !== undefined ? { flagReasons: input.flagReasons } : {}),
      ...(input.moderationResolvedAt !== undefined
        ? { moderationResolvedAt: input.moderationResolvedAt }
        : {}),
      ...(input.moderationEscalatedAt !== undefined
        ? { moderationEscalatedAt: input.moderationEscalatedAt }
        : {}),
    })
    .returning({ id: welfareReports.id });

  // Override createdAt if requested (for overdue testing).
  if (input.createdAt) {
    await db
      .update(welfareReports)
      .set({ createdAt: input.createdAt })
      .where(eq(welfareReports.id, row.id));
  }

  return row.id;
}

async function cleanup() {
  await db
    .delete(welfareReports)
    .where(sql`${welfareReports.referenceCode} LIKE ${`${WR_PREFIX}%`}`);
}

beforeAll(async () => {
  adminUserId = await resolveAdminUserId();
  await cleanup();
});
afterEach(cleanup);

// Helper: detect whether a Drizzle SQL condition is the `sql`false`` sentinel.
// We check the first queryChunk literal — sql`false` produces [{value:["false"]}].
// Using this avoids JSON.stringify which throws on circular Drizzle table refs.
function isSqlFalseSentinel(cond: ReturnType<typeof buildMaltratoListConditions>): boolean {
  if (!cond) return false;
  const chunks = (cond as { queryChunks?: Array<{ value?: string[] }> }).queryChunks;
  return Array.isArray(chunks) && chunks.length === 1 && chunks[0]?.value?.[0] === "false";
}

// Helper: run a scoped query using buildMaltratoListConditions and return IDs.
async function queryIds(filters: MaltratoListFilters): Promise<string[]> {
  const cond = buildMaltratoListConditions(filters);
  // Short-circuit when the helper returns sql`false` (govt with no assignments).
  if (isSqlFalseSentinel(cond)) return [];
  const rows = await db
    .select({ id: welfareReports.id })
    .from(welfareReports)
    .where(cond)
    .orderBy(welfareReports.createdAt);
  return rows.map((r) => r.id);
}

const GOVT_CORDOBA: MaltratoListFilters = {
  actor: { role: "govt" },
  filteredJurisdictions: [{ province: "Córdoba", locality: "Villa María" }],
  queue: "all",
  currentUserId: "00000000-0000-0000-0000-000000000001",
};

// ============================================================================
// Queue predicates
// ============================================================================

describe("buildMaltratoListConditions — queue: urgent (integration)", () => {
  it("returns critical/high severity reports that are not terminal", async () => {
    const urgentId = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      severity: "critical",
      status: "open",
    });
    const lowId = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      severity: "low",
      status: "open",
    });
    const closedUrgentId = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      severity: "high",
      status: "closed",
      closedAt: new Date(),
    });

    const ids = await queryIds({ ...GOVT_CORDOBA, queue: "urgent" });

    expect(ids).toContain(urgentId);
    expect(ids).not.toContain(lowId);
    expect(ids).not.toContain(closedUrgentId);
  });

  it("also includes high severity not-terminal", async () => {
    const highId = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      severity: "high",
      status: "triaged",
    });
    const ids = await queryIds({ ...GOVT_CORDOBA, queue: "urgent" });
    expect(ids).toContain(highId);
  });
});

describe("buildMaltratoListConditions — queue: mine (integration)", () => {
  it("returns only reports assigned to currentUserId", async () => {
    // assignedToUserId must reference a real profile — use the seeded admin.
    const mineId = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      assignedToUserId: adminUserId,
    });
    const notMineId = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      assignedToUserId: null,
    });

    const ids = await queryIds({ ...GOVT_CORDOBA, queue: "mine", currentUserId: adminUserId });
    expect(ids).toContain(mineId);
    expect(ids).not.toContain(notMineId);
  });

  // C6c workqueue grammar (2026-07-22) — KPI↔list parity fix. Before this fix
  // the "mine" queue predicate only checked assignedToUserId (no terminal
  // exclusion), while the "Mías" KPI tile (fetchWelfareMetrics.myCount) DID
  // exclude closed/invalid/duplicate — so the tile and the list its href
  // (?queue=mine) drilled into silently disagreed. Mirrors the "Sin asignar"
  // parity tests below for the same bug class.
  it("excludes closed/invalid/duplicate reports assigned to currentUserId (matches the Mías KPI)", async () => {
    const prov = "Chaco";
    const loc = `mine-terminal-${Date.now()}`;

    const myOpenId = await insertReport({
      province: prov,
      locality: loc,
      status: "open",
      assignedToUserId: adminUserId,
    });
    const myTriagedId = await insertReport({
      province: prov,
      locality: loc,
      status: "triaged",
      assignedToUserId: adminUserId,
    });
    const myClosedId = await insertReport({
      province: prov,
      locality: loc,
      status: "closed",
      closedAt: new Date(),
      assignedToUserId: adminUserId,
    });
    const myInvalidId = await insertReport({
      province: prov,
      locality: loc,
      status: "invalid",
      closedAt: new Date(),
      assignedToUserId: adminUserId,
    });

    const ids = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: [{ province: prov, locality: loc }],
      queue: "mine",
      currentUserId: adminUserId,
    });

    expect(ids).toContain(myOpenId);
    expect(ids).toContain(myTriagedId);
    expect(ids).not.toContain(myClosedId);
    expect(ids).not.toContain(myInvalidId);
  });

  it("the mine queue count equals the Mías KPI metric for the same scope (KPI↔list parity)", async () => {
    // The Mías KPI links to ?queue=mine; this asserts the destination list
    // and the counted metric are the SAME set — the wayfinding contract
    // (mirrors the "unassigned queue count equals Sin asignar KPI" test).
    const prov = "Chaco";
    const loc = `mine-kpi-${Date.now()}`;

    await insertReport({
      province: prov,
      locality: loc,
      status: "open",
      assignedToUserId: adminUserId,
    });
    await insertReport({
      province: prov,
      locality: loc,
      status: "triaged",
      assignedToUserId: adminUserId,
    });
    await insertReport({
      province: prov,
      locality: loc,
      status: "closed",
      closedAt: new Date(),
      assignedToUserId: adminUserId,
    });
    await insertReport({ province: prov, locality: loc, status: "open", assignedToUserId: null });

    const scope = [{ province: prov, locality: loc }];
    const ids = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: scope,
      queue: "mine",
      currentUserId: adminUserId,
    });
    const metrics = await fetchWelfareMetrics({ role: "govt" }, scope, adminUserId);

    // Two non-terminal rows assigned to adminUserId; the KPI and its
    // drill-down agree.
    expect(ids).toHaveLength(2);
    expect(metrics.myCount).toBe(ids.length);
  });
});

// ============================================================================
// C6c workqueue grammar — "Tomar" (self-assign) row-membership behavior
// ============================================================================
//
// TomarButton (app/gob/maltrato/_components/TomarButton.tsx) calls
// assignWelfareToMeAction, which performs the exact same setAssignee mutation
// exercised directly here (see assign-welfare.test.ts for the use-case's own
// unit coverage of the assignment guard). This integration test asserts the
// OBSERVABLE queue-membership effect the grammar promises: a self-assigned
// row leaves "Sin asignar" and appears in "Mías".

describe("Tomar (self-assign) — row moves out of the unassigned view (integration)", () => {
  it("assigning an unassigned report to currentUserId removes it from queue=unassigned and adds it to queue=mine", async () => {
    const prov = "Chaco";
    const loc = `tomar-${Date.now()}`;

    const reportId = await insertReport({
      province: prov,
      locality: loc,
      status: "open",
      assignedToUserId: null,
    });

    const scope = [{ province: prov, locality: loc }];
    const filtersFor = (queue: MaltratoListFilters["queue"]): MaltratoListFilters => ({
      actor: { role: "govt" },
      filteredJurisdictions: scope,
      queue,
      currentUserId: adminUserId,
    });

    const beforeUnassigned = await queryIds(filtersFor("unassigned"));
    expect(beforeUnassigned).toContain(reportId);
    const beforeMine = await queryIds(filtersFor("mine"));
    expect(beforeMine).not.toContain(reportId);

    // The "Tomar" mutation — identical setAssignee effect as
    // assignWelfareToMeAction → assignWelfare use-case.
    await db
      .update(welfareReports)
      .set({ assignedToUserId: adminUserId })
      .where(eq(welfareReports.id, reportId));

    const afterUnassigned = await queryIds(filtersFor("unassigned"));
    expect(afterUnassigned).not.toContain(reportId);
    const afterMine = await queryIds(filtersFor("mine"));
    expect(afterMine).toContain(reportId);
  });
});

describe("buildMaltratoListConditions — queue: unassigned (integration)", () => {
  it("returns only unassigned, non-terminal reports (matches the Sin asignar KPI)", async () => {
    // Isolated jurisdiction so the metric count reflects only these fixtures.
    const prov = "Chaco";
    const loc = `unassigned-test-${Date.now()}`;

    const unassignedOpenId = await insertReport({
      province: prov,
      locality: loc,
      status: "open",
      assignedToUserId: null,
    });
    const unassignedTriagedId = await insertReport({
      province: prov,
      locality: loc,
      status: "triaged",
      assignedToUserId: null,
    });
    const assignedOpenId = await insertReport({
      province: prov,
      locality: loc,
      status: "open",
      assignedToUserId: adminUserId,
    });
    const unassignedClosedId = await insertReport({
      province: prov,
      locality: loc,
      status: "closed",
      closedAt: new Date(),
      assignedToUserId: null,
    });

    const ids = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: [{ province: prov, locality: loc }],
      queue: "unassigned",
      currentUserId: adminUserId,
    });

    // Matches: unassigned + non-terminal.
    expect(ids).toContain(unassignedOpenId);
    expect(ids).toContain(unassignedTriagedId);
    // Excludes: assigned rows and terminal (closed) rows.
    expect(ids).not.toContain(assignedOpenId);
    expect(ids).not.toContain(unassignedClosedId);
  });

  it("the unassigned queue count equals the Sin asignar KPI metric for the same scope", async () => {
    // The KPI tile links to ?queue=unassigned; this asserts the destination
    // list and the counted metric are the SAME set — the wayfinding contract.
    const prov = "Chaco";
    const loc = `unassigned-kpi-${Date.now()}`;

    await insertReport({ province: prov, locality: loc, status: "open", assignedToUserId: null });
    await insertReport({
      province: prov,
      locality: loc,
      status: "triaged",
      assignedToUserId: null,
    });
    await insertReport({
      province: prov,
      locality: loc,
      status: "open",
      assignedToUserId: adminUserId,
    });
    await insertReport({
      province: prov,
      locality: loc,
      status: "closed",
      closedAt: new Date(),
      assignedToUserId: null,
    });

    const scope = [{ province: prov, locality: loc }];
    const ids = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: scope,
      queue: "unassigned",
      currentUserId: adminUserId,
    });
    const metrics = await fetchWelfareMetrics({ role: "govt" }, scope, adminUserId);

    // Two unassigned non-terminal rows; the KPI and its drill-down agree.
    expect(ids).toHaveLength(2);
    expect(metrics.unassignedCount).toBe(ids.length);
  });
});

describe("buildMaltratoListConditions — queue: overdue (integration)", () => {
  it("returns every NON-TERMINAL report past its own severity's SLA", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const overdueId = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      status: "open",
      createdAt: eightDaysAgo,
    });
    const recentId = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      status: "open",
      // Default createdAt = now (not overdue under any tier).
    });
    // BEHAVIOUR CHANGE, deliberate. This row used to be asserted ABSENT, on the
    // reasoning "overdue only applies to status=open". But `triaged` is not a
    // TERMINAL status, and the SLA predicate the row badge uses
    // (app/gob/maltrato/_lib/welfare-sla.ts) breaches on "still in a non-terminal
    // status and older than its tier". A report that was triaged and then sat for
    // eight days IS overdue — hiding it from the tab while badging its row
    // VENCIDO is the divergence live review 2026-07-28 measured.
    const oldButTriagedId = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      status: "triaged",
      createdAt: eightDaysAgo,
    });
    // A terminal report never breaches — there is nothing left to escalate.
    const oldButClosedId = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      status: "closed",
      createdAt: eightDaysAgo,
    });

    const ids = await queryIds({ ...GOVT_CORDOBA, queue: "overdue" });
    expect(ids).toContain(overdueId);
    expect(ids).toContain(oldButTriagedId);
    expect(ids).not.toContain(recentId);
    expect(ids).not.toContain(oldButClosedId);

    // THE TIERS THEMSELVES: two reports of the SAME age, two severities. At two
    // days a `critical` report is a day past its 1-day SLA; a `medium` one has
    // five days left. Under the old flat 7-day window NEITHER appeared — which
    // is precisely how a crítica three days late stayed out of the tab.
    const criticalLate = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      status: "open",
      severity: "critical",
      createdAt: twoDaysAgo,
    });
    const mediumOnTime = await insertReport({
      province: "Córdoba",
      locality: "Villa María",
      status: "open",
      severity: "medium",
      createdAt: twoDaysAgo,
    });

    const tiered = await queryIds({ ...GOVT_CORDOBA, queue: "overdue" });
    expect(tiered).toContain(criticalLate);
    expect(tiered).not.toContain(mediumOnTime);
  });
});

// ============================================================================
// Jurisdiction scope regression (mirrors gob-locality-scope.test.ts)
// ============================================================================

describe("buildMaltratoListConditions — jurisdiction scope (integration)", () => {
  it("govt assigned to province A sees ZERO rows when selecting province B", async () => {
    // Insert a report in Santa Fe (province B).
    await insertReport({ province: "Santa Fe", locality: "Rosario" });

    // Govt scoped only to Córdoba / Villa María (province A).
    const ids = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: [{ province: "Córdoba", locality: "Villa María" }],
      queue: "all",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });
    // Must not include any Santa Fe row.
    const allReports = await db
      .select({ id: welfareReports.id, prov: welfareReports.jurisdictionProvince })
      .from(welfareReports)
      .where(sql`${welfareReports.referenceCode} LIKE ${`${WR_PREFIX}%`}`);

    const santaFeIds = allReports.filter((r) => r.prov === "Santa Fe").map((r) => r.id);
    for (const id of santaFeIds) {
      expect(ids).not.toContain(id);
    }
  });

  it("govt with empty filteredJurisdictions sees zero rows", async () => {
    await insertReport({ province: "Córdoba", locality: "Villa María" });
    const ids = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: [],
      queue: "all",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });
    expect(ids).toHaveLength(0);
  });

  it("admin (unscoped) sees reports from any province", async () => {
    const idA = await insertReport({ province: "Córdoba", locality: "Villa María" });
    const idB = await insertReport({ province: "Santa Fe", locality: "Rosario" });

    const ids = await queryIds({
      actor: { role: "admin" },
      filteredJurisdictions: [],
      queue: "all",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
  });

  it("govt assigned province A + locality X gets zero rows when URL selects province A + locality Y (out-of-assignment)", async () => {
    // Assignment: Córdoba / Villa María
    // URL selects: Córdoba / Río Cuarto (not in assignments)
    // filteredJurisdictions after intersection = [] → zero rows
    await insertReport({ province: "Córdoba", locality: "Río Cuarto" });

    const ids = await queryIds({
      actor: { role: "govt" },
      // This is what the page computes after intersection: empty because Río Cuarto
      // is not in the govt's assignment list.
      filteredJurisdictions: [],
      queue: "all",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });
    expect(ids).toHaveLength(0);
  });
});

// ============================================================================
// Pagination / limit sanity
// ============================================================================

describe("pagination sanity (integration)", () => {
  it("offset + limit correctly pages through results", async () => {
    // Insert 3 reports in a unique isolated jurisdiction. The locality is
    // synthetic (a real one like Resistencia is populated by the national demo
    // seed, whose welfare reports would inflate the page counts below).
    const prov = "Chaco";
    const loc = `pagination-test-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      await insertReport({ province: prov, locality: loc });
    }

    const cond = buildMaltratoListConditions({
      actor: { role: "govt" },
      filteredJurisdictions: [{ province: prov, locality: loc }],
      queue: "all",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });

    // Page 1: 2 rows.
    const page1 = await db
      .select({ id: welfareReports.id })
      .from(welfareReports)
      .where(cond)
      .orderBy(welfareReports.createdAt)
      .limit(2)
      .offset(0);

    // Page 2: 1 row.
    const page2 = await db
      .select({ id: welfareReports.id })
      .from(welfareReports)
      .where(cond)
      .orderBy(welfareReports.createdAt)
      .limit(2)
      .offset(2);

    // Total via count.
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(welfareReports)
      .where(cond);

    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(1);
    expect(n).toBe(3);
    // No overlap between pages.
    const ids1 = new Set(page1.map((r) => r.id));
    for (const r of page2) expect(ids1.has(r.id)).toBe(false);
  });
});

// ============================================================================
// parsePage cap — unit tests
// ============================================================================

// Inline copy of parsePage from the page module (private fn — tested here inline).
function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 10_000) : 1;
}

describe("parsePage — unit", () => {
  it("returns 1 for undefined", () => expect(parsePage(undefined)).toBe(1));
  it("returns 1 for empty string", () => expect(parsePage("")).toBe(1));
  it("returns 1 for 0", () => expect(parsePage("0")).toBe(1));
  it("returns 1 for negative", () => expect(parsePage("-5")).toBe(1));
  it("returns 1 for NaN string", () => expect(parsePage("abc")).toBe(1));
  it("returns the page for a normal value", () => expect(parsePage("3")).toBe(3));
  it("floors decimal pages", () => expect(parsePage("2.9")).toBe(2));
  it("caps at 10_000", () => expect(parsePage("99999")).toBe(10_000));
  it("caps Infinity", () => expect(parsePage("Infinity")).toBe(1)); // Infinity is not finite
  it("returns exactly 10_000 for '10000'", () => expect(parsePage("10000")).toBe(10_000));
});

// ============================================================================
// parseQueue default — unit tests (C2 language contract, 2026-07-22:
// PO-locked default tab = "sin asignar abiertas", not "Todas")
// ============================================================================

// Inline copy of the page's parseQueue (private fn — mirrors the parsePage
// inline-copy convention above). VALID_QUEUES/DEFAULT_QUEUE mirror
// app/gob/maltrato/MaltratoQueueScreen.tsx exactly (F1 fusion, 2026-07-22:
// the queue body moved out of page.tsx, which is now just a redirect shim —
// see that file's own header comment).
const VALID_QUEUES_COPY = ["urgent", "unassigned", "mine", "all", "overdue", "unverified"];
const DEFAULT_QUEUE_COPY = "unassigned";
function parseQueue(raw: string | undefined): string {
  if (!raw) return DEFAULT_QUEUE_COPY;
  return VALID_QUEUES_COPY.includes(raw) ? raw : DEFAULT_QUEUE_COPY;
}

describe("parseQueue — unit (maltrato default queue)", () => {
  it("defaults to 'unassigned' (sin asignar abiertas) when no ?queue= param is present", () => {
    expect(parseQueue(undefined)).toBe("unassigned");
  });

  it("falls back to 'unassigned' for an invalid/unknown queue value", () => {
    expect(parseQueue("bogus")).toBe("unassigned");
  });

  it("an explicit ?queue= param still wins — including 'all'", () => {
    expect(parseQueue("all")).toBe("all");
    expect(parseQueue("urgent")).toBe("urgent");
    expect(parseQueue("mine")).toBe("mine");
    expect(parseQueue("overdue")).toBe("overdue");
    expect(parseQueue("unverified")).toBe("unverified");
  });
});

describe("app/gob/maltrato/MaltratoQueueScreen.tsx — source stays in sync with the default-queue contract", () => {
  it("DEFAULT_QUEUE is 'unassigned' and parseQueue resolves through it (no drift from this test's inline copy)", async () => {
    const fs = await import("node:fs");
    // F1 fusion (2026-07-22): the queue body relocated out of page.tsx (now a
    // redirect shim into /gob/denuncias?etapa=triage) into this sibling file,
    // imported by the Denuncias hub — same contract, same defaults, new home.
    const src = fs.readFileSync("app/gob/maltrato/MaltratoQueueScreen.tsx", "utf8");
    expect(src).toMatch(/DEFAULT_QUEUE:\s*MaltratoQueue\s*=\s*"unassigned"/);
    // UI review M5 (2026-08-06): the queue selector stopped being <UrlTabs>
    // (which read the default via `defaultValue={DEFAULT_QUEUE}`) and became a
    // row of link chips, so the ONE remaining consumer of the default is
    // parseQueue — both of its branches must resolve through the constant, not
    // a repeated literal.
    expect(src).toMatch(/if \(!raw\) return DEFAULT_QUEUE;/);
    expect(src).toMatch(/:\s*DEFAULT_QUEUE;/);
    // The old landing default must not still be hardcoded as the fallback.
    expect(src).not.toMatch(/if \(!raw\) return "all";/);
  });
});

// ============================================================================
// CABA two-tier locality scope (jurisdiction-scoping class bug — 2026-07-07)
//
// INDEC models CABA as ONE locality ("Ciudad Autónoma de Buenos Aires"); the 48
// barrios (Palermo, Almagro, …) are a finer overlay. A govt operator assigned
// the whole-city locality governs ALL of CABA and MUST see barrio-tagged
// denuncias — an anonymous denuncia whose address geocoded to a barrio was
// invisible before the isWholeProvinceLocality subsumption fix.
// ============================================================================

const CABA_WHOLE = "Ciudad Autónoma de Buenos Aires";

describe("buildMaltratoListConditions — CABA whole-province subsumption (integration)", () => {
  it("whole-CABA operator sees barrio-tagged reports (Almagro, Palermo) but not other provinces", async () => {
    const almagroId = await insertReport({ province: "CABA", locality: "Almagro" });
    const palermoId = await insertReport({ province: "CABA", locality: "Palermo" });
    const wholeCityId = await insertReport({ province: "CABA", locality: CABA_WHOLE });
    const saltaId = await insertReport({ province: "Salta", locality: "Salta" });

    const ids = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: [{ province: "CABA", locality: CABA_WHOLE }],
      queue: "all",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });

    // Barrio-tagged + whole-city CABA rows are all visible to the whole-CABA operator.
    expect(ids).toContain(almagroId);
    expect(ids).toContain(palermoId);
    expect(ids).toContain(wholeCityId);
    // Other provinces stay invisible (the fix must NOT widen security).
    expect(ids).not.toContain(saltaId);
  });

  it("a Salta operator does NOT see a CABA barrio report (cross-province isolation preserved)", async () => {
    const almagroId = await insertReport({ province: "CABA", locality: "Almagro" });

    const ids = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: [{ province: "Salta", locality: "Salta" }],
      queue: "all",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });

    expect(ids).not.toContain(almagroId);
  });

  it("a barrio-scoped operator (CABA / Palermo) stays narrow — sees Palermo, not Almagro", async () => {
    const almagroId = await insertReport({ province: "CABA", locality: "Almagro" });
    const palermoId = await insertReport({ province: "CABA", locality: "Palermo" });

    const ids = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: [{ province: "CABA", locality: "Palermo" }],
      queue: "all",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });

    expect(ids).toContain(palermoId);
    // Barrio-specific assignment is exact-match only — no subsumption.
    expect(ids).not.toContain(almagroId);
  });
});

// ============================================================================
// Flagged-vs-unflagged routing: moderation queue vs triage queue
//
// Anonymous denuncias are auto-flagged by heuristics ONLY when a reason fires.
// Unflagged reports go straight to the /gob/maltrato triage queue; flagged
// (unresolved) reports are held in the admin /admin/moderacion queue and are
// EXCLUDED from triage until moderation resolves them. DEN-6WQX-CCUC was never
// flagged, so its absence from /admin/moderacion is correct.
// ============================================================================

function isModSqlFalse(cond: ReturnType<typeof buildModerationQueueConditions>): boolean {
  if (!cond) return false;
  const chunks = (cond as { queryChunks?: Array<{ value?: string[] }> }).queryChunks;
  return Array.isArray(chunks) && chunks.length === 1 && chunks[0]?.value?.[0] === "false";
}

async function queryModerationIds(filters: ModerationQueueFilters): Promise<string[]> {
  const cond = buildModerationQueueConditions(filters);
  if (isModSqlFalse(cond)) return [];
  const rows = await db.select({ id: welfareReports.id }).from(welfareReports).where(cond);
  return rows.map((r) => r.id);
}

describe("flagged-vs-unflagged routing (integration)", () => {
  const ADMIN_TRIAGE: MaltratoListFilters = {
    actor: { role: "admin" },
    filteredJurisdictions: [],
    queue: "all",
    currentUserId: "00000000-0000-0000-0000-000000000001",
  };
  const ADMIN_MOD: ModerationQueueFilters = {
    actor: { role: "admin" },
    jurisdictions: [],
    status: "pending",
  };

  it("an unflagged report is in the triage queue but NOT the moderation queue", async () => {
    const unflaggedId = await insertReport({ province: "Salta", locality: "Salta" });

    const triageIds = await queryIds({
      ...ADMIN_TRIAGE,
      selectedProvince: "Salta",
    });
    const modIds = await queryModerationIds(ADMIN_MOD);

    expect(triageIds).toContain(unflaggedId);
    expect(modIds).not.toContain(unflaggedId);
  });

  it("a flagged, unresolved report is in the moderation queue but EXCLUDED from triage", async () => {
    const flaggedId = await insertReport({
      province: "Salta",
      locality: "Salta",
      flaggedAt: new Date(),
      flagReasons: ["short_description"],
    });

    const triageIds = await queryIds({
      ...ADMIN_TRIAGE,
      selectedProvince: "Salta",
    });
    const modIds = await queryModerationIds(ADMIN_MOD);

    expect(modIds).toContain(flaggedId);
    expect(triageIds).not.toContain(flaggedId);
  });

  it("a flagged report that was moderation-resolved re-enters the triage queue", async () => {
    const resolvedId = await insertReport({
      province: "Salta",
      locality: "Salta",
      flaggedAt: new Date(),
      flagReasons: ["short_description"],
      moderationResolvedAt: new Date(),
    });

    const triageIds = await queryIds({
      ...ADMIN_TRIAGE,
      selectedProvince: "Salta",
    });
    expect(triageIds).toContain(resolvedId);
  });
});

// ============================================================================
// includeEscalated — govt vs admin "pending" parity (PO decision 2026-07-19:
// unify /admin/moderacion's hand-rolled predicate into buildModerationQueueConditions)
// ============================================================================

describe("buildModerationQueueConditions — includeEscalated (integration)", () => {
  it("default (includeEscalated omitted) EXCLUDES an escalated-but-unresolved report — govt queue", async () => {
    const escalatedId = await insertReport({
      province: "Salta",
      locality: "Salta",
      flaggedAt: new Date(),
      flagReasons: ["short_description"],
      moderationEscalatedAt: new Date(),
    });

    const govtIds = await queryModerationIds({
      actor: { role: "govt" },
      jurisdictions: [{ province: "Salta", locality: "Salta" }],
      status: "pending",
      // includeEscalated omitted — govt actionable-queue semantics.
    });

    expect(govtIds).not.toContain(escalatedId);
  });

  it("includeEscalated: true INCLUDES an escalated-but-unresolved report — admin inbox", async () => {
    const escalatedId = await insertReport({
      province: "Salta",
      locality: "Salta",
      flaggedAt: new Date(),
      flagReasons: ["short_description"],
      moderationEscalatedAt: new Date(),
    });

    const adminIds = await queryModerationIds({
      actor: { role: "admin" },
      jurisdictions: [],
      status: "pending",
      includeEscalated: true,
    });

    expect(adminIds).toContain(escalatedId);
  });

  it("includeEscalated: true still excludes a moderation-resolved report from pending", async () => {
    const resolvedId = await insertReport({
      province: "Salta",
      locality: "Salta",
      flaggedAt: new Date(),
      flagReasons: ["short_description"],
      moderationEscalatedAt: new Date(),
      moderationResolvedAt: new Date(),
    });

    const adminIds = await queryModerationIds({
      actor: { role: "admin" },
      jurisdictions: [],
      status: "pending",
      includeEscalated: true,
    });

    expect(adminIds).not.toContain(resolvedId);
  });
});

// ============================================================================
// Status filter — unit + integration
// ============================================================================

describe("buildMaltratoListConditions — status filter (unit)", () => {
  const BASE: MaltratoListFilters = {
    actor: { role: "govt" },
    filteredJurisdictions: [{ province: "Córdoba", locality: "Córdoba" }],
    queue: "all",
    currentUserId: "00000000-0000-0000-0000-000000000001",
  };

  it("includes status value when status filter is set", () => {
    expect(whereSql({ ...BASE, status: "closed" })).toContain("\"status\" = 'closed'");
  });

  it("status=null adds NO status predicate at all (not merely a shorter one)", () => {
    // This used to compare the two extracted strings by LENGTH, which was the
    // one honest assertion left in the old block but a weak one: any extra
    // character anywhere satisfied it. Naming the absent column is exact.
    expect(whereSql({ ...BASE, status: null })).not.toContain('"status"');
  });
});

describe("buildMaltratoListConditions — status filter (integration)", () => {
  it("returns only reports with the specified status", async () => {
    const openId = await insertReport({
      province: "Formosa",
      locality: "Formosa",
      status: "open",
    });
    const closedId = await insertReport({
      province: "Formosa",
      locality: "Formosa",
      status: "closed",
      closedAt: new Date(),
    });

    const openIds = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: [{ province: "Formosa", locality: "Formosa" }],
      queue: "all",
      status: "open",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });
    expect(openIds).toContain(openId);
    expect(openIds).not.toContain(closedId);

    const closedIds = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: [{ province: "Formosa", locality: "Formosa" }],
      queue: "all",
      status: "closed",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });
    expect(closedIds).toContain(closedId);
    expect(closedIds).not.toContain(openId);
  });
});

// ============================================================================
// Admin province/locality filter (C-1)
// ============================================================================

describe("buildMaltratoListConditions — admin province/locality filter (integration)", () => {
  it("admin selecting province X returns only reports from province X", async () => {
    const cordobaId = await insertReport({ province: "Córdoba", locality: "Córdoba" });
    const santaFeId = await insertReport({ province: "Santa Fe", locality: "Santa Fe" });

    const ids = await queryIds({
      actor: { role: "admin" },
      filteredJurisdictions: [],
      queue: "all",
      selectedProvince: "Córdoba",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });

    expect(ids).toContain(cordobaId);
    expect(ids).not.toContain(santaFeId);
  });

  it("admin selecting province + locality returns only matching rows", async () => {
    const cordobaCityId = await insertReport({ province: "Córdoba", locality: "Córdoba" });
    const villaMaria = await insertReport({ province: "Córdoba", locality: "Villa María" });

    const ids = await queryIds({
      actor: { role: "admin" },
      filteredJurisdictions: [],
      queue: "all",
      selectedProvince: "Córdoba",
      selectedLocality: "Córdoba",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });

    expect(ids).toContain(cordobaCityId);
    expect(ids).not.toContain(villaMaria);
  });

  it("govt user (province A) selecting province B still returns ZERO rows (bypass-proof)", async () => {
    // This is the key safety test: govt assigned to Córdoba cannot see Santa Fe
    // reports by passing selectedProvince — we do NOT pass selectedProvince for
    // govt; the page uses filteredJurisdictions intersection instead.
    await insertReport({ province: "Santa Fe", locality: "Rosario" });

    const ids = await queryIds({
      actor: { role: "govt" },
      // filteredJurisdictions after intersection with assignments scoped to Córdoba = []
      // because Santa Fe is not in the assignments list.
      filteredJurisdictions: [],
      queue: "all",
      // Even if selectedProvince were passed for govt (which the page never does),
      // the short-circuit at the top of buildMaltratoListConditions returns sql`false`
      // before any selectedProvince check runs.
      selectedProvince: "Santa Fe",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });
    expect(ids).toHaveLength(0);
  });

  it("COUNT uses the same WHERE as the list query (same condition object reuse)", async () => {
    const id = await insertReport({ province: "La Pampa", locality: "Santa Rosa" });

    const cond = buildMaltratoListConditions({
      actor: { role: "admin" },
      filteredJurisdictions: [],
      queue: "all",
      selectedProvince: "La Pampa",
      currentUserId: "00000000-0000-0000-0000-000000000001",
    });

    const listRows = await db.select({ id: welfareReports.id }).from(welfareReports).where(cond);

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(welfareReports)
      .where(cond);

    // COUNT and list must agree.
    expect(n).toBe(listRows.length);
    expect(listRows.map((r) => r.id)).toContain(id);
  });
});

// ============================================================================
// KPI↔list parity harness (task #57) — reusable assertKpiListParity, wired
// against fetchWelfareMetrics.unassignedCount (the "Sin asignar" KPI tile)
// vs the "unassigned" queue list. This is the maltrato half of the two
// dashboard wirings; the second (perdidas) lives in
// __tests__/govt-dashboards.test.ts. Goes beyond the bare-queue parity test
// above (queue: unassigned (integration) — "the unassigned queue count
// equals the Sin asignar KPI metric") by exercising kind/severity domain
// filters through the SAME harness, since the original filter-honesty bug
// (welfare.ts's "KPI↔list parity" note) was specifically about the KPI
// tiles ignoring kind/severity/status while the list honored them.
// ============================================================================

describe("KPI↔list parity harness (assertKpiListParity) — maltrato unassignedCount", () => {
  it("unassignedCount matches the unassigned-queue list length when a kind filter narrows both sides", async () => {
    const prov = "Chaco";
    const loc = `parity-kind-${Date.now()}`;

    const neglectOpen = await insertReport({
      province: prov,
      locality: loc,
      status: "open",
      kind: "neglect",
      assignedToUserId: null,
    });
    const hoardingOpen = await insertReport({
      province: prov,
      locality: loc,
      status: "open",
      kind: "hoarding",
      assignedToUserId: null,
    });
    const neglectAssigned = await insertReport({
      province: prov,
      locality: loc,
      status: "open",
      kind: "neglect",
      assignedToUserId: adminUserId,
    });
    void hoardingOpen;
    void neglectAssigned;

    const scope = [{ province: prov, locality: loc }];

    await assertKpiListParity({
      filters: { kind: "neglect" as const },
      getKpiCount: async (f) =>
        (await fetchWelfareMetrics({ role: "govt" }, scope, adminUserId, { kind: f.kind }))
          .unassignedCount,
      getListRows: async (f) =>
        queryIds({
          actor: { role: "govt" },
          filteredJurisdictions: scope,
          queue: "unassigned",
          kind: f.kind,
          currentUserId: adminUserId,
        }),
      label: "maltrato — unassigned queue, kind=neglect",
    });

    // Sanity: the fixture actually exercised the kind filter (neglect-open
    // present, hoarding-open and the assigned neglect row excluded) — without
    // this the parity assertion above could pass vacuously at 0 == 0.
    const ids = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: scope,
      queue: "unassigned",
      kind: "neglect",
      currentUserId: adminUserId,
    });
    expect(ids).toEqual([neglectOpen]);
  });

  it("unassignedCount matches the unassigned-queue list length when a severity filter narrows both sides", async () => {
    const prov = "Chaco";
    const loc = `parity-severity-${Date.now()}`;

    const criticalOpen = await insertReport({
      province: prov,
      locality: loc,
      status: "open",
      severity: "critical",
      assignedToUserId: null,
    });
    const lowOpen = await insertReport({
      province: prov,
      locality: loc,
      status: "open",
      severity: "low",
      assignedToUserId: null,
    });
    void lowOpen;

    const scope = [{ province: prov, locality: loc }];

    await assertKpiListParity({
      filters: { severity: "critical" as const },
      getKpiCount: async (f) =>
        (await fetchWelfareMetrics({ role: "govt" }, scope, adminUserId, { severity: f.severity }))
          .unassignedCount,
      getListRows: async (f) =>
        queryIds({
          actor: { role: "govt" },
          filteredJurisdictions: scope,
          queue: "unassigned",
          severity: f.severity,
          currentUserId: adminUserId,
        }),
      label: "maltrato — unassigned queue, severity=critical",
    });

    const ids = await queryIds({
      actor: { role: "govt" },
      filteredJurisdictions: scope,
      queue: "unassigned",
      severity: "critical",
      currentUserId: adminUserId,
    });
    expect(ids).toEqual([criticalOpen]);
  });
});
