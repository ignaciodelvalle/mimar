// Every screen must render a failure through `apiFailureMessage` — a fence,
// because the defect A6-cuenta-resiliencia-14 named was a SHAPE, not a value.
//
// WHAT WENT WRONG. 25 screens each hand-rolled their own `failureMessage`
// switch over `ApiResult["outcome"]`, calling `apiErrorMessage` from
// `../api/error-copy` directly for the `"api-error"` arm. `client.ts`'s own
// doc comment on `apiFailureMessage` names the consequence: those switches do
// not print the correlation code (OBS-3) and do not honour a `Retry-After`
// countdown on `rate_limited` — a person reading "no pudimos conectarnos" had
// no way to tell support which attempt failed, and somebody rate-limited saw
// "esperá un momento" instead of a number.
//
// THE FIX WAS A MIGRATION, NOT A RULE. All 25 screens now call
// `apiFailureMessage(result) ?? "<fallback>"`, and the local switches were
// deleted. This fence is what stops the 26th screen (or a reverted 3rd) from
// bringing the shape back — a green screen test cannot catch a hand-rolled
// switch that happens to read the same codes correctly today; only a source
// scan of every `*Screen.tsx` can.
//
// TWO SIGNATURES, EITHER ONE IS AN OFFENDER. A screen imports `apiErrorMessage`
// straight from `../api/error-copy` (the one legitimate caller is
// `client.ts` itself), OR a screen contains a `switch` arm literally matching
// `case "unsupported-version"` — the fingerprint of the outcome switch,
// reachable even by a screen that inlines its own copy instead of calling
// `apiErrorMessage`. `TransferInitiateScreen.tsx` is not an offender under
// either check: it keeps ONE domain-specific override
// (`transferInitiateRefusalMessage`, for `transfer_forbidden` only) that
// falls through to `apiFailureMessage` for every other code — see its own
// comment.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@jest/globals";

const MOBILE_ROOT = path.resolve(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".expo", "dist", "android", "ios"]);

/**
 * COMMENTS ARE NOT CODE. This file itself names both banned patterns in
 * prose, so a naive scan of raw source would flag its own comments as
 * offenders.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function screenFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (entry.name.endsWith("Screen.tsx")) found.push(path.join(dir, entry.name));
    }
  };
  walk(path.join(MOBILE_ROOT, root));
  return found;
}

const IMPORTS_APIERRORMESSAGE =
  /import\s*\{[^}]*\bapiErrorMessage\b[^}]*\}\s*from\s*["']\.\.\/api\/error-copy["']/;
const REIMPLEMENTS_OUTCOME_SWITCH = /case\s*["']unsupported-version["']/;

describe("screens render failures through apiFailureMessage — no local switch", () => {
  const files = screenFiles("src").map((file) => ({
    rel: path.relative(MOBILE_ROOT, file).replace(/\\/g, "/"),
    src: withoutComments(readFileSync(file, "utf8")),
  }));

  it("walks a real corpus — the fence must not pass by finding nothing", () => {
    // Non-vacuity: 33 `*Screen.tsx` files exist today (25 migrated in this
    // change, 8 already correct). A broken walk would report a clean sweep of
    // zero files instead.
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(files.some((f) => f.rel === "src/claims/ClaimScreen.tsx")).toBe(true);
  });

  it("NON-VACUITY: the offender patterns themselves still match real source", () => {
    // A parser regression (a changed import path, a renamed outcome literal)
    // would otherwise make both checks below vacuously pass forever.
    expect(
      IMPORTS_APIERRORMESSAGE.test('import { apiErrorMessage } from "../api/error-copy";'),
    ).toBe(true);
    expect(REIMPLEMENTS_OUTCOME_SWITCH.test('case "unsupported-version":')).toBe(true);
  });

  it("no screen imports apiErrorMessage or reimplements the outcome switch", () => {
    const offenders = files
      .filter(
        ({ src }) => IMPORTS_APIERRORMESSAGE.test(src) || REIMPLEMENTS_OUTCOME_SWITCH.test(src),
      )
      .map(({ rel, src }) => {
        const reasons: string[] = [];
        if (IMPORTS_APIERRORMESSAGE.test(src)) {
          reasons.push("imports apiErrorMessage from ../api/error-copy directly");
        }
        if (REIMPLEMENTS_OUTCOME_SWITCH.test(src)) {
          reasons.push('reimplements a switch over ApiResult["outcome"]');
        }
        return `${rel}: ${reasons.join(" and ")} — use apiFailureMessage(result) from ../api/client instead`;
      });
    expect(offenders).toEqual([]);
  });
});
