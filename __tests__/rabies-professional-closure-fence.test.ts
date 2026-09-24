// Fence: only a professional may assert a clinical outcome on a rabies
// observation (PO decision 2026-08-17, engram
// roadmap/decisiones-legales-flujos-2026-08-17 item 1).
//
// WHY A SOURCE FENCE AND NOT ONLY UNIT TESTS
// ---------------------------------------------------------------------------
// The unit tests next to each use-case pin the behaviour of the code that
// exists. They cannot notice a NEW writer. The two paths deleted on 2026-08-17
// — the cron sweep and the owner's "Confirmar fin de observación" button — were
// each perfectly reasonable-looking twenty-line blocks; what made them wrong was
// not their internals but WHO was allowed to run them. That property lives
// across files, so it is checked across files.
//
// The rule: a writer may emit `rabies_observation_ended` (the event that carries
// `outcome`) only if it is the professional close or the death cascade. The
// death cascade is authored by the system, but it asserts a DEATH that a human
// recorded — not a clinical clearance — and its outcome is fixed to 'dead'.
//
// Regex over source, same tradeoff as every sibling linter in scripts/: an
// occurrence inside a comment would count, so comments are stripped first.

import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

/** Writers that are ALLOWED to emit a rabies_observation_ended event. */
const ALLOWED_WRITERS = [
  // The sanitary authority / admin close — the only path that asserts an outcome.
  "src/modules/surveillance/application/professional-close-observation.ts",
  // death_recorded cascade: outcome is pinned to 'dead' and mirrors a death a
  // human recorded elsewhere in the same transaction.
  "src/modules/events/application/lifecycle/death-record-use-case.ts",
];

/**
 * Files that NAME the event type without writing the event. Each must reach the
 * event only through an allowed writer — the second test below checks that it
 * imports one — so an entry here cannot become a back door: a file that dropped
 * the writer and inserted the event itself would fail that test.
 *
 * Added 2026-09-18 (pilot contract T0-1): the Atender action lets a verified vet
 * close an observation. The WRITE happens in `professionalCloseObservation`; the
 * action then passes `eventType: "rabies_observation_ended"` to
 * `completeAtenderSignature` only to link the owner's notice to the event that
 * was already written. The regex below cannot tell that argument from a write.
 */
const REFERENCES_NOT_WRITES: Record<string, { via: string }> = {
  "app/org/[orgToken]/atender/actions.ts": { via: "professionalCloseObservation" },
};

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Excluded from the scan: test and mock sources. Filtered in JS rather than via
 * `globSync`'s `exclude` option, which only accepts a list of glob patterns on
 * Node >= 24 — on the pinned 22.13.0 it must be a function, and passing the
 * array threw `TypeError: The "options.exclude" property must be of type
 * function`, which took every test in this file down with it. Sibling linters in
 * `scripts/` filter the same way for the same reason.
 */
function isExcluded(relPath: string): boolean {
  return (
    relPath.endsWith(".test.ts") ||
    relPath.endsWith(".test.tsx") ||
    relPath.includes("__tests__/") ||
    relPath.includes("__mocks__/")
  );
}

function productionSources(): string[] {
  return globSync(["app/**/*.ts", "app/**/*.tsx", "src/**/*.ts", "src/**/*.tsx", "lib/**/*.ts"], {
    cwd: ROOT,
  })
    .map((rel) => rel.replace(/\\/g, "/"))
    .filter((rel) => !isExcluded(rel));
}

describe("rabies observation — clinical outcome fence", () => {
  it("scans a non-trivial number of source files (non-vacuity)", () => {
    expect(productionSources().length).toBeGreaterThan(200);
  });

  it("only the professional close and the death cascade emit rabies_observation_ended", () => {
    const offenders: string[] = [];
    for (const rel of productionSources()) {
      const normalized = rel.replace(/\\/g, "/");
      if (ALLOWED_WRITERS.includes(normalized)) continue;
      if (normalized in REFERENCES_NOT_WRITES) continue;
      const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      // A WRITE looks like `eventType: "rabies_observation_ended"` or
      // `validateEventPayload("rabies_observation_ended", …)`. A read
      // (`eq(petEvents.eventType, …)`, a projection switch, a SQL string) does
      // not, which is why the match is anchored on those two shapes.
      if (
        /eventType:\s*["']rabies_observation_ended["']/.test(src) ||
        /validateEventPayload\(\s*["']rabies_observation_ended["']/.test(src)
      ) {
        offenders.push(normalized);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every reference-not-write entry reaches the event only through an allowed writer", () => {
    for (const [rel, { via }] of Object.entries(REFERENCES_NOT_WRITES)) {
      const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      // It must call the allowed writer…
      expect(new RegExp(`\\b${via}\\s*\\(`).test(src), `${rel} must call ${via}()`).toBe(true);
      // …and must not write the event itself: no validateEventPayload for it,
      // and no spine insert in the same file.
      expect(
        /validateEventPayload\(\s*["']rabies_observation_ended["']/.test(src),
        `${rel} validates a rabies_observation_ended payload itself`,
      ).toBe(false);
      expect(/insert\(\s*petEvents\s*\)/.test(src), `${rel} inserts into petEvents itself`).toBe(
        false,
      );
    }
  });

  it("the fence is non-vacuous: the allowed writers really do emit the event", () => {
    for (const rel of ALLOWED_WRITERS) {
      const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      expect(
        /eventType:\s*["']rabies_observation_ended["']/.test(src) ||
          /validateEventPayload\(\s*["']rabies_observation_ended["']/.test(src),
      ).toBe(true);
    }
  });

  it("no production writer sets pets.rabies_observation_status to a completed_* value outside the allowed writers", () => {
    const offenders: string[] = [];
    for (const rel of productionSources()) {
      const normalized = rel.replace(/\\/g, "/");
      if (ALLOWED_WRITERS.includes(normalized)) continue;
      const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      // setObservationStatus(petId, "completed_…") — the cache half of the
      // dual-write. outcomeToStatus() calls are fine: they are only reachable
      // from an outcome, which only the allowed writers hold.
      if (/setObservationStatus\([^)]*["']completed_/.test(src)) {
        offenders.push(normalized);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the owner close path is gone — no action named ownerClose* survives", () => {
    const offenders: string[] = [];
    for (const rel of productionSources()) {
      const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      if (/ownerClose(Rabies)?Observation/.test(src)) offenders.push(rel.replace(/\\/g, "/"));
    }
    expect(offenders).toEqual([]);
  });
});
