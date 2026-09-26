// Amendment-overlay fence — CI guardrail (A08-G3).
//
// THE QUESTION THIS ASKS
// ---------------------------------------------------------------------------
// "This module reads the payload of an event type that can be AMENDED. Does it
// read the corrected value, or the one the correction replaced?"
//
// WHY IT EXISTS
// ---------------------------------------------------------------------------
// Corrections are new events (Invariant 2): an `event_amended` row names its
// target and the changed fields, and every reader is supposed to fold it in
// through `overlayAmendments` (lib/infra/amendment.ts) or its SQL twin
// (lib/infra/amendment-sql.ts). Nothing enforced that. Two write paths —
// `updateWeightProjection` and `rederivePregnancyStatus` — replayed the RAW
// stream and silently reverted a correction on the next ordinary write
// (A08-G1, A08-G2), and the repair script replayed raw while claiming to run
// the detector's own check (A08-G4). All three shipped green through ~70 fences
// because none of them mentioned amendments at all.
//
// THE SUBJECT, NOT THE FORMS
// ---------------------------------------------------------------------------
// The amendable set is read from `AMENDABLE_EVENT_TYPES` itself, never copied,
// so a type added to the allowlist extends this fence on the same commit. A
// module is a READER when it either
//
//   (R1) calls a `replay*` export of a lib/projections module whose source
//        names an amendable type — the replays are derived from the same
//        constant, not listed here; or
//   (R2) reads a pet_events payload in a file that names an amendable type:
//        the Drizzle column `petEvents.payload`, OR a raw-SQL alias read
//        (`med.payload->>'drug_code'`, `pe.payload ->> …`) in a file that
//        names the `pet_events` table. The alias form was added after a fresh
//        security review found `fetchAmrDensity` reading medication_started
//        raw through `med.payload`, invisible to the Drizzle-only scan.
//
// A third rule (R3) guards the brand itself: `AmendmentOverlaid` is minted only
// by overlayAmendments, so ANY CAST THAT NAMES THE BRAND (`as AmendmentOverlaid…`,
// `as X & AmendmentOverlaidBrand`, wrapped across lines by a formatter — all of
// them) anywhere else forges the proof the replays rely on. R3 also catches the
// UNNAMED forgery: `as any` / `as never` passed directly as the argument to a
// `replayPet*` call for an amendable type erases the parameter's
// `AmendmentOverlaid<ProjectionEvent>` type entirely, so nothing about the brand
// is written down — same hole, no name to grep for.
//
// KNOWN CLASS OUTSIDE THIS MODEL
// ---------------------------------------------------------------------------
// Insert-time COPY columns are not payload reads and this fence cannot see
// them: `pet_events.proxima_dosis_at` is copied from the payload's next_due_at
// when the row is written and never follows a later correction, and
// lib/analytics/org-dashboard.ts reads that column. A correction to next_due_at
// therefore does not reach it. Recorded here on purpose (fresh security review,
// 2026-09-22); it needs its own fix, not an allowlist entry.
//
// checkPayloadReader is per-FILE-and-FORM, not per individual read site. It
// asks "does this file call the right coverage mechanism for this form of
// read (amendedPayloadText for a raw-SQL alias, overlayAmendments for a
// Drizzle column) anywhere at all" — not "does THIS SPECIFIC read site feed
// that call". A file with two raw alias reads of the SAME amendable event
// type, one wrapped in amendedPayloadText and one not, currently passes on
// the strength of the first. Making that precise needs data-flow (which
// variable's payload text ends up in which amendedPayloadText/overlayAmendments
// call), which this text-based fence does not attempt — it was chosen for
// this exact reason (see R2's regexes below: table-name presence + operator
// shape, not parsing). Closing the file-vs-form gap (fresh security review,
// 2026-09-22) removed the worst instance of this — `overlayAmendments(` used
// for an UNRELATED Drizzle read no longer blanket-exempts a raw alias read in
// the same file, which is exactly how `owner-dashboard.ts` hid a raw
// `e.payload->>'drug_name'` read past this fence (see KNOWN_READERS below —
// reverting that file's `amendedPayloadText` call must turn this fence red).
// A same-form, same-file, multiple-read gap remains and is accepted debt, not
// a silent hole: it needs an AST pass to close properly, not a wider regex.
//
// R1 is strict: an R1 reader must call `overlayAmendments(` itself, and if it
// narrows its fetch by event type it must also fetch `event_amended` — an
// overlay over a stream with no corrections in it is the A08-G1 bug with a
// type-correct call site (the brand on the replay input, `AmendmentOverlaid`,
// proves the call happened, not what was fetched). R1 readers cannot be
// allowlisted.
//
// R2 is deliberately wide, so an R2 reader passes when it calls
// `overlayAmendments(` or imports the SQL twin, or when ALLOWLIST classifies it
// (see the kinds below). Stale entries fail too: an entry for a file that no
// longer reads, or that now overlays directly, is a reason nobody is checking.
//
// Run: pnpm lint:amendment-overlay

