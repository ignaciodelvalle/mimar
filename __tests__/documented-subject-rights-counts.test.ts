// Every PROSE statement of a subject-rights count, checked against the list it
// describes.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// The same number has gone stale three times in this one topic, and the third
// time the document contradicted itself: on 2026-08-29 AGENTS.md §6b said the
// RPCs reach "dieciocho" and that KNOWN_GAP holds "21 tablas", forty-six lines
// above a §7 that already said 17 — while the live lint printed 22 and 17. The
// coverage fence's own header said "eighteen" and "twelve" in the same breath.
// None of it was reachable by any test: the CI line is computed from the lists,
// the prose beside it was not, and a reader has no way to tell which half is
// current.
//
// So the counts stop being transcriptions. Each one below is DERIVED from the
// four exported lists and compared against the sentence that states it. Add a
// table to KNOWN_GAP and this file goes red until the prose agrees.
//
// WHAT IT CANNOT DO, SAID PLAINLY
// ---------------------------------------------------------------------------
//   · It anchors on SENTENCES. A rewrite that drops an anchor fails loudly
//     (that is the `expect(match).not.toBeNull()` under each one) rather than
//     passing vacuously — but a rewrite that MOVES a claim into wording this
//     file does not know about is invisible to it. The mitigation is the rule
//     the docs now state: §7's table cell is the ONE place in AGENTS.md that
//     writes the KNOWN_GAP count, and §6b writes none.
//   · It reads number WORDS in the script header (`twenty-two`) and NUMERALS in
//     AGENTS.md (`17`), because that is what each document actually writes. A
//     Spanish word form in AGENTS.md would slip past the numeral scan, so the
//     word forms are mapped too — see SPANISH_NUMERALS.
//   · It says nothing about whether the lists themselves are right. That is
//     `pnpm lint:subject-rights` against the live catalogue, and
//     __tests__/check-subject-rights-coverage.test.ts for the fence's own logic.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IN_ERASE, IN_EXPORT, KNOWN_GAP } from "@/scripts/check-subject-rights-coverage";

const REPO_ROOT = join(__dirname, "..");
const FENCE_PATH = "scripts/check-subject-rights-coverage.ts";
const AGENTS_PATH = "AGENTS.md";

/**
 * Every prose document that has ever put a number on the debt register.
 *
 * AGENTS.md §7 is the one allowed to state it. The work board (open-work.md)
 * used to be scanned too — it carried a FOURTH copy that had been wrong since
 * 0207 — but it moved to the private companion repo (dim-interno) on
 * 2026-09-18, so this public repo can no longer read it. Only the documents
 * that ship in this tree are fenced here.
 */
const PROSE_PATHS = [AGENTS_PATH] as const;

/** Tables reached by at least one of the two RPCs — the union, never a sum. */
const REACHED = new Set([...IN_EXPORT, ...IN_ERASE]).size;
const GAP = Object.keys(KNOWN_GAP).length;

/**
 * The fence's header, flowed into one line of prose.
 *
 * Comment markers and line wrapping are stripped on purpose: an anchor that
 * breaks when somebody re-wraps a paragraph is an anchor that gets deleted
 * rather than maintained.
 */
