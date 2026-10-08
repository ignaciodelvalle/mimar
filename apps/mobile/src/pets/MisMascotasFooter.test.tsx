// The END of `/mascotas`, and the rule that keeps it short (inicio-app-rediseno,
// PO 2026-10-07).
//
// WHAT THIS FILE USED TO PIN, AND WHY IT CHANGED. It pinned the nine-button
// footer — its order, and the extra space above "Denunciar maltrato". The PO
// approved deleting that footer: every one of those buttons is a row of the
// header's ☰ menu now (or the bell, for Notificaciones). This friction was
// intended; the file is rewritten around what replaced the footer:
//
//   1. THE REGISTER ACTION IS "+ Agregar" ON THE "Tus mascotas · N" ROW (PO
//      2026-10-07) — one door, in the header of the list, loaded state only;
//      no destination button follows the list in ANY of the three states.
//   2. ONE DOOR PER FEATURE. No menu destination is also a home button. The only
//      routes the home body may reach that the menu also reaches are the
//      DOCUMENTED CONTEXTUAL SHORTCUTS below, each one drawn only when there is
//      something to show. Pressing EVERYTHING the home draws and collecting
//      where it goes is what makes this falsifiable — a list of labels to avoid
//      would pass any new button with a new label.
//   3. THE EMPTY STATE offers Reclamar ("¿Ya la registró un veterinario o un
//      refugio?").
//   4. THE ONE-TIME NOTICE "Lo que estaba abajo ahora está en el menú ☰" shows
//      until closed, and once closed it stays closed (persisted locally).
//
// Everything is read off the RENDERED tree; nothing reads the source of
// `index.tsx`. It runs under JEST — `apps` is excluded from the Vitest walk.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import type { MyCaseRowV1 } from "@dim/contract/api";

const mockPush = jest.fn<(path: string) => void>();
const mockFetchMyPets = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchMyCases = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  // The screen reads once per mount and once per focus. The real hook needs a
  // navigation container; invoking the callback once on mount is the same
  // number of reads a first focus performs.
  useFocusEffect: (callback: () => void) => {
    const { useEffect } = require("react");
    useEffect(() => {
      callback();
    }, [callback]);
  },
}));

jest.mock("../api/endpoints", () => ({
  fetchMyPets: (...args: unknown[]) => mockFetchMyPets(...args),
  fetchMyCases: (...args: unknown[]) => mockFetchMyCases(...args),
}));

// The list re-reads when the network comes back (B-05, `useReconnect`), and the
// real NetInfo has no native module under jest.
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));

jest.mock("../auth/session-store", () => ({
  sessionPort: {},
  getSessionState: () => ({ phase: "signed-in", user: { id: "owner-1" } }),
}));
jest.mock("../auth/useGate", () => ({ useGate: () => ({ allowed: true }) }));

import MisMascotasScreen from "../../app/mascotas/index";
import { NAV_DESTINATIONS } from "../ui/TopLevelNavMenu";
import { HOME_MENU_NOTICE_DISMISSED_KEY, HOME_MENU_NOTICE_TEXT } from "./MovedToMenuNotice";

/**
 * THE DOCUMENTED CONTEXTUAL SHORTCUTS (the review's "Qué cambia" table, column
 * "Atajo con contexto"). A route here may be reached from the home body AND from
 * the menu, because on the home it carries context the menu row does not:
 */
const CONTEXTUAL_SHORTCUTS: Record<string, string> = {
  // "/reclamar" is no longer a menu row (it lives in the "+ Agregar" sheet and in
  // the empty state's link), so it cannot overlap; kept for the empty-state pair.
  "/reclamar": "the empty state's 'Reclamala con su chip o tatuaje' (0 pets only)",
  "/casos": "'Ver todos mis casos' inside the casos block (only while a caso is open)",
  "/transferencias": "'Esperan tu respuesta' → 'Ver N pedidos más' (only with > 3 pending)",
};

const MENU_ROUTES = new Set(NAV_DESTINATIONS.map((d) => d.route));
const MENU_LABELS = NAV_DESTINATIONS.map((d) => d.label);

function pets(count: number) {
  return {
    outcome: "ok" as const,
    payload: {
      version: 1,
      pets: Array.from({ length: count }, (_, i) => ({
        publicToken: `DIM-TEST-000${i}`,
        name: `Mascota ${i}`,
        species: "dog",
        status: "active",
        photoUrl: null,
      })),
      total: count,
      truncated: false,
    },
  };
}