import { globSync, readFileSync } from "node:fs";

import { AMENDABLE_EVENT_TYPES } from "../lib/infra/amendment";

type Violation = { file: string; message: string };

// Every file the R2 scan flags that does NOT fold corrections directly. Each
// entry is a reviewed classification, not an excuse:
//
//   via           — folds corrections through something other than a direct
//                   call. `via` names the token that does it and the fence
//                   checks the token is really in the file, so deleting the
//                   helper call turns this red.
//   other-type    — the payload it reads belongs to a type OUTSIDE the
//                   allowlist; the amendable name is there for a count or a
//                   write, never a payload read.
//   raw-by-design — the stored value IS the one it needs (identity of a row the
//                   code itself wrote, a seeder's own tag, a backfill that
//                   replays what the write-time trigger saw).
//   debt          — a real raw read of an amendable payload, outside T3-A1's
//                   write-path scope. Listed so it is counted and cannot grow
//                   silently; each one is a follow-up, not a reason. Fixing one
//                   means deleting its entry — the stale check demands it.
//
// Inventory taken 2026-09-22: 24 files on the Drizzle form, 8 more once the
// raw-SQL alias form joined R2 (fresh security review, same day).
type Classification =
  | { kind: "via"; via: string; reason: string }
  | { kind: "other-type" | "raw-by-design" | "debt"; reason: string };

