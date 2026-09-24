// Audit-action declaration fence — every action an app WRITES must be declared.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// __tests__/audit-log-action-check.test.ts already set-compares the DB CHECK
// `audit_log_action_valid` against the TypeScript catalog AUDIT_LOG_ACTIONS. It
// is a good test and it was green the entire time the bug below was live,
// because it compares TWO DECLARATIONS AGAINST EACH OTHER and never compares
// either one against the code that actually writes rows.
//
// The bug it could not see (found 2026-08-23): src/modules/caretakers/actions.ts
// wrote 'caretaker_designated', 'caretaker_grant_accepted' and
// 'caretaker_grant_revoked' from the day custodia-temporal shipped. None was in
// the catalog, so none was in the CHECK. Both sides agreed perfectly — 105
// versus 105, zero difference — about a set that omitted all three. Every insert
// violated the constraint with a 23514, and the module's own `flushAuditLog`
// swallowed it behind a console.error reading "(action did succeed)". The whole
// feature produced ZERO audit rows and nothing anywhere went red.
//
// The escape hatch is the `as typeof auditLog.$inferInsert` cast. `action` is
// typed `AuditLogAction`, so a plain `db.insert(auditLog).values({...})` is
// checked by tsc; the cast erases that check and lets a module mint an action
// nobody declared. The parity test's own header names this exact hazard and
// cites the transfers module's cast as the example — and the caretakers module
// performs the identical cast, and did exactly the thing the header warned about.
//
// WHAT THIS CHECKS
// Derive, FROM SOURCE, every audit action literal the application writes, and
// require each to be present in AUDIT_LOG_ACTIONS. Both sides are read as text,
// so this fence needs no database and no import of the DB client: it fails in
// CI on a clean checkout, before anything is applied anywhere.
//
// IT FENCES THE SUBJECT, NOT THE TWO KNOWN FILES
// ---------------------------------------------------------------------------
// This repo has a documented lesson (memory: "fence enumerates forms, not the
// thing") that a fence which lists the spellings it knows about misses the next
// instance. Naming caretakers/actions.ts and transfers/actions.ts here would
// re-create precisely the hole it is meant to close: the THIRD module to grow a
// local audit helper would be invisible again.
//
// So the subject is "an audit_log write", discovered by deriving a WRITER INDEX
// and then scanning that index's call sites:
//
//   1. DIRECT   — `.insert(auditLog)` … `.values({ action: … })`, the drizzle
//                 write itself, wherever it appears.
//   2. HELPER   — `writeAuditLog(…)` / `buildAuditLogValues(…)`, the shared
//                 lib/infra/audit-log.ts surface.
//   3. RELAY INDEX — any function, anywhere in the scanned tree, that FORWARDS
//                 ITS OWN PARAMETER into (1) or (2), transitively and across
//                 files. Its call sites are then scanned like the real thing.
//                 `flushAuditLog` is not special-cased anywhere below; it is
//                 found because it hands its parameter to
//                 `db.insert(auditLog)`.
//
// "Forwards its parameter" rather than "reaches a write" is load-bearing and
// cost two wrong versions. Reachability is the obvious rule and it is useless
// in a layered codebase: nearly every server action eventually reaches an audit
// write, so the index grew to 626 names over 289 "writer" files and buried the
// signal. A function that writes `{ action: "x" }` in its own body is a WRITE —
// the literal is already visible where it stands and its callers pass nothing.
// Only a function handed the values object by its caller needs its call sites
// followed.
//
// WHY THE INDEX HAD TO BECOME CROSS-FILE (this is the part that was wrong)
// ---------------------------------------------------------------------------
// The first version of this fence resolved wrappers ONE FILE AT A TIME and said
// so in its own limits block: "a wrapper EXPORTED from module A and called in
// module B is registered only where it is declared… a missed offender, never a
// false positive". That understated it badly. Measured on this tree, the file-
// local rule was blind to the repo's DOMINANT shape: 20 audit write sites over
// 16 distinct actions go through `repo.insertAudit*({ action: "…" })` relays —
// the welfare, organizations and surveillance application layers calling their
// own `infrastructure/*-repository.ts`. Named examples:
// src/modules/events/infrastructure/events-repository.ts (insertAuditLog),
// src/modules/organizations/infrastructure/org-repository.ts (insertAuditLog),
// src/modules/welfare/infrastructure/welfare-repository.ts (insertAudit). None
// was visible: never counted as a site, never counted as dynamic residue.
//
// Which makes the sharp version of the point: HAD THE CARETAKERS MODULE
// FOLLOWED THIS REPO'S DOMINANT HEXAGONAL SHAPE (action → repo.insertAudit)
// INSTEAD OF A FILE-LOCAL HELPER, THIS FENCE WOULD NOT HAVE CAUGHT THE BUG IT
// EXISTS TO CATCH. A guardrail that only sees the one layout the bug happened
// to use is a coincidence, not a guardrail.
//
// The technique is borrowed from scripts/check-titular-gate.ts:43-47, which
// propagates effects transitively along same-name call edges for exactly the
// same structural reason: "DIM's layering puts the GUARD in the server action
// and the EFFECT in an application use-case or a repository method, two files
// away". Same layering, same answer. Call edges are matched BY NAME, so two
// different functions sharing a name OVER-taint rather than under-taint — the
// safe direction, since an over-tainted call site with no `action:` key simply
// resolves to nothing.
//
// NON-VACUITY (mandatory, per the same lesson)
// A fence that scans nothing and reports success is worse than no fence. Five
// floors must all hold or the run FAILS:
//   · the catalog parsed out of db/schema.ts is large (>= 100 actions),
//   · at least MIN_WRITERS names made it into the writer index,
//   · at least MIN_FILES distinct files were found to write audit rows,
//   · at least MIN_SITES write sites were found,
//   · at least MIN_ACTIONS distinct action literals were resolved.
// If a refactor renames the drizzle table symbol or moves the helper, these trip
// instead of the fence silently passing over a corpus it can no longer see.
//
// KNOWN LIMITS — stated, not hidden. A fence's honesty about its own blind
// spots is what makes the next reader trust the parts that do work.
//   · REGEX/SCANNER, NOT AST — same tradeoff as every sibling linter here.
//     Comments are stripped first so a mention in prose cannot register.
//   · NAME-KEYED CALL EDGES. `obj.method(…)` and a bare `method(…)` are the same
//     edge to this scanner, and a method reached through a variable whose name
//     differs from the declaration (`const fn = repo.insertAudit; fn({…})`) is
//     not an edge at all. Over-taint is harmless here; that last shape is a
//     genuine miss, and no occurrence exists on this tree.
//   · INDIRECT VALUES OBJECTS are resolved ONE HOP and only through a
//     file-local `const`: `const values = { action: "x" }; …values(values)` is
//     read, and so is `map[expr]` over a local literal map. A values object
//     assembled conditionally, spread from another object, or imported from a
//     second file is not — it lands in the dynamic residue below rather than
//     passing silently, which is the whole point. NOTE: zero occurrences of the
//     hoisted shape exist on this tree, so a run reporting "0 via a hoisted
//     values object" is honest rather than reassuring; the capability is
//     exercised by __tests__/check-audit-log-actions-declared.test.ts.
//   · RELAY PASS-THROUGH. A writer whose own body forwards a PARAMETER
//     (`insertAudit(values) { db.insert(auditLog).values(values) }`) carries no
//     literal, and counting it as residue would double-count: the literal lives
//     at its call sites, which the cross-file index now reaches. Those bodies
//     are counted and printed as pass-through, not as writes.
//   · DYNAMIC ACTIONS. `action: someVariable` cannot be resolved to a literal.
//     A ternary between two literals IS resolved (to both), and so is a
//     single-hop local `const x = "literal"`. What remains is counted, printed
//     on every run, and frozen at EXPECTED_DYNAMIC, enforced as an equality so
//     the number cannot drift upward OR go stale. See the ratchet in `main()`.
//
// Run: pnpm tsx scripts/check-audit-log-actions-declared.ts
//      (or: pnpm lint:audit-actions)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { stripComments } from "./lib/strip-comments.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");

