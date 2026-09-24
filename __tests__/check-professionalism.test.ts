/**
 * Unit tests for scripts/check-professionalism.ts — the UI professionalism
 * lint fence (emoji ban + symbol-as-icon ratchet).
 *
 * Pure fixture tests (no filesystem I/O): exercise the exported regexes and
 * the classifyLine/findRule2Hits helpers against known-bad and known-good
 * fixture strings, mirroring __tests__/check-ui-invariants.test.ts and
 * __tests__/check-design-tokens.test.ts.
 */

import { describe, expect, it } from "vitest";

import {
  EMOJI_RANGE,
  SYMBOL_ICON_CHAR,
  WHITELIST_CHARS,
  X_STANDALONE,
  classifyLine,
  findRule2Hits,
} from "@/scripts/check-professionalism";

// ---------------------------------------------------------------------------
// Rule 1 — EMOJI_RANGE
// ---------------------------------------------------------------------------

describe("EMOJI_RANGE — recall", () => {
  const BAD = [
    "🎉", // U+1F389 — the LandingHero-adjacent "worst offender" confetti
    "📞", // U+1F4DE — telephone (formerly in LandingHero's HERO_STATES)
    "📍", // U+1F4CD — round pushpin (formerly in LocationFields)
    "🌸", // U+1F338 — cherry blossom (formerly in PregnancyInProgressCard)
    "⚠", // U+26A0 — warning sign (Misc Symbols block)
    "✓", // U+2713 — check mark (Dingbats block)
    "✗", // U+2717 — ballot X (Dingbats block)
    "🇦🇷", // regional indicator pair (flag) — cross-platform rendering risk
  ];
  for (const ch of BAD) {
    it(`matches "${ch}"`, () => {
      EMOJI_RANGE.lastIndex = 0;
      expect(ch).toMatch(EMOJI_RANGE);
    });
  }
});

describe("EMOJI_RANGE — precision (whitelist + geometric-shape glyphs never match)", () => {
  const GOOD = [
    ...WHITELIST_CHARS,
    "×", // U+00D7 multiplication sign — sanctioned, handled separately
    "●", // U+25CF — Geometric Shapes block, governed by Rule 2 only
    "○",
    "▲",
    "◔",
    "◑",
    "◕",
    "⏸",
    "▶",
    "◹",
    "hola mundo",
  ];
  for (const ch of GOOD) {
    it(`does NOT match "${ch}"`, () => {
      EMOJI_RANGE.lastIndex = 0;
      expect(ch).not.toMatch(EMOJI_RANGE);
    });
  }
});

// ---------------------------------------------------------------------------
// Rule 2 — SYMBOL_ICON_CHAR
// ---------------------------------------------------------------------------

describe("SYMBOL_ICON_CHAR — recall (the full banned glyph list)", () => {
  const BAD = [
    "✓",
    "✗",
    "✕",
    "✖",
    "⚠",
    "★",
    "☆",
    "✎",
    "●",
    "○",
    "⏸",
    "▶",
    "◔",
    "◑",
    "◕",
    "▲",
    "◹",
    "♥",
    "♦",
  ];
  for (const ch of BAD) {
    it(`matches "${ch}"`, () => {
      SYMBOL_ICON_CHAR.lastIndex = 0;
      expect(ch).toMatch(SYMBOL_ICON_CHAR);
    });
  }
});

describe("SYMBOL_ICON_CHAR — precision (whitelist + × never match)", () => {
  const GOOD = [...WHITELIST_CHARS, "×", "hola mundo"];
  for (const ch of GOOD) {
    it(`does NOT match "${ch}"`, () => {
      SYMBOL_ICON_CHAR.lastIndex = 0;
      expect(ch).not.toMatch(SYMBOL_ICON_CHAR);
    });
  }
});

// ---------------------------------------------------------------------------
// X_STANDALONE — the "×" close-button anti-pattern (entire node only)
// ---------------------------------------------------------------------------

describe("X_STANDALONE — recall (the fake close-button pattern)", () => {
  const BAD = ["<button>×</button>", "<span>  ×  </span>", '{"×"}', "'×'", "`×`"];
  for (const line of BAD) {
    it(`flags "${line}"`, () => {
      X_STANDALONE.lastIndex = 0;
      expect(line).toMatch(X_STANDALONE);
    });
  }
});

describe("X_STANDALONE — precision (dimensions/formulas are sanctioned typography)", () => {
  const GOOD = ['"44×44px"', '"cobertura × señal"', '"×3 repeticiones"', "el ancho es 44×44"];
  for (const line of GOOD) {
    it(`does NOT flag "${line}"`, () => {
      X_STANDALONE.lastIndex = 0;
      expect(line).not.toMatch(X_STANDALONE);
    });
  }
});

// ---------------------------------------------------------------------------
// classifyLine — comment detection (// , /* */, JSDoc *, {/* */} JSX comments)
// ---------------------------------------------------------------------------

