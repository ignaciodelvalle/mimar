// The header menu — U-1 (M2, Samsung J7 2016 / Android 8). See
// `TopLevelNavMenu.tsx`'s own header for the finding and the decision.
//
// WHAT THIS FILE DOES NOT DO: render `app/_layout.tsx`. That file evaluates
// Sentry, the push adapters and the image-picker adapter at MODULE SCOPE
// specifically because each one "throws in a process that has none" (see its
// own comments) — no test in this app imports it, and this one does not
// either. Instead:
//   · `HeaderMenuButton` is exercised directly, the same way every other
//     component test in this app exercises a component that is not a route.
//   · The wiring itself — that `_layout.tsx` actually hands this component to
//     `headerRight` for both screens — is checked by reading the file's
//     source, the same technique `__tests__/mobile-screen-titles.test.ts`
//     already uses at the root for this exact file's registrations.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

const mockPush = jest.fn<(path: string) => void>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

// A MUTABLE GATE, the same shape `useGate()` itself returns. Tests default it
// to `allowed: true` in `beforeEach` and flip it to exercise the "hidden while
// the gate refuses" case — see `HeaderMenuButton`'s own comment for why it
// reads this hook at all.
const mockGate: { current: { allowed: boolean } } = { current: { allowed: true } };
jest.mock("../auth/useGate", () => ({ useGate: () => mockGate.current }));

import { HeaderMenuButton, TOP_LEVEL_DESTINATIONS } from "./TopLevelNavMenu";

/**
 * THE SAME NINE `app/mascotas/index.tsx`'s footer renders, in its own
 * order — copied here (not imported from that screen) so a change to EITHER
 * side has to pass through a human reading both, the same non-vacuity
 * argument `MisMascotasFooter.test.tsx` makes for its own `FOOTER_LABELS`.
 */
const EXPECTED_DESTINATIONS = [
  { label: "Transferencias", route: "/transferencias" },
  { label: "Tránsito", route: "/cuenta/transito" },
  { label: "Notificaciones", route: "/notificaciones" },
  { label: "Mis turnos", route: "/turnos" },
  { label: "Reclamar una mascota", route: "/reclamar" },
  { label: "Adoptar", route: "/adoptar" },
  { label: "Mis denuncias", route: "/denuncias" },
  { label: "Denunciar maltrato", route: "/denunciar" },
  { label: "Ajustes", route: "/ajustes" },
];

describe("TOP_LEVEL_DESTINATIONS", () => {
  it("is the footer's own nine destinations, in the footer's own order (non-vacuity)", () => {
    expect(TOP_LEVEL_DESTINATIONS.map((d) => ({ label: d.label, route: d.route }))).toEqual(
      EXPECTED_DESTINATIONS,
    );
  });
});

