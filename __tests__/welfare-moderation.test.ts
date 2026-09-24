// Integration tests for the moderation heuristics. The duplicate-within-24h
// check hits the DB so we keep this as a real integration test instead of
// trying to mock around Drizzle.

import { afterEach, describe, expect, it } from "vitest";

import { db, welfareReports } from "@/db";
import { computeFlagReasons } from "@/lib/infra/welfare-moderation";
import { eq } from "drizzle-orm";

async function insertFixtureReport(opts: {
  description: string;
  severity?: "low" | "medium" | "high" | "critical";
  subjectKind?: "registered_pet" | "unowned_animal" | "location" | "general";
  reporterUserId?: string | null;
}) {
  const referenceCode = `DEN-TEST-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const [row] = await db
    .insert(welfareReports)
    .values({
      referenceCode,
      reporterUserId: opts.reporterUserId ?? null,
      kind: "neglect",
      severity: opts.severity ?? "medium",
      description: opts.description,
      subjectKind: opts.subjectKind ?? "general",
    })
    .returning();
  return row;
}

describe("computeFlagReasons", () => {
  const insertedIds: string[] = [];

  afterEach(async () => {
    for (const id of insertedIds) {
      await db.delete(welfareReports).where(eq(welfareReports.id, id));
    }
    insertedIds.length = 0;
  });

  it("flags trivial_description when description is shorter than 30 chars", async () => {
    const row = await insertFixtureReport({ description: "Hay un perro mal" });
    insertedIds.push(row.id);

    const reasons = await computeFlagReasons({
      reportId: row.id,
      description: row.description,
      severity: row.severity,
      subjectKind: row.subjectKind,
      attachmentCount: 0,
    });
    expect(reasons).toContain("trivial_description");
  });

  it("flags trivial_description on all-caps shouting", async () => {
    const row = await insertFixtureReport({
      description: "ESTO ES UNA DENUNCIA URGENTE ATIENDAN POR FAVOR",
    });
    insertedIds.push(row.id);

    const reasons = await computeFlagReasons({
      reportId: row.id,
      description: row.description,
      severity: row.severity,
      subjectKind: row.subjectKind,
      attachmentCount: 0,
    });
    expect(reasons).toContain("trivial_description");
  });

  it("flags critical_without_evidence when critical + general + no attachments", async () => {
    const row = await insertFixtureReport({
      description:
        "Hay un caso muy grave que vi pasar en mi barrio pero no tengo más datos para sumar acá.",
      severity: "critical",
      subjectKind: "general",
    });
    insertedIds.push(row.id);

    const reasons = await computeFlagReasons({
      reportId: row.id,
      description: row.description,
      severity: row.severity,
      subjectKind: row.subjectKind,
      attachmentCount: 0,
    });
    expect(reasons).toContain("critical_without_evidence");
  });

  it("does NOT flag critical_without_evidence when attachments exist", async () => {
    const row = await insertFixtureReport({
      description:
        "Hay un caso muy grave que vi pasar en mi barrio pero no tengo más datos para sumar acá.",
      severity: "critical",
      subjectKind: "general",
    });
    insertedIds.push(row.id);

    const reasons = await computeFlagReasons({
      reportId: row.id,
      description: row.description,
      severity: row.severity,
      subjectKind: row.subjectKind,
      attachmentCount: 2,
    });
    expect(reasons).not.toContain("critical_without_evidence");
  });

  it("flags duplicate_within_24h when another anonymous row has the same description", async () => {
    const longDescription =
      "Vi un perro encadenado en el patio sin agua ni sombra durante todo el día de hoy.";
    const original = await insertFixtureReport({ description: longDescription });
    insertedIds.push(original.id);
    const duplicate = await insertFixtureReport({ description: longDescription });
    insertedIds.push(duplicate.id);

    const reasons = await computeFlagReasons({
      reportId: duplicate.id,
      description: duplicate.description,
      severity: duplicate.severity,
      subjectKind: duplicate.subjectKind,
      attachmentCount: 0,
    });
    expect(reasons).toContain("duplicate_within_24h");
  });

  it("does NOT flag duplicate when only itself exists", async () => {
    const longDescription =
      "Vi un gato sin atención médica en un balcón hace varios días, parece estar débil.";
    const row = await insertFixtureReport({ description: longDescription });
    insertedIds.push(row.id);

    const reasons = await computeFlagReasons({
      reportId: row.id,
      description: row.description,
      severity: row.severity,
      subjectKind: row.subjectKind,
      attachmentCount: 0,
    });
    expect(reasons).not.toContain("duplicate_within_24h");
  });

  it("returns empty array for well-formed legitimate report", async () => {
    const row = await insertFixtureReport({
      description:
        "Vi un perro callejero con una pata herida en la esquina de Av. Corrientes y Callao, parece haber sido atropellado hace poco.",
      severity: "medium",
      subjectKind: "unowned_animal",
    });
    insertedIds.push(row.id);

    const reasons = await computeFlagReasons({
      reportId: row.id,
      description: row.description,
      severity: row.severity,
      subjectKind: row.subjectKind,
      attachmentCount: 1,
    });
    expect(reasons).toEqual([]);
  });
});
