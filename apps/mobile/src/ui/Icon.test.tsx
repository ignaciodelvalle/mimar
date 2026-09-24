// The icon fence — the shared table must resolve, here, against THIS package.
//
// `@dim/contract/icons` maps app icon names onto lucide EXPORT names as
// strings, because the contract is framework-free and cannot import a
// component. Strings resolve nothing by themselves: a typo'd export name, or a
// glyph lucide renamed between versions, would compile everywhere and render
// the HelpCircle fallback in production. So this test closes the loop the
// table cannot: every name in the table resolves to a real component in
// `lucide-react-native`'s exports, and the explicit-import map inside Icon.tsx
// agrees with it glyph for glyph.

import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";

import { PET_PROFILE_ICONS } from "@dim/contract/icons";
import * as lucide from "lucide-react-native";

import { Icon } from "./Icon";

describe("PET_PROFILE_ICONS — every shared name resolves in lucide-react-native", () => {
  const entries = Object.entries(PET_PROFILE_ICONS);

  it("has the profile's whole vocabulary (non-vacuity)", () => {
    // A fence over an empty table proves nothing. The profile renders at
    // least the chrome, the situation set, the identity row and the footer.
    expect(entries.length).toBeGreaterThanOrEqual(19);
  });

  it.each(entries)("%s → %s is a real lucide-react-native export", (_name, exportName) => {
    const glyph = (lucide as Record<string, unknown>)[exportName];
    expect(typeof glyph).toBe("object"); // forwardRef component records
    expect(glyph).not.toBeUndefined();
  });

  it.each(entries)("<Icon name=%p> renders without the unknown-name warning", (name) => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      render(<Icon name={name} />);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("Icon — unknown names degrade the way the web does", () => {
  it("renders the fallback and says so, instead of rendering nothing", () => {
    // `situation.icon` arrives from the server; a newer server may name a
    // glyph this build never heard of. The honest degradation is a visible
    // placeholder plus a development warning — not a blank gap.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const tree = render(<Icon name="glyph-from-the-future" />);
      expect(tree.toJSON()).not.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[Icon] Unknown icon name: "glyph-from-the-future". Rendering fallback.',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
