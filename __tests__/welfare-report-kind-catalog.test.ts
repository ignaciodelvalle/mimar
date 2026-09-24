// The nine kinds of Ley 14.346 exist in three places. This is what stops them
// becoming three different lists.
//
// WHY THERE ARE THREE COPIES AT ALL
// ---------------------------------------------------------------------------
//   1. `welfare_report_kind`, a PostgreSQL enum (`db/schema.ts`). The one that
//      actually governs: a value Postgres refuses cannot be stored whatever any
//      TypeScript file believes.
//   2. `WELFARE_REPORT_KINDS` in `src/modules/welfare/domain/types.ts` — the
//      domain owner, where the es-AR labels live and where every operator
//      surface reads its filter options.
//   3. `WELFARE_REPORT_KINDS` in `packages/contract/src/input/welfare-report.ts`
//      — the CLIENT's copy. `packages/contract` is installable by a React Native
//      app and may import nothing from `@/src` or `@/db` (see
//      `scripts/check-contract-purity.ts`), so this one cannot be an import. It
//      has to be a copy.
//
// A fourth copy used to exist and is worth naming as the reason this file is
// written the way it is: `WELFARE_KINDS`, a bare `string[]` inside
// `src/modules/welfare/actions.ts`, which the web's two intakes validate
// against. It is still there. It is included below rather than left out,
// because a list nobody checks is exactly the one that drifts — and because a
// fence over "the copies I remembered" is a fence over a subset.
//
// WHAT THIS FILE ASSERTS, AND WHY IT IS ORDER-SENSITIVE
// ---------------------------------------------------------------------------
// Equality of the ARRAYS, not of sets. A sorted-set comparison would let two
// copies drift in presentation while agreeing in content — and this list is also
// the order a wizard offers the options in, so presentation is content here. It
// runs in both directions by construction: `toEqual` over arrays fails when one
// side grows a member, when one side loses one, and when they are reordered.
//
// THE COUNT IS DERIVED AND NOT WRITTEN DOWN. The board records seven numbers
// that rotted in this repo by being transcribed, and "nine" is one word away
// from being the eighth. The only literal here is the ONE the whole thing hangs
// off — Postgres's own enum — and every other number is read from it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { welfareReportKindEnum } from "@/db/schema";
import {
  WELFARE_REPORT_KINDS as DOMAIN_KINDS,
  welfareReportKindLabel,
} from "@/src/modules/welfare/domain/types";
import { WELFARE_REPORT_KINDS as CONTRACT_KINDS } from "@dim/contract/input";

const ROOT = join(__dirname, "..");

/**
 * The `WELFARE_KINDS` array inside `src/modules/welfare/actions.ts`, read out of
 * the source.
 *
 * IT IS NOT IMPORTED, and it cannot be: the module is `"use server"`, so it may
 * only export async actions and the constant is module-private. Reading the
 * source is the only way to see it — which is also why it is the copy most
 * likely to drift, and therefore the one most worth reading.
 *
 * ANCHORED TO THE DECLARATION, not to a loose regex over the file. If the
 * constant is renamed or deleted this throws instead of matching something
 * else; a parser that silently finds nothing is how a fence goes vacuous.
 */
function actionsWelfareKinds(): string[] {
  const src = readFileSync(join(ROOT, "src/modules/welfare/actions.ts"), "utf8");
  const match = src.match(/const WELFARE_KINDS = \[([\s\S]*?)\];/);
  if (!match) {
    throw new Error(
      "src/modules/welfare/actions.ts no longer declares `const WELFARE_KINDS = [...]` — " +
        "if the web's intake now validates against the domain catalogue directly, delete this " +
        "helper and the assertion that uses it. Do not loosen the pattern.",
    );
  }
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("the Ley 14.346 kind catalogue is one list wearing four names", () => {
  it("is non-empty and comes from Postgres, so nothing below is vacuously true", () => {
    // The anchor. Every other assertion compares against this array, and an
    // empty one would make all of them pass — the failure shape this repo keeps
    // rediscovering in its own fences.
    expect(welfareReportKindEnum.enumValues.length).toBeGreaterThan(0);
  });

  it("matches the DOMAIN copy exactly, in order", () => {
    expect(DOMAIN_KINDS).toEqual(welfareReportKindEnum.enumValues);
  });

  it("matches the CONTRACT copy exactly, in order — the one a phone installs", () => {
    // THE MUTATION THIS EXISTS FOR: add "spam" to `WELFARE_REPORT_KINDS` in
    // `packages/contract/src/input/welfare-report.ts`. Applied: the schema then
    // accepts a kind the column refuses, `/api/v1/welfare-reports` answers 201,
    // and the INSERT fails with a Postgres enum violation the client sees as a
    // 500. This is what turns that into a red at build time instead.
    expect([...CONTRACT_KINDS]).toEqual(welfareReportKindEnum.enumValues);
  });

  it("matches the WEB INTAKE's private copy exactly, in order", () => {
    // The fourth list — the one validating `/denuncias/nueva` and the org form.
    // It is a bare `string[]`, so nothing about it is checked by the type system.
    expect(actionsWelfareKinds()).toEqual(welfareReportKindEnum.enumValues);
  });

  it("gives every kind an es-AR label that is not just the enum value back", () => {
    // NON-VACUITY of a different kind, and a real gap the pins above cannot see:
    // a kind added to all four arrays and forgotten in
    // `welfareReportKindLabel`'s `switch` falls through to `default: return
    // kind`, so an operator queue renders `dog_fighting` and every array
    // assertion stays green.
    //
    // Kill it by deleting the `case "trafficking":` arm from
    // `welfareReportKindLabel`. Applied: this fails naming that kind.
    const unlabelled = welfareReportKindEnum.enumValues.filter(
      (kind) => welfareReportKindLabel(kind) === kind,
    );
    expect(unlabelled).toEqual([]);
  });
});
