/**
 * Libreta Nacional design tokens — the values `app/globals.css` declares in its
 * `@theme` block, restated as plain data a React Native app can read.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The web app's identity lives in CSS custom properties. Metro does not run
 * Tailwind, cannot resolve `var(--color-ln-azul)`, and `StyleSheet.create`
 * wants a resolved string. So until B46 the mobile app had its OWN palette —
 * `apps/mobile/src/ui/theme.ts`, whose header said, accurately, that it
 * "MIRRORS the web app's Tailwind greys, it does not import them". It mirrored
 * a DIFFERENT set of greys: neutral `#111827` / `#e5e7eb` / `#f7f7f5` against
 * the web's warm `#1b2a33` / `#e4dfd3` / `#fbfaf5`. Two products, one brand,
 * and nothing in CI could see the gap because there was no shared artifact to
 * compare.
 *
 * This is the B46 slice that closes it: the values move into the contract, both
 * clients read them from one place, and a fence proves this file still agrees
 * with the CSS.
 *
 * THIS IS NOT THE FULL B46. The end state is still a CODEMOD — the CSS
 * generated from this module, so the two cannot be written independently at
 * all. That is a bigger change (it touches the build, and `@theme` carries
 * ~170 tokens with prose attached to most of them, prose that a generator would
 * have to preserve or destroy). What ships here is the repo's established
 * cheaper instrument: a FENCE. `scripts/check-design-token-parity.ts` parses
 * the `@theme` block and asserts every token declared below matches the CSS
 * byte for byte. Drift on either side goes red. The codemod remains the end
 * state; this is what makes the interim honest instead of hopeful.
 *
 * WHAT IS AND IS NOT FENCED
 * ---------------------------------------------------------------------------
 *  - `LN_CSS_TOKENS` — exact string equality against the CSS declaration.
 *  - `LN_CSS_FONT_TOKENS` — CONTAINMENT, not equality. The CSS declarations are
 *    stacks with a next/font injected variable in front
 *    (`var(--a-serif-font, "IBM Plex Serif"), Georgia, serif`); what a native
 *    client needs out of that is the family name, so the fence asserts the CSS
 *    names the family and nothing more.
 *  - `LN_SPACE` below the `sheet` step — NOT fenced, and cannot be: the web's
 *    spacing rhythm is Tailwind's own 4px grid, which `@theme` deliberately
 *    does NOT restate ("decision: NO parallel --space-* scale"). There is no
 *    CSS declaration to compare against. Only `--space-sheet` exists as a token
 *    and only `--space-sheet` is fenced.
 *
 * NO RUNTIME DEPENDENCIES, per the package rule. This module is string and
 * number literals plus one `parseFloat`.
 */

/**
 * The tokens, verbatim as `app/globals.css` writes them.
 *
 * This map is the SINGLE literal for every value in this file — the ergonomic
 * objects below are derived from it by indexing, never by restating. That is
 * what makes the fence sufficient: there is no second copy for it to miss.
 * Keys are the CSS custom-property names so a rename on either side is a red
 * fence rather than a silent no-op.
 */