function flowedHeader(source: string): string {
  const header = source.split(/^import /m)[0];
  return header
    .split("\n")
    .map((l) => l.replace(/^\/\/ ?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const NUMBER_WORDS: Record<string, number> = {
  six: 6,
  twelve: 12,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  "twenty-one": 21,
  "twenty-two": 22,
  "twenty-three": 23,
  "twenty-four": 24,
  "twenty-five": 25,
};

/** The forms AGENTS.md could plausibly use for this count, beyond a numeral. */
const SPANISH_NUMERALS: Record<string, number> = {
  dieciseis: 16,
  dieciséis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintiuna: 21,
  veintidos: 22,
  veintidós: 22,
};

function wordToNumber(word: string): number {
  const key = word.toLowerCase();
  const n = NUMBER_WORDS[key];
  expect(
    n,
    `"${word}" is not a number word this fence knows. Add it to NUMBER_WORDS in the same commit that introduces it, so the count stays checkable.`,
  ).toBeDefined();
  return n as number;
}

/** Pull the one capture of `re` out of `text`, failing loudly when absent. */
function capture(text: string, re: RegExp, anchor: string): string {
  const m = text.match(re);
  expect(
    m,
    `The anchor sentence "${anchor}" is gone. It carried a number this fence derives, so its disappearance means either the claim moved (re-anchor this test in the same commit) or it was deleted (delete the assertion). It does not mean the claim is still true.`,
  ).not.toBeNull();
  return (m as RegExpMatchArray)[1];
}

const fenceSource = readFileSync(join(REPO_ROOT, FENCE_PATH), "utf8");
const fenceHeader = flowedHeader(fenceSource);
const agentsDoc = readFileSync(join(REPO_ROOT, AGENTS_PATH), "utf8");

describe(`${FENCE_PATH} — the header's numbers are the lists' numbers`, () => {
  it("states how many tables the two RPCs actually reach", () => {
    const word = capture(
      fenceHeader,
      /while the RPCs already reach ([a-z-]+)\./,
      "while the RPCs already reach <n>.",
    );
    expect(
      wordToNumber(word),
      `The header says the RPCs reach "${word}"; the union of IN_EXPORT and IN_ERASE is ${REACHED}. This exact sentence read "eighteen" for three migrations.`,
    ).toBe(REACHED);
  });

  it("states how many covered tables deriving from the baseline would discard", () => {
    // The claim is arithmetic over two things the file itself carries: the six
    // baseline tables, listed by name in the same sentence, and the reach above.
    // Both halves are derived here so the subtraction cannot go stale on its own
    // — which is exactly how "twelve" survived: it was consistent with the
    // "eighteen" beside it, and both were three migrations old.
    const baselineList = capture(
      fenceHeader,
      /Only SIX tables are under the baseline \(([^)]*)\)/,
      "Only SIX tables are under the baseline (…)",
    );
    const baselineTables = baselineList
      .split(/,|—/)
      .map((s) => s.trim())
      .filter((s) => /^[a-z_]+$/.test(s));
    expect(
      baselineTables.length,
      `The sentence says SIX baseline tables and names ${baselineTables.length}: ${baselineTables.join(", ")}.`,
    ).toBe(6);

    const word = capture(
      fenceHeader,
      /would declare ([a-z-]+) covered tables out of scope/,
      "would declare <n> covered tables out of scope",
    );
    expect(
      wordToNumber(word),
      `The header says deriving from the baseline would discard "${word}" covered tables; ${REACHED} reached minus ${baselineTables.length} under the baseline is ${REACHED - baselineTables.length}.`,
    ).toBe(REACHED - baselineTables.length);
  });

  it("states the size of the debt register, in both sentences that state it", () => {
    const inRationale = capture(
      fenceHeader,
      /there are ([a-z-]+) tables here that hold real subject data/,
      "there are <n> tables here that hold real subject data",
    );
    expect(wordToNumber(inRationale)).toBe(GAP);

    const inConsequence = capture(
      fenceHeader,
      /would be ([a-z-]+) false statements/,
      "would be <n> false statements",
    );
    expect(
      wordToNumber(inConsequence),
      "The two halves of the KNOWN_GAP rationale must state the same count — one of them going stale is how the paragraph starts arguing with itself.",
    ).toBe(GAP);

    const inDriftNote = capture(
      fenceHeader,
      /so it is ([a-z-]+)\./,
      "…organization_invitations, so it is <n>.",
    );
    expect(wordToNumber(inDriftNote)).toBe(GAP);
  });
});

describe("the docs — AGENTS.md §7 is the only place that writes the KNOWN_GAP count", () => {
  it("§7's cell states the live count", () => {
    const numeral = capture(
      agentsDoc,
      /(\d+) tablas siguen en `KNOWN_GAP`/,
      "<n> tablas siguen en `KNOWN_GAP`",
    );
    expect(
      Number(numeral),
      `AGENTS.md §7 says ${numeral} tables remain in KNOWN_GAP; the register holds ${GAP}.`,
    ).toBe(GAP);
  });

  it.each(PROSE_PATHS)("%s states no OTHER count that contradicts it", (path) => {
    // §6b carried its own copy and it was four migrations stale; the board
    // carried a third. Rather than trusting the next writer to remember which
    // section owns the number, every quantity written next to KNOWN_GAP in
    // either document is collected and must agree.
    const doc = readFileSync(join(REPO_ROOT, path), "utf8");
    const wrong: string[] = [];
    // Two details here are load-bearing, and both were found by MUTATING this
    // file's inputs rather than by reading the regex:
    //
    //   · The hyphen in the character class. Without it `twenty-one tables`
    //     captures only "one", which is in no lookup table, so the statement was
    //     skipped as "not a count" and passed green. The board writes English
    //     compound numbers, so that was the exact form that would arrive.
    //   · `\**` on both sides of the whitespace. These are Markdown documents
    //     and a number worth stating is a number somebody bolds; `**21** tables`
    //     put an asterisk pair between the digits and the noun and slipped
    //     straight through the earlier version.
    const re = /([\d]+|[a-záéíóú-]+)\**\s+\**(?:tablas?|tables?)\b[^.|\n]{0,60}?KNOWN_GAP/gi;
    for (const m of doc.matchAll(re)) {
      const token = m[1].toLowerCase();
      const value = /^\d+$/.test(token)
        ? Number(token)
        : (SPANISH_NUMERALS[token] ?? NUMBER_WORDS[token]);
      if (value === undefined) continue; // "las tablas", "these tables" — not a count.
      if (value !== GAP) wrong.push(`"${m[0].trim()}"`);
    }
    expect(
      wrong,
      `These statements in ${path} put a number on KNOWN_GAP that is not ${GAP}: ${wrong.join(
        " | ",
      )}. AGENTS.md §7's table cell is the one place that carries this count — every other mention should point at it, not restate it.`,
    ).toEqual([]);
  });
});
