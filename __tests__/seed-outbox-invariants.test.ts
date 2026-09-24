// Seed-side fence: a seed may only fabricate outbox states production can
// produce.
//
// THE DEFECT THIS TEST EXISTS TO PREVENT (numbers-that-lie audit 2026-08-01)
// ------------------------------------------------------------------------
// scripts/seed-panorama.ts inserted event_notification_outbox rows with
// `status: "delivered"` and no `attempts`, so the column kept its schema
// default of 0. The real drainer (app/api/cron/drain-outbox/route.ts) only
// ever marks a row delivered together with `attempts: row.attempts + 1` —
// delivered-with-zero-attempts is a state the production pipeline CANNOT
// produce. On /admin/outbox and /gob/outbox it rendered as "ENTREGADO" next
// to "Sin intentos", which reads as either a data-integrity bug or a lie.
//
// The rule is mechanical: any seed insert into eventNotificationOutbox whose
// values include a "delivered" status must also set `attempts`. (Production
// enqueue — lib/events/event-outbox-enqueue.ts — only creates pending rows
// and is out of scope here; this polices scripts/ only, same territory as
// seed-case-kinds.test.ts.)

import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");

type InsertBlock = { file: string; line: number; block: string };

/**
 * Collect the source window of every `insert(eventNotificationOutbox)` call
 * in scripts/**. The window runs to the next `db.` statement (or 1500 chars),
 * which comfortably covers the values object without needing a real parser.
 */
function collectOutboxInsertBlocks(): InsertBlock[] {
  const files = globSync("scripts/**/*.ts", { cwd: ROOT });
  const found: InsertBlock[] = [];

  for (const relative of files) {
    const source = readFileSync(resolve(ROOT, relative), "utf8");
    const marker = /\.insert\(eventNotificationOutbox\)/g;
    for (const match of source.matchAll(marker)) {
      const start = match.index ?? 0;
      const rest = source.slice(start + match[0].length);
      const nextStmt = rest.indexOf("await db.");
      const window = rest.slice(0, nextStmt === -1 ? 1500 : Math.min(nextStmt, 1500));
      const line = source.slice(0, start).split("\n").length;
      found.push({ file: relative, line, block: window });
    }
  }

  return found;
}

describe("seed outbox rows — delivered implies at least one recorded attempt", () => {
  const blocks = collectOutboxInsertBlocks();

  it("finds outbox inserts to check (guards against the scan silently rotting)", () => {
    // If a refactor renames the table binding or moves the seed, this fence
    // would pass vacuously forever. Pin that it still sees the insert it is
    // meant to police.
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.file.includes("seed-panorama"))).toBe(true);
  });

  it("every insert that fabricates a 'delivered' row also sets attempts", () => {
    const offenders = blocks.filter(
      (b) => b.block.includes('"delivered"') && !/\battempts:/.test(b.block),
    );

    expect(
      offenders.map((o) => `${o.file}:${o.line}`),
      "A seed fabricated status='delivered' without attempts. The drainer only " +
        "delivers with attempts = row.attempts + 1, so delivered-with-0-attempts " +
        "is a state production cannot produce; the outbox tables render it as " +
        "'ENTREGADO / Sin intentos'. Set attempts >= 1 on the delivered branch.",
    ).toEqual([]);
  });
});