function cases(open: Partial<MyCaseRowV1>[]) {
  return {
    outcome: "ok" as const,
    payload: {
      payloadVersion: 1,
      issuedAt: "2026-10-07T00:00:00.000Z",
      staleAfter: "2026-10-07T00:01:00.000Z",
      open: open.map((over) => ({
        kind: "case_generic_open",
        title: "Caso CAS-TEST-0001",
        subtitle: "Episodio de custodia",
        severity: "info",
        since: "2026-09-01T12:00:00.000Z",
        route: null,
        petId: null,
        petName: null,
        petPhotoUrl: null,
        needsAction: false,
        dueAt: null,
        ...over,
      })),
      history: { rows: [], hasMore: false },
    },
  };
}

/** Every string rendered inside one node, in tree order. */
function textOf(node: { children: Array<unknown> }): string {
  const parts: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === "string") {
      parts.push(child);
      return;
    }
    if (
      child &&
      typeof child === "object" &&
      Array.isArray((child as { children?: unknown[] }).children)
    ) {
      for (const grand of (child as { children: unknown[] }).children) walk(grand);
    }
  };
  for (const child of node.children) walk(child);
  return parts.join(" ");
}

function accessibleName(node: {
  children: Array<unknown>;
  props?: { accessibilityLabel?: unknown };
}): string {
  const explicit = node.props?.accessibilityLabel;
  return typeof explicit === "string" ? explicit : textOf(node);
}

/** Every pressable control the home body draws: buttons and links. */
function controls() {
  return [...screen.queryAllByRole("button"), ...screen.queryAllByRole("link")];
}

/**
 * Press every control the home draws, one at a time, and return every route
 * that was pushed. The controls are re-read after EVERY press: expanding a fold
 * (CollapsibleModule) or opening the "+ Agregar" sheet draws more of them, and
 * choosing a sheet row closes it, which unmounts its sibling. Dismissals
 * ("Cerrar" on a sheet backdrop) go nowhere and are skipped; a sheet row being
 * chosen re-arms the opener so the OTHER row can be reached.
 */
const SHEET_OPENER = "Agregar una mascota";
const SHEET_ROWS = ["Registrar una mascota nueva", "Reclamar una ya registrada"];

function pushedRoutesFromEverything(): string[] {
  const pressed = new Set<string>();
  for (let step = 0; step < 40; step += 1) {
    const next = controls().find((control) => {
      const name = accessibleName(control);
      return name !== "Cerrar" && !pressed.has(name);
    });
    if (next === undefined) break;
    const name = accessibleName(next);
    pressed.add(name);
    fireEvent.press(next);
    if (SHEET_ROWS.includes(name)) pressed.delete(SHEET_OPENER);
  }
  return mockPush.mock.calls.map(([route]) => route);
}

