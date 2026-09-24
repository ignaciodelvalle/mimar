// A `default:` arm may not print the value it did not recognise — a fence,
// because the typechecker actively hides this one.
//
// CRITIC GAP 3 / CANON-451 (mobile audit 2026-09-07). Four `switch`es over
// contract enums in this app's view models ended in a `default:` arm that
// assigned the subject to `never` — the exhaustiveness check, correct and
// worth keeping — and then RETURNED that same value as a string:
//
//     const unknown: never = kind;
//     return String(unknown);                      // libreta upcoming kind
//     return `Estado desconocido (${String(unknown)})`;   // vaccination status
//     return `Aviso sin descripción (${String(unknown)})`; // owner-face alert
//     return String(unknown);                      // viewer role
//
// Every one of those compiles, and every one of them is unreachable in the
// build it was written in — which is exactly why review never catches it. It
// becomes reachable the day the server is newer than the bundle, and an OTA
// channel makes that ordinary: `docs/mobile/ota-policy.md` requires the SERVER
// to stay compatible with the oldest install still opening, not the reverse, so
// a published bundle meets new enum members by design rather than by accident.
// What a citizen then reads is `medication`, `org_member`, `open-cases` — an
// internal identifier, in English, in a wallet whose whole UI is es-AR.
//
// THE RULE. Inside ANY `default:` arm of a `switch`, in any non-test source
// file under `src/`, no interpolation and no `String(...)` may appear.
// `unknownEnumLabel` (see `ui/enum-label.ts`) is the shape that keeps the
// compile-time guarantee and still hands a person a real word.
//
// A FENCE AND NOT FOUR ASSERTIONS: the bug is that the shape is writable, not
// that four call sites are currently wrong, and the fifth view model written
// next month gets caught by the same test.
//
// WHY THE RULE IS THAT BROAD, AND WAS NOT (finding M1, review 2026-09-07)
// ---------------------------------------------------------------------------
// The first draft of this file enumerated: it looked only at `*-view-model.ts`,
// and only at arms it RECOGNISED as exhaustiveness checks — an arm carrying
// `: never` or a call to `unknownEnumLabel`. Both halves are this repo's own
// standing failure, "a fence that enumerates the spellings misses one", written
// twice in one file:
//
//   · The spelling gate could not see `default: return String(kind);` — which
//     is the SAME leak AND has additionally thrown away the compile-time
//     exhaustiveness check, so it is strictly worse than the four arms this
//     fence was written for.
//   · The `-view-model.ts` scope could not see two live offenders on the day it
//     was written: `credential/CredentialScreen.tsx` interpolated an unknown
//     `LostState` into a `throw` — a NEW lost state from a newer server did not
//     print an identifier, it CRASHED the credential screen, in exactly the
//     OTA-skew scenario this file's header is about — and `pets/species.ts`
//     handed a citizen the server's raw `chinchilla`.
//
// So the subject is banned instead of its spellings. Measured on 2026-09-07 the
// widened scope reads 105 files, 40 `default:` arms across 36 of them, and finds
// exactly ONE offender — the CredentialScreen throw, fixed in the same batch. A
// `default:` arm that interpolates ANYTHING it did not recognise is guessing at
// what is safe to print, whether or not the compiler was told about it; there is
// no exceptions list here on purpose, because an arm that genuinely needs an
// interpolation can compute it outside the arm.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@jest/globals";

const SRC_ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".expo", "dist", "android", "ios"]);
/**
 * EVERY source file under `src/`, screens included. The old scope was
 * `-view-model.ts$` on the theory that "a screen may legitimately interpolate;
 * a label may not" — and the screens were where two of the offenders were. See
 * the header.
 */
const SUBJECT = /\.tsx?$/;
/** A test may write the offending shape on purpose; the synthetic below does. */
const IS_TEST = /\.test\.tsx?$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name)));
    } else if (SUBJECT.test(entry.name) && !IS_TEST.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * The text of every `default:` arm, by brace depth.
 *
 * A regex over the whole file cannot do this: the arm may or may not be
 * braced, it may hold a nested object literal, and the next `case` is what ends
 * an unbraced one. This walks from the `default:` token to whichever comes
 * first — the `}` that closes the switch, the `}` that closes an own block, or
 * the next `case`/`default` at the same depth.
 */
function defaultArms(source: string): string[] {
  const arms: string[] = [];
  const token = /\bdefault\s*:/g;
  let match = token.exec(source);
  while (match !== null) {
    let index = match.index + match[0].length;
    let depth = 0;
    const start = index;
    while (index < source.length) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        if (depth === 0) break;
        depth -= 1;
        // A braced arm ends at its own closing brace.
        if (depth === 0) {
          index += 1;
          break;
        }
      } else if (depth === 0 && source.startsWith("case ", index)) break;
      index += 1;
    }
    arms.push(source.slice(start, index));
    token.lastIndex = index;
    match = token.exec(source);
  }
  return arms;
}

