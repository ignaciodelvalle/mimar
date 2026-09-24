// The mobile icon-vocabulary fence, fenced.
//
// A CHECK NOBODY TESTS IS THE FAILURE THIS CHECK IS ABOUT. `scripts/check-
// mobile-icon-vocabulary.ts` exists because `apps/mobile/src/ui/Icon.test.tsx`
// was green while a bare `Circle` stood for death on a national credential — a
// passing check read as evidence of something it never measured. The same trap
// applies to the fence itself: it is 200 lines of string parsing, and until
// this file existed nothing proved that any of its three rules fires on the
// defect it names, or that a parser that went blind would say so.
//
// FIXTURES, NOT THE LIVE TABLE. Every case below feeds `evaluate()` a table
// source built here, so a rule's behaviour is pinned independently of what the
// real vocabulary happens to say today. Fixture (a) is the REAL pre-4fa613500
// table, which is the only one of the four that ever shipped.

import { describe, expect, it } from "vitest";

import { evaluate, parseTable } from "@/scripts/check-mobile-icon-vocabulary";

/** The vocabulary as it stands, in the shape the parser reads. */
function tableSource(rows: string): string {
  return [
    "// header prose the parser must skip",
    "",
    "export const PET_PROFILE_ICONS = {",
    rows,
    "} as const;",
    "",
    "export type PetProfileIconName = keyof typeof PET_PROFILE_ICONS;",
  ].join("\n");
}

/** The current table's twenty rows, verbatim in their file order. */
const CURRENT_ROWS = [
  "  // Document chrome",
  '  girar: "RefreshCw",',
  "",
  "  // Situation chip",
  '  "check-circle": "CheckCircle",',
  '  perdida: "Siren",',
  '  shield: "Shield",',
  '  ver: "Eye",',
  '  ocultar: "EyeOff",',
  '  medicacion: "Pill",',
  '  embarazo: "CalendarHeart",',
  '  corazon: "Heart",',
  '  casa: "Home",',
  '  fallecimiento: "Flower2",',
  "",
  "  // Identity row",
  '  paw: "PawPrint",',
  '  check: "Check",',
  '  "map-pin": "MapPin",',
  "",
  "  // Section dividers",
  '  alert: "AlertTriangle",',
  "",
  "  // Action footer",
  '  libreta: "BookOpen",',
  '  share: "Share2",',
  '  edit: "Pencil",',
  '  "alert-triangle": "AlertTriangle",',
  '  ellipsis: "MoreHorizontal",',
].join("\n");

const current = tableSource(CURRENT_ROWS);

/**
 * (a) The table as it SHIPPED, before 4fa613500 — `embarazo: "Baby"` and
 * `fallecimiento: "Circle"`. This is the fixture that makes the file header's
 * claim about Rule A checkable instead of rhetorical.
 */
const shipped = tableSource(
  CURRENT_ROWS.replace('embarazo: "CalendarHeart"', 'embarazo: "Baby"').replace(
    'fallecimiento: "Flower2"',
    'fallecimiento: "Circle"',
  ),
);

const ruleA = (failures: string[]) => failures.filter((f) => f.startsWith("Rule A"));
const ruleB = (failures: string[]) => failures.filter((f) => f.startsWith("Rule B"));
const ruleC = (failures: string[]) => failures.filter((f) => f.startsWith("Rule C"));

describe("check-mobile-icon-vocabulary — the fence is not vacuous", () => {
  it("passes the current vocabulary (the control every other case is read against)", () => {
    // Non-vacuity in the plainest form: if this went red, every "fires on X"
    // case below could be passing for the wrong reason.
    expect(parseTable(current)).toHaveLength(20);
    expect(evaluate(current)).toEqual([]);
  });
});

describe("Rule A — the placeholder glyph that shipped", () => {
  it("(a) fires exactly once on the pre-4fa613500 table, naming fallecimiento and Circle", () => {
    const failures = evaluate(shipped);
    const placeholders = ruleA(failures);
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toContain("`fallecimiento`");
    expect(placeholders[0]).toContain("`Circle`");
    // And NOT on `Baby`, which is the honest half of the header's claim: Baby
    // is a real, meaningful glyph pointed at the wrong concept, and no
    // mechanical rule can see that. Only a human reading the pin can.
    expect(placeholders[0]).not.toContain("embarazo");
  });

  it("(a) finds no glyph collision on that same table — Rule B is a forward guard", () => {
    // The header says Rule B has never caught anything that shipped. This is
    // that sentence, checked: the one collision on the shipped table is the
    // declared `alert`/`alert-triangle` alias.
    expect(ruleB(evaluate(shipped))).toEqual([]);
  });
});

describe("Rule C — the pin names what changed", () => {
  it("(b) fires on a single glyph swap, with both sides of the diff in the message", () => {
    const swapped = tableSource(
      CURRENT_ROWS.replace('embarazo: "CalendarHeart"', 'embarazo: "Baby"'),
    );
    const pinned = ruleC(evaluate(swapped)).filter((f) => f.includes("pinned table"));
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toContain("- embarazo:CalendarHeart");
    expect(pinned[0]).toContain("+ embarazo:Baby");
    // The count did not move — twenty rows before and after — which is exactly
    // the class of change a pinned COUNT reports as clean.
    expect(parseTable(swapped)).toHaveLength(20);
  });

  it("(c) yields exactly ONE failure for a source it could not read", () => {
    // Two failures for one cause is not a stricter fence, it is a worse
    // message: the reader has to decide which of the two is the remedy.
    const failures = evaluate("");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("could not read");
  });

  it("(d) fails naming the missing row when a key becomes unparseable, not on the count", () => {
    // A key the regex cannot match (`a.b`) drops one row silently. The count
    // moves to 19 here, but the message that matters is WHICH pair vanished —
    // and a parser change that dropped a row while adding a junk one would
    // keep the count at 20 and still be caught by the pair list.
    const hostile = tableSource(CURRENT_ROWS.replace('  ver: "Eye",', '  "a.b": "Eye",'));
    const failures = evaluate(hostile);
    const named = failures.filter((f) => f.includes("- ver:Eye"));
    expect(named).toHaveLength(1);
  });
});

describe("Rule B — a declared alias may not outlive its collision", () => {
  it("fires when the declared alias no longer describes a real duplication", () => {
    // `alert-triangle` re-pointed at a glyph of its own leaves the
    // AlertTriangle declaration standing over a single key: a permission for a
    // collision nobody decided on. (It also trips the pin, which is correct —
    // the vocabulary changed.)
    const split = tableSource(
      CURRENT_ROWS.replace('"alert-triangle": "AlertTriangle"', '"alert-triangle": "Siren"'),
    );
    const stale = ruleB(evaluate(split)).filter((f) => f.includes("stale alias"));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain("`AlertTriangle`");
  });

  it("does not report a stale alias when the table did not parse at all", () => {
    // Every alias looks dead against zero entries; reporting them would bury
    // the one failure that matters (the parser went blind) under noise.
    const broken = 'export const SOMETHING_ELSE = {\n  girar: "RefreshCw",\n} as const;\n';
    const failures = evaluate(broken);
    expect(ruleB(failures)).toEqual([]);
    expect(failures.filter((f) => f.includes("parsed ZERO"))).toHaveLength(1);
  });
});
