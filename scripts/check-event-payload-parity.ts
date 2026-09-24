// Reader-writer payload parity linter (task #76).
//
// Motivation: 2026-07-04's ghost-payload class — panorama/analytics code read
// `payload->>'key'` (or `.payload.key`) keys that NO writer schema in
// lib/events/event-schemas.ts actually emits (only a one-off raw-insert seed
// did). 14+ surfaces were silently empty of real data because Postgres
// returns NULL for a missing JSONB key instead of erroring — the bug was
// invisible until someone diffed the dashboard against the raw event log
// (see commits c01bec56 / 9e57a7b7). This linter makes that class impossible
// to reintroduce silently: every payload key read anywhere in app/, src/, or
// lib/ must be a key some event schema is capable of writing.
//
// Scope note — FLAT key set, not per-event-type: this linter checks that
// every READ key exists SOMEWHERE in the union of all schemas' top-level
// keys. It does not verify a reader queries the right key for the event_type
// it's actually filtering on (e.g. nothing stops code from reading
// `foster_user_id` while processing a `weight_recorded` row — that key IS
// legitimately written, just by a different schema). That per-event-type
// precision would need real type-narrowing at each call site; the flat check
// is the cheap, high-leverage version that catches the actual incident class
// (a key nobody writes, ever, under any event type).
//
// -----------------------------------------------------------------------
// Extraction rules (regex-based — matches the sibling linters: mirrors
// check-authz-guards.ts, check-dependency-direction.ts. Not a full AST
// analyzer; each rule below was validated against every current match in
// this repo before landing, and false-positive classes discovered during
// that audit are called out explicitly).
//
// READ keys — scanned from app/**, src/**, lib/** (*.ts, *.tsx). Excludes
// *.test.ts(x), files under __tests__/, and every lib/events/*event-schemas.ts
// file (writer definitions, not readers). Comments (// and /* */) are
// stripped before matching (line breaks preserved, so line numbers stay
// accurate) — illustrative key names in doc comments (e.g. "payload->>'key'"
// as a literal placeholder, found in lib/infra/sql-fragments.ts) would
// otherwise register as a bogus read of the key "key".
//
//   1. SQL JSONB text extraction, three shapes all found in this repo:
//        - `${petEvents.payload}->>'key'`      (drizzle sql`` interpolation)
//        - `alias.payload->>'key'`             (raw SQL, aliased CTE/subquery)
//        - `payload->>'key'`                   (raw SQL, unqualified column)
//      The interpolated form `${IDENT.payload}->>'key'` is accepted ONLY
//      when IDENT === "petEvents" — db/schema.ts has other JSONB `payload`
//      columns (notificationDeadLetter, approvalRequests, caseEvents,
//      welfareCases' auditLog) and `lib/analytics/program-health.ts` reads
//      `${auditLog.payload}->>'surface'`, which is NOT a pet_events read and
//      would false-positive without this guard. db/ itself is out of scope
//      (not scanned) even though db/schema.ts also defines JSONB expression
//      indexes on payload keys.
//
//   2. JS property access on an event's `payload` value, two shapes:
//        - `base.payload.key` / `base.payload['key']` / `base.payload?.key`
//        - bare `payload.key` / `payload['key']` / `payload?.key`, where a
//          local variable is itself literally named `payload` (very common:
//          `const payload = (e.payload ?? {}) as Record<string, unknown>`
//          in every lib/projections/*.ts fold, then `payload.some_key`).
//      Both shapes are gated to files that reference the identifier
//      `petEvents` somewhere (bounds the noise per the task brief) — but
//      that file-level gate is not enough on its own: within a file that
//      DOES import petEvents, a `resolveBusinessRule()` call also returns an
//      object with its own unrelated `.payload` (a DIFFERENT JSONB column,
//      `business_rules.payload`, not `pet_events.payload`) and every call
//      site in this repo binds it to an identifier ending in "Rule"
//      (`breedRule`, `weightRule`, `longStayRule`, `reminderWindowRule`,
//      `dueSoonWindowRule`, `pppBreedRule`, `resolvedRule` — verified by
//      grepping every `resolveBusinessRule(` call site). `base.payload.key`
//      is therefore excluded when `base` matches /Rule$/. A small explicit
//      denylist (EXCLUDED_PAYLOAD_BASE_IDENTIFIERS) covers one-off
//      non-event `.payload` sources found during the audit (approval
//      requests' `request.payload`, `dup.payload`) as defense in depth,
//      even though today those specific files don't import petEvents.
//      KNOWN LIMITATION: the bare `payload.key` shape has no base
//      identifier to filter on, so it relies entirely on the file-level
//      petEvents gate. If a future file imports petEvents AND ALSO
//      destructures an unrelated `payload` local (e.g. from an
//      approvalRequests row), this scanner cannot tell them apart — fix by
//      renaming the non-event local or adding a baseline entry.
//
// WRITTEN keys — parsed from every lib/events/*event-schemas.ts file. Every
// zod schema in them is either `z.object(SHAPE).strict()...` (SHAPE is an object
// literal, `withVersion({...})`, or a bare identifier referencing a
// module-level `const NAME = {...}` shared shape like `welfareCore`) or a
// `z.discriminatedUnion`/`z.union` of several such schemas — the extractor
// doesn't need to special-case unions at all, because it just walks every
// `z.object(` call site in the file independently and unions their keys.
// For each shape, only DEPTH-1 keys count (a brace-depth-aware scan, not a
// flat regex) — nested object keys (e.g. `match_strength.high_count`,
// `disclosure_prefs_snapshot.phone`) are never reachable via `payload->>` or
// a single `.payload.key` hop, so counting them would hide real gaps.
// `...welfareCore`-style spreads are resolved against the named-shape map.
// `payload_version` is added to the written set explicitly: `withVersion()`
// injects it at runtime (`payload_version: z.literal(1).default(1), ...shape`)
// so it never appears as a literal key in any shape's source text.
//
// Run: pnpm tsx scripts/check-event-payload-parity.ts   (or: pnpm lint:events)
// Exits 0 clean; exits 1 listing each offending read as file:line + key.

