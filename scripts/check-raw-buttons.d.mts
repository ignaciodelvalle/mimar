// Types for the raw-<button> ratchet, which is authored as .mjs so `node` can
// run it directly in CI without a TypeScript loader. `allowJs` is false in
// tsconfig, so a test importing it needs this declaration.

/** Count literal `<button` tag opens in `src`, ignoring comments. */
export function countRawButtons(src: string): number;

/** Every untokenized radius utility (e.g. `rounded-[6px]`) sitting on a raw
 *  `<button` / `<a` opening tag in `src`, ignoring comments. */
export function findUntokenizedButtonRadii(src: string): string[];

/** One button-context declaration flagged in a stylesheet. */
export type CssButtonViolation = {
  /** 1-indexed line of the rule block in the ORIGINAL file. */
  line: number;
  /** The selector list, whitespace-collapsed. */
  selector: string;
  /** The declared value, as written. */
  value: string;
};

/** The `--text-xs` floor in px, read from a stylesheet source (default 10). */
export function cssFontFloorPx(globalsCss: string): number;

/** Button-context violations in one stylesheet: radii that are not one of the
 *  two sanctioned tokens, and font-sizes below the `--text-xs` floor. */
export function findCssButtonViolations(
  css: string,
  floorPx?: number,
): { radius: CssButtonViolation[]; fontBelowFloor: CssButtonViolation[] };
