// The palette, spacing and type this app draws from — READ FROM THE CONTRACT.
//
// WHAT THIS FILE USED TO BE, AND WHY THAT WAS WRONG
// ---------------------------------------------------------------------------
// It used to hold its own hex values, under a header that said they "MIRROR the
// web app's Tailwind greys, they do not import them: the contract package is
// framework-free by fence and a Tailwind config is not a contract." The
// reasoning about the fence was right. The mirroring was not happening: this
// file said #111827 / #e5e7eb / #f7f7f5 — neutral greys — while the web has
// always been #1b2a33 / #e4dfd3 / #fbfaf5, a warm cream document. Not one value
// in common. The old header even predicted its own failure: "When the brand
// palette is settled this file is the one place that changes." The brand
// palette had been settled for months.
//
// `@dim/contract/tokens` is the fix. A Tailwind config still is not a contract —
// but the RESOLVED tokens are, they are framework-free, and
// `pnpm lint:token-parity` proves they still match app/globals.css. So this file
// stops being a second opinion and becomes a NAMING layer: it maps the Libreta
// Nacional token names onto the roles this app talks in.
//
// The mapping is the only thing here. No value is invented, no value is
// adjusted "for mobile". If a colour looks wrong on the phone, it is wrong on
// the web too and the fix belongs in globals.css.

import {
  LN_COLORS,
  LN_LEADING,
  LN_RADII,
  LN_SPACE,
  LN_TRACKING,
  LN_TYPE,
} from "@dim/contract/tokens";

export const COLORS = {
  /** The page ground: warm cream, the credential's paper. */
  canvas: LN_COLORS.paper,
  /** Cards and controls sit on white. */
  surface: LN_COLORS.card,
  /** A cream one step warmer than the canvas — inset strips, quiet chips. */
  stripe: LN_COLORS.stripe,
  /**
   * The canvas's slightly-darker sibling — the quiet neutral ground a notice
   * block or a neutral chip sits on. Lifts off the page without `stripe`'s
   * warmth, which stays the credential card's cream band.
   */
  canvas2: LN_COLORS.paper2,

  /** The warm hairline every card and row wears. */
  border: LN_COLORS.line,
  /** The lighter hairline for dividers INSIDE a card — the web's `line-2`,
   *  which the document chrome's inner frame and section dividers wear. */
  borderSoft: LN_COLORS.line2,
  /** The heavier warm border for controls and outline buttons. */
  borderStrong: LN_COLORS.lineStrong,

  ink: LN_COLORS.ink,
  inkSoft: LN_COLORS.ink2,
  inkMuted: LN_COLORS.mute,
  /** Placeholders and "opcional". Never body copy. */
  inkFaint: LN_COLORS.faint,

  /** Primary actions. The institutional blue. */
  accent: LN_COLORS.azul,
  /** Its pressed state. */
  accentPressed: LN_COLORS.azul700,
  /** The deep navy the credential band's gradient starts from (`azul-900`). */
  bandDeep: LN_COLORS.azul900,
  /** Links and informational accents on tinted ground. */
  celeste: LN_COLORS.celeste,
  /** The celeste hairline — the registration badge's border, the observación
   *  band tint's face border. */
  celeste100: LN_COLORS.celeste100,
  /** The 3px focus ring fill. */
  focusRing: LN_COLORS.celeste050,

  /** Refusals, alerts, "perdida". Never used for anything merely emphatic. */
  danger: LN_COLORS.err,
  dangerSurface: LN_COLORS.errBg,
  dangerBorder: LN_COLORS.errBorder,
  /** The seal red — the required-field asterisk, and destructive confirmations. */
  seal: LN_COLORS.seal,

  /** "We could not read this" — the honest-blank warning, not an error. */
  warnSurface: LN_COLORS.warnBg,
  warnBorder: LN_COLORS.warnBorder,
  warnInk: LN_COLORS.warn,

  okSurface: LN_COLORS.okBg,
  okBorder: LN_COLORS.okBorder,
  okInk: LN_COLORS.ok,

  /** The `prenada` credential band's tint (T4-M6, 2026-09-22). */
  rosa: LN_COLORS.rosa,
  rosaBorder: LN_COLORS.rosaBorder,
  /** The `fallecida` (memorial) credential band's two gradient stops. */
  memorialSepia: LN_COLORS.memorialSepia,
  memorialText: LN_COLORS.memorialText,
  memorialBorder: LN_COLORS.memorialBorder,
} as const;