export const LN_CSS_TOKENS = {
  // ---- Palette ------------------------------------------------------------
  "--color-ln-azul": "#0e5a99",
  "--color-ln-azul-700": "#0a4576",
  "--color-ln-azul-900": "#0a3556",
  "--color-ln-celeste": "#4e97d1",
  "--color-ln-celeste-100": "#dcebf7",
  "--color-ln-celeste-050": "#eff6fc",

  "--color-ln-ink": "#1b2a33",
  "--color-ln-ink-2": "#3c4b55",
  "--color-ln-mute": "#616e77",
  "--color-ln-faint": "#646f78",

  "--color-ln-paper": "#fbfaf5",
  "--color-ln-paper-2": "#f8f7f1",
  "--color-ln-card": "#ffffff",
  "--color-ln-stripe": "#f6f4ed",
  "--color-ln-line": "#e4dfd3",
  "--color-ln-line-2": "#eeeae0",
  "--color-ln-line-strong": "#cfc8b8",

  "--color-ln-seal": "#a23a2c",
  // The hover fills of the filled button variants, siblings of the
  // `--color-ln-azul-700` above. They are here, and not only in globals.css,
  // for the same reason that one is: this map is the half the parity fence
  // compares, and a hover colour that lives on only one side is exactly the
  // divergence `check-design-token-parity.ts` was built after.
  // Why they exist at all: `hover:opacity-90` fades the white label with the
  // fill, so hover LOWERED contrast on the most consequential controls —
  // measured, warn fell to 4.35:1, under the AA floor it had been darkened to
  // clear. See the block beside them in app/globals.css.
  "--color-ln-seal-700": "#7b2c21",
  "--color-ln-ok": "#2b7449",
  "--color-ln-ok-700": "#215837",
  "--color-ln-ok-bg": "#e8f3ec",
  "--color-ln-ok-100": "#c8e2d2",
  "--color-ln-warn": "#96600e",
  "--color-ln-warn-700": "#72490b",
  "--color-ln-warn-025": "#fdf6ea",
  "--color-ln-warn-100": "#f0dcb4",
  "--color-ln-err": "#c0392b",
  "--color-ln-err-bg": "#fcefed",
  "--color-ln-err-100": "#f1c6bf",

  // The pregnancy and memorial band tints (T4-M6, 2026-09-22). Both were
  // already `@theme` tokens in `app/globals.css` — the web's `prenada` and
  // `fallecida` credential bands have used them since the situation-skin work
  // (#42) — they were simply never restated here, so
  // `apps/mobile/src/pets/DocumentChromeNative.tsx` had no value to reach for
  // and fell back to the default navy band for both, with the chip carrying
  // the state as icon + text alone. Only the values that band actually needs
  // (the gradient stops and the face border) cross; the rest of the rosa and
  // memorial scales stay web-only, same as every other tint whose only native
  // consumer is a chip drawn from a semantic role rather than a raw shade.
  "--color-ln-rosa": "#b5497e",
  "--color-ln-rosa-bd": "#f1c8dd",
  "--color-ln-memorial-sepia": "#5d5240",
  "--color-ln-memorial-chip-text": "#6a5a3f",
  "--color-ln-memorial-chip-bd": "#e0d4b8",

  // ---- Radius -------------------------------------------------------------
  "--radius-xs": "2px",
  "--radius-sm": "4px",
  "--radius-md": "6px",
  "--radius-lg": "8px",
  "--radius-input": "10px",
  "--radius-card": "16px",
  "--radius-pill": "9999px",

  // ---- Type scale ---------------------------------------------------------
  "--text-xs": "10px",
  "--text-sm": "12px",
  "--text-md": "14px",
  "--text-base": "16px",
  "--text-lg": "18px",
  "--text-xl": "20px",
  "--text-title": "22px",
  "--text-2xl": "24px",
  "--text-3xl": "28px",
  "--text-4xl": "34px",
  "--text-5xl": "40px",

  // ---- Leading ------------------------------------------------------------
  "--leading-xs": "1.4",
  "--leading-sm": "1.4",
  "--leading-md": "1.45",
  "--leading-base": "1.5",
  "--leading-lg": "1.35",
  "--leading-xl": "1.3",
  "--leading-2xl": "1.2",

  // ---- Tracking -----------------------------------------------------------
  "--tracking-tight": "-0.01em",
  "--tracking-normal": "0em",
  "--tracking-wide": "0.02em",
  "--tracking-wider": "0.05em",

  // ---- Spacing (the one token; see the header) ----------------------------
  "--space-sheet": "18px",
} as const;

/**
 * Font families, fenced by CONTAINMENT (see the header).
 *
 * The VALUE is the family name as a native font stack wants it. The KEY is the
 * CSS custom property whose declaration must name it.
 */
