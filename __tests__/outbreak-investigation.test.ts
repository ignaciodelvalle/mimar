// Integration tests for the outbreak investigation management surface.
//
// Auth-guard is mocked. Users provisioned via Supabase admin SDK.

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrGovtOrRedirect: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

import { auditLog, caseEvents, cases, db, govtAssignments, profiles } from "@/db";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { getOutbreakInvestigationDetail } from "@/lib/infra/case-queries";
import {
  addInvestigationNoteAction,
  closeInvestigationAction,
  escalateInvestigationAction,
  openOutbreakInvestigationAction,
} from "@/src/modules/surveillance/actions";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

function govtSession(userId: string, province = "Buenos Aires", locality = "La Plata") {
  return {
    user: { id: userId },
    supabase: {} as never,
    profile: { id: userId, role: "govt" as const },
    jurisdictions: [{ province, locality }],
  };
}

function adminSession(userId: string) {
  return {
    user: { id: userId },
    supabase: {} as never,
    profile: { id: userId, role: "admin" as const },
    jurisdictions: [],
  };
}

function outOfScopeGovtSession(userId: string) {
  return {
    user: { id: userId },
    supabase: {} as never,
    profile: { id: userId, role: "govt" as const },
    jurisdictions: [{ province: "Mendoza", locality: "Mendoza" }],
  };
}

/** Govt user with matching province but non-matching locality. */
function wrongLocalityGovtSession(userId: string) {
  return {
    user: { id: userId },
    supabase: {} as never,
    profile: { id: userId, role: "govt" as const },
    // Same province as test case (Buenos Aires) but different locality.
    jurisdictions: [{ province: "Buenos Aires", locality: "Mar del Plata" }],
  };
}

const GOVT_EMAIL = "outbreak-test-govt@dim-test.local";
const ADMIN_EMAIL = "outbreak-test-admin@dim-test.local";

let govtUserId: string;
let adminUserId: string;

async function ensureUser(email: string, role: "govt" | "admin"): Promise<string> {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 500 });
  const existing = list?.users.find((u) => u.email === email);
  if (existing) {
    const [profile] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, existing.id));
    if (profile) return existing.id;
    await adminSdk.auth.admin.deleteUser(existing.id);
  }
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: "OutbreakTest_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser: ${r.error?.message}`);
  const id = r.data.user.id;
  await db.update(profiles).set({ role, accountType: "institutional" }).where(eq(profiles.id, id));
  return id;
}

async function cleanupTestCasesForUsers(userIds: string[]) {
  if (userIds.length === 0) return;
  const caseRows = await db
    .select({ id: cases.id })
    .from(cases)
    .where(inArray(cases.openedByUserId, userIds));
  const caseIds = caseRows.map((r) => r.id);
  if (caseIds.length > 0) {
    // case_events is append-only (migration 0121); both the explicit delete
    // and the cases ON DELETE CASCADE fire the trigger, so clean up under the
    // accountable mutation override.
    await withMutationOverride(async (tx) => {
      await tx.delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
      await tx.delete(cases).where(inArray(cases.id, caseIds));
    });
  }
}

/**
 * Remove ALL open/escalated outbreak_investigation cases for a given disease
 * + province + locality combo, regardless of who opened them.
 *
 * Used to make the duplicate-detection test self-isolating: any stale case
 * left by a prior run (or by a different user in the same run) is cleared
 * before the test creates its own fixture.
 */
async function cleanupOpenOutbreakCasesForJurisdiction(
  diseaseCode: string,
  province: string,
  locality: string,
) {
  const openRows = await db
    .select({ id: cases.id })
    .from(cases)
    .where(
      and(
        eq(cases.caseKind, "outbreak_investigation"),
        sql`${cases.status} IN ('open', 'escalated')`,
        sql`${cases.openedReason} LIKE ${`manual [${diseaseCode}]:%`}`,
        eq(cases.jurisdictionProvince, province),
        eq(cases.jurisdictionLocality, locality),
      ),
    );
  const ids = openRows.map((r) => r.id);
  if (ids.length > 0) {
    // caseEvents has ON DELETE CASCADE from cases, but explicit delete is
    // more explicit and avoids relying on the migration having CASCADE set.
    // case_events is append-only (0121) — both fire the trigger, so run the
    // cleanup under the accountable mutation override.
    await withMutationOverride(async (tx) => {
      await tx.delete(caseEvents).where(inArray(caseEvents.caseId, ids));
      await tx.delete(cases).where(inArray(cases.id, ids));
    });
  }
}