const ALLOWLIST: Record<string, Classification> = {
  // --- via -------------------------------------------------------------------
  "lib/analytics/govt-home-kpis.ts": {
    kind: "via",
    via: "rabiesDoseQualifies(",
    reason:
      "rabies numerators read vaccine_name/next_due_at through rabiesDoseQualifies (lib/metrics/rabies.ts → amendedPayloadText); sterilization is only counted; the other payload reads are incident/disease types",
  },
  "src/modules/pets/application/read/load-public-credential.ts": {
    kind: "via",
    via: '"event_amended"',
    reason:
      "fetches the pet's event_amended rows and returns them with the vaccination rows (rabiesEvents) for credential-badges.ts to overlay; latestVaccinationRows feeds computeConfidence, which grades the authorship attestation as recorded",
  },
  "lib/metrics/rabies.ts": {
    kind: "via",
    via: "am.event_type = 'event_amended'",
    reason:
      "rabiesDoseQualifies is itself an inline twin of amendedPayloadText: one probe over every event_amended on the dose, read for vaccine_name and next_due_at (latest correction touching each field)",
  },
  // --- other-type ------------------------------------------------------------
  "lib/analytics/org-dashboard.ts": {
    kind: "other-type",
    reason:
      "alias payload reads are adoption decisions, medication_stopped/dose links and transfer events; vaccination/deworming are read through the proxima_dosis_at COPY column, a known class outside this fence (see header)",
  },
  "src/modules/panorama/infrastructure/repository-choropleth.ts": {
    kind: "other-type",
    reason:
      "sterilization/deworming are counted by event_type only; the one alias payload read is status_changed.to_status",
  },
  "lib/analytics/compliance-metrics.ts": {
    kind: "other-type",
    reason:
      "payload reads are microchip_replaced / status_changed / shelter_intake_recorded (its header says so); sterilization_performed appears only in a COUNT",
  },
  "lib/analytics/dashboards/surveillance.ts": {
    kind: "other-type",
    reason:
      "payload reads are disease/outbreak events; vaccination_administered is only counted by occurred_at",
  },
  "src/modules/adoption/infrastructure/adoption-repository.ts": {
    kind: "other-type",
    reason: "payload reads are adoption events; note_added is only written",
  },
  "src/modules/cases/application/close-followup-expired-adoptions.ts": {
    kind: "other-type",
    reason: "payload read is the adoption follow-up window; note_added is only written",
  },
  "src/modules/transfers/infrastructure/transfers-repository.ts": {
    kind: "other-type",
    reason: "payload read is custody_transfer_proposed; note_added is only written",
  },
  "scripts/seed-panorama.ts": {
    kind: "other-type",
    reason:
      "payload reads are pet_registered / incident_reported seed tags; the amendable types are only written",
  },
  // --- raw-by-design ---------------------------------------------------------
  "app/org/[orgToken]/adopciones/page.tsx": {
    kind: "raw-by-design",
    reason:
      "the only amendable read is the system-written note_added (kind='adoption_info_requested') matched by its application_event_id link — identity of a row the flow wrote; the rest are adoption events",
  },
  "src/modules/adoption/infrastructure/my-applications-read.ts": {
    kind: "raw-by-design",
    reason:
      "same system-written adoption_info_requested note linked by application_event_id; the rest are adoption events",
  },
  "scripts/seed-demo-compliance-coverage.ts": {
    kind: "raw-by-design",
    reason: "seeder idempotency on its own payload.source = 'DEMO-coverage' tag",
  },
  "scripts/verify-history-coverage.ts": {
    kind: "raw-by-design",
    reason:
      "operator diagnostic that counts which years hold rows per source; it answers 'is there history', not a user-facing number",
  },
  "app/(public)/p/[publicToken]/encontre/action.ts": {
    kind: "raw-by-design",
    reason:
      "idempotency probe for the finder_in_possession note this action itself wrote — it must match the stored value",
  },
  "src/modules/return-to-owner/application/proposal-queries.ts": {
    kind: "raw-by-design",
    reason: "finds the system-written note by the marker it was written with",
  },
  "src/modules/events/application/lifecycle/report-lost-feed-item-use-case.ts": {
    kind: "raw-by-design",
    reason:
      "checks the reported row was AUTHORED as a sighting/finder note — the authored kind, not a corrected one",
  },
  "src/modules/pets/application/pregnancy/record-pregnancy-ended.ts": {
    kind: "raw-by-design",
    reason:
      "cancels the reminders spawned by the stored 'started' rows; the status itself is derived by rederivePregnancyStatus, which overlays",
  },
  "scripts/backfill-eno-trigger.ts": {
    kind: "raw-by-design",
    reason:
      "one-time replay of the ENO notification the write-time trigger should have fired on the payload as written",
  },
  "scripts/seed-demo-polish.ts": {
    kind: "raw-by-design",
    reason: "seeder reasoning over the demo rows it wrote",
  },
  "scripts/seed-demo-scenario.ts": {
    kind: "raw-by-design",
    reason: "seeder idempotency on its own payload.source tag",
  },
  "scripts/seed-owner-demo.ts": {
    kind: "raw-by-design",
    reason: "seeder idempotency on its own payload.source tag",
  },
  // --- debt ------------------------------------------------------------------
  "app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/medicacion-fin/page.tsx": {
    kind: "debt",
    reason: "lists open medications with the RAW drug_name",
  },
  "app/org/[orgToken]/atender/atender-declared-events.ts": {
    kind: "debt",
    reason:
      "fetchSignableRows reads sterilization_performed (upcast, NOT overlaid): the vet's sign-off card labels and prefills `procedure` from the owner's declaration as first written. Not a one-liner — needs event_amended in the fetch plus overlayAmendments before toPendingDeclaredEvent",
  },
  "lib/metrics/movement.ts": {
    kind: "debt",
    reason: "counts movement_recorded by RAW sub_kind",
  },
  "lib/analytics/dashboards/perdidas.ts": {
    kind: "debt",
    reason: "sighting notes read RAW (kind, location_description)",
  },
  "lib/infra/lost-mode.ts": {
    kind: "debt",
    reason: "sighting notes read RAW (kind, location_description)",
  },
  "src/modules/lost/infrastructure/lost-listing-read.ts": {
    kind: "debt",
    reason: "sighting notes read RAW (kind, location_description)",
  },
  "src/modules/panorama/infrastructure/repository-scope.ts": {
    kind: "debt",
    reason: "sighting predicate on RAW note_added.kind",
  },
};

