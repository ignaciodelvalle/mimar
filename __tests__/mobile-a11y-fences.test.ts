// Mobile source fences (C3, 2026-09-01) — the rules a phone build keeps.
//
// Three of them are a11y; the fourth (L2-10, decimal fields) is not, and it is
// here for the reason stated on the rule itself: this file is the only
// instrument that reaches `apps/mobile/app/`, where jest does not go. The
// FIFTH (F4, the discard-guard navigation fake) is not a11y either, and its
// reason is different again: it is a rule ABOUT TEST FILES, and a jest test
// cannot be the thing that audits the jest suite it belongs to.
//
// Same instrument as mobile-screen-titles.test.ts: a root vitest fence that
// SCANS apps/mobile source, so it runs inside test:verified without touching
// pnpm verify's fence count. What it holds:
//
//   1. EVERY `<Pressable` NAMES ITS ROLE. A Pressable with no
//      `accessibilityRole` is a control TalkBack announces as nothing — the
//      tap works and the person navigating by screen reader never finds it.
//      Checked PER BLOCK (opening tag scan), not per file: a file with two
//      pressables and one role passes a per-file count and still ships an
//      unnamed control.
//   2. EVERY PRESSABLE FILE MINDS THE 44dp TARGET. A file that renders a
//      `<Pressable` must reference `TOUCH_TARGET` or `hitSlop` at least
//      once. Deliberately file-grained — static analysis cannot resolve
//      which style object lands on which control — so this catches the
//      CLASS (a new interactive surface built with no target discipline;
//      PhoneRow shipped exactly that way the morning this fence was
//      written) and the per-control truth stays with the screen tests.
//   3. THE EMPTY-STATE PRIMITIVE CANNOT QUIETLY DIE. The web's fence scans
//      for bare "Sin resultados" literals; that shape does NOT transfer —
//      mobile empty copy lives in view-models, not JSX. What is fenceable
//      is the primitive's adoption: `EmptyState` (src/ui/components.tsx)
//      must keep at least its current number of consumer files. A refactor
//      that inlines dead-end `<Body>` empties would walk this number down
//      and go red; per-screen render tests hold the copy itself.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// BOTH ROOTS (CA-3, 2026-09-06). The scan read `src` only, and `app/` is not a
// thinner tree: it is expo-router's screens, and `alta.tsx` alone renders the
// registration wizard's radio pills. Everything this file fences was
// unenforced there — the pills shipped under the 44dp floor and announced
// `accessibilityState={{ selected }}` on a `radio`, and no gate said a word.
// Jest cannot cover them either: apps/mobile's `roots` is `<rootDir>/src`
// (CANON-431), so `app/` has no render tests at all and this fence is the only
// mechanism that reaches it.
const MOBILE_ROOTS = [
  resolve(__dirname, "../apps/mobile/src"),
  resolve(__dirname, "../apps/mobile/app"),
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const files = MOBILE_ROOTS.flatMap(walk).map((full) => ({
  rel: relative(resolve(__dirname, ".."), full).replaceAll("\\", "/"),
  content: readFileSync(full, "utf-8"),
}));

// ---------------------------------------------------------------------------
// The TEST corpus, for rule 5 (F4). `walk` above deliberately skips `.test.*`;
// this rule is about those files, so it needs its own walk.
// ---------------------------------------------------------------------------

function walkTests(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTests(full));
    else if (/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const MOBILE_SRC = resolve(__dirname, "../apps/mobile/src");

const testFiles = walkTests(MOBILE_SRC).map((full) => ({
  full,
  rel: relative(resolve(__dirname, ".."), full).replaceAll("\\", "/"),
  content: readFileSync(full, "utf-8"),
}));

/** Every source module in `apps/mobile/src`, by absolute path with no extension. */
const sourceByStem = new Map(
  MOBILE_ROOTS.flatMap(walk).map((full) => [
    full.replace(/\.tsx?$/, ""),
    readFileSync(full, "utf-8"),
  ]),
);

/**
 * Does this module CALL or DEFINE the discard guard?
 *
 * Not a bare substring search: `ui/use-draft-dirty.ts` names the hook in prose
 * ("`useDraftDiscardGuard` shipped on 2026-09-07") and does not use it, and a
 * fence that accused a docblock would be trained away within a week.
 */
function touchesDiscardGuard(content: string): boolean {
  return (
    /\buseDraftDiscardGuard\s*\(/.test(content) ||
    /export function useDraftDiscardGuard\b/.test(content)
  );
}

/** The modules a test file imports by relative path, resolved to source text. */
function relativeImportsOf(file: { full: string; content: string }): string[] {
  const out: string[] = [];
  const re = /from\s+["'](\.[^"']+)["']/g;
  let match = re.exec(file.content);
  while (match !== null) {
    const stem = resolve(file.full, "..", match[1] as string).replace(/\.tsx?$/, "");
    const source = sourceByStem.get(stem);
    if (source !== undefined) out.push(source);
    match = re.exec(file.content);
  }
  return out;
}

/**
 * Every `<Pressable` opening tag in `content`, as raw text. The tag ends at
 * the first `>` that sits outside JSX-expression braces — the same
 * brace-depth walk check-empty-state-consistency.ts uses.
 */
function pressableOpenings(content: string): string[] {
  return jsxOpenings(content, "Pressable");
}

/** The same walk, for any component. See `pressableOpenings` for the rule. */
function jsxOpenings(content: string, tag: string): string[] {
  const openings: string[] = [];
  const re = new RegExp(`<${tag}\\b`, "g");
  let match = re.exec(content);
  while (match !== null) {
    let i = match.index;
    let depth = 0;
    while (i < content.length) {
      const ch = content[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) break;
      i += 1;
    }
    openings.push(content.slice(match.index, i + 1));
    match = re.exec(content);
  }
  return openings;
}

/**
 * The property NAMES in a tag's `accessibilityState={{ … }}`.
 *
 * Shorthand (`{{ selected }}`) yields "selected"; `{{ checked: selected }}`
 * yields "checked" — which is the whole point, since the value there is a
 * variable that happens to be called `selected`.
 *
 * KNOWN BLIND SPOT: a computed state object (`accessibilityState={someVar}`,
 * one pair of braces) matches nothing here and yields `[]`, so a radio built
 * that way is neither accused nor cleared — it is simply not seen. Nothing in
 * `apps/mobile` writes one today, and the shape is worth naming because the
 * rule below would go on passing if one appeared. Reading it would take
 * resolving a variable across a file, which is where static analysis stops
 * being honest; the per-control truth for such a control belongs in a render
 * test.
 */
function stateKeys(opening: string): string[] {
  const match = /accessibilityState=\{\{([^}]*)\}\}/.exec(opening);
  if (match === null) return [];
  return (match[1] ?? "")
    .split(",")
    .map((entry) => (entry.split(":")[0] ?? "").trim())
    .filter((key) => key.length > 0);
}

const pressableFiles = files
  .map((f) => ({ ...f, openings: pressableOpenings(f.content) }))
  .filter((f) => f.openings.length > 0);

describe("mobile a11y fences (C3)", () => {
  it("NON-VACUITY: the scan sees the codebase it claims to fence", () => {
    // 92 source files and 18 pressable files existed the day this was
    // written; a scan that finds far fewer is reading the wrong tree, not
    // fencing a smaller app.
    expect(files.length).toBeGreaterThan(80);
    expect(pressableFiles.length).toBeGreaterThanOrEqual(15);
    // And it sees the SECOND root. A walk that silently lost `app/` would keep
    // passing on `src` alone — the exact shape of the gap CA-3 closed.
    expect(files.some((f) => f.rel.startsWith("apps/mobile/app/"))).toBe(true);
  });

  it("a radio's state is `checked`, never `selected` — a radio is not a tab", () => {
    // CA-1: `accessibilityState={{ selected }}` on `accessibilityRole="radio"`
    // is announced by TalkBack and VoiceOver as an UN-CHECKABLE control. The
    // person hears which pill has focus and never hears which one is chosen.
    // Caught here rather than in a render test because the only radio group in
    // the app lives in `app/alta.tsx`, where jest does not reach.
    const offenders: string[] = [];
    const radios: string[] = [];
    for (const f of files) {
      for (const opening of pressableOpenings(f.content)) {
        if (!/accessibilityRole=["']radio["']/.test(opening)) continue;
        radios.push(f.rel);
        // THE KEYS, not the text: `{{ checked: selected }}` is CORRECT and a
        // substring search for "selected" flags it — the first draft of this
        // fence did exactly that and accused two innocent files. Only a
        // property NAMED `selected` is the defect.
        if (stateKeys(opening).includes("selected")) {
          offenders.push(`${f.rel}: ${opening.split("\n")[0]}…`);
        }
      }
    }
    // NON-VACUITY, and this rule is the one that needed it most. The filter is
    // two regexes over a brace-depth walk: if the walk regresses — a `>` inside
    // a string, a renamed prop — the loop iterates ZERO radios and
    // `expect([]).toEqual([])` passes forever, which is the silent clean sweep
    // the other two rules already guard against. SEVEN radio openings existed
    // when this was written, across six files: `alta.tsx`'s species pills,
    // `kit.tsx`'s `Choice`, `LostScreen`'s report categories, plus
    // `DenunciaScreen`, `NotificationsScreen` and `ReservarTurnoScreen` (two).
    // The floor is
    // three, low enough to survive a screen being deleted and high enough that
    // a broken walk cannot reach it.
    expect(radios.length, `radio openings seen: ${radios.join(", ")}`).toBeGreaterThanOrEqual(3);
    expect(
      offenders,
      `A radio must report \`checked\`. \`selected\` is a tab's state:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every <Pressable> names its accessibilityRole — per BLOCK, not per file", () => {
    const unnamed: string[] = [];
    for (const f of pressableFiles) {
      for (const opening of f.openings) {
        if (!opening.includes("accessibilityRole")) {
          unnamed.push(`${f.rel}: ${opening.split("\n")[0]}…`);
        }
      }
    }
    expect(
      unnamed,
      `Pressables with no accessibilityRole — TalkBack announces these as nothing:\n${unnamed.join("\n")}`,
    ).toEqual([]);
  });

  it("every file that renders a <Pressable> references TOUCH_TARGET or hitSlop", () => {
    const undisciplined = pressableFiles
      .filter((f) => !f.content.includes("TOUCH_TARGET") && !f.content.includes("hitSlop"))
      .map((f) => f.rel);
    expect(
      undisciplined,
      `Pressable files with no touch-target discipline (44dp, theme.ts TOUCH_TARGET):\n${undisciplined.join("\n")}`,
    ).toEqual([]);
  });

  // L2-10 — a FOURTH rule, and the only one here that is about data rather than
  // about a screen reader. It lives in this file because this file is the only
  // instrument that reaches `apps/mobile/app/`: jest's `roots` is `<rootDir>/src`
  // (CANON-431), so `alta.tsx` — the one screen with a decimal field — has no
  // render test that could hold it.
  it("no decimal field caps its own length — truncation rewrites a number", () => {
    const capped: string[] = [];
    const decimals: string[] = [];
    for (const f of files) {
      for (const opening of jsxOpenings(f.content, "TextField")) {
        if (!/inputMode=["']decimal["']/.test(opening)) continue;
        decimals.push(f.rel);
        if (/\bmaxLength=/.test(opening)) capped.push(`${f.rel}: ${opening.split("\n")[0]}…`);
      }
    }
    // NON-VACUITY, for the reason the radio rule spells out: this is an
    // `expect([]).toEqual([])` over a filtered loop, so a broken walk or a
    // renamed prop makes it pass forever. One decimal field exists today (the
    // alta wizard's "Peso aproximado"); the floor is that one.
    expect(decimals.length, `decimal fields seen: ${decimals.join(", ")}`).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      capped,
      `A \`maxLength\` on a decimal field does not refuse the extra digit — it DROPS it, and what is left parses: \`123,456\` becomes \`123,45\`, a different weight with nothing on screen to say so. Bound it in the contract (WEIGHT_INVALID), which can say no out loud, not in the keyboard:\n${capped.join("\n")}`,
    ).toEqual([]);
    // AND THE RULE IS NOT "never cap a field". A FIXED-WIDTH MASK is safe —
    // `DateField`'s `maxLength={10}` is the width of `DD/MM/AAAA`, so there is
    // no eleventh character a person could have meant. What is unsafe is capping
    // a format with no width: every prefix of a decimal is another decimal.
    const kit = files.find((f) => f.rel.endsWith("src/ui/kit.tsx"));
    expect(kit?.content).toMatch(/maxLength=\{10\}/);
  });

  // RULE 5 (F4, review 2026-09-07) — THE SUBJECT IS THE FAKE, NOT ITS SPELLING.
  //
  // `ui/navigation-fake.ts` was built to end a stub that several screen tests
  // carried by hand: `useNavigation: () => ({ addListener: () => () => {} })`.
  // That object never fires the listener, so a screen with NO discard guard, or
  // with one that intercepts its own success navigation, passes every case in
  // the file — which is exactly how `AdoptionApplyScreen` shipped asking
  // "¿Salir sin guardar?" over a postulación the shelter already had. The fake
  // was written and two guarded screens were left on the stub anyway.
  //
  // A FENCE THAT ENUMERATED SPELLINGS WOULD MISS THE NEXT ONE. Banning the
  // literal `addListener: () => () => {}` catches today's copies and nothing
  // else: `addListener: () => noop`, a `jest.fn()` that returns undefined, a
  // fresh object per call with a real unsubscribe — all of them reintroduce one
  // half of the defect and none of them match. So the rule names the SUBJECT: a
  // test that mocks the router for a module which uses the guard must get its
  // navigation object from the one place that owns those two properties.
  it("a guarded screen's test uses the shared navigation fake, never its own", () => {
    const guarded: string[] = [];
    const offenders: string[] = [];
    for (const file of testFiles) {
      if (!/jest\.mock\(\s*["']expo-router["']/.test(file.content)) continue;
      if (!relativeImportsOf(file).some(touchesDiscardGuard)) continue;
      guarded.push(file.rel);
      if (!file.content.includes("createNavigationFake")) offenders.push(file.rel);
    }
    // NON-VACUITY, measured against the real corpus on 2026-09-07: TEN test
    // files mock the router for a module that uses the guard — the eight guarded
    // screens with jest coverage (asentar/RecordEvent, editar ficha, editar mis
    // datos, mudanza, denuncia, transferir, postularme, modo perdida), plus
    // CaretakerPetScreen and the guard's own binding test. The floor is 6: low
    // enough to survive two screens being deleted or losing their router mock,
    // high enough that a broken import walk — a renamed fake, a resolver that
    // stops matching, `relativeImportsOf` returning [] — cannot reach it and
    // sweep the rule clean. `expect([]).toEqual([])` over a filtered loop is the
    // shape that passes forever when the filter breaks.
    expect(
      guarded.length,
      `guarded screen tests seen: ${guarded.join(", ")}`,
    ).toBeGreaterThanOrEqual(6);
    expect(
      offenders,
      `These render a screen with a live \`useDraftDiscardGuard\` behind a hand-written \`useNavigation\`. A stub that never fires the listener cannot tell a guarded screen from an unguarded one — import \`createNavigationFake\` from src/ui/navigation-fake.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("EmptyState keeps its consumers — the primitive cannot quietly die", () => {
    const consumers = files.filter(
      (f) => !f.rel.endsWith("ui/components.tsx") && /\bEmptyState\b/.test(f.content),
    );
    // 4 consumer files when written (adoption catalogue, buscar turno,
    // reservar turno, owner face). Raise this floor when adoption grows;
    // never lower it to make a red go away — that red IS the finding.
    expect(consumers.length).toBeGreaterThanOrEqual(4);
  });
});
