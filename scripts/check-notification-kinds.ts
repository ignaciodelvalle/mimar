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

/**
 * `scripts/` joined in the review (R8): seeds write real rows into the inbox a
 * tester opens, so a seed kind the registry does not name is a notification
 * that resolves under the unknown-kind fallback in every demo.
 */
export const SCAN_DIRS = ["app", "lib", "src", "scripts"] as const;

/** This file names the key in its own strings; it is not a writer. */
const SELF = "scripts/check-notification-kinds.ts";

/**
 * Kinds written by SQL: `db/triggers.sql` (the `handle_new_user` welcome) and
 * every migration's `insert into public.notifications`. Parsed, not listed —
 * see `sqlNotificationKinds`.
 */
export const MIN_SQL_KINDS = 1;

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
  if (rel === SELF) return false;
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

/**
 * UPPER_CASE constants → the kind-shaped literals in each file's initializer,
 * KEPT PER FILE (code review R8). Two files defining the same name are two
 * constants; merging them let a writer "resolve" to literals from a file it
 * never imported.
 */
export type ConstantIndex = Map<string, Map<string, string[]>>;

export function collectConstants(sources: ReadonlyMap<string, string>): ConstantIndex {
  const constants: ConstantIndex = new Map();
  const decl = /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*/g;
  for (const [file, rawSrc] of sources) {
    const src = stripComments(rawSrc);
    for (const m of src.matchAll(decl)) {
      const start = (m.index ?? 0) + m[0].length;
      // An object initializer is read whole; a scalar one up to its terminator.
      const expression = src[start] === "{" ? readBlock(src, start) : readExpression(src, start);
      const literals = kindLiterals(expression);
      if (literals.length === 0) continue;
      const byFile = constants.get(m[1]) ?? new Map<string, string[]>();
      byFile.set(file, [...(byFile.get(file) ?? []), ...literals]);
      constants.set(m[1], byFile);
    }
  }
  return constants;
}

/** The literals a constant name resolves to, as seen from `file`. */
export function resolveConstant(
  name: string,
  file: string,
  constants: ConstantIndex,
): { ok: true; kinds: string[] } | { ok: false; why: string } {
  const byFile = constants.get(name);
  if (!byFile || byFile.size === 0) {
    return { ok: false, why: `constant ${name} has no kind-shaped literal` };
  }
  const own = byFile.get(file);
  if (own) return { ok: true, kinds: own };
  if (byFile.size === 1) return { ok: true, kinds: [...byFile.values()][0] };
  return {
    ok: false,
    why: `constant ${name} is defined in ${byFile.size} files (${[...byFile.keys()].join(", ")}) — the fence cannot tell which one this writer means; rename one`,
  };
}

export type Classified =
  | { kind: "literals"; kinds: string[] }
  | { kind: "pass-through" }
  | { kind: "computed"; why: string };

/** `(x)` → `x`, `x as const` → `x`, repeatedly, only when the parens wrap it all. */
function unwrap(expression: string): string {
  let current = expression.trim();
  for (;;) {
    const before = current;
    current = current.replace(/\s+as\s+const$/, "").trim();
    if (current.startsWith("(") && current.endsWith(")") && closesAtEnd(current)) {
      current = current.slice(1, -1).trim();
    }
    if (current === before) return current;
  }
}

/** Whether the `(` at index 0 is closed by the final character. */
function closesAtEnd(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i === text.length - 1;
    }
  }
  return false;
}

function skipString(text: string, at: number): number {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === "\\") i++;
    i++;
  }
  return i;
}

/**
 * A top-level `cond ? a : b`, split — or `null` when there is none. `?.` and
 * `??` are not the ternary.
 */