import { globSync, readFileSync } from "node:fs";

import { stripComments } from "./lib/strip-comments.mjs";

// Every zod payload-schema file, not just the registry. event-schemas.ts holds
// the registry and most shapes, but the file-size ratchet
// (scripts/file-size-baseline.json) pushed the tag (0169), caretaker (0189) and
// rehome-sponsorship payloads into siblings. A written-key index built from the
// registry file alone silently forgets every key those siblings emit, so the
// fence's subject shrinks each time the codebase does the split the ratchet
// asked for — and a legitimate read of, say, `ownership_id` gets reported as a
// ghost. Glob the family instead of enumerating it: the next split is free.
const SCHEMAS_GLOB = "lib/events/*event-schemas.ts";
const SCHEMAS_FILE = "lib/events/event-schemas.ts";
const BASELINE_FILE = "scripts/event-parity-baseline.json";

/** Absolute-free, forward-slash paths of every payload-schema source file. */
export function listSchemaFiles(): string[] {
  return globSync(SCHEMAS_GLOB)
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes(".test."))
    .sort();
}

// ---------------------------------------------------------------------------
// Shared: comment stripping (preserves newlines so line numbers stay valid).
// Single source of truth: scripts/lib/strip-comments.mjs — re-exported here
// so existing `import { stripComments } from "./check-event-payload-parity"`
// call sites (including this file's own test) keep working unchanged.
// ---------------------------------------------------------------------------

export { stripComments };

// ---------------------------------------------------------------------------
// WRITTEN keys — brace-depth-aware object-literal key extractor.
// ---------------------------------------------------------------------------

type ObjectScan = { keys: string[]; spreads: string[]; closeIdx: number };

