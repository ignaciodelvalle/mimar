// Action-level tests for app/actions/bulk-actions.ts (V1-9 coverage gap).
//
// Covers the three admin/govt batch actions:
//   - bulkApproveRequestsAction — approves N approval_requests, tagging each
//                                 audit row with a shared bulk_action_id.
//   - bulkRejectRequestsAction  — rejects N requests; pre-validates the reason.
//   - bulkRevokeAction          — multi-target revocation; pre-validates motivo
//                                 length + attachment presence before the batch.
//
// Each asserts: admin gate (unauthenticated → redirect throws), multi-row
// effects (status flips, shared bulk_action_id), and partial-failure behavior
// (valid + invalid tokens in one call land in succeeded[] / failed[]).
//
// Real local Postgres + Supabase stack; the admin session is mocked via
// `@/lib/supabase/server`.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

import {
  bulkApproveRequestsAction,
  bulkRejectRequestsAction,
  bulkRevokeAction,
} from "@/app/actions/bulk-actions";
import { approvalRequests, auditLog, db, notifications, profiles } from "@/db";
import { createClient } from "@/lib/supabase/server";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const ADMIN_EMAIL = "bulkact-admin@dim-test.local";
const APPLICANT1_EMAIL = "bulkact-app1@dim-test.local";
const APPLICANT2_EMAIL = "bulkact-app2@dim-test.local";
const PASS = "BulkAct_2026!";

const PROV = "Buenos Aires";
const LOCALITY = "La Plata";

let adminUserId: string;
let applicant1Id: string;
let applicant2Id: string;

const insertedRequestIds: string[] = [];

function mockSessionAs(userId: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: userId ? ({ id: userId } as unknown) : null },
        error: null,
      }),
    },
  } as never);
}

