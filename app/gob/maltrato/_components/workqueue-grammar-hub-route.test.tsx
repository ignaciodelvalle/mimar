// @vitest-environment jsdom
//
// C6c workqueue grammar survives the F1 route fusion (2026-07-22): the
// master-detail inspector's selection affordances (WelfareRowLink's plain row
// click, ActuarButton's `&panel=acciones` shortcut) and the TomarButton
// self-assign action are all pathname-agnostic by construction — they read
// `usePathname()` / `window.location.href` at click time and act relative to
// THAT path, never a hardcoded "/gob/maltrato". This test proves relocating
// the queue under the Denuncias hub (rendered at /gob/denuncias?etapa=triage,
// not the old standalone /gob/maltrato) doesn't change their behavior: mount
// them with a mocked pathname/location of "/gob/denuncias" and assert the
// constructed URL is built from that hub path.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const selectCaso = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/gob/denuncias",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../_inspector/inspector-nav", () => ({
  selectCaso: (...args: unknown[]) => selectCaso(...args),
}));

const assignWelfareToMeAction = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ ok: true as const }),
);
vi.mock("@/src/modules/welfare/actions", () => ({
  assignWelfareToMeAction: (...args: unknown[]) => assignWelfareToMeAction(...args),
}));

const navigateAfterActionSuccess = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (...args: unknown[]) => navigateAfterActionSuccess(...args),
}));

import { ActuarButton } from "./ActuarButton";
import { TomarButton } from "./TomarButton";
import { WelfareRowLink } from "./WelfareRowLink";

const originalLocation = window.location;

afterEach(() => {
  cleanup();
  selectCaso.mockClear();
  assignWelfareToMeAction.mockClear();
  navigateAfterActionSuccess.mockClear();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("C6c workqueue grammar under the Denuncias hub route (F1 fusion)", () => {
  it("WelfareRowLink selects the case relative to the CURRENT pathname (/gob/denuncias), not the old /gob/maltrato path", () => {
    render(
      <WelfareRowLink casoParam="DEN-0001-0001" href="/gob/maltrato/DEN-0001-0001">
        row content
      </WelfareRowLink>,
    );
    fireEvent.click(screen.getByText("row content"));

    expect(selectCaso).toHaveBeenCalledTimes(1);
    const [url] = selectCaso.mock.calls[0] as [string, boolean];
    expect(url.startsWith("/gob/denuncias?")).toBe(true);
    expect(new URL(url, "http://localhost").searchParams.get("caso")).toBe("DEN-0001-0001");
  });

  it("ActuarButton selects the case with &panel=acciones, relative to the current pathname (/gob/denuncias)", () => {
    render(
      <ActuarButton
        casoParam="DEN-0002-0002"
        href="/gob/maltrato/DEN-0002-0002"
        label="Iniciar seguimiento"
      />,
    );
    fireEvent.click(screen.getByText(/Iniciar seguimiento/));

    expect(selectCaso).toHaveBeenCalledTimes(1);
    const [url] = selectCaso.mock.calls[0] as [string, boolean];
    expect(url.startsWith("/gob/denuncias?")).toBe(true);
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("caso")).toBe("DEN-0002-0002");
    expect(params.get("panel")).toBe("acciones");
  });

  it("TomarButton (self-assign) reloads the CURRENT location — no hardcoded /gob/maltrato — so 'tomar' works unchanged under the hub route", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, href: "http://localhost/gob/denuncias?etapa=triage" },
    });

    render(<TomarButton reportId="report-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Tomar esta denuncia/i }));

    await waitFor(() => expect(navigateAfterActionSuccess).toHaveBeenCalledTimes(1));
    expect(assignWelfareToMeAction).toHaveBeenCalledWith("report-1");
    expect(navigateAfterActionSuccess).toHaveBeenCalledWith(
      "http://localhost/gob/denuncias?etapa=triage",
    );
  });
});
