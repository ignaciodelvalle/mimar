// @vitest-environment jsdom
//
// OrgMascotasFilterBar — the custody-list filter row after the "Filtrar" button
// was removed and the controls became self-committing (PO decision 5, UI review
// 2026-08-06). What these tests pin is the seam between its TWO commit
// mechanisms: the discrete controls navigate immediately, the free-text query
// navigates on a 300 ms debounce, and the two must not contradict each other.
//
// The load-bearing case is the CLEAR/DEBOUNCE race: typing leaves an
// uncommitted timer in flight, and "Limpiar filtros" navigates away while it is
// still pending. Before the fix the timer landed ~300 ms into the clear and
// re-added ?q=<typed> — the operator asked for an empty list and got the filter
// they had just abandoned, with the field showing it as if they had typed it
// again.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const assign = vi.fn();
let currentSearch = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
    className?: string;
  }) => (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
    >
      {children}
    </a>
  ),
}));

// serverNavCommit is window.location.assign under the hood — the discrete
// controls' hard-navigation path. Stubbed so a select change is observable.
vi.mock("@/lib/ui/filter-commit", () => ({
  serverNavCommit:
    (current: string) => (updates: Record<string, string | null>, drop: readonly string[]) =>
      assign({ current, updates, drop }),
}));

import { OrgMascotasFilterBar } from "./OrgMascotasFilterBar";

const BASE = "/org/ORG-TEST/mascotas";

function renderBar(overrides: Partial<React.ComponentProps<typeof OrgMascotasFilterBar>> = {}) {
  return render(
    <OrgMascotasFilterBar
      basePath={BASE}
      query=""
      species=""
      adoptionEligible={false}
      {...overrides}
    />,
  );
}

function queryInput(): HTMLInputElement {
  return screen.getByLabelText("Buscar por nombre") as HTMLInputElement;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  replace.mockClear();
  assign.mockClear();
  currentSearch = "";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<OrgMascotasFilterBar> — on the shared base (L3·2)", () => {
  it("renders inside OpFilterBar: its header actions are there, and no period control", () => {
    renderBar();
    expect(screen.getAllByRole("button", { name: /^Copiar vista/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Período")).toBeNull();
  });
});

describe("<OrgMascotasFilterBar> — debounced text commit", () => {
  it("commits the typed query once, after the debounce window", () => {
    renderBar();
    fireEvent.change(queryInput(), { target: { value: "Rocky" } });

    // Nothing yet — the point of the debounce is not to navigate per keystroke.
    vi.advanceTimersByTime(250);
    expect(replace).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`${BASE}?q=Rocky`, { scroll: false });
  });

  it("Enter flushes the pending commit instead of waiting", () => {
    renderBar();
    const input = queryInput();
    fireEvent.change(input, { target: { value: "Rocky" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(replace).toHaveBeenCalledWith(`${BASE}?q=Rocky`, { scroll: false });
  });

  it("does not re-navigate on mount when the URL already carries the query", () => {
    currentSearch = "q=Rocky";
    renderBar({ query: "Rocky" });

    vi.advanceTimersByTime(1000);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("<OrgMascotasFilterBar> — 'Limpiar filtros' cancels a pending query", () => {
  it("never re-adds the typed ?q= after the clear (the debounce race)", () => {
    currentSearch = "species=dog";
    renderBar({ species: "dog" });

    // Typed but NOT yet committed — the timer is in flight.
    fireEvent.change(queryInput(), { target: { value: "Rocky" } });
    vi.advanceTimersByTime(100);
    expect(replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "Limpiar filtros" }));

    // Well past the debounce window: the pending commit must be dead, not
    // merely late. A single ?q=Rocky navigation here is the whole defect.
    vi.advanceTimersByTime(1000);
    expect(replace).not.toHaveBeenCalled();
    expect(queryInput().value).toBe("");
  });

  it("keeps the field intact on a modified click (that click opens a new tab)", () => {
    currentSearch = "q=Rocky";
    renderBar({ query: "Rocky" });

    fireEvent.click(screen.getByRole("link", { name: "Limpiar filtros" }), { ctrlKey: true });

    expect(queryInput().value).toBe("Rocky");
  });
});

describe("<OrgMascotasFilterBar> — discrete controls commit hard", () => {
  it("carries a still-debouncing query along when a select commits first", () => {
    renderBar();
    fireEvent.change(queryInput(), { target: { value: "Rocky" } });
    fireEvent.change(screen.getByLabelText("Especie"), { target: { value: "cat" } });

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0][0].updates).toEqual({ q: "Rocky", species: "cat" });
  });
});
