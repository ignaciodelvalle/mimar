// Integration tests for Fase 2 admin decision actions.
//
// Each test exercises a real approval_request lifecycle: submit via the
// existing Fase 1 writers, then approve/reject via the new admin-decision
// inner writers. Verifies the target mutation, the approval_requests
// status flip, the audit_log entry, and the applicant notification.

import { createClient } from "@supabase/supabase-js";
import { and, eq, isNull, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composeMatriculaApprovalNotes } from "@/app/gob/cola/_lib/matricula-verification";
import { WHOLE_PROVINCE_LOCALITY } from "@/lib/domain/jurisdiction-canonical";

import {
  approvalRequests,
  auditLog,
  db,
  govtAssignments,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  pets,
  profiles,
} from "@/db";
import { approveRequestForAuthority } from "@/src/modules/organizations/application/admin-decisions/approve-request";
import { logRequestViewedForAuthority } from "@/src/modules/organizations/application/admin-decisions/log-request-viewed";
import { rejectRequestForAuthority } from "@/src/modules/organizations/application/admin-decisions/reject-request";
import { requestInfoForAuthority } from "@/src/modules/organizations/application/admin-decisions/request-info";
import { proposeVetUpgradeForUser } from "@/src/modules/organizations/application/admin-proposals/propose-vet-upgrade";
import { createOrganizationForUser } from "@/src/modules/organizations/application/upgrade/create-organization";
import { requestVetUpgradeForUser } from "@/src/modules/organizations/application/upgrade/request-vet-upgrade";
import {
  approvalRequestIdFromDedupeKey,
  messageFromApprovalInfoBody,
} from "@/src/modules/organizations/domain/approval-info-key";
import { setAuditMutationGucs, withMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const VET_EMAIL = "admin-dec-vet@dim-test.local";
const VET2_EMAIL = "admin-dec-vet2@dim-test.local";
const ORG_EMAIL = "admin-dec-org@dim-test.local";
const GOVT_EMAIL = "admin-dec-govt@dim-test.local";
const ADMIN_EMAIL = "admin-dec-admin@dim-test.local";
// Dedicated applicant for the scope-enforcement block. It MUST NOT be shared
// with the approval blocks above: those promote their applicant to role='vet',
// and a user who is already a vet cannot submit a new vet-upgrade petition — so
// a shared applicant silently leaves the scope test with nothing to decide.
const SCOPE_EMAIL = "admin-dec-scope@dim-test.local";
// H3 two-person rule: an officer who is ALSO the applicant / the initiator.
// Dedicated users so the promotion to govt and the org they found cannot leak
// into any other block's fixtures.
const TWOP_GOVT_EMAIL = "admin-dec-twop-govt@dim-test.local";
const TWOP_TARGET_EMAIL = "admin-dec-twop-target@dim-test.local";
const PASS = "AdminDec_2026!";

let vetApplicantId: string;
let vet2ApplicantId: string;
let orgApplicantId: string;
let govtUserId: string;
let adminUserId: string;
let scopeApplicantId: string;
let twoPersonGovtId: string;
let twoPersonTargetId: string;

async function deleteTestUser(email: string) {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((p) => p.id).filter((id) => id !== found?.id),
  ];
  for (const uid of ids) {
    // audit_log has ON DELETE RESTRICT on actor_user_id and NO ACTION on
    // target_user_id / target_organization_id. Wipe every row referencing
    // this user in either role before deleting the profile, and wipe rows
    // referencing each org as target before deleting the org.
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx
        .delete(auditLog)
        .where(or(eq(auditLog.actorUserId, uid), eq(auditLog.targetUserId, uid)));
    });
    await db.delete(govtAssignments).where(eq(govtAssignments.userId, uid));
    await db.delete(notifications).where(eq(notifications.userId, uid));
    const adminRows = await db
      .select({ orgId: organizationMemberships.organizationId })
      .from(organizationMemberships)
      .where(
        and(eq(organizationMemberships.userId, uid), eq(organizationMemberships.role, "admin")),
      );
    for (const { orgId } of adminRows) {
      await db.transaction(async (tx) => {
        await setAuditMutationGucs(tx);
        await tx.delete(auditLog).where(eq(auditLog.targetOrganizationId, orgId));
      });
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
    const owned = await db
      .select({ petId: ownerships.petId })
      .from(ownerships)
      .where(eq(ownerships.ownerUserId, uid));
    if (owned.length > 0) {
      await withMutationOverride(async (tx) => {
        for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
      });
    }
    await db.delete(profiles).where(eq(profiles.id, uid));
  }
  if (found) await admin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  for (const email of [
    VET_EMAIL,
    VET2_EMAIL,
    ORG_EMAIL,
    GOVT_EMAIL,
    ADMIN_EMAIL,
    SCOPE_EMAIL,
    TWOP_GOVT_EMAIL,
    TWOP_TARGET_EMAIL,
  ]) {
    await deleteTestUser(email);
  }

  vetApplicantId = await createTestUser(VET_EMAIL);
  vet2ApplicantId = await createTestUser(VET2_EMAIL);
  orgApplicantId = await createTestUser(ORG_EMAIL);
  govtUserId = await createTestUser(GOVT_EMAIL);
  adminUserId = await createTestUser(ADMIN_EMAIL);
  scopeApplicantId = await createTestUser(SCOPE_EMAIL);
  twoPersonGovtId = await createTestUser(TWOP_GOVT_EMAIL);
  twoPersonTargetId = await createTestUser(TWOP_TARGET_EMAIL);

  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));

  // DNI prereq: mark applicants verified so they can submit petitions.
  await db
    .update(profiles)
    .set({ dniVerified: true })
    .where(
      or(
        eq(profiles.id, vetApplicantId),
        eq(profiles.id, vet2ApplicantId),
        eq(profiles.id, orgApplicantId),
        eq(profiles.id, scopeApplicantId),
      ),
    );
});