export const LN_CSS_FONT_TOKENS = {
  "--font-ln-serif": "IBM Plex Serif",
  "--font-ln-sans": "IBM Plex Sans",
  "--font-ln-mono": "IBM Plex Mono",
} as const;

/** `"10px"` → `10`. Local, so no dependency is added for four characters. */
function px(declaration: string): number {
  return Number.parseFloat(declaration);
}

/**
 * The Libreta Nacional palette.
 *
 * Names drop the `ln-` prefix — inside `LN_COLORS` it would stutter — but keep
 * the rest of the CSS name so a reader can grep either side.
 */
export const LN_COLORS = {
  /** The institutional blue. The login CTA's fill, and every primary action. */
  azul: LN_CSS_TOKENS["--color-ln-azul"],
  /** Pressed / hover state of `azul`. */
  azul700: LN_CSS_TOKENS["--color-ln-azul-700"],
  azul900: LN_CSS_TOKENS["--color-ln-azul-900"],
  /** Informational accent. Focus borders, links on tinted ground. */
  celeste: LN_CSS_TOKENS["--color-ln-celeste"],
  celeste100: LN_CSS_TOKENS["--color-ln-celeste-100"],
  /** The focus RING fill — 3px of it around a focused control. */
  celeste050: LN_CSS_TOKENS["--color-ln-celeste-050"],

  /** Reading ink. Titles, values, anything the eye lands on first. */
  ink: LN_CSS_TOKENS["--color-ln-ink"],
  /** Secondary ink. Body copy, subtitles. */
  ink2: LN_CSS_TOKENS["--color-ln-ink-2"],
  /** Labels and meta. WCAG AA on paper, card and stripe — see globals.css. */
  mute: LN_CSS_TOKENS["--color-ln-mute"],
  /** Faintest legible step. Placeholders, "opcional". Never body copy. */
  faint: LN_CSS_TOKENS["--color-ln-faint"],

  /** The warm cream page ground. */
  paper: LN_CSS_TOKENS["--color-ln-paper"],
  /** Paper's slightly-darker sibling — quiet neutral ground for a notice
   *  block, a neutral chip or a row hover. Lifts off the page without the
   *  warmth of `stripe`, which stays the credential card's cream band. */
  paper2: LN_CSS_TOKENS["--color-ln-paper-2"],
  /** Card / control fill. */
  card: LN_CSS_TOKENS["--color-ln-card"],
  /** A cream one step warmer than paper — inset strips, chip fills. */
  stripe: LN_CSS_TOKENS["--color-ln-stripe"],
  /** The warm hairline. Card and row borders. */
  line: LN_CSS_TOKENS["--color-ln-line"],
  /** A lighter hairline for dividers inside a card. */
  line2: LN_CSS_TOKENS["--color-ln-line-2"],
  /** The strong warm border — form controls and outline buttons wear this. */
  lineStrong: LN_CSS_TOKENS["--color-ln-line-strong"],

  /** The seal red. The required-field asterisk, and destructive surfaces. */
  seal: LN_CSS_TOKENS["--color-ln-seal"],
  ok: LN_CSS_TOKENS["--color-ln-ok"],
  okBg: LN_CSS_TOKENS["--color-ln-ok-bg"],
  okBorder: LN_CSS_TOKENS["--color-ln-ok-100"],
  warn: LN_CSS_TOKENS["--color-ln-warn"],
  warnBg: LN_CSS_TOKENS["--color-ln-warn-025"],
  warnBorder: LN_CSS_TOKENS["--color-ln-warn-100"],
  /** Errors and refusals. */
  err: LN_CSS_TOKENS["--color-ln-err"],
  errBg: LN_CSS_TOKENS["--color-ln-err-bg"],
  errBorder: LN_CSS_TOKENS["--color-ln-err-100"],

  /** The `prenada` credential band's gradient — both stops, one flat tint. */
  rosa: LN_CSS_TOKENS["--color-ln-rosa"],
  /** The `prenada` face's border. */
  rosaBorder: LN_CSS_TOKENS["--color-ln-rosa-bd"],
  /** The `fallecida` credential band's gradient START — the darker of its two
   *  sepia stops. */
  memorialSepia: LN_CSS_TOKENS["--color-ln-memorial-sepia"],
  /** The `fallecida` band's gradient END. */
  memorialText: LN_CSS_TOKENS["--color-ln-memorial-chip-text"],
  /** The `fallecida` face's border. */
  memorialBorder: LN_CSS_TOKENS["--color-ln-memorial-chip-bd"],
} as const;

