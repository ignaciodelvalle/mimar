// W6 · PO decision 15 · finding F-9 — a freshly approved vet has somewhere to
// attend, and the legacy `can_write_pet_events` column tells the truth.
//
// WHY THIS HITS REAL POSTGRES. The defect was a ROW that did not exist: after
// approval there was no membership through which `event.write` could resolve,
// so the atender context refused the vet (correctly) in the TN-10 rehearsal.
// Only the real resolver over real rows can say whether that is fixed. The one
// thing mocked is the session (`requireLiveUser`): there is no browser here,
// and the resolver's own liveness/shift logic is covered by
// authz-resolver-liveness.test.ts.

import { createClient } from "@supabase/supabase-js";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () => ({
      ok: true,
      supabase: {},
      user: { id: live.userId, emailConfirmed: true },
      profile: null,
      sessionStartedAt: new Date(),
    }),
  };
});

import { composeMatriculaApprovalNotes } from "@/app/gob/cola/_lib/matricula-verification";
import { resolveAtenderContext } from "@/app/org/[orgToken]/atender/atender-access";
import {
  approvalRequests,
  attachments,
  auditLog,
  db,
  notifications,
  organizationCapabilityGrants,
  organizationMemberships,
  organizations,
  profiles,
} from "@/db";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { approveRequestForAuthority } from "@/src/modules/organizations/application/admin-decisions/approve-request";
import { provisionVetPractice } from "@/src/modules/organizations/application/admin-decisions/provision-vet-practice";
import { revokeVetRoleForAuthority } from "@/src/modules/organizations/application/revocations/revoke-vet-role";
import { syncEventWriteMirror } from "@/src/modules/organizations/application/set-member-event-write";
import { requestVetUpgradeForUser } from "@/src/modules/organizations/application/upgrade/request-vet-upgrade";
import { resolveGrantedCaps } from "@/src/modules/organizations/domain/capabilities";
import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";

import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const EMAILS = {
  approver: "w6-approver@dim-test.local",
  fresh: "w6-fresh-vet@dim-test.local",
  member: "w6-clinic-vet@dim-test.local",
  foster: "w6-foster-vet@dim-test.local",
} as const;
const PASS = "W6Practice_2026!";

const ids = {} as Record<keyof typeof EMAILS, string>;
const extraOrgIds: string[] = [];

async function orgIdsTouching(uid: string): Promise<string[]> {
  const created = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.createdByUserId, uid));
  return created.map((o) => o.id);
}

async function wipeOrgs(orgIds: string[]) {
  if (orgIds.length === 0) return;
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.delete(auditLog).where(inArray(auditLog.targetOrganizationId, orgIds));
  });
  await db.delete(approvalRequests).where(inArray(approvalRequests.targetOrganizationId, orgIds));
  await db
    .delete(organizationCapabilityGrants)
    .where(inArray(organizationCapabilityGrants.organizationId, orgIds));
  await db
    .delete(organizationMemberships)
    .where(inArray(organizationMemberships.organizationId, orgIds));
  await db.delete(organizations).where(inArray(organizations.id, orgIds));
}

async function deleteTestUser(email: string) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  const uid = found.id;
  await wipeOrgs(await orgIdsTouching(uid));
  await db.delete(attachments).where(eq(attachments.uploadedByUserId, uid));
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx
      .delete(auditLog)
      .where(or(eq(auditLog.actorUserId, uid), eq(auditLog.targetUserId, uid)));
  });
  await db.delete(notifications).where(eq(notifications.userId, uid));
  await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
  await db.delete(approvalRequests).where(eq(approvalRequests.applicantUserId, uid));
  await db.delete(profiles).where(eq(profiles.id, uid));
  await admin.auth.admin.deleteUser(uid);
}

async function createUser(email: string): Promise<string> {
  const r = await createFreshTestUser(admin, { email, password: PASS, email_confirm: true });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

async function makeOrg(orgType: "clinic" | "shelter", createdBy: string): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: generatePublicToken(),
      displayName: `W6 ${orgType}`,
      legalName: `W6 ${orgType}`,
      orgType,
      email: "w6-org@dim-test.local",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Coghlan",
      createdByUserId: createdBy,
    })
    .returning({ id: organizations.id });
  extraOrgIds.push(org.id);
  return org.id;
}

