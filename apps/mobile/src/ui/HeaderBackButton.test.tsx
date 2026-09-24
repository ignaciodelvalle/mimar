// `HeaderBackButton` — A-4 (native review): TalkBack announced "Navigate up"
// on the automatic back control app-wide. See the component's own header for
// why no declarative prop fixes this in this build's react-navigation /
// react-native-screens versions, and why this "house header" replaces it.
//
// WHAT THIS FILE DOES NOT DO: render `app/_layout.tsx` — see
// `TopLevelNavMenu.test.tsx`'s own header for why (Sentry, the push adapters
// and the image-picker adapter all evaluate at module scope there). Instead:
//   · `HeaderBackButton` is exercised directly, against a mocked navigation
//     object.
//   · The wiring — that `_layout.tsx` hands this to `headerLeft` app-wide, and
//     that the two screens which hide the back control override it back to
//     `null` — is checked by reading the file's own source, the same
//     technique `TopLevelNavMenu.test.tsx` uses for `headerRight`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

const mockGoBack = jest.fn();
const mockCanGoBack: { current: boolean } = { current: true };

jest.mock("expo-router", () => ({
  useNavigation: () => ({
    canGoBack: () => mockCanGoBack.current,
    goBack: mockGoBack,
  }),
}));

import { HeaderBackButton } from "./HeaderBackButton";

describe("HeaderBackButton", () => {
  it("announces itself as Volver, not the platform default", () => {
    mockCanGoBack.current = true;
    render(<HeaderBackButton />);
    expect(screen.getByLabelText("Volver")).toBeOnTheScreen();
    // The whole point: TalkBack's own "Navigate up" is gone.
    expect(screen.queryByLabelText("Navigate up")).toBeNull();
  });

  it("goes back on press", () => {
    mockCanGoBack.current = true;
    mockGoBack.mockClear();
    render(<HeaderBackButton />);
    fireEvent.press(screen.getByLabelText("Volver"));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when there is nowhere to go back to, same as the control it replaces", () => {
    mockCanGoBack.current = false;
    render(<HeaderBackButton />);
    expect(screen.queryByLabelText("Volver")).toBeNull();
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

  it("gives the Stack's screenOptions a headerLeft that renders it", () => {
    expect(layoutSource).toMatch(/headerLeft:\s*\(\)\s*=>\s*<HeaderBackButton\s*\/>/);
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
