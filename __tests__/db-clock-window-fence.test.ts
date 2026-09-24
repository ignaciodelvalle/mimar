// db-clock-window-fence — no test may window a Postgres-defaulted column
// against a clock read in Node.
//
// THE DEFECT THIS PREVENTS, which has already happened twice and cost a gate
// both times. `CLAUDE.md` records it as the fourth red signature, and the rule
// it extracted is one sentence: **no assertion may compare a clock read on the
// host against a column with `defaultNow()`.**
//
// On 2026-08-30 two `pnpm test:verified` runs over ONE tree answered
// differently — `0 failing`, then `1 failing` — with no worker crash and no
// broken file, so none of the three documented crash signatures applied and
// none of them should have been stretched to cover it. The cause was
// `const since = new Date()` in Node compared against a column defaulted from
// Postgres's `now()` inside a Docker container. When the container clock sits
// behind the host — which a Docker VM does without warning after a resync — a
// row that really exists falls outside `gte(column, since)` and the test fails
// on a tree that is correct. Two tests across three files, failing in OPPOSITE
// directions: one window too narrow to see its own row, two too wide and
// admitting the previous run's.
//
// `__tests__/_helpers/db-now.ts` is the cure and it is already written. What
// was missing is anything that makes the next person use it: on 2026-09-11 only
// TWO files imported it, and nothing at all required them to. The artifact's
// own words for this debt were "el sexto va a fallar igual".
//
// WHY THE RULE IS NOT "BAN `new Date()` IN A COMPARISON", which was the first
// draft and was wrong. Measured against the real tree: that rule flags
// `gt(reminders.dueAt, new Date())` in `pregnancy-flow.test.ts`, and that
// assertion is CORRECT. `dueAt` carries no `.defaultNow()` — it is a future
// date the application computes and writes, days away, where two hundred
// milliseconds of drift changes nothing. A fence that reds a correct assertion
// teaches people to disable fences.
//
// So the rule bans the SUBJECT: a window over a column whose value comes from
// POSTGRES'S clock. The column set is derived from `db/schema.ts` at run time
// rather than hand-listed, so a new `defaultNow()` column is covered the day it
// is declared and nobody has to remember this file exists.
//
// THE HONEST LIMIT OF THIS FENCE, stated so nobody mistakes green for proof:
// it matches on drizzle comparison helpers and on the FIELD NAME, so it cannot
// see a window built in raw `sql` template strings, nor one where the column is
// reached through an alias this file cannot resolve. It catches the shape that
// actually occurred, twice, and not every shape that could.

import { globSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCHEMA = path.join(process.cwd(), "db/schema.ts");

/**
 * Every drizzle field name declared with `.defaultNow()`.
 *
 * Derived, not listed. A hand-kept list would be a second source of truth that
 * silently stops covering the column somebody adds next week — the exact
 * failure mode `dim-interno:docs/reviews` keeps recording for enumerated fences.
 */
function defaultNowFields(): Set<string> {
  const src = readFileSync(SCHEMA, "utf8");
  const names = new Set<string>();
  // `createdAt: timestamp("created_at", {...}).notNull().defaultNow(),`
  const re = /^\s*(\w+)\s*:\s*timestamp\([^)]*\)(?:\.\w+\([^)]*\))*\.defaultNow\(\)/gm;
  for (const m of src.matchAll(re)) names.add(m[1]);
  return names;
}

/** Test files that could hold such a window. */
function testFiles(): string[] {
  return (
    [
      ...globSync("__tests__/**/*.test.ts"),
      ...globSync("__tests__/**/*.test.tsx"),
      ...globSync("src/**/__tests__/**/*.test.ts"),
    ]
      .map((f) => f.replaceAll("\\", "/"))
      // THIS FILE IS EXCLUDED, and not as a convenience. Its synthetic fixtures
      // below are string literals shaped exactly like the defect, because that is
      // the only way to prove the detector detects. Scanning itself made the rule
      // report its own evidence as a violation on the first run.
      .filter((f) => !f.endsWith("__tests__/db-clock-window-fence.test.ts"))
  );
}

/**
 * Identifiers in `src` that hold a clock read taken in NODE.
 *
 * Both spellings that actually appear: `const since = new Date()` and
 * `const since = Date.now()`. A value taken from the database — `await dbNow()`
 * — is deliberately NOT collected: that is the cure, not the defect.
 */
function hostClockIdentifiers(src: string): Set<string> {
  const ids = new Set<string>();
  const re = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:new\s+Date\s*\(\s*\)|Date\.now\s*\(\s*\))/g;
  for (const m of src.matchAll(re)) ids.add(m[1]);
  return ids;
}

/**
 * The comparison shape, as a fresh regex each call.
 *
 * A FRESH one because `/g` regexes carry `lastIndex` across `matchAll` calls,
 * and one shared instance would silently start mid-file on the second use.
 *
 * The right-hand side is an ALTERNATION of the three shapes it can legally be,
 * not a "anything up to the closing paren" wildcard. The first draft used
 * `[^),]+?` and it could not match `new Date()` at all — the `)` inside the
 * call terminated the group early, so the rule quietly missed the single most
 * common spelling of the defect it exists to catch. Its own detector test is
 * what surfaced that, on the first run.
 */