/** Trees that can contain application code writing audit rows. */
const SCAN_ROOTS = ["app", "lib", "src", "scripts", "db"];

/** Directory names never worth walking into. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "__tests__",
  "__mocks__",
  // Forward-only SQL, not TypeScript. The migrations carry the CHECK, and the
  // parity TEST is what compares the CHECK to the catalog — not this fence.
  "migrations",
]);

/** Non-vacuity floors. Raise them if the corpus grows; never lower to pass. */
// Measured 2026-08-23 on the cross-file index: 5 writer names, 90 writer files,
// 105 sites, 87 distinct actions. Floors sit below those with headroom — they
// exist to catch a scanner that has gone blind, not to pin the corpus.
const MIN_CATALOG = 100;
const MIN_WRITERS = 4;
const MIN_FILES = 60;
const MIN_SITES = 80;
const MIN_ACTIONS = 60;

/**
 * Audit writes whose action is not statically resolvable — a `string`-typed
 * value reaching the insert with nothing static to say what it is:
 *   · lib/infra/eno-queue-processor.ts — replays `row.action` off a queue row
 *   · src/modules/surveillance/infrastructure/surveillance-repository.ts —
 *     `insertOutbreakAuditLog(values)` forwards its caller's string
 *
 * STILL TWO after the cross-file index landed, which is the point worth
 * keeping: the scan went from 83 sites / 71 actions to 105 / 87, and every one
 * of the newly-visible writes resolved to a literal. The third candidate it
 * surfaced — decide-capability.ts's `actionByDecision[input.decision]` — is now
 * read through resolveLocalLiteralMap instead of being parked here.
 *
 * Enforced as an EQUALITY, not a ceiling: see the ratchet block in `main()`.
 * Every entry is printed on every run, so this number is never a mystery.
 */
const EXPECTED_DYNAMIC = 2;

/** The shared surface in lib/infra/audit-log.ts — the index's other seed. */
const SEED_WRITERS = ["writeAuditLog", "buildAuditLogValues"] as const;

