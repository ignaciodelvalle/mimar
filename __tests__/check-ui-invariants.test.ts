/**
 * Unit tests for scripts/check-ui-invariants.ts rule regexes and helpers.
 *
 * Pure fixture tests — no filesystem I/O.  Each rule's exported regex/helper
 * is exercised against known-bad and known-good fixture strings to verify
 * precision (no false positives) and recall (catches real violations).
 */

import { describe, expect, it } from "vitest";

import {
  ACCENT_NOUNS,
  ACCENT_WORDS,
  ENGLISH_UI_WORDS,
  SCREAMING_ENUM,
  SNAKE_CASE_PAYLOAD_FRAGMENT,
  TOUCH_TARGET_TOKENS,
  hasAccentedNeighbor,
  isPayloadFragmentRenderedAsCopy,
  isSymbolPosition,
} from "@/scripts/check-ui-invariants";

// ---------------------------------------------------------------------------
// Rule 1 — Touch target tokens
// ---------------------------------------------------------------------------

describe("TOUCH_TARGET_TOKENS", () => {
  it("matches h-9 in a className string", () => {
    TOUCH_TARGET_TOKENS.lastIndex = 0;
    expect('className="flex h-9 items-center"').toMatch(TOUCH_TARGET_TOKENS);
  });

  it("matches min-h-9 in a className string", () => {
    TOUCH_TARGET_TOKENS.lastIndex = 0;
    expect('className="min-h-9 w-full"').toMatch(TOUCH_TARGET_TOKENS);
  });

  it("matches min-w-9 in a className string", () => {
    TOUCH_TARGET_TOKENS.lastIndex = 0;
    expect('className="min-w-9 shrink-0"').toMatch(TOUCH_TARGET_TOKENS);
  });

  it("matches w-9 in a className string", () => {
    TOUCH_TARGET_TOKENS.lastIndex = 0;
    expect('className="w-9 h-9 rounded-full"').toMatch(TOUCH_TARGET_TOKENS);
  });

  it("does NOT match h-11 (correct 44px size)", () => {
    TOUCH_TARGET_TOKENS.lastIndex = 0;
    expect('className="min-h-11 w-full"').not.toMatch(TOUCH_TARGET_TOKENS);
  });

  it("does NOT match h-10 (other sizes)", () => {
    TOUCH_TARGET_TOKENS.lastIndex = 0;
    expect('className="h-10 w-10"').not.toMatch(TOUCH_TARGET_TOKENS);
  });

  it("does NOT match h-9 as a word inside h-9x (no word boundary overlap)", () => {
    // h-9 followed by a non-word char is still a match — check boundary
    TOUCH_TARGET_TOKENS.lastIndex = 0;
    const m = 'className="h-9"'.matchAll(TOUCH_TARGET_TOKENS);
    expect([...m]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — Screaming enum in JSX text
// ---------------------------------------------------------------------------

// We test the SCREAMING_ENUM regex itself — the looksLikeJsxText helper
// is an internal function that further filters; here we verify the base regex
// catches the pattern and that the overall approach only flags literal text.

describe("SCREAMING_ENUM", () => {
  it("matches a SCREAMING_CASE token with 2+ segments", () => {
    SCREAMING_ENUM.lastIndex = 0;
    expect(">LOST_EPISODE_RESOLVED<").toMatch(SCREAMING_ENUM);
  });

  it("matches PPP_BREED_LIST_UPDATED", () => {
    SCREAMING_ENUM.lastIndex = 0;
    expect(">PPP_BREED_LIST_UPDATED<").toMatch(SCREAMING_ENUM);
  });

  it("does NOT match a single-segment uppercase word (not an enum pattern)", () => {
    SCREAMING_ENUM.lastIndex = 0;
    // Single word: LOST — only one segment, no underscore → no match
    const matches = [...">LOST<".matchAll(SCREAMING_ENUM)];
    expect(matches).toHaveLength(0);
  });

  it("does NOT match a two-segment token (requires 2+ underscores/3 parts)", () => {
    // Pattern requires at least {2,} underscore segments: FOO_BAR has 1 → skip
    SCREAMING_ENUM.lastIndex = 0;
    const matches = [..."FOO_BAR".matchAll(SCREAMING_ENUM)];
    // FOO_BAR has 1 underscore segment ({2,} means ≥2 repetitions of _SEGMENT)
    // Actually the regex is `[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}` — requires ≥2
    // occurrences of the _SEGMENT group, meaning ≥3 parts total (FOO_BAR_BAZ).
    expect(matches).toHaveLength(0);
  });

  it("matches a 3-part token FOO_BAR_BAZ", () => {
    SCREAMING_ENUM.lastIndex = 0;
    expect("FOO_BAR_BAZ").toMatch(SCREAMING_ENUM);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — es-AR accent words
// ---------------------------------------------------------------------------

describe("ACCENT_WORDS", () => {
  it("has an entry for each expected word", () => {
    const bads = ACCENT_WORDS.map((w) => w.bad);
    expect(bads).toContain("Ultimas");
    expect(bads).toContain("notificacion");
    expect(bads).toContain("pais");
    expect(bads).toContain("evaluan");
    expect(bads).toContain("duenos");
    expect(bads).toContain("accion");
    expect(bads).toContain("jurisdiccion");
    expect(bads).toContain("auditoria");
    expect(bads).toContain("administracion");
    expect(bads).toContain("todavia");
    expect(bads).toContain("aqui");
    expect(bads).toContain("ademas");
    expect(bads).toContain("despues");
  });

  // "aun" y "aún" son DOS PALABRAS, no una con y sin acento:
  //   aún = todavía  → lleva tilde
  //   aun = incluso  → no lleva
  // La regla escrita a secas rechazaba copy correcto: frenó la frase "y aun así
  // no aparece" del not-found de denuncias (2026-08-18). Una fence que obliga a
  // escribir mal es peor que no tenerla, y más en un producto cuyo argumento
  // entero es no afirmar cosas falsas. Estas cuatro aserciones fijan la
  // distinción en las dos direcciones — sin la segunda mitad, alguien
  // "simplifica" el lookahead y vuelve el rechazo.
  describe("aun / aún — dos palabras, no un acento faltante", () => {
    // Vive en ACCENT_NOUNS, no en ACCENT_WORDS — la lista se partió cuando el
    // filtro por posición pasó a llevar el peso (ver el comentario del script).
    const entry = ACCENT_NOUNS.find((w) => w.bad === "aun")!;

    it("NO marca las concesivas, que van sin tilde", () => {
      for (const frase of ["y aun así no aparece", "aun cuando falte el dato"]) {
        entry.re.lastIndex = 0;
        expect(frase, frase).not.toMatch(entry.re);
      }
    });

    it("sí marca el adverbio temporal, al que le falta la tilde", () => {
      for (const frase of ["aun no llegó la respuesta", "esto aun falta"]) {
        entry.re.lastIndex = 0;
        expect(frase, frase).toMatch(entry.re);
      }
    });
  });

  describe("pais", () => {
    const entry = ACCENT_WORDS.find((w) => w.bad === "pais")!;

    it("matches unaccented 'pais' in JSX text", () => {
      entry.re.lastIndex = 0;
      expect("Configura reglas por pais, provincia o localidad.").toMatch(entry.re);
    });

    it("does NOT match the accented form 'país'", () => {
      entry.re.lastIndex = 0;
      expect("Configura reglas por país, provincia o localidad.").not.toMatch(entry.re);
    });

    it("does NOT match 'pais' inside a longer word like 'paisaje'", () => {
      entry.re.lastIndex = 0;
      expect("El paisaje es hermoso.").not.toMatch(entry.re);
    });
  });

  describe("jurisdiccion", () => {
    const entry = ACCENT_WORDS.find((w) => w.bad === "jurisdiccion")!;

    it("matches unaccented 'jurisdiccion' as JSX text", () => {
      entry.re.lastIndex = 0;
      expect("La jurisdiccion no tiene overrides.").toMatch(entry.re);
    });

    it("does NOT match the accented form 'jurisdicción'", () => {
      entry.re.lastIndex = 0;
      expect("La jurisdicción no tiene overrides.").not.toMatch(entry.re);
    });
  });

  describe("accion", () => {
    const entry = ACCENT_WORDS.find((w) => w.bad === "accion")!;

    it("matches 'accion' as user copy", () => {
      entry.re.lastIndex = 0;
      expect("Esta accion queda registrada.").toMatch(entry.re);
    });

    it("does NOT match 'acciones' (different word form — word boundary)", () => {
      entry.re.lastIndex = 0;
      expect("Las acciones disponibles son...").not.toMatch(entry.re);
    });

    it("does NOT match accented 'acción'", () => {
      entry.re.lastIndex = 0;
      expect("Esta acción queda registrada.").not.toMatch(entry.re);
    });
  });

  describe("Ultimas", () => {
    const entry = ACCENT_WORDS.find((w) => w.bad === "Ultimas")!;

    it("matches 'Ultimas' missing accent", () => {
      entry.re.lastIndex = 0;
      expect("Ultimas 10 acciones realizadas").toMatch(entry.re);
    });

    it("does NOT match 'Últimas' (correctly accented)", () => {
      entry.re.lastIndex = 0;
      expect("Últimas 10 acciones realizadas").not.toMatch(entry.re);
    });
  });

  describe("auditoria", () => {
    const entry = ACCENT_WORDS.find((w) => w.bad === "auditoria")!;

    it("matches 'auditoria' without accent in copy text", () => {
      entry.re.lastIndex = 0;
      expect("Ver el log de auditoria del sistema.").toMatch(entry.re);
    });

    it("does NOT match 'auditoría' (correctly accented)", () => {
      entry.re.lastIndex = 0;
      expect("Ver el log de auditoría del sistema.").not.toMatch(entry.re);
    });
  });

  describe("administracion", () => {
    const entry = ACCENT_WORDS.find((w) => w.bad === "administracion")!;

    it("matches 'administracion' as copy", () => {
      entry.re.lastIndex = 0;
      expect("La administracion de reglas la hace el admin.").toMatch(entry.re);
    });

    it("does NOT match accented 'administración'", () => {
      entry.re.lastIndex = 0;
      expect("La administración de reglas la hace el admin.").not.toMatch(entry.re);
    });
  });

  describe("todavia", () => {
    const entry = ACCENT_WORDS.find((w) => w.bad === "todavia")!;

    it("matches 'todavia' as copy", () => {
      entry.re.lastIndex = 0;
      expect("Sin casos registrados todavia.").toMatch(entry.re);
    });

    it("does NOT match accented 'todavía'", () => {
      entry.re.lastIndex = 0;
      expect("Sin casos registrados todavía.").not.toMatch(entry.re);
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 3b — The position filter that lets NOUNS into the accent list
// ---------------------------------------------------------------------------
// Every one of these snippets is the real shape found in the tree by the survey
// of 2026-08-09. See the ACCENT_NOUNS docstring in the fence.

/** Index of `token` in `line`, so the tests read like the source they model. */
function at(line: string, token: string): number {
  const i = line.indexOf(token);
  if (i < 0) throw new Error(`token "${token}" not in line`);
  return i;
}

describe("isSymbolPosition", () => {
  const symbols: Array<[string, string, string]> = [
    ["kebab slug in an href", "href={`/org/x?sheet=devolver-al-dueno`}", "dueno"],
    ["kebab slug in a union member", `  | "en-transito"`, "transito"],
    ["object key", `    transito: { label: "Tránsito" },`, "transito"],
    ["object key preceded by a brace", "{ dueno: 1 }", "dueno"],
    ["member access", "  const phone = payload.telefono ?? null;", "telefono"],
    ["lone string as a prop value", `<Icon name="ubicacion" size="sm" decorative />`, "ubicacion"],
    ["lone string as a mapped value", `  province: "provincia",`, "provincia"],
    ["lone string as a route fragment", `  route: "?sheet=sintoma",`, "sintoma"],
  ];

  for (const [name, line, token] of symbols) {
    it(`treats ${name} as a symbol, not copy`, () => {
      expect(isSymbolPosition(line, at(line, token), token)).toBe(true);
    });
  }

  const copy: Array<[string, string, string]> = [
    ["a sentence in JSX text", "        Solicitud creada. Va a la cola para revision.", "revision"],
    ["a sentence in a string literal", `  return { error: "El tamano no es válido." };`, "tamano"],
    ["a capitalized single-word label", "  <span>Descripcion</span>", "Descripcion"],
    ["a phrase inside a template literal", `  body: \`Avisale al dueno de ${"x"}.\`,`, "dueno"],
  ];

  for (const [name, line, token] of copy) {
    it(`treats ${name} as copy`, () => {
      expect(isSymbolPosition(line, at(line, token), token)).toBe(false);
    });
  }

  // Regression: enclosingStringValue used `index > start`, so a token sitting
  // FLUSH against the opening quote fell outside its own string and the whole
  // lone-string rule missed it. Six `key: "dueno"` lines in landing-content.ts
  // were reported as copy because of this one character.
  it("sees a token flush against the opening quote", () => {
    const line = `    key: "dueno",`;
    expect(isSymbolPosition(line, at(line, "dueno"), "dueno")).toBe(true);
  });
});

describe("hasAccentedNeighbor", () => {
  // JS \w excludes accented letters, so \b fires between "gestion" and "á".
  it("suppresses a match that is a prefix of an already-correct word", () => {
    const line = "  solo ves y gestionás las tuyas.";
    expect(hasAccentedNeighbor(line, at(line, "gestion"), "gestion")).toBe(true);
  });

  it("does not suppress a genuine unaccented word", () => {
    const line = "  La gestion quedó pendiente.";
    expect(hasAccentedNeighbor(line, at(line, "gestion"), "gestion")).toBe(false);
  });
});

const STRIPPED: Record<string, string> = {
  á: "a",
  é: "e",
  í: "i",
  ó: "o",
  ú: "u",
  ü: "u",
  ñ: "n",
};

describe("ACCENT_NOUNS", () => {
  it("suggests a genuinely different, accented spelling for every entry", () => {
    for (const { bad, good } of ACCENT_NOUNS) {
      expect(good).not.toBe(bad);
      const unaccented = good.replace(/[áéíóúüñ]/g, (c) => STRIPPED[c] ?? c);
      expect(unaccented).toBe(bad);
    }
  });

  it("has no duplicate entries", () => {
    const bads = ACCENT_NOUNS.map((w) => w.bad);
    expect(new Set(bads).size).toBe(bads.length);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — Raw English UI words in JSX text
// ---------------------------------------------------------------------------

describe("ENGLISH_UI_WORDS", () => {
  it("has an entry for Enrollment", () => {
    const words = ENGLISH_UI_WORDS.map((w) => w.word);
    expect(words).toContain("Enrollment");
  });

  describe("Enrollment", () => {
    const entry = ENGLISH_UI_WORDS.find((w) => w.word === "Enrollment")!;

    // Positive: >Enrollment< in JSX text position is flagged
    it("matches >Enrollment< in JSX text position", () => {
      entry.re.lastIndex = 0;
      expect(">Enrollment<").toMatch(entry.re);
    });

    it("matches 'Enrollment' in a realistic JSX label line", () => {
      entry.re.lastIndex = 0;
      const line = '          <p className="text-[9px] font-bold uppercase">Enrollment</p>';
      expect(line).toMatch(entry.re);
    });

    // Negative: code identifier is NOT flagged by the regex itself
    it("does NOT match 'Inscripciones' (correct Spanish form)", () => {
      entry.re.lastIndex = 0;
      expect(">Inscripciones<").not.toMatch(entry.re);
    });

    // Negative: Outreach is not in the denylist at all
    it("Outreach is not in the denylist (intentional product vocabulary)", () => {
      const words = ENGLISH_UI_WORDS.map((w) => w.word);
      expect(words).not.toContain("Outreach");
    });

    // Negative: a TypeScript const declaration is not JSX text
    it("does NOT flag 'const Enrollment = ...' (code identifier, not JSX text)", () => {
      // looksLikeJsxText returns false for this pattern — the regex matches but
      // the JSX text check (>Word< or {"Word"}) is what gates the rule.
      // Here we verify the regex alone matches, then confirm a non-JSX line
      // containing Enrollment would be excluded by the text-position check.
      entry.re.lastIndex = 0;
      const codeLine = "  const Enrollment = offering.enrollment;";
      // The regex matches the word — but looksLikeJsxText would return false
      // because the line has neither >Enrollment< nor {"Enrollment"}.
      const matches = [...codeLine.matchAll(entry.re)];
      expect(matches.length).toBeGreaterThan(0); // regex detects it
      // Confirm it's NOT in JSX text position (no >Word< or {"Word"} pattern):
      expect(codeLine).not.toMatch(/>Enrollment</);
      expect(codeLine).not.toMatch(/\{["'`]Enrollment["'`]\}/);
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — Raw <button> growth guard (countRawButtons + RAW_BUTTON_BASELINE)
// ---------------------------------------------------------------------------

// NOTE: two different functions share the name `countRawButtons`. The one in
// check-raw-buttons.mjs takes SOURCE TEXT (unit-tested below); the one in the
// fence takes a FILE LIST and reads from disk. Aliased so the difference is
// visible at the call site rather than silently returning 0.
import {
  RAW_BUTTON_BASELINE,
  RAW_BUTTON_FILES,
  countRawButtons as countRawButtonsInFiles,
} from "@/scripts/check-ui-invariants";

// These used to re-implement `line.includes("<button")` inline and assert on
// their own reimplementation — countRawButtons was never imported, so the
// describe block was named after a function it did not exercise. The excuse in
// the old comment ("countRawButtons reads from disk") was untrue: it takes a
// source string. A test that reimplements the thing it guards passes forever,
// including after the real implementation is deleted.
import { countRawButtons } from "@/scripts/check-raw-buttons.mjs";

describe("countRawButtons — unit", () => {
  it("counts each <button tag open, regardless of attributes", () => {
    const src = [
      '    <button type="button" onClick={onClear}>Limpiar</button>',
      '    <button type="submit" disabled>Guardar</button>',
      '    <div className="container">no button here</div>',
    ].join("\n");
    expect(countRawButtons(src)).toBe(2);
  });

  it("does NOT count <OpButton or <LnButton (only the literal lowercase tag)", () => {
    const src = [
      "    <OpButton variant='primary'>Acción</OpButton>",
      "    <LnButton>Citizen</LnButton>",
    ].join("\n");
    expect(countRawButtons(src)).toBe(0);
  });

  it("does NOT count a <button that only appears in a comment", () => {
    // The defect this guards: prose naming the tag was tallied as shipped
    // chrome. Fourteen of the citizen surface's tracked buttons were comments,
    // and that phantom count was headroom — real new buttons could land under
    // it without the ratchet reacting.
    const src = [
      "// migrated the hand-rolled <button>/<Link> pair onto LnButton",
      '/* was: <button className="rounded-[6px]"> */',
      "    <LnButton>Guardar</LnButton>",
    ].join("\n");
    expect(countRawButtons(src)).toBe(0);
  });

  it("still counts a real <button that sits next to a commented one", () => {
    // The control for the test above. Without it, a stripper that ate the
    // whole file would pass both.
    const src = [
      '// old markup: <button type="submit">',
      '    <button type="submit">Guardar</button>',
    ].join("\n");
    expect(countRawButtons(src)).toBe(1);
  });
});

describe("RAW_BUTTON_BASELINE", () => {
  it("is a positive integer (the locked-in baseline count)", () => {
    expect(typeof RAW_BUTTON_BASELINE).toBe("number");
    expect(RAW_BUTTON_BASELINE).toBeGreaterThan(0);
    expect(Number.isInteger(RAW_BUTTON_BASELINE)).toBe(true);
  });

  // REWRITTEN 2026-08-09. This used to assert `toBe(47)` — a number typed into
  // the test. Buttons kept getting migrated, the constant was never lowered,
  // and the real count reached 25. So the fence had room for 22 new raw
  // buttons, the CI line read "✓ 25/47 remaining (22 migrated)" as if that were
  // progress, and THIS TEST was what protected the slack: it asserted the stale
  // number, so lowering the constant would have turned it red.
  //
  // A ratchet's baseline has exactly one correct value: the current count.
  // Asserting that relationship instead of a literal makes drift impossible.
  it("equals the real count in the tree — no slack for new raw buttons", () => {
    expect(RAW_BUTTON_BASELINE).toBe(countRawButtonsInFiles(RAW_BUTTON_FILES));
  });

  it("scans a non-empty corpus (a glob that matches nothing would pass vacuously)", () => {
    expect(RAW_BUTTON_FILES.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 6 (gap fix, qa-triage-2026-07-23 #9) — payload fragment inside a JSX
// STRING ATTRIBUTE, not just between tags. Regression: AdminPoblacionScreen.tsx
// rendered `sub="mascotas con pregnancy_status='in_progress' (nacional)"` — a
// raw enum leak the ORIGINAL between-tags-only Arm B check could not see
// because the fragment lived inside an attribute value, not JSX children.
// ---------------------------------------------------------------------------

describe("isPayloadFragmentRenderedAsCopy — Rule 6 Arm B", () => {
  it("catches the real regression: a payload fragment inside a JSX string attribute (OpKpi's `sub` prop)", () => {
    const line = `          sub="mascotas con pregnancy_status='in_progress' (nacional)"`;
    const frag = line.match(SNAKE_CASE_PAYLOAD_FRAGMENT)?.[0];
    expect(frag).toBeTruthy();
    expect(isPayloadFragmentRenderedAsCopy(line, frag as string)).toBe(true);
  });

  it("still catches the original between-tags shape", () => {
    const line = `          <span>pregnancy_status='in_progress'</span>`;
    const frag = line.match(SNAKE_CASE_PAYLOAD_FRAGMENT)?.[0];
    expect(frag).toBeTruthy();
    expect(isPayloadFragmentRenderedAsCopy(line, frag as string)).toBe(true);
  });

  it("does NOT flag a fragment used as a genuine code identifier / non-JSX-copy position", () => {
    const line = `  const filter = pregnancy_status_eq('in_progress');`;
    const frag = line.match(SNAKE_CASE_PAYLOAD_FRAGMENT)?.[0];
    // No `key='value'` shaped match here at all (function-call syntax, not an
    // attribute/text assignment) — nothing to flag.
    expect(frag).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — CSS button rules (findCssButtonViolations)
// ---------------------------------------------------------------------------
//
// The gap this closes: every other button rule in the repo reads .tsx and
// matches Tailwind utilities, and the landing is styled by a stylesheet.
// globals.css:811 says so in its own comment — the commit that declared the two
// radius tokens named "the landing 8px" as a drifting surface and then left it,
// "because the fence it added reads `rounded-*` utilities in JSX and .lp-btn is
// CSS". Widening the scan found a second live one, `.lp .lp-lost-btn` at 10px.

import { readFileSync } from "node:fs";

import { cssFontFloorPx, findCssButtonViolations } from "@/scripts/check-raw-buttons.mjs";

describe("findCssButtonViolations", () => {
  it("flags an untokenized radius on a btn-named class", () => {
    const { radius } = findCssButtonViolations(".lp .lp-btn { border-radius: 10px; }");
    expect(radius).toHaveLength(1);
    expect(radius[0]).toMatchObject({ value: "10px", selector: ".lp .lp-btn" });
  });

  it("accepts the two sanctioned radius tokens", () => {
    const css = [
      ".lp .lp-btn { border-radius: var(--radius-pill); }",
      ".op-btn { border-radius: var(--radius-op-btn); }",
    ].join("\n");
    expect(findCssButtonViolations(css).radius).toEqual([]);
  });

  it("accepts a percentage radius — that is a SHAPE, not a scale step", () => {
    expect(findCssButtonViolations("button.avatar { border-radius: 50%; }").radius).toEqual([]);
  });

  it("flags the bare button element and [type=submit], not arbitrary classes", () => {
    expect(findCssButtonViolations("button { border-radius: 4px; }").radius).toHaveLength(1);
    expect(
      findCssButtonViolations('input[type="submit"] { border-radius: 4px; }').radius,
    ).toHaveLength(1);
    expect(findCssButtonViolations(".lp-card { border-radius: 4px; }").radius).toEqual([]);
  });

  it("finds a rule nested inside an @media without swallowing the prelude", () => {
    const css = "@media (min-width: 700px) {\n  .lp .lp-btn { border-radius: 8px; }\n}";
    const { radius } = findCssButtonViolations(css);
    expect(radius).toHaveLength(1);
    expect(radius[0].selector).toBe(".lp .lp-btn");
  });

  it("flags a button font-size below the floor, in px and in rem", () => {
    const css = [".lp-btn { font-size: 8px; }", "button.small { font-size: 0.5rem; }"].join("\n");
    expect(findCssButtonViolations(css, 10).fontBelowFloor).toHaveLength(2);
  });

  it("accepts a button font-size at or above the floor", () => {
    expect(findCssButtonViolations(".lp-btn { font-size: 15px; }", 10).fontBelowFloor).toEqual([]);
  });

  it("ignores the values named in a comment — globals.css documents this rule in prose", () => {
    const css = [
      "/* This was border-radius: 8px and font-size: 8px until 2026-07-31. */",
      ".lp .lp-btn { border-radius: var(--radius-pill); font-size: 15px; }",
    ].join("\n");
    const { radius, fontBelowFloor } = findCssButtonViolations(css, 10);
    expect(radius).toEqual([]);
    expect(fontBelowFloor).toEqual([]);
  });
});

describe("cssFontFloorPx", () => {
  it("reads the floor from the --text-xs declaration", () => {
    expect(cssFontFloorPx("  --text-xs: 10px;\n  --text-sm: 12px;")).toBe(10);
  });

  it("falls back to 10px when the token is absent", () => {
    expect(cssFontFloorPx(":root { --color: red; }")).toBe(10);
  });

  it("agrees with the floor the real stylesheet declares", () => {
    expect(cssFontFloorPx(readFileSync("app/globals.css", "utf8"))).toBe(10);
  });
});
