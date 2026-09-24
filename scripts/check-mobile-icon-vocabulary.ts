// Mobile icon-vocabulary fence — CI guard (placeholder glyphs, glyph collisions, silent table drift).
//
// WHY THIS EXISTS, AND WHY THE FENCE THAT ALREADY EXISTED DID NOT CATCH IT.
// `apps/mobile/src/ui/Icon.test.tsx` has fenced this table since 2026-09-01. It
// asserts every value in PET_PROFILE_ICONS resolves to a real export of
// `lucide-react-native`. That test was green on 2026-09-03 while the table read:
//
//     embarazo:      "Baby"     ← a national sanitary registry drawing an
//                                 INFANT over a pregnant animal
//     fallecimiento: "Circle"   ← a bare circle for death: a placeholder that
//                                 shipped and that nobody looked at again
//
// Both resolve. `Baby` is a real lucide export; so is `Circle`. A fence that
// asks "does this glyph exist" cannot answer "does this glyph mean anything",
// and its green was read for a week as if it had. That is the failure this file
// is built around: NOT that the table was wrong, but that a passing check
// covered it. See docs/mobile/eas-build-profiles.md for the same shape in the
// build (a `catch` that could never run).
//
// WHAT A FENCE CAN AND CANNOT DECIDE. It cannot decide that `Baby` is the wrong
// picture for `embarazo` — that is a judgement, and pretending to automate it
// would produce exactly the false comfort described above. What it CAN decide
// is mechanical. Rule A would have caught `fallecimiento: "Circle"` on the
// shipped table. Rule B fires on nothing that has ever shipped — its one
// collision (`alert`/`alert-triangle`) is declared below, and it exists to stop
// the NEXT one, which is a forward guard and not a caught defect. Saying that
// plainly matters here of all places: the whole reason this file exists is that
// a green check was read as evidence it had never earned.
//
// THREE RULES:
//
//   (A) NO PLACEHOLDER GLYPHS. A bare geometric primitive carries no meaning,
//       so it is never a considered choice — it is what someone types to make
//       the type-checker stop complaining, intending to come back. `Circle` for
//       `fallecimiento` is that, and it reached a store build. HARD rule, no
//       baseline: the correct count is zero and always was.
//
//   (B) ONE GLYPH, ONE CONCEPT. Two keys pointing at the same glyph means the
//       interface says the same thing with two words, or — worse — two
//       different things with one picture. Today `alert` and `alert-triangle`
//       both map to `AlertTriangle`. Deliberate aliases are allowed but must be
//       DECLARED below with a reason, so the next one is a decision instead of
//       an accident. This rule is also what stops the `girar` → `RefreshCw`
//       collision from spreading: the flip control and a future data-refresh
//       control cannot quietly wear the same picture. The declarations are
//       checked in BOTH directions — an alias that no longer collides is a dead
//       permission, and a dead permission is how the next real collision gets
//       waved through.
//
//   (C) NON-VACUITY, AND THE PIN. Every rule above scans a table this script
//       must first FIND and PARSE. If the path moves, the export is renamed, or
//       the regex stops matching, a scan of zero entries would satisfy A and B
//       perfectly and this fence would report success forever. So the whole
//       table is pinned, PAIR BY PAIR, in `PINNED_TABLE`: an unreadable file, a
//       parse of zero, a count under the floor, or any key→glyph pair that
//       differs from the pin is a FAILURE and not a pass.
//
//       PAIRS AND NOT A COUNT, and that change has one purpose. A count (or a
//       digest) tells a reviewer that something moved and nothing about what;
//       the update ritual is "paste the number the tool printed", which is the
//       same reflex that let `Baby` through. A pair list makes the failure read
//       `- embarazo:CalendarHeart / + embarazo:Baby` inside THIS file — the file
//       whose header argues about what glyphs may mean — so a glyph swap is a
//       two-file diff whose second file is the one reviewers read for intent.
//       It does not make the fence able to judge `Baby`. Nothing can. It makes
//       the judgement unavoidable instead of optional.
//
//       This rule is also the reason the file exists in this shape. The six
//       design fences this repo runs over the web (lint:icons, lint:buttons,
//       lint:states, lint:empty-states, lint:screens, lint:copy-contract) all
//       resolve their globs against the root Next.js tree and NONE of them
//       include apps/mobile — `lint:buttons` even counts literal `<button>`
//       tags, which React Native does not have. Pointed at the mobile client
//       they would all pass, having read nothing. A fence that cannot prove it
//       looked at something is indistinguishable from no fence, and it is worse
//       than no fence because it appears in a green list.
//
// THE OTHER SIDE OF THE TABLE is fenced elsewhere and deliberately not here:
// `components/Icon.test.tsx` (root vitest) compares the shared table against
// the web's own ICON_MAP by component REFERENCE, which a string-matching parser
// in this file could not do without reading an alias rename as a violation.
//
// Run: pnpm tsx scripts/check-mobile-icon-vocabulary.ts   (or: pnpm lint:mobile-icons)
// Exits 1 with a reason per violation. Exits 0 if clean.

