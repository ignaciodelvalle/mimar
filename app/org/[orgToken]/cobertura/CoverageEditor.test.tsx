// @vitest-environment jsdom
//
// CoverageEditor — router-drop defect fix (QA sweep, fix/qa-findings-20260702).
// The province select used to write the URL via `router.replace`, which Next
// 15.5.18's App Router can silently drop in production (same defect class
// documented in lib/ui/sheet-nav.ts and cured in
// components/gob/JurisdictionSwitcher.tsx). This page server-renders the
// locality options from `?province=` on every request, so a shallow
// client-router transition alone would leave stale options on screen. The
// fix bypasses the client router entirely via a full document navigation
// (`window.location.assign`) — this test asserts that mechanism directly and
// that no router method is ever invoked.
//
// Note: the add/remove/set-primary zone mutations still use useTransition —
// that's an unrelated server-action pending affordance, not part of this
// fix, and is out of scope here.

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

vi.mock("@/src/modules/organizations/actions", () => ({
  addCoverageZoneAction: vi.fn(),
  removeCoverageZoneAction: vi.fn(),
  setPrimaryCoverageZoneAction: vi.fn(),
}));

import { CoverageEditor } from "./CoverageEditor";

const PROVINCES = [
  { code: "AR-B", name: "Buenos Aires", slug: "buenos-aires" },
  { code: "AR-C", name: "CABA", slug: "caba" },
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

function renderEditor() {
  return render(
    <CoverageEditor
      orgToken="org-token-1"
      provinces={PROVINCES}
      localities={[]}
      zones={[]}
      canManage
    />,
  );
}

beforeEach(() => {
  routerPush.mockClear();
  routerReplace.mockClear();
  routerRefresh.mockClear();
  mockAssign.mockClear();
  setUrl("/org/org-token-1/cobertura");
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("CoverageEditor — full navigation on change (router-drop fix)", () => {
  it("selecting a province navigates via window.location.assign, preserving other params", () => {
    setUrl("/org/org-token-1/cobertura?tab=zonas");
    renderEditor();

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "AR-B" } });

    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = new URL(
      mockAssign.mock.calls[0][0] as string,
      "http://localhost/org/org-token-1/cobertura",
    );
    expect(url.pathname).toBe("/org/org-token-1/cobertura");
    expect(url.searchParams.get("tab")).toBe("zonas");
    expect(url.searchParams.get("province")).toBe("AR-B");
  });

  it("selecting a province clears any previously-selected locality param", () => {
    setUrl("/org/org-token-1/cobertura?province=AR-B&locality=la-plata");
    renderEditor();

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "AR-C" } });

    const url = new URL(
      mockAssign.mock.calls[0][0] as string,
      "http://localhost/org/org-token-1/cobertura",
    );
    expect(url.searchParams.get("province")).toBe("AR-C");
    expect(url.searchParams.get("locality")).toBeNull();
  });

  it("never calls router.push/replace/refresh — only the full-navigation path", () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "AR-B" } });

    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