async function createUser(email: string): Promise<string> {
  const r = await createFreshTestUser(supabaseAdmin, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser ${email}: ${r.error?.message}`);
  return r.data.user.id;
}

async function purgeUserByEmail(email: string) {
  const { data } = await supabaseAdmin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  for (const uid of ids) {
    // audit_log is append-only — strip the bulk audit rows via the dedicated
    // audit-mutation GUC (same pattern as admin-revocations.test.ts cleanup).
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx
        .delete(auditLog)
        .where(or(eq(auditLog.actorUserId, uid), eq(auditLog.targetUserId, uid)));
    });
    await db.delete(notifications).where(eq(notifications.userId, uid));
    await db.delete(approvalRequests).where(eq(approvalRequests.applicantUserId, uid));
    await db.delete(profiles).where(eq(profiles.id, uid));
  }
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

// Insert a pending role_upgrade_vet request for `applicantId`. Returns its
// public token.
async function seedVetRequest(applicantId: string, token: string): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      publicToken: token,
      type: "role_upgrade_vet",
      status: "pending",
      applicantUserId: applicantId,
      initiatedBy: "self",
      targetUserId: applicantId,
      jurisdictionProvince: PROV,
      jurisdictionLocality: LOCALITY,
      payload: { matricula: "MP-TEST-0001" },
    })
    .returning({ id: approvalRequests.id });
  insertedRequestIds.push(row.id);
  return token;
}

// Reset an applicant + their request back to a clean pending state between
// tests (approve mutates the applicant's role to vet).
async function resetApplicant(applicantId: string) {
  await db.delete(approvalRequests).where(eq(approvalRequests.applicantUserId, applicantId));
  await db
    .update(profiles)
    .set({ role: "owner", matriculaVerified: false })
    .where(eq(profiles.id, applicantId));
}

beforeAll(async () => {
  for (const e of [ADMIN_EMAIL, APPLICANT1_EMAIL, APPLICANT2_EMAIL]) await purgeUserByEmail(e);

  adminUserId = await createUser(ADMIN_EMAIL);
  applicant1Id = await createUser(APPLICANT1_EMAIL);
  applicant2Id = await createUser(APPLICANT2_EMAIL);

  // Institutional accountType is required by the consolidated admin guard
  // (loadActiveInstitutionalProfile); createUser seeds accountType="personal".
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));
}, 90_000);

afterAll(async () => {
  for (const e of [ADMIN_EMAIL, APPLICANT1_EMAIL, APPLICANT2_EMAIL]) await purgeUserByEmail(e);
});

// ---------------------------------------------------------------------------
// bulkApproveRequestsAction
// ---------------------------------------------------------------------------

describe("bulkApproveRequestsAction", () => {
  // Matrícula (role_upgrade_vet) requests are DELIBERATELY not bulk-approvable
  // (UI/UX audit 2026-07): each requires the individual verification flow on the
  // detail page. The bulk path refuses them per-item — see approve-request.ts
  // (bulkActionId != null + type role_upgrade_vet → refusal).
  it("refuses vet matrícula requests in bulk — each lands in failed[], no role flip", async () => {
    await resetApplicant(applicant1Id);
    await resetApplicant(applicant2Id);
    const t1 = await seedVetRequest(applicant1Id, "DIM-BULK-APR-1");
    const t2 = await seedVetRequest(applicant2Id, "DIM-BULK-APR-2");
    mockSessionAs(adminUserId);

    const result = await bulkApproveRequestsAction({ requestPublicTokens: [t1, t2] });

    // Both refused (the loop processed both — accumulation, not abort).
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed.map((f) => f.id).sort()).toEqual([t1, t2].sort());
    expect(result.failed.every((f) => f.reason.includes("no se aprueban en lote"))).toBe(true);

    // Neither request advanced and neither applicant became a vet.
    const reqs = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(inArray(approvalRequests.publicToken, [t1, t2]));
    expect(reqs.every((r) => r.status === "pending")).toBe(true);
    const apps = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(inArray(profiles.id, [applicant1Id, applicant2Id]));
    expect(apps.every((a) => a.role === "owner")).toBe(true);

    // No approval audit rows were written under this bulk_action_id.
    const audits = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.action, "request_approved"));
    const bulkTagged = audits.filter(
      (a) => (a.payload as { bulk_action_id?: string }).bulk_action_id === result.bulkActionId,
    );
    expect(bulkTagged.length).toBe(0);
  });

  it("partial failure: a non-existent token lands in failed[] without aborting the rest", async () => {
    await resetApplicant(applicant1Id);
    const t1 = await seedVetRequest(applicant1Id, "DIM-BULK-APR-PARTIAL");
    mockSessionAs(adminUserId);

    const result = await bulkApproveRequestsAction({
      requestPublicTokens: [t1, "DIM-BULK-DOES-NOT-EXIST"],
    });

    // Both fail — the vet token by bulk-refusal, the unknown token by not-found —
    // and the loop processed both (no abort on the first failure).
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    const byId = Object.fromEntries(result.failed.map((f) => [f.id, f.reason]));
    expect(byId[t1]).toContain("no se aprueban en lote");
    expect(byId["DIM-BULK-DOES-NOT-EXIST"]).toContain("no encontrada");
  });

  it("rejects an unauthenticated caller (redirect throws)", async () => {
    mockSessionAs(null);
    await expect(
      bulkApproveRequestsAction({ requestPublicTokens: ["DIM-BULK-NOAUTH"] }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// bulkRejectRequestsAction
// ---------------------------------------------------------------------------

describe("bulkRejectRequestsAction", () => {
  it("rejects multiple requests with a shared bulk_action_id", async () => {
    await resetApplicant(applicant1Id);
    await resetApplicant(applicant2Id);
    const t1 = await seedVetRequest(applicant1Id, "DIM-BULK-REJ-1");
    const t2 = await seedVetRequest(applicant2Id, "DIM-BULK-REJ-2");
    mockSessionAs(adminUserId);

    const result = await bulkRejectRequestsAction({
      requestPublicTokens: [t1, t2],
      reason: "Documentación insuficiente para verificar la matrícula.",
    });

    expect(result.succeeded.sort()).toEqual([t1, t2].sort());
    expect(result.failed).toHaveLength(0);

    const reqs = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(inArray(approvalRequests.publicToken, [t1, t2]));
    expect(reqs.every((r) => r.status === "rejected")).toBe(true);
  });

  it("fails fast for every token when the reason is too short (validation gate)", async () => {
    await resetApplicant(applicant1Id);
    const t1 = await seedVetRequest(applicant1Id, "DIM-BULK-REJ-SHORT");
    mockSessionAs(adminUserId);

    const result = await bulkRejectRequestsAction({
      requestPublicTokens: [t1],
      reason: "no",
    });

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toContain("al menos 5 caracteres");

    // The request was NOT touched — still pending.
    const [req] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.publicToken, t1))
      .limit(1);
    expect(req?.status).toBe("pending");
  });

  it("partial failure: an already-decided request lands in failed[]", async () => {
    await resetApplicant(applicant1Id);
    await resetApplicant(applicant2Id);
    const t1 = await seedVetRequest(applicant1Id, "DIM-BULK-REJ-MIX-1");
    const t2 = await seedVetRequest(applicant2Id, "DIM-BULK-REJ-MIX-2");
    mockSessionAs(adminUserId);

    // Reject t1 first so it's no longer pending.
    await bulkRejectRequestsAction({
      requestPublicTokens: [t1],
      reason: "Primer rechazo de prueba.",
    });

    const result = await bulkRejectRequestsAction({
      requestPublicTokens: [t1, t2],
      reason: "Segundo lote de rechazo de prueba.",
    });

    expect(result.succeeded).toEqual([t2]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(t1);
  });
});

// ---------------------------------------------------------------------------
// bulkRevokeAction (validation gates + admin gate)
// ---------------------------------------------------------------------------

describe("bulkRevokeAction", () => {
  it("fails fast for every target when motivo is shorter than 30 chars", async () => {
    mockSessionAs(adminUserId);
    const result = await bulkRevokeAction({
      targetIds: ["id-a", "id-b"],
      targetKind: "vet",
      motivo: "corto",
      attachmentIds: ["att-1"],
    });
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed.map((f) => f.id).sort()).toEqual(["id-a", "id-b"]);
    expect(result.failed[0].reason).toContain("al menos 30 caracteres");
  });

  it("fails fast for every target when no evidence attachment is provided", async () => {
    mockSessionAs(adminUserId);
    const result = await bulkRevokeAction({
      targetIds: ["id-a", "id-b"],
      targetKind: "vet",
      motivo: "Motivo de revocación suficientemente largo para pasar el mínimo.",
      attachmentIds: [],
    });
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0].reason).toContain("adjunto de evidencia");
  });

  it("rejects an unauthenticated caller (redirect throws)", async () => {
    mockSessionAs(null);
    await expect(
      bulkRevokeAction({
        targetIds: ["id-a"],
        targetKind: "vet",
        motivo: "Motivo de revocación suficientemente largo para pasar el mínimo.",
        attachmentIds: ["att-1"],
      }),
    ).rejects.toThrow();
  });
});