import { readFileSync } from "node:fs";

const TABLE_FILE = "packages/contract/src/icons/pet-profile-icons.ts";
const TABLE_EXPORT = "PET_PROFILE_ICONS";
const THIS_FILE = "scripts/check-mobile-icon-vocabulary.ts";

/**
 * Lucide exports that are bare geometry and therefore never a considered
 * choice for a domain concept. Not a style opinion: each of these is a shape
 * with no subject, so it cannot be right or wrong about anything, which is
 * precisely why it survives review.
 */
const PLACEHOLDER_GLYPHS = new Set([
  "Circle",
  "Square",
  "Box",
  "Dot",
  "Minus",
  "Slash",
  "HelpCircle",
  "CircleDashed",
  "SquareDashed",
]);

/**
 * Glyphs deliberately shared by more than one vocabulary key, with the reason.
 * An entry here is a decision on the record; anything else that collides is a
 * failure. Keep the key set sorted so a diff reads cleanly.
 */
const DECLARED_ALIASES: Record<string, { keys: string[]; reason: string }> = {
  AlertTriangle: {
    keys: ["alert", "alert-triangle"],
    reason:
      "The web ICON_MAP carries both spellings and this table matches it verbatim by design (see the file header: change a glyph THERE first). Collapsing one here would break that parity, so the duplication is inherited rather than chosen. Remove BOTH sides together or not at all.",
  },
};

/** Floor below which the table cannot plausibly be the real one. */
const MIN_ENTRIES = 15;

/**
 * Exact `key:glyph` pairs, sorted by key, as of the last reviewed change; update
 * it in the SAME commit that changes any glyph or key, so the swap lands in THIS
 * file's diff next to the rules that decide what a glyph may mean. Last change:
 * `fallecimiento: HeartOff → Flower2` — a crossed heart is not how you mourn.
 */
const PINNED_TABLE = [
  "alert:AlertTriangle",
  "alert-triangle:AlertTriangle",
  "casa:Home",
  "check:Check",
  "check-circle:CheckCircle",
  "corazon:Heart",
  "edit:Pencil",
  "ellipsis:MoreHorizontal",
  "embarazo:CalendarHeart",
  "fallecimiento:Flower2",
  "girar:RefreshCw",
  "libreta:BookOpen",
  "map-pin:MapPin",
  "medicacion:Pill",
  "ocultar:EyeOff",
  "paw:PawPrint",
  "perdida:Siren",
  "share:Share2",
  "shield:Shield",
  "ver:Eye",
];

export type Entry = { key: string; glyph: string; line: number };

export function parseTable(source: string): Entry[] {
  const start = source.indexOf(`export const ${TABLE_EXPORT} = {`);
  if (start === -1) return [];
  const end = source.indexOf("} as const;", start);
  if (end === -1) return [];

  const body = source.slice(start, end);
  const lineOffset = source.slice(0, start).split("\n").length;

  const entries: Entry[] = [];
  body.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("//") || line.length === 0) return;
    // `key: "Glyph",` or `"quoted-key": "Glyph",`
    const m = line.match(/^"?([A-Za-z0-9_-]+)"?\s*:\s*"([A-Za-z0-9]+)"\s*,?/);
    if (m) entries.push({ key: m[1], glyph: m[2], line: lineOffset + i });
  });
  return entries;
}

/**
 * Every violation the three rules find in one table source, in order.
 *
 * Separated from the runner so it can be exercised against fixtures — the fence
 * itself is code, and a fence nobody tests is the shape of failure this file's
 * header is about. `source` is the table file's text; the empty string means
 * "could not be read", which is a Rule C failure and stops there rather than
 * producing a second, misleading "parsed zero" alongside it.
 */
export function evaluate(source: string): string[] {
  // Rule C first: everything below is meaningless without it, and an
  // unreadable source stops here rather than producing a second, misleading
  // "parsed zero" beside the one failure that names the remedy.
  if (!source) {
    return [
      `Rule C (non-vacuity): could not read ${TABLE_FILE}, or it is empty. The vocabulary moved; this fence is blind until the path is updated, and a blind fence must not report success.`,
    ];
  }
  const entries = parseTable(source);
  return [...ruleC(entries), ...ruleA(entries), ...ruleB(entries)];
}