/** Submit a vet petition for `uid` and approve it as the approver. */
async function approveVet(uid: string, matricula: string) {
  const submit = await requestVetUpgradeForUser(uid, {
    matriculaNumber: matricula,
    matriculaJurisdiccion: "CABA",
    operationalProvince: "CABA",
    operationalLocality: "Coghlan",
  });
  expect(submit.ok).toBe(true);
  const [req] = await db
    .select({ publicToken: approvalRequests.publicToken, id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.applicantUserId, uid),
        eq(approvalRequests.type, "role_upgrade_vet"),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .limit(1);
  const result = await approveRequestForAuthority(
    ids.approver,
    req.publicToken,
    composeMatriculaApprovalNotes("OK"),
  );
  expect(result).toEqual({ ok: true });
  return req.id;
}

async function activeMemberships(uid: string) {
  return db
    .select({
      id: organizationMemberships.id,
      role: organizationMemberships.role,
      organizationId: organizationMemberships.organizationId,
      canWritePetEvents: organizationMemberships.canWritePetEvents,
    })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.userId, uid));
}

beforeAll(async () => {
  for (const email of Object.values(EMAILS)) await deleteTestUser(email);
  for (const key of Object.keys(EMAILS) as (keyof typeof EMAILS)[]) {
    ids[key] = await createUser(EMAILS[key]);
  }
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, ids.approver));
  await db
    .update(profiles)
    .set({ dniVerified: true })
    .where(inArray(profiles.id, [ids.fresh, ids.member, ids.foster]));
});

afterAll(async () => {
  await wipeOrgs(extraOrgIds);
  for (const email of Object.values(EMAILS)) await deleteTestUser(email);
});

describe("approving a vet with nowhere to write (F-9)", () => {
  let practiceId: string;
  let practiceToken: string;
  let requestId: string;

  beforeAll(async () => {
    requestId = await approveVet(ids.fresh, "MN-W6-0001");
    const rows = await activeMemberships(ids.fresh);
    expect(rows).toHaveLength(1);
    practiceId = rows[0].organizationId;
    const [org] = await db
      .select({ publicToken: organizations.publicToken })
      .from(organizations)
      .where(eq(organizations.id, practiceId));
    practiceToken = org.publicToken;
  });

  it("provisions an individual practice the vet administers (the solo-vet clinic shape)", async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, practiceId));
    expect(org.orgType).toBe("clinic");
    expect(org.verified).toBe(true);
    expect(org.autoVerifiedViaMatricula).toBe(true);
    expect(org.createdByUserId).toBe(ids.fresh);
    // The login address is not published as the practice contact.
    expect(org.email).toBe("");
    const [m] = await activeMemberships(ids.fresh);
    expect(m.role).toBe("admin");
    expect(m.canWritePetEvents).toBe(true);
  });

  it("can open the atender context and sign as a verified professional — the TN-10 step", async () => {
    live.userId = ids.fresh;
    const atender = await resolveAtenderContext(practiceToken);
    expect(atender.ok).toBe(true);
    if (!atender.ok) return;
    expect(atender.organizationId).toBe(practiceId);
    expect(atender.eventAuthorship).toMatchObject({ authorRole: "vet", authorVerified: true });

    const cap = await requireCapabilityForOrgToken("event.write", practiceToken);
    expect(cap.error).toBeNull();
  });

  it("writes the spine the org-creation path writes, traced to the approval", async () => {
    const added = await db
      .select({ payload: auditLog.payload, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(
        and(eq(auditLog.targetOrganizationId, practiceId), eq(auditLog.action, "org_member_added")),
      );
    expect(added).toHaveLength(1);
    expect(added[0].actor).toBe(ids.approver);
    expect(added[0].payload).toMatchObject({
      how: "vet_approval_provisioning",
      approval_request_id: requestId,
      role: "admin",
    });

    const [verification] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.targetOrganizationId, practiceId),
          eq(approvalRequests.type, "organization_verification"),
        ),
      );
    expect(verification.status).toBe("approved");

    const [approved] = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(eq(auditLog.approvalRequestId, requestId), eq(auditLog.action, "request_approved")),
      );
    expect(approved.payload).toMatchObject({
      mutations_applied: { practice: { kind: "provisioned", organization_id: practiceId } },
    });
  });

  it("is idempotent: provisioning again finds the practice instead of creating a second", async () => {
    const again = await db.transaction((tx) =>
      provisionVetPractice(tx, {
        vetUserId: ids.fresh,
        actorUserId: ids.approver,
        request: { id: requestId, jurisdictionProvince: "CABA", jurisdictionLocality: "Coghlan" },
        tokens: { orgPublicToken: generatePublicToken(), verificationPublicToken: "unused" },
      }),
    );
    expect(again).toMatchObject({ kind: "existing", organization_id: practiceId });
    expect(await orgIdsTouching(ids.fresh)).toEqual([practiceId]);
  });
});