beforeAll(async () => {
  govtUserId = await ensureUser(GOVT_EMAIL, "govt");
  adminUserId = await ensureUser(ADMIN_EMAIL, "admin");

  // Ensure govt user has EXACTLY ONE jurisdiction assignment. The old
  // insert-and-swallow ran on EVERY suite run with no unique constraint to
  // trip its catch — 44 duplicate rows had accumulated (found during the
  // 2026-07-14 test-isolation sweep). Idempotent form: clear, then insert.
  await db.delete(govtAssignments).where(eq(govtAssignments.userId, govtUserId));
  await db.insert(govtAssignments).values({
    userId: govtUserId,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
  });

  await cleanupTestCasesForUsers([govtUserId, adminUserId]);
});

afterAll(async () => {
  await cleanupTestCasesForUsers([govtUserId, adminUserId]);
});

// ---------------------------------------------------------------------------
// openOutbreakInvestigationAction
// ---------------------------------------------------------------------------

describe("openOutbreakInvestigationAction", () => {
  it("creates a general-subject pet-less case in the govt jurisdiction", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );

    const result = await openOutbreakInvestigationAction({
      diseaseCode: "leptospirosis",
      reason: "Tres casos confirmados en la misma semana.",
    });

    expect(result).toMatchObject({ ok: true });
    if (!("ok" in result)) return;

    const [caseRow] = await db
      .select()
      .from(cases)
      .where(eq(cases.publicCode, result.publicCode))
      .limit(1);

    expect(caseRow.caseKind).toBe("outbreak_investigation");
    expect(caseRow.primarySubjectKind).toBe("general");
    expect(caseRow.primaryPetId).toBeNull();
    expect(caseRow.jurisdictionProvince).toBe("Buenos Aires");
    // Locality must also be set when opened by a govt user.
    expect(caseRow.jurisdictionLocality).toBe("La Plata");
    expect(caseRow.status).toBe("open");
    expect(caseRow.openedReason).toContain("manual [leptospirosis]:");
    expect(caseRow.openedByUserId).toBe(govtUserId);

    const events = await db.select().from(caseEvents).where(eq(caseEvents.caseId, caseRow.id));
    expect(events.some((n) => n.entryType === "case_opened")).toBe(true);

    // Order by most recent: audit rows for this user/action accumulate across
    // suite runs (audit_log is append-only and not cleaned by teardown), so an
    // unordered pick is nondeterministic.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, govtUserId),
          eq(auditLog.action, "outbreak_investigation_opened"),
        ),
      )
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    expect(auditRows.length).toBeGreaterThan(0);
    const payload = auditRows[0].payload as Record<string, unknown>;
    expect(payload.v1_noop).toBe(true);
    expect(payload.disease_code).toBe("leptospirosis");
  });

  it("rejects invalid disease code", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );
    const result = await openOutbreakInvestigationAction({
      diseaseCode: "not-a-real-disease",
      reason: "Motivo suficientemente largo para test.",
    });
    expect(result).toMatchObject({ error: expect.stringContaining("ENO") });
  });

  it("rejects reason shorter than 10 chars", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );
    const result = await openOutbreakInvestigationAction({
      diseaseCode: "rabies",
      reason: "Corto",
    });
    expect(result).toMatchObject({ error: expect.stringContaining("10 caracteres") });
  });

  // Nested describe gives this test its own beforeEach/afterEach lifecycle so
  // stale open cases from a prior run (or from another file that left a
  // hidatidosis/Córdoba row open) cannot interfere with the dedup assertion.
  describe("blocks duplicate open investigation for same (disease, jurisdiction)", () => {
    const DEDUP_DISEASE = "hidatidosis";
    const DEDUP_PROVINCE = "Córdoba";
    const DEDUP_LOCALITY = "Córdoba";

    beforeEach(async () => {
      await cleanupOpenOutbreakCasesForJurisdiction(DEDUP_DISEASE, DEDUP_PROVINCE, DEDUP_LOCALITY);
    });

    afterEach(async () => {
      await cleanupOpenOutbreakCasesForJurisdiction(DEDUP_DISEASE, DEDUP_PROVINCE, DEDUP_LOCALITY);
    });

    it("first call succeeds, second call is rejected", async () => {
      (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
        govtSession(govtUserId, DEDUP_PROVINCE, DEDUP_LOCALITY),
      );

      const first = await openOutbreakInvestigationAction({
        diseaseCode: DEDUP_DISEASE,
        reason: "Primera investigacion de hidatidosis en Córdoba.",
      });
      expect(first).toMatchObject({ ok: true });

      const second = await openOutbreakInvestigationAction({
        diseaseCode: DEDUP_DISEASE,
        reason: "Segunda investigacion de hidatidosis en Córdoba.",
      });
      expect(second).toMatchObject({ error: expect.stringContaining(DEDUP_DISEASE) });
      expect("error" in second).toBe(true);
    });
  });

  it("admin bypasses jurisdiction requirement (national scope)", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      adminSession(adminUserId),
    );
    const result = await openOutbreakInvestigationAction({
      diseaseCode: "brucelosis_canina",
      reason: "Investigacion administrativa de alcance nacional.",
    });
    expect(result).toMatchObject({ ok: true });
    if (!("ok" in result)) return;

    const [caseRow] = await db
      .select()
      .from(cases)
      .where(eq(cases.publicCode, result.publicCode))
      .limit(1);
    expect(caseRow.jurisdictionProvince).toBeNull();
    expect(caseRow.openedByUserId).toBe(adminUserId);
  });
});