const SOURCE_GLOBS = [
  "app/**/*.{ts,tsx}",
  "lib/**/*.{ts,tsx}",
  "src/**/*.{ts,tsx}",
  "scripts/**/*.ts",
];

const EXCLUDED = [
  /\.test\.tsx?$/,
  /\/__tests__\//,
  /\.d\.ts$/,
  // Definitions, not readers.
  /^lib\/projections\//,
  /^lib\/infra\/amendment(-sql)?\.ts$/,
  // This file names every amendable type by construction.
  /^scripts\/check-amendment-overlay\.ts$/,
];

// Non-vacuity: these are known R1 readers today. If the scan stops seeing
// them, the detector broke, not the codebase.
const KNOWN_READERS = [
  "lib/infra/rederive-pet-cache.ts",
  "scripts/rebuild-projections.ts",
  "src/modules/events/infrastructure/events-repository.ts",
  "src/modules/pets/application/pregnancy/rederive-pregnancy-status.ts",
  "src/modules/events/application/amendment/refresh-pet-cache-after-amendment.ts",
  // Alias-form anchors (R2 raw SQL): if these vanish, the alias scan broke.
  "lib/analytics/surveillance-metrics.ts",
  "lib/metrics/rabies.ts",
  // File-vs-form anchor: owner-dashboard.ts calls overlayAmendments( for
  // unrelated Drizzle reads AND amendedPayloadText( for the raw alias read in
  // fetchOngoingMedications — reverting the latter to a raw read must turn
  // this fence red even though overlayAmendments( is still in the file.
  "lib/analytics/owner-dashboard.ts",
];
const MIN_READERS = 40;

function norm(p: string): string {
  return p.replaceAll("\\", "/");
}

function stripComments(src: string): string {
  // Comments legitimately NAME the helper ("we do not use overlayAmendments
  // here because…"); a comment must not satisfy the rule or trip it.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function namesAmendableType(src: string): boolean {
  return AMENDABLE_EVENT_TYPES.some((t) => new RegExp(`["'\`]${t}["'\`]`).test(src));
}

/**
 * R2's two forms — BOTH are detected, not just the first found. A file can
 * carry both (owner-dashboard.ts does: Drizzle reads elsewhere, plus a raw
 * alias read in fetchOngoingMedications), and picking only one used to hide
 * whichever form lost the priority order — always the alias form, since the
 * Drizzle check ran first. The alias form needs the raw table name in the
 * file so a `.payload->>` on some other table's JSON column (notifications,
 * audit_log) is not a pet_events read.
 */
