// Lint guard for timezone-safe date formatting.
//
// Closes the F2 bug class (comprobantes review 2026-07-10): a bare
// `toLocaleDateString`/`toLocaleString`/`new Intl.DateTimeFormat` with NO
// `timeZone` option renders on the server in UTC, so a late-evening ART
// timestamp (UTC-3) displays as the NEXT calendar day. All product date
// formatting MUST pin `America/Argentina/Buenos_Aires` — in practice by going
// through the canonical helpers in lib/utils/format.ts (formatDate,
// formatDateTime, …), which already set `timeZone: AR_TIME_ZONE`.
//
// This guard FAILS on any of these calls that lacks a `timeZone` option,
// OUTSIDE the canonical formatter module (CANONICAL_MODULE below).
//
// SECOND ARM (copy audit 2026-08-04, S1): it also fails a call that HAS
// timeZone but requests `hour` without `hourCycle`/`hour12` — es-AR's Intl
// default hour cycle is 12-hour with a "p. m." suffix, so a timezone-safe
// call can still render the hybrid "05:39 p. m." that no es-AR reader
// writes. Same ratchet, same baseline file, tagged by `reason`.
//
// RATCHET baseline (scripts/timezone-dates-baseline.json):
//   - Existing bare calls in baselined files are grandfathered (pass today).
//   - Any NEW bare call (new file, or a count above the file's baseline) FAILS.
//   - To clear debt: route the call through lib/utils/format.ts (or add an
//     explicit `timeZone`), then lower the baseline (node/tsx --write below).
//
// Note on `toLocaleString`: it is also used for NUMBER formatting (thousands
// separators), which legitimately has no `timeZone`. Those calls are captured
// in the baseline; the guard's job is only to prevent NEW bare calls, at which
// point the author routes dates through format.ts and numbers keep their
// baseline slot (or use `Intl.NumberFormat`).
//
// Run:    pnpm tsx scripts/check-timezone-dates.ts
// Or:     pnpm lint:timezone
// Rewrite baseline: pnpm tsx scripts/check-timezone-dates.ts --write

import { globSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// File set
// ---------------------------------------------------------------------------

// The canonical formatter module — the ONE place raw Intl date APIs are allowed
// (it pins timeZone: AR_TIME_ZONE for everyone else). Excluded from the scan.
const CANONICAL_MODULE = "lib/utils/format.ts";

const EXCLUDE = [
  "node_modules/",
  CANONICAL_MODULE,
  ".test.ts",
  ".test.tsx",
  ".spec.ts",
  ".spec.tsx",
  "/__tests__/",
  "/e2e/",
];

const FILES = globSync("{app,components,lib,packages,src}/**/*.{ts,tsx}").filter((f) => {
  const p = f.replaceAll("\\", "/");
  return !EXCLUDE.some((frag) => p.includes(frag) || p.endsWith(frag));
});

// ---------------------------------------------------------------------------
// Detection
//
// Each regex captures the full call up to its first closing paren. Date
// formatting option objects never contain parens, so `[^)]*` reliably spans a
// multi-line options object. A match is a VIOLATION when its text does not
// mention `timeZone`.
// ---------------------------------------------------------------------------

const CALL_PATTERNS: RegExp[] = [
  /\.toLocaleDateString\s*\([^)]*\)/gs,
  /\.toLocaleTimeString\s*\([^)]*\)/gs,
  // Bare `.toLocaleString(` is OVERWHELMINGLY Number formatting (thousands
  // separators — timeZone is meaningless there) and only dangerous on a Date
  // receiver. A regex can't type the receiver, so we flag it ONLY when the
  // receiver expression smells like a date: a name containing date/time/
  // watermark/asOf, an `…At`-suffixed field (occurredAt, createdAt…), or a
  // direct `new Date(...)`/`Date` receiver. Plain numeric formatting
  // (`count.toLocaleString("es-AR")`) stays un-flagged — the first guard
  // version tripped on 12 legend/popup number sites (all false positives).
  /(?:new\s+Date\s*\([^)]*\)|\b(?:[A-Za-z_$][\w$]*(?:date|time|watermark|asof)[\w$]*|[A-Za-z_$][\w$]*At))\s*\.toLocaleString\s*\([^)]*\)/gis,
  /\bnew\s+Intl\.DateTimeFormat\s*\([^)]*\)/gs,
  // SEMANTIC arm (2026-08-04) — the receiver-name heuristic above has a hole
  // shaped like a variable name, and it cost a real defect.
  //
  // `components/panorama/panorama-informe.ts` formatted the generation stamp of
  // a PRINTED GOVERNMENT REPORT with `now.toLocaleString("es-AR", {...})`. The
  // receiver is `now` — no "date", no "time", no `…At` suffix — so no pattern
  // above matched, the fence stayed green with an EMPTY baseline, and the
  // document went to paper stamped in the server's UTC clock, three hours off.
  //
  // Names are a weak signal; the OPTIONS OBJECT is a strong one. Nobody asks
  // for `day`/`month`/`year`/`hour`/`minute`/`weekday`/`dateStyle`/`timeStyle`
  // while formatting a number — those keys only mean something on a Date. So
  // this arm flags any `toLocaleString` whose options request calendar or clock
  // fields, whatever the receiver is called. Numeric formatting
  // (`count.toLocaleString("es-AR")`) has no such keys and stays un-flagged,
  // which was the false-positive problem that shaped the heuristic originally.
  /\.toLocaleString\s*\([^)]*\b(?:dateStyle|timeStyle|weekday|year|month|day|hour|minute|second)\s*:[^)]*\)/gs,
];

