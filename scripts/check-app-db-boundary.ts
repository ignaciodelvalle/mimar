// `app/` → database boundary fence — canon decision B02 (PO 2026-09-02).
//
// WHAT WAS DECIDED
// ---------------------------------------------------------------------------
// The 2026-09 audit asked the one architectural question the repo had never
// answered: may `app/` issue Drizzle queries directly, or must every database
// access go through `src/modules`? The PO answered on 2026-09-02
// (dim-interno:docs/reviews/2026-09-fresh/BACKLOG.md § "B02 — the `app/` → `db` boundary"):
//
//   * WRITES go ONLY through `src/modules` use cases. Hard rule, fenced.
//   * Page-level READS from `app/` through Drizzle are TOLERATED, under a
//     shrink-only baseline. Banning reads outright is a rewrite nobody asked
//     for and would stall the pilot; banning WRITES outside the module layer is
//     where the integrity invariants actually live — invariant #2 (the
//     append-only spine) and invariant #3 (caches declare themselves).
//
// So this fence is deliberately asymmetric, and says so: the WRITE set is
// frozen file by file and may only shrink, while the READ set is counted,
// printed, and allowed. `scripts/check-dependency-direction.ts` polices only
// `src/modules/<A>` → `<B>` edges and has never had anything to say about
// `app/`; this is the fence that covers that gap.
//
// WHAT FAILS
// ---------------------------------------------------------------------------
//   (A) NEW WRITER — an `app/**` file that writes to the database and is not in
//       the baseline. Move the write into a `src/modules/<domain>` use case and
//       call it from `actions.ts`. There is no "add it to the baseline" fix for
//       a new writer: the baseline is grandfathered debt, not an allowlist.
//   (B) STALE BASELINE — a baselined writer that no longer exists, or no longer
//       writes. Remove it from the baseline. This is the half that makes the
//       ratchet tighten: a debt list that keeps naming paid debt stops being
//       readable as a burn-down.
//   (C) WRITER DRIFT — a baselined writer whose write surface CHANGED (a new
//       idiom, or a new table). Grandfathered debt may shrink or stay flat; it
//       may not accrete. Regenerating is one command with a reviewable diff, so
//       the drift is a decision someone makes on purpose rather than a table
//       that silently stops describing the file.
//   (D) SPINE DRIFT — the number of `app/**` files inserting directly into
//       `petEvents` is pinned EXACTLY at `_meta.spineWriters`. Rule (A) already
//       fails a brand-new file that does it; this pin is what fails an ALREADY
//       BASELINED writer that starts doing it. Invariant #2 is the reason the
//       write half of this decision exists at all, so it gets its own number.
//   (E) EMPTY CORPUS — zero `app/**` source files, or zero of them touching the
//       database. A fence whose glob stopped matching reports success forever;
//       an empty scan is a broken scan, not a clean tree.
//
// WHAT IS ONLY REPORTED
// ---------------------------------------------------------------------------
// The READ-class count, against `_meta.readers`. The decision calls it "a
// tablero number, and the direction of travel is that reads migrate into query
// modules over time" — so it is printed with its delta and never fails. It is
// NOT a floor and NOT a ceiling: it is a snapshot regenerated with the baseline.
//
// Baseline: scripts/app-db-boundary-baseline.json — regenerate with
//   pnpm tsx scripts/check-app-db-boundary.ts --write-baseline
//
// Run: pnpm tsx scripts/check-app-db-boundary.ts   (or: pnpm lint:app-db-boundary)
// Exits 0 when clean; exits 1 naming every offender and what to do about it.

import { globSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The corpus. `apps/mobile` is a different program and is not matched here. */
export const APP_GLOB = "app/**/*.{ts,tsx}";

export const BASELINE_PATH = "scripts/app-db-boundary-baseline.json";

/**
 * Tables whose direct insertion from `app/` is pinned by count, not merely
 * baselined. `petEvents` is THE append-only spine (invariant #2) and the
 * decision names it explicitly. `caseEvents` is deliberately NOT here: whether
 * it is append-only in the same sense is still an open audit question (lens
 * C01), and a fence may not settle a question by assertion.
 */
export const SPINE_TABLES = ["petEvents"];

/** Test files, by the repo's usual patterns (mirrors scripts/check-file-size.ts). */
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".d.ts"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WriteKind = "insert" | "update" | "delete" | "transaction" | "execute" | "sql";

export type SourceFile = { path: string; content: string };

/** One classified `app/**` file that touches the database. */
export type AppDbFile = {
  path: string;
  /** Sorted, deduped. Empty means READ-class. */
  kinds: WriteKind[];
  /** Drizzle table identifiers written by name, sorted. Best-effort — a write
   *  issued through a helper that receives `tx` names no table here. */
  tables: string[];
  /** Spine tables this file inserts into directly, sorted. */
  spineTables: string[];
};

export type BaselineEntry = { kinds: WriteKind[]; tables: string[] };

export type Baseline = {
  _meta: {
    generatedAt: string;
    description: string;
    /** READ-class count at generation. Reported, never enforced. */
    readers: number;
    /** `app/**` files inserting directly into a SPINE_TABLES table. Pinned exactly. */
    spineWriters: number;
  };
  writers: Record<string, BaselineEntry>;
};

export type BoundaryViolation =
  | { kind: "new-writer"; file: string; found: BaselineEntry }
  | { kind: "stale-baseline"; file: string; reason: "gone" | "no-longer-writes" }
  | { kind: "writer-drift"; file: string; recorded: BaselineEntry; found: BaselineEntry }
  | { kind: "spine-drift"; recorded: number; actual: number; files: string[] }
  | { kind: "empty-corpus"; scanned: number; touching: number };

export type BoundaryReport = {
  violations: BoundaryViolation[];
  writers: AppDbFile[];
  readers: AppDbFile[];
  spineWriters: string[];
  /** `app/**` non-test source files considered. */
  scanned: number;
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Does this file pull in the database at all?
 *
 * Static imports, re-exports and RUNTIME `import()` all count — the point is
 * whether the module can reach Drizzle, not which syntax it used to get there.
 */
export function touchesDb(src: string): boolean {
  return /(?:from|import)\s*\(?\s*["'](?:@\/db(?:\/[^"']*)?|drizzle-orm(?:\/[^"']*)?)["']/.test(
    src,
  );
}

/**
 * Receivers that are the Drizzle client or a Drizzle transaction handle.
 *
 * `db` is what `@/db` exports; `tx` is what every `.transaction(async (tx) =>`
 * callback in `app/` names its handle (all 7 sites, measured 2026-09-02).
 * `trx` is defensive.
 */
const DB_RECEIVER = String.raw`(?:db|tx|trx)`;

/**
 * `insert` and `transaction` are matched receiver-AGNOSTICALLY: they are
 * Drizzle-shaped enough that any occurrence inside a file that already imports
 * the database is a write, and matching them without a receiver is what
 * survives someone renaming the client.
 *
 * `update` and `delete` are NOT: `params.delete(…)` on URLSearchParams and
 * `next.delete(…)` on a Set are both live in this corpus, and a receiver-blind
 * rule would classify three read-only pages as writers. So those two require a
 * database receiver.
 */
const ANY_INSERT = /\.\s*insert\s*\(/;
const ANY_TRANSACTION = /\.\s*transaction\s*\(/;
const DB_UPDATE = new RegExp(String.raw`\b${DB_RECEIVER}\s*\.\s*update\s*\(`);
const DB_DELETE = new RegExp(String.raw`\b${DB_RECEIVER}\s*\.\s*delete\s*\(`);

/** A SQL statement that changes something. Used on `sql` template bodies. */
const MUTATING_SQL =
  /\b(?:insert\s+into|update\s+["\w]|delete\s+from|truncate\b|drop\s+|alter\s+|create\s+|grant\s+|revoke\s+|refresh\s+materialized)/i;

/**
 * Every `<receiver?>.<verb>(<firstArg>` whose verb writes. The receiver is
 * CAPTURED rather than baked in, so the same sweep can name the table and then
 * apply the receiver rule above per verb.
 */
const WRITE_CALL = /(?:\b([\w$]+)\s*)?\.\s*(insert|update|delete)\s*\(\s*([\w$]+(?:\.[\w$]+)*)/g;

const DB_RECEIVERS = new Set(["db", "tx", "trx"]);

const DB_EXECUTE = new RegExp(String.raw`\b${DB_RECEIVER}\s*\.\s*execute\s*\(`, "g");

/** Make an identifier safe to interpolate into a RegExp (`$` is an anchor). */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Is this `db.execute(…)` call site mutating?
 *
 * Three shapes, and the third is the one that matters: an argument this
 * function cannot resolve is treated as MUTATING. Raw SQL nobody can read is
 * exactly what a boundary fence must not wave through, and the conservative
 * direction here costs at worst one baseline entry.
 */
export function executeIsMutating(src: string, afterCall: string): boolean {
  const inline = /^\s*sql`([\s\S]*?)`/.exec(afterCall);
  if (inline) return MUTATING_SQL.test(inline[1]);

  const ident = /^\s*([\w$]+)\s*[),]/.exec(afterCall);
  if (ident) {
    // The backtick is spelled with an escape because the pattern itself is
    // written in a template literal.
    const decl = new RegExp(String.raw`\b${escapeRe(ident[1])}\s*=\s*sql\`([\s\S]*?)\``).exec(src);
    if (decl) return MUTATING_SQL.test(decl[1]);
  }
  return true;
}

/** Classify one file's write surface. An empty `kinds` means READ-class. */
export function classifyFile(file: SourceFile): AppDbFile {
  const src = file.content;
  const kinds = new Set<WriteKind>();
  const tables = new Set<string>();
  const spineTables = new Set<string>();

  if (ANY_INSERT.test(src)) kinds.add("insert");
  if (ANY_TRANSACTION.test(src)) kinds.add("transaction");
  if (DB_UPDATE.test(src)) kinds.add("update");
  if (DB_DELETE.test(src)) kinds.add("delete");

  for (const m of src.matchAll(WRITE_CALL)) {
    const receiver = m[1];
    const verb = m[2] as "insert" | "update" | "delete";
    // The receiver rule, re-applied: the sweep is deliberately loose so it can
    // name tables, and `params.delete(next)` must not become one.
    if (verb !== "insert" && !(receiver !== undefined && DB_RECEIVERS.has(receiver))) continue;
    // `schema.petEvents` and `petEvents` name the same table.
    const table = m[3].split(".").at(-1) as string;
    tables.add(table);
    if (verb === "insert" && SPINE_TABLES.includes(table)) spineTables.add(table);
  }

  for (const m of src.matchAll(DB_EXECUTE)) {
    if (executeIsMutating(src, src.slice((m.index ?? 0) + m[0].length))) kinds.add("execute");
  }

  // A `sql` template that carries a mutating statement is a write however it is
  // later handed to the driver.
  for (const m of src.matchAll(/\bsql`([\s\S]*?)`/g)) {
    if (MUTATING_SQL.test(m[1])) kinds.add("sql");
  }

  return {
    path: file.path,
    kinds: [...kinds].sort(),
    tables: [...tables].sort(),
    spineTables: [...spineTables].sort(),
  };
}

// ---------------------------------------------------------------------------
// Core logic (pure — the unit test feeds it fixtures, the CLI feeds it the tree)
// ---------------------------------------------------------------------------

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Compare the tree against the baseline.
 *
 * `files` is every `app/**` non-test source file, already read. Filtering to
 * the ones that touch the database happens here so the caller cannot
 * accidentally hand in a pre-filtered set and hide the empty-corpus check.
 */
export function checkAppDbBoundary(baseline: Baseline, files: SourceFile[]): BoundaryReport {
  const touching = files.filter((f) => touchesDb(f.content)).map(classifyFile);
  const writers = touching.filter((f) => f.kinds.length > 0).sort((a, b) => cmp(a.path, b.path));
  const readers = touching.filter((f) => f.kinds.length === 0).sort((a, b) => cmp(a.path, b.path));
  const spineWriters = writers.filter((w) => w.spineTables.length > 0).map((w) => w.path);

  const violations: BoundaryViolation[] = [];

  if (files.length === 0 || touching.length === 0) {
    violations.push({ kind: "empty-corpus", scanned: files.length, touching: touching.length });
    return { violations, writers, readers, spineWriters, scanned: files.length };
  }

  const recorded = baseline.writers ?? {};
  const seen = new Map(files.map((f) => [f.path, f]));
  const writerByPath = new Map(writers.map((w) => [w.path, w]));

  for (const w of writers) {
    const entry = recorded[w.path];
    const found: BaselineEntry = { kinds: w.kinds, tables: w.tables };
    if (!entry) {
      violations.push({ kind: "new-writer", file: w.path, found });
      continue;
    }
    if (!sameList(entry.kinds ?? [], w.kinds) || !sameList(entry.tables ?? [], w.tables)) {
      violations.push({ kind: "writer-drift", file: w.path, recorded: entry, found });
    }
  }

  for (const path of Object.keys(recorded).sort(cmp)) {
    if (writerByPath.has(path)) continue;
    violations.push({
      kind: "stale-baseline",
      file: path,
      reason: seen.has(path) ? "no-longer-writes" : "gone",
    });
  }

  const pinned = baseline._meta?.spineWriters;
  if (pinned !== spineWriters.length) {
    violations.push({
      kind: "spine-drift",
      recorded: pinned ?? 0,
      actual: spineWriters.length,
      files: spineWriters,
    });
  }

  return { violations, writers, readers, spineWriters, scanned: files.length };
}

/** Code-unit order, so the JSON diff reads as a diff and not as a reshuffle. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function isTestFile(path: string): boolean {
  return TEST_SUFFIXES.some((s) => path.endsWith(s)) || path.includes("/__tests__/");
}

/** Every `app/**` non-test source file, read from disk, sorted. */
export function collectAppFiles(cwd: string = process.cwd()): SourceFile[] {
  return globSync(APP_GLOB, { cwd })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !isTestFile(f))
    .sort(cmp)
    .map((path) => ({ path, content: readFileSync(resolve(cwd, path), "utf8") }));
}

export function loadBaseline(cwd: string = process.cwd()): Baseline {
  return JSON.parse(readFileSync(resolve(cwd, BASELINE_PATH), "utf8")) as Baseline;
}

function writeBaseline(report: BoundaryReport): void {
  const baseline: Baseline = {
    _meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      description: [
        "Canon B02 (PO 2026-09-02): writes go only through src/modules use cases. ",
        "Every app/** file below already writes to the database directly and is grandfathered ",
        "debt — the list may SHRINK, never grow. A new writer, a stale entry, or a changed ",
        "write surface fails lint:app-db-boundary. `readers` is the tolerated read-path count ",
        "(reported, never enforced); `spineWriters` counts app/** files inserting straight into ",
        `${SPINE_TABLES.join("/")} and is pinned EXACTLY (invariant #2).`,
      ].join(""),
      readers: report.readers.length,
      spineWriters: report.spineWriters.length,
    },
    writers: Object.fromEntries(
      report.writers.map((w) => [w.path, { kinds: w.kinds, tables: w.tables }]),
    ),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `✓ Wrote ${report.writers.length} writer(s) to ${BASELINE_PATH} ` +
      `(${report.readers.length} read-class file(s), ${report.spineWriters.length} spine writer(s)).`,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function describeEntry(e: BaselineEntry): string {
  const tables = e.tables.length ? ` on ${e.tables.join(", ")}` : "";
  return `${e.kinds.join("+")}${tables}`;
}

function report(r: BoundaryReport, baseline: Baseline): void {
  for (const v of r.violations) {
    if (v.kind === "empty-corpus") {
      console.error(
        [
          `✗ ${APP_GLOB} matched ${v.scanned} source file(s), ${v.touching} of them touching`,
          "  the database. Zero on either count is a BROKEN SCAN, not a clean tree — the glob",
          "  or the import detection stopped seeing the corpus this fence exists to police.",
        ].join("\n"),
      );
    } else if (v.kind === "new-writer") {
      console.error(
        [
          `${v.file}: writes to the database from app/ (${describeEntry(v.found)}).`,
          "  Canon B02: writes go ONLY through a src/modules/<domain> use case, called from",
          "  actions.ts. Adding this file to the baseline is NOT the fix — the baseline is",
          "  grandfathered debt from 2026-09-02, not an allowlist.",
        ].join("\n"),
      );
    } else if (v.kind === "stale-baseline") {
      const why = v.reason === "gone" ? "the file no longer exists" : "it no longer writes";
      console.error(
        `${v.file}: baselined as an app/ writer but ${why} — remove it from ` +
          `${BASELINE_PATH}. The ratchet only tightens.`,
      );
    } else if (v.kind === "writer-drift") {
      console.error(
        [
          `${v.file}: grandfathered write surface CHANGED.`,
          `  baseline: ${describeEntry(v.recorded)}`,
          `  now:      ${describeEntry(v.found)}`,
          "  Debt may shrink or stay flat, not accrete. Move the new write into",
          "  src/modules/<domain>, or — if this is deliberate — regenerate with",
          "  `pnpm tsx scripts/check-app-db-boundary.ts --write-baseline` and say why.",
        ].join("\n"),
      );
    } else {
      console.error(
        [
          `✗ spine writers: ${v.actual} app/ file(s) insert straight into ` +
            `${SPINE_TABLES.join("/")}, pinned at ${v.recorded}.`,
          ...v.files.map((f) => `    ${f}`),
          "  Invariant #2: the event spine is append-only and is written by the module layer.",
          "  Lower the number by moving the insert into src/modules; raise it only with a PO",
          "  decision recorded in the commit.",
        ].join("\n"),
      );
    }
  }

  const recordedReaders = baseline._meta?.readers ?? 0;
  const delta = r.readers.length - recordedReaders;
  const trend = delta === 0 ? "flat" : `${delta > 0 ? "+" : ""}${delta} since the baseline`;
  console.log(
    [
      `  read-class app/ files: ${r.readers.length} (${trend}). Tolerated by canon B02 and NOT `,
      "enforced — the direction of travel is that reads migrate into query modules.",
    ].join(""),
  );

  if (r.violations.length > 0) {
    console.error(`\n✗ ${r.violations.length} app/ → db boundary violation(s).`);
    process.exit(1);
  }

  console.log(
    `✓ app/ → db boundary clean — ${r.writers.length} grandfathered writer(s), ` +
      `${r.spineWriters.length} spine writer(s), across ${r.scanned} app/ source files.`,
  );
}

function main(): void {
  const files = collectAppFiles();
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(
      checkAppDbBoundary(
        { _meta: { generatedAt: "", description: "", readers: 0, spineWriters: -1 }, writers: {} },
        files,
      ),
    );
    return;
  }
  const baseline = loadBaseline();
  report(checkAppDbBoundary(baseline, files), baseline);
}

// Only run as a CLI. Importing this module from the unit test must not scan the
// tree or call process.exit.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
