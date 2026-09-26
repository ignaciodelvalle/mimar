// Merge-conflict marker fence.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// A conflict resolved in a hurry can leave its markers behind in a file no
// compiler reads: a Markdown doc, a SQL migration comment, a JSON fixture that
// is only parsed by a test that happens to be skipped, a YAML workflow that
// only runs on a schedule. Biome and tsc see TypeScript; nothing else in
// `pnpm verify` looked at the rest of the tree. This fence does, over EVERY
// tracked file, and fails on a line that git itself would have written:
//
//   `<<<<<<< ` (ours), `||||||| ` (diff3 base), `=======` alone on its line
//   (separator), `>>>>>>> ` (theirs).
//
// The markers are matched exactly as git writes them — seven characters at
// column 0, a space after the angle/pipe ones, nothing after the separator
// (a trailing CR is tolerated for CRLF files). A Markdown setext underline is
// never exactly seven `=` on a line of its own in this repo; if one ever is,
// the fence says so and the fix is to lengthen it, not to allowlist it.
//
// ALLOWLIST — a file that legitimately QUOTES a marker at column 0 (a doc
// explaining conflict resolution, say) goes in ALLOWLIST with a reason. It is
// empty on purpose, and a stale entry (a path that no longer carries a
// marker) fails the fence, so the list can only shrink.
//
// NON-VACUITY — a fence that scans nothing passes on every tree. `git ls-files`
// returning fewer than MIN_TRACKED_FILES paths, or fewer than MIN_TEXT_FILES of
// them readable as text, is a failure, not a pass.
//
// Run:  pnpm tsx scripts/check-conflict-markers.ts   (or: pnpm lint:conflict-markers)
// Exits 0 when no tracked file carries a marker line.
// Exits 1 listing every file:line that does, or when the scan was vacuous.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/** The four marker shapes, built at runtime so this file never matches itself. */
const OURS = `${"<".repeat(7)} `;
const BASE = `${"|".repeat(7)} `;
const THEIRS = `${">".repeat(7)} `;
const SEPARATOR = "=".repeat(7);

export type MarkerKind = "ours" | "base" | "separator" | "theirs";

export type MarkerFinding = { path: string; line: number; kind: MarkerKind };

export type AllowlistEntry = { path: string; reason: string };

/**
 * Tracked files allowed to carry a marker line, each with the reason. Keep it
 * empty unless a file genuinely has to quote git's output verbatim at column 0.
 */
export const ALLOWLIST: readonly AllowlistEntry[] = [];

/** Below this, the listing broke — this repo tracks thousands of files. */
export const MIN_TRACKED_FILES = 1000;
/** Below this, reading broke — most of the tracked tree is text. */
export const MIN_TEXT_FILES = 1000;

const MAX_BYTES = 4 * 1024 * 1024;

/** The marker kind of one line, or null. Exported for the red controls. */
export function markerKind(rawLine: string): MarkerKind | null {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (line.startsWith(OURS)) return "ours";
  if (line.startsWith(BASE)) return "base";
  if (line.startsWith(THEIRS)) return "theirs";
  if (line === SEPARATOR) return "separator";
  return null;
}

/** Every marker line in one file's text. */
export function findMarkers(path: string, src: string): MarkerFinding[] {
  const findings: MarkerFinding[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kind = markerKind(lines[i]);
    if (kind !== null) findings.push({ path, line: i + 1, kind });
  }
  return findings;
}

export type ScanResult = {
  findings: MarkerFinding[];
  allowed: MarkerFinding[];
  staleAllowlist: AllowlistEntry[];
};

/** Pure core: scan a set of files against an allowlist. */
export function scanConflictMarkers(
  files: { path: string; src: string }[],
  allowlist: readonly AllowlistEntry[] = ALLOWLIST,
): ScanResult {
  const allowedPaths = new Set(allowlist.map((e) => e.path));
  const usedPaths = new Set<string>();
  const findings: MarkerFinding[] = [];
  const allowed: MarkerFinding[] = [];
  for (const { path, src } of files) {
    for (const f of findMarkers(path, src)) {
      if (allowedPaths.has(path)) {
        allowed.push(f);
        usedPaths.add(path);
      } else {
        findings.push(f);
      }
    }
  }
  return {
    findings,
    allowed,
    staleAllowlist: allowlist.filter((e) => !usedPaths.has(e.path)),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

function readText(path: string): string | null {
  try {
    if (statSync(path).size > MAX_BYTES) return null;
    const buf = readFileSync(path);
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    // Deleted in the working tree but still tracked — nothing to read.
    return null;
  }
}

function runCheck(): void {
  const paths = trackedFiles();
  if (paths.length < MIN_TRACKED_FILES) {
    console.error(
      `✗ check-conflict-markers: \`git ls-files\` returned ${paths.length} path(s), below the ${MIN_TRACKED_FILES} floor. That is not a pass — the listing broke and this fence would wave everything through.`,
    );
    process.exit(1);
  }

  const files: { path: string; src: string }[] = [];
  for (const path of paths) {
    const src = readText(path);
    if (src !== null) files.push({ path, src });
  }
  if (files.length < MIN_TEXT_FILES) {
    console.error(
      `✗ check-conflict-markers: only ${files.length} tracked file(s) were readable as text, below the ${MIN_TEXT_FILES} floor. The scan checked almost nothing.`,
    );
    process.exit(1);
  }

  const result = scanConflictMarkers(files);
  let failed = false;

  if (result.findings.length > 0) {
    failed = true;
    for (const f of result.findings) {
      console.error(`${f.path}:${f.line}: leftover merge-conflict marker (${f.kind}).`);
    }
    console.error(
      [
        "",
        `✗ ${result.findings.length} merge-conflict marker line(s) in tracked files.`,
        "  Finish resolving the conflict: keep the right side, delete every marker line.",
        "  A file that must QUOTE a marker at column 0 goes in ALLOWLIST",
        "  (scripts/check-conflict-markers.ts) with its reason.",
        "",
      ].join("\n"),
    );
  }
  for (const e of result.staleAllowlist) {
    failed = true;
    console.error(`✗ stale allowlist entry — ${e.path} carries no marker line; delete it.`);
  }
  if (failed) process.exit(1);

  console.log(
    `✓ No merge-conflict markers — ${paths.length} tracked path(s), ${files.length} text file(s) scanned, ${result.allowed.length} allowlisted line(s) across ${ALLOWLIST.length} entr(ies).`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-conflict-markers.ts") ||
    process.argv[1].endsWith("check-conflict-markers.js"));

if (isMain) runCheck();
