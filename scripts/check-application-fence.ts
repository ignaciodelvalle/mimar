// Application-layer import fence RATCHET — CI guardrail (native-readiness T1.3).
//
// WHAT THE FENCE IS
// ---------------------------------------------------------------------------
// biome.json bans a handful of specifiers inside `src/modules/*/application/**`
// (ADR 2026-07-18 native-readiness, Decision 1): `next`, `next/cache`,
// `next/navigation`, `next/headers`, `server-only`, and — since T1.3 —
// `@/lib/supabase/server`, which is `next/headers` wearing an alias. The point
// is that a use-case must be runnable without a Next request, because a React
// Native app has no Next request to give it.
//
// WHAT THIS FILE IS
// ---------------------------------------------------------------------------
// The fence shipped with an escape hatch: a second biome override that turns
// `noRestrictedImports` OFF for an enumerated list of files. That list is the
// honest, legible form of the debt — but a frozen exemption list is only a
// ratchet if something forces it downward. Nothing did. Measured 2026-08-20,
// two of its entries had ALREADY been fixed and nobody removed them: the list
// said 46 and the real coupling was 44. An exemption that outlives the
// violation is how a ratchet quietly stops ratcheting.
//
// So, in the shape of scripts/check-db-budget.ts's baseline:
//
//   1. NON-VACUITY. The application override must exist and must restrict at
//      least one specifier, and the scan must find application files. Scanning
//      nothing is a FAILURE, not a pass — this repo has been bitten repeatedly
//      by a fence whose corpus quietly stopped matching the code.
//   2. The exemption override must exist and be uniquely identifiable.
//   3. Every exempt path must EXIST. A rename has to MOVE the entry, not drop
//      enforcement in silence (check-db-budget learned this the hard way).
//   4. Every exempt path must STILL import something restricted. A stale entry
//      is removed, in the commit that fixed the file.
//   5. No unexempt application file may import a restricted specifier. Biome
//      enforces this too; duplicated here so a single command answers "is the
//      layer clean?" and so the count below is derived from something real.
//   6. The list may only SHRINK. scripts/application-fence-baseline.json records
//      the current size; the check demands EQUALITY, so removing a file forces
//      you to lower the number in the same diff, and adding one is a visible,
//      reviewable edit to a file whose only content is that number.
//   7. The list stays sorted and duplicate-free, so its diff is readable.
//
// WHY NOT JUST DELETE THE EXEMPTIONS: 44 coupled use-cases is weeks of write-
// boundary refactoring, each one a small behavioural risk. The debt is real.
// This file makes it monotonic.
//
// Run: pnpm tsx scripts/check-application-fence.ts   (or: pnpm lint:app-fence)
// Exits 0 when clean; exits 1 naming every offending entry.
//
// Regex/string scan (not an AST analyzer) — matches the sibling linters
// (check-contract-purity.ts, check-db-budget.ts, check-dependency-direction.ts).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const BIOME_CONFIG = "biome.json";
export const BASELINE_PATH = "scripts/application-fence-baseline.json";

/** Root of the guarded layer, and the glob biome uses for it. */
export const MODULES_ROOT = "src/modules";
export const APPLICATION_INCLUDE = "src/modules/*/application/**";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BiomeOverride = {
  include?: string[];
  linter?: {
    rules?: {
      nursery?: {
        noRestrictedImports?: unknown;
      };
    };
  };
};

export type BiomeConfig = { overrides?: BiomeOverride[] };

export type Baseline = { exemptions: number };

// ---------------------------------------------------------------------------
// Core logic (exported for unit tests)
// ---------------------------------------------------------------------------

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|(typeof\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Every import/export/require specifier in `src`.
 *
 * `typeof import("x")` is excluded, and that exclusion is load-bearing rather
 * than a shortcut. It is a TYPE-position reference: it erases at compile time,
 * pulls no module into any bundle, and is precisely the shape a decoupled
 * use-case uses to name the type of a client its caller injects
 * (record-post-adoption-checkin.ts is the worked example). Biome's own
 * noRestrictedImports does not flag it either — measured 2026-08-20 — so
 * counting it here would put this ratchet permanently out of step with the
 * fence it guards, and would have demanded an exemption for a file that is
 * already correct.
 *
 * A RUNTIME `await import("next/headers")` IS counted, and there biome is the
 * one out of step: it sees nothing. That hole is this check's to close.
 */
export function extractSpecifiers(src: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = IMPORT_RE.exec(src))) {
    if (m[3] !== undefined && m[2] !== undefined) continue; // typeof import("x")
    const specifier = m[1] ?? m[3] ?? m[4];
    if (specifier) out.push(specifier);
  }
  return out;
}