/** Cheap prefilter: a file with none of these cannot seed the index. */
const SEED_MARKERS = ["auditLog", ...SEED_WRITERS];

// ---------------------------------------------------------------------------
// Balanced scanning — string- and template-aware, so a brace or paren inside a
// string literal cannot desynchronise the depth counter.
// ---------------------------------------------------------------------------

type Delims = { open: string; close: string };

/**
 * Index of the delimiter matching the one at `start`, or -1.
 * `text` must already have had comments stripped.
 */
function matchDelimiter(text: string, start: number, { open, close }: Delims): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const PARENS: Delims = { open: "(", close: ")" };
const BRACES: Delims = { open: "{", close: "}" };

/**
 * Index of the `{` that opens a function body, starting the search at `from`.
 *
 * NOT `indexOf("{")`. A return annotation carries braces — `Promise<{ id:
 * string }>` — and the naive search lands inside the TYPE, so the "body" of
 * `writeAuditLog` read as `{ id: string }` and the function that wraps the
 * repo's only shared audit helper was not recognisable as a relay. The walk
 * waits for a brace at angle-depth zero, the same correction
 * scripts/check-titular-gate.ts had to make in its own walker.
 */
function findBodyStart(source: string, from: number): number {
  let angle = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "{" && angle === 0) return i;
  }
  return -1;
}

/**
 * Character ranges covered by string and template literals.
 *
 * Comments are stripped before anything else runs, but STRINGS are not, and a
 * fence's own help text is full of example code: scripts/check-audit-log-
 * coverage.ts prints `await writeAuditLog(tx, { action, … })` as advice, and
 * that read as a live call site with an unresolvable action. Prose about the
 * subject must not register as the subject.
 */
function stringSpans(source: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch !== '"' && ch !== "'" && ch !== "`") continue;
    const start = i;
    for (i++; i < source.length; i++) {
      if (source[i] === "\\") i++;
      else if (source[i] === ch) break;
    }
    spans.push([start, Math.min(i, source.length - 1)]);
  }
  return spans;
}

function inSpans(spans: Array<[number, number]>, index: number): boolean {
  return spans.some(([a, b]) => index > a && index < b);
}

/** 1-based line number of a character offset. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Every `action:` value written at the TOP LEVEL of an object literal inside
 * `args` — the argument text of one audit-write call.
 *
 * Depth matters: `flushAuditLog({ action: "x", payload: { action: "y" } })`
 * writes "x". "y" is a payload field that happens to share the name and is not
 * an audit action at all. Only brace depth 1 counts.
 */
function topLevelActionValues(args: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    // A key named `action`, quoted or bare, followed by a colon.
    const rest = args.slice(i);
    const m = /^(?:action|"action"|'action')\s*:\s*/.exec(rest);
    if (!m) continue;
    // Guard against matching the tail of a longer identifier (`sub_action:`).
    const prev = args[i - 1];
    if (prev && /[A-Za-z0-9_$]/.test(prev)) continue;
    found.push(rest.slice(m[0].length));
    i += m[0].length - 1;
  }
  return found;
}

/** The literal at the head of `expr`, or null. */
function headLiteral(expr: string): string | null {
  const m = /^\s*(["'])((?:[^\\]|\\.)*?)\1/.exec(expr);
  if (m) return m[2].replace(/\\(.)/g, "$1");
  // A backtick with no interpolation is still a literal.
  const t = /^\s*`([^`$\\]*)`/.exec(expr);
  return t ? t[1] : null;
}

/**
 * Every literal an `action:` value expression can evaluate to, or null when it
 * is not statically resolvable.
 *
 * A ternary between two literals is resolved to BOTH branches, not treated as
 * dynamic: `role === "admin" ? "institutional_admin_created" :
 * "institutional_govt_created"` writes one of exactly two known actions and
 * both must be declared. Collapsing that to "unresolvable" would have hidden a
 * genuine pair behind an escape hatch.
 */
function literalsOf(valueExpr: string): string[] | null {
  const direct = headLiteral(valueExpr);
  if (direct !== null) return [direct];

  const question = valueExpr.indexOf("?");
  if (question !== -1) {
    const rest = valueExpr.slice(question + 1);
    const consequent = headLiteral(rest);
    if (consequent !== null) {
      const colon = rest.indexOf(":", rest.indexOf(consequent) + consequent.length);
      const alternate = colon === -1 ? null : headLiteral(rest.slice(colon + 1));
      if (alternate !== null) return [consequent, alternate];
    }
  }
  return null;
}

/**
 * `actionByDecision[input.decision]` → every literal value of the file-local
 * `const actionByDecision = { … } as const`.
 *
 * Same argument as the ternary rule above: an indexed lookup writes one of a
 * closed set of known actions and every one of them must be declared, so
 * collapsing it to "unresolvable" would hide a genuine set behind an escape
 * hatch. It was hiding one — decide-capability.ts routes capability_granted /
 * capability_denied / capability_revoked through exactly this shape, and the
 * cross-file index is what made the site visible in the first place.
 *
 * Only VALUES are read; a quoted key is not an action.
 */
function resolveLocalLiteralMap(source: string, valueExpr: string): string[] | null {
  const id = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\[/.exec(valueExpr);
  if (!id) return null;
  const literal = resolveLocalObjectLiteral(source, id[1]);
  if (literal === null) return null;
  const values = [...literal.matchAll(/:\s*(["'])((?:[^\\]|\\.)*?)\1/g)].map((m) =>
    m[2].replace(/\\(.)/g, "$1"),
  );
  return values.length > 0 ? values : null;
}

/** Resolve a bare identifier against a `const x = "literal"` in the same file. */
function resolveLocalConst(source: string, valueExpr: string): string | null {
  const id = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|\}|$)/.exec(valueExpr);
  if (!id) return null;
  const decl = new RegExp(`\\bconst\\s+${id[1]}\\s*(?::[^=]+)?=\\s*(["'])((?:[^\\\\]|\\\\.)*?)\\1`);
  const m = decl.exec(source);
  return m ? m[2].replace(/\\(.)/g, "$1") : null;
}

/** A call's arguments, split at depth 0. */
function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out;
}

/** The first argument's text in a call's argument list, split at depth 0. */
function firstArgument(args: string): string {
  return topLevelArgs(args)[0] ?? args;
}

/** `values`, `values as NewAuditLogRow` → "values". Anything richer → null. */
function bareIdentifier(expr: string): string | null {
  const m = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:as\s+[A-Za-z0-9_$.<>[\]| ]+)?\s*$/.exec(expr);
  return m ? m[1] : null;
}

