// `NotificationsScreen` — the inbox's render and action tests.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. A FAILED READ IS NOT AN EMPTY INBOX. "Tu bandeja está vacía" over a
//      server outage tells somebody that nobody has reported seeing their lost
//      dog. It must show the failure and a way to retry.
//   2. THE AFFORDANCES ARE THE SERVER'S. `petLinkAvailable: false` on a row that
//      HAS a pet must hide the link — that combination is the whole point of the
//      denylist, and a screen that decided from `pet !== null` would offer a
//      guaranteed dead end. Since pulido-avisos the link lives on the detail, so
//      what is asserted here is what the ROW hands the detail.
//   3. A CTA WITH NO NATIVE ROUTE IS NOT PRESSABLE. Pushing a web path opens the
//      app onto a blank stack, which is the failure mode this whole resolution
//      exists to prevent.
//   4. THE WRITES GO THROUGH THE CONTRACT AND THE LIST RE-READS. A tap that
//      patched local state instead would let the badge and the rows disagree.
//   5. THE ORDER IS THE SHARED RULE'S. Asserted here as "urgent renders above
//      info even though the wire order is the reverse" — the cross-client half
//      lives in `__tests__/notification-ordering-parity.test.ts`.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { FlatList } from "react-native";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * Every focus callback currently mounted, so a test can fire a RE-focus.
 *
 * The same stand-in `TransfersScreen.test.tsx` uses, and for the same reason:
 * the defect (NAV-3) is about a screen that is ALREADY MOUNTED when it regains
 * focus, and a mount-only stand-in can only be re-fired by remounting — which
 * is precisely the case that never had the bug.
 */
const mockFocusCallbacks: Array<() => void> = [];

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useFocusEffect: (callback: () => void) => {
    const { useEffect } = require("react");
    useEffect(() => {
      mockFocusCallbacks.push(callback);
      // A mount IS a first focus, which is what the real hook does too.
      callback();
      return () => {
        const at = mockFocusCallbacks.indexOf(callback);
        if (at >= 0) mockFocusCallbacks.splice(at, 1);
      };
    }, [callback]);
  },
}));

jest.mock("../api/endpoints", () => ({
  fetchMyNotifications: (...args: unknown[]) => mockFetch(...args),
  sendNotificationCommand: (...args: unknown[]) => mockSend(...args),
}));

// The screen now re-reads when the network comes back (B-05, `useReconnect`),
// and the real NetInfo has no native module under jest — it crashes inside its
// own reachability timer, several frames from anything this file is about. The
// stand-in `MisMascotasFooter.test.tsx` already uses.
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { MyNotificationV1, MyNotificationsV1 } from "@dim/contract/api";
import { NotificationsScreen } from "./NotificationsScreen";

function aNotification(over: Partial<MyNotificationV1> = {}): MyNotificationV1 {
  return {
    id: "n-1",
    notificationType: "pet_sighting",
    title: "Avistaje de Pampa",
    body: "Alguien la vio en Palermo.",
    severity: "urgent",
    category: "perdidas",
    createdAt: "2026-08-20T10:00:00.000Z",
    read: false,
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa" },
    petLinkAvailable: true,
    cta: null,
    ...over,
  };
}

function payload(over: Partial<MyNotificationsV1> = {}): MyNotificationsV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T00:00:00.000Z",
    staleAfter: "2026-08-26T00:00:30.000Z",
    notifications: [],
    categories: [],
    unreadCount: 0,
    total: 0,
    truncated: false,
    nextCursor: null,
    ...over,
  };
}

const noop = () => {};

function renderScreen(onOpenRoute = noop as (route: string) => void) {
  return render(<NotificationsScreen onOpenRoute={onOpenRoute} onOpenPets={noop} />);
}