/** The restricted specifiers `src` imports, deduped and in source order. */
export function restrictedImportsIn(src: string, restricted: ReadonlySet<string>): string[] {
  const hits = extractSpecifiers(src).filter((s) => restricted.has(s));
  return [...new Set(hits)];
}

/**
 * The override that DECLARES the fence: the one whose include list is exactly
 * the application glob and whose noRestrictedImports carries options.
 */
export function findFenceOverride(config: BiomeConfig): BiomeOverride | null {
  for (const o of config.overrides ?? []) {
    if (!o.include?.includes(APPLICATION_INCLUDE)) continue;
    const rule = o.linter?.rules?.nursery?.noRestrictedImports;
    if (rule && typeof rule === "object") return o;
  }
  return null;
}

/** The specifiers the fence bans, read from the override itself. */
export function restrictedSpecifiers(config: BiomeConfig): string[] {
  const rule = findFenceOverride(config)?.linter?.rules?.nursery?.noRestrictedImports as
    | { options?: { paths?: Record<string, string> } }
    | undefined;
  return Object.keys(rule?.options?.paths ?? {});
}

/** True when an include entry names one concrete file (no glob metacharacter). */
export function isConcretePath(include: string): boolean {
  return !/[*?[\]{}]/.test(include);
}

/**
 * The override that WAIVES the fence for enumerated files: rule turned "off",
 * every include entry a concrete path under src/modules/. The test carve-out
 * (which also turns the rule off) is excluded by the concrete-path test, since
 * its entries are globs.
 */
export function findExemptionOverrides(config: BiomeConfig): BiomeOverride[] {
  return (config.overrides ?? []).filter((o) => {
    if (o.linter?.rules?.nursery?.noRestrictedImports !== "off") return false;
    const include = o.include ?? [];
    if (include.length === 0) return false;
    return include.every((i) => isConcretePath(i) && i.startsWith(`${MODULES_ROOT}/`));
  });
}

/** Application source files (tests excluded — the fence exempts those by glob). */
export function listApplicationFiles(root = MODULES_ROOT): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(p);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(p);
      }
    }
  };
  for (const mod of readdirSync(root, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    const dir = `${root}/${mod.name}/application`;
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  }
  return out.sort();
}

/** Entries out of alphabetical order or repeated. */
export function unsortedOrDuplicate(include: string[]): {
  unsorted: boolean;
  duplicates: string[];
} {
  const sorted = [...include].sort();
  const duplicates = include.filter((v, i) => include.indexOf(v) !== i);
  // Element-wise, not a joined string: an entry could contain any separator a
  // join would pick, and comparing paths through a delimiter is how two
  // different lists start looking identical.
  const unsorted = include.some((entry, i) => entry !== sorted[i]);
  return { unsorted, duplicates };
}

