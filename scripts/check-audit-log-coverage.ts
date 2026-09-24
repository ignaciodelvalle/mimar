// Audit-log coverage fence — the missing sibling of `lint:authz`.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// An invariant-escape audit (2026-08-16) ranked audit-log completeness as the
// single largest structural gap in the system: the only catastrophic invariant
// with NO defense at any layer. 67 hand-written `db.insert(auditLog)` call
// sites, no helper, no fence, no test. Contrast with authorization, where an
// unguarded server action is caught by check-authz-guards.ts — here, omitting
// the audit row entirely was caught by nothing, and the absence of a row is
// permanently indistinguishable from the absence of the action it would have
// described. Ley 25.326 accountability rests on that row existing.
//
// WHAT IT CHECKS
// An exported server action that (a) establishes OPERATOR authority — an
// institutional guard, i.e. admin/govt, not a mere logged-in citizen — and
// (b) reaches a database MUTATION, must also (c) reach an audit write. All
// three are measured over the action's own body PLUS the modules it calls into
// one hop away, because the dominant shape in this repo is a thin guarded
// `*Action` wrapper delegating to an application use-case.
//
// DISCOVERY IS BY CONTENT, NOT BY FILENAME
// The module list comes from check-authz-guards.ts's `listActionFiles()`: every
// module under app/ or src/ whose FIRST statement is `"use server"`. That file
// documents at length why the old filename globs were "a naming convention
// masquerading as a security boundary" that left ten real modules invisible.
// Importing its function rather than re-deriving one means this fence can never
// drift narrower than that one.
//
// TWO ANTI-ROT GUARDS, BOTH MANDATORY
//   1. NON-VACUITY. Discovering zero action files, or zero operator+mutating
//      CANDIDATES, is a FAILURE, not a pass. A fence that scans nothing and
//      reports success is the exact failure class this repo keeps paying for.
//   2. NO STALE BASELINE. A baseline entry that no longer offends must be
//      removed — copied from the `staleBaseline` block in `runScan()` of
//      scripts/check-db-budget.ts, which 17 of the 18 other ratchets in this
//      repo lack. A stale entry is how a ratchet quietly stops ratcheting.
//      (Cited by SYMBOL, not by line range: this pointer read ":551-561" until
//      2026-08-21, by which time the block had moved to ~779 and the lines it
//      named were part of a string-literal scanner. A citation that has drifted
//      is worse than none — it sends a reader somewhere plausible and wrong.)
//
// KNOWN BLIND SPOTS — stated, not hidden:
//   · ONE HOP. A wrapper → use-case → repository chain hides the mutation (and
//     the audit) two hops down. Both signals move together, so the usual result
//     is a MISSED offender, not a false positive.
//   · OPERATOR-ONLY. Owner/vet self-service mutations (personal-tier guards)
//     are out of scope; the invariant this fence serves is about operator and
//     admin actions. Widening to every authenticated mutation is a much larger
//     baseline and a different rule.
//   · REGEX, NOT AST — same tradeoff as every sibling linter here. An
//     `auditLog` identifier named only in a comment would count as coverage, so
//     comments are stripped before any body is tested.
//
// Run: pnpm tsx scripts/check-audit-log-coverage.ts   (or: pnpm lint:audit-log)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  extractExportedAsyncFunctions,
  isInnerWriter,
  listActionFiles,
} from "./check-authz-guards";
import { stripComments } from "./lib/strip-comments.mjs";

export const BASELINE_PATH = "scripts/audit-log-coverage-baseline.json";