export function splitTernary(
  expression: string,
): { cond: string; whenTrue: string; whenFalse: string } | null {
  let depth = 0;
  let question = -1;
  let nested = 0;
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(expression, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === "?") {
      const next = expression[i + 1];
      if (next === "." || next === "?" || expression[i - 1] === "?") continue;
      if (question < 0) question = i;
      else nested++;
    } else if (depth === 0 && ch === ":" && question >= 0) {
      if (nested > 0) {
        nested--;
        continue;
      }
      return {
        cond: expression.slice(0, question),
        whenTrue: expression.slice(question + 1, i),
        whenFalse: expression.slice(i + 1),
      };
    }
  }
  return null;
}

/**
 * One VALUE the key can take: a kind literal, an UPPER_CASE constant (or a map
 * of them indexed by a key), or a ternary whose EVERY arm is one of those.
 * Anything else — a call, a variable, a template with `${}` — is computed: a
 * mixed ternary like `c ? "a" : computeKind()` fails on its second arm.
 */
function classifyValue(value: string, file: string, constants: ConstantIndex): Classified {
  const expression = unwrap(value);
  const ternary = splitTernary(expression);
  if (ternary) {
    const kinds: string[] = [];
    for (const arm of [ternary.whenTrue, ternary.whenFalse]) {
      const classified = classifyValue(arm, file, constants);
      if (classified.kind !== "literals") {
        return classified.kind === "computed"
          ? classified
          : { kind: "computed", why: `ternary arm \`${arm.trim()}\` is not a literal` };
      }
      kinds.push(...classified.kinds);
    }
    return { kind: "literals", kinds };
  }
  const literal = expression.match(/^(["'`])([a-z][a-z0-9_]*)\1$/);
  if (literal) return { kind: "literals", kinds: [literal[2]] };
  const constant = expression.match(/^([A-Z][A-Z0-9_]*)(\[[^\]]+\])?$/);
  if (constant) {
    const resolved = resolveConstant(constant[1], file, constants);
    return resolved.ok
      ? { kind: "literals", kinds: resolved.kinds }
      : { kind: "computed", why: resolved.why };
  }
  return {
    kind: "computed",
    why: `\`${expression}\` is not a literal the fence can read — write one literal per value`,
  };
}

/**
 * A PASS-THROUGH copies a type some other site chose: a plain member access
 * ending in `.notificationType`, optionally inside `String(…)`. Nothing else —
 * `String(anything)` or `f(x.notificationType)` used to slip through as
 * "pass-through" and is computed now (code review R8).
 */
const PASS_THROUGH =
  /^(?:String\(\s*)?[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\.notificationType(?:\s*\))?$/;

export function classifyExpression(
  expression: string,
  constants: ConstantIndex,
  file = "",
): Classified {
  const trimmed = expression.trim();
  // Shorthand `notificationType,` — the value is a local `notificationType`
  // variable, whose own `const notificationType = "…"` is a site of its own.
  if (trimmed === "") return { kind: "pass-through" };
  // A type annotation, not a value.
  if (/^(string|NotificationKind)(\s*\|\s*(null|undefined))*$/.test(trimmed)) {
    return { kind: "pass-through" };
  }
  if (PASS_THROUGH.test(trimmed)) {
    const opens = trimmed.startsWith("String(");
    const closes = trimmed.endsWith(")");
    if (opens === closes) return { kind: "pass-through" };
  }
  return classifyValue(trimmed, file, constants);
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

/**
 * The `notification_type` each SQL `insert into public.notifications (…)
 * values (…)` writes — `db/triggers.sql` (the welcome notification) and the
 * migrations. A value that is not a quoted kind literal is reported.
 */
export function sqlNotificationKinds(sql: string): { kinds: string[]; computed: string[] } {
  const kinds: string[] = [];
  const computed: string[] = [];
  const text = sql.replace(/--[^\n]*/g, "");
  const insert = /insert\s+into\s+public\.notifications\s*\(([^)]*)\)\s*values\s*\(/gi;
  for (const m of text.matchAll(insert)) {
    const columns = m[1].split(",").map((c) => c.trim().toLowerCase());
    const at = columns.indexOf("notification_type");
    if (at < 0) continue;
    const values = splitSqlTuple(text, (m.index ?? 0) + m[0].length);
    const value = values[at]?.trim() ?? "";
    const literal = value.match(/^'([a-z][a-z0-9_]*)'$/);
    if (literal) kinds.push(literal[1]);
    else computed.push(value);
  }
  return { kinds, computed };
}

/** The top-level comma-separated items of a SQL tuple whose `(` precedes `start`. */
function splitSqlTuple(text: string, start: number): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (text[j] === "'") break;
        j++;
      }
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      if (depth === 0) {
        items.push(current);
        return items;
      }
      depth--;
    }
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items;
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
  sqlKinds: number;
};

type Registry = Readonly<Record<string, NotificationKindSpec>>;

function isRegistered(registry: Registry, kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry, kind);
}

