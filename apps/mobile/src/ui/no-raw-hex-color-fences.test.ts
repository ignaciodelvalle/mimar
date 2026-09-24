// A raw hex colour literal in a component may not appear outside the design
// system — a fence, because DocumentChromeNative.tsx and TurnoDetailScreen.tsx
// each drifted to a literal `"#fff"` / `"#ffffff"` that happened to equal an
// existing `COLORS` token (U-9, M9, 2026-09-24). Nothing caught it: the colour
// LOOKED right, `tsc` does not type hex strings, and no test renders the band
// against a screenshot. Only a source scan can, and only a fence — not a
// one-time fix — stops the next screen from doing the same thing, since the
// literal is just as easy to type as the token import.
//
// THE ONE JUSTIFIED EXCEPTION. `credential/CredentialQr.tsx`'s `QR_INK =
// "#000000"` is not a design-system colour at all — its own comment explains
// why a scanner needs TRUE black, darker than `COLORS.ink` (`#1b2a33`), and no
// token in the palette is that dark. Tokenising it would change the pixel, not
// just the name. `turnos/TurnoDetailScreen.tsx`'s QR quiet-zone frame made the
// same argument for true white — but true white already IS `COLORS.surface`
// (`#ffffff`), so tokenising it changes nothing and it is NOT exempted here.
//
// WHY COMMENTS ARE STRIPPED FIRST. `Icon.tsx`'s own doc comment shows
// `<Icon name="girar" size="sm" color="#fff" />` as a USAGE EXAMPLE — a literal
// this fence must not flag, because the file's actual code takes `color` as a
// prop rather than hard-coding it. A naive whole-file regex would ban the
// documentation of the fix along with the bug.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@jest/globals";

const SRC_ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".expo", "dist", "android", "ios"]);
const SUBJECT = /\.tsx$/;
const IS_TEST = /\.test\.tsx?$/;

/** The one file allowed a raw hex literal, and why — see the header. */
const ALLOWLIST = new Set(["credential/CredentialQr.tsx"]);

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
 * Source with every comment blanked out — block comments first (so a `//`
 * inside one is not mistaken for a line comment start), then line comments,
 * tracked char-by-char so a `//` inside a STRING (none today, but a future
 * URL) is not stripped as if it started a comment.
 *
 * Comments are replaced with spaces, not deleted, so column/line positions —
 * and therefore nothing downstream that might slice by index — never shift.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let quote: '"' | "'" | "`" | null = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "\\") {
        // Preserve the escaped character verbatim, including a `"`/`'`/`` ` ``
        // that would otherwise end the string one character early.
        if (next !== undefined) {
          out += next;
          i += 2;
          continue;
        }
      } else if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g;

type Offence = { file: string; hex: string };

const FILES = walk(SRC_ROOT);
const OFFENCES: Offence[] = [];

for (const file of FILES) {
  const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
  if (ALLOWLIST.has(relative)) continue;
  const code = stripComments(readFileSync(file, "utf8"));
  for (const match of code.match(HEX_COLOR) ?? []) {
    OFFENCES.push({ file: relative, hex: match });
  }
}

describe("no raw hex colour outside the design system", () => {
  it("finds nothing under src/**/*.tsx hard-coding a hex colour", () => {
    expect(OFFENCES.map((offence) => `${offence.file} → ${offence.hex}`)).toEqual([]);
  });

  // NON-VACUITY. A walk that stops recursing, or an allowlist that grows past
  // its one justified entry, would report an empty offender list and read as a
  // pass — the failure mode every fence in this repo is required to close.
  it("actually walks the app's screens and components", () => {
    // Measured 2026-09-24: 57 .tsx files under src/. The floor sits just under
    // that census — ordinary churn must not trip it, but a walk that stopped
    // recursing (a COLLAPSE, this fence's actual failure mode) reports 0 and
    // must.
    expect(FILES.length).toBeGreaterThanOrEqual(50);
    expect(ALLOWLIST.size).toBe(1);
  });

  it("still finds the one allowlisted hex — proves the scan reaches that file at all", () => {
    const qrFile = FILES.find(
      (file) => path.relative(SRC_ROOT, file).split(path.sep).join("/") === "credential/CredentialQr.tsx",
    );
    expect(qrFile).toBeDefined();
    const code = stripComments(readFileSync(qrFile as string, "utf8"));
    expect(code.match(HEX_COLOR)).toEqual(["#000000"]);
  });

  it("recognises the offending shape, and ignores the same literal inside a comment", () => {
    const offending = 'const styles = { color: "#fff" };';
    expect(stripComments(offending).match(HEX_COLOR)).toEqual(["#fff"]);

    const documented = `
      // Usage:
      //   <Icon name="girar" size="sm" color="#fff" />
      export function Icon() {}
    `;
    expect(stripComments(documented).match(HEX_COLOR)).toBeNull();

    const blockCommented = `
      /**
       * Was color: "#ffffff" before the token migration.
       */
      const x = 1;
    `;
    expect(stripComments(blockCommented).match(HEX_COLOR)).toBeNull();
  });
});
