// GRAMMAR-OF-CONFIRMATION GUARD — no confirm-style button may ever read
// exactly "Confirmar" again.
//
// PO decision D.3 (2026-07-30): the button carries the VERB OF THE ACT
// ("Revocar", "Aceptar custodia", "Resolver disputa"), never "Confirmar". A
// button labelled "Confirmar" names the user's CLICK instead of the OUTCOME,
// so the person committing an irreversible act has to reconstruct from memory
// what they are committing to. Friction scales with consequence — a modal
// stating the consequence for irreversible/legally weighty acts, inline for
// reversible ones — but the wording rule holds in both.
//
// The type system already fences the two components that own a confirm button:
// `ConfirmDialog.confirmLabel` and `CaptureConfidenceCard.confirmLabel` have no
// default, so omitting them is a compile error. That stops the label appearing
// by OMISSION. This test stops it appearing by COMMISSION — someone typing the
// literal back in.
//
// SCOPE — deliberately narrow, to stay false-positive free:
//   * only the EXACT string "Confirmar". "Confirmar reserva", "Confirmar
//     mordedura" and the other multi-step wizard CTAs are a separate,
//     unresolved copy question and are NOT this guard's business; widening
//     this to a prefix match would flag ~25 citizen wizard steps the D.3 table
//     never ruled on.
//   * only positions where the string can reach a button: a JSX text child, a
//     label-ish JSX attribute, a ternary arm, an object-literal value, or a
//     destructuring default.
//   * NOT prose, NOT step-label arrays (["Mascota", "Cuándo", "Confirmar"]),
//     NOT comments, NOT identifiers (`sinConfirmar`) — all of which legitimately
//     contain the word and are excluded by the position rules above.
//
// If this test fails, do not weaken the pattern. Rename the button to the verb
// of its act.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["app", "components", "src", "lib"];

// The literal, in each of the three quote styles the codebase uses.
const Q = `["'\`]`;
const LITERAL = `${Q}Confirmar${Q}`;

type Rule = { name: string; re: RegExp };

// Every rule is anchored to a POSITION where the value ends up rendered as a
// button's accessible name. Comments are stripped before matching (see below),
// so a rule can afford to be simple.
const RULES: Rule[] = [
  {
    // A JSX text child on its own line:  <OpButton …>\n  Confirmar\n</OpButton>
    // Also the quoted/braced spellings: {"Confirmar"} / {'Confirmar'}
    name: "JSX text child",
    re: new RegExp(`^[ \\t]*(?:Confirmar|\\{\\s*${LITERAL}\\s*\\})[ \\t]*$`),
  },
  {
    // A label-ish JSX attribute: confirmLabel="Confirmar", aria-label="Confirmar",
    // title="Confirmar", ctaLabel={"Confirmar"} …
    name: "JSX label attribute",
    re: new RegExp(
      `\\b(?:confirmLabel|ctaLabel|cancelLabel|editLabel|label|title|aria-label|alt)\\s*=\\s*\\{?\\s*${LITERAL}`,
    ),
  },
  {
    // A ternary arm that lands straight on a button:
    //   {pending ? "Procesando…" : "Confirmar"}
    name: "ternary arm",
    re: new RegExp(`[?:]\\s*${LITERAL}\\s*[}\\)]`),
  },
  {
    // An object-literal value keyed by anything:  reject: "Confirmar",
    // (this is how per-mode label maps are written in this codebase)
    name: "object-literal value",
    re: new RegExp(`^[ \\t]*[\\w"'\\[\\]$.]+\\s*:\\s*${LITERAL}\\s*,?[ \\t]*$`),
  },
  {
    // A destructuring / parameter default:  confirmLabel = "Confirmar",
    name: "default value",
    re: new RegExp(`^[ \\t]*\\w+\\s*=\\s*${LITERAL}\\s*,?[ \\t]*$`),
  },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

// Tests are excluded: a test may legitimately assert the historical label while
// pinning that it is GONE. Production source is the surface under contract.
function isExcluded(rel: string): boolean {
  const norm = rel.split(sep).join("/");
  return norm.includes("__tests__/") || norm.endsWith(".test.ts") || norm.endsWith(".test.tsx");
}

// Strip //-comments and /* */ blocks so the header of a file that DOCUMENTS the
// banned label (ConfirmDialog.tsx and this repo's other rule comments) doesn't
// trip the scan. String contents survive: naive, but a `//` inside a string is
// vanishingly rare next to a bare "Confirmar" on the same line, and a false
// negative here still leaves the compiler fence in place.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/[^"'`]*$/, ""))
    .join("\n");
}

function scanRepo(): string[] {
  const offenders: string[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(ROOT, dir);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of walk(abs)) {
      const rel = relative(ROOT, file);
      if (isExcluded(rel)) continue;
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        for (const rule of RULES) {
          if (rule.re.test(line)) {
            offenders.push(`${rel.split(sep).join("/")}:${i + 1} [${rule.name}] ${line.trim()}`);
            return;
          }
        }
      });
    }
  }
  return offenders;
}

describe('grammar of confirmation — no button labelled exactly "Confirmar"', () => {
  it("finds zero offenders across app/, components/, src/ and lib/", () => {
    expect(scanRepo()).toEqual([]);
  });

  it("the rules actually fire (self-test — a guard that matches nothing is not a guard)", () => {
    // Each fixture is a line the guard MUST reject. Without this, a typo in one
    // of the regexes above would make the scan silently vacuous and the first
    // test would pass forever.
    // Asserting only THAT a rule fires, not WHICH: the positions overlap by
    // design (a destructuring default and a JSX attribute are both `name =
    // "Confirmar"` to a line-based regex), and pinning the winner would make
    // the self-test fail on a harmless reordering rather than on a real hole.
    const mustFail = [
      "          Confirmar",
      '          {"Confirmar"}',
      '        confirmLabel="Confirmar"',
      '        aria-label="Confirmar"',
      '        {pending ? "Procesando…" : "Confirmar"}',
      '    reject: "Confirmar",',
      '  confirmLabel = "Confirmar",',
    ];
    for (const line of mustFail) {
      const hit = RULES.find((r) => r.re.test(line));
      expect(hit?.name, `expected ${JSON.stringify(line)} to trip a rule`).toBeDefined();
    }

    // And these must NOT fire — the false-positive surface the scope note
    // above promises to leave alone.
    const mustPass = [
      'const STEP_LABELS = ["Mascota", "Cuándo", "Víctima y contexto", "Confirmar"];',
      '  "Confirmar",',
      "  sinConfirmar: summary.unconfirmed,",
      '        confirmLabel="Confirmar corrección"',
      '  const title = mode === "pass" ? "Pasar a triage" : "Confirmar como spam";',
      "      <p>Vas a Confirmar el turno con el veterinario.</p>",
    ];
    for (const line of mustPass) {
      const hit = RULES.find((r) => r.re.test(line));
      expect(hit?.name, `expected ${JSON.stringify(line)} NOT to trip a rule`).toBeUndefined();
    }
  });
});