async function createTestUser(email: string): Promise<string> {
  const r = await createFreshTestUser(admin, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

afterAll(async () => {
  for (const email of [
    VET_EMAIL,
    VET2_EMAIL,
    ORG_EMAIL,
    GOVT_EMAIL,
    ADMIN_EMAIL,
    SCOPE_EMAIL,
    TWOP_GOVT_EMAIL,
    TWOP_TARGET_EMAIL,
  ]) {
    await deleteTestUser(email);
  }
});

describe("approveRequestForAuthority — role_upgrade_vet", () => {
  it("admin approves: flips role + verified, logs audit, notifies applicant", async () => {
    const submit = await requestVetUpgradeForUser(vetApplicantId, {
      matriculaNumber: "MN-A1000",
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
          eq(approvalRequests.applicantUserId, vetApplicantId),
          eq(approvalRequests.type, "role_upgrade_vet"),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .limit(1);

    // A3: a vet-matricula approval must carry the checklist's structured note.
    const result = await approveRequestForAuthority(
      adminUserId,
      req.publicToken,
      composeMatriculaApprovalNotes("OK"),
    );
    expect(result).toEqual({ ok: true });

    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.id, vetApplicantId))
      .limit(1);
    expect(profile.role).toBe("vet");
    expect(profile.matriculaVerified).toBe(true);

    const [updated] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, req.id))
      .limit(1);
    expect(updated.status).toBe("approved");
    expect(updated.decidedByUserId).toBe(adminUserId);
    expect(updated.decisionNotes).toBe(composeMatriculaApprovalNotes("OK"));

    const [logEntry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.approvalRequestId, req.id), eq(auditLog.action, "request_approved")))
      .limit(1);
    expect(logEntry).toBeDefined();
    expect(logEntry.actorUserId).toBe(adminUserId);

    const [notif] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, vetApplicantId),
          eq(notifications.notificationType, "approval_request_approved"),
        ),
      )
      .limit(1);
    expect(notif).toBeDefined();
    expect(notif.severity).toBe("success");
  });

  it("guards: deciding twice rejects the second call", async () => {
    const [req] = await db
      .select({ publicToken: approvalRequests.publicToken })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.applicantUserId, vetApplicantId),
          eq(approvalRequests.type, "role_upgrade_vet"),
          eq(approvalRequests.status, "approved"),
        ),
      )
      .limit(1);
    const result = await approveRequestForAuthority(adminUserId, req.publicToken, null);
    expect("error" in result && result.error).toMatch(/aprobada|estado/i);
  });
});