describe("a vet who can already write somewhere", () => {
  it("gets no second place: the clinic membership with event.write is kept as is", async () => {
    const clinicId = await makeOrg("clinic", ids.approver);
    const [m] = await db
      .insert(organizationMemberships)
      .values({ organizationId: clinicId, userId: ids.member, role: "member" })
      .returning({ id: organizationMemberships.id });
    await db.insert(organizationCapabilityGrants).values({
      membershipId: m.id,
      organizationId: clinicId,
      capability: "event.write",
      status: "approved",
      decidedAt: new Date(),
      decidedByUserId: ids.approver,
    });

    await approveVet(ids.member, "MN-W6-0002");

    const rows = await activeMemberships(ids.member);
    expect(rows.map((r) => r.organizationId)).toEqual([clinicId]);
    // …and the legacy column on it now says what the grant says.
    expect(rows[0].canWritePetEvents).toBe(true);
    expect(await orgIdsTouching(ids.member)).toEqual([]);
  });

  it("a tránsito elsewhere is NOT upgraded — the vet gets their own practice instead", async () => {
    const shelterId = await makeOrg("shelter", ids.approver);
    await db
      .insert(organizationMemberships)
      .values({ organizationId: shelterId, userId: ids.foster, role: "foster" });

    await approveVet(ids.foster, "MN-W6-0003");

    const rows = await activeMemberships(ids.foster);
    const foster = rows.find((r) => r.organizationId === shelterId);
    const practice = rows.find((r) => r.organizationId !== shelterId);
    expect(foster?.role).toBe("foster");
    expect(foster?.canWritePetEvents).toBe(false);
    expect(practice?.role).toBe("admin");
    const shelterGrants = await db
      .select({ id: organizationCapabilityGrants.id })
      .from(organizationCapabilityGrants)
      .where(eq(organizationCapabilityGrants.organizationId, shelterId));
    expect(shelterGrants).toEqual([]);
  });
});

describe("the legacy column follows the real grant (single writer)", () => {
  it("derives the value from role + approved grants, not from anybody's intent", async () => {
    const repo = new OrgRepository();
    const shelterId = await makeOrg("shelter", ids.approver);
    const [m] = await db
      .insert(organizationMemberships)
      .values({ organizationId: shelterId, userId: ids.fresh, role: "member" })
      .returning({ id: organizationMemberships.id });

    // A member with no grant: false, even if something had written true.
    await db
      .update(organizationMemberships)
      .set({ canWritePetEvents: true })
      .where(eq(organizationMemberships.id, m.id));
    expect(await db.transaction((tx) => syncEventWriteMirror(repo, m.id, tx))).toBe(false);

    // An approved grant: true.
    await db.insert(organizationCapabilityGrants).values({
      membershipId: m.id,
      organizationId: shelterId,
      capability: "event.write",
      status: "approved",
      decidedAt: new Date(),
      decidedByUserId: ids.approver,
    });
    expect(await db.transaction((tx) => syncEventWriteMirror(repo, m.id, tx))).toBe(true);

    // Every membership this file created agrees with what the resolver grants.
    for (const uid of [ids.fresh, ids.member, ids.foster]) {
      for (const row of await activeMemberships(uid)) {
        const state = await repo.readEventWriteState(row.id);
        const effective = state
          ? resolveGrantedCaps(state.role, state.approvedCapabilities, {
              vetCredentialValid: state.vetCredentialValid,
            }).has("event.write")
          : false;
        const [fresh] = await db
          .select({ c: organizationMemberships.canWritePetEvents })
          .from(organizationMemberships)
          .where(eq(organizationMemberships.id, row.id));
        expect(fresh.c, `${row.role} in ${row.organizationId}`).toBe(effective);
      }
    }
  });
});

