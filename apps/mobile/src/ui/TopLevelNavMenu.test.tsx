// The header menu, grouped (inicio-app-rediseno, PO 2026-10-07). See
// `TopLevelNavMenu.tsx`'s own header for the decision.
//
// THIS FILE PINS THE WHOLE MENU ON PURPOSE. The list used to be nine flat rows
// copied from the home's footer; it is now the ONLY door to those destinations,
// in four groups, and moving a row between groups — or adding one — is a design
// decision. So the expected sections are written out here, by hand, and a
// change to `NAV_SECTIONS` that does not also change this file goes red. That
// friction is the point (R5 of the review).
//
// WHAT THIS FILE DOES NOT DO: render `app/_layout.tsx`, which evaluates Sentry
// and the native adapters at module scope. The wiring — that `_layout.tsx`
// hands `HeaderActions` to `headerRight` on both screens — is checked by reading
// the file's source, the technique `__tests__/mobile-screen-titles.test.ts`
// uses for the same file.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import { Dimensions, ScrollView } from "react-native";

const mockPush = jest.fn<(path: string) => void>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

// A MUTABLE GATE, the same shape `useGate()` itself returns.
const mockGate: { current: { allowed: boolean } } = { current: { allowed: true } };
jest.mock("../auth/useGate", () => ({ useGate: () => mockGate.current }));

import { HeaderMenuButton, NAV_DESTINATIONS, NAV_SECTIONS } from "./TopLevelNavMenu";

/** The approved menu (section c of the review), written out by hand. */
const EXPECTED_SECTIONS = [
  {
    title: "Mis mascotas",
    rows: [
      { label: "Transferencias", route: "/transferencias" },
      { label: "Tránsito", route: "/cuenta/transito" },
    ],
  },
  {
    title: "Turnos y casos",
    rows: [
      { label: "Mis turnos", route: "/turnos" },
      { label: "Mis casos", route: "/casos" },
    ],
  },
  {
    title: "Comunidad",
    rows: [
      { label: "Adoptar", route: "/adoptar" },
      { label: "Denuncias", route: "/denuncias" },
    ],
  },
  {
    title: "Cuenta",
    rows: [{ label: "Ajustes", route: "/ajustes" }],
  },
];

const EXPECTED_ROWS = EXPECTED_SECTIONS.flatMap((section) => section.rows);

function openMenu() {
  render(<HeaderMenuButton />);
  fireEvent.press(screen.getByLabelText("Abrir menú de navegación"));
}

