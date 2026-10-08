// The END of `/mascotas`, and the rule that keeps it short (inicio-app-rediseno,
// PO 2026-10-07).
//
// WHAT THIS FILE USED TO PIN, AND WHY IT CHANGED. It pinned the nine-button
// footer — its order, and the extra space above "Denunciar maltrato". The PO
// approved deleting that footer: every one of those buttons is a row of the
// header's ☰ menu now (or the bell, for Notificaciones). This friction was
// intended; the file is rewritten around what replaced the footer:
//
//   1. THE HOME ENDS AT "Registrar otra mascota" — in the loaded state, and no
//      destination button follows in ANY of the three states.
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
 * that was pushed. Expanding a fold (CollapsibleModule) draws more controls, so
 * this repeats until a pass finds nothing new.
 */
function pushedRoutesFromEverything(): string[] {
  const pressed = new Set<string>();
  for (let pass = 0; pass < 4; pass += 1) {
    let pressedSomething = false;
    for (const node of controls()) {
      const name = accessibleName(node);
      if (pressed.has(name)) continue;
      pressed.add(name);
      pressedSomething = true;
      fireEvent.press(node);
    }
    if (!pressedSomething) break;
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

  it("ends at 'Registrar otra mascota' — the last control on the screen", async () => {
    mockFetchMyPets.mockResolvedValue(pets(2));
    render(<MisMascotasScreen />);
    await screen.findByText("Mascota 1");

    const names = controls().map(accessibleName);
    expect(names.at(-1)).toBe("Registrar otra mascota");
    for (const label of MENU_LABELS) {
      expect(names).not.toContain(label);
    }
    expect(screen.queryByText("Notificaciones")).toBeNull();
    expect(screen.queryByText("Denunciar maltrato")).toBeNull();
  });

  it("heads the list with 'Tus mascotas' and the count", async () => {
    mockFetchMyPets.mockResolvedValue(pets(2));
    render(<MisMascotasScreen />);
    await screen.findByText("Mascota 1");

    expect(screen.getByText("Tus mascotas")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
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
    expect(screen.queryByText("Tus mascotas")).toBeNull();
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
