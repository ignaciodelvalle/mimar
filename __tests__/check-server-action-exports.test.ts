// Offline guard for the "use server" export-shape fence
// (scripts/check-server-action-exports.ts).
//
// The fence exists because Next validates EVERY export of a "use server" module
// and throws at module load on anything that is not an async function — a hard
// 500 that tsc, biome and this very suite all wave through. So the assertions
// here are of two kinds, and the second matters more:
//
//   · the CLASSIFIER, one case per shape that can break a page. Each `expect`
//     below is a distinct way to produce the production error, and the
//     difference between "flagged" and "silently allowed" is one regex.
//   · the SCAN SET, pinned by NAME. The fence's plausible failure is not
//     misjudging an export — it is never opening the file, which reads exactly
//     like a clean run. The script carries crude count floors for the `pnpm
//     verify` lane (no test runner there); these pins catch a narrowing that
//     still leaves the counts healthy.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MIN_RUNTIME_EXPORTS,
  MIN_SERVER_ACTION_MODULES,
  classifyExports,
  isServerActionModule,
  listServerActionModules,
} from "@/scripts/check-server-action-exports";

const problems = (src: string) =>
  classifyExports(src)
    .filter((v) => v.problem !== null)
    .map((v) => v.name);

describe("isServerActionModule", () => {
  it("recognises the directive as the first statement, in either quote style", () => {
    expect(isServerActionModule('"use server";\n\nexport async function a() {}')).toBe(true);
    expect(isServerActionModule("'use server';\n")).toBe(true);
  });

  it("still sees it behind a header comment — the convention in this repo", () => {
    expect(isServerActionModule('// Adoption actions.\n"use server";\n')).toBe(true);
  });

  it("does not fire on a file that only MENTIONS the directive", () => {
    // 133 files in the repo say "use server" in prose; 91 carry it. Most of the
    // difference is comments explaining that a helper file deliberately has none
    // (src/modules/events/action-support.ts and its siblings) — reading one of
    // those as an action module would make the fence demand that a plain
    // constants file stop exporting constants.
    expect(
      isServerActionModule(
        '// This module is intentionally NOT a "use server" file.\nexport const a = 1;',
      ),
    ).toBe(false);
  });
});

describe("classifyExports — shapes Next rejects at module load", () => {
  it("flags the exact defect this fence was written for: an exported object", () => {
    expect(problems("export const LIMITS = {\n  maxPerMinute: 8,\n} as const;")).toEqual([
      "LIMITS",
    ]);
  });

  it("flags a synchronous function", () => {
    expect(problems("export function helper() {\n  return 1;\n}")).toEqual(["helper"]);
  });

  it("flags a class, an enum and a mutable binding", () => {
    expect(problems("export class Repo {}")).toEqual(["Repo"]);
    expect(problems('export enum Kind {\n  A = "a",\n}')).toEqual(["Kind"]);
    expect(problems("export let counter = 0;")).toEqual(["counter"]);
  });

  it("flags an alias whose asyncness cannot be proven here", () => {
    // `export const f = someImportedFn` and `export { helper }` both hide the
    // answer behind a module resolution step. The fence refuses to guess:
    // "probably fine" is the reasoning that shipped the 500.
    expect(problems("export const doIt = someWriter;")).toEqual(["doIt"]);
    expect(problems("export { helper };")).toEqual(["export { helper };"]);
    expect(problems('export * from "./writers";')).toEqual(['export * from "./writers";']);
  });

  it("flags an abstract class too", () => {
    expect(problems("export abstract class Base {}")).toEqual(["Base"]);
  });

  it("flags an export shape it does not recognise rather than skipping it", () => {
    // The `continue` this branch replaces is the hole: an unknown shape that
    // slipped through silently would be a new blind spot every time TypeScript
    // grows a declaration form.
    expect(problems("export namespace Legacy {}")).toEqual(["export namespace Legacy {}"]);
  });

  it("flags a test-only helper even when it is a legal async function (A01-4)", () => {
    // In a "use server" module every export is a production endpoint; the two
    // rate-limit resets that lived in such modules let any browser clear a live
    // throttle.
    expect(problems("export async function __resetRateLimitForTests() {}")).toEqual([
      "__resetRateLimitForTests",
    ]);
    expect(problems("export async function __resetKpisCache() {}")).toEqual(["__resetKpisCache"]);
    expect(problems("export const seedForTest = async () => {};")).toEqual(["seedForTest"]);
  });
});

