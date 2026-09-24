// Integration tests for deriveWelfareToOrg — the R7 derivation writer.
//
// WHAT THIS PINS, AND WHY IT IS NOT OPTIONAL
// ---------------------------------------------------------------------------
// The body of this writer used to live inside `deriveWelfareToOrgAction`
// (src/modules/welfare/actions.ts) and wrote its audit row through
// `WelfareRepository.insertAudit` — a bare `db.insert(auditLog).values(v)`.
// The split moved it onto `writeAuditLog(tx, …)` (lib/infra/audit-log.ts),
// which is a DIFFERENT code path building the same row. The invariant that
// survives that swap is the ROW, not the call: an `audit_log` row whose action
// string, actor, target organization or payload keys drifted is a silently
// broken accountability trail (Ley 25.326), and nothing else in the suite
// notices.
//
// So the first test asserts the persisted row field-for-field against the exact
// values `insertAudit` received before the split. It is RED-capable in the way
// that matters: change `action` from "welfare_report_derived_to_org", drop a
// payload key, rename one to snake_case, or stop passing targetOrganizationId,
// and that assertion fails.
//
// The second test pins the module BOUNDARY: the writer BUILDS notifications and
// must not persist them. `flushNotifications` stays in actions.ts (shared by
// every welfare action, and the `lint:notifications` corpus is path-keyed —
// a raw notification insert here would register a NEW offender).
//
// Postgres is required. If unavailable the test file will fail at connection
// and that is expected — the failure is reported as an infra block.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditLog,
  db,
  notifications,
  organizationMemberships,
  organizations,
  profiles,
  welfareReports,
} from "@/db";
import { deriveWelfareToOrg } from "./derive-to-org-writer";

// ---------------------------------------------------------------------------
// Fixture identifiers — must not collide with production or other test data
// ---------------------------------------------------------------------------

const ACTOR_ID = "d1de0000-0000-4000-8000-00000000d001";
const TARGET_MEMBER_ID = "d1de0000-0000-4000-8000-00000000d002";
const PREVIOUS_MEMBER_ID = "d1de0000-0000-4000-8000-00000000d003";
const PROFILE_IDS = [ACTOR_ID, TARGET_MEMBER_ID, PREVIOUS_MEMBER_ID];

const UNKNOWN_ORG_ID = "d1de0000-0000-4000-8000-0000000000ff";

const ORG_TOKEN_PREFIX = "DERWRITER-";
const TARGET_ORG_TOKEN = `${ORG_TOKEN_PREFIX}TARGET`;
const PREVIOUS_ORG_TOKEN = `${ORG_TOKEN_PREFIX}PREV`;
const UNVERIFIED_ORG_TOKEN = `${ORG_TOKEN_PREFIX}UNVERIF`;
const CLINIC_ORG_TOKEN = `${ORG_TOKEN_PREFIX}CLINIC`;

// UNIQUE PER RUN — deliberately, and this is not cosmetic. `audit_log` is
// append-only IN THE DATABASE (trigger enforce_audit_log_append_only raises
// 23001 on DELETE), so this file's rows cannot be cleaned up; they accumulate
// across local runs exactly as the invariant intends. A fixed reference code
// would therefore make "exactly one audit row" fail on the SECOND run. Scoping
// every audit assertion to a per-run code keeps the count meaningful forever.
const REF_PREFIX = "DEN-DERWRITER-";
const REFERENCE_CODE = `${REF_PREFIX}${randomUUID().slice(0, 8).toUpperCase()}`;
const TARGET_ORG_DISPLAY_NAME = "Refugio destino (derive writer fixture)";

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