// Guards that establish ADMIN/GOVT authority — the "operator" half of the rule.
// Deliberately the institutional set only (see the operator-only blind spot).
// Kept as its own list rather than imported from check-authz-guards so that
// widening THAT file's authorization taxonomy cannot silently change what this
// fence considers an operator action.
export const OPERATOR_GUARDS = [
  "requireAdminOrRedirect",
  "requireAdminOrGovtOrRedirect",
  "requireDecomisoPrincipal",
  "requireDenunciaModerationPrincipal",
  // ADDED 2026-08-22 (top-10 review H1). Until then this fence could not see
  // capability-gated org writes AT ALL: `requireCapability` was absent from the
  // list, so every action authorized by an organization capability was
  // structurally invisible — not baselined, not exempted, simply never derived
  // as a candidate. That is the worst shape a fence can have, because its
  // summary line kept saying "coverage clean" about a set that excluded the
  // whole class. The bite report from an org — which puts a legally consequential
  // status on a third party's animal — sat in that blind spot with no audit row.
  //
  // BOTH names are listed. `callsAnyOf` builds `\brequireCapability\s*\(`, which
  // does NOT match `requireCapabilityForOrgToken(` — so listing only the bare
  // one would have re-created the same blind spot for exactly the actions that
  // took the trouble to pin their org scope.
  //
  // On the operator-only blind spot below: an org capability IS institutional
  // authority. `bite.report`, `custody.transfer` and `adoption.finalize` move
  // animals and impose statutory states on other people's property; the fact
  // that the authority is delegated by an org admin rather than by a govt role
  // does not make the act personal self-service.
  "requireCapability",
  "requireCapabilityForOrgToken",
] as const;

// A drizzle write. `.insert(auditLog)` is excluded by construction: it is the
// audit signal, and a function whose ONLY write is its own audit row is an
// audit-only fact (an export receipt, a page-view trail), not a mutation.
const MUTATION_RE = /\.(insert|update|delete)\s*\(\s*(?!auditLog\b)/;

// Reaching the audit trail: the helper, the drizzle table, the raw SQL name, or
// a CALL to a repository's audit writer — the repo-wide convention
// `repo.insert<Something>AuditLog(…)` (org, transfers, events and surveillance
// repositories all name it so, and every one inserts into audit_log). Added
// 2026-09-18: the State's rabies close writes its audit row through
// `repo.insertObservationCloseAuditLog` inside the use case — one hop from the
// action — and the old pattern (case-sensitive `auditLog`) could not see the
// `…AuditLog` suffix, so the action read as unaudited the moment it started
// calling a mutating module directly. Anchored on a CALL, so a type or a
// comment naming such a method does not count.
const AUDIT_RE = /\b(writeAuditLog|auditLog|audit_log)\b|\binsert\w*AuditLog\s*\(/;

/** Marker opting a specific export out, with a documented reason. */
export const NO_AUDIT_COMMENT = "@no-audit-required";

const REPO_ROOT = resolve(import.meta.dirname, "..");

export function normalizePath(p: string): string {
  return p.replaceAll("\\", "/");
}

function callsAnyOf(body: string, names: readonly string[]): boolean {
  return names.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(body));
}

/**
 * Map of local identifier → module specifier, for the specifiers this fence can
 * follow (repo-internal `@/…` and relative paths). Node modules are ignored:
 * nothing in `node_modules` writes this application's audit trail.
 *
 * Includes MODULE-LEVEL ALIASES of imported values, because the dominant
 * delegation shape in this repo binds a repository once at module scope and
 * calls methods on it:
 *
 *     import { WelfareRepository } from "./infrastructure/welfare-repository";
 *     const repo = new WelfareRepository();
 *     …
 *     await repo.insertAudit({ … });          // ← the audit write
 *
 * Without alias resolution `repo` resolves to nothing and
 * deriveWelfareToOrgAction reads as UNAUDITED — a measured false positive on
 * this fence's first run. A fence that cries wolf on correct code gets
 * baselined into silence, so this matters as much as recall does.
 */
export function importedIdentifiers(strippedSource: string): Map<string, string> {
  const out = new Map<string, string>();
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of strippedSource.matchAll(importRe)) {
    const specifier = match[2];
    if (!specifier.startsWith("@/") && !specifier.startsWith(".")) continue;
    for (const rawEntry of match[1].split(",")) {
      const entry = rawEntry.trim();
      if (entry === "" || entry.startsWith("type ")) continue;
      const parts = entry.split(/\s+as\s+/);
      const local = (parts[1] ?? parts[0]).trim();
      if (local) out.set(local, specifier);
    }
  }

  // `const alias = new Imported(…)` / `const alias = imported(…)` / `const
  // alias = imported` — alias inherits the imported value's module.
  const aliasRe = /^\s*(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:new\s+)?(\w+)\b/gm;
  for (const match of strippedSource.matchAll(aliasRe)) {
    const [, alias, source] = match;
    const specifier = out.get(source);
    if (specifier && !out.has(alias)) out.set(alias, specifier);
  }

  return out;
}

