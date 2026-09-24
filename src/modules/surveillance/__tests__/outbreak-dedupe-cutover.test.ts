// Outbreak dedupe survives the structured-open-reason cutover.
//
// THE HAZARD THIS GUARDS
// ----------------------
// `cases.opened_reason` is not just an audit column — surveillance-repository's
// findOpenInvestigationsForDisease executes
//     opened_reason LIKE 'manual [{diseaseCode}]:%'
// as SQL to stop a second open investigation for the same disease in the same
// jurisdiction. That makes the PROSE a live query key.
//
// Nothing type-checks a SQL LIKE against a TypeScript template. If the
// structured path had rendered the es-AR label into opened_reason (the
// intuitive move), this query would have silently stopped matching: duplicate
// open outbreak investigations, no compile error, no other failing test.
//
// So this test does not check strings. It writes a REAL post-cutover row
// through the REAL choke point (CasesRepository.openCase, structured input),
// then asks the REAL dedupe query to find it. Both cohorts, one query.

import { cases, db } from "@/db";
import { CasesRepository } from "@/src/modules/cases/infrastructure/cases-repository";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { SurveillanceRepository } from "../infrastructure/surveillance-repository";

const repo = new SurveillanceRepository();
const casesRepo = new CasesRepository();

const PROVINCE = "Buenos Aires";
const LOCALITY = `Dedupe Test ${Date.now()}`;
const createdIds: string[] = [];

afterEach(async () => {
  if (createdIds.length) {
    await db.delete(cases).where(inArray(cases.id, createdIds));
    createdIds.length = 0;
  }
});

async function openStructuredInvestigation(diseaseCode: string, note: string) {
  const row = await casesRepo.openCase({
    kind: "outbreak_investigation",
    primarySubjectKind: "general",
    jurisdictionProvince: PROVINCE,
    jurisdictionLocality: LOCALITY,
    openedReason: { code: "outbreak_investigation_manual", diseaseCode, note },
  });
  createdIds.push(row.id);
  return row;
}

describe("outbreak dedupe finds POST-cutover (structured) rows", () => {
  it("the LIKE query matches a row opened with a structured reason", async () => {
    const opened = await openStructuredInvestigation("rabia", "cluster en zona sur");

    const found = await repo.findOpenInvestigationsForDisease("rabia", PROVINCE, LOCALITY);

    expect(found.map((f) => f.id)).toContain(opened.id);
  });

  it("the structured row really did get both representations", async () => {
    const opened = await openStructuredInvestigation("leptospirosis", "tres casos");
    const [row] = await db.select().from(cases).where(eq(cases.id, opened.id));

    // structured — what R4's GROUP BY reads
    expect(row.openedReasonCode).toBe("outbreak_investigation_manual");
    expect(row.openedReasonParams).toEqual({
      diseaseCode: "leptospirosis",
      note: "tres casos",
    });
    // prose — byte-identical, what the LIKE reads
    expect(row.openedReason).toBe("manual [leptospirosis]: tres casos");
  });

  it("does not match a different disease", async () => {
    await openStructuredInvestigation("rabia", "cluster");

    const found = await repo.findOpenInvestigationsForDisease("moquillo", PROVINCE, LOCALITY);

    expect(found).toHaveLength(0);
  });
});

describe("outbreak dedupe finds BOTH cohorts with one query", () => {
  it("matches a pre-cutover (prose, null code) and a post-cutover row together", async () => {
    // Pre-cutover row: prose only, exactly as rows written before this change.
    const [legacy] = await db
      .insert(cases)
      .values({
        publicCode: `INV-LEG-${Date.now()}`,
        caseKind: "outbreak_investigation",
        primarySubjectKind: "general",
        jurisdictionProvince: PROVINCE,
        jurisdictionLocality: LOCALITY,
        openedReason: "manual [rabia]: investigación anterior",
        status: "open",
      })
      .returning();
    createdIds.push(legacy.id);

    const structured = await openStructuredInvestigation("rabia", "investigación nueva");

    const found = await repo.findOpenInvestigationsForDisease("rabia", PROVINCE, LOCALITY);
    const ids = found.map((f) => f.id);

    // The mixed-cohort property: ONE query, no OR over `code is null`, because
    // ADR-1 keeps the prose identical across the cutover.
    expect(ids).toContain(legacy.id);
    expect(ids).toContain(structured.id);
  });
});

describe("the app-side dedupe guard also still fires", () => {
  it("openedReason.startsWith('manual [code]:') holds for a structured row", async () => {
    // outbreak-investigation.ts:168 re-checks the prefix in JS after the query.
    // A second prose reader the design did not enumerate — same contract.
    const opened = await openStructuredInvestigation("rabia", "cluster");
    const [row] = await db.select().from(cases).where(eq(cases.id, opened.id));

    expect(row.openedReason?.startsWith("manual [rabia]:")).toBe(true);
  });
});