describe("the end of /mascotas", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    // The notice is not what these tests are about; closed on this install.
    await AsyncStorage.setItem(HOME_MENU_NOTICE_DISMISSED_KEY, "1");
    mockPush.mockClear();
    mockFetchMyPets.mockReset();
    mockFetchMyCases.mockReset();
    mockFetchMyCases.mockResolvedValue(cases([]));
  });

  it("has no register button at the end — the last control is a pet row", async () => {
    mockFetchMyPets.mockResolvedValue(pets(2));
    render(<MisMascotasScreen />);
    await screen.findByText("Mascota 1");

    const names = controls().map(accessibleName);
    expect(names.at(-1)).toMatch(/^Mascota 1/);
    expect(names.filter((name) => name === "Agregar una mascota")).toHaveLength(1);
    expect(names).not.toContain("Registrar otra mascota");
    for (const label of MENU_LABELS) {
      expect(names).not.toContain(label);
    }
    expect(screen.queryByText("Notificaciones")).toBeNull();
    expect(screen.queryByText("Denunciar maltrato")).toBeNull();
  });

  it("heads the list with 'Tus mascotas · N' — the count joins the title", async () => {
    mockFetchMyPets.mockResolvedValue(pets(2));
    render(<MisMascotasScreen />);
    await screen.findByText("Mascota 1");

    expect(screen.getByText("Tus mascotas · 2")).toBeTruthy();
  });

  it("draws the register action in the header row with one or more pets", async () => {
    mockFetchMyPets.mockResolvedValue(pets(1));
    render(<MisMascotasScreen />);
    await screen.findByText("Mascota 0");

    const action = screen.getByRole("button", { name: "Agregar una mascota" });
    expect(action.props.accessibilityLabel).toBe("Agregar una mascota");
    expect(screen.getByText("+ Agregar")).toBeTruthy();
    // Its box is at least a 44dp touch target.
    const style = Array.isArray(action.props.style) ? action.props.style : [action.props.style];
    const flat = Object.assign({}, ...style.flat(Number.POSITIVE_INFINITY).filter(Boolean));
    expect(flat.minHeight).toBeGreaterThanOrEqual(44);
    expect(flat.flexShrink).toBe(0);

    // It opens the sheet; it does not navigate by itself.
    expect(screen.queryByText("Registrar una mascota nueva")).toBeNull();
    fireEvent.press(action);
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByText("Registrar una mascota nueva")).toBeTruthy();
  });

  it("the sheet lists Registrar first, then Reclamar, with their captions", async () => {
    mockFetchMyPets.mockResolvedValue(pets(1));
    render(<MisMascotasScreen />);
    await screen.findByText("Mascota 0");
    fireEvent.press(screen.getByRole("button", { name: "Agregar una mascota" }));

    expect(screen.getByText("Cargala desde cero y obtené su credencial")).toBeTruthy();
    expect(
      screen.getByText("Si un veterinario o refugio ya la cargó: con su chip o tatuaje"),
    ).toBeTruthy();
    const names = screen.getAllByRole("button").map(accessibleName);
    const register = names.indexOf("Registrar una mascota nueva");
    const claim = names.indexOf("Reclamar una ya registrada");
    expect(register).toBeGreaterThanOrEqual(0);
    expect(claim).toBeGreaterThan(register);
  });

  it("'Registrar una mascota nueva' goes to the register route", async () => {
    mockFetchMyPets.mockResolvedValue(pets(1));
    render(<MisMascotasScreen />);
    await screen.findByText("Mascota 0");
    fireEvent.press(screen.getByRole("button", { name: "Agregar una mascota" }));
    fireEvent.press(screen.getByRole("button", { name: "Registrar una mascota nueva" }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/alta");
  });

  it("'Reclamar una ya registrada' goes to the existing Reclamar route", async () => {
    mockFetchMyPets.mockResolvedValue(pets(1));
    render(<MisMascotasScreen />);
    await screen.findByText("Mascota 0");
    fireEvent.press(screen.getByRole("button", { name: "Agregar una mascota" }));
    fireEvent.press(screen.getByRole("button", { name: "Reclamar una ya registrada" }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/reclamar");
  });

  it("Reclamar is not a row of the menu any more", () => {
    expect(MENU_ROUTES.has("/reclamar")).toBe(false);
    expect(MENU_LABELS).not.toContain("Reclamar una mascota");
  });

  it("keeps the big register CTA and no header action with zero pets", async () => {
    mockFetchMyPets.mockResolvedValue(pets(0));
    render(<MisMascotasScreen />);
    await screen.findByText("Registrar una mascota");

    expect(screen.queryByText("+ Agregar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Agregar una mascota" })).toBeNull();
    expect(screen.getByRole("button", { name: "Registrar una mascota" })).toBeTruthy();
  });

  it("draws no destination in the failed state either — the header is the way out", async () => {
    mockFetchMyPets.mockResolvedValue({ outcome: "unreachable", detail: "sin red" });
    render(<MisMascotasScreen />);
    await screen.findByText("No pudimos conectarnos. Revisá tu conexión.");

    const names = controls().map(accessibleName);
    for (const label of MENU_LABELS) {
      expect(names).not.toContain(label);
    }
  });

  it("shows a skeleton, not a bare spinner, on the first read", async () => {
    mockFetchMyPets.mockReturnValue(new Promise(() => undefined));
    render(<MisMascotasScreen />);

    const skeleton = screen.getByLabelText("Buscando tus mascotas…");
    expect(skeleton.props.accessibilityRole).toBe("progressbar");
  });
});

describe("one door per feature", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(HOME_MENU_NOTICE_DISMISSED_KEY, "1");
    mockPush.mockClear();
    mockFetchMyPets.mockReset();
    mockFetchMyCases.mockReset();
  });

  const STATES: Array<[string, number, Partial<MyCaseRowV1>[]]> = [
    ["a loaded list with open casos", 2, [{ needsAction: true }, { needsAction: false }]],
    ["a loaded list with nothing open", 3, []],
    ["the empty state", 0, []],
  ];

  it.each(STATES)(
    "on %s, every menu route the home reaches is a documented shortcut",
    async (_state, petCount, openCases) => {
      mockFetchMyPets.mockResolvedValue(pets(petCount));
      mockFetchMyCases.mockResolvedValue(cases(openCases));
      render(<MisMascotasScreen />);
      await screen.findByText(petCount === 0 ? "Registrar una mascota" : "Mascota 0");

      // No home control is NAMED like a menu row …
      const names = controls().map(accessibleName);
      for (const label of MENU_LABELS) {
        expect(names).not.toContain(label);
      }

      // … and no home control LEADS where a menu row leads, except the shortcuts.
      const overlap = pushedRoutesFromEverything().filter((route) => MENU_ROUTES.has(route));
      for (const route of overlap) {
        expect(Object.keys(CONTEXTUAL_SHORTCUTS)).toContain(route);
      }
    },
  );

  it("non-vacuity: the sweep does reach the shortcuts it allows", async () => {
    mockFetchMyPets.mockResolvedValue(pets(0));
    mockFetchMyCases.mockResolvedValue(cases([{ needsAction: true }]));
    render(<MisMascotasScreen />);
    await screen.findByText("Registrar una mascota");

    const pushed = pushedRoutesFromEverything();
    expect(pushed).toContain("/reclamar");
    expect(pushed).toContain("/casos");
    expect(pushed).toContain("/alta");
  });
});