// `src[openIdx]` must be the opening `{` of the object literal. Returns its
// DEPTH-1 property keys (identifier or quoted-string keys) and `...spread`
// identifiers, plus the index of the matching closing `}`.
export function scanObjectLiteral(src: string, openIdx: number): ObjectScan {
  const keys: string[] = [];
  const spreads: string[] = [];
  let depth = 0;
  let expectingKey = true;
  let i = openIdx;
  for (; i < src.length; i++) {
    const ch = src[i];

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      // A quoted string in "key position" (depth 1, expecting a key) is a
      // string-literal key; capture it, then skip the rest of the literal.
      let j = i + 1;
      const start = j;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\") j++;
        j++;
      }
      if (depth === 1 && expectingKey) {
        let k = j + 1;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] === ":") keys.push(src.slice(start, j));
        expectingKey = false;
      }
      i = j;
      continue;
    }

    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      if (depth === 1) expectingKey = true;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return { keys, spreads, closeIdx: i };
      continue;
    }

    if (depth !== 1) continue;

    if (ch === ",") {
      expectingKey = true;
      continue;
    }
    if (/\s/.test(ch)) continue;

    if (expectingKey && ch === "." && src[i + 1] === "." && src[i + 2] === ".") {
      let j = i + 3;
      const start = j;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      spreads.push(src.slice(start, j));
      i = j - 1;
      expectingKey = false;
      continue;
    }

    if (expectingKey && /[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      const ident = src.slice(i, j);
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] === ":") keys.push(ident);
      i = j - 1;
      expectingKey = false;
    }
    // Anything else at depth 1 while not in key position (e.g. mid-value
    // tokens) is irrelevant to key extraction — ignore.
  }
  return { keys, spreads, closeIdx: i };
}

// Resolves `...spreadName` references against a map of module-level
// `const NAME = { ... }` object literals (e.g. `welfareCore`), recursively.
function resolveKeys(
  scan: ObjectScan,
  namedShapes: Map<string, ObjectScan>,
  seen = new Set<string>(),
): string[] {
  const out = [...scan.keys];
  for (const spreadName of scan.spreads) {
    if (seen.has(spreadName)) continue;
    seen.add(spreadName);
    const target = namedShapes.get(spreadName);
    if (target) out.push(...resolveKeys(target, namedShapes, seen));
  }
  return out;
}

// Collects every module-level `const NAME = { ... };` object literal (shared
// shapes like `welfareCore`), keyed by name.
function collectNamedShapes(src: string): Map<string, ObjectScan> {
  const shapes = new Map<string, ObjectScan>();
  const re = /(?:^|\n)const (\w+)\s*=\s*\{/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(src))) {
    const name = m[1];
    const openIdx = m.index + m[0].length - 1;
    shapes.set(name, scanObjectLiteral(src, openIdx));
  }
  return shapes;
}

// Every top-level key any registered event schema is capable of writing,
// flattened across all event types (see the FLAT key set note above).
export function extractWrittenKeys(src: string): Set<string> {
  const clean = stripComments(src);
  const namedShapes = collectNamedShapes(clean);
  const written = new Set<string>();
  // Injected by the withVersion() helper at runtime — never a literal key in
  // any shape's source text (see header comment).
  written.add("payload_version");

  // `z` and `.object(` are frequently split across lines in this file
  // (`const petRegistered = z\n  .object(\n    withVersion({...`) — the
  // whitespace must be tolerated on every join, not just before the
  // optional `withVersion(`.
  const callRe = /z\s*\.\s*object\s*\(\s*(withVersion\s*\(\s*)?/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = callRe.exec(clean))) {
    let cursor = m.index + m[0].length;
    while (cursor < clean.length && /\s/.test(clean[cursor])) cursor++;

    if (clean[cursor] === "{") {
      const scan = scanObjectLiteral(clean, cursor);
      for (const key of resolveKeys(scan, namedShapes)) written.add(key);
      continue;
    }

    // Bare identifier shape, e.g. `z.object(withVersion(welfareCore))`.
    if (/[A-Za-z_$]/.test(clean[cursor] ?? "")) {
      let j = cursor;
      while (j < clean.length && /[\w$]/.test(clean[j])) j++;
      const ident = clean.slice(cursor, j);
      const target = namedShapes.get(ident);
      if (target) {
        for (const key of resolveKeys(target, namedShapes)) written.add(key);
      }
    }
  }

  return written;
}

// ---------------------------------------------------------------------------
// READ keys — scan app/, src/, lib/ for payload key reads.
// ---------------------------------------------------------------------------

