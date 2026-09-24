// @vitest-environment jsdom
//
// ContextBar — the sticky one-line answer above the map.
//
// What these tests defend, in order of how expensive the regression would be:
//
//   1. ONE PANEL AT A TIME. The bar is controlled by the console's single
//      open-panel state; if it ever grows its own, the same panel can be open
//      twice (bar + rail) with divergent local state.
//   2. THE VALUE IS VISIBLE TEXT. ScopePillSummary.tsx documents the exact
//      anti-pattern this file must not reintroduce — a control whose only
//      visible text is its value, with the name hidden in sr-only, reads as a
//      status label to a sighted operator while AT hears a control.
//   3. THE PANEL IS NOT CLIPPED BY ITS OWN CONTAINER. The mobile row scrolls
//      horizontally; an `overflow-x-auto` ancestor would cut the open panel off
//      at the row's edge. That is invisible in jsdom, so it is pinned as a
//      class-level contract here and must be re-checked visually.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextBar, type ContextBarSegment } from "@/components/panorama/ContextBar";

afterEach(cleanup);

const SEGMENTS: ContextBarSegment[] = [
  {
    id: "periodo",
    changeLabel: "período",
    value: "últimos 90 días",
    valueClassName: "first-letter:uppercase",
    panelTitle: "Período",
    render: () => <div data-testid="periodo-body">cuerpo período</div>,
  },
  {
    id: "filtro",
    changeLabel: "capas del mapa",
    value: "3 capas",
    badge: 2,
    badgeLabel: "2 ajustes sobre la vista",
    panelTitle: "Capas del mapa",
    render: () => <div data-testid="filtro-body">cuerpo capas</div>,
  },
];

function renderBar(over: Partial<React.ComponentProps<typeof ContextBar>> = {}) {
  const onOpenChange = vi.fn();
  const onCopyView = vi.fn();
  const utils = render(
    <ContextBar
      segments={SEGMENTS}
      open={null}
      onOpenChange={onOpenChange}
      onCopyView={onCopyView}
      copied={false}
      savedViews={<button type="button">Vistas guardadas</button>}
      {...over}
    />,
  );
  return { ...utils, onOpenChange, onCopyView };
}

describe("ContextBar — the answer is on screen, not behind a click", () => {
  it("states the period and the layer count as text, without opening anything", () => {
    renderBar();
    // NOTE the deliberately weak verb: jsdom loads no stylesheet, so
    // `toBeVisible()` cannot see Tailwind's `.sr-only`. Presence is all this
    // proves — the sr-only guard is the next test, which is the one that fails
    // when the value gets hidden.
    expect(screen.getByText("últimos 90 días")).toBeInTheDocument();
    expect(screen.getByText("3 capas")).toBeInTheDocument();
  });

  it("does NOT hide the value in sr-only — only the verb is", () => {
    renderBar();
    const value = screen.getByText("3 capas");
    expect(value).not.toHaveClass("sr-only");
    expect(value.closest(".sr-only")).toBeNull();
    // ...and the verb IS there, leading the accessible name.
    expect(screen.getByTestId("panorama-context-filtro")).toHaveTextContent(
      /Cambiar capas del mapa\. Actualmente:/,
    );
  });

  it("never ships a bare integer badge — it says what it counts", () => {
    renderBar();
    const badge = screen.getByText("2");
    expect(badge).toHaveAttribute("aria-label", "2 ajustes sobre la vista");
    expect(badge).toHaveAttribute("title", "2 ajustes sobre la vista");
  });
});

describe("ContextBar — disclosure semantics", () => {
  it("declares aria-expanded and points aria-controls at the panel that is actually rendered", () => {
    const { rerender, onOpenChange } = renderBar();
    const trigger = screen.getByTestId("panorama-context-periodo");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("periodo-body")).toBeNull();

    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith("periodo");

    rerender(
      <ContextBar
        segments={SEGMENTS}
        open="periodo"
        onOpenChange={onOpenChange}
        onCopyView={() => {}}
        copied={false}
        savedViews={null}
      />,
    );
    const openTrigger = screen.getByTestId("panorama-context-periodo");
    expect(openTrigger).toHaveAttribute("aria-expanded", "true");
    const controlled = openTrigger.getAttribute("aria-controls");
    expect(controlled).toBeTruthy();
    // The id must resolve to a real node — a dangling aria-controls is the
    // failure mode a "the attribute is present" assertion would miss.
    const panel = document.getElementById(controlled as string);
    expect(panel).not.toBeNull();
    expect(panel).toContainElement(screen.getByTestId("periodo-body"));
  });

  it("clicking the OPEN segment closes it (toggle, not re-open)", () => {
    const { onOpenChange } = renderBar({ open: "periodo" });
    fireEvent.click(screen.getByTestId("panorama-context-periodo"));
    expect(onOpenChange).toHaveBeenCalledWith(null);
  });

  it("renders AT MOST one panel: opening another segment replaces, never adds", () => {
    renderBar({ open: "periodo" });
    expect(screen.getByTestId("periodo-body")).toBeInTheDocument();
    expect(screen.queryByTestId("filtro-body")).toBeNull();

    cleanup();
    renderBar({ open: "filtro" });
    expect(screen.getByTestId("filtro-body")).toBeInTheDocument();
    expect(screen.queryByTestId("periodo-body")).toBeNull();
  });

  it("Esc closes and returns focus to the trigger that opened it", () => {
    const { onOpenChange } = renderBar({ open: "filtro" });
    const trigger = screen.getByTestId("panorama-context-filtro");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(null);
    expect(trigger).toHaveFocus();
  });

  it("a pointer press outside the bar closes the open panel", () => {
    const { onOpenChange } = renderBar({ open: "filtro" });
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).toHaveBeenCalledWith(null);
  });

  it("Esc does nothing while nothing is open (no listener, no spurious close)", () => {
    const { onOpenChange } = renderBar({ open: null });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("the panel's own Cerrar button closes it and restores focus", () => {
    const { onOpenChange } = renderBar({ open: "periodo" });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(onOpenChange).toHaveBeenCalledWith(null);
    expect(screen.getByTestId("panorama-context-periodo")).toHaveFocus();
  });
});

describe("ContextBar — the mobile row must not clip the panel it opens", () => {
  it("scrolls horizontally while CLOSED (the ~390px pill row)", () => {
    renderBar({ open: null });
    const row = screen.getByTestId("panorama-context-bar").firstElementChild;
    expect(row?.className).toContain("overflow-x-auto");
  });

  it("stops scrolling while a panel is OPEN, so the panel is not cut off at the row edge", () => {
    renderBar({ open: "periodo" });
    const row = screen.getByTestId("panorama-context-bar").firstElementChild;
    expect(row?.className).not.toContain("overflow-x-auto");
  });
});

describe("ContextBar — the actions are the console's existing ones", () => {
  it("fires the console's copyView callback and confirms it in place", () => {
    const { onCopyView } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: /Copiar vista/ }));
    expect(onCopyView).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("· copiada")).toBeNull();

    cleanup();
    renderBar({ copied: true });
    expect(screen.getByText("· copiada")).toBeVisible();
  });

  it("mounts the saved-views popover the caller passes — the bar owns no second copy", () => {
    renderBar();
    expect(screen.getAllByRole("button", { name: "Vistas guardadas" })).toHaveLength(1);
  });
});