function payloadReadForms(src: string): Array<"petEvents.payload" | "pet_events alias"> {
  const forms: Array<"petEvents.payload" | "pet_events alias"> = [];
  if (/\bpetEvents\.payload\b/.test(src)) forms.push("petEvents.payload");
  // `alias.payload` or a bare `payload` followed by a JSONB operator (->, ->>,
  // #>, #>>) or a containment test (@>, ?).
  const rawRead = /(?:\b(?!petEvents\b)[A-Za-z_]\w*\.|[^\w.$])payload\s*(?:->|#>|@>|\?)/;
  // The table is named either literally or interpolated (`FROM ${petEvents} pe`).
  if (/\bpet_events\b|\$\{petEvents\}/.test(src) && rawRead.test(src)) {
    forms.push("pet_events alias");
  }
  return forms;
}

/** R3: only overlayAmendments may mint the brand. */
const BRAND_MINTER = "lib/infra/amendment.ts";
// `as X & AmendmentOverlaidBrand`, `as unknown as AmendmentOverlaid<T>` and
// `as import("…/types").AmendmentOverlaid<T>` alike: anything up to the end of
// the expression (`;`, `,`, `=` or the line end) that names the brand — INCLUDING
// across lines, since a long cast is exactly the shape biome/prettier wraps:
//   const x = raw as unknown as
//     AmendmentOverlaid<ProjectionEvent>;
// The character class used to exclude `\n`, so that (entirely ordinary) wrap
// made the cast invisible to this fence. Only `;`, `,` and `=` still bound the
// match — those really do end the expression wherever they land.
export const BRAND_CAST = /\bas\s+[^;,=]*\bAmendmentOverlaid/;

/**
 * Balanced-paren argument list starting at an open-paren index. Same shape as
 * check-authz-guards.ts's paramListAt — kept local rather than shared since
 * these two fences are deliberately dependency-free from each other.
 *
 * STRING-AWARE (fresh-context review, pre-push): a `(` or `)` INSIDE a quoted
 * string or template literal — `pick(events, "(unbalanced")` — used to be
 * counted as real paren structure, so the depth counter could close early (or
 * never close) and return the wrong slice, silently truncating or corrupting
 * the argument list the forged-cast scan below reads. `skipStringLiteral`
 * (already used by `splitTopLevelArgs` and `isFullyParenthesized` for the
 * same reason) jumps whole string/template spans so their contents can never
 * be mistaken for call structure.
 */
export function argListAt(src: string, openParenIndex: number): string {
  let depth = 0;
  let i = openParenIndex;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIndex + 1, i);
    }
    i++;
  }
  return "";
}

/**
 * Advances past a quoted string or template literal starting at `src[i]`
 * (which must be `"`, `'` or `` ` ``), honouring backslash escapes. Returns
 * the index just past the closing quote (or `src.length` if it never closes,
 * which only happens on malformed input the type checker would already
 * reject). Used by both `splitTopLevelArgs` and the paren-unwrapper below so
 * a comma or a stray `)` INSIDE a string — `", x as any"` — is never mistaken
 * for real argument structure.
 */