describe("matrícula verification flow (UI/UX audit 2026-07)", () => {
  let vet2Token: string;
  let vet2RequestId: string;

  beforeAll(async () => {
    const submit = await requestVetUpgradeForUser(vet2ApplicantId, {
      matriculaNumber: "MN-B2000",
      matriculaJurisdiccion: "Buenos Aires",
      operationalProvince: "Buenos Aires",
      operationalLocality: "La Plata",
    });
    expect(submit.ok).toBe(true);
    const [req] = await db
      .select({ publicToken: approvalRequests.publicToken, id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.applicantUserId, vet2ApplicantId),
          eq(approvalRequests.type, "role_upgrade_vet"),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .limit(1);
    vet2Token = req.publicToken;
    vet2RequestId = req.id;
  });

  it("bulk approve is refused for role_upgrade_vet (bulk reject unaffected)", async () => {
    // bulkActionId != null marks the bulk path (bulk-approve-requests.ts).
    const result = await approveRequestForAuthority(
      adminUserId,
      vet2Token,
      null,
      "test-bulk-action-id",
    );
    expect("error" in result && result.error).toMatch(/lote|individual/i);

    // The request must remain pending and decidable.
    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, vet2RequestId))
      .limit(1);
    expect(row.status).toBe("pending");
  });

  it("requestInfoForAuthority: validates the message length", async () => {
    const result = await requestInfoForAuthority(adminUserId, vet2Token, "abc");
    expect("error" in result && result.error).toMatch(/5 y 1000/);
  });

  it("requestInfoForAuthority: logs the event + notifies, keeps the request pending", async () => {
    const message = "Adjuntá una foto del carnet de matrícula, por favor.";
    const result = await requestInfoForAuthority(adminUserId, vet2Token, message);
    expect(result).toEqual({ ok: true });

    // Notes-only event: audit row with the message…
    const [logEntry] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.approvalRequestId, vet2RequestId),
          eq(auditLog.action, "request_info_requested"),
        ),
      )
      .limit(1);
    expect(logEntry).toBeDefined();
    expect((logEntry.payload as { message?: string }).message).toBe(message);

    // …an applicant notification…
    const [notif] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, vet2ApplicantId),
          eq(notifications.notificationType, "approval_request_info_requested"),
        ),
      )
      .limit(1);
    expect(notif).toBeDefined();
    expect(notif.body).toContain(message);

    // …which /cuenta/solicitudes must be able to READ BACK. The bug this whole
    // path exists to close was never a format bug: the event fired and nothing
    // rendered it. Asserting only that the row exists would have passed happily
    // through the entire outage, so this replays the page's own derivation
    // against the row the use case just wrote.
    expect(approvalRequestIdFromDedupeKey(notif.dedupeKey)).toBe(vet2RequestId);
    expect(messageFromApprovalInfoBody(notif.body)).toBe(message);
    // And the CTA has to land on the page that shows it. ctaForApplicant points
    // at /cuenta/upgrade for this type, which replaces its form with "Solicitud
    // enviada — pendiente de revisión." while a request is pending: the exact
    // silence being fixed.
    expect(notif.ctaUrl).toBe("/cuenta/solicitudes");

    // …and the request row is UNTOUCHED: still pending, no decision fields.
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, vet2RequestId))
      .limit(1);
    expect(row.status).toBe("pending");
    expect(row.decidedAt).toBeNull();
    expect(row.decidedByUserId).toBeNull();

    // Non-terminal: an individual approve afterwards still works, with the
    // structured verification notes persisted in decision_notes.
    const structuredNotes =
      "[Verificación de matrícula] Formato verificado; registro oficial consultado; identidad consistente.";
    const approve = await approveRequestForAuthority(adminUserId, vet2Token, structuredNotes);
    expect(approve).toEqual({ ok: true });
    const [decided] = await db
      .select({ status: approvalRequests.status, decisionNotes: approvalRequests.decisionNotes })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, vet2RequestId))
      .limit(1);
    expect(decided.status).toBe("approved");
    expect(decided.decisionNotes).toBe(structuredNotes);
  });

  it("A3: rejects an individual vet approval WITHOUT the verification note — direct call, bare notes", async () => {
    // The client checklist only disables the submit button; this proves the
    // server refuses the upgrade when the structured proof is absent. Fresh
    // request so no earlier approve in this suite can make the case vacuous.
    const submit = await requestVetUpgradeForUser(orgApplicantId, {
      matriculaNumber: "MN-A3000",
      matriculaJurisdiccion: "Buenos Aires",
      operationalProvince: "Buenos Aires",
      operationalLocality: "Quilmes",
    });
    expect(submit.ok).toBe(true);
    const [req] = await db
      .select({ publicToken: approvalRequests.publicToken, id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.applicantUserId, orgApplicantId),
          eq(approvalRequests.type, "role_upgrade_vet"),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .limit(1);
    expect(req).toBeDefined();

    const bare = await approveRequestForAuthority(adminUserId, req.publicToken, "OK");
    expect("error" in bare && bare.error).toMatch(/verificaci|checklist/i);
    const nullNotes = await approveRequestForAuthority(adminUserId, req.publicToken, null);
    expect("error" in nullNotes && nullNotes.error).toMatch(/verificaci|checklist/i);

    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, req.id))
      .limit(1);
    expect(row.status).toBe("pending");

    // Cleanup: clear the pending request so the later reject suite can mint
    // its own for the same applicant (and the applicant keeps role != vet).
    const cleanup = await rejectRequestForAuthority(
      adminUserId,
      req.publicToken,
      "A3 cleanup — solicitud de prueba del gate de verificación.",
    );
    expect(cleanup).toEqual({ ok: true });
  });
});