/** Re-focus every mounted screen, the way popping back to it does. */
async function refocus(): Promise<void> {
  await act(async () => {
    for (const callback of [...mockFocusCallbacks]) callback();
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockSend.mockReset();
  mockFocusCallbacks.length = 0;
});

describe("NotificationsScreen — coming back into focus (NAV-3)", () => {
  it("re-reads the inbox on RE-focus, not only on mount", async () => {
    // Every row here leads somewhere that changes the row. Returning from a
    // transfer proposal does not remount this screen, so the inbox kept
    // showing the state from before the decision.
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ total: 1, unreadCount: 1, notifications: [aNotification()] }),
    });
    renderScreen();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    await refocus();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the rows on screen while it re-reads — a refresh, not a skeleton", async () => {
    // `initial` blanks the list. Doing that every time somebody comes back
    // from a detail screen would trade one annoyance for a worse one.
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        total: 1,
        unreadCount: 1,
        notifications: [aNotification({ title: "Avistaje de Pampa" })],
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Avistaje de Pampa")).toBeTruthy());

    let resolveSecond: ((value: unknown) => void) | undefined;
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    );
    await refocus();
    // The second read is in flight and the row is STILL THERE.
    expect(screen.getByText("Avistaje de Pampa")).toBeTruthy();

    await act(async () => {
      resolveSecond?.({
        outcome: "ok",
        payload: payload({
          total: 1,
          unreadCount: 0,
          notifications: [aNotification({ title: "Avistaje de Pampa" })],
        }),
      });
    });
  });
});

describe("NotificationsScreen — reading", () => {
  it("shows the failure and a retry, never an empty inbox", async () => {
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
    expect(screen.queryByText("Sin notificaciones")).toBeNull();
  });

  it("offers a way out of an empty inbox instead of a dead end", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Sin notificaciones")).toBeTruthy());
    expect(screen.getByText("Ver mis mascotas")).toBeTruthy();
  });

  it("renders the shared display order, not the wire order", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        total: 2,
        unreadCount: 2,
        notifications: [
          aNotification({ id: "n-info", severity: "info", title: "Un aviso cualquiera" }),
          aNotification({ id: "n-urgent", severity: "urgent", title: "Avistaje de Pampa" }),
        ],
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Avistaje de Pampa")).toBeTruthy());
    const rendered = screen.getAllByText(/Avistaje de Pampa|Un aviso cualquiera/);
    expect(rendered[0]?.props.children).toBe("Avistaje de Pampa");
  });
});

describe("NotificationsScreen — cursor pagination (D5)", () => {
  it("never shows the retired 'entrá desde la web' copy, even with more pages behind it", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        total: 240,
        truncated: true,
        notifications: [aNotification()],
        nextCursor: "cursor-1",
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Avistaje de Pampa")).toBeTruthy());
    expect(screen.queryByText("La lista está incompleta")).toBeNull();
    expect(screen.queryByText(/entrá desde la web/i)).toBeNull();
  });

  it("appends the next page onto what is on screen, and asks with the right cursor", async () => {
    mockFetch.mockResolvedValueOnce({
      outcome: "ok",
      payload: payload({
        total: 2,
        notifications: [aNotification({ id: "n-1", title: "Primera" })],
        nextCursor: "cursor-1",
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Primera")).toBeTruthy());

    mockFetch.mockResolvedValueOnce({
      outcome: "ok",
      payload: payload({
        total: 2,
        notifications: [aNotification({ id: "n-2", title: "Segunda" })],
        nextCursor: null,
      }),
    });
    const list = screen.UNSAFE_getByType(FlatList);
    fireEvent(list, "endReached");

    await waitFor(() => expect(screen.getByText("Segunda")).toBeTruthy());
    // The first row is STILL there — a growing list, not a swap.
    expect(screen.getByText("Primera")).toBeTruthy();
    expect(mockFetch).toHaveBeenNthCalledWith(2, {}, null, "cursor-1");
  });

  it("does nothing on endReached once nextCursor is null — no page to ask for", async () => {
    mockFetch.mockResolvedValueOnce({
      outcome: "ok",
      payload: payload({ notifications: [aNotification()], nextCursor: null }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Avistaje de Pampa")).toBeTruthy());

    const list = screen.UNSAFE_getByType(FlatList);
    fireEvent(list, "endReached");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

/** Decode the query the row handed `aviso/{id}`. */
function detailParams(route: string): Record<string, string> {
  const [, query = ""] = route.split("?");
  return Object.fromEntries(
    query
      .split("&")
      .filter((pair) => pair.length > 0)
      .map((pair) => {
        const [key = "", value = ""] = pair.split("=");
        return [key, decodeURIComponent(value)];
      }),
  );
}

describe("NotificationsScreen — compact rows (pulido-avisos)", () => {
  it("draws a row as title, body and date, with no buttons of its own", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ total: 1, unreadCount: 1, notifications: [aNotification()] }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Avistaje de Pampa")).toBeTruthy());
    expect(screen.getByText("Alguien la vio en Palermo.")).toBeTruthy();
    // The four per-row actions moved to the detail.
    expect(screen.queryByText("Archivar")).toBeNull();
    expect(screen.queryByText("Marcar como leída")).toBeNull();
    expect(screen.queryByText("Ver Pampa")).toBeNull();
    expect(screen.queryByText("Ver detalle")).toBeNull();
  });

  it("clamps the body to two lines", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ total: 1, notifications: [aNotification()] }),
    });
    renderScreen();
    const body = await screen.findByText("Alguien la vio en Palermo.");
    expect(body.props.numberOfLines).toBe(2);
  });

  it("does not draw the page title twice — the stack header already says it", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ total: 1, unreadCount: 1, notifications: [aNotification()] }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("1 sin leer · 1 en total")).toBeTruthy());
    expect(screen.queryByText("Notificaciones")).toBeNull();
  });
});