function CMP_RE(): RegExp {
  // Assembled from String.raw parts rather than written as one literal.
  // A backslash in this pattern has been eaten twice on the way into the
  // file by the tooling that wrote it, and a silently-missing `\b` or `\s`
  // does not throw — it just makes the rule match less, which is the one
  // failure mode a fence must never have.
  const helper = String.raw`\b(?:gte|gt|lte|lt)`;
  const column = String.raw`\(\s*[\w.]*\.(\w+)\s*,\s*`;
  const hostClock = String.raw`(new\s+Date\s*\(\s*\)|Date\.now\s*\(\s*\)|\w+)`;
  const tail = String.raw`\s*\)`;
  return new RegExp(helper + column + hostClock + tail, "g");
}

type Violation = { file: string; line: number; text: string };

/**
 * A drizzle range comparison whose LEFT side names a `defaultNow()` column and
 * whose RIGHT side is a host clock.
 *
 * The left side is matched as `<anything>.<field>` because the table alias
 * varies per file and is not the thing under test — the column name is.
 */
function findViolations(fields: Set<string>): Violation[] {
  const found: Violation[] = [];
  const cmp = CMP_RE();

  for (const file of testFiles()) {
    const src = readFileSync(file, "utf8");
    const hostIds = hostClockIdentifiers(src);
    const lines = src.split("\n");

    for (const m of src.matchAll(cmp)) {
      const [, field, rightRaw] = m;
      if (!fields.has(field)) continue;
      const right = rightRaw.trim();
      const isHostClock =
        /^new\s+Date\s*\(\s*\)$/.test(right) ||
        /^Date\.now\s*\(\s*\)$/.test(right) ||
        hostIds.has(right);
      if (!isHostClock) continue;
      const line = src.slice(0, m.index).split("\n").length;
      found.push({ file, line, text: (lines[line - 1] ?? "").trim() });
    }
  }
  return found;
}

describe("db clock windows — Postgres's clock on both sides, or no window at all", () => {
  it("the column set is derived and non-empty", () => {
    // If this floor ever fails, the regex stopped matching db/schema.ts and
    // every rule below is passing because it has nothing to check.
    const fields = defaultNowFields();
    expect(fields.size).toBeGreaterThanOrEqual(15);
    expect(fields.has("createdAt")).toBe(true);
    expect(fields.has("occurredAt")).toBe(true);
    // And the control that keeps the rule honest: a column the application
    // writes with a computed future date is NOT in the set, which is why
    // `gt(reminders.dueAt, new Date())` is correct and must never be flagged.
    expect(fields.has("dueAt")).toBe(false);
  });

  it("finds test files to scan", () => {
    expect(testFiles().length).toBeGreaterThan(200);
  });

  it("no test windows a Postgres-defaulted column against a Node clock", () => {
    const violations = findViolations(defaultNowFields());
    const rendered = violations.map((v) => `${v.file}:${v.line} — ${v.text}`);
    expect(
      rendered,
      [
        "These assertions compare a clock read in Node against a column defaulted from",
        "Postgres's now(). The two clocks are different (Docker), they drift without",
        "warning, and the result is a suite that answers differently over one tree.",
        "",
        "Fix it by taking BOTH sides from the database — `dbNow()` in",
        "__tests__/_helpers/db-now.ts — or, better, by dropping the time window and",
        "keying on something already unique per run (a fresh randomUUID). Never widen",
        "the comparison with a tolerance: a tolerance is a guess about how far two",
        "clocks may drift, and the drift is unbounded.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("the detector really detects — it is not passing because it matches nothing", () => {
    // The rule above is currently expected to be GREEN, which makes it exactly
    // the kind of assertion that can rot into a no-op without anybody noticing.
    // The pending-assertion guard in CLAUDE.md was written the same way — purely
    // defensive, demonstrable only against a synthetic report — and it fired on
    // its own the next day. So the detector is exercised against a synthetic
    // source here rather than trusted.
    const fields = new Set(["createdAt", "occurredAt"]);
    const synthetic = [
      "const since = new Date();",
      "await db.select().from(t).where(gte(t.createdAt, since));",
      "await db.select().from(t).where(gt(t.occurredAt, new Date()));",
      // Must NOT match: not a defaultNow column.
      "await db.select().from(t).where(gt(t.dueAt, new Date()));",
      // Must NOT match: the cure.
      "const from = await dbNow();",
      "await db.select().from(t).where(gte(t.createdAt, from));",
    ].join("\n");

    const hostIds = hostClockIdentifiers(synthetic);
    expect(hostIds.has("since")).toBe(true);
    expect(hostIds.has("from")).toBe(false);

    // The SAME builder the real scan uses. A second copy of the pattern here
    // would let the detector's proof and the detector itself drift apart —
    // which is exactly how a test ends up certifying something the production
    // path does not do.
    const cmp = CMP_RE();
    const hits: string[] = [];
    for (const m of synthetic.matchAll(cmp)) {
      const [, field, rightRaw] = m;
      const right = rightRaw.trim();
      if (!fields.has(field)) continue;
      if (/^new\s+Date\s*\(\s*\)$/.test(right) || hostIds.has(right)) hits.push(field);
    }
    expect(hits.sort()).toEqual(["createdAt", "occurredAt"]);
  });
});
