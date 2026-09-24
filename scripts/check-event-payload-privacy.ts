// Event-payload privacy classification fence (T3-A2b, 2026-09-22).
// Replaces scripts/check-event-string-sweep.ts (A05-4).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Until T3-A2b, `erase_subject_data` (0159 → 0228) sentinel-redacted a fixed
// list of payload KEY NAMES across every event type. Two failures followed
// from redacting by name:
//   · it destroyed compliance facts. `reason` is prose on status_changed and an
//     ENUM on microchip_replaced, foster_ended, custody_transferred and
//     custody_transfer_proposed; the sweep overwrote the enum with
//     '[dato removido]' and the row stopped validating against its own schema.
//   · it destroyed professional acts: a vet's diagnosis, a rabies observation's
//     closure note, erased because the OWNER asked to be forgotten.
// The old fence (check-event-string-sweep.ts) could not see either: it read
// only single-line bare `z.string()` keys, by name, with no notion of the
// event type or of the leaf's type.
//
// WHAT THIS FENCE DOES
// ---------------------------------------------------------------------------
// Offline, against the zod schemas themselves (`PayloadSchemas`, converted with
// z.toJSONSchema so arrays, unions, discriminated unions, nested objects and
// z.unknown() are all walked):
//   1. every leaf path of every event type is classified in
//      lib/events/payload-privacy.ts (on itself or on an ancestor object);
//   2. no classified path is stale, and no path is classified twice;
//   3. every transform FITS its leaf — sentinel only on a free string (never
//      an enum, a literal, a uuid/date format, an `*_id`/`*_at`-style key or a
//      string whose maxLength cannot hold the sentinel); drop only on an
//      optional key; null only on a nullable one; empty_array only on an array;
//      age_band only on `*_age_estimate` with its `*_age_band` enum sibling;
//      mirrored only on `changes[].old|new`. A sentinel on an enum is exactly
//      the `reason` bug, and it is a violation here;
//   4. professional acts and personal data carry a written reason (≥20 chars);
//   5. every S3 party key names a uuid key of that payload;
//   6. every column of pet_events (getTableColumns) is classified, and nothing
//      stale is;
//   7. every `changes[].field` a pet_profile_updated writer emits is
//      classified in PROFILE_CHANGE_FIELD_PRIVACY, and nothing stale is;
//   8. the walk finds at least MIN_EXPECTED_LEAVES leaves — the non-vacuity
//      floor.
//   9. (security review of T3-A2b) an author gate together with party keys
//      is refused unless the entry says why — the gate skips first, so the
//      named party never reaches a kept author's words;
//  10. MACHINE CODES under prose keys: every string literal a writer passes
//      to validateEventPayload("<type>", { <key>: … "code" … }) for a
//      sentinel-classified key must be declared in that entry's `codes` and
//      match CODE_PATTERN (the SQL sentinel keeps that shape); every declared
//      code must still appear as a literal somewhere in the sources;
//  11. KIND_PAYLOAD_PRIVACY paths exist in the base schema; LEGACY keys do
//      NOT (a legacy key the schema now declares belongs in PAYLOAD_PRIVACY),
//      and use only sentinel or drop.
// The DB side — the live `pii.pet_event_redaction_rules` equals
// `redactionRules()`, the live code pattern and kept roles match, and every
// live event type carrying a point is in COORDINATE_PRIVACY — lives in
// check-subject-rights-coverage.ts, with the other checks that read the live
// database.
//
// KNOWN LIMITS (stated, not hidden)
// ---------------------------------------------------------------------------
//   · The changelog-field check (7) reads a HARD-CODED list of writer files
//     (PROFILE_CHANGE_WRITERS) with a literal-only regex: a new writer file, or
//     a field name built from a variable, is invisible to it. SQL treats an
//     unlisted field as a compliance fact, so that miss keeps data, it never
//     destroys a fact.
//   · The machine-code check (10) sees only literals written INSIDE the object
//     passed to validateEventPayload for that event type. A code that arrives
//     through a variable (`reason: failures[0]`, a constant imported from
//     another module) is caught only if someone declares it; the SQL guard
//     (never sentinel a CODE_PATTERN value) is what protects it meanwhile.
//   · A `z.record()` / `z.unknown()` leaf hides every key below it: the walker
//     sees one `any` leaf, classified as a whole. event_amended's changes[].field
//     is validated at write time instead (amend-event.ts checks the field is a
//     top-level key of the target type's classification).
//
// Run:  pnpm tsx scripts/check-event-payload-privacy.ts   (or: pnpm lint:string-sweep)
// Exits 0 when clean; exits 1 listing each violation.

import { globSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getTableColumns } from "drizzle-orm";
import { z } from "zod";

import { petEvents } from "@/db/schema";
import { PayloadSchemas } from "@/lib/events/event-schemas";
import {
  type ColumnEntry,
  KIND_PAYLOAD_PRIVACY,
  LEGACY_PAYLOAD_PRIVACY,
  PAYLOAD_PRIVACY,
  PET_EVENT_COLUMN_PRIVACY,
  PROFILE_CHANGE_FIELD_PRIVACY,
  type PrivacyEntry,
  SENTINEL,
  isMachineCode,
} from "@/lib/events/payload-privacy";

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

/** What one path of a payload can hold, merged across union variants. */
export type SchemaNode = {
  /** "string" (free) | "enum" | "literal" | "string:<format>" | "string:pattern" |
   *  "number" | "integer" | "boolean" | "object" | "array" | "any". */
  kinds: Set<string>;
  optional: boolean;
  nullable: boolean;
  /** Smallest maxLength across the string variants, when any declares one. */
  maxLength: number | null;
  /** True when nothing is walked below this node. */
  leaf: boolean;
};

function variantsOf(s: JsonSchema, root: JsonSchema): JsonSchema[] {
  if (typeof s.$ref === "string") {
    const name = s.$ref.replace(/^#\/(\$defs|definitions)\//, "");
    const defs = (root.$defs ?? root.definitions ?? {}) as Record<string, JsonSchema>;
    const target = defs[name];
    return target ? variantsOf(target, root) : [{}];
  }
  if (Array.isArray(s.anyOf)) return (s.anyOf as JsonSchema[]).flatMap((v) => variantsOf(v, root));
  if (Array.isArray(s.oneOf)) return (s.oneOf as JsonSchema[]).flatMap((v) => variantsOf(v, root));
  if (Array.isArray(s.allOf)) {
    // An intersection: merge the members' properties into one object variant.
    const members = (s.allOf as JsonSchema[]).flatMap((v) => variantsOf(v, root));
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const m of members) {
      Object.assign(props, (m.properties ?? {}) as Record<string, unknown>);
      required.push(...((m.required as string[] | undefined) ?? []));
    }
    return [{ type: "object", properties: props, required }];
  }
  if (Array.isArray(s.type)) {
    return (s.type as string[]).map((t) => ({ ...s, type: t }));
  }
  return [s];
}

function kindOf(v: JsonSchema): string {
  if (v.const !== undefined) return "literal";
  if (Array.isArray(v.enum)) return "enum";
  if (v.type === "string") {
    if (typeof v.format === "string") return `string:${v.format}`;
    if (typeof v.pattern === "string") return "string:pattern";
    return "string";
  }
  if (v.type === "object") return "object";
  if (typeof v.type === "string") return v.type;
  return "any";
}

function isObjectWithProps(v: JsonSchema): boolean {
  return v.type === "object" && typeof v.properties === "object" && v.properties !== null;
}

function joinPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

