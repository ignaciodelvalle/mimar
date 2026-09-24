// Fitness fence: a rejected welfare report must not wipe what the operator typed.
//
// THE DEFECT
// ---------------------------------------------------------------------------
// React 19 automatically resets an uncontrolled form once its action resolves —
// including when the action RETURNS AN ERROR, which is the only case that
// matters here. A welfare report is long (kind, severity, subject, symptoms,
// date, contact), and bouncing on "the description is too short" wiped every
// uncontrolled field. The operator fixed one field and lost five.
//
// WelfareReportForm now captures the submitted FormData in `submittedRef` at
// submit time and seeds each field's `defaultValue` from it via `kept(name)`,
// so the reset lands on what was typed. The login form solved the same trap the
// same way — its comment is the reference — by echoing the value back from the
// server; this form captures client-side instead, because
// src/modules/welfare/actions.ts sits at its file-size ratchet.
//
// WHY THIS IS A SOURCE TEST AND NOT A RENDER TEST
// ---------------------------------------------------------------------------
// The behaviour under test is React 19's automatic form reset, which is
// activation behaviour in a real browser. jsdom does not reproduce it, so a
// render test asserting "the field still holds the text" would pass whether or
// not the fix works — a green light parked over the exact bug. That is worse
// than no test.
//
// So this asserts the MECHANISM, which is what a regression actually removes:
// every field a person types into, that React does not control, seeds its
// defaultValue from the capture. A ninth field added without `kept(...)` fails
// here. Whether the browser then restores it is the e2e gate's job, not jsdom's.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const FORM = "app/(public)/denuncias/nueva/WelfareReportForm.tsx";

/**
 * Fields exempt from the rule, with the reason each is provably safe.
 * Empty-by-default is the goal; every entry has to earn its place.
 */
const EXEMPT: Record<string, string> = {
  // Regenerated per mount by useIdempotencyKey and rendered with `value=` — it
  // is React-controlled, and a stale key surviving a bounce would be wrong
  // anyway: the retry needs the same key, which the hook already guarantees.
  clientIdempotencyKey: "controlled by useIdempotencyKey, not user input",
};

/** Every `<LnInput|LnTextarea|LnSelect …>` element, as raw JSX text. */
function fieldElements(src: string): string[] {
  const out: string[] = [];
  const re = /<Ln(?:Input|Textarea|Select)\b/g;
  for (const m of src.matchAll(re)) {
    // Walk to the end of the opening tag, tracking brace depth so a `>` inside
    // a JSX expression (a ternary in a placeholder, say) does not end it early.
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

function nameOf(element: string): string | null {
  return /\bname="([^"]+)"/.exec(element)?.[1] ?? null;
}

describe("WelfareReportForm keeps the operator's input across a rejection", () => {
  const src = readFileSync(FORM, "utf8");
  const elements = fieldElements(src);

  // NON-VACUITY. A parser that silently matches nothing would make every
  // assertion below pass. The form had 8 uncontrolled user-typed fields when
  // this was written; the floor sits under that with room for churn.
  it("actually finds the form's fields", () => {
    expect(elements.length).toBeGreaterThanOrEqual(8);
    expect(elements.map(nameOf).filter(Boolean)).toContain("severity");
  });

  it("captures the submitted values at submit time", () => {
    // The mechanism the rule below depends on. Without it the `kept()` calls
    // would all read an empty object and the fields would seed to "".
    //
    // 2026-09-22 (T4-F1): the hand-rolled `submittedRef` + `kept()` pair became
    // the shared `useKeptFields` hook, because the hand-rolled version missed
    // the two selects and the subject radios. This test follows the mechanism,
    // so it asserts the hook is wired AND that the hook itself still captures.
    expect(src).toContain('from "@/lib/ui/use-kept-fields"');
    expect(src).toMatch(/\bkept\b[\s\S]{0,80}=\s*useKeptFields\(/);
    const hook = readFileSync("lib/ui/use-kept-fields.ts", "utf8");
    expect(hook).toMatch(/submitted\w*\.current\s*=/);
    expect(hook).toContain("return { boundAction, kept, keptChecked }");
  });

  it("seeds every uncontrolled user-typed field from the capture", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const element of elements) {
      const name = nameOf(element);
      if (name === null) continue;
      if (EXEMPT[name] !== undefined) continue;
      // React-controlled: its value comes from state and survives the reset on
      // its own. `description` and the subject radios work this way.
      if (/\bvalue=\{/.test(element)) continue;

      checked++;
      if (!element.includes(`defaultValue={kept("${name}")}`)) {
        offenders.push(name);
      }
    }

    expect(
      checked,
      "no uncontrolled fields were examined — the parser broke",
    ).toBeGreaterThanOrEqual(8);
    expect(
      offenders,
      `these fields reset to empty when the server rejects the report: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // Same rule the api-guard fence uses: an exemption has to name a reason,
    // and it has to point at a field that still exists.
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${name} needs a written reason`).toBeGreaterThan(10);
      expect(src, `${name} is exempt but no longer in the form`).toContain(`name="${name}"`);
    }
  });
});
