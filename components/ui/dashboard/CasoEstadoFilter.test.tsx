// @vitest-environment jsdom
//
// CasoEstadoFilter / parseCasoEstado — BUGFIX opfilterbar-sweep-2026-07-21.
//
// THE BUG this guards against: casos' Estado control used to be an
// OpFilterBar `axis`. An axis always renders OpFilterBar's OWN injected blank
// "Todas" option (mapping to "no status param"), which for casos silently
// reverts to the Abiertos default — NOT "every case" — while the axis's own
// explicit "all" option (real "Todos los estados") sat right beside it,
// visually identical. Selecting "Todas" was a dead control.
//
// THE FIX: Estado renders as its own 3-option control (this file) instead of
// an axis, so there is exactly ONE "Todos los estados" option and it
// genuinely clears the status filter. These tests pin:
//   1. parseCasoEstado — the raw `status` searchParam → 3-way value mapping
//      (open default / all / closed), including the fail-safe default for
//      garbage input.
//   2. The rendered <select> carries EXACTLY 3 options — no 4th injected
//      blank alongside them (the regression this bug was).
//   3. Selecting each of the 3 options commits a DISTINCT `status` URL param
//      via the same serverNavCommit primitive every other OpFilterBar control
//      uses, and drops the keyset `cursor` (a status change invalidates the
//      current page).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockAssign = vi.fn();
const originalLocation = window.location;

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { CasoEstadoFilter } from "./CasoEstadoFilter";
import { parseCasoEstado } from "./caso-estado";

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
  const current = new URL(url, "http://localhost");
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, ...current, assign: mockAssign },
  });
}

function committedStatus(): string | null {
  const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/admin/casos");
  return url.searchParams.get("status");
}

afterEach(() => {
  cleanup();
  mockAssign.mockClear();
});

describe("parseCasoEstado — raw status param → 3-way Estado value", () => {
  it('returns "open" (default) when the param is absent', () => {
    expect(parseCasoEstado(undefined)).toBe("open");
  });

  it('returns "open" for an explicit status=open', () => {
    expect(parseCasoEstado("open")).toBe("open");
  });

  it('returns "all" for status=all', () => {
    expect(parseCasoEstado("all")).toBe("all");
  });

  it('returns "closed" for status=closed', () => {
    expect(parseCasoEstado("closed")).toBe("closed");
  });

  it('falls back to "open" for an unrecognized value (fail-safe default)', () => {
    expect(parseCasoEstado("bogus")).toBe("open");
  });
});

describe("<CasoEstadoFilter> — exactly 3 options, no injected 4th blank", () => {
  it("renders Abiertos / Todos los estados / Cerrados and nothing else", () => {
    setUrl("/admin/casos");
    render(<CasoEstadoFilter value="open" />);
    const select = screen.getByLabelText("Estado") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => ({ value: o.value, label: o.text }));
    expect(options).toEqual([
      { value: "open", label: "Abiertos" },
      { value: "all", label: "Todos los estados" },
      { value: "closed", label: "Cerrados" },
    ]);
  });
});

describe("<CasoEstadoFilter> — each state commits a DISTINCT status param", () => {
  it('selecting "Todos los estados" commits status=all (the dead-control regression)', () => {
    setUrl("/admin/casos");
    render(<CasoEstadoFilter value="open" />);
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "all" } });
    expect(committedStatus()).toBe("all");
  });

  it('selecting "Cerrados" commits status=closed', () => {
    setUrl("/admin/casos?status=all");
    render(<CasoEstadoFilter value="all" />);
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "closed" } });
    expect(committedStatus()).toBe("closed");
  });

  it('selecting "Abiertos" CLEARS the status param (default, clean URL)', () => {
    setUrl("/admin/casos?status=closed");
    render(<CasoEstadoFilter value="closed" />);
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "open" } });
    expect(committedStatus()).toBeNull();
  });

  it("drops the keyset cursor param on a status change", () => {
    setUrl("/admin/casos?cursor=abc123");
    render(<CasoEstadoFilter value="open" />);
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "closed" } });
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/admin/casos");
    expect(url.searchParams.get("cursor")).toBeNull();
  });
});
