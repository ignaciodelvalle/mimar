// @vitest-environment jsdom
//
// ContactarSheet — router-drop cure port (same pattern as
// app/(app)/mis-mascotas/[publicToken]/SheetMounter.tsx). This sheet has
// TWO close paths: the "Cerrar" button (immediate) and a 4s auto-close timer
// that fires after a successful submit. Both used router.replace; both are
// now closeSheetNav (shallow — the org contact form doesn't mutate any
// server-rendered content elsewhere on this page, so no full-reload variant
// is needed here, unlike MisTurnosSheetMounter's post-cancel close).
// Shared boilerplate lives in __tests__/helpers/sheet-nav-harness.tsx.

import "@testing-library/jest-dom/vitest";

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async () => {
  const h = await import("@/__tests__/helpers/sheet-nav-harness");
  return h.sheetNavigationMock("/refugios/refugio-abc", "sheet=contactar&foo=bar");
});
vi.mock("@/lib/ui/sheet-nav", async () => {
  const h = await import("@/__tests__/helpers/sheet-nav-harness");
  return h.sheetNavModuleMock();
});

const submitOrgContactAction = vi.fn();
vi.mock("@/src/modules/organizations/actions", () => ({
  submitOrgContactAction: (...args: unknown[]) => submitOrgContactAction(...args),
}));

import {
  closeSheetNav,
  routerReplace,
  testSheetClosesViaCleanNav,
} from "@/__tests__/helpers/sheet-nav-harness";
import { ContactarSheet } from "./ContactarSheet";

const renderSheet = () => (
  <ContactarSheet
    orgToken="refugio-abc"
    orgDisplayName="Refugio Abc"
    orgEmail="hola@refugio.org"
    orgPhone="+541111111111"
  />
);

describe("<ContactarSheet> — sheet=contactar", () => {
  testSheetClosesViaCleanNav({
    render: renderSheet,
    expectedCloseUrl: "/refugios/refugio-abc?foo=bar",
    extraAfterEach: () => {
      vi.useRealTimers();
      submitOrgContactAction.mockClear();
    },
  });

  it("auto-closes via closeSheetNav 4s after a successful submit, never via router.replace", async () => {
    // Fake timers from the start (with time-advancing microtasks) so the
    // effect's setTimeout is one this clock controls — findByText's
    // real-timer-based polling would otherwise deadlock against it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    submitOrgContactAction.mockResolvedValue({ ok: true, error: null });

    render(renderSheet());

    fireEvent.change(screen.getByLabelText(/Tu email/), { target: { value: "vos@ejemplo.com" } });
    fireEvent.change(screen.getByLabelText(/Mensaje/), {
      target: { value: "Hola, quiero ayudar." },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje" }));
    });

    expect(screen.getByText("Mensaje enviado.")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });

    expect(closeSheetNav).toHaveBeenCalledWith("/refugios/refugio-abc?foo=bar");
    expect(routerReplace).not.toHaveBeenCalled();
  });
});