function recordNode(
  out: Map<string, SchemaNode>,
  path: string,
  variants: JsonSchema[],
  optional: boolean,
  leaf: boolean,
): void {
  const prev = out.get(path);
  const node: SchemaNode = prev ?? {
    kinds: new Set(),
    optional,
    nullable: false,
    maxLength: null,
    leaf,
  };
  for (const v of variants) {
    if (v.type === "null") {
      node.nullable = true;
      continue;
    }
    node.kinds.add(kindOf(v));
    if (v.type === "string" && typeof v.maxLength === "number") {
      node.maxLength =
        node.maxLength === null ? v.maxLength : Math.min(node.maxLength, v.maxLength);
    }
  }
  if (prev) {
    node.optional = prev.optional && optional;
    node.leaf = prev.leaf && leaf;
  }
  out.set(path, node);
}

function walk(
  s: JsonSchema,
  root: JsonSchema,
  path: string,
  optional: boolean,
  out: Map<string, SchemaNode>,
): void {
  const variants = variantsOf(s, root);
  const objects = variants.filter(isObjectWithProps);
  const arrays = variants.filter((v) => v.type === "array");
  const objectItems = arrays
    .map((a) => (a.items ?? {}) as JsonSchema)
    .filter((i) => variantsOf(i, root).some(isObjectWithProps));
  const descends = objects.length > 0 || objectItems.length > 0;

  if (path !== "") recordNode(out, path, variants, optional, !descends);

  if (objects.length > 0) {
    const keys = new Set<string>();
    for (const o of objects) for (const k of Object.keys(o.properties as object)) keys.add(k);
    for (const k of keys) {
      const present = objects.filter((o) => Object.hasOwn(o.properties as object, k));
      // Optional unless SOME variant that declares the key requires it.
      const opt = present.every((o) => !((o.required as string[] | undefined) ?? []).includes(k));
      for (const o of present) {
        walk((o.properties as Record<string, JsonSchema>)[k], root, joinPath(path, k), opt, out);
      }
    }
  }
  for (const item of objectItems) walk(item, root, `${path}[]`, false, out);
}

/** Every path of a zod payload schema, including intermediate objects/arrays. */
export function schemaNodes(schema: z.ZodTypeAny): Map<string, SchemaNode> {
  const root = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const out = new Map<string, SchemaNode>();
  walk(root, root, "", false, out);
  return out;
}

// ---------------------------------------------------------------------------
// The checks (pure — tests feed synthetic schemas and tables)
// ---------------------------------------------------------------------------

export const MIN_REASON_LENGTH = 20;

/**
 * The floor — pinned a little below the 2026-09-22 count (441 leaves across 55
 * event types), so ordinary additions do not touch it while a walker that
 * silently stops descending still fails loudly.
 */
export const MIN_EXPECTED_LEAVES = 420;

export type Violation = { kind: string; message: string };

/** Key names that are never free text, whatever zod says about the string. */
const STRUCTURAL_KEY = /(^id$|_id$|Id$|_at$|_on$|_date$|_until$|_code$|_token$)/;

function lastSegment(path: string): string {
  const segs = path.split(".");
  return (segs[segs.length - 1] ?? "").replace(/\[\]$/, "");
}

function parentPath(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(0, i);
}

function ancestorsOf(path: string): string[] {
  // "changes[].old" → ["changes[]", "changes"]; "a.b.c" → ["a.b", "a"].
  const out: string[] = [];
  let p = path;
  for (;;) {
    if (p.endsWith("[]")) {
      p = p.slice(0, -2);
    } else {
      const i = p.lastIndexOf(".");
      if (i < 0) break;
      p = p.slice(0, i);
    }
    if (p === "") break;
    out.push(p);
  }
  return out;
}

function isFreeString(node: SchemaNode): boolean {
  return node.kinds.size > 0 && [...node.kinds].every((k) => k === "string");
}

function sentinelMisfit(path: string, node: SchemaNode): string | null {
  if (!isFreeString(node)) {
    return `its leaf is ${[...node.kinds].join(" | ")}, not free text — a sentinel there makes the row fail its own schema (the enum \`reason\` bug)`;
  }
  if (STRUCTURAL_KEY.test(lastSegment(path))) {
    return "its key name marks an identifier, date or code, never free text";
  }
  if (node.maxLength !== null && node.maxLength < SENTINEL.length) {
    return `its maxLength (${node.maxLength}) cannot hold the sentinel`;
  }
  return null;
}