export type ReadHit = { key: string; file: string; line: number };

// Identifiers known to bind to a DIFFERENT JSONB `payload` column than
// pet_events.payload (see header comment). Defense in depth beyond the
// `/Rule$/` heuristic — populated from the audit that shipped this linter.
export const EXCLUDED_PAYLOAD_BASE_IDENTIFIERS = new Set<string>(["request", "dup", "rule"]);

const RESOLVE_BUSINESS_RULE_SUFFIX_RE = /Rule$/;

function isExcludedBase(ident: string): boolean {
  return (
    EXCLUDED_PAYLOAD_BASE_IDENTIFIERS.has(ident) || RESOLVE_BUSINESS_RULE_SUFFIX_RE.test(ident)
  );
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

const SQL_PAYLOAD_RE =
  /\$\{\s*(\w+)\.payload\s*\}\s*->>\s*'([^']+)'|(\w+)\.payload\s*->>\s*'([^']+)'|(?<![.\w])payload\s*->>\s*'([^']+)'/g;

// Two shapes, kept as SEPARATE (not merged-optional) patterns: `base.payload.key`
// requires an explicit identifier immediately before `.payload`, while the bare
// `payload.key` form requires NO preceding dot/word char (a real standalone
// local named `payload`). A single merged pattern with `(?:(\w+)\.)?` PLUS a
// `(?<![.\w])` lookbehind on `payload` is self-contradicting — when the
// optional base group matches, the character actually preceding "payload" in
// the string IS that group's trailing ".", so the lookbehind then always
// fails and `base.payload.key` can never match. Caught by this file's own
// unit test against `meta.payload.location_description` — kept split.
const JS_DOT_WITH_BASE_RE = /\b([A-Za-z_$][\w$]*)\.payload\??\.([A-Za-z_$][\w$]*)/g;
const JS_DOT_BARE_RE = /(?<![.\w])payload\??\.([A-Za-z_$][\w$]*)/g;

const JS_BRACKET_WITH_BASE_RE =
  /\b([A-Za-z_$][\w$]*)\.payload\??\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]/g;
const JS_BRACKET_BARE_RE = /(?<![.\w])payload\??\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]/g;

export function extractReadHits(relPath: string, rawSrc: string): ReadHit[] {
  const hits: ReadHit[] = [];
  const src = stripComments(rawSrc);

  let m: RegExpExecArray | null;

  const sqlRe = new RegExp(SQL_PAYLOAD_RE);
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = sqlRe.exec(src))) {
    if (m[1] !== undefined) {
      // `${IDENT.payload}->>'key'` — only a real pet_events read when
      // IDENT === "petEvents" (see header comment: other tables have their
      // own `payload` JSONB column too).
      if (m[1] === "petEvents") hits.push({ key: m[2], file: relPath, line: lineOf(src, m.index) });
      continue;
    }
    if (m[3] !== undefined) {
      hits.push({ key: m[4], file: relPath, line: lineOf(src, m.index) });
      continue;
    }
    if (m[5] !== undefined) {
      hits.push({ key: m[5], file: relPath, line: lineOf(src, m.index) });
    }
  }

  // JS accessor reads are bounded to files that reference petEvents at all
  // (bounds noise per the task brief — see header comment for the residual
  // false-positive class this doesn't cover).
  if (/\bpetEvents\b/.test(src)) {
    const dotWithBaseRe = new RegExp(JS_DOT_WITH_BASE_RE);
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
    while ((m = dotWithBaseRe.exec(src))) {
      if (isExcludedBase(m[1])) continue;
      hits.push({ key: m[2], file: relPath, line: lineOf(src, m.index) });
    }

    const dotBareRe = new RegExp(JS_DOT_BARE_RE);
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
    while ((m = dotBareRe.exec(src))) {
      hits.push({ key: m[1], file: relPath, line: lineOf(src, m.index) });
    }

    const bracketWithBaseRe = new RegExp(JS_BRACKET_WITH_BASE_RE);
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
    while ((m = bracketWithBaseRe.exec(src))) {
      if (isExcludedBase(m[1])) continue;
      hits.push({ key: m[2], file: relPath, line: lineOf(src, m.index) });
    }

    const bracketBareRe = new RegExp(JS_BRACKET_BARE_RE);
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
    while ((m = bracketBareRe.exec(src))) {
      hits.push({ key: m[1], file: relPath, line: lineOf(src, m.index) });
    }
  }

  return hits;
}