describe("the empty state", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(HOME_MENU_NOTICE_DISMISSED_KEY, "1");
    mockPush.mockClear();
    mockFetchMyPets.mockReset();
    mockFetchMyPets.mockResolvedValue(pets(0));
    mockFetchMyCases.mockReset();
    mockFetchMyCases.mockResolvedValue(cases([]));
  });

  it("offers Reclamar for an animal a vet or a shelter already registered", async () => {
    render(<MisMascotasScreen />);
    expect(await screen.findByText("¿Ya la registró un veterinario o un refugio?")).toBeTruthy();

    fireEvent.press(screen.getByRole("link", { name: "Reclamala con su chip o tatuaje" }));
    expect(mockPush).toHaveBeenCalledWith("/reclamar");
  });

  it("draws no 'Tus mascotas' eyebrow over an empty list", async () => {
    render(<MisMascotasScreen />);
    await screen.findByText("Registrar una mascota");
    expect(screen.queryByText(/^Tus mascotas/)).toBeNull();
  });
});

describe("the one-time notice 'Lo que estaba abajo ahora está en el menú ☰'", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockPush.mockClear();
    mockFetchMyPets.mockReset();
    mockFetchMyPets.mockResolvedValue(pets(1));
    mockFetchMyCases.mockReset();
    mockFetchMyCases.mockResolvedValue(cases([]));
  });

  it("shows on a fresh install, closes, and is remembered", async () => {
    render(<MisMascotasScreen />);
    expect(await screen.findByText(HOME_MENU_NOTICE_TEXT)).toBeTruthy();

    fireEvent.press(screen.getByRole("link", { name: "Entendido" }));
    expect(screen.queryByText(HOME_MENU_NOTICE_TEXT)).toBeNull();
    await waitFor(async () => {
      expect(await AsyncStorage.getItem(HOME_MENU_NOTICE_DISMISSED_KEY)).toBe("1");
    });
  });

  it("never comes back once closed — a new mount does not draw it", async () => {
    await AsyncStorage.setItem(HOME_MENU_NOTICE_DISMISSED_KEY, "1");
    render(<MisMascotasScreen />);
    await screen.findByText("Mascota 0");
    // Let the storage read settle before asserting its absence.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(HOME_MENU_NOTICE_TEXT)).toBeNull();
  });

  it("is a neutral notice, not an alert", async () => {
    render(<MisMascotasScreen />);
    await screen.findByText(HOME_MENU_NOTICE_TEXT);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still shows, and nothing crashes, when the storage read REJECTS", async () => {
    // The recoverable direction (see `MovedToMenuNotice.tsx`): storage that will
    // not answer means "not dismissed", never a crash of the home and never a
    // notice withheld forever.
    const original = AsyncStorage.getItem.bind(AsyncStorage);
    const getItem = jest
      .spyOn(AsyncStorage, "getItem")
      .mockImplementation((key: string) =>
        key === HOME_MENU_NOTICE_DISMISSED_KEY
          ? Promise.reject(new Error("storage unavailable"))
          : original(key),
      );
    try {
      render(<MisMascotasScreen />);
      expect(await screen.findByText(HOME_MENU_NOTICE_TEXT)).toBeTruthy();
      expect(screen.getByText("Mascota 0")).toBeTruthy();
      expect(getItem).toHaveBeenCalledWith(HOME_MENU_NOTICE_DISMISSED_KEY);
    } finally {
      getItem.mockRestore();
    }
  });
});