export function readBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) return { exemptions: Number.NaN };
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runCheck(): void {
  const config = JSON.parse(readFileSync(BIOME_CONFIG, "utf8")) as BiomeConfig;
  const errors: string[] = [];

  // (1) Non-vacuity — the fence itself.
  const restricted = restrictedSpecifiers(config);
  if (restricted.length === 0) {
    console.error(
      [
        `✗ check-application-fence: ${BIOME_CONFIG} declares no restricted imports for`,
        `  "${APPLICATION_INCLUDE}". The fence this ratchet guards is GONE, and a ratchet`,
        "  over a missing fence reports success forever. Restore the override.",
      ].join("\n"),
    );
    process.exit(1);
  }
  const restrictedSet = new Set(restricted);

  const applicationFiles = listApplicationFiles();
  if (applicationFiles.length === 0) {
    console.error(
      [
        "✗ check-application-fence: scanned ZERO application files.",
        `  That is not a pass — it means ${MODULES_ROOT}/*/application/ no longer matches the`,
        "  code (moved? renamed?) and this check would wave everything through.",
      ].join("\n"),
    );
    process.exit(1);
  }

  // (2) The exemption override must be there, and there must be exactly one.
  const exemptionOverrides = findExemptionOverrides(config);
  if (exemptionOverrides.length !== 1) {
    console.error(
      [
        `✗ check-application-fence: expected exactly ONE exemption override in ${BIOME_CONFIG}`,
        `  (noRestrictedImports "off" over concrete ${MODULES_ROOT}/… paths); found ${exemptionOverrides.length}.`,
        "  Splitting the list across overrides hides its size, which is the one thing",
        "  this ratchet measures. Keep it as a single list.",
      ].join("\n"),
    );
    process.exit(1);
  }
  const exempt = exemptionOverrides[0]?.include ?? [];

  // (7) Readable diffs.
  const { unsorted, duplicates } = unsortedOrDuplicate(exempt);
  if (unsorted) {
    errors.push(
      "the exemption list is not sorted alphabetically — sort it so its diff is legible.",
    );
  }
  for (const d of new Set(duplicates)) {
    errors.push(`duplicate exemption entry: ${d}`);
  }

  // (3) Every exempt path must exist.
  const missing = exempt.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    errors.push(
      `${missing.length} exempt path(s) no longer exist. A rename must MOVE the entry, not drop enforcement:\n${missing.map((m) => `    ${m}`).join("\n")}`,
    );
  }

  // (4) Every exempt path must still offend.
  const stale = exempt.filter(
    (f) =>
      existsSync(f) && restrictedImportsIn(readFileSync(f, "utf8"), restrictedSet).length === 0,
  );
  if (stale.length > 0) {
    errors.push(
      `${stale.length} STALE exemption(s) — these no longer import anything restricted and must be removed so the ratchet keeps its grip:\n${stale.map((s) => `    ${s}`).join("\n")}`,
    );
  }

  // (5) Nothing coupled outside the list.
  const exemptSet = new Set(exempt);
  const unlisted: string[] = [];
  for (const file of applicationFiles) {
    if (exemptSet.has(file)) continue;
    const hits = restrictedImportsIn(readFileSync(file, "utf8"), restrictedSet);
    if (hits.length > 0) unlisted.push(`${file}  (${hits.join(", ")})`);
  }
  if (unlisted.length > 0) {
    errors.push(
      `${unlisted.length} application file(s) import a restricted specifier without an exemption:\n${unlisted.map((u) => `    ${u}`).join("\n")}`,
    );
  }

  // (6) The ratchet.
  const baseline = readBaseline();
  if (!Number.isInteger(baseline.exemptions)) {
    errors.push(
      `${BASELINE_PATH} is missing or has no integer "exemptions". Without it there is no ratchet.`,
    );
  } else if (exempt.length !== baseline.exemptions) {
    const verb = exempt.length > baseline.exemptions ? "GREW" : "shrank";
    errors.push(
      [
        `the exemption list ${verb}: ${baseline.exemptions} baselined, ${exempt.length} in ${BIOME_CONFIG}.`,
        exempt.length > baseline.exemptions
          ? `    A new coupled use-case is a regression. Decouple it, or raise "exemptions" in ${BASELINE_PATH} in the same commit and say why in the message.`
          : `    You fixed ${baseline.exemptions - exempt.length} file(s) — lower "exemptions" to ${exempt.length} in ${BASELINE_PATH} so the ratchet holds the new floor.`,
      ].join("\n"),
    );
  }

  if (errors.length > 0) {
    console.error("");
    console.error("✗ application-layer import fence FAILED");
    console.error("");
    for (const e of errors) console.error(`  ${e}`);
    console.error("");
    console.error(
      [
        `  Restricted inside ${APPLICATION_INCLUDE}: ${restricted.join(", ")}.`,
        "  A use-case must run without a Next request — that is what makes it callable",
        "  from /api/v1, from a script, and eventually from a native client.",
      ].join("\n"),
    );
    console.error("");
    process.exit(1);
  }

  console.log(
    `✓ application fence — ${applicationFiles.length} application file(s) scanned, ${exempt.length} exemption(s) (baseline ${baseline.exemptions}), every one still coupled, nothing coupled off-list.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-application-fence.ts") ||
    process.argv[1].endsWith("check-application-fence.js"));

if (isMain) runCheck();
