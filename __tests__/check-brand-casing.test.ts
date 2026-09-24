/**
 * Unit tests for scripts/check-brand-casing.ts — the miMAR brand lint fence.
 *
 *   Rule 1 (2026-07-18) — brand CASING:   the public brand is spelled "miMAR".
 *   Rule 2 (2026-07-30) — brand IDENTITY: the public brand is the only name
 *                                          that appears.
 *
 * Rule 2 exists because Rule 1 was not enough. The Ley 14.346 denuncia PDF
 * filed with the Unidad Fiscal de Maltrato Animal signed itself "Documento
 * generado por DIM" three lines under a header reading "miMAR — Mi Mascota
 * Argentina". The fence already scanned that file; it had no rule for it.
 *
 * Pure fixture tests (no filesystem I/O): exercise the exported regexes and
 * the find*Hits helpers against known-bad and known-good fixture strings,
 * mirroring __tests__/check-professionalism.test.ts.
 */

import { describe, expect, it } from "vitest";

import {
  CODENAME_PRAGMA,
  INTERNAL_CODENAME,
  WRONG_CASE_BRAND,
  findBrandHits,
  findCodenameHits,
} from "@/scripts/check-brand-casing";

// ---------------------------------------------------------------------------
// WRONG_CASE_BRAND — recall
// ---------------------------------------------------------------------------

describe("WRONG_CASE_BRAND — recall (the wrong-cased forms)", () => {
  const BAD = ["MiMAR", "Mimar", "MIMAR"];
  for (const word of BAD) {
    it(`matches "${word}"`, () => {
      WRONG_CASE_BRAND.lastIndex = 0;
      expect(word).toMatch(WRONG_CASE_BRAND);
    });
  }
});

// ---------------------------------------------------------------------------
// WRONG_CASE_BRAND — precision
// ---------------------------------------------------------------------------

describe("WRONG_CASE_BRAND — precision (correct casing, technical lowercase, identifiers, DIM)", () => {
  const GOOD = [
    "miMAR", // canonical casing — must never self-flag
    "mimar.com.ar", // email domain — technical, lowercase
    "logo-mimar-mark.svg", // asset path — technical, lowercase
    "MiMARBadge", // hypothetical identifier — "MiMAR" is a prefix, not a standalone word
    "isMiMARFeature", // hypothetical identifier — no word boundary either side
    "DIM-1234-5678", // internal codename token — unrelated
    "hola mundo",
  ];
  for (const text of GOOD) {
    it(`does NOT match "${text}"`, () => {
      WRONG_CASE_BRAND.lastIndex = 0;
      expect(text).not.toMatch(WRONG_CASE_BRAND);
    });
  }
});

// ---------------------------------------------------------------------------
// findBrandHits — comment-awareness + CRLF safety
// ---------------------------------------------------------------------------