/** Rule C over a parsed table: the floors, then the pinned pair list. */
function ruleC(entries: Entry[]): string[] {
  if (entries.length === 0) {
    return [
      `Rule C (non-vacuity): parsed ZERO entries from ${TABLE_FILE}. The export \`${TABLE_EXPORT}\` was renamed, reshaped, or the parser no longer matches it. Rules A and B would pass vacuously, so this is a failure.`,
    ];
  }
  if (entries.length < MIN_ENTRIES) {
    return [
      `Rule C (non-vacuity): parsed only ${entries.length} entries from ${TABLE_FILE}, below the floor of ${MIN_ENTRIES}. Either the table really shrank that far — in which case say so by lowering MIN_ENTRIES — or the parser is missing rows.`,
    ];
  }
  // Sorted BY KEY, not by the pair string: `-` sorts before `:` in UTF-16, so
  // sorting the joined pairs would put `alert-triangle` above `alert` and make
  // the pin's reading order disagree with its own comparison.
  const actual = entries
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((e) => `${e.key}:${e.glyph}`);
  if (actual.join("\n") === PINNED_TABLE.join("\n")) return [];

  const removed = PINNED_TABLE.filter((p) => !actual.includes(p));
  const added = actual.filter((p) => !PINNED_TABLE.includes(p));
  const diff = [...removed.map((p) => `  - ${p}`), ...added.map((p) => `  + ${p}`)].join("\n");
  return [
    `Rule C (pinned table): the vocabulary no longer matches PINNED_TABLE in ${THIS_FILE}.\n${diff}\nA glyph change is a product decision (the web's components/Icon.tsx is the authority, the contract table follows it): update PINNED_TABLE in the same commit so the change is visible in review instead of quiet.`,
  ];
}

/** Rule A: a bare geometric primitive is never a considered choice. */
function ruleA(entries: Entry[]): string[] {
  return entries
    .filter((e) => PLACEHOLDER_GLYPHS.has(e.glyph))
    .map(
      ({ key, glyph, line }) =>
        `Rule A (placeholder glyph): ${TABLE_FILE}:${line} maps \`${key}\` to \`${glyph}\`, a bare geometric primitive. It resolves in lucide, which is why the existing Icon.test.tsx passes on it, but it does not mean anything. Choose a glyph that is about ${key}.`,
    );
}

/** Rule B, both directions: an undeclared collision, and a declaration that no
 *  longer describes one. */
function ruleB(entries: Entry[]): string[] {
  const byGlyph = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = byGlyph.get(e.glyph) ?? [];
    list.push(e);
    byGlyph.set(e.glyph, list);
  }

  const failures: string[] = [];
  for (const [glyph, list] of byGlyph) {
    if (list.length < 2) continue;
    const keys = list.map((e) => e.key).sort();
    const declared = DECLARED_ALIASES[glyph];
    if (declared && declared.keys.slice().sort().join(",") === keys.join(",")) continue;
    failures.push(
      `Rule B (glyph collision): \`${glyph}\` is used by ${keys.length} keys — ${keys.map((k) => `\`${k}\``).join(", ")} — at ${TABLE_FILE}:${list.map((e) => e.line).join(", ")}. Two names for one picture, or one picture for two meanings. If it is deliberate, declare it in DECLARED_ALIASES with the reason.`,
    );
  }

  // NO STALE BASELINE. A declaration that no longer describes a real collision
  // is a standing permission for a collision nobody decided on — the same shape
  // scripts/check-audit-log-coverage.ts guards. Skipped when the table did not
  // parse at all: every alias would look dead, burying the real failure.
  if (entries.length === 0) return failures;
  for (const [glyph, declared] of Object.entries(DECLARED_ALIASES)) {
    const keys = (byGlyph.get(glyph) ?? []).map((e) => e.key).sort();
    if (keys.length >= 2 && keys.join(",") === declared.keys.slice().sort().join(",")) continue;
    failures.push(
      `Rule B (stale alias): DECLARED_ALIASES in ${THIS_FILE} declares \`${glyph}\` shared by ${declared.keys.map((k) => `\`${k}\``).join(", ")}, but the table now has ${keys.length === 0 ? "no key" : keys.map((k) => `\`${k}\``).join(", ")} on that glyph. Remove the declaration in the same commit that removed the collision — a declaration nobody re-reads is how the next real collision gets waved through.`,
    );
  }
  return failures;
}

function run(): void {
  let source = "";
  try {
    source = readFileSync(TABLE_FILE, "utf8");
  } catch {
    source = "";
  }

  const failures = evaluate(source);
  if (failures.length > 0) {
    console.error(`\n✗ Mobile icon vocabulary — ${failures.length} violation(s):\n`);
    for (const f of failures) console.error(`  · ${f}\n`);
    process.exit(1);
  }

  const scanned = parseTable(source).length;
  console.log(`✓ Mobile icon vocabulary clean — ${scanned} entries scanned in ${TABLE_FILE}.`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-mobile-icon-vocabulary.ts") ||
    process.argv[1].endsWith("check-mobile-icon-vocabulary.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) run();