describe("approveRequestForAuthority — organization_verification", () => {
  it("admin approves: flips verified=true, fans out to org admins on decision notification", async () => {
    const created = await createOrganizationForUser(orgApplicantId, {
      name: "Refugio Fase2",
      legalName: "Asoc. Civil Fase2",
      orgType: "shelter",
      cuit: "30766554433",
      email: "fase2@refugio.test",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Almagro",
    });
    expect("ok" in created && created.ok).toBe(true);
    const orgId = (created as { organizationId: string }).organizationId;

    const [req] = await db
      .select({ publicToken: approvalRequests.publicToken })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.targetOrganizationId, orgId),
          eq(approvalRequests.type, "organization_verification"),
        ),
      )
      .limit(1);

    const result = await approveRequestForAuthority(adminUserId, req.publicToken, null);
    expect(result).toEqual({ ok: true });

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    expect(org.verified).toBe(true);
    expect(org.verifiedByUserId).toBe(adminUserId);

    const [notif] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, orgApplicantId),
          eq(notifications.notificationType, "approval_request_approved"),
        ),
      )
      .limit(1);
    expect(notif).toBeDefined();
  });
});

describe("rejectRequestForAuthority", () => {
  it("admin rejects with reason: sets status, logs audit, notifies applicant", async () => {
    // Spin up a new vet request specifically for this test (the vet
    // applicant from earlier is already role='vet').
    const submit = await requestVetUpgradeForUser(orgApplicantId, {
      matriculaNumber: "MN-R2000",
      matriculaJurisdiccion: "Buenos Aires",
      operationalProvince: "Buenos Aires",
      operationalLocality: "Mar del Plata",
    });
    expect(submit.ok).toBe(true);

    const [req] = await db
      .select({ publicToken: approvalRequests.publicToken, id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.applicantUserId, orgApplicantId),
          eq(approvalRequests.type, "role_upgrade_vet"),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .limit(1);

    const result = await rejectRequestForAuthority(
      adminUserId,
      req.publicToken,
      "Matrícula vencida — adjuntá certificado vigente.",
    );
    expect(result).toEqual({ ok: true });

    const [updated] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, req.id))
      .limit(1);
    expect(updated.status).toBe("rejected");
    expect(updated.decisionNotes).toMatch(/vencida/i);

    const [notif] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, orgApplicantId),
          eq(notifications.notificationType, "approval_request_rejected"),
        ),
      )
      .limit(1);
    expect(notif).toBeDefined();
    expect(notif.severity).toBe("warning");

    const [logEntry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.approvalRequestId, req.id), eq(auditLog.action, "request_rejected")))
      .limit(1);
    expect(logEntry).toBeDefined();
  });

  it("validates reason length (too short)", async () => {
    const result = await rejectRequestForAuthority(adminUserId, "APR-DUMMY-NOOP", "no");
    expect("error" in result && result.error).toMatch(/raz/i);
  });
});

