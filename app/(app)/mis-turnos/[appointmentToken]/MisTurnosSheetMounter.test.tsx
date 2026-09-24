// @vitest-environment jsdom
//
// MisTurnosSheetMounter — router-drop cure port (same pattern as
// app/(app)/mis-mascotas/[publicToken]/SheetMounter.tsx / SheetHost.interaction.test.tsx).
//
// This mounter has TWO distinct close paths (a discovery from reading the
// file, not symmetric open/close as the task briefing first assumed):
//   - "Volver" (cancel out without cancelling the appointment) → closeSheetNav
//     (shallow History-API close, no server data changed).
//   - "Sí, cancelar" success → closeAfterCancel → closeSheetNavWithFullReload,
//     because the appointment's server-rendered status badge + this very
//     cancel button (both rendered by page.tsx) need a real re-fetch that a
//     shallow close would never trigger — same rationale as SheetMounter's
//     closeAfterEmergencyContactSave. This used to be router.refresh() +
//     close(), which rides the same silently-dropping client-router
//     transition machinery this whole cure exists to avoid.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { routerPush, routerReplace, routerRefresh, closeSheetNav, closeSheetNavWithFullReload } =
  vi.hoisted(() => ({
    routerPush: vi.fn(),
    routerReplace: vi.fn(),
    routerRefresh: vi.fn(),
    closeSheetNav: vi.fn(),
    closeSheetNavWithFullReload: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/mis-turnos/tok-abc",
  useSearchParams: () => new URLSearchParams("sheet=cancelar-turno&foo=bar"),
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: routerRefresh }),
}));

vi.mock("@/lib/ui/sheet-nav", () => ({
  closeSheetNav,
  closeSheetNavWithFullReload,
}));

const cancelAppointmentByOwnerAction = vi.fn();
vi.mock("@/app/actions/booking", () => ({
  cancelAppointmentByOwnerAction: (...args: unknown[]) => cancelAppointmentByOwnerAction(...args),
}));

import { MisTurnosSheetMounter } from "./MisTurnosSheetMounter";

beforeEach(() => {
  // Vaul checks window.matchMedia when a drawer opens — jsdom has none.
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ??
    (class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver);
});

afterEach(() => {
  cleanup();
  closeSheetNav.mockClear();
  closeSheetNavWithFullReload.mockClear();
  cancelAppointmentByOwnerAction.mockClear();
  routerPush.mockClear();
  routerReplace.mockClear();
  routerRefresh.mockClear();
});

describe("<MisTurnosSheetMounter> — sheet=cancelar-turno", () => {
  it("'Volver' calls closeSheetNav (shallow close), preserving other params, never touching the router", () => {
    render(<MisTurnosSheetMounter appointmentToken="tok-abc" />);

    fireEvent.click(screen.getByRole("button", { name: "Volver" }));

    expect(closeSheetNav).toHaveBeenCalledWith("/mis-turnos/tok-abc?foo=bar");
    expect(closeSheetNavWithFullReload).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("a successful cancellation calls closeSheetNavWithFullReload (post-mutation stale-server-data close), never router.refresh", async () => {
    cancelAppointmentByOwnerAction.mockResolvedValue({ ok: true });
    render(<MisTurnosSheetMounter appointmentToken="tok-abc" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sí, cancelar" }));
    });

    await waitFor(() => {
      expect(closeSheetNavWithFullReload).toHaveBeenCalledWith("/mis-turnos/tok-abc?foo=bar");
    });
    expect(closeSheetNav).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("a failed cancellation shows the inline error and does not close the sheet", async () => {
    cancelAppointmentByOwnerAction.mockResolvedValue({ error: "No se pudo cancelar el turno." });
    render(<MisTurnosSheetMounter appointmentToken="tok-abc" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sí, cancelar" }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("No se pudo cancelar el turno.");
    });
    expect(closeSheetNav).not.toHaveBeenCalled();
    expect(closeSheetNavWithFullReload).not.toHaveBeenCalled();
  });
});