/**
 * Whether an arm prints something it did not recognise.
 *
 * `String(` and `${` are the two ways the raw value reached a screen. Both are
 * banned outright rather than matched against the switch subject's identifier:
 * an arm that interpolates ANYTHING it did not recognise is guessing at what is
 * safe to print. There is no "is this an exhaustiveness arm?" question any more
 * — see the header for why asking it was the bug.
 */
function printsTheUnknown(arm: string): boolean {
  return arm.includes("String(") || arm.includes("${");
}

const FILES = walk(SRC_ROOT);

type Offence = { file: string; arm: string };

const OFFENCES: Offence[] = [];
const ARMS_SEEN: string[] = [];

for (const file of FILES) {
  const source = readFileSync(file, "utf8");
  for (const arm of defaultArms(source)) {
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
    ARMS_SEEN.push(relative);
    if (printsTheUnknown(arm)) {
      OFFENCES.push({ file: relative, arm: arm.trim().slice(0, 120) });
    }
  }
}

describe("a default: arm may not print the value it did not recognise", () => {
  it("finds nothing under src/ interpolating a value its switch did not recognise", () => {
    expect(OFFENCES.map((offence) => `${offence.file} → ${offence.arm}`)).toEqual([]);
  });

  // NON-VACUITY. A walk that stops finding files, or a parser that stops
  // finding arms, would report an empty offender list and read as a pass — the
  // failure mode every fence in this repo is required to close.
  it("actually walks the app and finds the arms it judges", () => {
    // Measured at 2026-09-07 on the widened scope: 105 non-test source files,
    // 40 `default:` arms, across 36 distinct files. The floors sit just under
    // the census so ordinary churn does not trip them and a COLLAPSE — a walk
    // that stopped recursing, a parser that stopped matching — does.
    expect(FILES.length).toBeGreaterThanOrEqual(90);
    expect(ARMS_SEEN.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ARMS_SEEN).size).toBeGreaterThanOrEqual(25);
  });

  it("reaches SCREENS and not only view models, which is where two offenders were", () => {
    // The scope half of finding M1, asserted rather than described: the old
    // `-view-model.ts$` walk could not see `CredentialScreen.tsx`, and a
    // "simplification" back to the mapping layer would silently re-open it.
    expect(FILES.some((file) => file.endsWith(".tsx"))).toBe(true);
    expect(ARMS_SEEN.some((file) => file.endsWith(".tsx"))).toBe(true);
  });

  it("recognises the offending shape when it is present — including the one with no `never`", () => {
    // The rule is exercised against both shapes, so a refactor that quietly
    // stops matching `default:` arms fails here rather than passing silently.
    const before = `
      switch (kind) {
        case "reminder":
          return "Recordatorio";
        default: {
          const unknown: never = kind;
          return String(unknown);
        }
      }`;
    const arms = defaultArms(before);
    expect(arms).toHaveLength(1);
    expect(printsTheUnknown(arms[0] ?? "")).toBe(true);

    // THE SHAPE THE OLD SPELLING GATE COULD NOT SEE, and the reason the gate is
    // gone: no `: never`, no `unknownEnumLabel(` — so the old predicate skipped
    // the arm entirely — and it has ALSO thrown away the compile-time
    // exhaustiveness check, which makes it strictly worse than the four arms
    // this fence was written for.
    const unannotated = `
      switch (kind) {
        case "reminder":
          return "Recordatorio";
        default:
          return String(kind);
      }`;
    const bare = defaultArms(unannotated);
    expect(bare).toHaveLength(1);
    expect(printsTheUnknown(bare[0] ?? "")).toBe(true);

    // And a THROW that interpolates, which is how `CredentialScreen.tsx` turned
    // an unknown enum member into a crash instead of a word.
    const thrown = `
      switch (lost.state) {
        case "lost":
          return null;
        default: {
          const unhandled: never = lost;
          throw new Error(\`Unhandled lost state: \${JSON.stringify(unhandled)}\`);
        }
      }`;
    expect(printsTheUnknown(defaultArms(thrown)[0] ?? "")).toBe(true);

    const after = `
      switch (kind) {
        case "reminder":
          return "Recordatorio";
        default:
          return unknownEnumLabel(kind, "Registro");
      }`;
    const fixed = defaultArms(after);
    expect(fixed).toHaveLength(1);
    expect(printsTheUnknown(fixed[0] ?? "")).toBe(false);
  });
});