describe("scope enforcement — govt cannot decide out-of-scope requests", () => {
  it("govt without matching govt_assignment is rejected by capability check", async () => {
    // Promote govtUserId to govt + give them an assignment in a DIFFERENT
    // locality from the request being decided.
    await db
      .update(profiles)
      .set({ role: "govt", accountType: "institutional" })
      .where(eq(profiles.id, govtUserId));
    // WHOLE_PROVINCE_SENTINEL, not "Capital" (fixed 2026-08-10).
    //
    // "Capital" does not exist in ar_localities for Mendoza, and
    // __tests__/govt-assignments-locality-integrity.test.ts is explicit about
    // what that means: a locality that does not resolve "silently produces an
    // EMPTY scope in jurisdictionPairClause". So this fixture was proving the
    // wrong thing — the govt would have been rejected even if the scoping logic
    // were broken, because their scope matched nothing at all.
    //
    // The sentinel gives them a REAL scope (all of Mendoza) that genuinely does
    // not contain the CABA request below, so the rejection now tests the rule
    // instead of testing a typo. Note jurisdiction-canonical.ts warns that the
    // province's own name is NOT the sentinel: "Mendoza" is itself a real
    // locality inside Mendoza.
    // REVOKED IN A `finally`, NOT AT FILE TEARDOWN (2026-08-26).
    //
    // This row is scoped to the WHOLE of Mendoza, and Mendoza/Bowen is the
    // jurisdiction two other suites use precisely because nothing covers it —
    // `__tests__/_helpers/admin-fallback-jurisdiction.ts` names them. While this
    // row is live, `findAuthoritiesForJurisdiction` is govt-first for Bowen too,
    // so the admin fallback those suites assert cannot fire.
    //
    // It used to be cleaned only when this FILE tore down, which is fine right
    // up until the worker dies first — and then the row outlives the run and
    // three assertions in two unrelated files fail on every run afterwards,
    // reporting a bare "expected 0" that points at neither this file nor this
    // row. That happened, and it read as a flake for days. Scoping the fixture
    // to the test that needs it does not survive a mid-test crash either, but it
    // removes every ordinary way for the row to escape.
    const [scopeAssignment] = await db
      .insert(govtAssignments)
      .values({
        userId: govtUserId,
        jurisdictionProvince: "Mendoza",
        jurisdictionLocality: WHOLE_PROVINCE_LOCALITY.Mendoza,
        grantedByUserId: adminUserId,
      })
      .returning({ id: govtAssignments.id });

    try {
      // Create a fresh request in CABA — from an applicant NOBODY promoted.
      // This used to reuse vetApplicantId, whom the first describe block turns
      // into role='vet'; the submit then failed, an `if (!submit.ok) return`
      // swallowed it, and the only assertion in this file's scope coverage never
      // ran. A failed submit is now a FAILURE: without a pending request there is
      // no out-of-scope decision to reject and the test proves nothing.
      const submit = await requestVetUpgradeForUser(scopeApplicantId, {
        matriculaNumber: "MN-OUT1000",
        matriculaJurisdiccion: "CABA",
        operationalProvince: "CABA",
        operationalLocality: "Colegiales",
      });
      expect(submit.ok, "the scope test needs a real pending request to decide").toBe(true);

      const [req] = await db
        .select({ publicToken: approvalRequests.publicToken, id: approvalRequests.id })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.applicantUserId, scopeApplicantId),
            eq(approvalRequests.jurisdictionLocality, "Colegiales"),
          ),
        )
        .limit(1);
      expect(req, "the CABA/Colegiales request must exist before it can be denied").toBeDefined();

      const result = await approveRequestForAuthority(govtUserId, req.publicToken, null);
      expect("error" in result && result.error).toMatch(/permiso|jurisdicc/i);

      // The denial is not just a message: the request must be UNTOUCHED — an
      // out-of-scope authority that returns an error while still flipping the row
      // would pass the assertion above.
      const [row] = await db
        .select({
          status: approvalRequests.status,
          decidedByUserId: approvalRequests.decidedByUserId,
        })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, req.id))
        .limit(1);
      expect(row.status).toBe("pending");
      expect(row.decidedByUserId).toBeNull();
    } finally {
      await db.delete(govtAssignments).where(eq(govtAssignments.id, scopeAssignment.id));
    }
  });
});