// ---------------------------------------------------------------------------
// addInvestigationNoteAction
// ---------------------------------------------------------------------------

describe("addInvestigationNoteAction", () => {
  let testCasePublicCode: string;

  beforeAll(async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );
    const result = await openOutbreakInvestigationAction({
      diseaseCode: "leishmaniasis",
      reason: "Caso de leishmaniasis para test de notas del dataset.",
    });
    if (!("ok" in result)) throw new Error(`Setup failed: ${JSON.stringify(result)}`);
    testCasePublicCode = result.publicCode;
  });

  it("records a classification entry", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );
    const result = await addInvestigationNoteAction({
      casePublicCode: testCasePublicCode,
      entryType: "classification",
      notes: "Caso sospechoso identificado en barrio norte.",
    });
    expect(result).toMatchObject({ ok: true });

    const [caseRow] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(eq(cases.publicCode, testCasePublicCode))
      .limit(1);
    const events = await db
      .select()
      .from(caseEvents)
      .where(and(eq(caseEvents.caseId, caseRow.id), eq(caseEvents.entryType, "classification")));
    expect(events.length).toBeGreaterThan(0);
  });

  it("records a lab_result entry", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );
    const result = await addInvestigationNoteAction({
      casePublicCode: testCasePublicCode,
      entryType: "lab_result",
      notes: "PCR positivo confirmado por ANLIS.",
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("records a control_action entry", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );
    const result = await addInvestigationNoteAction({
      casePublicCode: testCasePublicCode,
      entryType: "control_action",
      notes: "Fumigacion del area de 500 metros realizada.",
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects out-of-scope govt user (wrong province)", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      outOfScopeGovtSession(govtUserId),
    );
    const result = await addInvestigationNoteAction({
      casePublicCode: testCasePublicCode,
      entryType: "system",
      notes: "Nota de usuario fuera de scope.",
    });
    expect(result).toMatchObject({ error: expect.stringContaining("jurisdicción") });
  });

  it("rejects out-of-scope govt user (same province, wrong locality)", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      wrongLocalityGovtSession(govtUserId),
    );
    const result = await addInvestigationNoteAction({
      casePublicCode: testCasePublicCode,
      entryType: "system",
      notes: "Nota de usuario con provincia correcta pero localidad incorrecta.",
    });
    expect(result).toMatchObject({ error: expect.stringContaining("jurisdicción") });
  });

  it("admin bypasses jurisdiction check", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      adminSession(adminUserId),
    );
    const result = await addInvestigationNoteAction({
      casePublicCode: testCasePublicCode,
      entryType: "system",
      notes: "Nota registrada por admin con scope universal.",
    });
    expect(result).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// closeInvestigationAction
// ---------------------------------------------------------------------------