describe("classifyExports — shapes that are legal", () => {
  it("accepts async functions in declaration and expression form", () => {
    expect(problems("export async function act(x: string) {\n  return x;\n}")).toEqual([]);
    expect(problems("export const act = async (x: string) => x;")).toEqual([]);
    // The test-only rule keys on the name's edges, not on the substring.
    expect(problems("export async function testForTestsDrift() {}")).toEqual([]);
    expect(problems("export const act = async function (x: string) {\n  return x;\n};")).toEqual(
      [],
    );
  });

  it("accepts an async arrow whose parameters wrap across lines", () => {
    // The dominant shape in this repo's action modules. A classifier that only
    // looked at the declaration LINE would read this as a non-async const and
    // fail every one of them.
    expect(
      problems("export const act = async (\n  a: string,\n  b: string,\n) => `${a}${b}`;"),
    ).toEqual([]);
  });

  it("accepts type-only exports — they are erased before Next ever sees them", () => {
    expect(problems("export type State = { error: string | null };")).toEqual([]);
    expect(problems("export interface Deps {\n  db: unknown;\n}")).toEqual([]);
    expect(problems('export type { AgeBucket } from "./domain/types";')).toEqual([]);
    expect(problems("export { type A, type B };")).toEqual([]);
  });

  it("marks erased exports as erased, so the runtime floor cannot be inflated by types", () => {
    const kinds = classifyExports(
      "export type State = { a: number };\nexport async function act() {}",
    ).map((v) => v.kind);
    expect(kinds).toEqual(["erased", "runtime"]);
  });

  it("does not read an export named inside a comment as a declaration", () => {
    expect(problems("// export const LIMITS = { a: 1 };\nexport async function act() {}")).toEqual(
      [],
    );
  });
});

describe("scan set", () => {
  const modules = listServerActionModules();

  it("opens a plausible number of modules", () => {
    expect(modules.length).toBeGreaterThanOrEqual(MIN_SERVER_ACTION_MODULES);
  });

  it("includes the module the production 500 came from", () => {
    expect(modules).toContain("src/modules/adoption/actions.ts");
  });

  it("includes route-colocated and app/ action files, not just src/modules/*/actions.ts", () => {
    // check-action-redirect.ts lost its whole point once to filename globs that
    // missed `action.ts` (SINGULAR) and the app/ tree. This fence discovers by
    // CONTENT so it cannot repeat that — these pins are what prove the
    // discovery did not quietly narrow back to a naming convention.
    expect(modules.some((f) => f.startsWith("app/"))).toBe(true);
    expect(modules.some((f) => f.endsWith("/action.ts"))).toBe(true);
  });

  it("excludes files that only mention the directive in prose", () => {
    expect(modules).not.toContain("src/modules/events/action-support.ts");
    expect(modules).not.toContain("src/modules/adoption/domain/dni-check-policy.ts");
  });

  it("classifies enough RUNTIME exports across the corpus to be judging anything", () => {
    // The count that matters: erased type exports cannot offend, so a
    // classifier that started reading every export as a type would keep the
    // module count and the total healthy while examining nothing.
    let runtime = 0;
    for (const file of modules) {
      for (const v of classifyExports(readFileSync(file, "utf8"))) {
        if (v.kind === "runtime") runtime++;
      }
    }
    expect(runtime).toBeGreaterThanOrEqual(MIN_RUNTIME_EXPORTS);
  });
});
