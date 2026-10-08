// The header bell (inicio-app-rediseno, PO 2026-10-07): the unread badge, and
// the one lie it must never tell — a number it did not receive.
//
//   · a count shows, capped at "9+" like the web masthead;
//   · a failed read shows NO badge (never "0"), and so does a real zero;
//   · a failure after a good read HIDES the old number rather than keeping it;
//   · the bell re-reads when its screen comes back into focus — the pathname
//     returning to the screen it was mounted on, which is how "back from
//     Notificaciones" looks from a header — and not while somewhere else;
//   · the bell opens the inbox, and nothing is drawn while the gate refuses.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

const mockPush = jest.fn<(path: string) => void>();
const mockPathname: { current: string } = { current: "/mascotas" };
const mockFetchUnread = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname.current,
}));

jest.mock("../api/endpoints", () => ({
  fetchMyUnreadNotificationCount: (...args: unknown[]) => mockFetchUnread(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

const mockGate: { current: { allowed: boolean } } = { current: { allowed: true } };
jest.mock("../auth/useGate", () => ({ useGate: () => mockGate.current }));

import { HeaderActions, bellAccessibilityLabel } from "./HeaderActions";

// The badge is hidden from the accessibility tree on purpose — the count rides
// the bell's own accessible name — so the visual queries must look past that.
const HIDDEN = { includeHiddenElements: true } as const;

function ok(unreadCount: number) {
  return {
    outcome: "ok" as const,
    payload: {
      payloadVersion: 1,
      issuedAt: "2026-10-07T00:00:00.000Z",
      staleAfter: "2026-10-07T00:00:30.000Z",
      unreadCount,
    },
  };
}

/** Let every pending read settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("HeaderActions — the bell", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockFetchUnread.mockReset();
    mockPathname.current = "/mascotas";
    mockGate.current = { allowed: true };
  });

  it("shows the unread count on the badge and in the accessible name", async () => {
    mockFetchUnread.mockResolvedValue(ok(3));
    render(<HeaderActions />);
    await settle();

    expect(screen.getByTestId("notifications-badge", HIDDEN)).toBeTruthy();
    expect(screen.getByText("3", HIDDEN)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notificaciones, 3 sin leer" })).toBeTruthy();
  });

  it("keeps the badge digit at its size under a large font scale (QA v14 P3)", async () => {
    mockFetchUnread.mockResolvedValue(ok(4));
    render(<HeaderActions />);
    await settle();
    expect(screen.getByText("4", HIDDEN).props.maxFontSizeMultiplier).toBe(1);
  });

  it("caps the badge at 9+", async () => {
    mockFetchUnread.mockResolvedValue(ok(42));
    render(<HeaderActions />);
    await settle();

    expect(screen.getByText("9+", HIDDEN)).toBeTruthy();
    expect(screen.queryByText("42", HIDDEN)).toBeNull();
    expect(screen.getByRole("button", { name: "Notificaciones, más de 9 sin leer" })).toBeTruthy();
  });

  it("hides the badge — and never draws a 0 — when the read fails", async () => {
    mockFetchUnread.mockResolvedValue({ outcome: "unreachable", detail: "sin red" });
    render(<HeaderActions />);
    await settle();

    expect(mockFetchUnread).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("notifications-badge", HIDDEN)).toBeNull();
    expect(screen.queryByText("0", HIDDEN)).toBeNull();
    expect(screen.getByRole("button", { name: "Notificaciones" })).toBeTruthy();
  });

  it("draws no badge for a real zero either", async () => {
    mockFetchUnread.mockResolvedValue(ok(0));
    render(<HeaderActions />);
    await settle();

    expect(screen.queryByTestId("notifications-badge", HIDDEN)).toBeNull();
    expect(screen.queryByText("0", HIDDEN)).toBeNull();
  });

  it("clears the old number when a re-read THROWS instead of answering", async () => {
    // MUTATION, APPLIED: drop the try/catch in `useUnreadCount.refresh`. The 4
    // stays on the badge (and the rejection goes unhandled).
    mockFetchUnread.mockResolvedValueOnce(ok(4));
    const view = render(<HeaderActions />);
    await settle();
    expect(screen.getByText("4", HIDDEN)).toBeTruthy();

    mockFetchUnread.mockRejectedValueOnce(new Error("socket hang up"));
    mockPathname.current = "/notificaciones";
    view.rerender(<HeaderActions />);
    mockPathname.current = "/mascotas";
    view.rerender(<HeaderActions />);
    await settle();

    expect(mockFetchUnread).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("notifications-badge", HIDDEN)).toBeNull();
    expect(screen.getByRole("button", { name: "Notificaciones" })).toBeTruthy();
  });

  it("re-reads when its screen comes back into focus, and drops a number it can no longer confirm", async () => {
    mockFetchUnread.mockResolvedValueOnce(ok(5));
    const view = render(<HeaderActions />);
    await settle();
    expect(screen.getByText("5", HIDDEN)).toBeTruthy();

    // Away to the inbox: no read while the screen is not showing.
    mockPathname.current = "/notificaciones";
    view.rerender(<HeaderActions />);
    await settle();
    expect(mockFetchUnread).toHaveBeenCalledTimes(1);

    // Back — read again. This read FAILS: the stale 5 must not stay.
    mockFetchUnread.mockResolvedValueOnce({ outcome: "server_error", status: 503 });
    mockPathname.current = "/mascotas";
    view.rerender(<HeaderActions />);
    await settle();
    expect(mockFetchUnread).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("notifications-badge", HIDDEN)).toBeNull();

    // And once more, after the person read two of them.
    mockFetchUnread.mockResolvedValueOnce(ok(3));
    mockPathname.current = "/notificaciones";
    view.rerender(<HeaderActions />);
    mockPathname.current = "/mascotas";
    view.rerender(<HeaderActions />);
    await settle();
    expect(mockFetchUnread).toHaveBeenCalledTimes(3);
    expect(screen.getByText("3", HIDDEN)).toBeTruthy();
  });

  it("opens the inbox", async () => {
    mockFetchUnread.mockResolvedValue(ok(1));
    render(<HeaderActions />);
    await settle();

    fireEvent.press(screen.getByRole("button", { name: "Notificaciones, 1 sin leer" }));
    expect(mockPush).toHaveBeenCalledWith("/notificaciones");
  });

  it("sits beside the menu button", async () => {
    mockFetchUnread.mockResolvedValue(ok(0));
    render(<HeaderActions />);
    await settle();

    expect(screen.getByLabelText("Abrir menú de navegación")).toBeTruthy();
  });

  it("draws nothing, and reads nothing, while the session gate refuses", async () => {
    mockGate.current = { allowed: false };
    render(<HeaderActions />);
    await settle();

    expect(screen.queryByRole("button", { name: /Notificaciones/ })).toBeNull();
    expect(screen.queryByLabelText("Abrir menú de navegación")).toBeNull();
    expect(mockFetchUnread).not.toHaveBeenCalled();
  });
});

describe("bellAccessibilityLabel", () => {
  it.each([
    [null, "Notificaciones"],
    ["1", "Notificaciones, 1 sin leer"],
    ["9+", "Notificaciones, más de 9 sin leer"],
  ])("reads %s as %s", (badge, label) => {
    expect(bellAccessibilityLabel(badge)).toBe(label);
  });
});
