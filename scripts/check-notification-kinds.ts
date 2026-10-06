// check-notification-kinds — every notification type a writer emits is in the
// registry, and every registry entry names a destination (notificaciones-
// destinos, 2026-10).
//
// THE DEFECT THIS EXISTS FOR
// ---------------------------------------------------------------------------
// `notifications.notification_type` is free text, and for two years each writer
// chose its type and its `cta_url` alone. The 2026-10-06 audit found about sixty
// per cent of kinds landing somewhere the recipient could not open — a case an
// org party cannot read, a pet the recipient no longer holds, a web path with no
// app screen — and nothing could have caught it, because no list of kinds
// existed to check anything against. `@dim/contract/notifications`'
// `NOTIFICATION_KINDS` is that list now, and the server resolver decides every
// destination from it at read time. This fence keeps the list complete: a writer
// that emits a type the registry does not name fails here, before it ships.
//
// WHAT IS CHECKED
// ---------------------------------------------------------------------------
// (a) Every `notificationType` a writer under app/, lib/ or src/ assigns —
//     `notificationType: "x"`, `const notificationType = "x"`, a ternary of
//     literals, or an UPPER_CASE constant (resolved across the tree, including
//     a constant map indexed by a key) — is a key of NOTIFICATION_KINDS.
// (b) A COMPUTED type (a template literal with `${…}`, or a bare lowercase
//     identifier that is not a pass-through) is refused: the fence cannot read
//     it, so neither can a reviewer. Write one literal per value.
// (c) Every registry entry names a destination, and carries the copy its
//     pending actor needs: `action` for `recipient`, `counterpartyAction` for
//     `counterparty`, `informational` for a `none` destination.
// (d) Every registry entry is emitted by some writer (or by SQL — see
//     SQL_WRITTEN_KINDS). A kind nobody writes any more is a stale row in a
//     table people read to learn what exists.
//
// PASS-THROUGH SITES ARE NOT WRITERS. `n.notificationType`,
// `input.notificationType`, `String(row.notificationType)` copy a type some
// other site chose; that other site is the one checked. Type annotations
// (`notificationType: string;`) are skipped for the same reason.
//
// Comments are stripped first, so a docblock that quotes a type does not count
// as emitting it. String contents are kept.
//
// Run: pnpm tsx scripts/check-notification-kinds.ts   (or: pnpm lint:notification-kinds)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  NOTIFICATION_DESTINATIONS,
  NOTIFICATION_KINDS,
  NOTIFICATION_PENDING_ACTORS,
  type NotificationKindSpec,
} from "@dim/contract/notifications";

import { stripComments } from "./lib/strip-comments.mjs";

export const SCAN_DIRS = ["app", "lib", "src"] as const;

/**
 * Kinds written by SQL rather than TypeScript. `welcome` is inserted by the
 * `handle_new_user` trigger (migrations 0091 → 0157); the fence confirms the
 * literal still appears in a migration that inserts notifications.
 */
export const SQL_WRITTEN_KINDS = ["welcome"] as const;

/**
 * Non-vacuity floors, measured 2026-10-06: 230 writer sites, 151 distinct
 * kinds. A glob that stops matching produces no offenders and reads as clean.
 */
export const MIN_WRITER_SITES = 180;
export const MIN_EMITTED_KINDS = 130;

const KIND_LITERAL = /^[a-z][a-z0-9_]*$/;

export type WriterSite = { file: string; line: number; expression: string };
export type KindsViolation = { where: string; reason: string };

function isScannable(rel: string): boolean {
  if (!/\.(ts|tsx)$/.test(rel)) return false;
  if (rel.includes("__tests__/")) return false;
  if (/\.test\.tsx?$/.test(rel)) return false;
  return true;
}

function walk(dir: string, acc: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
}

/**
 * The expression after `notificationType:` / `notificationType =`, up to the
 * first `,` `;` or unmatched closer at depth zero. Strings are skipped whole, so
 * a comma inside a literal does not end the expression.
 */
export function readExpression(src: string, start: number): string {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if ((ch === "," || ch === ";") && depth === 0) break;
    i++;
  }
  return src.slice(start, i).trim();
}