/**
 * The `{ … }` initialiser of a file-local `const <id> = { … }`, or null.
 *
 * This is the second blind spot the 2026-08-23 review reproduced: hoisting the
 * values object out of the call (`const values = { action: "x" }; …
 * .values(values)`) made the write invisible AND kept it out of the dynamic
 * ratchet, so it was not flagged and not counted. One hop is enough for every
 * occurrence on this tree; deeper indirection lands in the residue instead.
 */
function resolveLocalObjectLiteral(source: string, id: string): string | null {
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*(?::[^=;]+)?=\\s*\\{`);
  const m = decl.exec(source);
  if (!m) return null;
  const open = source.indexOf("{", (m.index ?? 0) + m[0].length - 1);
  if (open === -1) return null;
  const close = matchDelimiter(source, open, BRACES);
  if (close === -1) return null;
  return source.slice(open, close + 1);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function listSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
      if (/\.d\.ts$/.test(entry)) continue;
      out.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

/** The declared catalog, parsed out of db/schema.ts as TEXT (no DB import). */
function parseDeclaredActions(): Set<string> {
  const schemaPath = join(REPO_ROOT, "db", "schema.ts");
  const src = stripComments(readFileSync(schemaPath, "utf8")) as string;
  const start = src.indexOf("AUDIT_LOG_ACTIONS");
  if (start === -1) {
    throw new Error("AUDIT_LOG_ACTIONS not found in db/schema.ts — this fence cannot see its side");
  }
  const openBracket = src.indexOf("[", start);
  const close = matchDelimiter(src, openBracket, { open: "[", close: "]" });
  if (openBracket === -1 || close === -1) {
    throw new Error("AUDIT_LOG_ACTIONS array literal is unparseable in db/schema.ts");
  }
  const body = src.slice(openBracket, close);
  return new Set([...body.matchAll(/(["'])((?:[^\\]|\\.)*?)\1/g)].map((m) => m[2]));
}

// ---------------------------------------------------------------------------
// Function extraction — one entry per function-like declaration in a file
// ---------------------------------------------------------------------------

type FileFn = {
  name: string;
  /** Offset of the `(` opening the PARAMETER LIST — never an argument list. */
  declParen: number;
  /** Parameter-list text, used to tell a relay's pass-through from a real value. */
  params: string;
  /** Body text, braces included. */
  body: string;
  /** Body span, so a call site can find the function it sits inside. */
  start: number;
  end: number;
  /**
   * Reachable from another file — `export`ed, or a method sitting at its own
   * indented line (`async insertAudit(…) {`), which is how every `*Repository`
   * in this codebase spells its surface.
   *
   * THIS IS THE BRAKE ON NAME-KEYED PROPAGATION, and it was learned the
   * expensive way: without it the first cross-file index grew to 626 names and
   * 289 "writer" files, because a one-off `async function main()` in a seed
   * script contains an audit insert, and every OTHER script also has a `main`.
   * A generic private name is a within-file fact; only a name another file can
   * actually import or call has any business crossing a file boundary.
   */
  reachable: boolean;
};

// Control-flow keywords wear the shape `name(…) {…}` without being functions.
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "with"]);

// Four declaration shapes, because a helper is a helper however it is spelled:
//   function f(…) {}            — plain declaration
//   const f = (…) => {}         — arrow bound to a const
//   f: (…) => {} / f: async …   — object-literal property (a deps bag)
//   async f(…) {}               — class or object method
//
// Each alternative ends at the name; the parameter list and body are found by
// WALKING, never by `indexOf("{")`. That shortcut is what the first version of
// this fence did, and it was silently wrong: `flushAuditLog(entry: { … })`
// annotates its parameter with an inline object type, so the first `{` after
// the name opens the TYPE, not the body. The scan read the type literal, found
// no `.insert(auditLog)` in it, and never registered the single most important
// wrapper in the repo — the fence reported a clean pass over the exact bug it
// was written for. Caught by deleting a declared action and watching it stay
// green; the lesson is that a fence must be tested by being made to fail.
const DECL =
  /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)|(?:^|\s)(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?=\()|(?:^|[\s{,])([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(?:async\s*)?(?=\()|(?:^|[\s{;])(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=\()/g;

/** True when the match begins at column 0 or on nothing but indentation. */
function isLineLeading(source: string, index: number): boolean {
  const newline = source.lastIndexOf("\n", index);
  return /^[ \t]*$/.test(source.slice(newline + 1, index));
}

function extractFunctions(source: string): FileFn[] {
  const out: FileFn[] = [];
  for (const m of source.matchAll(DECL)) {
    const name = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!name || KEYWORDS.has(name)) continue;
    // Reachable from elsewhere: an `export`, or a method/property declared on
    // its own line — `async insertAudit(…) {`, `insertAudit: async (…) =>`.
    // A private helper buried mid-expression is a within-file fact only.
    const exported = /\bexport\s/.test(m[0]);
    const method =
      (m[3] !== undefined || m[4] !== undefined) && isLineLeading(source, m.index ?? 0);
    const reachable = exported || method;

    // Parameter list: the first `(` after the declaration, walked to its match.
    const openParen = source.indexOf("(", (m.index ?? 0) + m[0].length - 1);
    if (openParen === -1) continue;
    const closeParen = matchDelimiter(source, openParen, PARENS);
    if (closeParen === -1) continue;

    // Body: the first `{` after the parameter list at angle-depth zero, so a
    // `Promise<{ … }>` return annotation cannot be mistaken for it.
    const braceAt = findBodyStart(source, closeParen);
    if (braceAt === -1) continue;
    // Anything other than `=>`, `:` and whitespace between them means this was
    // a CALL that happens to be followed by an unrelated block, not a body.
    // Generic groups are elided first so `Promise<{ id: string }>` does not
    // trip the check with the very braces findBodyStart just walked past.
    const between = source
      .slice(closeParen + 1, braceAt)
      .replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, "");
    if (!/^[\s:=>a-zA-Z0-9_$<>,.[\]|&?]*$/.test(between)) continue;

    const end = matchDelimiter(source, braceAt, BRACES);
    if (end === -1) continue;

    out.push({
      name,
      declParen: openParen,
      params: source.slice(openParen + 1, closeParen),
      body: source.slice(braceAt, end),
      start: braceAt,
      end,
      reachable,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 1 — the writer index, transitive and cross-file
// ---------------------------------------------------------------------------

export type SourceFile = {
  rel: string;
  raw: string;
  /** Comment-stripped source, parsed once and memoised. */
  src(): string;
  /** Function declarations, parsed once and memoised. */
  fns(): FileFn[];
};

/** One scannable file, from disk or from a test's fixture string. */
export function makeSourceFile(rel: string, raw: string): SourceFile {
  let stripped: string | null = null;
  let fns: FileFn[] | null = null;
  const file: SourceFile = {
    rel,
    raw,
    src() {
      if (stripped === null) stripped = stripComments(raw) as string;
      return stripped;
    },
    fns() {
      if (fns === null) fns = extractFunctions(file.src());
      return fns;
    },
  };
  return file;
}

/** Exported so a negative check can be run against the REAL tree, not fixtures. */
export function loadSources(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const full of listSourceFiles()) {
    const rel = relative(REPO_ROOT, full).split(sep).join("/");
    // This fence's own source names every marker it looks for; scanning it would
    // report its own regexes as write sites. Excluded by IDENTITY, not by a
    // pattern that could ever exclude a real writer.
    if (rel === "scripts/check-audit-log-actions-declared.ts") continue;
    out.push(makeSourceFile(rel, readFileSync(full, "utf8")));
  }
  return out;
}

/** `name(` for any of `names`, as one alternation. */
function callProbe(names: Iterable<string>): RegExp {
  return new RegExp(`\\b(?:${[...names].join("|")})\\s*\\(`);
}

/**
 * The argument text of every audit write inside `text` — the drizzle
 * `.values(…)` and every call of a known writer name.
 */
function auditCallArgs(text: string, writers: Iterable<string>, self?: string): string[] {
  const out: string[] = [];
  const spans = stringSpans(text);
  const take = (openParen: number): void => {
    if (inSpans(spans, openParen)) return;
    const close = matchDelimiter(text, openParen, PARENS);
    if (close !== -1) out.push(text.slice(openParen + 1, close));
  };
  for (const m of text.matchAll(/\.insert\(\s*auditLog\s*\)/g)) {
    const after = (m.index ?? 0) + m[0].length;
    const values = text.indexOf(".values(", after);
    if (values !== -1 && !text.slice(after, values).includes(";")) take(values + ".values".length);
  }
  for (const name of writers) {
    if (name === self) continue;
    for (const m of text.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
      take((m.index ?? 0) + m[0].length - 1);
    }
  }
  return out;
}

/**
 * A RELAY forwards its own parameter into an audit write, so the action literal
 * lives at ITS call sites rather than in its body.
 *
 * THIS PREDICATE IS THE WHOLE BRAKE ON THE INDEX, and it took two wrong
 * versions to find. "Reaches an audit write, transitively" is the obvious rule
 * and it is useless here: in a layered codebase almost every server action
 * eventually reaches one, so the index grew to 626 names, then 389 after
 * restricting it to exported/method names, and drowned the corpus in call sites
 * that carry no action at all. A function whose body writes `{ action: "x" }`
 * is not a relay — the literal is already visible where it stands, and its own
 * callers pass nothing. Only a function handed the values object by its caller
 * needs its call sites scanned, and that is exactly what this asks.
 */
function isRelay(fn: FileFn, writers: Iterable<string>): boolean {
  const names = [...writers];
  for (const args of auditCallArgs(fn.body, names, fn.name)) {
    // If the action literal is RIGHT THERE, this is a write, not a relay — the
    // callers pass nothing worth following. Checked before the parameter test
    // because `writeAuditLog(tx, { action: "x" })` forwards the EXECUTOR, and
    // taking that as evidence of a relay made every server action with a `tx`
    // parameter a writer whose own call sites got scanned (`executeDecomiso-
    // Action(input)` in a client component, resolving to nothing).
    if (topLevelActionValues(args).length > 0) continue;
    for (const arg of topLevelArgs(args)) {
      // `values`, `values as NewAuditLogRow` and `{ ...values }` all forward.
      const text = arg.trim();
      const id = bareIdentifier(text) ?? /^\{\s*\.\.\.([A-Za-z_$][A-Za-z0-9_$]*)/.exec(text)?.[1];
      if (!id) continue;
      if (new RegExp(`\\b${id}\\b`).test(fn.params)) return true;
    }
  }
  return false;
}

/**
 * Every relay declared IN ONE FILE, to a fixpoint.
 *
 * The fixpoint is what closes the two-hop wrapper the 2026-08-23 review
 * reproduced: `high(v)` → `low(v)` → insert. A single pass registers `low` and
 * stops, so every call site of `high` — the one a module actually calls — stays
 * invisible. Seeded with the cross-file names so a local helper forwarding into
 * `repo.insertAudit` is a relay too.
 */
function localWriters(file: SourceFile, global: Set<string>): Set<string> {
  const names = new Set<string>();
  for (let pass = 0; pass < 10; pass++) {
    let grew = false;
    for (const fn of file.fns()) {
      if (names.has(fn.name) || global.has(fn.name)) continue;
      if (!isRelay(fn, [...global, ...names])) continue;
      names.add(fn.name);
      grew = true;
    }
    if (!grew) break;
  }
  return names;
}

/**
 * Writer names that may cross a file boundary, to a fixpoint.
 *
 * The check-titular-gate.ts technique — propagate along same-name call edges,
 * because "DIM's layering puts the GUARD in the server action and the EFFECT in
 * an application use-case or a repository method, two files away" — with one
 * addition that fence did not need: only REACHABLE names are admitted. Its
 * subject set is small and specific; this one is seeded by "any function
 * containing an audit insert", which on this tree includes a one-off
 * `async function main()` in a seed script. Propagating that name grew the
 * index to 626 names over 289 files and buried the real signal in noise.
 */
function indexAuditWriters(files: SourceFile[]): Set<string> {
  const global = new Set<string>(SEED_WRITERS);

  for (let pass = 0; pass < 10; pass++) {
    const probe = callProbe(global);
    let grew = false;
    for (const file of files) {
      // A file that neither names the drizzle table nor calls a known writer
      // cannot contribute — which keeps the parser off ~1900 files.
      if (!SEED_MARKERS.some((marker) => file.raw.includes(marker)) && !probe.test(file.raw)) {
        continue;
      }
      const local = localWriters(file, global);
      for (const fn of file.fns()) {
        if (!fn.reachable) continue;
        if (global.has(fn.name)) continue;
        if (!local.has(fn.name)) continue;
        global.add(fn.name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return global;
}

// ---------------------------------------------------------------------------
// Phase 2 — call sites
// ---------------------------------------------------------------------------

type Site = { file: string; line: number; offset: number; args: string };

/** Every audit-write call site in one file, given that file's writer names. */
function auditWriteSites(file: SourceFile, writers: Iterable<string>): Site[] {
  const source = file.src();
  const spans = stringSpans(source);
  const sites: Site[] = [];
  const push = (openParen: number): void => {
    // Example code inside a help string is prose, not a call site.
    if (inSpans(spans, openParen)) return;
    const close = matchDelimiter(source, openParen, PARENS);
    if (close === -1) return;
    sites.push({
      file: file.rel,
      line: lineOf(source, openParen),
      offset: openParen,
      args: source.slice(openParen + 1, close),
    });
  };

  // 1. DIRECT — the drizzle write. Take the `.values(` that follows the insert.
  for (const m of source.matchAll(/\.insert\(\s*auditLog\s*\)/g)) {
    const after = (m.index ?? 0) + m[0].length;
    const values = source.indexOf(".values(", after);
    // Only when it is the same chain — no statement boundary in between.
    if (values !== -1 && !source.slice(after, values).includes(";")) {
      push(values + ".values".length);
    }
  }

  // 2/3. Every indexed writer name called here. A writer's own parameter list
  // looks exactly like a call to a regex, so declarations are excluded by exact
  // offset — precise where "is the preceding token `function`?" is not, since
  // class methods and object properties carry no such keyword.
  const names = new Set(writers);
  const declarationParens = new Set(
    file
      .fns()
      .filter((fn) => names.has(fn.name))
      .map((fn) => fn.declParen),
  );
  for (const name of names) {
    if (!file.raw.includes(name)) continue;
    for (const m of source.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
      const openParen = (m.index ?? 0) + m[0].length - 1;
      if (declarationParens.has(openParen)) continue;
      push(openParen);
    }
  }
  return sites;
}

/** The innermost indexed function whose body contains `offset`. */
function enclosingFunction(fns: FileFn[], offset: number): FileFn | null {
  let best: FileFn | null = null;
  for (const fn of fns) {
    if (offset < fn.start || offset > fn.end) continue;
    if (best === null || fn.start > best.start) best = fn;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Scan = {
  undeclared: Array<{ file: string; line: number; action: string }>;
  unresolved: Array<{ file: string; line: number; expr: string }>;
  writerFiles: Set<string>;
  seenActions: Set<string>;
  siteCount: number;
  /** Relay bodies forwarding a parameter — literal-free by construction. */
  passThroughCount: number;
  /** Sites whose values object was hoisted into a file-local `const`. */
  indirectCount: number;
};

/**
 * The `action:` value expressions one site writes.
 *
 * `null` means the site carried nothing to check and has already been booked as
 * pass-through or residue; `[]` means it is not an action-bearing call at all.
 */
function siteActionExprs(file: SourceFile, site: Site, scan: Scan): string[] | null {
  const direct = topLevelActionValues(site.args);
  if (direct.length > 0) return direct;

  // No `action:` in the argument text. Either the values object was hoisted
  // into a local const (resolvable, and a real write), or the argument is a
  // parameter this function is forwarding (a relay — the literal lives at its
  // call sites, which the cross-file index now reaches), or it is opaque and
  // belongs in the dynamic residue.
  const id = bareIdentifier(firstArgument(site.args));
  if (id === null) return [];

  const literal = resolveLocalObjectLiteral(file.src(), id);
  if (literal !== null) {
    const exprs = topLevelActionValues(literal);
    if (exprs.length > 0) scan.indirectCount++;
    return exprs;
  }

  const owner = enclosingFunction(file.fns(), site.offset);
  if (owner !== null && new RegExp(`\\b${id}\\b`).test(owner.params)) {
    scan.passThroughCount++;
    return null;
  }
  scan.unresolved.push({ file: file.rel, line: site.line, expr: id });
  return null;
}

/** Classify every action literal written by one file. */
function scanFile(file: SourceFile, global: Set<string>, declared: Set<string>, scan: Scan): void {
  // Cross-file relays PLUS this file's own wrappers, including the ones a
  // sibling module can never see.
  const writers = new Set([...global, ...localWriters(file, global)]);
  const sites = auditWriteSites(file, writers);
  if (sites.length === 0) return;
  const source = file.src();
  let wrote = false;

  for (const site of sites) {
    const exprs = siteActionExprs(file, site, scan);
    if (exprs === null) {
      wrote = true;
      continue;
    }
    if (exprs.length === 0) continue;

    scan.siteCount++;
    wrote = true;
    for (const expr of exprs) {
      const fromConst = resolveLocalConst(source, expr);
      const literals =
        literalsOf(expr) ??
        resolveLocalLiteralMap(source, expr) ??
        (fromConst === null ? null : [fromConst]);
      if (literals === null) {
        scan.unresolved.push({ file: file.rel, line: site.line, expr: expr.slice(0, 60).trim() });
        continue;
      }
      for (const literal of literals) {
        scan.seenActions.add(literal);
        if (!declared.has(literal)) {
          scan.undeclared.push({ file: file.rel, line: site.line, action: literal });
        }
      }
    }
  }

  if (wrote) scan.writerFiles.add(file.rel);
}

/**
 * Index the writers and scan the corpus in one call.
 *
 * Exported so __tests__/check-audit-log-actions-declared.test.ts can drive it
 * over fixture strings. A fence must be tested BY BEING MADE TO FAIL — the
 * header records that the first version passed cleanly over the exact bug it
 * was written for, and nobody noticed until a declared action was deleted by
 * hand to see whether it went red.
 */
export function analyze(
  files: SourceFile[],
  declared: Set<string>,
): { writers: Set<string>; scan: Scan } {
  const writers = indexAuditWriters(files);
  return { writers, scan: scanCorpus(files, writers, declared) };
}

function scanCorpus(files: SourceFile[], writers: Set<string>, declared: Set<string>): Scan {
  const scan: Scan = {
    undeclared: [],
    unresolved: [],
    writerFiles: new Set(),
    seenActions: new Set(),
    siteCount: 0,
    passThroughCount: 0,
    indirectCount: 0,
  };
  const probe = callProbe(writers);
  for (const file of files) {
    // A file that neither mentions the drizzle table nor calls any indexed
    // writer cannot contain a site. Everything else is parsed in full.
    if (!file.raw.includes("auditLog") && !probe.test(file.raw)) continue;
    scanFile(file, writers, declared, scan);
  }
  return scan;
}

/** The floors that stop a blind fence from reporting success. */
function nonVacuityProblems(declared: Set<string>, writers: Set<string>, scan: Scan): string[] {
  const problems: string[] = [];
  if (declared.size < MIN_CATALOG) {
    problems.push(
      `NON-VACUITY: parsed only ${declared.size} actions out of AUDIT_LOG_ACTIONS ` +
        `(floor ${MIN_CATALOG}). The catalog parser has lost sight of db/schema.ts.`,
    );
  }
  if (writers.size < MIN_WRITERS) {
    problems.push(
      `NON-VACUITY: the writer index holds only ${writers.size} name(s) (floor ${MIN_WRITERS}). The seed markers or the relay propagation have stopped matching.`,
    );
  }
  if (scan.writerFiles.size < MIN_FILES) {
    problems.push(
      `NON-VACUITY: found audit writes in only ${scan.writerFiles.size} file(s) ` +
        `(floor ${MIN_FILES}). Discovery is broken — this fence is scanning almost nothing.`,
    );
  }
  if (scan.siteCount < MIN_SITES) {
    problems.push(
      `NON-VACUITY: found only ${scan.siteCount} audit write site(s) (floor ${MIN_SITES}).`,
    );
  }
  if (scan.seenActions.size < MIN_ACTIONS) {
    problems.push(
      `NON-VACUITY: resolved only ${scan.seenActions.size} distinct action(s) ` +
        `(floor ${MIN_ACTIONS}).`,
    );
  }
  return problems;
}

function main(): void {
  const declared = parseDeclaredActions();
  const { writers, scan } = analyze(loadSources(), declared);
  const { undeclared, unresolved, writerFiles, seenActions, siteCount } = scan;

  const problems: string[] = nonVacuityProblems(declared, writers, scan);

  // --- The rule itself -----------------------------------------------------
  for (const u of undeclared) {
    problems.push(
      [
        `${u.file}:${u.line} writes audit action '${u.action}', which is NOT in AUDIT_LOG_ACTIONS.`,
        "    The DB CHECK audit_log_action_valid will reject the insert with a 23514 — and if",
        "    the writer swallows errors, silently. Add it to db/schema.ts AND to a forward-only",
        "    migration amending the CHECK.",
      ].join("\n"),
    );
  }
  // --- The dynamic residue, ratcheted in BOTH directions -------------------
  // What is left after literals, ternaries of literals, single-hop consts and
  // hoisted values objects have all been resolved: an action that arrives as a
  // plain `string` with no local declaration to read it off.
  //
  // These are the caretakers bug in miniature — a `string`-typed value erases
  // the union check exactly like `as typeof auditLog.$inferInsert` did — so they
  // are counted, printed on every run, and frozen. A NEW one fails the build;
  // removing one and not lowering the number also fails it, because a ratchet
  // that only moves one way is how a baseline goes stale (the lesson
  // scripts/check-audit-log-coverage.ts records about its own baseline).
  if (unresolved.length !== EXPECTED_DYNAMIC) {
    problems.push(
      [
        `DYNAMIC-ACTION RATCHET: ${unresolved.length} non-literal audit action(s), expected exactly ${EXPECTED_DYNAMIC}.`,
        unresolved.length > EXPECTED_DYNAMIC
          ? "    A new one appeared — give it a string literal, or a ternary of literals, so this fence can check it."
          : "    One was removed — lower EXPECTED_DYNAMIC in this file to lock the gain in.",
        ...unresolved.map((u) => `    · ${u.file}:${u.line} — ${u.expr}`),
      ].join("\n"),
    );
  }

  const tally = [
    `Indexed ${writers.size} writer name(s); scanned ${writerFiles.size} writer file(s),`,
    `${siteCount} write site(s) (${scan.indirectCount} via a hoisted values object,`,
    `${scan.passThroughCount} relay pass-through),`,
    `${seenActions.size} distinct action(s) against ${declared.size} declared.`,
  ].join(" ");

  if (problems.length > 0) {
    console.error("\naudit-action declaration fence — FAILED\n");
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`\n${tally}\n`);
    process.exit(1);
  }

  console.log(`audit-action declaration fence: ok — ${tally} All declared.`);
}

// Importing this module (the test does) must not run the scan or call
// process.exit. Same guard shape as scripts/check-titular-gate.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-audit-log-actions-declared.ts") ||
    process.argv[1].endsWith("check-audit-log-actions-declared.js"));

if (isMain) main();