describe("revocation closes the practice; re-approval reopens the same one (W6 review)", () => {
  let practiceId: string;
  let practiceToken: string;
  let shelterId: string;

  beforeAll(async () => {
    [practiceId] = await orgIdsTouching(ids.fresh);
    const [org] = await db
      .select({ publicToken: organizations.publicToken })
      .from(organizations)
      .where(eq(organizations.id, practiceId));
    practiceToken = org.publicToken;

    // A seat in someone else's shelter, with the legacy column saying "writes"
    // — the revocation does not end it (the vet did not create that org), so
    // it is what the resolver's own credential check has to stop.
    shelterId = await makeOrg("shelter", ids.approver);
    await db.insert(organizationMemberships).values({
      organizationId: shelterId,
      userId: ids.fresh,
      role: "vet_individual",
      canWritePetEvents: true,
    });

    const [evidence] = await db
      .insert(attachments)
      .values({
        uploadedByUserId: ids.approver,
        storagePath: `revocations/${ids.approver}/w6-evidence.jpg`,
        mimeType: "image/jpeg",
        fileSize: 1234,
      })
      .returning({ id: attachments.id });
    const revoked = await revokeVetRoleForAuthority(ids.approver, {
      targetUserId: ids.fresh,
      motivo: "Matrícula dada de baja por el colegio profesional (prueba W6).",
      attachmentIds: [evidence.id],
    });
    expect(revoked).toEqual(expect.objectContaining({ ok: true }));
  });

  it("ends the practice membership, audits the removal against the revocation, un-verifies the org", async () => {
    const [m] = await db
      .select({
        leftAt: organizationMemberships.leftAt,
        column: organizationMemberships.canWritePetEvents,
      })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, practiceId),
          eq(organizationMemberships.userId, ids.fresh),
        ),
      );
    expect(m.leftAt).not.toBeNull();
    expect(m.column).toBe(false);

    const [revocation] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.targetUserId, ids.fresh), eq(auditLog.action, "revocation_vet_role")));
    const removed = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetOrganizationId, practiceId),
          eq(auditLog.action, "org_member_removed"),
        ),
      );
    expect(removed).toHaveLength(1);
    expect(removed[0].payload).toMatchObject({
      how: "vet_revocation",
      reason_audit_log_id: revocation.id,
    });

    const [org] = await db
      .select({ verified: organizations.verified })
      .from(organizations)
      .where(eq(organizations.id, practiceId));
    expect(org.verified).toBe(false);
  });

  it("the revoked vet can no longer open the atender context of the practice", async () => {
    live.userId = ids.fresh;
    const atender = await resolveAtenderContext(practiceToken);
    expect(atender.ok).toBe(false);
    if (atender.ok) return;
    // The membership itself is gone, which is stronger than a missing capability.
    expect(atender.reason).toBe("NO_MEMBERSHIP");
  });

  it("a vet_individual seat the revocation left in place grants no clinical write", async () => {
    // Belt and braces: the membership row survives (another org's), but the
    // clinical baseline rides on the member's live matrícula, not on the role.
    const [seat] = await db
      .select({
        leftAt: organizationMemberships.leftAt,
        column: organizationMemberships.canWritePetEvents,
      })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, shelterId),
          eq(organizationMemberships.userId, ids.fresh),
        ),
      );
    expect(seat.leftAt).toBeNull();
    // The revocation re-derived the legacy column through its single writer.
    expect(seat.column).toBe(false);

    const [shelter] = await db
      .select({ publicToken: organizations.publicToken })
      .from(organizations)
      .where(eq(organizations.id, shelterId));
    live.userId = ids.fresh;
    const atender = await resolveAtenderContext(shelter.publicToken);
    expect(atender.ok).toBe(false);
    if (atender.ok) return;
    expect(atender.reason).toBe("NO_CAPABILITY");
  });

  it("approving the same person again reopens their practice instead of creating a second", async () => {
    // Nothing else to write from: end the memberships the earlier cases added.
    await db
      .update(organizationMemberships)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(organizationMemberships.userId, ids.fresh),
          inArray(organizationMemberships.organizationId, extraOrgIds),
        ),
      );

    const secondRequestId = await approveVet(ids.fresh, "MN-W6-0004");

    expect(await orgIdsTouching(ids.fresh)).toEqual([practiceId]);
    const [m] = await db
      .select({ leftAt: organizationMemberships.leftAt, role: organizationMemberships.role })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, practiceId),
          eq(organizationMemberships.userId, ids.fresh),
        ),
      );
    expect(m.leftAt).toBeNull();
    expect(m.role).toBe("admin");
    const [org] = await db
      .select({ verified: organizations.verified, auto: organizations.autoVerifiedViaMatricula })
      .from(organizations)
      .where(eq(organizations.id, practiceId));
    expect(org).toEqual({ verified: true, auto: true });

    const added = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(eq(auditLog.targetOrganizationId, practiceId), eq(auditLog.action, "org_member_added")),
      );
    const payloads = added.map((r) => r.payload as { how: string; approval_request_id?: string });
    expect(payloads.map((p) => p.how).sort()).toEqual([
      "vet_approval_provisioning",
      "vet_approval_reactivation",
    ]);
    expect(payloads.some((p) => p.approval_request_id === secondRequestId)).toBe(true);

    live.userId = ids.fresh;
    expect((await resolveAtenderContext(practiceToken)).ok).toBe(true);
  });
});