/** The text of a `{ … }` block opening at `open`, strings skipped whole. */
export function readBlock(src: string, open: number): string {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
    i++;
  }
  return src.slice(open + 1);
}

/** Every string literal in an expression whose value looks like a kind. */
export function kindLiterals(expression: string): string[] {
  const out: string[] = [];
  for (const m of expression.matchAll(/(["'`])([^"'`]*)\1/g)) {
    if (KIND_LITERAL.test(m[2])) out.push(m[2]);
  }
  return out;
}

/** UPPER_CASE constants across the tree → the kind-shaped literals in their initializer. */
export function collectConstants(sources: ReadonlyMap<string, string>): Map<string, string[]> {
  const constants = new Map<string, string[]>();
  const decl = /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*/g;
  for (const src of sources.values()) {
    for (const m of src.matchAll(decl)) {
      const start = (m.index ?? 0) + m[0].length;
      // An object initializer is read whole; a scalar one up to its terminator.
      const expression = src[start] === "{" ? readBlock(src, start) : readExpression(src, start);
      const literals = kindLiterals(expression);
      if (literals.length === 0) continue;
      constants.set(m[1], [...(constants.get(m[1]) ?? []), ...literals]);
    }
  }
  return constants;
}

export type Classified =
  | { kind: "literals"; kinds: string[] }
  | { kind: "pass-through" }
  | { kind: "computed"; why: string };

export function classifyExpression(
  expression: string,
  constants: ReadonlyMap<string, string[]>,
): Classified {
  // Shorthand `notificationType,` — the value is a local `notificationType`
  // variable, whose own `const notificationType = "…"` is a site of its own.
  if (expression === "") return { kind: "pass-through" };
  if (/`[^`]*\$\{/.test(expression)) {
    return { kind: "computed", why: "a template literal with ${…} — write one literal per value" };
  }
  const literals = kindLiterals(expression);
  if (literals.length > 0) return { kind: "literals", kinds: literals };
  const constant = expression.match(/^([A-Z][A-Z0-9_]*)\b/);
  if (constant) {
    const resolved = constants.get(constant[1]);
    if (!resolved) {
      return { kind: "computed", why: `constant ${constant[1]} has no kind-shaped literal` };
    }
    return { kind: "literals", kinds: resolved };
  }
  // A member access or a String(…) copies a type chosen elsewhere.
  if (/\.notificationType\b/.test(expression) || /^String\(/.test(expression)) {
    return { kind: "pass-through" };
  }
  // A type annotation, not a value.
  if (/^(string|NotificationKind)\b/.test(expression)) return { kind: "pass-through" };
  return { kind: "computed", why: `\`${expression}\` is not a literal the fence can read` };
}

export function findWriterSites(rel: string, rawSrc: string): WriterSite[] {
  const src = stripComments(rawSrc);
  const sites: WriterSite[] = [];
  const key = /\bnotificationType\s*(?::|=(?!=))\s*/g;
  for (const m of src.matchAll(key)) {
    const start = (m.index ?? 0) + m[0].length;
    const line = src.slice(0, m.index).split("\n").length;
    sites.push({ file: rel, line, expression: readExpression(src, start) });
  }
  return sites;
}

export function checkSpec(name: string, spec: NotificationKindSpec): string[] {
  const problems: string[] = [];
  if (!(NOTIFICATION_DESTINATIONS as readonly string[]).includes(spec.primaryDestination)) {
    problems.push(`has no destination ("${String(spec.primaryDestination)}")`);
  }
  if (!(NOTIFICATION_PENDING_ACTORS as readonly string[]).includes(spec.pendingActor)) {
    problems.push(`has no pending actor ("${String(spec.pendingActor)}")`);
  }
  if (spec.pendingActor === "recipient" && !spec.action?.trim()) {
    problems.push("says the recipient must act but carries no `action` copy");
  }
  if (spec.pendingActor === "counterparty" && !spec.counterpartyAction?.trim()) {
    problems.push("says the counterparty must act but carries no `counterpartyAction` copy");
  }
  if (spec.primaryDestination === "none" && !spec.informational?.trim()) {
    problems.push("opens nothing and carries no `informational` copy explaining why");
  }
  return problems.map((p) => `${name}: ${p}`);
}

export type ScanResult = {
  violations: KindsViolation[];
  siteCount: number;
  emitted: Set<string>;
};

export function checkNotificationKinds(
  sources: ReadonlyMap<string, string>,
  migrations: readonly string[],
  registry: Readonly<Record<string, NotificationKindSpec>> = NOTIFICATION_KINDS,
): ScanResult {
  const violations: KindsViolation[] = [];
  const constants = collectConstants(sources);
  const emitted = new Set<string>();
  let siteCount = 0;

  for (const [rel, src] of sources) {
    for (const site of findWriterSites(rel, src)) {
      siteCount++;
      const where = `${site.file}:${site.line}`;
      const classified = classifyExpression(site.expression, constants);
      if (classified.kind === "computed") {
        violations.push({ where, reason: `computed notificationType: ${classified.why}` });
        continue;
      }
      if (classified.kind === "pass-through") continue;
      for (const kind of classified.kinds) {
        emitted.add(kind);
        if (!Object.prototype.hasOwnProperty.call(registry, kind)) {
          violations.push({
            where,
            reason: `emits "${kind}", which NOTIFICATION_KINDS (packages/contract/src/notifications/kinds.ts) does not name. Add it with its subject, destination and pending actor.`,
          });
        }
      }
    }
  }

  for (const kind of SQL_WRITTEN_KINDS) {
    const written = migrations.some(
      (sql) => /insert\s+into\s+public\.notifications/i.test(sql) && sql.includes(`'${kind}'`),
    );
    if (!written) {
      violations.push({
        where: "db/migrations",
        reason: `SQL_WRITTEN_KINDS lists "${kind}" but no migration inserts it into notifications any more`,
      });
    } else {
      emitted.add(kind);
    }
  }

  for (const [name, spec] of Object.entries(registry)) {
    for (const problem of checkSpec(name, spec)) {
      violations.push({ where: "NOTIFICATION_KINDS", reason: problem });
    }
    if (!emitted.has(name)) {
      violations.push({
        where: "NOTIFICATION_KINDS",
        reason: `${name}: no writer emits this kind any more. Remove it from the registry (stored rows still resolve through UNKNOWN_NOTIFICATION_KIND_SPEC).`,
      });
    }
  }

  return { violations, siteCount, emitted };
}

function runScan(): void {
  const root = process.cwd();
  const sources = new Map<string, string>();
  for (const dir of SCAN_DIRS) {
    const acc: string[] = [];
    walk(join(root, dir), acc);
    for (const abs of acc) {
      const rel = relative(root, abs).split(sep).join("/");
      if (!isScannable(rel)) continue;
      sources.set(rel, readFileSync(abs, "utf8"));
    }
  }
  const migrationDir = join(root, "db", "migrations");
  const migrations = readdirSync(migrationDir)
    .filter((n) => n.endsWith(".sql"))
    .map((n) => readFileSync(join(migrationDir, n), "utf8"));

  const { violations, siteCount, emitted } = checkNotificationKinds(sources, migrations);

  if (siteCount < MIN_WRITER_SITES || emitted.size < MIN_EMITTED_KINDS) {
    console.error(
      `✗ check-notification-kinds: scanned ${siteCount} writer site(s) emitting ${emitted.size} kind(s) — below the floor (${MIN_WRITER_SITES} / ${MIN_EMITTED_KINDS}). The scan stopped finding the writers.`,
    );
    process.exit(1);
  }

  if (violations.length > 0) {
    for (const v of violations) console.error(`${v.where}: ${v.reason}`);
    console.error(`\n✗ ${violations.length} notification-kind violation(s).`);
    process.exit(1);
  }

  console.log(
    `✓ notification kinds clean — ${siteCount} writer site(s), ${emitted.size} kind(s) emitted, all ${Object.keys(NOTIFICATION_KINDS).length} registry entries named with a destination.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-notification-kinds.ts") ||
    process.argv[1].endsWith("check-notification-kinds.js"));

if (isMain) runScan();