/**
 * The spacing rhythm, straight from the contract.
 *
 * Re-exported rather than re-declared so the numbers have one home. The web's
 * login page is `p-6` / `space-y-8` / `gap-5` — `xl2` / `xl3` / `xl` here.
 */
export const SPACE = LN_SPACE;

/**
 * Corner radii — and the three rules are not the same rule.
 *
 *   `control` (4px) — form fields and cards, matching `LN_CONTROL_CLASS` and
 *       `LnCard` on the web. Both render `rounded-[var(--radius-sm)]`.
 *   `button` (pill) — every button, matching `components/ui/Button.tsx`. This
 *       is a written PO decision (X2-S2, 2026-07-29) fenced by
 *       scripts/check-raw-buttons.mjs, and the reason is maintenance: 9999px is
 *       scale-invariant, so it stays correct at every button height, which a
 *       fixed px radius does not.
 *   `chip` (2px) — status chips, tighter than a card so a chip inside a row
 *       does not read as a second card.
 *
 * WHY THE BUTTON IS NOT 4px, WHICH IS WHAT THE WEB LOGIN LOOKS LIKE. That
 * screen's CTA is a raw `<button className="rounded-[var(--radius-sm)] …">`,
 * i.e. one of the 307 grandfathered raw buttons `check-raw-buttons.mjs` counts
 * against the citizen baseline — debt queued for migration to `LnButton`, not
 * the decided geometry. Copying it into a greenfield native kit would import
 * the web's debt and then require a second migration here when the web burns
 * its own down. The kit follows the design system's primitives (Field, Card,
 * Button), which is also the only reading under which all three agree.
 *
 * `--radius-input` (10px) is exported by the contract and used by NOTHING, on
 * either side. It is Poncho's form radius; the shipped control has never worn
 * it. Left alone here rather than "corrected" — that is a web decision.
 */
export const RADIUS = {
  control: LN_RADII.sm,
  button: LN_RADII.pill,
  chip: LN_RADII.xs,
  /** The credential card's own corner — the web's `--radius-card` (16px),
   *  worn by the two-faced document sheet and nothing smaller. */
  card: LN_RADII.card,
} as const;

/** Font sizes. The web's named steps, by the same names. */
export const TYPE = LN_TYPE;

/**
 * Line height and letter spacing, PRE-MULTIPLIED at the call site.
 *
 * CSS takes both as ratios; React Native takes both in px. So these stay the
 * ratios the contract declares and every style does the multiplication against
 * its own font size — `lineHeight: TYPE.md * LEADING.md`. Baking px values in
 * here would silently decouple them from the size they belong to.
 */
export const LEADING = LN_LEADING;
export const TRACKING = LN_TRACKING;

/**
 * The letter spacing of a mono uppercase micro-label, as an em fraction.
 *
 * OFF THE SCALE ON BOTH SIDES, which is why it is named here rather than
 * inlined at the three places that need it. `--tracking-wider` is 0.05em; the
 * web's field label, card title and eyebrow all render `tracking-[.1em]` —
 * twice that — and have since the Libreta Nacional handoff. At 10px the
 * difference is half a pixel per character, which is exactly the amount that
 * makes an uppercase mono label read as a label. Snapping it to the token would
 * be matching the wrong thing; leaving it as three hand-typed `0.1`s is how the
 * three drift apart.
 */
export const LABEL_TRACKING_EM = 0.1;

/**
 * The disabled treatment, as ONE value, because the web has one.
 *
 * `LnButton` renders `disabled:opacity-60` over the SAME fill. That is the
 * honest signal — the button is still recognisably itself, just not available —
 * and it is why there is no `COLORS.disabled` any more: the old palette had a
 * grey `#9ca3af` that a disabled primary turned into, which reads as a
 * DIFFERENT button rather than as an unavailable one.
 */
export const DISABLED_OPACITY = 0.6;

/** Pressed feedback. `active:scale-[0.98] active:opacity-90` on the web. */
export const PRESSED_OPACITY = 0.9;

/**
 * The touch-target floor, in px. WCAG 2.5.5.
 *
 * The web applies it to form controls (`min-h-[44px]` in `LN_CONTROL_CLASS`)
 * and file triggers, fenced by `lint:ui`. On a phone it applies to everything
 * tappable, which is why it lives here and not in one component.
 */
export const TOUCH_TARGET = 44;
