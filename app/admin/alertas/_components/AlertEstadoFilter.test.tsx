// @vitest-environment jsdom
//
// AlertEstadoFilter — dead-filter-trap guard (opfilterbar-sweep-2026-07-21
// cluster 2). Estado's no-param default is "open" (STATUS_FILTER_LABEL's own
// specific "Abiertas (todas)" subset) — a DIFFERENT, genuinely-"all" entry
// ("Todas") already exists in the same option set. Were Estado a registered
// OpFilterBar `axis`, the bar would inject its OWN blank "Todas" option whose
// value clears the `status` param — i.e. reverts to "open", NOT the real
// "all" — sitting right beside the genuine "Todas" entry as an
// indistinguishable dead second option (the exact bug CasoEstadoFilter
// guards against on /gob/casos, /admin/casos). These tests pin that Estado
// renders EXACTLY the configured options (no injected 4th/9th blank) and that
// each commits a DISTINCT `status` param.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockAssign = vi.fn();
const originalLocation = window.location;

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { AlertEstadoFilter } from "./AlertEstadoFilter";

const OPTIONS = [
  { value: "open", label: "Abiertas (todas)" },
  { value: "all", label: "Todas" },
  { value: "disparada", label: "Disparada" },
  { value: "reconocida", label: "Reconocida" },
  { value: "en_investigacion", label: "En investigación" },
  { value: "autoridad_contactada", label: "Autoridad contactada" },
  { value: "resuelta", label: "Resuelta" },
  { value: "descartada", label: "Descartada" },
];

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
  const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/admin/alertas");
  return url.searchParams.get("status");
}

afterEach(() => {
  cleanup();
  mockAssign.mockClear();
});

describe("<AlertEstadoFilter> — exactly the configured options, no injected extra blank", () => {
  it("renders all 8 options and nothing else", () => {
    setUrl("/admin/alertas");
    render(<AlertEstadoFilter value="open" options={OPTIONS} />);
    const select = screen.getByLabelText("Estado") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => ({ value: o.value, label: o.text }));
    expect(options).toEqual(OPTIONS);
  });
});

describe("<AlertEstadoFilter> — each state commits a DISTINCT status param", () => {
  it('selecting "Todas" commits status=all (the dead-control regression)', () => {
    setUrl("/admin/alertas");
    render(<AlertEstadoFilter value="open" options={OPTIONS} />);
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "all" } });
    expect(committedStatus()).toBe("all");
  });

  it('selecting "Descartada" commits status=descartada', () => {
    setUrl("/admin/alertas?status=all");
    render(<AlertEstadoFilter value="all" options={OPTIONS} />);
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "descartada" } });
    expect(committedStatus()).toBe("descartada");
  });

  it('selecting "Abiertas (todas)" CLEARS the status param (default, clean URL)', () => {
    setUrl("/admin/alertas?status=resuelta");
    render(<AlertEstadoFilter value="resuelta" options={OPTIONS} />);
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "open" } });
    expect(committedStatus()).toBeNull();
  });

  it("preserves other active params (e.g. metric/province) on a status change", () => {
    setUrl("/admin/alertas?metric=active_zoonosis&province=Chaco");
    render(<AlertEstadoFilter value="open" options={OPTIONS} />);
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "all" } });
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/admin/alertas");
    expect(url.searchParams.get("metric")).toBe("active_zoonosis");
    expect(url.searchParams.get("province")).toBe("Chaco");
    expect(url.searchParams.get("status")).toBe("all");
  });
});