function skipStringLiteral(src: string, startIndex: number): number {
  const quote = src[startIndex];
  let i = startIndex + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * Splits an argument-list string (the text `argListAt` returns, WITHOUT the
 * enclosing call parens) on top-level commas only: `()`, `[]` and `{}` are
 * depth-tracked, and quoted/template-literal text is skipped whole, so a
 * comma inside a nested call, object, array or string is never treated as an
 * argument boundary. `""` (a call with no arguments) yields `[]`, not `[""]`.
 *
 * This is the fix for the reviewer's TOO-NARROW case: the old regex's
 * `[^,()]*` could not cross a nested call's parens at all, so
 * `pick(events, "x") as any` was invisible to it. Walking depth instead of
 * excluding parens from a character class sees straight through it.
 */
export function splitTopLevelArgs(argsSrc: string): string[] {
  if (argsSrc.trim().length === 0) return [];
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < argsSrc.length) {
    const ch = argsSrc[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(argsSrc, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(argsSrc.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(argsSrc.slice(start));
  return parts;
}

/** True when `s` (trimmed) is wrapped in a SINGLE pair of parens that spans
 * the whole string — `(raw as any)` — as opposed to one that merely starts
 * and ends with a paren character, such as `f(a) + g(a)`. */
function isFullyParenthesized(s: string): boolean {
  if (!(s.startsWith("(") && s.endsWith(")"))) return false;
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(s, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      // Closed before the string's last character: the opening paren does
      // not reach all the way to the end, so it does not wrap the WHOLE arg.
      if (depth === 0 && i !== s.length - 1) return false;
    }
    i++;
  }
  return depth === 0;
}

function unwrapFullyParenthesized(s: string): string {
  let out = s;
  while (isFullyParenthesized(out)) out = out.slice(1, -1).trim();
  return out;
}

// R3's unnamed forgery: `as any` / `as never` bypasses the type system
// entirely, so a stream that was never overlaid can reach a `replayPet*` call
// expecting `AmendmentOverlaid<ProjectionEvent>` without ever writing the
// brand's name — invisible to BRAND_CAST by construction.
const TOP_LEVEL_CAST_SUFFIX_RE = /\bas\s+(?:any|never)\b\s*$/;
// The OTHER TypeScript cast syntax: `<any>expr` / `<never>expr` (legal in
// .ts, not .tsx — but this scan runs over .ts sources too, and the forgery is
// identical either way). Same erasure, spelled with a leading angle-bracket
// cast instead of a trailing `as`, and just as invisible to BRAND_CAST since
// neither form names `AmendmentOverlaid`.
const TOP_LEVEL_CAST_PREFIX_RE = /^<\s*(?:any|never)\s*>/;

/**
 * True when a SINGLE argument (one element of `splitTopLevelArgs`'s result)
 * is a forgery: trimmed and unwrapped of any parens enclosing the whole
 * expression, it either ends in a top-level `as any`/`as never` or STARTS
 * with the angle-bracket form `<any>`/`<never>` — a cast on the argument
 * expression ITSELF, not one buried inside something the argument merely
 * contains.
 *
 *   pick(events, "x") as any        → true  (casts the whole argument)
 *   (raw as any)                    → true  (the wrapping paren encloses it)
 *   <any>raw                        → true  (angle-bracket cast form)
 *   (<never>raw)                    → true  (wrapped angle-bracket form)
 *   { meta: raw as any }            → false (the cast is inside the object;
 *                                             the argument itself is `{…}`)
 *   overlayAmendments(events as any) → false (the RAW stream is cast, but
 *                                              overlayAmendments still runs on
 *                                              it before the replay sees it)
 *
 * `\s` in the trailing regex matches newlines too, so a biome-wrapped
 * `raw as\n  any` still matches — this is what fixes the reviewer's
 * TOO-BROAD case in the other direction: it no longer needs a same-line cast.
 */
export function isForgedCastArgument(rawArg: string): boolean {
  const expr = unwrapFullyParenthesized(rawArg.trim());
  return TOP_LEVEL_CAST_SUFFIX_RE.test(expr) || TOP_LEVEL_CAST_PREFIX_RE.test(expr);
}

const FORGED_CAST_MESSAGE = (name: string): string =>
  `${name}(…) is called with \`as any\`/\`as never\` applied directly to one of its arguments — that erases the \`AmendmentOverlaid<ProjectionEvent>\` parameter type entirely, the same forgery as an explicit \`as AmendmentOverlaid\` cast with no name to grep for (R3). Overlay first (overlayAmendments(events)), then pass the result — never cast an argument past the type.`;

/**
 * Scans `src` for calls to any name in `replayNames` and returns one message
 * per call whose argument list contains a forged cast (per
 * `isForgedCastArgument`, checked against EACH top-level argument — a call
 * can have more than one). Exported so tests can drive it directly on inline
 * source strings, the way check-authz-guards.test.ts drives its finders.
 */
export function findForgedCastCalls(src: string, replayNames: string[]): string[] {
  if (replayNames.length === 0) return [];
  const out: string[] = [];
  const callRe = new RegExp(`\\b(${replayNames.join("|")})\\s*\\(`, "g");
  for (const m of src.matchAll(callRe)) {
    const openParen = (m.index ?? 0) + m[0].length - 1;
    const args = splitTopLevelArgs(argListAt(src, openParen));
    if (args.some((arg) => isForgedCastArgument(arg))) {
      out.push(FORGED_CAST_MESSAGE(m[1]));
    }
  }
  return out;
}

function brandForgers(replays: string[]): Violation[] {
  const all = [...SOURCE_GLOBS, "__tests__/**/*.{ts,tsx}"].flatMap((g) => globSync(g)).map(norm);
  const files = [...new Set(all)]
    .filter((f) => f !== BRAND_MINTER && f !== "scripts/check-amendment-overlay.ts")
    .sort();

  const violations: Violation[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    if (BRAND_CAST.test(src)) {
      violations.push({
        file,
        message: `casts to AmendmentOverlaid — only overlayAmendments (${BRAND_MINTER}) may mint the brand (R3)`,
      });
    }
    for (const message of findForgedCastCalls(src, replays)) {
      violations.push({ file, message });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file));
}

function amendableReplays(): string[] {
  const names = new Set<string>();
  for (const f of globSync("lib/projections/*.ts").map(norm)) {
    if (/\.test\.ts$/.test(f)) continue;
    const src = stripComments(readFileSync(f, "utf8"));
    if (!namesAmendableType(src)) continue;
    for (const m of src.matchAll(/export function (replay\w+)\s*\(/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/** R1: a replay caller overlays itself and fetches the corrections it folds. */
function checkReplayReader(file: string, src: string, r1: string[]): Violation[] {
  const out: Violation[] = [];
  const replayed = r1.join(", ");
  if (ALLOWLIST[file]) {
    out.push({
      file,
      message: `replays an amendable stream (${replayed}) — R1 readers cannot be allowlisted`,
    });
  }
  if (!/\boverlayAmendments\s*\(/.test(src)) {
    out.push({
      file,
      message: `replays an amendable stream (${replayed}) without overlayAmendments`,
    });
    return out;
  }
  const narrowsByType = /\b(inArray|eq)\(\s*petEvents\.eventType\b/.test(src);
  if (narrowsByType && !/["'`]event_amended["'`]/.test(src)) {
    out.push({
      file,
      message: `narrows its fetch by event type but never fetches "event_amended" — the overlay folds nothing (A08-G1 shape)`,
    });
  }
  return out;
}

/**
 * R2 coverage differs by form, and conflating them was itself a gap (fresh
 * security review, 2026-09-22): `overlayAmendments(` runs on FETCHED JS rows,
 * so a file that calls it ANYWHERE genuinely overlays every Drizzle-column
 * read it later folds through that call — that exemption stays file-level on
 * purpose (see the header's KNOWN CLASS note; tracking WHICH fetch feeds
 * WHICH `overlayAmendments(` call needs data-flow analysis this text-based
 * fence does not do). A raw-SQL alias read (`e.payload->>'field'`) is a
 * different animal: the correction has to be folded INSIDE that same SQL
 * text via `amendedPayloadText(`, so `overlayAmendments(` elsewhere in the
 * file — or merely importing the amendment-sql module without calling it —
 * proves nothing about that read. `owner-dashboard.ts` is the concrete case:
 * it calls `overlayAmendments(` four times for unrelated Drizzle reads, which
 * used to blanket-exempt a RAW `e.payload->>'drug_name'` alias read the fence
 * never actually checked (fetchOngoingMedications, fixed same review).
 */
function checkPayloadReader(file: string, src: string, form: string): Violation[] {
  const overlays =
    form === "pet_events alias"
      ? /\bamendedPayloadText\s*\(/.test(src)
      : /\boverlayAmendments\s*\(/.test(src) || /from\s+["'][^"']*amendment-sql["']/.test(src);
  const entry = ALLOWLIST[file];
  if (!entry) {
    return overlays
      ? []
      : [
          {
            file,
            message:
              form === "pet_events alias"
                ? `reads an amendable payload (${form}) without calling amendedPayloadText — overlayAmendments() only folds fetched JS rows, not raw SQL text`
                : `reads an amendable payload (${form}) without overlayAmendments / amendment-sql`,
          },
        ];
  }
  if (overlays) {
    return [
      {
        file,
        message: `allowlisted as "${entry.kind}" but now overlays directly — drop the entry`,
      },
    ];
  }
  if (entry.kind === "via" && !src.includes(entry.via)) {
    return [
      {
        file,
        message: `allowlisted as folding corrections via \`${entry.via}\`, which is no longer in the file`,
      },
    ];
  }
  if (entry.reason.trim().length < 20) {
    return [{ file, message: "allowlist reason is too thin to be reviewed" }];
  }
  return [];
}

/** Non-vacuity and stale-entry checks over the whole scan. */
function checkScan(files: string[], readers: string[]): Violation[] {
  const out: Violation[] = [];
  for (const known of KNOWN_READERS) {
    if (!readers.includes(known)) {
      out.push({ file: known, message: "known reader not detected — the scan is vacuous" });
    }
  }
  if (readers.length < MIN_READERS) {
    out.push({
      file: "(scan)",
      message: `only ${readers.length} reader(s) detected; floor is ${MIN_READERS}`,
    });
  }
  for (const file of Object.keys(ALLOWLIST)) {
    if (!files.includes(file)) {
      out.push({ file, message: "allowlisted file does not exist — drop the entry" });
    }
  }
  return out;
}

function main(): void {
  const replays = amendableReplays();
  const violations: Violation[] = [];

  if (replays.length < 3) {
    violations.push({
      file: "lib/projections",
      message: `only ${replays.length} amendable replay(s) found (${replays.join(", ")}); expected at least replayPetWeight, replayPetPregnancy, replayPetJurisdiction — the derivation broke`,
    });
  }

  const files = [...new Set(SOURCE_GLOBS.flatMap((g) => globSync(g)).map(norm))]
    .filter((f) => !EXCLUDED.some((re) => re.test(f)))
    .sort();

  const readers: string[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    const r1 = replays.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(src));
    const forms = namesAmendableType(src) ? payloadReadForms(src) : [];
    if (r1.length === 0 && forms.length === 0) {
      if (ALLOWLIST[file]) {
        violations.push({
          file,
          message: "allowlisted but no longer reads an amendable payload — drop the entry",
        });
      }
      continue;
    }
    readers.push(file);
    // Each present form is checked independently — a file with BOTH a
    // Drizzle-column read and a raw alias read must satisfy BOTH coverage
    // mechanisms, not whichever one happens to be true.
    violations.push(
      ...(r1.length > 0
        ? checkReplayReader(file, src, r1)
        : forms.flatMap((form) => checkPayloadReader(file, src, form))),
    );
  }
  violations.push(...checkScan(files, readers), ...brandForgers(replays));

  if (violations.length > 0) {
    console.error(`check-amendment-overlay: ${violations.length} violation(s)\n`);
    for (const v of violations) console.error(`  ${v.file}: ${v.message}`);
    console.error(
      "\nFold corrections with overlayAmendments (lib/infra/amendment.ts) or the SQL twin (lib/infra/amendment-sql.ts), or classify the file in ALLOWLIST with a reason.",
    );
    process.exit(1);
  }
  const debt = Object.values(ALLOWLIST).filter((e) => e.kind === "debt").length;
  console.log(
    `check-amendment-overlay: ${readers.length} reader(s) of ${AMENDABLE_EVENT_TYPES.length} amendable type(s) checked (replays: ${replays.join(", ")}); ${debt} raw-read debt entr${debt === 1 ? "y" : "ies"} listed.`,
  );
}

// Guard: only scan when run directly; importing (tests) exposes the helpers
// without triggering the filesystem scan. Same shape as
// scripts/check-authz-guards.ts's own guard.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-amendment-overlay.ts") ||
    process.argv[1].endsWith("check-amendment-overlay.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  main();
}