// Migration 0015 replaced the role='admin'-scoped trigger with
// enforce_institutional_no_pets which covers account_type='institutional'
// (both govt AND admin). role_upgrade_admin and role_upgrade_govt were
// removed from APPROVAL_REQUEST_TYPES — institutional accounts are now
// created directly by an existing admin, not via approval_requests.
//
// This describe block now verifies the DB-level trigger fires when ANY
// institutional user (admin or govt) tries to own a pet.
describe("enforce_institutional_no_pets trigger (migration 0015)", () => {
  it("inserting an ownership for an institutional user throws restrict_violation", async () => {
    // adminUserId was seeded as role='admin' with account_type='institutional'
    // in beforeAll. Attempting to give them a pet must throw.
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: `DIM-FA2-${Date.now().toString(36).toUpperCase().slice(-4)}`,
        name: "BlockerPet",
        species: "dog",
        sex: "unknown",
        status: "active",
        potentiallyDangerousBreed: false,
      })
      .returning();

    await expectDbError(
      db.insert(ownerships).values({
        petId: pet.id,
        ownerUserId: adminUserId,
        role: "owner",
        startedAt: new Date(),
      }),
      { constraint: /institutional|restrict/i },
    );

    // Cleanup the pet (ownership was never inserted).
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, pet.id));
    });
  });
});

describe("logRequestViewedForAuthority", () => {
  it("inserts a request_viewed audit_log entry", async () => {
    // Use the latest approved/rejected request from earlier tests.
    const [req] = await db
      .select({ publicToken: approvalRequests.publicToken, id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.applicantUserId, orgApplicantId))
      .limit(1);
    if (!req) return;

    await logRequestViewedForAuthority(adminUserId, req.publicToken);

    const views = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, adminUserId),
          eq(auditLog.approvalRequestId, req.id),
          eq(auditLog.action, "request_viewed"),
        ),
      );
    expect(views.length).toBeGreaterThan(0);
  });

  it("is a no-op for unknown tokens (does not raise)", async () => {
    await logRequestViewedForAuthority(adminUserId, "APR-XXXX-XXXX");
    // No assertion needed — if it raised, the test would fail.
  });
});

void isNull; // referenced by helpers above; satisfy ts-unused-vars in some configs

// ---------------------------------------------------------------------------
// H3 (top-10 review 2026-08-22) — the two-person rule.
//
// Creating an organization needs no role at all: any live user with a declared
// DNI can do it. So a government officer could stand up a foundation in their
// own barrio, walk into their own approvals queue, and verify it themselves.
// `organizations.verified` is not a badge — it gates receiving decomisos, being
// a rehome destination, and appearing in the public directory. One human, end
// to end, no second pair of eyes.
//
// That this is an OVERSIGHT and not a decision is provable from the repo: the
// identical control already exists in revoke-govt-locality.ts, whose comment
// literally calls it "Self-revocation footgun".
//
// The refusal is ordered AFTER the scope check, deliberately: an out-of-scope
// authority must keep getting the jurisdiction error, which is the accurate one,
// instead of learning that the request happens to be their own.
//
// The two arms below are the two identities the queue named — the APPLICANT
// (the org's own verification request) and the INITIATOR (a vet upgrade this
// same officer proposed). The third, TARGET, is covered by the pure unit tests
// in src/modules/organizations/domain/two-person-rule.test.ts.
// ---------------------------------------------------------------------------

