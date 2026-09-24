// Integration tests for Fase D1 of the cases system — wiring
// welfare_denuncia cases into the existing welfare flow.
//
// We don't drive the full createWelfareReportAction (FormData + auth
// would force us to mock too much). Instead we exercise the contract
// directly by:
//  1. Inserting a welfare_reports row.
//  2. Calling openCase() with the same shape the action uses + linking.
//  3. Asserting the case row, the welfare_reports.case_id pointer, and
//     bridge-event case_id attribution all converge.
//
// The triage closure mirror is tested by calling closeCase() the same
// way welfare-triage.ts does — same helper, same arguments.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, petEvents, pets, welfareReports } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, openCase } from "@/lib/infra/case-helpers";
import { withMutationOverride } from "./_helpers/db-overrides";

let petId: string;
let welfareReportId: string;
let caseId: string;

const PET_TOKEN = "DIM-D1-PA1";
const REF_CODE = "DEN-D1-AAAA";

beforeAll(async () => {
  // Reset prior runs. FK chain is bidirectional with RESTRICT:
  //   welfare_reports.case_id → cases (RESTRICT)
  //   cases.welfare_report_id → welfare_reports (RESTRICT)
  //   cases.primary_pet_id → pets (RESTRICT)
  // Null both sides of the welfare↔case pair, drop pet_events first, then
  // cases, welfare_reports, pets.
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
    await tx.execute(sql`DELETE FROM cases WHERE welfare_report_id IN (
      SELECT id FROM welfare_reports WHERE reference_code = ${REF_CODE}
    )`);
    await tx.execute(sql`DELETE FROM welfare_reports WHERE reference_code = ${REF_CODE}`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "WelfareCaseTest",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;

  const [report] = await db
    .insert(welfareReports)
    .values({
      referenceCode: REF_CODE,
      kind: "neglect",
      severity: "high",
      description: "fixture report for D1 case wiring tests (≥20 chars).",
      subjectKind: "registered_pet",
      subjectPetId: petId,
      status: "open",
    })
    .returning();
  welfareReportId = report.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    // Null out both sides of the bidirectional welfare↔case FK pair.
    await tx.execute(sql`UPDATE welfare_reports SET case_id = NULL WHERE id = ${welfareReportId}`);
    await tx.execute(sql`UPDATE cases SET welfare_report_id = NULL WHERE id = ${caseId}`);
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
    await tx.execute(sql`DELETE FROM cases WHERE id = ${caseId}`);
    await tx.execute(sql`DELETE FROM welfare_reports WHERE id = ${welfareReportId}`);
    await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
  });
});

describe("D1: welfare_denuncia case opens atomically with welfare_reports row", () => {
  it("openCase + UPDATE report.case_id + bridge event lands inside one tx", async () => {
    await db.transaction(async (tx) => {
      const caseRow = await openCase(
        {
          kind: "welfare_denuncia",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          openedReason: {
            code: "welfare_report_citizen",
            referenceCode: REF_CODE,
            kind: "neglect",
            severity: "high",
          },
          welfareReportId,
        },
        tx,
      );
      caseId = caseRow.id;

      await tx
        .update(welfareReports)
        .set({ caseId: caseRow.id })
        .where(eq(welfareReports.id, welfareReportId));

      const payload = validateEventPayload("maltreatment_reported", {
        welfare_report_id: welfareReportId,
        reporter_role: "witness",
        description: "fixture description for the bridge event",
        severity: "high",
        kind: "neglect",
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "maltreatment_reported",
        occurredAt: new Date(),
        recordedAt: new Date(),
        authorRole: "scanner",
        payload,
        caseId: caseRow.id,
      });
    });

    const [linked] = await db
      .select({
        caseId: welfareReports.caseId,
        status: cases.status,
        caseKind: cases.caseKind,
        primaryPetId: cases.primaryPetId,
      })
      .from(welfareReports)
      .leftJoin(cases, eq(cases.id, welfareReports.caseId))
      .where(eq(welfareReports.id, welfareReportId));

    expect(linked.caseId).toBe(caseId);
    expect(linked.status).toBe("open");
    expect(linked.caseKind).toBe("welfare_denuncia");
    expect(linked.primaryPetId).toBe(petId);
  });

  it("bridge event carries case_id back to the case row", async () => {
    const events = await db
      .select({ caseId: petEvents.caseId })
      .from(petEvents)
      .where(eq(petEvents.petId, petId));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.caseId === caseId)).toBe(true);
  });
});

describe("D1: closeWelfareReportAction parity — closeCase mirror", () => {
  it("closes case with closed_reason=resolved when report closes normally", async () => {
    const updated = await closeCase({
      caseId,
      reason: "resolved",
      closedByUserId: null,
    });
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("closed");
    expect(updated?.closedReason).toBe("resolved");
  });

  it("is idempotent — closing twice returns the existing closed row", async () => {
    const second = await closeCase({ caseId, reason: "resolved" });
    expect(second?.status).toBe("closed");
  });
});