/** Resolve a module specifier to a readable file on disk, or null. */
export function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(REPO_ROOT, specifier.slice(2))
    : resolve(dirname(join(REPO_ROOT, fromFile)), specifier);

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return normalizePath(candidate);
  }
  return null;
}

const sourceCache = new Map<string, string>();
function readStripped(absPath: string): string {
  const cached = sourceCache.get(absPath);
  if (cached !== undefined) return cached;
  const src = stripComments(readFileSync(absPath, "utf8"));
  sourceCache.set(absPath, src);
  return src;
}

/**
 * The action's own (comment-stripped) body plus the source of every
 * repo-internal module it actually CALLS into. One hop — see the blind spots.
 */
export function reachableSources(
  relPath: string,
  moduleImports: Map<string, string>,
  strippedBody: string,
): string[] {
  const sources = [strippedBody];
  const seen = new Set<string>();
  for (const [identifier, specifier] of moduleImports) {
    // `\s*[.(]` — a direct call `useCase(…)` OR a method call on an imported
    // value / its module-level alias `repo.insertAudit(…)`.
    if (!new RegExp(`\\b${identifier}\\s*[.(]`).test(strippedBody)) continue;
    const resolved = resolveSpecifier(relPath, specifier);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      sources.push(readStripped(resolved));
    } catch {
      // Unreadable module — treat as contributing no signal rather than
      // crashing the fence. It can only cause a missed offender.
    }
  }
  return sources;
}

export type Candidate = {
  /** `<relPath>#<fnName>` — the baseline key. */
  key: string;
  relPath: string;
  name: string;
  line: number;
  audited: boolean;
};

/**
 * Every operator+mutating exported action in `src`, each flagged with whether
 * an audit write is reachable from it.
 */
export function findCandidates(relPath: string, src: string): Candidate[] {
  const stripped = stripComments(src);
  const moduleImports = importedIdentifiers(stripped);
  const out: Candidate[] = [];

  for (const fn of extractExportedAsyncFunctions(src)) {
    if (isInnerWriter(fn.name)) continue;
    const body = stripComments(fn.body);
    if (!callsAnyOf(body, OPERATOR_GUARDS)) continue;

    const sources = reachableSources(relPath, moduleImports, body);
    if (!sources.some((s) => MUTATION_RE.test(s))) continue;

    out.push({
      key: `${relPath}#${fn.name}`,
      relPath,
      name: fn.name,
      line: fn.startLine,
      // The opt-out marker counts as coverage so the exception is visible in
      // the source, next to the code, instead of buried in a JSON baseline.
      audited:
        fn.body.includes(NO_AUDIT_COMMENT) ||
        hasNoAuditComment(src, fn.startLine) ||
        sources.some((s) => AUDIT_RE.test(s)),
    });
  }
  return out;
}

/** Walk backwards through the contiguous comment block above the export. */
function hasNoAuditComment(src: string, startLine: number): boolean {
  const lines = src.split("\n");
  for (let i = startLine - 2; i >= 0; i--) {
    const line = lines[i].trim();
    const isComment =
      line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line === "";
    if (!isComment) return false;
    if (line.includes(NO_AUDIT_COMMENT)) return true;
  }
  return false;
}

export function readBaseline(): string[] {
  if (!existsSync(BASELINE_PATH)) return [];
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
    unaudited?: string[];
  };
  return parsed.unaudited ?? [];
}