describe("HeaderMenuButton", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockGate.current = { allowed: true };
  });

  it("renders a 48dp, Spanish-labelled trigger", () => {
    render(<HeaderMenuButton />);

    const trigger = screen.getByLabelText("Abrir menú de navegación");
    expect(trigger.props.accessibilityRole).toBe("button");

    const flat = ([] as unknown[]).concat(trigger.props.style);
    const sized = flat.find(
      (layer): layer is { minHeight?: number; minWidth?: number } =>
        typeof layer === "object" && layer !== null && "minHeight" in layer,
    );
    expect(sized?.minHeight).toBeGreaterThanOrEqual(48);
    expect(sized?.minWidth).toBeGreaterThanOrEqual(48);
  });

  it("lists every top-level destination once opened", () => {
    render(<HeaderMenuButton />);

    fireEvent.press(screen.getByLabelText("Abrir menú de navegación"));

    for (const destination of EXPECTED_DESTINATIONS) {
      expect(screen.getByText(destination.label)).toBeTruthy();
    }
  });

  it("keeps every row its OWN reachable button — the sheet is a container, not one opaque element", () => {
    // THE ACCESSIBILITY FIX THIS PINS: the sheet used to be a `Pressable`
    // wrapping every row, which VoiceOver reads as a single element — a
    // screen-reader user landed on one unlabelled node instead of eight
    // named buttons. `accessible={false}` on the sheet's container makes it
    // transparent to the accessibility tree again, and `getAllByRole` is
    // what proves each row still resolves on its own rather than only the
    // container answering to the role.
    render(<HeaderMenuButton />);
    fireEvent.press(screen.getByLabelText("Abrir menú de navegación"));

    const buttons = screen.getAllByRole("button").map((node) => node.props.accessibilityLabel);
    for (const destination of EXPECTED_DESTINATIONS) {
      expect(buttons).toContain(destination.label);
    }
    // The trigger and the backdrop are buttons too, but not sheet ROWS —
    // nine rows plus those two is the honest count, not "at least nine".
    expect(buttons).toHaveLength(EXPECTED_DESTINATIONS.length + 2);
  });

  it("navigates to the pressed destination and closes the sheet", () => {
    render(<HeaderMenuButton />);

    fireEvent.press(screen.getByLabelText("Abrir menú de navegación"));
    fireEvent.press(screen.getByText("Denunciar maltrato"));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/denunciar");
    // The sheet closed: the row is gone, and so is every other one — proof
    // this is the SHEET closing rather than that one row disappearing.
    expect(screen.queryByText("Denunciar maltrato")).toBeNull();
    expect(screen.queryByText("Ajustes")).toBeNull();
  });

  it("closes without navigating when the backdrop is pressed", () => {
    render(<HeaderMenuButton />);

    fireEvent.press(screen.getByLabelText("Abrir menú de navegación"));
    fireEvent.press(screen.getByLabelText("Cerrar menú"));

    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByText("Ajustes")).toBeNull();
  });

  it("ignores a second press on the same row during the fade-out (double-tap guard)", () => {
    // THE BUG: RN's `Modal` does not unmount its content the instant `visible`
    // goes false — the fade-out plays first — so a row pressed twice in quick
    // succession could call `router.push` with the same route twice. Both
    // presses land on the SAME captured `onPress` closure here (the row is
    // never re-queried between them), which is exactly the shape a rushed
    // double-tap takes.
    //
    // MUTATION, APPLIED: drop the `navigatedRef` guard in `selectDestination`.
    // This goes red at 2 calls.
    render(<HeaderMenuButton />);
    fireEvent.press(screen.getByLabelText("Abrir menú de navegación"));

    const row = screen.getByText("Ajustes");
    fireEvent.press(row);
    fireEvent.press(row);

    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while the session gate refuses (Splash, unverified, signed-out)", () => {
    // `headerRight` mounts before the SCREEN's own `useGate()` has decided
    // whether to draw the real page — see the component's own comment. A
    // hamburger over Splash or `UnverifiedScreen` would offer eight
    // destinations from a session that may not reach any of them.
    mockGate.current = { allowed: false };
    render(<HeaderMenuButton />);

    expect(screen.queryByLabelText("Abrir menú de navegación")).toBeNull();
  });
});

describe("the header menu is wired on both screens the footer used to be the only way out of", () => {
  // Source-read, not a render of `_layout.tsx` — see the file header for why.
  const layoutSource = readFileSync(join(__dirname, "..", "..", "app", "_layout.tsx"), "utf8");

  it("imports HeaderMenuButton from this module", () => {
    expect(layoutSource).toMatch(
      /import\s*\{\s*HeaderMenuButton\s*\}\s*from\s*"\.\.\/src\/ui\/TopLevelNavMenu"/,
    );
  });

  it.each(["mascotas/index", "mascotas/[publicToken]"])(
    "gives %s a headerRight that renders HeaderMenuButton",
    (routeName) => {
      const escaped = routeName.replace(/[[\]]/g, "\\$&");
      const screenMatch = layoutSource.match(
        new RegExp(`<Stack\\.Screen\\s+name="${escaped}"[\\s\\S]*?/>`),
      );
      expect(screenMatch).not.toBeNull();
      expect(screenMatch?.[0]).toMatch(/headerRight:\s*\(\)\s*=>\s*<HeaderMenuButton\s*\/>/);
    },
  );
});