// NOTE: audit_log rows are NOT cleaned up — they cannot be. The table is
// append-only in the database and a DELETE raises 23001. The per-run
// REFERENCE_CODE above is what keeps the assertions exact despite that.
// audit_log's actor / target-organization FKs are ON DELETE SET NULL, so
// dropping the profile and organization fixtures below is unaffected.
async function cleanupFixtures() {
  await db.delete(notifications).where(inArray(notifications.userId, PROFILE_IDS));
  await db.execute(sql`
    DELETE FROM welfare_reports WHERE reference_code LIKE ${`${REF_PREFIX}%`}
  `);
  await db.execute(sql`
    DELETE FROM organization_memberships
    WHERE organization_id IN (
      SELECT id FROM organizations WHERE public_token LIKE ${`${ORG_TOKEN_PREFIX}%`}
    )
  `);
  await db.execute(sql`
    DELETE FROM organizations WHERE public_token LIKE ${`${ORG_TOKEN_PREFIX}%`}
  `);
  await db.delete(profiles).where(inArray(profiles.id, PROFILE_IDS));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let targetOrgId: string;
let previousOrgId: string;
let unverifiedOrgId: string;
let clinicOrgId: string;
let reportId: string;

beforeAll(async () => {
  await cleanupFixtures();

  await db.insert(profiles).values([
    { id: ACTOR_ID, displayName: "derive-writer-actor", role: "govt" },
    { id: TARGET_MEMBER_ID, displayName: "derive-writer-target-member", role: "owner" },
    { id: PREVIOUS_MEMBER_ID, displayName: "derive-writer-previous-member", role: "owner" },
  ]);

  const orgRows = await db
    .insert(organizations)
    .values([
      {
        publicToken: TARGET_ORG_TOKEN,
        legalName: "Refugio Destino AC",
        displayName: TARGET_ORG_DISPLAY_NAME,
        orgType: "shelter",
        email: "target@derive-writer.test",
        verified: true,
      },
      {
        publicToken: PREVIOUS_ORG_TOKEN,
        legalName: "Red Rescate Previa AC",
        displayName: "Red previa (derive writer fixture)",
        orgType: "rescue_network",
        email: "previous@derive-writer.test",
        verified: true,
      },
      {
        publicToken: UNVERIFIED_ORG_TOKEN,
        legalName: "Refugio Sin Verificar AC",
        displayName: "Refugio sin verificar (derive writer fixture)",
        orgType: "shelter",
        email: "unverified@derive-writer.test",
        verified: false,
      },
      {
        publicToken: CLINIC_ORG_TOKEN,
        legalName: "Clinica Inelegible SRL",
        displayName: "Clinica inelegible (derive writer fixture)",
        orgType: "clinic",
        email: "clinic@derive-writer.test",
        verified: true,
      },
    ])
    .returning({ id: organizations.id, publicToken: organizations.publicToken });

  const byToken = new Map(orgRows.map((o) => [o.publicToken, o.id]));
  targetOrgId = byToken.get(TARGET_ORG_TOKEN) as string;
  previousOrgId = byToken.get(PREVIOUS_ORG_TOKEN) as string;
  unverifiedOrgId = byToken.get(UNVERIFIED_ORG_TOKEN) as string;
  clinicOrgId = byToken.get(CLINIC_ORG_TOKEN) as string;

  await db.insert(organizationMemberships).values([
    { organizationId: targetOrgId, userId: TARGET_MEMBER_ID, role: "coordinator" },
    { organizationId: previousOrgId, userId: PREVIOUS_MEMBER_ID, role: "coordinator" },
  ]);

  // The report starts DERIVED to the previous org, so one run exercises both
  // the derivation write and the UI-7 B8 re-derivation branch.
  const [report] = await db
    .insert(welfareReports)
    .values({
      referenceCode: REFERENCE_CODE,
      kind: "neglect",
      severity: "medium",
      description: "Derive-to-org writer integration fixture (>=20 chars ok).",
      subjectKind: "general",
      derivedToOrganizationId: previousOrgId,
      orgInterventionStatus: "tomado",
      orgInterventionAt: new Date(),
    })
    .returning({ id: welfareReports.id });
  reportId = report.id;
});

afterAll(async () => {
  await cleanupFixtures();
});

/**
 * Every audit row this run has written, newest first. Assertions are DELTAS
 * against this list, never absolute counts: three tests in the first describe
 * call the writer with the same per-run reference code and each appends a
 * row, so an absolute "exactly one" would hold only under declaration-order
 * execution — and since audit_log rejects DELETE, a shuffled or retried run
 * would stay red until the database is rebuilt.
 */
async function auditRowsForRun() {
  return db
    .select()
    .from(auditLog)
    .where(sql`${auditLog.payload}->>'referenceCode' = ${REFERENCE_CODE}`)
    .orderBy(desc(auditLog.performedAt));
}

// ---------------------------------------------------------------------------
// The audit row — the contract that survived the insertAudit → writeAuditLog swap
// ---------------------------------------------------------------------------

describe("deriveWelfareToOrg", () => {
  it("persists the derivation and appends the SAME audit_log row insertAudit produced", async () => {
    const auditRowsBefore = (await auditRowsForRun()).length;

    const outcome = await deriveWelfareToOrg({
      welfareReportId: reportId,
      targetOrgId,
      actorUserId: ACTOR_ID,
      referenceCode: REFERENCE_CODE,
      previousOrgId,
    });

    expect(outcome).toMatchObject({ ok: true, targetOrgPublicToken: TARGET_ORG_TOKEN });

    // Derivation fields, including the intervention-state reset.
    const [row] = await db
      .select({
        derivedToOrganizationId: welfareReports.derivedToOrganizationId,
        derivedByUserId: welfareReports.derivedByUserId,
        derivedAt: welfareReports.derivedAt,
        orgInterventionStatus: welfareReports.orgInterventionStatus,
        orgInterventionAt: welfareReports.orgInterventionAt,
      })
      .from(welfareReports)
      .where(eq(welfareReports.id, reportId))
      .limit(1);

    expect(row.derivedToOrganizationId).toBe(targetOrgId);
    expect(row.derivedByUserId).toBe(ACTOR_ID);
    expect(row.derivedAt).toBeInstanceOf(Date);
    expect(row.orgInterventionStatus).toBeNull();
    expect(row.orgInterventionAt).toBeNull();

    // The audit row, field for field. `insertAudit` passed exactly
    // { actorUserId, action, targetOrganizationId, payload } and let the DB
    // default the rest to NULL; `buildAuditLogValues` sends those NULLs
    // explicitly. The stored row must be indistinguishable.
    const auditRows = await auditRowsForRun();

    expect(auditRows).toHaveLength(auditRowsBefore + 1);
    const audit = auditRows[0];

    expect(audit.action).toBe("welfare_report_derived_to_org");
    expect(audit.actorUserId).toBe(ACTOR_ID);
    expect(audit.targetOrganizationId).toBe(targetOrgId);
    expect(audit.approvalRequestId).toBeNull();
    expect(audit.targetUserId).toBeNull();
    expect(audit.targetGovtAssignmentId).toBeNull();
    // toEqual, not toMatchObject: an EXTRA payload key is drift too. In
    // particular `before_values` / `after_values` must stay absent — the
    // pre-split row never captured them, and "absent" honestly reads as
    // "not captured" (lib/infra/audit-log.ts).
    expect(audit.payload).toEqual({
      welfareReportId: reportId,
      referenceCode: REFERENCE_CODE,
      targetOrgId,
      targetOrgDisplayName: TARGET_ORG_DISPLAY_NAME,
    });
  });

  it("BUILDS the notifications and persists none — the flush stays in the action", async () => {
    const outcome = await deriveWelfareToOrg({
      welfareReportId: reportId,
      targetOrgId,
      actorUserId: ACTOR_ID,
      referenceCode: REFERENCE_CODE,
      // Re-derivation away from a DIFFERENT org: both legs must be built.
      previousOrgId,
    });

    if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.error}`);

    const byType = new Map(outcome.notifications.map((n) => [n.notificationType, n]));

    expect(byType.get("welfare_report_derived_to_org")).toMatchObject({
      userId: TARGET_MEMBER_ID,
      severity: "warning",
      ctaUrl: `/org/${TARGET_ORG_TOKEN}/maltrato/recibidos?tab=recibidos`,
      category: "welfare",
    });
    expect(byType.get("welfare_report_rederived_away")).toMatchObject({
      userId: PREVIOUS_MEMBER_ID,
      severity: "info",
      ctaUrl: `/org/${PREVIOUS_ORG_TOKEN}/maltrato/recibidos?tab=recibidos`,
      category: "welfare",
    });

    const persisted = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(inArray(notifications.userId, PROFILE_IDS));
    expect(persisted).toHaveLength(0);
  });

  it("skips the corrective notice when the report is re-derived to the SAME org", async () => {
    const outcome = await deriveWelfareToOrg({
      welfareReportId: reportId,
      targetOrgId,
      actorUserId: ACTOR_ID,
      referenceCode: REFERENCE_CODE,
      previousOrgId: targetOrgId,
    });

    if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.error}`);
    expect(outcome.notifications.map((n) => n.notificationType)).toEqual([
      "welfare_report_derived_to_org",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Target refusals — no mutation, no audit row
// ---------------------------------------------------------------------------

describe("deriveWelfareToOrg target validation", () => {
  async function auditRowCount(): Promise<number> {
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(sql`${auditLog.payload}->>'referenceCode' = ${REFERENCE_CODE}`);
    return rows.length;
  }

  it("refuses an unknown, an unverified, and an ineligible-type organization", async () => {
    const before = await auditRowCount();

    const base = {
      welfareReportId: reportId,
      actorUserId: ACTOR_ID,
      referenceCode: REFERENCE_CODE,
      previousOrgId: null,
    };

    expect(await deriveWelfareToOrg({ ...base, targetOrgId: UNKNOWN_ORG_ID })).toEqual({
      ok: false,
      error: "Organización no encontrada.",
    });
    expect(await deriveWelfareToOrg({ ...base, targetOrgId: unverifiedOrgId })).toEqual({
      ok: false,
      error: "La organización no está verificada.",
    });
    expect(await deriveWelfareToOrg({ ...base, targetOrgId: clinicOrgId })).toEqual({
      ok: false,
      error:
        "Solo se puede derivar a refugios, redes de rescate o autoridades sanitarias verificadas.",
    });

    // A refused derivation writes nothing: no new audit row, no ownership move.
    expect(await auditRowCount()).toBe(before);
    const [row] = await db
      .select({ derivedToOrganizationId: welfareReports.derivedToOrganizationId })
      .from(welfareReports)
      .where(eq(welfareReports.id, reportId))
      .limit(1);
    expect(row.derivedToOrganizationId).toBe(targetOrgId);
  });
});

// ---------------------------------------------------------------------------
// The transaction — a source pin, because no input can make it fail
// ---------------------------------------------------------------------------
//
// Before the split the derivation UPDATE and its audit row were two
// autocommits; the writer joins them in one db.transaction. That is the one
// behavioural change of the move, and it is not observable through inputs:
// `action` is typed to the catalog and `actorUserId` is the same value the
// UPDATE writes to derived_by_user_id, so any input that breaks the audit
// INSERT breaks the UPDATE first. Nothing in lint:audit-log cares either — it
// only looks for the writeAuditLog token one hop from the action. So a rewrite
// back to `await db.update(...); await writeAuditLog(db, ...)` would pass every
// gate green and reopen the gap lib/infra/audit-log.ts exists to close: a crash
// between the two statements commits a derivation with no trace (Ley 25.326).
// The pin below is the only thing that notices.

describe("deriveWelfareToOrg audit write is transactional (source pin)", () => {
  const writerSrc = readFileSync(join(__dirname, "derive-to-org-writer.ts"), "utf8");

  it("opens a transaction around the derivation write", () => {
    expect(writerSrc).toMatch(/db\.transaction\(/);
  });

  it("writes the audit row with the transaction executor, not the pool", () => {
    expect(writerSrc).toMatch(/writeAuditLog\(\s*tx\b/);
    expect(writerSrc).not.toMatch(/writeAuditLog\(\s*db\b/);
  });
});
