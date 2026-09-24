// @vitest-environment jsdom
//
// SerVoluntarioSheet — router-drop cure port (same pattern as
// app/(app)/mis-mascotas/[publicToken]/SheetMounter.tsx). This sheet has
// TWO close paths: the "Cerrar" button (immediate) and a 4s auto-close timer
// that fires after a successful submit. Both used router.replace; both are
// now closeSheetNav (shallow — this form doesn't mutate any server-rendered
// content elsewhere on this page, so no full-reload variant is needed).
// Shared boilerplate lives in __tests__/helpers/sheet-nav-harness.tsx.

import "@testing-library/jest-dom/vitest";

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async () => {
  const h = await import("@/__tests__/helpers/sheet-nav-harness");
  return h.sheetNavigationMock("/refugios/refugio-abc", "sheet=ser-voluntario&foo=bar");
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
import { SerVoluntarioSheet } from "./SerVoluntarioSheet";

describe("<SerVoluntarioSheet> — sheet=ser-voluntario", () => {
  testSheetClosesViaCleanNav({
    render: () => <SerVoluntarioSheet orgToken="refugio-abc" orgDisplayName="Refugio Abc" />,
    expectedCloseUrl: "/refugios/refugio-abc?foo=bar",
    extraAfterEach: () => {
      vi.useRealTimers();
      submitOrgContactAction.mockClear();
    },
  });

  it("auto-closes via closeSheetNav 4s after a successful submit, never via router.replace", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    submitOrgContactAction.mockResolvedValue({ ok: true, error: null });

    render(<SerVoluntarioSheet orgToken="refugio-abc" orgDisplayName="Refugio Abc" />);

    fireEvent.change(screen.getByLabelText(/Tu email/), { target: { value: "vos@ejemplo.com" } });
    fireEvent.change(screen.getByLabelText(/Contales en qué te interesa ayudar/), {
      target: { value: "Puedo pasear perros los fines de semana." },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    });

    expect(screen.getByText("¡Genial! Tu mensaje llegó.")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });

    expect(closeSheetNav).toHaveBeenCalledWith("/refugios/refugio-abc?foo=bar");
    expect(routerReplace).not.toHaveBeenCalled();
  });
});