describe("NAV_SECTIONS", () => {
  it("is the approved menu: four groups, seven rows, in this order", () => {
    expect(
      NAV_SECTIONS.map((section) => ({
        title: section.title,
        rows: section.destinations.map((d) => ({ label: d.label, route: d.route })),
      })),
    ).toEqual(EXPECTED_SECTIONS);
    expect(NAV_DESTINATIONS).toHaveLength(7);
  });

  it("has one row per route — no destination reachable twice from the menu", () => {
    const routes = NAV_DESTINATIONS.map((d) => d.route);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("does not carry Notificaciones (the bell) nor Registrar (the end of the home)", () => {
    const labels = NAV_DESTINATIONS.map((d) => d.label);
    expect(labels).not.toContain("Notificaciones");
    expect(NAV_DESTINATIONS.map((d) => d.route)).not.toContain("/notificaciones");
    expect(labels.some((label) => /registrar/i.test(label))).toBe(false);
  });

  it("gives every row an icon, and a caption or a hint for a screen reader", () => {
    for (const destination of NAV_DESTINATIONS) {
      expect(destination.icon).toBeDefined();
      expect(destination.caption ?? destination.accessibilityHint).toBeTruthy();
    }
  });
});

describe("HeaderMenuButton", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockGate.current = { allowed: true };
  });

  it("renders a 48dp, Spanish-labelled trigger whose hint no longer enumerates nine rows", () => {
    render(<HeaderMenuButton />);

    const trigger = screen.getByLabelText("Abrir menú de navegación");
    expect(trigger.props.accessibilityRole).toBe("button");
    // The old hint read out the nine footer labels one by one. Pinned so it
    // cannot drift back into a list that no longer matches the menu.
    expect(trigger.props.accessibilityHint).not.toMatch(/Notificaciones/);
    expect(trigger.props.accessibilityHint).toMatch(/cuatro grupos/);

    const flat = ([] as unknown[]).concat(trigger.props.style);
    const sized = flat.find(
      (layer): layer is { minHeight?: number; minWidth?: number } =>
        typeof layer === "object" && layer !== null && "minHeight" in layer,
    );
    expect(sized?.minHeight).toBeGreaterThanOrEqual(48);
    expect(sized?.minWidth).toBeGreaterThanOrEqual(48);
  });

  it("draws the four group titles as headers, in order", () => {
    openMenu();
    const headers = screen.getAllByRole("header").map((node) => node.props.children);
    expect(headers).toEqual(EXPECTED_SECTIONS.map((section) => section.title));
  });

  it("draws every row under its own group, with its caption", () => {
    openMenu();
    for (const section of NAV_SECTIONS) {
      for (const destination of section.destinations) {
        const row = screen.getByRole("button", { name: destination.label });
        expect(row.props.accessibilityHint).toBe(
          destination.caption ?? destination.accessibilityHint,
        );
        if (destination.caption !== undefined) {
          expect(within(row).getByText(destination.caption)).toBeTruthy();
        }
      }
    }
  });

  it("keeps every row its OWN reachable button — the sheet is a container, not one opaque element", () => {
    openMenu();
    const buttons = screen.getAllByRole("button").map((node) => node.props.accessibilityLabel);
    for (const row of EXPECTED_ROWS) {
      expect(buttons).toContain(row.label);
    }
    // Eight rows plus the trigger and the backdrop — the honest count.
    expect(buttons).toHaveLength(EXPECTED_ROWS.length + 2);
  });

  it("caps the sheet at 85% of the window and scrolls past that", () => {
    openMenu();
    const scroll = screen.UNSAFE_getByType(ScrollView);
    const flat = ([] as unknown[]).concat(scroll.props.style);
    const capped = flat.find(
      (layer): layer is { maxHeight: number } =>
        typeof layer === "object" && layer !== null && "maxHeight" in layer,
    );
    expect(capped?.maxHeight).toBeCloseTo(Dimensions.get("window").height * 0.85);
  });

  it("navigates to the pressed destination and closes the sheet", () => {
    openMenu();
    fireEvent.press(screen.getByText("Denuncias"));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/denuncias");
    expect(screen.queryByText("Denuncias")).toBeNull();
    expect(screen.queryByText("Ajustes")).toBeNull();
  });

  it.each(EXPECTED_ROWS)("routes $label to $route", ({ label, route }) => {
    openMenu();
    fireEvent.press(screen.getByRole("button", { name: label }));
    expect(mockPush).toHaveBeenCalledWith(route);
  });

  it("closes without navigating when the backdrop is pressed", () => {
    openMenu();
    fireEvent.press(screen.getByLabelText("Cerrar menú"));

    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByText("Ajustes")).toBeNull();
  });

  it("ignores a second press on the same row during the fade-out (double-tap guard)", () => {
    // MUTATION, APPLIED: drop the `navigatedRef` guard in `selectDestination`.
    // This goes red at 2 calls.
    openMenu();
    const row = screen.getByText("Ajustes");
    fireEvent.press(row);
    fireEvent.press(row);

    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while the session gate refuses (Splash, unverified, signed-out)", () => {
    mockGate.current = { allowed: false };
    render(<HeaderMenuButton />);

    expect(screen.queryByLabelText("Abrir menú de navegación")).toBeNull();
  });
});

describe("the bell + menu are wired on both screens that carry the menu", () => {
  // Source-read, not a render of `_layout.tsx` — see the file header for why.
  const layoutSource = readFileSync(join(__dirname, "..", "..", "app", "_layout.tsx"), "utf8");

  it("imports HeaderActions and nothing of the old header button", () => {
    expect(layoutSource).toMatch(
      /import\s*\{\s*HeaderActions\s*\}\s*from\s*"\.\.\/src\/ui\/HeaderActions"/,
    );
    expect(layoutSource).not.toMatch(/HeaderMenuButton/);
  });

  it.each(["mascotas/index", "mascotas/[publicToken]"])(
    "gives %s a headerRight that renders HeaderActions",
    (routeName) => {
      const escaped = routeName.replace(/[[\]]/g, "\\$&");
      const screenMatch = layoutSource.match(
        new RegExp(`<Stack\\.Screen\\s+name="${escaped}"[\\s\\S]*?/>`),
      );
      expect(screenMatch).not.toBeNull();
      expect(screenMatch?.[0]).toMatch(/headerRight:\s*\(\)\s*=>\s*<HeaderActions\s*\/>/);
    },
  );

  it("titles the denuncias list 'Denuncias', the menu row's own name", () => {
    expect(layoutSource).toMatch(
      /<Stack\.Screen name="denuncias\/index" options=\{\{ title: "Denuncias" \}\} \/>/,
    );
  });
});