export function listReadFiles(): string[] {
  const patterns = ["app/**/*.ts", "app/**/*.tsx", "src/**/*.ts", "src/**/*.tsx", "lib/**/*.ts"];
  const files = patterns.flatMap((p) => globSync(p));
  const schemaFiles = new Set(listSchemaFiles());
  return [...new Set(files)]
    .filter((f) => !f.includes(".test."))
    .filter((f) => !f.split(/[\\/]/).includes("__tests__"))
    .filter((f) => !schemaFiles.has(f.replaceAll("\\", "/")))
    .sort();
}

// ---------------------------------------------------------------------------
// Baseline — justified pre-existing exceptions. `"relPath#key": "reason"`.
// Empty is the goal; every entry must carry a reason a reviewer can audit.
// ---------------------------------------------------------------------------

export function loadBaseline(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function runScan(): void {
  const schemaFiles = listSchemaFiles();
  const writtenKeys = new Set<string>();
  for (const file of schemaFiles) {
    for (const key of extractWrittenKeys(readFileSync(file, "utf8"))) writtenKeys.add(key);
  }
  const baseline = loadBaseline();

  const readFiles = listReadFiles();
  if (readFiles.length === 0) {
    console.error("✗ check-event-payload-parity: found no files to scan under app/, src/, lib/.");
    process.exit(1);
  }

  const offenders: string[] = [];
  let totalReads = 0;
  const usedBaselineEntries = new Set<string>();

  for (const file of readFiles) {
    const relPath = file.replaceAll("\\", "/");
    const src = readFileSync(file, "utf8");
    const hits = extractReadHits(relPath, src);
    totalReads += hits.length;
    for (const hit of hits) {
      if (writtenKeys.has(hit.key)) continue;
      const baselineKey = `${hit.file}#${hit.key}`;
      if (baseline[baselineKey] !== undefined) {
        usedBaselineEntries.add(baselineKey);
        continue;
      }
      offenders.push(
        `${hit.file}:${hit.line} reads payload key '${hit.key}' — no writer schema under ${SCHEMAS_GLOB} emits this key. Ghost-payload read (see c01bec56/9e57a7b7 class): the query returns NULL forever instead of erroring. Either the reader has the wrong key name, or the key is a genuinely justified legacy exception (add "${baselineKey}": "<reason>" to ${BASELINE_FILE}).`,
      );
    }
  }

  const staleBaselineEntries = Object.keys(baseline).filter((k) => !usedBaselineEntries.has(k));

  if (offenders.length > 0) {
    console.error(offenders.join("\n"));
    console.error(
      `\n✗ ${offenders.length} payload read(s) reference a key no writer schema emits (${readFiles.length} files scanned, ${totalReads} payload reads found, ${writtenKeys.size} written keys known).`,
    );
    process.exit(1);
  }

  if (staleBaselineEntries.length > 0) {
    console.error(
      `✗ ${staleBaselineEntries.length} stale baseline entr${staleBaselineEntries.length === 1 ? "y" : "ies"} in ${BASELINE_FILE} no longer match any read: ${staleBaselineEntries.join(", ")}. Remove them — a baseline only exists for keys that need it.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ event payload parity clean — ${readFiles.length} files scanned, ${totalReads} payload reads checked against ${writtenKeys.size} written keys${
      usedBaselineEntries.size > 0 ? ` (${usedBaselineEntries.size} baselined)` : ""
    }.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-event-payload-parity.ts") ||
    process.argv[1].endsWith("check-event-payload-parity.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}

// Re-exported so other tooling (or a future rebuild-script cross-check) can
// resolve the schema paths without hardcoding them twice. Prefer
// listSchemaFiles() over SCHEMAS_FILE: the latter names only the registry.
export { SCHEMAS_FILE, SCHEMAS_GLOB, BASELINE_FILE };
