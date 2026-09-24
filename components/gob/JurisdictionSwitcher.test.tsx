// @vitest-environment jsdom
//
// JurisdictionSwitcher — router-drop defect fix (finding 5, live QA).
// The province/locality selects used to write the URL via `router.replace`,
// which Next 15.5.18's App Router can silently drop in production (same
// defect class documented in lib/ui/sheet-nav.ts). Unlike the pet profile's
// sheets, /gob/vigilancia's panels are SERVER-rendered from searchParams, so
// a shallow history write alone would leave stale content on screen. The fix
// bypasses the client router entirely via a full document navigation
// (`window.location.assign`) — this test asserts that mechanism directly and
// that no router method is ever invoked.

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

import { JurisdictionSwitcher } from "./JurisdictionSwitcher";

const ALLOWED_PROVINCES = [
  { code: "AR-B", name: "Buenos Aires" },
  { code: "AR-C", name: "CABA" },
];

const LOCALITIES = [
  { slug: "la-plata", name: "La Plata" },
  { slug: "mar-del-plata", name: "Mar del Plata" },
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
  setUrl("/gob/vigilancia?period=30d");
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("JurisdictionSwitcher — full navigation on change (router-drop fix)", () => {
  it("selecting a province navigates via window.location.assign, preserving other params", () => {
    render(<JurisdictionSwitcher allowedProvinces={ALLOWED_PROVINCES} />);

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "AR-B" } });

    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/vigilancia");
    expect(url.searchParams.get("period")).toBe("30d");
    expect(url.searchParams.get("province")).toBe("AR-B");
    expect(url.searchParams.get("locality")).toBeNull();
  });

  it("selecting a province clears any previously-selected locality", () => {
    setUrl("/gob/vigilancia?period=30d&province=AR-B&locality=la-plata");
    render(<JurisdictionSwitcher allowedProvinces={ALLOWED_PROVINCES} localities={LOCALITIES} />);

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "AR-C" } });

    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/vigilancia");
    expect(url.searchParams.get("province")).toBe("AR-C");
    expect(url.searchParams.get("locality")).toBeNull();
  });

  it("selecting a locality navigates via window.location.assign, preserving province", () => {
    setUrl("/gob/vigilancia?period=30d&province=AR-B");
    render(<JurisdictionSwitcher allowedProvinces={ALLOWED_PROVINCES} localities={LOCALITIES} />);

    fireEvent.change(screen.getByLabelText("Localidad"), { target: { value: "la-plata" } });

    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/vigilancia");
    expect(url.searchParams.get("province")).toBe("AR-B");
    expect(url.searchParams.get("locality")).toBe("la-plata");
  });

  it("never calls router.replace/push/refresh — only the full-navigation path", () => {
    render(<JurisdictionSwitcher allowedProvinces={ALLOWED_PROVINCES} localities={LOCALITIES} />);

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "AR-B" } });

    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("drops the caller-nominated params (panorama camera) on a scope change", () => {
    setUrl("/gob/panorama?period=30d&z=4.2&lat=-38&lng=-63");
    render(
      <JurisdictionSwitcher
        allowedProvinces={ALLOWED_PROVINCES}
        dropParamsOnNavigate={["z", "lat", "lng"]}
      />,
    );

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "AR-B" } });

    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/panorama");
    expect(url.searchParams.get("province")).toBe("AR-B");
    expect(url.searchParams.get("period")).toBe("30d");
    // The stale national camera is dropped so the province frames itself.
    expect(url.searchParams.get("z")).toBeNull();
    expect(url.searchParams.get("lat")).toBeNull();
    expect(url.searchParams.get("lng")).toBeNull();
  });

  it("preserves camera params when no drop list is passed (default routes)", () => {
    setUrl("/gob/vigilancia?period=30d&z=4.2");
    render(<JurisdictionSwitcher allowedProvinces={ALLOWED_PROVINCES} />);

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "AR-B" } });

    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/vigilancia");
    expect(url.searchParams.get("z")).toBe("4.2");
  });
});

// panorama embedded-drill: with `onScopeCommit`, the switcher is a CONTROLLED
// component that delegates the scope commit to the caller (client-side, no
// reload) instead of a full document navigation.
describe("JurisdictionSwitcher — embedded mode (onScopeCommit)", () => {
  it("delegates a province pick to onScopeCommit and never navigates the document", () => {
    const onScopeCommit = vi.fn();
    render(
      <JurisdictionSwitcher
        allowedProvinces={ALLOWED_PROVINCES}
        localities={LOCALITIES}
        selectedProvince={null}
        selectedLocality={null}
        onScopeCommit={onScopeCommit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "AR-B" } });

    expect(onScopeCommit).toHaveBeenCalledTimes(1);
    // Province committed, locality cleared — no reload, no router.
    expect(onScopeCommit).toHaveBeenCalledWith({ province: "AR-B", locality: null });
    expect(mockAssign).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("reads its selection from the controlled props, not searchParams (shallow-commit safe)", () => {
    // The URL still shows national scope (a shallow commit isn't visible to
    // useSearchParams in production), but the controlled props say AR-B → the
    // province select must reflect AR-B, and a locality pick must carry AR-B.
    setUrl("/gob/panorama?period=3y");
    const onScopeCommit = vi.fn();
    render(
      <JurisdictionSwitcher
        allowedProvinces={ALLOWED_PROVINCES}
        localities={LOCALITIES}
        selectedProvince="AR-B"
        selectedLocality={null}
        onScopeCommit={onScopeCommit}
      />,
    );

    expect((screen.getByLabelText("Provincia") as HTMLSelectElement).value).toBe("AR-B");

    fireEvent.change(screen.getByLabelText("Localidad"), { target: { value: "la-plata" } });

    expect(onScopeCommit).toHaveBeenCalledWith({ province: "AR-B", locality: "la-plata" });
    expect(mockAssign).not.toHaveBeenCalled();
  });
});
