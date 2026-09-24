// Smoke test for <Sheet> (Vaul-based right-drawer).
//
// LIMITATION: Vaul renders its drawer through `Drawer.Portal`, which emits
// NOTHING under `renderToStaticMarkup` (no DOM to portal into). So we cannot
// assert on the rendered markup / token classes here — an empty-string assert
// would be vacuous theater. This is why the original poncho Sheet had no
// component test, only a helpers test.
//
// Token correctness for this component is instead guaranteed by:
//   - the gob-*→ln-* swap being same-hex (verified class-by-class against
//     app/globals.css when VaulSheet was extracted from poncho/Sheet), and
//   - lib/sheet-helpers.test.ts covering getDrawerWidth's size→class output.
//
// What this file still buys us: a crash guard — the component must render
// without throwing in both states, and must emit nothing when closed.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Sheet } from "./VaulSheet";

function render(open: boolean): string {
  return renderToStaticMarkup(
    <Sheet id="docs" title="Documentos" open={open} onClose={() => {}}>
      <p>contenido</p>
    </Sheet>,
  );
}

describe("<Sheet> (VaulSheet)", () => {
  it("renders without throwing when closed, and emits nothing (portal is closed)", () => {
    expect(() => render(false)).not.toThrow();
    expect(render(false)).toBe("");
  });

  it("renders without throwing when open (Vaul portal is client-only)", () => {
    expect(() => render(true)).not.toThrow();
  });
});
