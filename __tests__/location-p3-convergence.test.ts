// DB-backed tests for the P3 location column convergence — Phase C (drop legacy columns).
//
// Validates:
//   (a) cases canonical-only write — openCase with coordinates writes ONLY
//       location_lat / location_lng (canonical); legacy primary_location_* no longer exists.
//   (b) cases canonical read — getCaseDetailByPublicCode reads location_lat/lng
//       and projects them as primaryLocationLat/primaryLocationLng on the DTO.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db } from "@/db";
import { getCaseDetailByPublicCode } from "@/lib/infra/case-queries";
import { CasesRepository } from "@/src/modules/cases/infrastructure/cases-repository";
import { withMutationOverride } from "./_helpers/db-overrides";

const repo = new CasesRepository();
const insertedCaseIds: string[] = [];

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM cases WHERE public_code LIKE 'CAS-P3L-%'`);
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const id of insertedCaseIds) {
      await tx.execute(sql`DELETE FROM case_events WHERE case_id = ${id}`);
      await tx.execute(sql`DELETE FROM cases WHERE id = ${id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// (a) cases canonical-only write via openCase
// ---------------------------------------------------------------------------

describe("cases canonical write (openCase) — Phase C", () => {
  it("writes location_lat/lng from locationLat/locationLng input (canonical-only)", async () => {
    const row = await repo.openCase({
      kind: "bite_incident",
      primarySubjectKind: "location",
      locationLat: "-34.6083000",
      locationLng: "-58.3712000",
      openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });
    insertedCaseIds.push(row.id);

    // Canonical columns must be set from the input
    expect(row.locationLat).toBe("-34.6083000");
    expect(row.locationLng).toBe("-58.3712000");

    // Re-select to confirm persistence
    const [reloaded] = await db.select().from(cases).where(eq(cases.id, row.id)).limit(1);
    expect(reloaded.locationLat).toBe("-34.6083000");
    expect(reloaded.locationLng).toBe("-58.3712000");
  });

  it("writes null to canonical columns when no coordinates are provided", async () => {
    const row = await repo.openCase({
      kind: "welfare_denuncia",
      primarySubjectKind: "unowned_animal",
      openedReason: {
        code: "welfare_report_citizen",
        referenceCode: "DEN-P3-0001",
        kind: "neglect",
        severity: "medium",
      },
    });
    insertedCaseIds.push(row.id);

    expect(row.locationLat).toBeNull();
    expect(row.locationLng).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (b) cases canonical read via getCaseDetailByPublicCode
// ---------------------------------------------------------------------------

describe("cases canonical read (getCaseDetailByPublicCode) — Phase C", () => {
  it("projects coordinates from canonical location_lat/lng columns", async () => {
    const [raw] = await db
      .insert(cases)
      .values({
        publicCode: "CAS-P3L-NEW1",
        caseKind: "bite_incident",
        status: "open",
        primarySubjectKind: "location",
        locationLat: "-34.6000000",
        locationLng: "-58.2000000",
        openedReason: "P3 Phase C canonical-read test -- canonical columns sourced directly",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      })
      .returning();
    insertedCaseIds.push(raw.id);

    const detail = await getCaseDetailByPublicCode("CAS-P3L-NEW1");
    expect(detail).not.toBeNull();
    expect(detail?.primaryLocationLat).toBe("-34.6000000");
    expect(detail?.primaryLocationLng).toBe("-58.2000000");
  });

  it("projects null when canonical columns are null", async () => {
    const [raw] = await db
      .insert(cases)
      .values({
        publicCode: "CAS-P3L-NUL1",
        caseKind: "welfare_denuncia",
        status: "open",
        primarySubjectKind: "unowned_animal",
        openedReason: "P3 Phase C canonical-read test -- no coordinates",
      })
      .returning();
    insertedCaseIds.push(raw.id);

    const detail = await getCaseDetailByPublicCode("CAS-P3L-NUL1");
    expect(detail).not.toBeNull();
    expect(detail?.primaryLocationLat).toBeNull();
    expect(detail?.primaryLocationLng).toBeNull();
  });
});