function transformMisfit(
  transform: string,
  path: string,
  node: SchemaNode,
  nodes: Map<string, SchemaNode>,
): string | null {
  switch (transform) {
    case "sentinel":
      return sentinelMisfit(path, node);
    case "drop":
      return node.optional ? null : "drop needs an optional key; this one is required";
    case "null":
      return node.nullable || node.kinds.has("any") ? null : "null needs a nullable key";
    case "empty_array":
      return node.kinds.has("array") ? null : "empty_array needs an array";
    case "age_band": {
      const key = lastSegment(path);
      if (!key.endsWith("_age_estimate")) return "age_band applies only to a `*_age_estimate` key";
      const sibling = joinPath(parentPath(path), key.replace(/_age_estimate$/, "_age_band"));
      const s = nodes.get(sibling);
      if (!s?.kinds.has("enum")) return `age_band needs an enum sibling \`${sibling}\``;
      return sentinelMisfit(path, node);
    }
    case "coarsen_point":
      return "coarsen_point applies to the location columns, never to a payload key";
    case "changes_mirror":
      return /\[\]\.(old|new)$/.test(path) && nodes.has(path.replace(/(old|new)$/, "field"))
        ? null
        : "mirrored applies only to `changes[].old|new` next to a `changes[].field`";
    default:
      return `unknown transform ${transform}`;
  }
}

function entryTransform(e: PrivacyEntry): string | null {
  if (e.class === "personal_data") return e.transform;
  if (e.class === "professional_act") return e.authorGated?.otherwise ?? null;
  if (e.class === "mirrored") return "changes_mirror";
  return null;
}

function checkEntry(
  eventType: string,
  path: string,
  e: PrivacyEntry,
  node: SchemaNode,
  nodes: Map<string, SchemaNode>,
): Violation[] {
  const at = `${eventType}.${path}`;
  const out: Violation[] = [];
  if (e.class !== "compliance_fact" && e.why.trim().length < MIN_REASON_LENGTH) {
    out.push({
      kind: "missing-reason",
      message: `✗ ${at} — classified ${e.class} with no written reason (under ${MIN_REASON_LENGTH} characters).`,
    });
  }
  const t = entryTransform(e);
  if (t !== null) {
    const misfit = transformMisfit(t, path, node, nodes);
    if (misfit !== null) {
      out.push({ kind: "transform-misfit", message: `✗ ${at} — transform ${t}: ${misfit}.` });
    }
  }
  out.push(...checkGatedParty(at, e), ...checkDeclaredCodes(at, e));
  const partyKeys =
    e.class === "compliance_fact" || e.class === "mirrored" ? undefined : e.partyKeys;
  for (const pk of partyKeys ?? []) {
    const local = pk.split(">")[0] ?? "";
    const n = nodes.get(local);
    if (!n?.kinds.has("string:uuid")) {
      out.push({
        kind: "bad-party-key",
        message: `✗ ${at} — party key \`${pk}\`: \`${local}\` is not a uuid key of ${eventType}.`,
      });
    }
  }
  return out;
}

/** Check 9 — an author gate with party keys must say why. */
export function checkGatedParty(at: string, e: PrivacyEntry): Violation[] {
  if (e.class !== "professional_act" || !e.authorGated || !e.partyKeys?.length) return [];
  if ((e.gatedPartyReason ?? "").trim().length >= MIN_REASON_LENGTH) return [];
  return [
    {
      kind: "gated-party",
      message: `✗ ${at} — authorGated together with partyKeys: the gate skips first, so the named party's erasure never reaches a kept author's row. If the value is ABOUT that person make it personal_data; if the combination is intended, say why in gatedPartyReason.`,
    },
  ];
}

