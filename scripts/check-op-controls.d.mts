// Types for the hand-rolled-op-control ratchet, which is authored as .mjs so
// `node` can run it directly in CI without a TypeScript loader. `allowJs` is
// false in tsconfig, so a test importing it needs this declaration.

/** The full JSX opening tag starting at `start`, or null when it never closes. */
export function readOpeningTag(src: string, start: number): string | null;

/** Count raw `<input>`/`<select>`/`<textarea>` elements in `src` whose className
 *  carries the operator control chrome (`border-ln-op-line`). Checkbox and
 *  radio inputs are exempt — OpCheckbox/LnCheckbox own that shape. */
export function countRawOpControls(src: string): number;
