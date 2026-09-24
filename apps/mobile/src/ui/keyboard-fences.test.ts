// The keyboard a field opens — a fence, because the defect was invisible on
// the machine that wrote it.
//
// forms-F1 (mobile QoL audit 2026-09-05). SEVEN numeric fields across three
// files declared `keyboardType="numbers-and-punctuation"` — four in
// `pets/RecordEventScreen.tsx`, two in `caretakers/CaretakerPetScreen.tsx`,
// one in `lost/LostScreen.tsx`. That value exists on iOS ONLY: React Native's
// Android implementation does not map it, so every one of those fields opened
// the full QWERTY keyboard — a person entering a microchip number, a chip's
// country code or a date had to find the digits themselves. On the simulator
// it looked right, which is exactly why a review could not see it.
//
// THE REMEDY IS `inputMode`, not a different `keyboardType`. `inputMode` is the
// cross-platform prop; RN maps it to a real keyboard on both.
//
// AN ALLOWLIST AND NOT A BAN, and the difference is the whole point of this
// rewrite. The first version of this fence banned the ONE spelling the audit
// happened to find, under a header that claimed to hold the CLASS. React
// Native's own types say the class is bigger: `KeyboardTypeIOS` has FIVE
// members (`ascii-capable`, `numbers-and-punctuation`, `name-phone-pad`,
// `twitter`, `web-search`) and `KeyboardTypeAndroid` has one
// (`visible-password`) — so six spellings had the same defect and one was
// fenced. A ban also cannot be right for long: the day RN adds a seventh
// platform-only value, a denylist is silently out of date and still green.
// The allowlist below is `KeyboardType` — the cross-platform union, verbatim
// from `react-native/Libraries/Components/TextInput/TextInput.d.ts` — and it
// cannot be outgrown, because a value RN adds tomorrow is not in it.
//
// A FENCE AND NOT SEVEN RENDER ASSERTIONS: the bug is the availability of the
// spelling, not the state of seven call sites, and an eighth field written
// tomorrow gets caught by the same test.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@jest/globals";

const MOBILE_ROOT = path.resolve(__dirname, "..", "..");
/** Both source roots. `app/` is expo-router's screens and is real UI too. */
const WALKED = ["src", "app"];
const SKIP_DIRS = new Set(["node_modules", ".expo", "dist", "android", "ios"]);
const EXTENSIONS = [".ts", ".tsx"];

/**
 * `KeyboardType` — the values React Native maps on BOTH platforms.
 *
 * Copied from the installed `react-native`'s TextInput typings, where the union
 * is split three ways on purpose: `KeyboardType` (this list),
 * `KeyboardTypeIOS`, and `KeyboardTypeAndroid`. `KeyboardTypeOptions`, which is
 * what the `keyboardType` prop actually accepts, is all three together — so the
 * type system will not stop any of them, and this list is the only thing that
 * does.
 */
const CROSS_PLATFORM: ReadonlySet<string> = new Set([
  "default",
  "number-pad",
  "decimal-pad",
  "numeric",
  "email-address",
  "phone-pad",
  "url",
]);

const PROP = "keyboardType=";

/**
 * COMMENTS ARE NOT CODE, and this fence would otherwise fail on the notes that
 * explain it — `date-input.ts` and three call sites name the banned value in
 * prose precisely so the next reader knows why `inputMode` is there. Stripping
 * comments first is what lets the rule be documented at all.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The quoted string literals in a fragment of source. */
function literals(fragment: string): string[] {
  return [...fragment.matchAll(/(["'])([^"']*)\1/g)].map((m) => m[2] ?? "");
}

/** The index of the `}` that closes the `{` at `openAt`, or the end of input. */
function matchingBrace(content: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < content.length; i += 1) {
    if (content[i] === "{") depth += 1;
    else if (content[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return content.length;
}

/**
 * The values a JSX expression can hand to `keyboardType`.
 *
 * A LITERAL BEING COMPARED IS A DISCRIMINANT, NOT A KEYBOARD. `kind ===
 * "microchip"` names a field kind; it is stripped before the values are
 * collected, or the fence would accuse a call site that chooses correctly
 * between two allowed keyboards.
 */
function expressionValues(expression: string): string[] {
  return literals(
    expression.replace(/[!=]==?\s*(["'])[^"']*\1/g, "").replace(/(["'])[^"']*\1\s*[!=]==?/g, ""),
  );
}

/**
 * Every value a `keyboardType=` assignment in `content` can produce.
 *
 * Two shapes exist in this codebase and both are parsed rather than skipped: a
 * bare literal (`keyboardType="phone-pad"`) and a JSX expression
 * (`keyboardType={kind === "microchip" ? "number-pad" : "default"}`). A shape
 * that is neither is reported as `null`, which the rule treats as an offender:
 * a value this fence cannot read is a value it is not fencing, and saying so is
 * the honest answer.
 */
function keyboardTypeValues(content: string): (string[] | null)[] {
  const found: (string[] | null)[] = [];
  let at = content.indexOf(PROP);
  while (at !== -1) {
    const start = at + PROP.length;
    const head = content[start];
    if (head === '"' || head === "'") {
      const end = content.indexOf(head, start + 1);
      found.push(end === -1 ? null : [content.slice(start + 1, end)]);
    } else if (head === "{") {
      found.push(expressionValues(content.slice(start + 1, matchingBrace(content, start))));
    } else {
      found.push(null);
    }
    at = content.indexOf(PROP, start);
  }
  return found;
}

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(path.join(MOBILE_ROOT, root));
  return found;
}

describe("a field may only ask for a keyboard BOTH platforms have", () => {
  // This file names every value in prose and would be its own worst offender.
  const files = WALKED.flatMap(sourceFiles).filter(
    (file) => !file.endsWith("keyboard-fences.test.ts"),
  );
  const assignments = files.flatMap((file) =>
    keyboardTypeValues(withoutComments(readFileSync(file, "utf8"))).map((values) => ({
      rel: path.relative(MOBILE_ROOT, file),
      values,
    })),
  );

  it("walks a real corpus — the fence must not pass by finding nothing", () => {
    // Non-vacuity: a broken walk (a renamed root, a bad extension list) would
    // otherwise report a clean sweep of zero files.
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((f) => f.includes(`${path.sep}app${path.sep}`))).toBe(true);
  });

  it("NON-VACUITY: the parser actually finds the assignments it judges", () => {
    // Eight `keyboardType=` sites survived forms-F1 (two in DenunciaScreen, one
    // in ClaimScreen, two in PetProfileEditScreen, three in EditProfileScreen)
    // and all eight are legal. A parser regression — a changed prop spelling, a
    // brace walk that runs off the end — would find none of them and the rule
    // below would sweep an empty list clean forever. That is the exact silent
    // pass this fence was rewritten to make impossible.
    expect(assignments.length).toBeGreaterThanOrEqual(8);
  });

  it("never asks for a keyboard only one platform has", () => {
    // The offender strings carry the remedy, because jest's `expect` takes no
    // custom message: what a red run prints is this array, so it has to read
    // like a finding on its own.
    const remedy = `not one of ${[...CROSS_PLATFORM].join(", ")} — use inputMode`;
    const offenders = assignments
      .filter(({ values }) => values === null || values.some((value) => !CROSS_PLATFORM.has(value)))
      .map(
        ({ rel, values }) =>
          `${rel}: ${values === null ? "(unreadable value)" : values.join(", ")} — ${remedy}`,
      );
    expect(offenders).toEqual([]);
  });
});
