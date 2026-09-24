// @vitest-environment jsdom
//
// UrlTabs — router-drop defect fix (QA sweep, fix/qa-findings-20260702).
// Tab switching used to write the URL via `router.replace`, which Next
// 15.5.18's App Router can silently drop in production (same defect class
// documented in lib/ui/sheet-nav.ts and cured in
// components/gob/JurisdictionSwitcher.tsx). Consumer pages
// (app/gob/maltrato, app/gob/perdidas) server-render the active tab's
// content from this searchParam, so a shallow client-router transition
// alone would leave stale content on screen. The fix bypasses the client
// router entirely via a full document navigation (`window.location.assign`)
// — this test asserts that mechanism directly and that no router method is
// ever invoked.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerPush = vi.fn();
const routerReplace = vi.fn();
const routerRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: routerRefresh }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { UrlTabs } from "./UrlTabs";

const TABS = [
  { value: "abierto", label: "Abierto" },
  { value: "cerrado", label: "Cerrado" },
];

const mockAssign = vi.fn();
const originalLocation = window.location;

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
  const current = new URL(url, "http://localhost");
  // jsdom's real window.location.assign performs a navigation it doesn't
  // support ("Not implemented: navigation"), and its `assign` method isn't
  // directly spy-able (non-configurable on the Location object). Replace the
  // whole object with a plain stub that mirrors the fields the component and
  // useSearchParams mock read, plus a jest.fn() for `assign`.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, ...current, assign: mockAssign },
  });
}

beforeEach(() => {
  routerPush.mockClear();
  routerReplace.mockClear();
  routerRefresh.mockClear();
  mockAssign.mockClear();
  setUrl("/gob/maltrato?queue=abierto");
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("UrlTabs — full navigation on change (router-drop fix)", () => {
  it("selecting a tab navigates via window.location.assign, preserving other params", () => {
    setUrl("/gob/maltrato?queue=abierto&province=buenos-aires");
    render(
      <UrlTabs paramKey="queue" defaultValue="abierto" tabs={TABS} aria-label="Cola de casos">
        <div />
      </UrlTabs>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Cerrado" }));

    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/maltrato");
    expect(url.searchParams.get("queue")).toBe("cerrado");
    expect(url.searchParams.get("province")).toBe("buenos-aires");
  });

  it("never calls router.push/replace/refresh — only the full-navigation path", () => {
    render(
      <UrlTabs paramKey="queue" defaultValue="abierto" tabs={TABS} aria-label="Cola de casos">
        <div />
      </UrlTabs>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Cerrado" }));

    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});

describe("UrlTabs — keyboard (APG Tabs pattern, a11y audit 2026-07-04 #1)", () => {
  it("only the active tab is in the Tab order (roving tabindex)", () => {
    render(
      <UrlTabs paramKey="queue" defaultValue="abierto" tabs={TABS} aria-label="Cola de casos">
        <div />
      </UrlTabs>,
    );

    expect(screen.getByRole("tab", { name: "Abierto" })).toHaveAttribute("tabIndex", "0");
    expect(screen.getByRole("tab", { name: "Cerrado" })).toHaveAttribute("tabIndex", "-1");
  });

  it("ArrowRight moves to and activates the next tab, wrapping at the end", () => {
    setUrl("/gob/maltrato?queue=cerrado");
    render(
      <UrlTabs paramKey="queue" defaultValue="cerrado" tabs={TABS} aria-label="Cola de casos">
        <div />
      </UrlTabs>,
    );

    fireEvent.keyDown(screen.getByRole("tab", { name: "Cerrado" }), { key: "ArrowRight" });

    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/maltrato");
    expect(url.searchParams.get("queue")).toBe("abierto");
  });

  it("ArrowLeft moves to and activates the previous tab, wrapping at the start", () => {
    render(
      <UrlTabs paramKey="queue" defaultValue="abierto" tabs={TABS} aria-label="Cola de casos">
        <div />
      </UrlTabs>,
    );

    fireEvent.keyDown(screen.getByRole("tab", { name: "Abierto" }), { key: "ArrowLeft" });

    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/maltrato");
    expect(url.searchParams.get("queue")).toBe("cerrado");
  });

  it("Home activates the first tab; End activates the last tab", () => {
    setUrl("/gob/maltrato?queue=cerrado");
    render(
      <UrlTabs paramKey="queue" defaultValue="cerrado" tabs={TABS} aria-label="Cola de casos">
        <div />
      </UrlTabs>,
    );

    fireEvent.keyDown(screen.getByRole("tab", { name: "Cerrado" }), { key: "Home" });
    const homeUrl = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/maltrato");
    expect(homeUrl.searchParams.get("queue")).toBe("abierto");

    mockAssign.mockClear();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Cerrado" }), { key: "End" });
    const endUrl = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/maltrato");
    expect(endUrl.searchParams.get("queue")).toBe("cerrado");
  });

  it("ignores unrelated keys (no navigation on Enter/Space — click already handles activation)", () => {
    render(
      <UrlTabs paramKey="queue" defaultValue="abierto" tabs={TABS} aria-label="Cola de casos">
        <div />
      </UrlTabs>,
    );

    fireEvent.keyDown(screen.getByRole("tab", { name: "Abierto" }), { key: "Enter" });
    expect(mockAssign).not.toHaveBeenCalled();
  });
});

describe("UrlTabs — badge tone", () => {
  it("urgent (default) badge labels the count as urgentes for screen readers", () => {
    render(
      <UrlTabs
        paramKey="queue"
        defaultValue="abierto"
        tabs={[
          { value: "abierto", label: "Abierto", badge: 3 },
          { value: "cerrado", label: "Cerrado", badge: 0 },
        ]}
        aria-label="Cola de casos"
      >
        <div />
      </UrlTabs>,
    );
    expect(screen.getByLabelText("3 urgentes")).toBeInTheDocument();
    expect(screen.getByLabelText("0 urgentes")).toBeInTheDocument();
  });

  it("neutral badge reads the count as plain text (no 'urgente' semantics)", () => {
    render(
      <UrlTabs
        paramKey="cat"
        defaultValue="all"
        tabs={[
          { value: "all", label: "Todas", badge: 12, badgeTone: "neutral" },
          { value: "health", label: "Salud", badge: 4, badgeTone: "neutral" },
        ]}
        aria-label="Filtrar notificaciones por categoría"
      >
        <div />
      </UrlTabs>,
    );
    // The count renders as visible text, but is NOT announced as "urgentes".
    expect(screen.queryByLabelText(/urgente/)).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Todas/ })).toHaveTextContent("12");
    expect(screen.getByRole("tab", { name: /Salud/ })).toHaveTextContent("4");
  });
});
