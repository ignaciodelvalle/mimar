// Titular-only write fence — CI guardrail (custodia-temporal).
//
// THE QUESTION THIS ASKS
// ---------------------------------------------------------------------------
// check-authz-guards.ts asks "is there a guard AT ALL?". check-authz-scoping.ts
// asks "is the resource bound to the caller's tenant?". This one asks the third
// question, the one custodia-temporal opened: "the caller holds an ownership
// row on this pet — but is the ROLE in that row allowed to do THIS?".
//
// Since custodia-temporal a Path-1 holder may be a `caretaker`: a bounded,
// scoped grant. `requirePetAccess` binds the pet to the caller and says NOTHING
// about which of the caller's roles is acting. So "this pet is one of mine" is
// no longer the same claim as "I may write anything on it", and the difference
// needs its own fence.
//
// WHAT IT CHECKS — the EFFECT, not a list of call sites
// ---------------------------------------------------------------------------
// A list of "these seven actions are gated" proves nothing about a default-
// ALLOW rule: the eighth writer, in a module that does not exist yet, is
// precisely the one that will not be on the list. So the subject is the closed
// set of DATABASE EFFECTS a titular-only action produces, declared once in
// lib/domain/titular-only.ts:
//
//   - inserting a TITULAR_ONLY_EVENT_TYPES row into petEvents
//   - updating a TITULAR_ONLY_PET_COLUMNS column on pets
//   - inserting into a TITULAR_ONLY_INSERT_TABLES table (libreta share tokens)
//
// A brand-new file in a brand-new module producing one of those effects is
// caught on its first commit, with no fence update.
//
// WHY IT PROPAGATES THROUGH CALLS (the part that took a rewrite)
// ---------------------------------------------------------------------------
// The obvious shape — "a function body with the effect must also call the
// guard" — is unsatisfiable in this codebase and would have been a fence that
// could never go green for the right reason. DIM's layering puts the GUARD in
// the server action and the EFFECT in an application use-case or a repository
// method, two files away; neither function contains both, and the use-case has
// no session to guard with. Measured on the tree at authoring time: the naive
// rule found ZERO of the five real ungated writers and 17 false positives in
// decomiso / return-to-owner (org-authority flows a caretaker cannot reach).
//
// So the scan runs in two phases:
//   1. INDEX  — every exported async function and every object-literal async
//      method in the scanned tree is checked for a direct effect, then the
//      effect is propagated transitively along same-name call edges (import
//      aliases resolved). The index is DERIVED on every run; there is no
//      hand-maintained list of writers to forget to update.
//   2. ENFORCE — a function is an offender when it authorizes through the
//      PERSON PATH (requirePetAccess / requireAlivePetAccess /
//      requireOwnedPetByToken — the only path a caretaker can enter by),
//      reaches a titular-only effect, and does not call requireTitularAccess.
//
// Org-path writers are deliberately out of subject: `holderRole` is null on the
// org path by construction (design decision B), so requireTitularAccess is a
// no-op there and flagging them would flood the baseline with every legitimate
// shelter action.
//
// HONEST RESIDUALS — stated, not glossed
//   - Regex over file-local bodies, like all 59 sibling linters. An event type
//     assembled from a variable defeats the event rule. That is WHY the RLS
//     counterpart exists (migration N+1): two uncorrelated layers, not one.
//   - Call edges are matched BY NAME. Two different functions sharing a name
//     over-taint rather than under-taint — the safe direction, and it costs an
//     allowlist entry if it ever fires.
//   - `.set({…})` blocks are collected per FUNCTION, not per statement, so a
//     function that updates `pets` and separately sets `name` on another table
//     would be flagged. Measured zero occurrences; the direction is safe.
//   - A writer that never touches a person-path guard (e.g. one resolving
//     identity with a bare `supabase.auth.getUser()`) is invisible here. That
//     class is check-authz-guards.ts's deletion-aware rule, and moving such an
//     action onto requireTitularAccess — as createLibretaShareAction did — is
//     what brings it into this fence's subject.
//
// Run: pnpm tsx scripts/check-titular-gate.ts   (or: pnpm lint:titular-gate)

import { globSync, readFileSync } from "node:fs";

import {
  TITULAR_ONLY_EVENT_TYPES,
  TITULAR_ONLY_INSERT_TABLES,
  TITULAR_ONLY_PET_COLUMNS,
} from "../lib/domain/titular-only";
import {
  extractExportedAsyncFunctions,
  isInnerWriter,
  listActionFiles,
} from "./check-authz-guards";
import { stripComments } from "./lib/strip-comments.mjs";

/** The guard that satisfies this fence. */
export const TITULAR_GUARD = "requireTitularAccess";

/**
 * Guards that resolve access through an `ownerships` row keyed on the caller's
 * user_id — Path 1 of requirePetAccess. This is the ONLY door a caretaker can
 * walk through, which is what makes it the right antecedent for the rule.
 */
export const PERSON_PATH_GUARDS = [
  "requirePetAccess",
  "requireAlivePetAccess",
  "requireOwnedPetByToken",
] as const;

