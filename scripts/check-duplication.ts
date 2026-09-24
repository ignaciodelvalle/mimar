// Duplicate-code ceiling — CI guard (copy-paste burn-down), backed by jscpd.
//
// WHY THIS EXISTS
// ----------------
// Copy-pasted blocks are how "same label, two truths" bugs are born: one copy
// gets the fix, its clones keep the bug. jscpd measures exact-clone density
// across app/, components/, lib/, src/ (tests/fixtures excluded — a test that
// repeats an arrange block is fine).
//
// BASELINE (2026-07-18, jscpd 5.0.12, minTokens 50):
//   total 6.35% duplicated lines (17,370 / 273,676) — css 1.03%, tsx 5.89%,
//   typescript 6.95%. THRESHOLD is 7% — ~0.65pp (≈1,800 lines) of headroom
//   over the measured state. Lower the threshold as duplication burns down;
//   never raise it without PO sign-off. Config: jscpd.json (repo root).
//   Full run measured ~1.3s — cheap enough for the verify chain.
//
// FAIL-CLOSED: a missing jscpd binary, a failed run without a report, or a
// report showing zero scanned sources all FAIL — never a vacuous pass.
//
// Run: pnpm tsx scripts/check-duplication.ts   (or: pnpm lint:dupes)
// Exits 0 when at/under threshold; exits 1 with the measured density.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Anchor to the repo root (this file lives at <root>/scripts/).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Max % of duplicated lines (total across formats). See baseline note above. */
const THRESHOLD_PERCENT = 7;

type JscpdReport = {
  statistics: {
    total: {
      sources: number;
      lines: number;
      duplicatedLines: number;
      percentage: number;
      clones: number;
    };
    formats: Record<string, { lines: number; duplicatedLines: number; percentage: number }>;
  };
};

function runJscpd(outputDir: string): { status: number | null; stderr: string } {
  // Resolve jscpd's bin through the module graph (pnpm's store layout means
  // node_modules/jscpd is a symlink — never hardcode the physical path).
  let bin: string;
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("jscpd/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: Record<string, string> };
    bin = resolve(dirname(pkgPath), pkg.bin.jscpd);
  } catch {
    // FAIL CLOSED: no binary means nothing was scanned.
    console.error("✗ check-duplication: jscpd is not installed. Run pnpm install.");
    process.exit(1);
  }
  if (!existsSync(bin)) {
    console.error(`✗ check-duplication: jscpd bin missing at ${bin}. Run pnpm install.`);
    process.exit(1);
  }
  const result = spawnSync(
    process.execPath,
    [bin, "--config", resolve(ROOT, "jscpd.json"), "--output", outputDir],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return { status: result.status, stderr: result.stderr ?? "" };
}

function runChecks(): void {
  const outputDir = mkdtempSync(join(tmpdir(), "jscpd-"));
  try {
    const { status, stderr } = runJscpd(outputDir);
    const reportPath = join(outputDir, "jscpd-report.json");

    if (!existsSync(reportPath)) {
      // FAIL CLOSED: no report, no verdict.
      console.error(
        `✗ check-duplication: jscpd produced no report (exit ${status}).\n${stderr.trim()}`,
      );
      process.exit(1);
    }

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as JscpdReport;
    const total = report.statistics.total;

    if (total.sources === 0 || total.lines === 0) {
      // FAIL CLOSED: an empty scan must never read as "no duplication".
      console.error("✗ check-duplication: jscpd scanned 0 sources — check jscpd.json paths.");
      process.exit(1);
    }

    const pct = total.percentage;
    const perFormat = Object.entries(report.statistics.formats)
      .map(([fmt, s]) => `${fmt} ${s.percentage.toFixed(2)}%`)
      .join(", ");

    if (pct > THRESHOLD_PERCENT) {
      console.error(
        `✗ duplicated-line density ${pct.toFixed(2)}% (${total.duplicatedLines}/${total.lines} lines, ${total.clones} clones) exceeds the ${THRESHOLD_PERCENT}% ceiling [${perFormat}]. Extract the shared block instead of pasting it — see the clone list via: pnpm exec jscpd --config jscpd.json --reporters consoleFull`,
      );
      process.exit(1);
    }

    console.log(
      `✓ duplication under ceiling — ${pct.toFixed(2)}% duplicated lines (limit ${THRESHOLD_PERCENT}%; ${total.clones} clones across ${total.sources} files) [${perFormat}].`,
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-duplication.ts") ||
    process.argv[1].endsWith("check-duplication.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runChecks();
}