describe("NotificationsScreen — tapping a row opens the detail and marks it read", () => {
  it("navigates to aviso/{id} as the inbox's detail and marks the row read", async () => {
    const pushed: string[] = [];
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ total: 1, unreadCount: 1, notifications: [aNotification()] }),
    });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "mark_read", changed: true, unreadCount: 0 },
    });
    renderScreen((route) => pushed.push(route));
    fireEvent.press(await screen.findByText("Avistaje de Pampa"));

    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.startsWith("/aviso/n-1?")).toBe(true);
    expect(detailParams(pushed[0] ?? "").origen).toBe("bandeja");
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend.mock.calls[0]?.[1]).toEqual({
      command: "mark_read",
      notificationIds: ["n-1"],
    });
    // The re-read is what keeps the dot, the summary and the badge agreeing.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it("marks nothing when the row is already read, and still opens it", async () => {
    const pushed: string[] = [];
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ total: 1, notifications: [aNotification({ read: true })] }),
    });
    renderScreen((route) => pushed.push(route));
    fireEvent.press(await screen.findByText("Avistaje de Pampa"));
    expect(pushed).toHaveLength(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("re-reads when it comes back from the detail, so the row reads as read", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ total: 1, unreadCount: 1, notifications: [aNotification()] }),
    });
    mockSend.mockReturnValue(new Promise(() => {}));
    renderScreen();
    fireEvent.press(await screen.findByText("Avistaje de Pampa"));
    await refocus();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("reports a refused mark-read instead of pretending the tap worked", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ total: 1, unreadCount: 1, notifications: [aNotification()] }),
    });
    mockSend.mockResolvedValue({
      outcome: "api-error",
      code: "rate_limited",
      retryAfterSeconds: 30,
    });
    renderScreen();
    fireEvent.press(await screen.findByText("Avistaje de Pampa"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    // No re-read was triggered by a write that did not land.
    await waitFor(() =>
      expect(screen.getByText("Demasiadas consultas. Probá de nuevo en 30 segundos.")).toBeTruthy(),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("NotificationsScreen — what the row hands the detail is the server's", () => {
  it("hands over the pet link only when the server says the destination is alive", async () => {
    // The row HAS a pet. `pet_transfer_accepted` means custody LEFT the reader,
    // so the pet page is a guaranteed dead end and only the denylist knows it.
    const pushed: string[] = [];
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        total: 2,
        notifications: [
          aNotification({ id: "n-alive", title: "Viva" }),
          aNotification({
            id: "n-dead",
            title: "Transferida",
            notificationType: "pet_transfer_accepted",
            petLinkAvailable: false,
            read: true,
          }),
        ],
      }),
    });
    mockSend.mockReturnValue(new Promise(() => {}));
    renderScreen((route) => pushed.push(route));
    fireEvent.press(await screen.findByText("Viva"));
    fireEvent.press(screen.getByText("Transferida"));

    expect(detailParams(pushed[0] ?? "")).toMatchObject({
      mascota: "DIM-PAMP-0001",
      nombre: "Pampa",
    });
    expect(detailParams(pushed[1] ?? "").mascota).toBeUndefined();
    expect(detailParams(pushed[1] ?? "").nombre).toBeUndefined();
  });

  // notificaciones-destinos (2026-10): the CTA never pushes the stored route —
  // it goes through `aviso/{id}`, which asks the server where to go. Still a
  // NATIVE route, still never a web path.
  it("opens aviso/{id}, a native route, never the stored web path", async () => {
    const pushed: string[] = [];
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        total: 1,
        notifications: [
          aNotification({
            read: true,
            cta: { label: "Ver el registro", route: "/mascotas/DIM-PAMP-0001/eventos/ev-1" },
          }),
        ],
      }),
    });
    renderScreen((route) => pushed.push(route));
    fireEvent.press(await screen.findByText("Avistaje de Pampa"));
    expect(pushed[0]?.startsWith("/aviso/n-1?")).toBe(true);
    expect(pushed[0]).not.toContain("eventos");
    expect(detailParams(pushed[0] ?? "").accion).toBe("Ver el registro");
  });

  it("hands over 'Ver detalle' for a row with no CTA, unless the kind is informational", async () => {
    const pushed: string[] = [];
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        total: 2,
        notifications: [
          aNotification({ id: "n-1", cta: null, read: true }),
          aNotification({
            id: "n-2",
            notificationType: "pet_transfer_cancelled",
            title: "Transferencia cancelada",
            cta: null,
            pet: null,
            petLinkAvailable: false,
            read: true,
          }),
        ],
      }),
    });
    renderScreen((route) => pushed.push(route));
    fireEvent.press(await screen.findByText("Avistaje de Pampa"));
    fireEvent.press(screen.getByText("Transferencia cancelada"));
    expect(detailParams(pushed[0] ?? "").accion).toBe("Ver detalle");
    expect(detailParams(pushed[1] ?? "").accion).toBeUndefined();
  });

  it("offers 'marcar todas' only while something is unread", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        total: 1,
        unreadCount: 0,
        notifications: [aNotification({ read: true })],
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Avistaje de Pampa")).toBeTruthy());
    expect(screen.queryByText("Marcar todas como leídas")).toBeNull();
  });
});