export function scanAll(): { candidates: Candidate[]; actionFiles: number } {
  const files = listActionFiles();
  const candidates: Candidate[] = [];
  for (const file of files) {
    const relPath = normalizePath(file);
    candidates.push(...findCandidates(relPath, readFileSync(file, "utf8")));
  }
  return { candidates, actionFiles: files.length };
}

function runScan(): void {
  const writeBaseline = process.argv.includes("--write-baseline");
  const { candidates, actionFiles } = scanAll();

  // GUARD 1 — non-vacuity. Two levels: nothing to scan, and nothing matched.
  if (actionFiles === 0) {
    console.error(
      '✗ check-audit-log-coverage: found ZERO "use server" modules to scan.\n' +
        "  That is not a pass — discovery broke, and a fence that scans nothing\n" +
        "  waves everything through.",
    );
    process.exit(1);
  }
  if (candidates.length === 0) {
    console.error(
      [
        `✗ check-audit-log-coverage: scanned ${actionFiles} server-action module(s) and derived ZERO`,
        `  operator+mutating candidates (guards: ${OPERATOR_GUARDS.join("/")}).`,
        "  Either every operator write disappeared, or the derivation broke. A guard",
        "  that derives nothing guards nothing — fix the derivation.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const unaudited = candidates.filter((c) => !c.audited);

  if (writeBaseline) {
    const payload = {
      $comment: [
        "Pre-existing operator actions with no reachable audit write (lint:audit-log).",
        "This list may only SHRINK. Adding an entry means accepting a mutating",
        "operator action whose occurrence leaves no trace — fix it or write a",
        `\`// ${NO_AUDIT_COMMENT}: <reason>\` comment above the export instead.`,
      ],
      unaudited: unaudited.map((c) => c.key).sort(),
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`✓ wrote ${unaudited.length} baseline entr(y/ies) to ${BASELINE_PATH}`);
    return;
  }

  const baseline = new Set(readBaseline());
  let failed = false;

  // The actual rule: a NEW unaudited operator mutation.
  const fresh = unaudited.filter((c) => !baseline.has(c.key));
  if (fresh.length > 0) {
    console.error(
      `✗ ${fresh.length} operator action(s) MUTATE the database with no reachable audit write:`,
    );
    for (const c of fresh) {
      console.error(`    ${c.relPath}:${c.line} ${c.name}`);
    }
    console.error(
      [
        "",
        "  An admin/govt mutation that writes no audit_log row is indistinguishable,",
        "  afterwards, from the mutation never having happened (Ley 25.326).",
        "  Write the row INSIDE the mutation's transaction:",
        "      await writeAuditLog(tx, { action, actorUserId, before, after })",
        "  (lib/infra/audit-log.ts). If the action genuinely needs none, add a",
        `  \`// ${NO_AUDIT_COMMENT}: <reason>\` comment above the export.`,
      ].join("\n"),
    );
    failed = true;
  }

  // GUARD 2 — no stale baseline. Copied from the `staleBaseline` block in
  // check-db-budget.ts's `runScan()`.
  const stillUnaudited = new Set(unaudited.map((c) => c.key));
  const stale = [...baseline].filter((k) => !stillUnaudited.has(k)).sort();
  if (stale.length > 0) {
    console.error(
      `✗ ${stale.length} stale entr(y/ies) in ${BASELINE_PATH} — these no longer offend (fixed, renamed, or deleted) and must be removed so the ratchet keeps its grip:`,
    );
    for (const s of stale) console.error(`    ${s}`);
    failed = true;
  }

  if (failed) process.exit(1);

  console.log(
    `✓ audit-log coverage clean — ${actionFiles} server-action module(s) scanned, ` +
      `${candidates.length} operator+mutating action(s) derived, ` +
      `${candidates.length - unaudited.length} reach an audit write (${baseline.size} baselined debt).`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-audit-log-coverage.ts") ||
    process.argv[1].endsWith("check-audit-log-coverage.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