/** The TypeScript writers: every site classified, every literal checked. */
function scanTypeScriptWriters(
  sources: ReadonlyMap<string, string>,
  registry: Registry,
  emitted: Set<string>,
  violations: KindsViolation[],
): number {
  const constants = collectConstants(sources);
  let siteCount = 0;
  for (const [rel, src] of sources) {
    for (const site of findWriterSites(rel, src)) {
      siteCount++;
      const where = `${site.file}:${site.line}`;
      const classified = classifyExpression(site.expression, constants, rel);
      if (classified.kind === "computed") {
        violations.push({ where, reason: `computed notificationType: ${classified.why}` });
        continue;
      }
      if (classified.kind === "pass-through") continue;
      for (const kind of classified.kinds) {
        emitted.add(kind);
        if (!isRegistered(registry, kind)) {
          violations.push({
            where,
            reason: `emits "${kind}", which NOTIFICATION_KINDS (packages/contract/src/notifications/kinds.ts) does not name. Add it with its subject, destination and pending actor.`,
          });
        }
      }
    }
  }
  return siteCount;
}

/** The SQL writers (`db/triggers.sql`, migrations). Returns how many kinds they wrote. */
function scanSqlWriters(
  sqlSources: ReadonlyMap<string, string>,
  registry: Registry,
  emitted: Set<string>,
  violations: KindsViolation[],
): number {
  let sqlKinds = 0;
  for (const [rel, sql] of sqlSources) {
    const { kinds, computed } = sqlNotificationKinds(sql);
    for (const value of computed) {
      violations.push({
        where: rel,
        reason: `computed notification_type in SQL (\`${value}\`) — write the kind as a quoted literal`,
      });
    }
    for (const kind of kinds) {
      sqlKinds++;
      emitted.add(kind);
      if (!isRegistered(registry, kind)) {
        violations.push({
          where: rel,
          reason: `SQL emits "${kind}", which NOTIFICATION_KINDS does not name.`,
        });
      }
    }
  }
  return sqlKinds;
}

export function checkNotificationKinds(
  sources: ReadonlyMap<string, string>,
  sqlSources: ReadonlyMap<string, string>,
  registry: Registry = NOTIFICATION_KINDS,
): ScanResult {
  const violations: KindsViolation[] = [];
  const emitted = new Set<string>();
  const siteCount = scanTypeScriptWriters(sources, registry, emitted, violations);
  const sqlKinds = scanSqlWriters(sqlSources, registry, emitted, violations);

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

  return { violations, siteCount, emitted, sqlKinds };
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
  const sqlSources = new Map<string, string>();
  sqlSources.set("db/triggers.sql", readFileSync(join(root, "db", "triggers.sql"), "utf8"));
  const migrationDir = join(root, "db", "migrations");
  for (const n of readdirSync(migrationDir).filter((name) => name.endsWith(".sql"))) {
    sqlSources.set(`db/migrations/${n}`, readFileSync(join(migrationDir, n), "utf8"));
  }

  const { violations, siteCount, emitted, sqlKinds } = checkNotificationKinds(sources, sqlSources);

  if (
    siteCount < MIN_WRITER_SITES ||
    emitted.size < MIN_EMITTED_KINDS ||
    sqlKinds < MIN_SQL_KINDS
  ) {
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
