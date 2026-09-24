// Fitness test — V1-8 performance indexes presence guard.
//
// PURPOSE:
//   The national-scale performance audit (V1-8) added / confirmed a set of
//   foreign-key and filter indexes on the hottest tables (pet_events,
//   notifications, welfare_reports, custody_disputes, custody_dispute_parties).
//   These indexes are the difference between an index scan and a full table
//   scan on the biggest tables in the system. This test asserts they actually
//   exist in the live schema, so a botched migration / missing apply is caught
//   in CI rather than as a production slowdown.
//
// WHAT THIS TEST DOES:
//   Queries pg_indexes for each expected index name on each expected table and
//   asserts presence. It does NOT assert the exact index definition (column
//   order, partial predicate) — name presence is the stable contract; the
//   precise shape is owned by db/schema.ts + the migration files.
//
// HOW TO MAINTAIN:
//   If an index here is renamed or dropped, update EXPECTED_INDEXES. Adding a
//   new perf-critical index? Add its name here so the guard covers it.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

// table → index names that MUST exist. Names match db/schema.ts and the
// migrations that created them (0025, 0033, 0035, 0090, 0110).
const EXPECTED_INDEXES: Record<string, string[]> = {
  pet_events: [
    // Genuinely new in migration 0090 (V1-8).
    "pet_events_recorded_by_user_id_idx",
    "pet_events_author_organization_id_idx",
    // Shipped earlier (0033), now mirrored in schema.ts.
    "pet_events_case_id_idx",
  ],
  notifications: [
    // Shipped earlier (0033), now mirrored in schema.ts.
    "notifications_related_case_id_idx",
  ],
  welfare_reports: [
    // Shipped earlier (0033 / 0035), now mirrored in schema.ts.
    "welfare_reports_case_id_idx",
    "welfare_reports_org_reporter_idx",
  ],
  custody_disputes: [
    // Genuinely new in migration 0090 (V1-8).
    "custody_disputes_pet_status_idx",
    // Shipped earlier (0025), now mirrored in schema.ts.
    "custody_disputes_pet_idx",
    "custody_disputes_juris_open_idx",
    "custody_disputes_one_open_per_pet",
  ],
  custody_dispute_parties: [
    // Shipped earlier (0025), now mirrored in schema.ts.
    "custody_dispute_parties_dispute_idx",
    "custody_dispute_parties_user_idx",
    "custody_dispute_parties_org_idx",
  ],
  // WS-PERF P1: leading performed_at index for the default /admin/auditoria sort.
  audit_log: ["audit_log_performed_at_idx"],
};

describe("V1-8 perf indexes — presence in live schema", () => {
  it("every expected index exists in pg_indexes", async () => {
    const rows = (await db.execute(sql`
      SELECT tablename, indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
    `)) as unknown as Array<{ tablename: string; indexname: string }>;

    const present = new Set(rows.map((r) => `${r.tablename}.${r.indexname}`));

    const missing: string[] = [];
    for (const [table, indexes] of Object.entries(EXPECTED_INDEXES)) {
      for (const idx of indexes) {
        if (!present.has(`${table}.${idx}`)) {
          missing.push(`${table}.${idx}`);
        }
      }
    }

    expect(
      missing,
      `Missing performance index(es) — apply migration 0090 (and confirm 0025/0033/0035 ran):\n${missing.join(
        "\n",
      )}`,
    ).toEqual([]);
  });

  it("the three genuinely-new indexes are valid (not INVALID after a failed CONCURRENTLY build)", async () => {
    const rows = (await db.execute(sql`
      SELECT c.relname AS indexname, i.indisvalid AS isvalid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN (
        'pet_events_recorded_by_user_id_idx',
        'pet_events_author_organization_id_idx',
        'custody_disputes_pet_status_idx'
      )
    `)) as unknown as Array<{ indexname: string; isvalid: boolean }>;

    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.isvalid, `${r.indexname} is INVALID — drop and rebuild CONCURRENTLY`).toBe(true);
    }
  });
});