describe("H3 — two-person rule on approval decisions", () => {
  let selfOrgToken: string;
  let selfOrgId: string;
  let proposedVetToken: string;

  beforeAll(async () => {
    // The org is created BEFORE the promotion, which is also the real-world
    // order: a citizen founds the org, and is later an authority.
    await db.update(profiles).set({ dniVerified: true }).where(eq(profiles.id, twoPersonGovtId));

    const created = await createOrganizationForUser(twoPersonGovtId, {
      name: "Refugio del Funcionario",
      legalName: "Asoc. Civil del Funcionario",
      orgType: "shelter",
      cuit: "30712345671",
      email: "funcionario@refugio.test",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Almagro",
    });
    expect("ok" in created && created.ok, "the H3 fixture needs a real org").toBe(true);
    selfOrgId = (created as { organizationId: string }).organizationId;

    await db
      .update(profiles)
      .set({ role: "govt", accountType: "institutional" })
      .where(eq(profiles.id, twoPersonGovtId));
    await db.insert(govtAssignments).values({
      userId: twoPersonGovtId,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Almagro",
      grantedByUserId: adminUserId,
    });

    const [orgReq] = await db
      .select({ publicToken: approvalRequests.publicToken })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.targetOrganizationId, selfOrgId),
          eq(approvalRequests.type, "organization_verification"),
        ),
      )
      .limit(1);
    expect(orgReq, "the org must have filed its verification request").toBeDefined();
    selfOrgToken = orgReq.publicToken;

    // The same officer proposes a vet upgrade for somebody else — they are the
    // INITIATOR, and the applicant is the target.
    await db.update(profiles).set({ dniVerified: true }).where(eq(profiles.id, twoPersonTargetId));
    const proposed = await proposeVetUpgradeForUser(twoPersonGovtId, {
      targetUserId: twoPersonTargetId,
      matriculaNumber: "MN-TWOP-01",
      matriculaJurisdiccion: "CABA",
      operationalProvince: "CABA",
      operationalLocality: "Almagro",
    });
    expect("ok" in proposed && proposed.ok, "the H3 fixture needs a proposed upgrade").toBe(true);

    const [vetReq] = await db
      .select({ publicToken: approvalRequests.publicToken })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.applicantUserId, twoPersonTargetId),
          eq(approvalRequests.type, "role_upgrade_vet"),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .limit(1);
    expect(vetReq, "the proposed vet upgrade must be pending").toBeDefined();
    proposedVetToken = vetReq.publicToken;
  });

  it("refuses a govt approving the verification of the organization THEY founded", async () => {
    const result = await approveRequestForAuthority(twoPersonGovtId, selfOrgToken, null);
    expect("error" in result && result.error).toMatch(/otra persona|vos mismo|misma persona/i);

    // The refusal is not just a message: the org must still be unverified and
    // the request untouched.
    const [org] = await db
      .select({ verified: organizations.verified })
      .from(organizations)
      .where(eq(organizations.id, selfOrgId))
      .limit(1);
    expect(org.verified).toBe(false);

    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.publicToken, selfOrgToken))
      .limit(1);
    expect(row.status).toBe("pending");
  });

  it("refuses a govt approving the vet upgrade THEY proposed", async () => {
    const result = await approveRequestForAuthority(
      twoPersonGovtId,
      proposedVetToken,
      composeMatriculaApprovalNotes("verificada"),
    );
    expect("error" in result && result.error).toMatch(/otra persona|vos mismo|misma persona/i);

    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.publicToken, proposedVetToken))
      .limit(1);
    expect(row.status).toBe("pending");
  });

  it("refuses the same officer merely ASKING FOR INFO on their own request", async () => {
    const result = await requestInfoForAuthority(
      twoPersonGovtId,
      selfOrgToken,
      "Necesito el estatuto firmado.",
    );
    expect("error" in result && result.error).toMatch(/otra persona|vos mismo|misma persona/i);
  });

  it("CONTROL: a DIFFERENT authority approves the very same request", async () => {
    // Without this the refusals above would be satisfied by a build that
    // refuses everything. Runs last so the earlier assertions still see the
    // request pending.
    const result = await approveRequestForAuthority(adminUserId, selfOrgToken, null);
    expect(result).toEqual({ ok: true });

    const [org] = await db
      .select({
        verified: organizations.verified,
        verifiedByUserId: organizations.verifiedByUserId,
      })
      .from(organizations)
      .where(eq(organizations.id, selfOrgId))
      .limit(1);
    expect(org.verified).toBe(true);
    expect(org.verifiedByUserId).toBe(adminUserId);
  });
});
