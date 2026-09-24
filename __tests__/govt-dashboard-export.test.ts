// Tests for lib/analytics/govt-dashboard-export.ts — CSV assembly + the
// mandatory audit row shared by the four /gob dashboard "Exportar CSV" routes
// (Wave C, gob-audit-inventory item 2).
//
// buildSectionedCsv is a pure function (no DB). logGobDashboardExport is an
// integration smoke test — it pins the writer's contract (one
// gob_dashboard_export_generated row per export, carrying `dashboard` +
// `row_counts` in the payload) so a future refactor of the four export
// routes can't silently drop the audit trail.

import { desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLog, db, profiles } from "@/db";
import { buildSectionedCsv, logGobDashboardExport } from "@/lib/analytics/govt-dashboard-export";

describe("buildSectionedCsv", () => {
  it("renders a single section with a title comment + header + rows", () => {
    const csv = buildSectionedCsv([{ title: "resumen", rows: [{ total: 10, activas: 8 }] }]);
    expect(csv).toContain("# resumen\r\n");
    expect(csv).toContain("total,activas\r\n10,8");
  });

  it("joins multiple sections with a blank line between them", () => {
    const csv = buildSectionedCsv([
      { title: "resumen", rows: [{ total: 10 }] },
      { title: "por_provincia", rows: [{ provincia: "Buenos Aires", total: 5 }] },
    ]);
    expect(csv).toContain("# resumen\r\ntotal\r\n10");
    expect(csv).toContain("# por_provincia\r\nprovincia,total\r\nBuenos Aires,5");
    // Sections are separated by a blank line (\r\n\r\n between blocks).
    expect(csv.indexOf("# por_provincia")).toBeGreaterThan(csv.indexOf("# resumen"));
  });

  it("omits sections with zero rows", () => {
    const csv = buildSectionedCsv([
      { title: "resumen", rows: [{ total: 10 }] },
      { title: "vacia", rows: [] },
    ]);
    expect(csv).not.toContain("# vacia");
  });

  it("prefixes the whole document with a UTF-8 BOM for Excel compatibility", () => {
    const csv = buildSectionedCsv([{ title: "resumen", rows: [{ total: 1 }] }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("returns just the BOM (no sections) when every section is empty", () => {
    const csv = buildSectionedCsv([{ title: "vacia", rows: [] }]);
    expect(csv).toBe("﻿\r\n");
  });
});

describe("logGobDashboardExport (export smoke)", () => {
  // A fresh random actor per run guarantees isolation WITHOUT teardown:
  // audit_log is append-only (enforce_audit_log_append_only, no override hatch —
  // an audit trail you can DELETE is worthless), so neither the audit rows nor
  // the profile that owns them can be torn down. The random UUID means the
  // leftover rows never collide with another run's assertions.
  const testActorId = crypto.randomUUID();

  it("writes exactly one gob_dashboard_export_generated row with dashboard + row_counts", async () => {
    await db
      .insert(profiles)
      .values({ id: testActorId, displayName: "govt-dashboard-export smoke", role: "govt" });

    await logGobDashboardExport(testActorId, "poblacion", {
      resumen: 1,
      cobertura_por_provincia: 4,
    });

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorUserId, testActorId))
      .orderBy(desc(auditLog.performedAt));

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("gob_dashboard_export_generated");
    expect(rows[0].payload).toEqual({
      dashboard: "poblacion",
      row_counts: { resumen: 1, cobertura_por_provincia: 4 },
    });
  });
});