/**
 * Documented exceptions: `"<relPath>#<fn>"` → reason. EMPTY IS THE GOAL, and
 * `__tests__/check-titular-gate.test.ts` asserts the real tree produces no
 * offender outside it.
 *
 * IT WAS NOT BORN EMPTY. The commit that introduced this fence found five real,
 * live, ungated titular-only writers on the unmodified tree — the tier-2 public
 * toggles, the profile edit, the jurisdiction move and the species correction —
 * and parked them here with a closing date. The commit that swapped them onto
 * requireTitularAccess emptied it. That round trip is the evidence the fence
 * detects something: a fence green on fixtures alone proves only that the
 * fixtures work.
 */
export const TITULAR_GATE_ALLOWLIST: Record<string, string> = {};

export type ScanSource = { relPath: string; src: string };

type Unit = {
  relPath: string;
  name: string;
  /** Comment-stripped body. Raw bodies let a guard named in prose pass. */
  body: string;
  effects: string[];
  aliases: Map<string, string>;
  isActionFile: boolean;
};

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

const SCAN_GLOBS = [
  "src/modules/**/application/**/*.ts",
  "src/modules/**/infrastructure/**/*.ts",
  "app/**/action.ts",
];

function isScannable(relPath: string): boolean {
  if (relPath.includes("__tests__")) return false;
  if (/\.test\.[jt]sx?$/.test(relPath)) return false;
  return !relPath.endsWith(".d.ts");
}

export function listScanSources(): ScanSource[] {
  const paths = new Set<string>();
  for (const f of listActionFiles()) paths.add(f.replaceAll("\\", "/"));
  for (const pattern of SCAN_GLOBS) {
    for (const f of globSync(pattern)) paths.add(f.replaceAll("\\", "/"));
  }
  return [...paths]
    .filter(isScannable)
    .sort()
    .map((relPath) => ({ relPath, src: readFileSync(relPath, "utf8") }));
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Object-literal async methods (`async updatePetProfile(args, tx) { … }`) — the
 * shape every `*Repository` in this codebase uses. extractExportedAsyncFunctions
 * only sees `export async function`, so without this the repository layer (where
 * most `pets` column writes actually happen) would be invisible to the index.
 */
/** Index just past the `)` closing the parameter list that opens at `from`. */
function skipParams(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/**
 * Index of the `{` that opens the body. The return annotation may carry braces
 * inside `Promise<{ … }>`, so the walk waits for a brace at angle-depth zero —
 * the same correction check-authz-guards had to make for its own walker.
 */
function findBodyStart(src: string, from: number): number {
  let angle = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "{" && angle === 0) return i;
  }
  return src.length;
}

/** Index of the `}` matching the `{` at `from`. */
function matchBrace(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

export function extractAsyncMethods(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const m of src.matchAll(/^[ \t]+async\s+(\w+)\s*\(/gm)) {
    const paramsEnd = skipParams(src, (m.index ?? 0) + m[0].length - 1);
    const start = findBodyStart(src, paramsEnd);
    const end = matchBrace(src, start);
    out.push({ name: m[1], body: src.slice(start, end + 1) });
  }
  return out;
}

/** `import { createLibretaShareForUser as _create }` → `_create` ⇒ original. */
export function importAliases(src: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const raw of m[1].split(",")) {
      const parts = raw.trim().split(/\s+as\s+/);
      if (parts.length === 2 && parts[0] && parts[1]) aliases.set(parts[1].trim(), parts[0].trim());
    }
  }
  return aliases;
}

function callsIdentifier(unit: Unit, name: string): boolean {
  if (new RegExp(`\\b${name}\\s*\\(`).test(unit.body)) return true;
  for (const [local, original] of unit.aliases) {
    if (original === name && new RegExp(`\\b${local}\\s*\\(`).test(unit.body)) return true;
  }
  return false;
}

function callsAnyGuard(body: string, guards: readonly string[]): boolean {
  return guards.some((g) => new RegExp(`\\b${g}\\s*\\(`).test(body));
}

// ---------------------------------------------------------------------------
// Phase 1 — effect index
// ---------------------------------------------------------------------------