describe("closeInvestigationAction", () => {
  let resolvedCaseCode: string;
  let dismissedCaseCode: string;

  beforeAll(async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );

    const r1 = await openOutbreakInvestigationAction({
      diseaseCode: "rabies",
      reason: "Investigacion de rabia para test de cierre resuelto.",
    });
    if (!("ok" in r1)) throw new Error(`Setup r1: ${JSON.stringify(r1)}`);
    resolvedCaseCode = r1.publicCode;

    const r2 = await openOutbreakInvestigationAction({
      diseaseCode: "brucelosis_canina",
      reason: "Investigacion de brucelosis para test de cierre desestimado.",
    });
    if (!("ok" in r2)) throw new Error(`Setup r2: ${JSON.stringify(r2)}`);
    dismissedCaseCode = r2.publicCode;
  });

  it("BLOCKS close-resolved without final report", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );
    const result = await closeInvestigationAction({
      casePublicCode: resolvedCaseCode,
      outcome: "resolved",
      reason: "Investigacion cerrada con exito.",
    });
    expect(result).toMatchObject({ error: expect.stringContaining("informe epidemiológico") });
  });

  it("SUCCEEDS close-resolved with inline final report text", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );
    const result = await closeInvestigationAction({
      casePublicCode: resolvedCaseCode,
      outcome: "resolved",
      finalReportText: "Brote controlado. Sin nuevos casos en 4 semanas. Vacunacion al 95%.",
      reason: "Brote controlado sin nuevos casos confirmados.",
    });
    expect(result).toMatchObject({ ok: true });

    const [caseRow] = await db
      .select()
      .from(cases)
      .where(eq(cases.publicCode, resolvedCaseCode))
      .limit(1);
    expect(caseRow.status).toBe("closed");
    expect(caseRow.closedReason).toBe("resolved");

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, govtUserId),
          eq(auditLog.action, "outbreak_investigation_closed_resolved"),
        ),
      )
      .limit(1);
    expect(auditRows.length).toBeGreaterThan(0);
    const payload = auditRows[0].payload as Record<string, unknown>;
    expect(payload.v1_noop).toBe(true);
    expect(payload.outcome).toBe("resolved");
  });

  it("SUCCEEDS close-resolved with pre-existing final report note", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );
    const r = await openOutbreakInvestigationAction({
      diseaseCode: "hidatidosis",
      reason: "Hidatidosis para test con informe previo registrado antes del cierre.",
    });
    expect(r).toMatchObject({ ok: true });
    if (!("ok" in r)) return;

    const noteResult = await addInvestigationNoteAction({
      casePublicCode: r.publicCode,
      entryType: "final_report",
      notes: "Informe final previo registrado como nota antes del cierre.",
    });
    expect(noteResult).toMatchObject({ ok: true });

    const closeResult = await closeInvestigationAction({
      casePublicCode: r.publicCode,
      outcome: "resolved",
      reason: "Cierre con informe previo registrado como nota.",
    });
    expect(closeResult).toMatchObject({ ok: true });
  });

  it("SUCCEEDS close-dismissed without final report", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );
    const result = await closeInvestigationAction({
      casePublicCode: dismissedCaseCode,
      outcome: "dismissed",
      reason: "Falsa alarma, no hay brote confirmado en el area.",
    });
    expect(result).toMatchObject({ ok: true });

    const [caseRow] = await db
      .select()
      .from(cases)
      .where(eq(cases.publicCode, dismissedCaseCode))
      .limit(1);
    expect(caseRow.status).toBe("closed");
    expect(caseRow.closedReason).toBe("cancelled");

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, govtUserId),
          eq(auditLog.action, "outbreak_investigation_closed_dismissed"),
        ),
      )
      .limit(1);
    expect(auditRows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// escalateInvestigationAction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getOutbreakInvestigationDetail — jurisdiction scoping (review 24 HIGH #1/#2)
// ---------------------------------------------------------------------------
//
// The detail query loads the full case_events timeline (epidemiological notes,
// which can carry PII). It must be scoped IN SQL to the reader's (province,
// locality) assignments so an out-of-jurisdiction govt reader gets null.

describe("getOutbreakInvestigationDetail — jurisdiction scoping", () => {
  let scopedCaseCode: string;
  // Unique disease + jurisdiction so the per-(disease, jurisdiction) dedup guard
  // can't collide with cases other describes in this file open.
  // Valid ENO code + a jurisdiction (Chubut/Rawson) no other describe uses, so
  // the per-(disease, jurisdiction) dedup guard can't collide.
  const SCOPE_DISEASE = "leptospirosis";
  const CASE_PROVINCE = "Chubut";
  const CASE_LOCALITY = "Rawson";

  beforeAll(async () => {
    await cleanupOpenOutbreakCasesForJurisdiction(SCOPE_DISEASE, CASE_PROVINCE, CASE_LOCALITY);
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId, CASE_PROVINCE, CASE_LOCALITY),
    );
    const result = await openOutbreakInvestigationAction({
      diseaseCode: SCOPE_DISEASE,
      reason: "Caso para test de scoping de detalle de investigacion.",
    });
    if (!("ok" in result)) throw new Error(`Setup failed: ${JSON.stringify(result)}`);
    scopedCaseCode = result.publicCode;
  });

  afterAll(async () => {
    await cleanupOpenOutbreakCasesForJurisdiction(SCOPE_DISEASE, CASE_PROVINCE, CASE_LOCALITY);
  });

  it("in-scope govt (matching province + locality) resolves the case", async () => {
    const detail = await getOutbreakInvestigationDetail(
      scopedCaseCode,
      [{ province: CASE_PROVINCE, locality: CASE_LOCALITY }],
      false,
    );
    expect(detail).not.toBeNull();
    expect(detail?.publicCode).toBe(scopedCaseCode);
  });

  it("wrong-locality govt (same province) gets null — no notes leaked", async () => {
    const detail = await getOutbreakInvestigationDetail(
      scopedCaseCode,
      [{ province: CASE_PROVINCE, locality: "Mar del Plata" }],
      false,
    );
    expect(detail).toBeNull();
  });

  it("out-of-province govt gets null", async () => {
    const detail = await getOutbreakInvestigationDetail(
      scopedCaseCode,
      [{ province: "Mendoza", locality: "Mendoza" }],
      false,
    );
    expect(detail).toBeNull();
  });

  it("govt with no assignments gets null (no nationwide leak)", async () => {
    const detail = await getOutbreakInvestigationDetail(scopedCaseCode, [], false);
    expect(detail).toBeNull();
  });

  it("admin (isAdmin=true, empty jurisdictions) resolves the case (universal scope)", async () => {
    const detail = await getOutbreakInvestigationDetail(scopedCaseCode, [], true);
    expect(detail).not.toBeNull();
    expect(detail?.publicCode).toBe(scopedCaseCode);
  });
});

