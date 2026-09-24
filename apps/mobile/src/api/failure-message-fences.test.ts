// Every non-test file under `src/` must render a failure through
// `apiFailureMessage` — a fence, because the defect A6-cuenta-resiliencia-14
// named was a SHAPE, not a value.
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
// deleted. This fence is what stops the 26th one (or a reverted one) from
// bringing the shape back — a green render test cannot catch a hand-rolled
// switch that happens to read the same codes correctly today; only a source
// scan can.
//
// SCOPED TO SCREENS FIRST, WIDENED THE SAME DAY (fresh review, 2026-09-24). The
// first draft of this fence only walked `*Screen.tsx`, on the theory that
// `-view-model.ts` files are pure and screens are where the switch renders.
// The review caught a live counter-example in the same PR that added the fence:
// `pets/pet-photo-view-model.ts`'s `transportMessage` was the EXACT same
// four-armed switch, reachable from two call sites
// (`petPhotoFailureMessage`'s `ticket` and `confirm` stages) and printing
// straight onto `PetPhotoScreen` — the fence would have let it stand forever
// because its file name does not end in `Screen.tsx`. That one is migrated now
// (see its own comment), and the scope widened to every non-test source file
// under `src/` so the NEXT view-model with a copy of this switch cannot hide
// behind a naming convention either.
//
// `src/api/**` IS EXCLUDED, not narrowed around: `client.ts` (the switch
// `apiFailureMessage` itself is built from) and `error-copy.ts` (the switch
// `apiErrorMessage` IS) are the two legitimate, single owners of this shape —
// fencing them against themselves would be the fence failing on its own
// mechanism, the exact false-positive a scope exception exists to prevent.
//
// THREE SIGNATURES, ANY ONE IS AN OFFENDER. A file imports `apiErrorMessage`
// straight from a relative `api/error-copy` (the two legitimate callers both
// live under the excluded `src/api/**`), OR a file contains a `switch` arm
// literally matching `case "unreachable"` or `case "malformed"` — the two
// outcome literals a copy of the switch cannot avoid writing, whether or not it
// also happens to call `apiErrorMessage` for the `api-error` arm.
// `unsupported-version` is checked too, for the same reason and because it was
// the original fingerprint. `TransferInitiateScreen.tsx` is not an offender
// under any of them: it keeps ONE domain-specific override
// (`transferInitiateRefusalMessage`, for `transfer_forbidden` only) that falls
// through to `apiFailureMessage` for every other code, with no local switch
// over the transport outcomes — see its own comment.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@jest/globals";

const SRC_ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".expo", "dist", "android", "ios"]);
const SUBJECT = /\.tsx?$/;
const IS_TEST = /\.test\.tsx?$/;

/**
 * COMMENTS ARE NOT CODE. This file itself names every banned pattern in
 * prose, so a naive scan of raw source would flag its own comments — and this
 * file's own header, specifically — as an offender.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every non-test `.ts`/`.tsx` file under `src/`, excluding `src/api/**` — the
 * switch's two legitimate owners.
 */
function subjectFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string, isSrcRoot: boolean) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (isSrcRoot && entry.name === "api") continue;
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), false);
        continue;
      }
      if (SUBJECT.test(entry.name) && !IS_TEST.test(entry.name)) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(SRC_ROOT, true);
  return found;
}