/**
 * Corner radii, in px.
 *
 * A NOTE THE MOBILE KIT DEPENDS ON. `input` (10px) is the Poncho form radius
 * the token table names, and it is NOT what the shipped web control wears:
 * `LN_CONTROL_CLASS` in components/ui/Field.tsx renders
 * `rounded-[var(--radius-sm)]`, i.e. 4px, and so does the login CTA. Both
 * values are exported here because both are really in the CSS; a client
 * matching the LOOK of the web login should reach for `sm`, and the repo's
 * spec-conflict rule ("validated code beats design-handoff tables") is why.
 */
export const LN_RADII = {
  xs: px(LN_CSS_TOKENS["--radius-xs"]),
  /** What form controls and the primary CTA actually render at. */
  sm: px(LN_CSS_TOKENS["--radius-sm"]),
  md: px(LN_CSS_TOKENS["--radius-md"]),
  lg: px(LN_CSS_TOKENS["--radius-lg"]),
  /** The Poncho forms radius. See the note above before using it. */
  input: px(LN_CSS_TOKENS["--radius-input"]),
  card: px(LN_CSS_TOKENS["--radius-card"]),
  pill: px(LN_CSS_TOKENS["--radius-pill"]),
} as const;

/** Font sizes, in px. `title` and the display steps are semantic, not numeric. */
export const LN_TYPE = {
  xs: px(LN_CSS_TOKENS["--text-xs"]),
  sm: px(LN_CSS_TOKENS["--text-sm"]),
  md: px(LN_CSS_TOKENS["--text-md"]),
  base: px(LN_CSS_TOKENS["--text-base"]),
  lg: px(LN_CSS_TOKENS["--text-lg"]),
  xl: px(LN_CSS_TOKENS["--text-xl"]),
  title: px(LN_CSS_TOKENS["--text-title"]),
  xl2: px(LN_CSS_TOKENS["--text-2xl"]),
  /** The dominant display size — what the web login's `<h1>` renders at. */
  xl3: px(LN_CSS_TOKENS["--text-3xl"]),
  xl4: px(LN_CSS_TOKENS["--text-4xl"]),
  xl5: px(LN_CSS_TOKENS["--text-5xl"]),
} as const;

/**
 * Line-height MULTIPLIERS, paired with the `LN_TYPE` steps.
 *
 * CSS takes them unitless; React Native's `lineHeight` is in px, so a native
 * caller multiplies: `lineHeight: LN_TYPE.md * LN_LEADING.md`.
 */
export const LN_LEADING = {
  xs: px(LN_CSS_TOKENS["--leading-xs"]),
  sm: px(LN_CSS_TOKENS["--leading-sm"]),
  md: px(LN_CSS_TOKENS["--leading-md"]),
  base: px(LN_CSS_TOKENS["--leading-base"]),
  lg: px(LN_CSS_TOKENS["--leading-lg"]),
  xl: px(LN_CSS_TOKENS["--leading-xl"]),
  xl2: px(LN_CSS_TOKENS["--leading-2xl"]),
} as const;