function directEffects(body: string): string[] {
  const effects: string[] = [];
  if (/\.insert\s*\(/.test(body) && /\bpetEvents\b/.test(body)) {
    for (const eventType of TITULAR_ONLY_EVENT_TYPES) {
      if (new RegExp(`["'\`]${eventType}["'\`]`).test(body)) effects.push(`event:${eventType}`);
    }
  }
  if (/\.update\s*\(\s*pets\s*\)/.test(body)) {
    const setBlocks = [...body.matchAll(/\.set\s*\(\s*\{([\s\S]*?)\}\s*\)/g)]
      .map((m) => m[1])
      .join("\n");
    for (const column of TITULAR_ONLY_PET_COLUMNS) {
      if (new RegExp(`(^|[^\\w.])${column}\\s*:`, "m").test(setBlocks)) {
        effects.push(`column:${column}`);
      }
    }
  }
  for (const table of TITULAR_ONLY_INSERT_TABLES) {
    if (new RegExp(`\\.insert\\s*\\(\\s*${table}\\s*\\)`).test(body))
      effects.push(`table:${table}`);
  }
  return effects;
}

function parseUnits(sources: ScanSource[]): Unit[] {
  const actionFiles = new Set(listActionFilesFrom(sources));
  const units: Unit[] = [];
  for (const { relPath, src } of sources) {
    const aliases = importAliases(src);
    const isAction = actionFiles.has(relPath);
    const raw = [
      ...extractExportedAsyncFunctions(src).map((f) => ({ name: f.name, body: f.body })),
      ...extractAsyncMethods(src),
    ];
    for (const unit of raw) {
      const body = stripComments(unit.body);
      units.push({
        relPath,
        name: unit.name,
        body,
        effects: directEffects(body),
        aliases,
        isActionFile: isAction,
      });
    }
  }
  return units;
}

/**
 * "use server" modules among the given sources. Detected by CONTENT (the first
 * statement is the directive), the same authority check-authz-guards uses — a
 * filename convention is not a security boundary.
 */
function listActionFilesFrom(sources: ScanSource[]): string[] {
  return sources
    .filter(({ src }) => /^(["'])use server\1/.test(stripComments(src).trimStart()))
    .map(({ relPath }) => relPath);
}

/**
 * name → effect labels, after transitive propagation along call edges.
 *
 * Server actions are enforcement points, not propagators: a tainted action must
 * not export its taint to whatever calls it, or one gated action would light up
 * half the tree.
 */
export function indexTitularEffects(sources: ScanSource[]): Map<string, string[]> {
  const units = parseUnits(sources);
  const index = new Map<string, string[]>();
  for (const unit of units) {
    if (unit.effects.length === 0) continue;
    index.set(unit.name, [...new Set([...(index.get(unit.name) ?? []), ...unit.effects])]);
  }
  // Fixpoint. Bounded by the number of units; the guard is a safety net against
  // a pathological cycle, not an expected exit.
  for (let pass = 0; pass < 20; pass++) {
    let grew = false;
    for (const unit of units) {
      if (index.has(unit.name)) continue;
      if (unit.isActionFile) continue;
      if (isInnerWriter(unit.name)) continue;
      const reached = [...index.keys()].filter(
        (name) => name !== unit.name && callsIdentifier(unit, name),
      );
      if (reached.length === 0) continue;
      index.set(unit.name, [...new Set(reached.flatMap((n) => index.get(n) ?? []))]);
      grew = true;
    }
    if (!grew) break;
  }
  return index;
}

// ---------------------------------------------------------------------------
// Phase 2 — enforcement
// ---------------------------------------------------------------------------

export function findTitularGateOffenders(sources: ScanSource[]): string[] {
  const units = parseUnits(sources);
  const index = indexTitularEffects(sources);
  const offenders: string[] = [];

  for (const unit of units) {
    if (isInnerWriter(unit.name)) continue;
    if (!callsAnyGuard(unit.body, PERSON_PATH_GUARDS)) continue;
    if (callsAnyGuard(unit.body, [TITULAR_GUARD])) continue;

    const own = unit.effects;
    const viaNames = [...index.keys()].filter(
      (name) => name !== unit.name && callsIdentifier(unit, name),
    );
    const effects = [...new Set([...own, ...viaNames.flatMap((n) => index.get(n) ?? [])])];
    if (effects.length === 0) continue;
    if (TITULAR_GATE_ALLOWLIST[`${unit.relPath}#${unit.name}`] !== undefined) continue;

    const via = viaNames.length > 0 ? ` (reached via ${viaNames.join(", ")})` : "";
    offenders.push(
      `${unit.relPath} — ${unit.name} authorizes through the person path (${PERSON_PATH_GUARDS.join(
        "/",
      )}) and produces a titular-only effect [${effects.join(", ")}]${via}, but never calls ${TITULAR_GUARD}. A caretaker holds a Path-1 ownership row and would pass. Swap the guard for ${TITULAR_GUARD} (lib/infra/pet-access.ts), or document the exception in TITULAR_GATE_ALLOWLIST.`,
    );
  }
  return offenders.sort();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runScan(): void {
  const sources = listScanSources();
  if (sources.length === 0) {
    console.error("✗ check-titular-gate: found no sources to scan.");
    process.exit(1);
  }
  const index = indexTitularEffects(sources);
  if (index.size === 0) {
    console.error(
      "✗ check-titular-gate: the effect index is EMPTY. That is not a clean tree, it is a broken scanner — the codebase provably contains titular-only writers.",
    );
    process.exit(1);
  }

  const offenders = findTitularGateOffenders(sources);
  if (offenders.length > 0) {
    console.error(offenders.join("\n\n"));
    console.error(`\n✗ ${offenders.length} ungated titular-only writer(s).`);
    process.exit(1);
  }

  const allowlisted = Object.keys(TITULAR_GATE_ALLOWLIST).length;
  console.log(
    `✓ titular gate clean — ${sources.length} files scanned, ${index.size} titular-only effect producers indexed, no ungated person-path writer${
      allowlisted > 0 ? ` (${allowlisted} allowlisted)` : ""
    }.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-titular-gate.ts") ||
    process.argv[1].endsWith("check-titular-gate.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