/** Check 10, entry half — declared codes are code-shaped and on a sentinel key. */
export function checkDeclaredCodes(at: string, e: PrivacyEntry): Violation[] {
  if (e.class !== "personal_data" && e.class !== "professional_act") return [];
  const out: Violation[] = [];
  if (e.codes?.length && entryTransform(e) !== "sentinel") {
    out.push({
      kind: "codes-on-non-sentinel",
      message: `✗ ${at} — declares machine codes but its transform is not sentinel; codes only matter where the sentinel could overwrite them.`,
    });
  }
  for (const code of e.codes ?? []) {
    if (!isMachineCode(code)) {
      out.push({
        kind: "code-not-code-shaped",
        message: `✗ ${at} — declared code "${code}" does not match CODE_PATTERN, so the SQL sentinel WOULD overwrite it. Rename the code (snake_case with an underscore, no 5-digit run) or move it to an enum key.`,
      });
    }
  }
  return out;
}

/** Checks 1–5 and 8 for a set of event types. */
export function checkPayloadPrivacy(
  schemas: Readonly<Record<string, z.ZodTypeAny>>,
  table: Readonly<Record<string, Readonly<Record<string, PrivacyEntry>>>>,
  minLeaves: number = MIN_EXPECTED_LEAVES,
): { violations: Violation[]; leafCount: number } {
  const violations: Violation[] = [];
  let leafCount = 0;

  for (const eventType of Object.keys(table)) {
    if (!schemas[eventType]) {
      violations.push({
        kind: "stale-event-type",
        message: `✗ ${eventType} — classified in PAYLOAD_PRIVACY but has no payload schema.`,
      });
    }
  }

  for (const [eventType, schema] of Object.entries(schemas)) {
    const entries = table[eventType];
    if (!entries) {
      violations.push({
        kind: "unclassified-event-type",
        message: `✗ ${eventType} — has a payload schema and no PAYLOAD_PRIVACY entry. Classify every key.`,
      });
      continue;
    }
    const nodes = schemaNodes(schema);

    for (const [path, node] of nodes) {
      if (!node.leaf) continue;
      leafCount++;
      const covering = [path, ...ancestorsOf(path)].filter((p) => Object.hasOwn(entries, p));
      if (covering.length === 0) {
        violations.push({
          kind: "unclassified",
          message: `✗ ${eventType}.${path} — a payload leaf with NO privacy class in lib/events/payload-privacy.ts. Classify it compliance_fact | professional_act | personal_data (PO decision 5A: erase what belongs to the person, never the pet's history).`,
        });
      } else if (covering.length > 1) {
        violations.push({
          kind: "double-classified",
          message: `✗ ${eventType}.${path} — classified more than once (${covering.join(", ")}). Keep one.`,
        });
      }
    }

    for (const [path, entry] of Object.entries(entries)) {
      const node = nodes.get(path);
      if (!node) {
        violations.push({
          kind: "stale",
          message: `✗ ${eventType}.${path} — classified but the schema has no such path. Remove the entry.`,
        });
        continue;
      }
      violations.push(...checkEntry(eventType, path, entry, node, nodes));
    }
  }

  if (leafCount < minLeaves) {
    violations.push({
      kind: "floor",
      message: `✗ Only ${leafCount} payload leaves walked, expected at least ${minLeaves}. The walker itself is probably broken — that is a false pass, not a clean schema.`,
    });
  }
  return { violations, leafCount };
}

