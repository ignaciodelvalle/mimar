// @vitest-environment jsdom
//
// AuditMineToggle — the "Ver solo mi actividad" toggle shared by /gob/historial
// and /admin/historial (F-migration 2026-07-21 cluster 2). Its default
// (unchecked) is OFF = the page's genuine "todos los actores" default — this
// is a toggle, not an axis, and shares the SAME `actor` param the Actor axis
// already owns. These tests pin: checked state reflects `isMine`, checking it
// commits actor=<userId>, and unchecking it CLEARS the actor param (not just
// "some other value") so it round-trips back to "todos los actores".

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockAssign = vi.fn();
const originalLocation = window.location;

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { AuditMineToggle } from "./AuditMineToggle";

const USER_ID = "11111111-1111-1111-1111-111111111111";

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
  const current = new URL(url, "http://localhost");
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, ...current, assign: mockAssign },
  });
}

afterEach(() => {
  cleanup();
  mockAssign.mockClear();
});

describe("<AuditMineToggle>", () => {
  it("renders unchecked when isMine is false (default: todos los actores)", () => {
    setUrl("/gob/historial");
    render(<AuditMineToggle userId={USER_ID} isMine={false} />);
    expect(screen.getByRole("checkbox", { name: "Ver solo mi actividad" })).not.toBeChecked();
  });

  it("renders checked when isMine is true", () => {
    setUrl(`/gob/historial?actor=${USER_ID}`);
    render(<AuditMineToggle userId={USER_ID} isMine={true} />);
    expect(screen.getByRole("checkbox", { name: "Ver solo mi actividad" })).toBeChecked();
  });

  it("checking it commits actor=<userId> and drops the cursor", () => {
    setUrl("/gob/historial?cursor=abc123");
    render(<AuditMineToggle userId={USER_ID} isMine={false} resetParamsOnChange={["cursor"]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Ver solo mi actividad" }));
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/historial");
    expect(url.searchParams.get("actor")).toBe(USER_ID);
    expect(url.searchParams.get("cursor")).toBeNull();
  });

  it("unchecking it CLEARS the actor param (back to todos los actores)", () => {
    setUrl(`/gob/historial?actor=${USER_ID}`);
    render(<AuditMineToggle userId={USER_ID} isMine={true} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Ver solo mi actividad" }));
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/historial");
    expect(url.searchParams.get("actor")).toBeNull();
  });

  it("preserves other active params (e.g. action/period) on toggle", () => {
    setUrl("/gob/historial?action=pii_queried&period=90d");
    render(<AuditMineToggle userId={USER_ID} isMine={false} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Ver solo mi actividad" }));
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/historial");
    expect(url.searchParams.get("action")).toBe("pii_queried");
    expect(url.searchParams.get("period")).toBe("90d");
  });
});
