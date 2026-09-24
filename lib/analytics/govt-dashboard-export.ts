// Shared CSV assembly + audit logging for the "Exportar CSV" buttons on the
// four /gob analytics dashboards (poblacion, censo, adopciones, campanas).
//
// Pattern choice: these dashboards export small AGGREGATE tables (by-province
// breakdowns, KPI summaries, per-offering rows) — not raw PII pet lists — so
// they follow /gob/outreach/export's model (direct synchronous CSV download,
// GET route) rather than /gob/analytics/export's model (Storage upload +
// signed URL + email, built for large multi-slice raw-row exports). Reuses
// rowsToCsv from lib/analytics/govt-exports.ts instead of re-implementing
// CSV escaping a third time.

import { auditLog, db } from "@/db";
import { rowsToCsv } from "@/lib/analytics/govt-exports";

export type CsvSection = {
  /** Spanish label rendered as a `# comment` line above the section's table. */
  title: string;
  rows: Record<string, unknown>[];
};

/**
 * Joins one or more labeled row-sets into a single CSV document (UTF-8 BOM
 * for Excel compatibility, CRLF line endings per RFC 4180 — same convention
 * as /gob/outreach/export). Sections with zero rows are omitted.
 */
export function buildSectionedCsv(sections: CsvSection[]): string {
  const blocks = sections
    .filter((s) => s.rows.length > 0)
    .map((s) => `# ${s.title}\r\n${rowsToCsv(s.rows)}`);
  return `﻿${blocks.join("\r\n\r\n")}\r\n`;
}

export type GobDashboardKind = "poblacion" | "censo" | "adopciones" | "campanas";

/**
 * Mandatory audit row for a /gob dashboard CSV export — one row per download,
 * fire-and-forget (callers `await` it before responding so the row lands
 * before the request completes, but do not need to block the CSV write).
 */
export async function logGobDashboardExport(
  actorUserId: string,
  dashboard: GobDashboardKind,
  rowCounts: Record<string, number>,
): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId,
    action: "gob_dashboard_export_generated",
    payload: { dashboard, row_counts: rowCounts },
  });
}

/** Standard CSV download response headers — no-store (PII-adjacent aggregate data). */
export function csvDownloadResponse(content: string, filename: string): Response {
  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