describe("classifyLine — single-line forms", () => {
  it("classifies a // line comment as a comment", () => {
    const { isComment, nextState } = classifyLine("// the ✕ button closes it", { inBlock: false });
    expect(isComment).toBe(true);
    expect(nextState.inBlock).toBe(false);
  });

  it("classifies a JSDoc continuation ( * foo) as a comment", () => {
    const { isComment } = classifyLine('   * Shows "✓ completo" when closed', { inBlock: false });
    expect(isComment).toBe(true);
  });

  it("classifies a single-line /** ... */ JSDoc comment as a comment and closes the block", () => {
    const { isComment, nextState } = classifyLine('/** Shows "✓ completo" */', { inBlock: false });
    expect(isComment).toBe(true);
    expect(nextState.inBlock).toBe(false);
  });

  it("classifies a single-line {/* ... */} JSX comment as a comment and closes the block", () => {
    const { isComment, nextState } = classifyLine('{/* "✓ completo" — only shown when closed */}', {
      inBlock: false,
    });
    expect(isComment).toBe(true);
    expect(nextState.inBlock).toBe(false);
  });

  it("does NOT classify real code as a comment", () => {
    const { isComment } = classifyLine('<span className="lp-hcard-libstamp">FIRMADA</span>', {
      inBlock: false,
    });
    expect(isComment).toBe(false);
  });
});

describe("classifyLine — multi-line block tracking (the InspectorMounter/SituationalMap regression)", () => {
  it("keeps a {/* ... */} block's CONTINUATION line classified as a comment even with no per-line prefix", () => {
    // The exact shape of app/gob/maltrato/_inspector/InspectorMounter.tsx:
    // {/* Mobile dim area (non-interactive) — the ✕ button and Esc close the
    //     overlay; on lg there is no dim and the list stays live. */}
    let state = { inBlock: false };
    const opener = classifyLine(
      "{/* Mobile dim area (non-interactive) — the ✕ button and Esc close the",
      state,
    );
    expect(opener.isComment).toBe(true);
    expect(opener.nextState.inBlock).toBe(true); // not closed on this line
    state = opener.nextState;

    const continuation = classifyLine(
      "    overlay; on lg there is no dim and the list stays live. */}",
      state,
    );
    // No //, /*, or * prefix on this line — only inBlock tracking catches it.
    expect(continuation.isComment).toBe(true);
    expect(continuation.nextState.inBlock).toBe(false); // closes here
  });

  it("resumes flagging real code once the block closes", () => {
    let state = { inBlock: false };
    state = classifyLine("{/* a multi-line", state).nextState;
    state = classifyLine("   comment block */}", state).nextState;
    const afterBlock = classifyLine('<Icon name="close" decorative />', state);
    expect(afterBlock.isComment).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findRule2Hits — the AlertInboxTable regression: comment prose describing
// the escalation-fill metaphor must NOT be counted, only the real literals.
// ---------------------------------------------------------------------------

describe("findRule2Hits — AlertInboxTable-shaped fixture", () => {
  const FIXTURE = [
    "// DELIBERATE GLYPH EXCEPTION (PO-approved 2026-07-14, UI professionalism pass).",
    "// These six escalation marks encode a *quarter-fill progression* — ▲ (fired) →",
    "// ◔ (¼) → ◑ (½) → ◕ (¾) → ● (full/resolved), with ○ (empty) for discarded.",
    "const STATUS_ICON: Record<AlertFiringStatus, string> = {",
    '  disparada: "▲",',
    '  reconocida: "◔",',
    '  en_investigacion: "◑",',
    '  autoridad_contactada: "◕",',
    '  resuelta: "●",',
    '  descartada: "○",',
    "};",
  ].join("\n");

  it("counts exactly the 6 real STATUS_ICON literals, not the comment prose", () => {
    const hits = findRule2Hits(FIXTURE);
    expect(hits).toHaveLength(6);
    expect(hits.map((h) => h.char).sort()).toEqual(["○", "◔", "◑", "◕", "●", "▲"].sort());
  });

  it("every hit lands on one of the literal-value lines (5-10), never the comment lines (1-3)", () => {
    const hits = findRule2Hits(FIXTURE);
    for (const hit of hits) {
      expect(hit.line).toBeGreaterThanOrEqual(5);
      expect(hit.line).toBeLessThanOrEqual(10);
    }
  });
});

describe("findRule2Hits — the × close-button anti-pattern is counted too", () => {
  it("flags a standalone × JSX text node alongside symbol-icon glyphs", () => {
    const src = ["function Close() {", "  return <button>×</button>;", "}"].join("\n");
    const hits = findRule2Hits(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.char).toBe("×");
  });

  it("does NOT flag × inside a dimension string on the same kind of line", () => {
    const src = ['const dims = "44×44px";'].join("\n");
    expect(findRule2Hits(src)).toHaveLength(0);
  });
});
