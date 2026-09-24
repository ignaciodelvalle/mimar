// Shared comment stripper for the ratchet fences.
//
// WHY THIS EXISTS: a fence that counts occurrences in raw source counts them
// inside comments too. That is not a cosmetic bug — it makes the instrument
// react to documentation. Two ways it goes wrong, and this repo has hit both:
//
//   - Fails OPEN: a review counted `globals.css:570` — a comment reading
//     "computed font-size is below 16px" — as one of the raw font-sizes it was
//     measuring. The prose describing the defect was tallied as an instance.
//   - Fails CLOSED: writing an accurate comment that names the thing the fence
//     forbids trips the fence. An agent working on RA-2 had to reword a true
//     comment ("the hand-rolled `<button>`/`<Link>` pair") to get past
//     check-raw-buttons. A fence that penalises correct documentation teaches
//     authors to write worse comments, or to re-baseline — which loosens it
//     for real violations.
//
// Whitespace is substituted 1:1 for stripped characters and newlines are
// preserved, so byte offsets and line numbers survive stripping and any
// reported location still points at the right place in the ORIGINAL file.
//
// String and template literal contents are deliberately KEPT: a tag or token
// inside a string can be real emitted markup, so removing them would make the
// fence blind to a genuine violation.
//
// KNOWN GAP — regex literals are not tracked. `/foo\/\/bar/` contains `//`,
// which this reads as a line comment and blanks to end of line. Distinguishing
// a regex literal from division needs the preceding-token context a real lexer
// has and this does not, and a heuristic that guesses wrong would silently eat
// live code — strictly worse than the current, stated limitation. Zero
// occurrences across the globs any caller scans today (checked 2026-07-31). If
// a fence ever scans a file with regex-heavy source, verify this first.
//
// CONSOLIDATED: check-copy-contract.ts, check-scope-discipline.ts, and
// check-event-payload-parity.ts used to carry their own byte-identical copy
// of this state machine; all three now re-export stripComments from here —
// tsx resolves .mjs from .ts without ceremony.
//
// 2026-08-05 — the last two holdouts joined them: check-router-refresh.ts and
// check-confused-deputy.ts. Both had DIVERGED rather than merely duplicated,
// and both diverged in the same direction — toward deleting real code:
//   - check-router-refresh.ts scanned line by line and cut at the first `//`
//     WHEREVER it appeared, string literals included, so
//     `logUrl("a//b"); router.push("/x")` lost its call site.
//   - check-confused-deputy.ts used two regex replaces with a `[^:]` guard so
//     `https://…` survived; any other `//` inside a string did not.
// A stripper that removes live code makes its fence fail OPEN, which is the
// one failure mode a fence must not have. This version tracks string and
// template literals, so it is strictly the stricter of the three, and both
// files now re-export it under their own names for their existing callers.

/**
 * Replace every comment in `src` with equivalent whitespace.
 * @param {string} src
 * @returns {string}
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: character-by-character string/template/comment state machine — the same ignore the four TypeScript copies carry.
export function stripComments(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j - 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(j + 2, src.length);
      out += src
        .slice(i, j)
        .split("")
        .map((c) => (c === "\n" ? "\n" : " "))
        .join("");
      i = j - 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\") j++;
        j++;
      }
      j = Math.min(j + 1, src.length);
      out += src.slice(i, j);
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return out;
}