describe("findBrandHits", () => {
  it("flags a wrong-cased literal in real JSX text", () => {
    const src = ["export function Foo() {", "  return <p>Bienvenido a MiMAR</p>;", "}"].join("\n");
    const hits = findBrandHits(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ line: 2, text: "MiMAR" });
  });

  it("does NOT flag a wrong-cased mention inside a // comment", () => {
    const src = ["// legacy note: MiMAR brand header", 'const x = "miMAR";'].join("\n");
    expect(findBrandHits(src)).toHaveLength(0);
  });

  it("does NOT flag a wrong-cased mention inside a {/* ... */} JSX comment, including continuation lines", () => {
    const src = [
      "{/* Mobile dim area — used to say MiMAR here, now",
      "    correctly cased miMAR below. */}",
      'const label = "miMAR";',
    ].join("\n");
    expect(findBrandHits(src)).toHaveLength(0);
  });

  it("flags multiple wrong-cased forms on different lines", () => {
    const src = ['const a = "MiMAR";', 'const b = "Mimar";', 'const c = "MIMAR";'].join("\n");
    const hits = findBrandHits(src);
    expect(hits.map((h) => h.text)).toEqual(["MiMAR", "Mimar", "MIMAR"]);
  });

  it("is CRLF-safe (Windows line endings)", () => {
    const src = ['const a = "MiMAR";', 'const b = "miMAR";'].join("\r\n");
    const hits = findBrandHits(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(1);
  });

  it("never flags the canonical miMAR casing", () => {
    const src = ['export const BRANDING = { appName: "miMAR" };'].join("\n");
    expect(findBrandHits(src)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — INTERNAL_CODENAME: the hyphen is the whole distinction
// ---------------------------------------------------------------------------

describe("INTERNAL_CODENAME — recall (the codename standing alone)", () => {
  const BAD = [
    "Documento generado por DIM — Trazabilidad: DEN-0001", // the actual fiscalía leak
    "Autoridad DIM", // the MPF "GENERADO POR" fallback leak
    "DIM", // bare
    "DIM/1.0", // slash is not a hyphen
    "generado por DIM.", // sentence-final
    "(DIM)", // parenthesised
    // A PRECEDING hyphen does not make it a token — the token format is
    // DIM-prefixed, so the codename is never a suffix. A leading hyphen is how
    // the codename gets used as a compound word, which is precisely the usage
    // this rule is for. (Found by a surviving mutant: the rule originally
    // guarded both sides, and the leading guard was a false-negative hole.)
    "outside-DIM",
    "usuarios no-DIM",
    "Carpeta Final-DIM 2021.docx",
  ];
  for (const text of BAD) {
    it(`flags "${text}"`, () => {
      INTERNAL_CODENAME.lastIndex = 0;
      expect(text).toMatch(INTERNAL_CODENAME);
    });
  }
});

describe("INTERNAL_CODENAME — precision (the token is public by design)", () => {
  const GOOD = [
    "DIM-PAMP-0001", // the flagship pet's public token
    "DIM-XXXX-XXXX", // the token format, as shown in placeholder copy
    "/mis-mascotas/DIM-S001-PLRM", // token in a route
    "DIM-A9PJ-B5T7", // org token
    "See companion storyline DIM-HCN2-0016B.", // token mid-sentence
    "DIM_TOKEN_RE", // identifier — underscore is a word char, no boundary
    "MAX_DIM", // identifier suffix, same reason
    "dimension", // lowercase, unrelated word
    "dim", // lowercase
    "Dimensiones", // capitalised but not the codename
    "miMAR", // the brand itself
    "mimar.com.ar",
  ];
  for (const text of GOOD) {
    it(`does NOT flag "${text}"`, () => {
      INTERNAL_CODENAME.lastIndex = 0;
      expect(text).not.toMatch(INTERNAL_CODENAME);
    });
  }
});

// ---------------------------------------------------------------------------
// findCodenameHits — comment-awareness, pragma scoping, CRLF safety
// ---------------------------------------------------------------------------

describe("findCodenameHits", () => {
  it("flags the fiscalía PDF footer as it actually shipped", () => {
    const src = [
      "page.drawText(`Documento generado por DIM — Trazabilidad: ${code} — mimar.ar`, {",
      "  x: margin,",
      "});",
    ].join("\n");
    const hits = findCodenameHits(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ line: 1, text: "DIM" });
  });

  it("does NOT flag a line that is only handling DIM-XXXX-XXXX tokens", () => {
    const src = [
      'const token = "DIM-PAMP-0001";',
      'if (!/^DIM-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(token)) throw new Error("bad token");',
    ].join("\n");
    expect(findCodenameHits(src)).toHaveLength(0);
  });

  it("does NOT flag the codename inside a // comment — comments never render", () => {
    const src = [
      "// The DIM codename must not surface in operator UI.",
      'const label = "miMAR";',
    ].join("\n");
    expect(findCodenameHits(src)).toHaveLength(0);
  });

  it("does NOT flag the codename inside a {/* ... */} JSX comment block", () => {
    const src = [
      "{/* Historically this said DIM here; the",
      "    brand is miMAR. */}",
      'const label = "miMAR";',
    ].join("\n");
    expect(findCodenameHits(src)).toHaveLength(0);
  });

  it("exempts the line carrying the pragma itself", () => {
    const src = [`return generatePrefixedToken("DIM"); // ${CODENAME_PRAGMA}: token prefix`].join(
      "\n",
    );
    expect(findCodenameHits(src)).toHaveLength(0);
  });

  it("exempts the next line of code when the pragma is in the comment block above", () => {
    const src = [
      `// ${CODENAME_PRAGMA}: the token prefix, at its single point of definition.`,
      "// Every value this returns is hyphenated and public by design.",
      'return generatePrefixedToken("DIM");',
    ].join("\n");
    expect(findCodenameHits(src)).toHaveLength(0);
  });

  it("exempts the next line of code when the pragma is a JSX comment above it", () => {
    const src = [
      `{/* ${CODENAME_PRAGMA}: deliberate institutional disclosure on /acerca. */}`,
      "<strong>DIM — Documento de Identificación para Mascotas</strong>",
    ].join("\n");
    expect(findCodenameHits(src)).toHaveLength(0);
  });

  it("exempts exactly ONE line of code — a pragma cannot silence the lines after it", () => {
    // The failure this fence exists to prevent was a leak nobody could see.
    // An escape hatch with a region scope would recreate it.
    const src = [
      `// ${CODENAME_PRAGMA}: only the first line is justified.`,
      'const prefix = "DIM";',
      'const footer = "Documento generado por DIM";',
    ].join("\n");
    const hits = findCodenameHits(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(3);
  });

  it("does not let a blank line consume the pragma before the code reaches it", () => {
    const src = [`// ${CODENAME_PRAGMA}: justified below.`, "", 'const prefix = "DIM";'].join("\n");
    expect(findCodenameHits(src)).toHaveLength(0);
  });

  it("flags every leak in a file, not just the first", () => {
    const src = [
      'const a = "Documento generado por DIM";',
      'const b = "DIM-PAMP-0001";',
      'const c = "Autoridad DIM";',
    ].join("\n");
    expect(findCodenameHits(src).map((h) => h.line)).toEqual([1, 3]);
  });

  it("is CRLF-safe (Windows line endings)", () => {
    const src = ['const a = "Autoridad DIM";', 'const b = "DIM-PAMP-0001";'].join("\r\n");
    const hits = findCodenameHits(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(1);
  });
});
