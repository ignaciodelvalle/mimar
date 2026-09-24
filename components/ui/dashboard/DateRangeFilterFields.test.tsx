// @vitest-environment jsdom
//
// DateRangeFilterFields — the Desde/Hasta children-slot control shared by
// /admin/alertas and /admin/auditoria (F-migration 2026-07-21 cluster 2,
// consistency fix 2026-07-21). Unlike OpFilterBar's `period` prop (which
// always resolves to a preset default), this control's range has NO default
// bound — "no from/no to" is genuinely unbounded. These tests pin: each
// field commits ON CHANGE (no "Aplicar" button anywhere), only once its
// value is a complete valid date or fully cleared, preserving the OTHER
// bound's current value, and dropping an optional `resetParamsOnChange` key.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockAssign = vi.fn();
const originalLocation = window.location;

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { DateRangeFilterFields } from "./DateRangeFilterFields";

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
  const current = new URL(url, "http://localhost");
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, ...current, assign: mockAssign },
  });
}

function committedUrl(basePath: string, callIndex = 0): URL {
  return new URL(mockAssign.mock.calls[callIndex][0] as string, `http://localhost${basePath}`);
}

afterEach(() => {
  cleanup();
  mockAssign.mockClear();
});

describe("<DateRangeFilterFields>", () => {
  it("renders blank Desde/Hasta when no default bound is passed (genuinely unbounded)", () => {
    setUrl("/admin/alertas");
    render(<DateRangeFilterFields />);
    expect((screen.getByLabelText("Desde") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Hasta") as HTMLInputElement).value).toBe("");
  });

  it("renders no 'Aplicar' button — every field commits on change", () => {
    setUrl("/admin/alertas");
    render(<DateRangeFilterFields />);
    expect(screen.queryByRole("button", { name: "Aplicar" })).toBeNull();
  });

  it("commits Desde on change alone, without touching Hasta", () => {
    setUrl("/admin/alertas");
    render(<DateRangeFilterFields />);
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "01072026" } });
    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = committedUrl("/admin/alertas");
    expect(url.searchParams.get("from")).toBe("2026-07-01");
    expect(url.searchParams.get("to")).toBeNull();
  });

  it("commits Hasta on change, preserving Desde's already-committed value", () => {
    setUrl("/admin/alertas");
    render(<DateRangeFilterFields fromValue="2026-07-01" />);
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "15072026" } });
    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = committedUrl("/admin/alertas");
    expect(url.searchParams.get("from")).toBe("2026-07-01");
    expect(url.searchParams.get("to")).toBe("2026-07-15");
  });

  it("does NOT commit while a date is only partially typed", () => {
    setUrl("/admin/alertas");
    render(<DateRangeFilterFields />);
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "1507" } });
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it("drops resetParamsOnChange keys (e.g. keyset cursor) on commit", () => {
    setUrl("/admin/auditoria?cursor=abc123");
    render(<DateRangeFilterFields resetParamsOnChange={["cursor"]} />);
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "01072026" } });
    const url = committedUrl("/admin/auditoria");
    expect(url.searchParams.get("cursor")).toBeNull();
  });

  it("uses custom fromKey/toKey param names when provided", () => {
    setUrl("/admin/alertas");
    render(<DateRangeFilterFields fromKey="desde" toKey="hasta" />);
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "01072026" } });
    const url = committedUrl("/admin/alertas");
    expect(url.searchParams.get("desde")).toBe("2026-07-01");
    expect(url.searchParams.get("from")).toBeNull();
  });

  it("clearing a field removes its param while preserving the other bound", () => {
    setUrl("/admin/alertas?from=2026-07-01&to=2026-07-15");
    render(<DateRangeFilterFields fromValue="2026-07-01" toValue="2026-07-15" />);
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "" } });
    const url = committedUrl("/admin/alertas");
    expect(url.searchParams.get("from")).toBeNull();
    expect(url.searchParams.get("to")).toBe("2026-07-15");
  });

  it("ignores a tampered/invalid default when preserving the other bound", () => {
    setUrl("/admin/alertas?from=2026-99-99");
    render(<DateRangeFilterFields fromValue="2026-99-99" />);
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "15072026" } });
    const url = committedUrl("/admin/alertas");
    expect(url.searchParams.get("from")).toBeNull();
    expect(url.searchParams.get("to")).toBe("2026-07-15");
  });
});
