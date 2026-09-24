// `HeaderBackButton` — A-4 (native review): TalkBack announced "Navigate up"
// on the automatic back control app-wide. See the component's own header for
// why no declarative prop fixes this in this build's react-navigation /
// react-native-screens versions, and why this "house header" replaces it.
//
// WHAT THIS FILE DOES NOT DO: render `app/_layout.tsx` — see
// `TopLevelNavMenu.test.tsx`'s own header for why (Sentry, the push adapters
// and the image-picker adapter all evaluate at module scope there). Instead:
//   · `HeaderBackButton` is exercised directly, against the PROPS the fork's
//     `headerLeft` actually hands it (`canGoBack`, `tintColor`) — not a
//     re-derived `navigation.canGoBack()`, per the fresh-review follow-up.
//   · The wiring — that `_layout.tsx` hands this to `headerLeft` app-wide with
//     the header's own props spread through, and that the two screens which
//     hide the back control override it back to `null` — is checked by
//     reading the file's own source, the same technique
//     `TopLevelNavMenu.test.tsx` uses for `headerRight`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

const mockGoBack = jest.fn();

jest.mock("expo-router", () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));

import { HeaderBackButton } from "./HeaderBackButton";

describe("HeaderBackButton", () => {
  it("announces itself as Volver", () => {
    render(<HeaderBackButton canGoBack />);
    expect(screen.getByLabelText("Volver")).toBeOnTheScreen();
  });

  it("goes back on press", () => {
    mockGoBack.mockClear();
    render(<HeaderBackButton canGoBack />);
    fireEvent.press(screen.getByLabelText("Volver"));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the header says there is nowhere to go back to", () => {
    render(<HeaderBackButton canGoBack={false} />);
    expect(screen.queryByLabelText("Volver")).toBeNull();
  });

  it("has a real 48x48 touch target, not one padded out with hitSlop", () => {
    // TalkBack's focus rectangle follows the NODE'S OWN box, not `hitSlop` —
    // the fresh-review finding this replaces `hitSlop={SPACE.sm}` with.
    render(<HeaderBackButton canGoBack />);
    const flattened = StyleSheet.flatten(screen.getByLabelText("Volver").props.style);
    expect(flattened.minWidth).toBe(48);
    expect(flattened.minHeight).toBe(48);
  });

  it("carries a borderless ripple sized to the touch target", () => {
    // The OUTERMOST node carrying our own `accessibilityLabel` — not
    // `getByLabelText(...).props`, which resolves to a host node further down
    // that Pressable's internals render without forwarding `android_ripple`
    // onto it (unlike `style`, asserted above, which it does forward).
    render(<HeaderBackButton canGoBack />);
    const [outermost] = screen.UNSAFE_getAllByProps({ accessibilityLabel: "Volver" });
    expect(outermost.props.android_ripple).toEqual({ borderless: true, radius: 24 });
  });
});

describe("the back button is wired app-wide, and the two locked screens opt back out", () => {
  // Source-read, not a render of `_layout.tsx` — see the file header for why.
  const layoutSource = readFileSync(join(__dirname, "..", "..", "app", "_layout.tsx"), "utf8");

  it("imports HeaderBackButton from this module", () => {
    expect(layoutSource).toMatch(
      /import\s*\{\s*HeaderBackButton\s*\}\s*from\s*"\.\.\/src\/ui\/HeaderBackButton"/,
    );
  });

  it("gives the Stack's screenOptions a headerLeft that spreads the header's own props through", () => {
    expect(layoutSource).toMatch(
      /headerLeft:\s*\(props\)\s*=>\s*<HeaderBackButton\s*\{\.\.\.props\}\s*\/>/,
    );
  });

  it.each(["identidad-pendiente", "mascotas/index"])(
    "overrides %s back to no back control at all",
    (routeName) => {
      const escaped = routeName.replace(/[[\]]/g, "\\$&");
      const screenMatch = layoutSource.match(
        new RegExp(`<Stack\\.Screen\\s+name="${escaped}"[\\s\\S]*?/>`),
      );
      expect(screenMatch).not.toBeNull();
      expect(screenMatch?.[0]).toMatch(/headerLeft:\s*\(\)\s*=>\s*null/);
    },
  );
});
