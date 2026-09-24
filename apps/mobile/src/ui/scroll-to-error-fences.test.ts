// Every `useScrollToError` caller must hand its `scrollRef` to a `Screen` — a
// fence, because the defect was a SHAPE and not a value.
//
// WHAT WENT WRONG (forms-F4, filed 2026-09-05 as open-work row 12). The hook
// found the ScrollView through `ScreenScrollContext`, whose provider is mounted
// INSIDE `Screen`. Every screen that calls the hook calls it from the component
// that RENDERS its own `<Screen>` — above the provider — so `useContext`
// answered `null` at every call site in the app, and the hook's own courtesy
// rule ("consumers must treat null as nothing to move") turned that into a
// silent no-op. Two screens shipped with the hook wired and neither one ever
// scrolled: the denuncia and `asentar`, the two longest forms in the app, which
// is precisely where it was introduced to help.
//
// NOTHING WENT RED, and that is the part worth fencing. The hook is best-effort
// by design, so a dead call site is indistinguishable from a working one at
// runtime; and the hook's own unit test wraps its harness in the provider BY
// HAND (`use-scroll-to-error.test.tsx`), so the mechanism was proven in a
// position no real caller is ever in. A green mechanism test over a dead wiring
// is the exact false channel this file closes.
//
// THE REMEDY SHIPPED, AND THIS FENCE IS NOT IT. `Screen` now accepts a
// `scrollRef` prop and the hook hands one back; all eight call sites pass it.
// Re-checked against the tree on 2026-09-11 and every one of them was already
// correct — so what follows guards the SHAPE for the ninth screen, written by
// somebody who read row 12 and not this paragraph.
//
// A FENCE AND NOT EIGHT RENDER ASSERTIONS, for the same reason the keyboard
// fence beside it is one: the failure is "a caller forgot the second half of
// the contract", the ninth caller is the one at risk, and a render test per
// screen cannot be written for a screen that does not exist yet. A refs
// identity check is also not something a render can do — the ref never appears
// in the rendered tree.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@jest/globals";

const MOBILE_ROOT = path.resolve(__dirname, "..", "..");
/** Both source roots. `app/` is expo-router's screens and is real UI too. */
const WALKED = ["src", "app"];
const SKIP_DIRS = new Set(["node_modules", ".expo", "dist", "android", "ios"]);
const EXTENSIONS = [".ts", ".tsx"];

const HOOK = "useScrollToError(";

/**
 * COMMENTS ARE NOT CODE. This rule is documented at three of its call sites and
 * at the hook itself, in prose that names both `useScrollToError` and
 * `scrollRef` — a fence that read comments would be reading its own
 * documentation as evidence and passing on it.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
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

/**
 * The local name a file binds the hook's `scrollRef` to, or `null`.
 *
 * The destructure is `const { anchorRef: errorAnchor, scrollRef } = useScrollToError(…)`
 * at every site today, but the rename form (`scrollRef: somethingElse`) is legal
 * and must be followed rather than assumed away — a fence that only knew one
 * spelling would clear a renamed binding it never checked.
 *
 * `null` means "this file calls the hook and this parser could not find where
 * the ref went", which the rule treats as an offender. A value a fence cannot
 * read is a value it is not fencing.
 */
function scrollRefBinding(content: string): string | null {
  const call = content.indexOf(HOOK);
  if (call === -1) return null;
  const open = content.lastIndexOf("{", call);
  const close = content.indexOf("}", open);
  if (open === -1 || close === -1 || close > call) return null;
  const pattern = content.slice(open + 1, close);
  const renamed = pattern.match(/\bscrollRef\s*:\s*([A-Za-z_$][\w$]*)/);
  if (renamed?.[1]) return renamed[1];
  return /\bscrollRef\b/.test(pattern) ? "scrollRef" : null;
}

/** Whether `name` is handed to a `scrollRef=` prop anywhere in the file. */
function passesToScreen(content: string, name: string): boolean {
  return new RegExp(`scrollRef=\\{\\s*${name}\\s*\\}`).test(content);
}

describe("useScrollToError — a caller that does not pass the ref scrolls nothing", () => {
  const files = WALKED.flatMap(sourceFiles).filter(
    // This file names the hook throughout, and the hook's own module and unit
    // test are the mechanism rather than a consumer of it.
    (file) =>
      !file.endsWith("scroll-to-error-fences.test.ts") &&
      !file.endsWith("use-scroll-to-error.ts") &&
      !file.endsWith("use-scroll-to-error.test.tsx") &&
      !file.endsWith("kit.tsx"),
  );

  const callers = files
    .map((file) => ({
      rel: path.relative(MOBILE_ROOT, file),
      src: withoutComments(readFileSync(file, "utf8")),
    }))
    .filter(({ src }) => src.includes(HOOK));

  it("walks a real corpus — the fence must not pass by finding nothing", () => {
    // Non-vacuity, first half: a broken walk (a renamed root, a bad extension
    // list) would otherwise report a clean sweep of zero files.
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((f) => f.includes(`${path.sep}app${path.sep}`))).toBe(true);
  });

  it("NON-VACUITY: it finds the call sites it judges, including both long forms", () => {
    // Eight screens call the hook (adoption/AdoptionApplyScreen,
    // caretakers/CaretakerPetScreen, custody/MudanzaScreen,
    // denuncias/DenunciaScreen, pets/RecordEventScreen, pets/RehomeScreen,
    // pets/VacunasScreen, transfers/TransferInitiateScreen). A parser
    // regression — a changed hook name, a comment stripper that eats code —
    // would find none of them and sweep an empty list clean forever.
    expect(callers.length).toBeGreaterThanOrEqual(8);
    // The two the row was filed about are named, because they are the two that
    // shipped dead and the ones a refactor is most likely to restructure.
    const named = callers.map((c) => c.rel.replace(/\\/g, "/"));
    expect(named).toContain("src/denuncias/DenunciaScreen.tsx");
    expect(named).toContain("src/pets/RecordEventScreen.tsx");
  });

  it("NON-VACUITY: the binding parser reads a real destructure", () => {
    // The half that would otherwise rot silently: if `scrollRefBinding` stopped
    // finding names it would return `null` everywhere, and `null` IS an
    // offender — so this cannot mask a failure, only prove the parser works on
    // the shape the tree actually uses.
    expect(scrollRefBinding("const { anchorRef: a, scrollRef } = useScrollToError(e);")).toBe(
      "scrollRef",
    );
    expect(scrollRefBinding("const { scrollRef: sr } = useScrollToError(e);")).toBe("sr");
    expect(scrollRefBinding("const { anchorRef } = useScrollToError(e);")).toBeNull();
  });

  it("every caller hands its scrollRef to a Screen", () => {
    // The offender strings carry the remedy: jest's `expect` takes no custom
    // message, so what a red run prints is this array and it has to read like a
    // finding on its own.
    const offenders = callers
      .map(({ rel, src }) => ({ rel, name: scrollRefBinding(src), src }))
      .filter(({ name, src }) => name === null || !passesToScreen(src, name))
      .map(({ rel, name }) =>
        name === null
          ? `${rel}: calls useScrollToError and never binds scrollRef — the hook cannot reach the ScrollView, so it will silently never scroll`
          : `${rel}: binds \`${name}\` and never passes it as <Screen scrollRef={${name}}> — the hook will silently never scroll (open-work row 12)`,
      );
    expect(offenders).toEqual([]);
  });
});