type Violation = { line: number; col: number; text: string; reason: "timezone" | "hourCycle" };

// hour-cycle arm (copy audit 2026-08-04, S1): es-AR's Intl default hour cycle
// is 12-hour with a "p. m." suffix — a call that requests `hour` without
// `hourCycle`/`hour12` renders the hybrid "05:39 p. m." (a zero-padded
// 12-hour clock WITH a meridiem — neither a real 12-hour nor a real 24-hour
// clock; es-AR never writes this). This is independent of the timeZone
// check above: a call can be perfectly AR-pinned and still leak the hybrid
// clock (that is exactly what happened to two Panorama flagship timestamps).
// `timeStyle` requests a clock exactly like `hour` does — es-AR's short
// timeStyle renders "9:49 p. m." — but the first version of this arm only
// looked for the `hour:` key, so 15 AR-pinned `timeStyle: "short"` call sites
// shipped the hybrid clock with the fence green (Cowork QA v3, 2026-08-06).
const HOUR_RE = /\bhour\s*:|\btimeStyle\s*:/;
const HOUR_CYCLE_RE = /\bhourCycle\s*:|\bhour12\s*:/;

function findViolations(src: string): Violation[] {
  const out: Violation[] = [];
  for (const re of CALL_PATTERNS) {
    for (const m of src.matchAll(re)) {
      const hasTimeZone = m[0].includes("timeZone");
      const requestsHour = HOUR_RE.test(m[0]);
      const hasHourCycle = HOUR_CYCLE_RE.test(m[0]);
      if (hasTimeZone && (!requestsHour || hasHourCycle)) continue;
      const idx = m.index ?? 0;
      const before = src.slice(0, idx);
      const line = before.split(/\r?\n/).length;
      const col = idx - before.lastIndexOf("\n");
      // Collapse to a single line for readable reporting.
      out.push({
        line,
        col,
        text: m[0].replace(/\s+/g, " ").slice(0, 80),
        reason: hasTimeZone ? "hourCycle" : "timezone",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

type BaselineFile = {
  _meta: { totalViolations: number; description: string };
  files: Record<string, number>;
};

const BASELINE_PATH = "scripts/timezone-dates-baseline.json";

function loadBaseline(): Record<string, number> {
  try {
    const req = createRequire(import.meta.url);
    const data = req("./timezone-dates-baseline.json") as BaselineFile;
    return data.files;
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — all bare date calls will fail (no grandfather). Run: pnpm tsx scripts/check-timezone-dates.ts --write`,
    );
    return {};
  }
}

function writeBaseline(): void {
  const files: Record<string, number> = {};
  let total = 0;
  for (const file of FILES) {
    const rel = file.replaceAll("\\", "/");
    const count = findViolations(readFileSync(file, "utf8")).length;
    if (count > 0) {
      files[rel] = count;
      total += count;
    }
  }
  const output: BaselineFile = {
    _meta: {
      totalViolations: total,
      description: `Baseline of (a) bare toLocaleDateString/toLocaleString/Intl.DateTimeFormat calls without a timeZone option, and (b) AR-pinned calls that request "hour" without hourCycle/hour12 (copy audit 2026-08-04, S1 — the es-AR 12-hour default hybrid "05:39 p. m."). Files listed here are grandfathered. New violations (new files or counts above these) fail lint:timezone. Canonical module excluded: ${CANONICAL_MODULE}.`,
    },
    files,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `Baseline written: ${total} grandfathered bare date call(s) across ${Object.keys(files).length} files.`,
  );
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

function runChecks(): void {
  const baseline = loadBaseline();
  let hits = 0;
  let grandfathered = 0;

  for (const file of FILES) {
    const rel = file.replaceAll("\\", "/");
    const violations = findViolations(readFileSync(file, "utf8"));
    const allowed = baseline[rel] ?? 0;
    grandfathered += Math.min(violations.length, allowed);

    if (violations.length > allowed) {
      // Report the calls above the grandfathered count (the newest wins-ish;
      // we surface every site so the author can see all candidates to fix).
      for (const v of violations) {
        const hint =
          v.reason === "hourCycle"
            ? `requests "hour" without hourCycle/hour12 — es-AR's Intl default renders the hybrid "05:39 p. m.". Route through lib/utils/format.ts (formatDateTime) or add { hourCycle: "h23" }.`
            : "bare date call without timeZone. Route through lib/utils/format.ts (formatDate/formatDateTime) or pass { timeZone: AR_TIME_ZONE }.";
        console.error(`${file}:${v.line}:${v.col}: "${v.text}" — ${hint}`);
      }
      console.error(
        `${file}: ratchet — ${violations.length} bare date call(s) (baseline allows ${allowed}).`,
      );
      hits += 1;
    }
  }

  if (hits > 0) {
    console.error(
      `\n✗ ${hits} file(s) exceed the timezone-date baseline. Fix the new call(s) above, or (only to intentionally grandfather) run: pnpm tsx scripts/check-timezone-dates.ts --write`,
    );
    process.exit(1);
  }

  console.log(
    `✓ Timezone-safe dates — no new bare toLocale*/Intl.DateTimeFormat calls across ${FILES.length} files.`,
  );
  console.log(
    `  Ratchet: ${grandfathered} grandfathered bare call(s) across ${Object.keys(baseline).length} files. New ones will fail.`,
  );
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-timezone-dates.ts") ||
    process.argv[1].endsWith("check-timezone-dates.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write")) {
    writeBaseline();
  } else {
    runChecks();
  }
}