/**
 * Letter-spacing, as the EM fraction the CSS declares.
 *
 * Same unit problem as leading, same answer: React Native's `letterSpacing` is
 * in px, so a native caller multiplies by the font size —
 * `letterSpacing: LN_TYPE.sm * LN_TRACKING.wider`.
 */
export const LN_TRACKING = {
  tight: px(LN_CSS_TOKENS["--tracking-tight"]),
  normal: px(LN_CSS_TOKENS["--tracking-normal"]),
  wide: px(LN_CSS_TOKENS["--tracking-wide"]),
  wider: px(LN_CSS_TOKENS["--tracking-wider"]),
} as const;

/**
 * The spacing rhythm, in px.
 *
 * Only `sheet` is a CSS token and only `sheet` is fenced (see the header). The
 * rest is Tailwind's default 4px grid restated for a client that has no
 * Tailwind — the web's `p-6` / `gap-5` / `space-y-8` are 24 / 20 / 32, and a
 * native screen that wants the same rhythm needs the numbers, not the classes.
 * Adding a `--space-*` scale to `@theme` to fence these would undo a decision
 * globals.css states explicitly; restating the grid here is the smaller lie,
 * and this paragraph is what keeps it from being a silent one.
 */
export const LN_SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  /** `p-6` — the login page's own page gutter. */
  xl2: 24,
  /** `space-y-8` — the gap between the heading block and the form. */
  xl3: 32,
  /** `--space-sheet`, the one fenced step. LnSheet's gutter. */
  sheet: px(LN_CSS_TOKENS["--space-sheet"]),
} as const;

/**
 * Font family NAMES, not stacks.
 *
 * A native client registers a font under a key and asks for it by that key; a
 * fallback stack is a web concept with no equivalent in `StyleSheet`. What
 * crosses the boundary is therefore the family, and the client owns how it
 * loads and names the faces (see `apps/mobile/src/ui/fonts.ts`).
 */
export const LN_FONT_FAMILY = {
  /** Display. Titles and pet names. */
  serif: LN_CSS_FONT_TOKENS["--font-ln-serif"],
  /** Body. Everything that is read rather than looked at. */
  sans: LN_CSS_FONT_TOKENS["--font-ln-sans"],
  /** Field labels, codes, hints. Uppercase and letterspaced by convention. */
  mono: LN_CSS_FONT_TOKENS["--font-ln-mono"],
} as const;

/**
 * The weights a NATIVE client ships, per family. A strict subset of the web's.
 *
 * `app/layout.tsx` loads more — sans and mono at 400/500/600/700, serif at
 * 500/600/700 — and that asymmetry is the point rather than an oversight. The
 * web pays for a face once and serves it to everyone; a phone pays per install,
 * per face, in bytes the user downloads before the app opens. So this names the
 * six faces the mobile kit actually renders:
 *
 *   serif 600  — the display step. Every title on every screen.
 *   sans  400  — body copy.
 *   sans  500  — the primary CTA's label (`font-medium` on the web).
 *   sans  600  — emphasis inside body: row values, pet names, chip labels.
 *   mono  400  — hints, codes, the public token.
 *   mono  600  — the uppercase letterspaced field label.
 *
 * Serif 700 is deliberately ABSENT: the web login's `<h1>` is `font-semibold`,
 * so 600 is the display weight this design actually uses, and a second serif
 * face would be ~40KB bought for nothing.
 *
 * NOT fenced against `layout.tsx`, and cannot usefully be: the web's set is a
 * superset by design, so an equality check would fail the moment either side
 * legitimately grew. `__tests__/font-weight-contract.test.ts` holds the web end.
 * `apps/mobile/src/ui/fonts.test.ts` holds this one — it asserts the app
 * registers exactly these faces, so adding one here without loading it (or
 * loading one without declaring it) is red.
 */
export const LN_FONT_WEIGHTS = {
  serif: [600],
  sans: [400, 500, 600],
  mono: [400, 600],
} as const;