describe("NotificationsScreen — the writes", () => {
  it("marks the whole inbox read", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ total: 1, unreadCount: 1, notifications: [aNotification()] }),
    });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "mark_all_read", changed: true, unreadCount: 0 },
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Marcar todas como leídas")).toBeTruthy());
    fireEvent.press(screen.getByText("Marcar todas como leídas"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend.mock.calls[0]?.[1]).toEqual({ command: "mark_all_read" });
  });
});

describe("NotificationsScreen — the tabs", () => {
  it("re-reads with the chosen category and draws only populated tabs", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        total: 3,
        notifications: [aNotification()],
        categories: [
          { category: "perdidas", count: 2 },
          { category: "health", count: 1 },
        ],
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Pérdidas · 2")).toBeTruthy());
    // Six categories exist; only the two with rows are drawn.
    expect(screen.queryByText(/Custodia/)).toBeNull();

    fireEvent.press(screen.getByText("Salud · 1"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls[1]?.[1]).toBe("health");
  });

  it("draws no tab bar at all for an inbox with nothing in any category", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Sin notificaciones")).toBeTruthy());
    expect(screen.queryByText("Todas")).toBeNull();
  });
});

describe("NotificationsScreen — grouping", () => {
  it("collapses a run and expands it on demand", async () => {
    const sighting = (id: string) => aNotification({ id, title: `Avistaje ${id}` });
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        total: 3,
        unreadCount: 3,
        notifications: [sighting("a1"), sighting("a2"), sighting("a3")],
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("+ 2 más del mismo tipo")).toBeTruthy());
    // The two behind the leader are not on screen until asked for.
    expect(screen.queryByText("Avistaje a2")).toBeNull();

    fireEvent.press(screen.getByText("+ 2 más del mismo tipo"));
    expect(screen.getByText("Avistaje a2")).toBeTruthy();
    expect(screen.getByText("Ocultar")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// S-2 / S-2b — WHAT SURVIVES A FAILED RE-READ, AND WHAT SURVIVES A TAB SWITCH
// ---------------------------------------------------------------------------

describe("NotificationsScreen — a failed re-read keeps the inbox (S-2)", () => {
  it("keeps the rows and reports the failure as a banner", async () => {
    // The first read landed and its rows are on screen. A refresh in a dead
    // spot used to replace them with a full-screen error: the inbox the phone
    // was still holding, deleted because the network went away.
    mockFetch.mockResolvedValueOnce({
      outcome: "ok",
      payload: payload({ total: 1, unreadCount: 1, notifications: [aNotification()] }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Avistaje de Pampa")).toBeTruthy());

    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "network" });
    await refocus();

    await waitFor(() => expect(screen.getByText("No pudimos actualizar")).toBeTruthy());
    expect(screen.getByText("Avistaje de Pampa")).toBeTruthy();
    expect(screen.getByText("1 sin leer · 1 en total")).toBeTruthy();
  });

  it("still shows the full error when the FIRST read fails", async () => {
    // The control: with nothing on screen there is nothing to keep, and the
    // error is the only thing this screen can honestly say.
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "network" });
    renderScreen();

    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
    expect(screen.queryByText("No pudimos actualizar")).toBeNull();
  });
});

describe("NotificationsScreen — switching tabs keeps the chrome (S-2b)", () => {
  it("skeletons the list only, with the title and the tabs still mounted", async () => {
    mockFetch.mockResolvedValueOnce({
      outcome: "ok",
      payload: payload({
        total: 1,
        unreadCount: 1,
        notifications: [aNotification()],
        categories: [{ category: "custody", count: 1 }],
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByLabelText("Custodia, 1")).toBeTruthy());

    // The second read never answers, which is the whole window under test: the
    // screen used to blank to a skeleton — title, tab bar and all — for as long
    // as it lasted, having just been tapped in the tab bar it removed.
    mockFetch.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Custodia, 1"));
    });

    expect(screen.getByText("1 sin leer · 1 en total")).toBeTruthy();
    expect(screen.getByLabelText("Custodia, 1")).toBeTruthy();
    expect(screen.getByLabelText("Cargando notificaciones…")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // lote 1b F4 — S-2 AND S-2b TOGETHER SAID SOMETHING NEITHER OF THEM MEANT
  //
  // S-2 keeps the last good payload through a failed re-read; S-2b keeps the
  // chrome through a tab switch. Offline, tapping "Custodia" produced both at
  // once: the Custodia chip active, "lo último que pudimos leer" over the list,
  // and THE WHOLE INBOX still drawn under it. The banner can honestly say the
  // rows may be old. It cannot say they may be about something else.
  // -------------------------------------------------------------------------
  it("does not label the previous tab's rows as this tab's answer", async () => {
    // "Avistaje de Pampa" is a `perdidas` row and the first read is unfiltered,
    // so it is on screen when the Custodia tab is tapped.
    mockFetch.mockResolvedValueOnce({
      outcome: "ok",
      payload: payload({
        total: 1,
        unreadCount: 1,
        notifications: [aNotification()],
        categories: [{ category: "custody", count: 1 }],
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByLabelText("Custodia, 1")).toBeTruthy());
    expect(screen.getByText("Avistaje de Pampa")).toBeTruthy();

    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "network" });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Custodia, 1"));
    });

    // The Custodia read failed and there is no Custodia list to keep. The full
    // error is the honest answer; the `perdidas` row must not survive under it.
    expect(screen.queryByText("Avistaje de Pampa")).toBeNull();
    expect(screen.queryByText("No pudimos actualizar")).toBeNull();
    expect(screen.getByText("Reintentar")).toBeTruthy();
  });

  it("still keeps the rows when the SAME tab fails to re-read", async () => {
    // The control for the tag. Without it the assertion above would pass on a
    // screen that had simply lost S-2 altogether — which is the bug S-2 fixed.
    mockFetch.mockResolvedValueOnce({
      outcome: "ok",
      payload: payload({
        total: 1,
        unreadCount: 1,
        notifications: [aNotification()],
        categories: [{ category: "custody", count: 1 }],
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText("Avistaje de Pampa")).toBeTruthy());

    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "network" });
    await refocus();

    await waitFor(() => expect(screen.getByText("No pudimos actualizar")).toBeTruthy());
    expect(screen.getByText("Avistaje de Pampa")).toBeTruthy();
  });
});

// R11 — an erased row (Ley 25.326 art. 16) says nothing more: no button at all.
describe("NotificationsScreen — an erased row", () => {
  it("hands the detail no open action", async () => {
    const pushed: string[] = [];
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        total: 1,
        notifications: [
          aNotification({
            title: "[eliminado]",
            read: true,
            body: "[contenido eliminado a pedido del titular]",
            cta: null,
            pet: null,
            petLinkAvailable: false,
          }),
        ],
      }),
    });
    renderScreen((route) => pushed.push(route));
    fireEvent.press(await screen.findByText("[eliminado]"));
    expect(detailParams(pushed[0] ?? "").accion).toBeUndefined();
  });
});