/** Check 6 — every pet_events column classified, nothing stale. */
export function checkColumnPrivacy(
  columns: ReadonlyArray<{ name: string; dataType: string }>,
  table: Readonly<Record<string, ColumnEntry>>,
): Violation[] {
  const out: Violation[] = [];
  const live = new Set(columns.map((c) => c.name));
  for (const c of columns) {
    const e = table[c.name];
    if (!e) {
      out.push({
        kind: "unclassified-column",
        message: `✗ pet_events.${c.name} — a column with no privacy class in PET_EVENT_COLUMN_PRIVACY.`,
      });
      continue;
    }
    if (e.class !== "compliance_fact" && e.why.trim().length < MIN_REASON_LENGTH) {
      out.push({
        kind: "missing-reason",
        message: `✗ pet_events.${c.name} — classified ${e.class} with no written reason.`,
      });
    }
    if (e.class === "personal_data" && c.dataType !== "string") {
      // drizzle reports numeric(10,7) as dataType "string" — the only shape
      // pii.redacted_coordinate rounds.
      out.push({
        kind: "transform-misfit",
        message: `✗ pet_events.${c.name} — coarsen_point needs a numeric location column.`,
      });
    }
  }
  for (const name of Object.keys(table)) {
    if (!live.has(name)) {
      out.push({
        kind: "stale-column",
        message: `✗ pet_events.${name} — classified but no such column. Remove the entry.`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check 10, writer half — string literals written under sentinel keys
// ---------------------------------------------------------------------------

export type WriterLiteral = { eventType: string; key: string; value: string; at: string };

const VALIDATE_CALL = /validateEventPayload\(\s*"([a-z_]+)"\s*,\s*\{/g;

/** The `{ … }` object literal starting at `open` (index of "{"), brace-matched. */
function objectLiteralAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/**
 * Every CODE-LIKE literal (a lowercase token) in `key: <expression>` lines of
 * an object passed to validateEventPayload("<type>", { … }). A literal that is
 * only compared against (`x === "rejected" ? …`) is not written and is
 * skipped. Fixed product copy (a sentence) under a prose key names nobody and
 * holds no fact another key lacks; erasing it is the safe direction, so it is
 * not reported.
 */
export function extractWriterLiterals(file: string, src: string): WriterLiteral[] {
  const out: WriterLiteral[] = [];
  for (const m of src.matchAll(VALIDATE_CALL)) {
    const eventType = m[1] as string;
    const open = (m.index ?? 0) + m[0].length - 1;
    const body = objectLiteralAt(src, open);
    for (const line of body.split("\n")) {
      const km = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
      if (!km) continue;
      const written = (km[2] as string).replace(/[!=]==\s*"[^"]*"/g, "");
      for (const lit of written.matchAll(/"([^"\\]*)"/g)) {
        const value = lit[1] as string;
        if (!/^[a-z][a-z0-9_]*$/.test(value)) continue;
        out.push({ eventType, key: km[1] as string, value, at: file });
      }
    }
  }
  return out;
}

function sentinelEntry(eventType: string, key: string): PrivacyEntry | undefined {
  const e =
    PAYLOAD_PRIVACY[eventType as keyof typeof PAYLOAD_PRIVACY]?.[key] ??
    LEGACY_PAYLOAD_PRIVACY[eventType as keyof typeof LEGACY_PAYLOAD_PRIVACY]?.[key];
  return e && entryTransform(e) === "sentinel" ? e : undefined;
}

/** Check 10 — undeclared literals under sentinel keys, and stale declared codes. */
export function checkWriterCodes(
  literals: readonly WriterLiteral[],
  allSources: string,
  lookup: (eventType: string, key: string) => PrivacyEntry | undefined = sentinelEntry,
  declared: ReadonlyArray<{ at: string; code: string }> = declaredCodes(),
): Violation[] {
  const out: Violation[] = [];
  for (const l of literals) {
    const e = lookup(l.eventType, l.key);
    if (!e || (e.class !== "personal_data" && e.class !== "professional_act")) continue;
    if (!(e.codes ?? []).includes(l.value)) {
      out.push({
        kind: "undeclared-code",
        message: `✗ ${l.eventType}.${l.key} — ${l.at} writes the literal "${l.value}" into a key erasure sentinels. If it is a machine code, declare it in the entry's codes (it must match CODE_PATTERN, which the SQL keeps); if it is prose, it will be erased — say so by moving it out of the writer.`,
      });
    }
  }
  for (const d of declared) {
    if (!allSources.includes(`"${d.code}"`)) {
      out.push({
        kind: "stale-code",
        message: `✗ ${d.at} — declares code "${d.code}" but no source file writes that literal any more. Remove it.`,
      });
    }
  }
  return out;
}

function declaredCodes(): Array<{ at: string; code: string }> {
  const out: Array<{ at: string; code: string }> = [];
  for (const table of [PAYLOAD_PRIVACY, LEGACY_PAYLOAD_PRIVACY]) {
    for (const [t, keys] of Object.entries(table)) {
      for (const [k, e] of Object.entries(keys ?? {})) {
        if (e.class !== "personal_data" && e.class !== "professional_act") continue;
        for (const code of e.codes ?? []) out.push({ at: `${t}.${k}`, code });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check 11 — kind overrides and legacy keys
// ---------------------------------------------------------------------------

function nodesOf(schemas: Readonly<Record<string, z.ZodTypeAny>>, t: string) {
  const schema = schemas[t];
  return schema ? schemaNodes(schema) : new Map<string, SchemaNode>();
}

function checkKindOverrides(
  schemas: Readonly<Record<string, z.ZodTypeAny>>,
  kinds: typeof KIND_PAYLOAD_PRIVACY,
): Violation[] {
  const out: Violation[] = [];
  for (const [t, byKind] of Object.entries(kinds)) {
    const nodes = nodesOf(schemas, t);
    for (const [kind, paths] of Object.entries(byKind ?? {})) {
      for (const [path, e] of Object.entries(paths)) {
        const node = nodes.get(path);
        const at = `${t}[kind=${kind}]`;
        if (node) {
          out.push(...checkEntry(at, path, e, node, nodes));
        } else {
          out.push({
            kind: "stale-kind-path",
            message: `✗ ${at}.${path} — no such path in the ${t} schema.`,
          });
        }
      }
    }
  }
  return out;
}

function checkLegacyEntry(at: string, e: PrivacyEntry): Violation[] {
  if (e.class === "compliance_fact" || e.class === "mirrored") return [];
  const out: Violation[] = [];
  if (e.why.trim().length < MIN_REASON_LENGTH) {
    out.push({ kind: "missing-reason", message: `✗ ${at} — no written reason.` });
  }
  const tr = entryTransform(e);
  if (tr !== null && tr !== "sentinel" && tr !== "drop") {
    out.push({
      kind: "transform-misfit",
      message: `✗ ${at} — a legacy key has no schema to fit ${tr} against; use sentinel or drop.`,
    });
  }
  return [...out, ...checkGatedParty(at, e), ...checkDeclaredCodes(at, e)];
}

function checkLegacyKeys(
  schemas: Readonly<Record<string, z.ZodTypeAny>>,
  legacy: typeof LEGACY_PAYLOAD_PRIVACY,
): Violation[] {
  const out: Violation[] = [];
  for (const [t, keys] of Object.entries(legacy)) {
    const nodes = nodesOf(schemas, t);
    for (const [key, e] of Object.entries(keys ?? {})) {
      const at = `${t}.${key} (legacy)`;
      if (nodes.has(key)) {
        out.push({
          kind: "legacy-now-declared",
          message: `✗ ${at} — the ${t} schema declares this key now; classify it in PAYLOAD_PRIVACY and remove the legacy entry.`,
        });
      }
      out.push(...checkLegacyEntry(at, e));
    }
  }
  return out;
}

export function checkKindAndLegacy(
  schemas: Readonly<Record<string, z.ZodTypeAny>>,
  kinds: typeof KIND_PAYLOAD_PRIVACY = KIND_PAYLOAD_PRIVACY,
  legacy: typeof LEGACY_PAYLOAD_PRIVACY = LEGACY_PAYLOAD_PRIVACY,
): Violation[] {
  return [...checkKindOverrides(schemas, kinds), ...checkLegacyKeys(schemas, legacy)];
}

/** Files that emit pet_profile_updated.changes[].field values. */
export const PROFILE_CHANGE_WRITERS = [
  "src/modules/pets/domain/pet-diff.ts",
  "src/modules/pets/infrastructure/pets-repository.ts",
  "lib/infra/business-rules-reeval.ts",
] as const;

const FIELD_LITERAL = /\bfield:\s*"([a-z_]+)"/g;

export function extractChangeFields(source: string): string[] {
  return [...source.matchAll(FIELD_LITERAL)].map((m) => m[1] as string);
}

/** Check 7 — every profile field a writer emits is classified, nothing stale. */
export function checkProfileChangeFields(
  emitted: ReadonlySet<string>,
  table: Readonly<Record<string, PrivacyEntry>>,
): Violation[] {
  const out: Violation[] = [];
  for (const f of emitted) {
    if (!Object.hasOwn(table, f)) {
      out.push({
        kind: "unclassified-change-field",
        message: `✗ pet_profile_updated.changes[].field "${f}" — emitted by a writer and not classified in PROFILE_CHANGE_FIELD_PRIVACY.`,
      });
    }
  }
  for (const [f, e] of Object.entries(table)) {
    if (!emitted.has(f)) {
      out.push({
        kind: "stale-change-field",
        message: `✗ PROFILE_CHANGE_FIELD_PRIVACY.${f} — no writer emits this field. Remove the entry.`,
      });
    }
    if (e.class === "mirrored" || e.class === "compliance_fact") continue;
    if (e.why.trim().length < MIN_REASON_LENGTH) {
      out.push({ kind: "missing-reason", message: `✗ changes field ${f} — no written reason.` });
    }
    const t = entryTransform(e);
    if (t === "drop" || t === "age_band" || t === "coarsen_point") {
      out.push({
        kind: "transform-misfit",
        message: `✗ changes field ${f} — ${t} does not apply to a changelog value (use null or sentinel).`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "..");

function runCheck(): void {
  const schemas = PayloadSchemas as Record<string, z.ZodTypeAny>;
  const { violations, leafCount } = checkPayloadPrivacy(schemas, PAYLOAD_PRIVACY);

  const columns = Object.values(getTableColumns(petEvents)).map((c) => ({
    name: c.name,
    dataType: c.dataType,
  }));
  violations.push(...checkColumnPrivacy(columns, PET_EVENT_COLUMN_PRIVACY));

  const emitted = new Set<string>();
  for (const f of PROFILE_CHANGE_WRITERS) {
    for (const field of extractChangeFields(readFileSync(join(REPO_ROOT, f), "utf8"))) {
      emitted.add(field);
    }
  }
  violations.push(...checkProfileChangeFields(emitted, PROFILE_CHANGE_FIELD_PRIVACY));
  violations.push(...checkKindAndLegacy(schemas));

  const sourceFiles = globSync("{src,lib,app}/**/*.{ts,tsx}", { cwd: REPO_ROOT }).filter(
    (f) => !/\.(test|spec)\.tsx?$/.test(f) && !f.includes("__tests__"),
  );
  const literals: WriterLiteral[] = [];
  let allSources = "";
  for (const f of sourceFiles) {
    const src = readFileSync(join(REPO_ROOT, f), "utf8");
    allSources += src;
    literals.push(...extractWriterLiterals(f.replace(/\\/g, "/"), src));
  }
  violations.push(...checkWriterCodes(literals, allSources));

  if (violations.length > 0) {
    for (const v of violations) console.error(v.message);
    console.error(
      `\n✗ ${violations.length} violation(s). Every pet_events payload leaf, column and changelog field carries a privacy class (AGENTS.md §Privacidad; PO decision 5A).`,
    );
    process.exit(1);
  }
  console.log(
    `✓ event payload privacy — ${leafCount} leaves across ${Object.keys(schemas).length} event types, ${columns.length} columns and ${emitted.size} changelog fields, all classified and every transform fits its leaf; ${literals.length} writer literals checked against declared codes in ${sourceFiles.length} files.`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-event-payload-privacy.ts") ||
    process.argv[1].endsWith("check-event-payload-privacy.js"));

if (isMain) {
  runCheck();
}