const IMPORTS_APIERRORMESSAGE =
  /import\s*\{[^}]*\bapiErrorMessage\b[^}]*\}\s*from\s*["'](?:\.\.\/)+api\/error-copy["']/;
const REIMPLEMENTS_OUTCOME_SWITCH = /case\s*["'](?:unsupported-version|malformed|unreachable)["']/;

/**
 * Files that DO switch on every outcome literal and are not offenders — a
 * list of DECISIONS, not a place to park failures, pinned for the same reason
 * `deep-link-map.ts`'s `APP_PATH_NAMES_NO_SCREEN` is. Widening the pattern
 * scope (fresh review, 2026-09-24) surfaced both: neither switch RETURNS a
 * Spanish sentence for a person to read, which is the one thing this fence
 * polices.
 *
 *   · `ui/reload-state.ts`'s `isOutageShaped` returns a BOOLEAN — whether a
 *     reload's stale banner may keep the last good payload on screen. It never
 *     builds copy; the sentence a screen shows is `apiFailureMessage`'s, passed
 *     in as `staleFailure` by the caller.
 *   · `credential/credential-view-model.ts`'s `cachedCredentialReason` maps to
 *     `CachedReason` — an internal tag (`"offline" | "server" | "version" |
 *     "unreadable"`) for the OFFLINE-DOCUMENT banner, a different mechanism
 *     from a live API failure entirely. Its Spanish labels live in the
 *     SEPARATE `CACHED_REASON_LABEL` object, outside any switch this fence
 *     would ever match.
 */
const NOT_A_COPY_SWITCH: ReadonlySet<string> = new Set([
  "ui/reload-state.ts",
  "credential/credential-view-model.ts",
]);

describe("src/ (outside api/) renders failures through apiFailureMessage — no local switch", () => {
  const files = subjectFiles().map((file) => ({
    rel: path.relative(SRC_ROOT, file).replace(/\\/g, "/"),
    src: withoutComments(readFileSync(file, "utf8")),
  }));

  it("walks a real corpus — the fence must not pass by finding nothing", () => {
    // Non-vacuity: 139 non-test files exist under src/ outside api/ today.
    expect(files.length).toBeGreaterThanOrEqual(120);
    expect(files.some((f) => f.rel === "claims/ClaimScreen.tsx")).toBe(true);
    expect(files.some((f) => f.rel === "pets/pet-photo-view-model.ts")).toBe(true);
    // The excluded directory really was excluded, not merely never matched.
    expect(files.some((f) => f.rel.startsWith("api/"))).toBe(false);
  });

  it("NON-VACUITY: the offender patterns themselves still match real source", () => {
    // A parser regression (a changed import path, a renamed outcome literal)
    // would otherwise make both checks below vacuously pass forever.
    expect(
      IMPORTS_APIERRORMESSAGE.test('import { apiErrorMessage } from "../api/error-copy";'),
    ).toBe(true);
    expect(
      IMPORTS_APIERRORMESSAGE.test('import { apiErrorMessage } from "../../api/error-copy";'),
    ).toBe(true);
    expect(REIMPLEMENTS_OUTCOME_SWITCH.test('case "unsupported-version":')).toBe(true);
    expect(REIMPLEMENTS_OUTCOME_SWITCH.test('case "malformed":')).toBe(true);
    expect(REIMPLEMENTS_OUTCOME_SWITCH.test('case "unreachable":')).toBe(true);
  });

  it("the pinned non-offenders still trip the raw pattern — the allowlist is a decision, not a blind spot", () => {
    // If either stopped matching, the allowlist entry would be dead weight
    // masking whatever the file actually does today.
    const reload = files.find((f) => f.rel === "ui/reload-state.ts");
    const credential = files.find((f) => f.rel === "credential/credential-view-model.ts");
    expect(reload && REIMPLEMENTS_OUTCOME_SWITCH.test(reload.src)).toBe(true);
    expect(credential && REIMPLEMENTS_OUTCOME_SWITCH.test(credential.src)).toBe(true);
  });

  it("no file imports apiErrorMessage or reimplements the outcome switch", () => {
    const offenders = files
      .filter(({ rel }) => !NOT_A_COPY_SWITCH.has(rel))
      .filter(
        ({ src }) => IMPORTS_APIERRORMESSAGE.test(src) || REIMPLEMENTS_OUTCOME_SWITCH.test(src),
      )
      .map(({ rel, src }) => {
        const reasons: string[] = [];
        if (IMPORTS_APIERRORMESSAGE.test(src)) {
          reasons.push("imports apiErrorMessage from api/error-copy directly");
        }
        if (REIMPLEMENTS_OUTCOME_SWITCH.test(src)) {
          reasons.push('reimplements a switch over ApiResult["outcome"]');
        }
        return `${rel}: ${reasons.join(" and ")} — use apiFailureMessage(result) from ../api/client instead`;
      });
    expect(offenders).toEqual([]);
  });
});