describe("escalateInvestigationAction", () => {
  it("escalates an open investigation and writes case_event + audit row atomically", async () => {
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId),
    );

    const openResult = await openOutbreakInvestigationAction({
      diseaseCode: "rabies",
      reason: "Nuevo brote de rabia para test especifico de escalada urgente.",
    });
    expect(openResult).toMatchObject({ ok: true });
    if (!("ok" in openResult)) return;

    const escalateResult = await escalateInvestigationAction({
      casePublicCode: openResult.publicCode,
      reason: "Nuevos casos confirmados, situacion critica en expansion rapida.",
    });
    expect(escalateResult).toMatchObject({ ok: true });

    const [caseRow] = await db
      .select()
      .from(cases)
      .where(eq(cases.publicCode, openResult.publicCode))
      .limit(1);
    expect(caseRow.status).toBe("escalated");

    // case_event must exist for the escalation.
    const escalateEvents = await db
      .select()
      .from(caseEvents)
      .where(and(eq(caseEvents.caseId, caseRow.id), eq(caseEvents.entryType, "case_escalated")));
    expect(escalateEvents.length).toBeGreaterThan(0);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, govtUserId),
          eq(auditLog.action, "outbreak_investigation_escalated"),
        ),
      )
      .limit(1);
    expect(auditRows.length).toBeGreaterThan(0);
  });

  it("rejects escalation of out-of-scope case (wrong province)", async () => {
    // Use a distinct province/locality so there's no collision with cases opened
    // in earlier describes (leptospirosis/La Plata is already open from suite 1).
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId, "Santa Fe", "Rosario"),
    );
    const openResult = await openOutbreakInvestigationAction({
      diseaseCode: "leptospirosis",
      reason: "Investigacion de leptospirosis en Rosario para test de scope incorrecto.",
    });
    expect(openResult).toMatchObject({ ok: true });
    if (!("ok" in openResult)) return;

    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      outOfScopeGovtSession(govtUserId),
    );
    const escalateResult = await escalateInvestigationAction({
      casePublicCode: openResult.publicCode,
      reason: "Intento de escalada desde jurisdiccion erronea, deberia ser rechazado.",
    });
    expect(escalateResult).toMatchObject({ error: expect.stringContaining("jurisdicción") });
  });

  it("rejects escalation from same province but wrong locality", async () => {
    // Use a distinct locality (Mar del Plata) to avoid collision with La Plata cases.
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId, "Buenos Aires", "Mar del Plata"),
    );
    const openResult = await openOutbreakInvestigationAction({
      diseaseCode: "leishmaniasis",
      reason: "Investigacion de leishmaniasis en Mar del Plata para test de localidad.",
    });
    expect(openResult).toMatchObject({ ok: true });
    if (!("ok" in openResult)) return;

    // Wrong-locality user has Buenos Aires + different locality → rejected.
    (requireAdminOrGovtOrRedirect as ReturnType<typeof vi.fn>).mockResolvedValue(
      govtSession(govtUserId, "Buenos Aires", "La Plata"),
    );
    const escalateResult = await escalateInvestigationAction({
      casePublicCode: openResult.publicCode,
      reason: "Intento de escalada desde localidad incorrecta dentro de la misma provincia.",
    });
    expect(escalateResult).toMatchObject({ error: expect.stringContaining("jurisdicción") });
  });
});
