// Integration tests for the org-side welfare denuncia (spec
// 2026-05-19-org-abuse-investigation). The full server action requires
// formData + auth so we exercise the contract by emulating the action's
// invariants directly against the DB and the helpers it composes
// (openCase, welfare_reports.reporter_organization_id).

import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cases,
  db,
  organizationMemberships,
  organizations,
  pets,
  profiles,
  welfareReports,
} from "@/db";
import { openCase } from "@/lib/infra/case-helpers";
import { withMutationOverride } from "./_helpers/db-overrides";

const ORG_TOKEN = "DIM-ORGWLF-1";
const PET_TOKEN = "DIM-ORGWLF-PA1";
const REF_CODE = "DEN-OWLF-AAAA";

let orgId: string;
let petId: string;
let reporterUserId: string;
let welfareReportId: string;
let caseId: string;
const TEST_ROLE = "coordinator";

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`UPDATE welfare_reports SET case_id = NULL WHERE reference_code = ${REF_CODE}`,
    );
    await tx.execute(sql`UPDATE cases SET welfare_report_id = NULL
      WHERE welfare_report_id IN (SELECT id FROM welfare_reports WHERE reference_code = ${REF_CODE})`);
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM welfare_reports WHERE reference_code = ${REF_CODE}`);
    await tx.execute(sql`DELETE FROM organization_memberships WHERE organization_id IN (
      SELECT id FROM organizations WHERE public_token = ${ORG_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
    await tx.execute(sql`DELETE FROM organizations WHERE public_token = ${ORG_TOKEN}`);
  });

  // Insert a stub reporter profile (no auth.users row needed for direct DB tests).
  const stubId = "00000000-0000-0000-0000-000000af1f01";
  await db
    .insert(profiles)
    .values({
      id: stubId,
      displayName: "Org Welfare Reporter",
      role: "owner",
    })
    .onConflictDoNothing({ target: profiles.id });
  reporterUserId = stubId;

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Org Welfare Test SRL",
      displayName: "Org Welfare Test",
      orgType: "shelter",
      email: "orgwlf-test@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: reporterUserId,
    role: TEST_ROLE,
  });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "OrgWelfareTest",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`UPDATE welfare_reports SET case_id = NULL WHERE id = ${welfareReportId}`);
    await tx.execute(sql`UPDATE cases SET welfare_report_id = NULL WHERE id = ${caseId}`);
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
    await tx.execute(sql`DELETE FROM cases WHERE id = ${caseId}`);
    await tx.execute(sql`DELETE FROM welfare_reports WHERE id = ${welfareReportId}`);
    await tx.execute(sql`DELETE FROM organization_memberships WHERE organization_id = ${orgId}`);
    await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
    await tx.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
    await tx.execute(sql`DELETE FROM profiles WHERE id = ${reporterUserId}`);
  });
});

describe("Org-side welfare denuncia — schema + flow contract", () => {
  it("welfare_reports.reporter_organization_id is set when the org-side flow inserts", async () => {
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: REF_CODE,
        reporterUserId,
        reporterOrganizationId: orgId,
        kind: "neglect",
        severity: "critical",
        description:
          "Fixture description for org-side welfare denuncia, at least 100 characters to satisfy the professional reporting requirements baked into the action.",
        subjectKind: "registered_pet",
        subjectPetId: petId,
        status: "open",
      })
      .returning();
    welfareReportId = report.id;
    expect(report.reporterOrganizationId).toBe(orgId);
    expect(report.severity).toBe("critical");
  });

  it("welfare_denuncia case opens with the opened_by_organization populated", async () => {
    await db.transaction(async (tx) => {
      const c = await openCase(
        {
          kind: "welfare_denuncia",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          openedByUserId: reporterUserId,
          openedByOrganizationId: orgId,
          openedReason: {
            code: "welfare_report_org",
            referenceCode: REF_CODE,
            orgDisplayName: "Org Welfare Test",
          },
          welfareReportId,
        },
        tx,
      );
      caseId = c.id;
      await tx
        .update(welfareReports)
        .set({ caseId: c.id })
        .where(eq(welfareReports.id, welfareReportId));
    });
    const [linked] = await db
      .select({
        caseId: welfareReports.caseId,
        openedByOrganizationId: cases.openedByOrganizationId,
        primaryPetId: cases.primaryPetId,
        caseKind: cases.caseKind,
      })
      .from(welfareReports)
      .leftJoin(cases, eq(cases.id, welfareReports.caseId))
      .where(eq(welfareReports.id, welfareReportId));
    expect(linked.caseId).toBe(caseId);
    expect(linked.openedByOrganizationId).toBe(orgId);
    expect(linked.caseKind).toBe("welfare_denuncia");
    expect(linked.primaryPetId).toBe(petId);
  });

  it("the org-side report is queryable via reporter_organization_id (inbox)", async () => {
    const rows = await db
      .select({ id: welfareReports.id, referenceCode: welfareReports.referenceCode })
      .from(welfareReports)
      .where(eq(welfareReports.reporterOrganizationId, orgId));
    expect(rows.some((r) => r.id === welfareReportId)).toBe(true);
  });

  it("active membership in verified org with allowed role gates the capability", async () => {
    const [row] = await db
      .select({
        verified: organizations.verified,
        role: organizationMemberships.role,
      })
      .from(organizations)
      .innerJoin(
        organizationMemberships,
        eq(organizationMemberships.organizationId, organizations.id),
      )
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizationMemberships.userId, reporterUserId),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    expect(row.verified).toBe(true);
    expect(["admin", "coordinator", "member", "vet_individual"]).toContain(row.role);
  });
});
