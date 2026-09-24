// @vitest-environment jsdom
//
// FiltroPanel — WP2 progressive disclosure.
//
// What these tests defend:
//
//   1. UNDER A VISTA, ONLY ITS LAYERS RENDER BY DEFAULT. The 19-row catalog
//      collapses to the preset-relevant rows plus a single panel-wide
//      expander; the rest must be reachable, never gone.
//   2. AN ACTIVE LAYER IS NEVER SWALLOWED. A hand-activated layer outside the
//      vista's set stays visible without expanding — hiding an active layer
//      would make the map lie about what the panel shows.
//   3. MANUAL MODE SHOWS EVERYTHING. Without a relevant set there is no
//      disclosure and no expander button.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FiltroPanel } from "@/components/panorama/FiltroPanel";
import { initialState } from "@/components/panorama/panorama-console-helpers";
import { PANORAMA_LAYERS } from "@/src/modules/panorama/domain/layers";
import type { LayerId } from "@/src/modules/panorama/domain/types";

afterEach(cleanup);

function renderPanel(opts: {
  relevant?: ReadonlyArray<LayerId> | null;
  activeIds?: ReadonlyArray<LayerId>;
}) {
  const states = initialState();
  for (const id of opts.activeIds ?? []) {
    states[id] = { ...states[id], active: true };
  }
  return render(
    <FiltroPanel
      states={states}
      onToggle={vi.fn()}
      detail={true}
      presetId={null}
      presetRelevantLayerIds={opts.relevant === null ? null : new Set(opts.relevant ?? [])}
    />,
  );
}

describe("FiltroPanel — WP2 progressive disclosure", () => {
  it("renders only the vista-relevant rows plus the expander by default", () => {
    renderPanel({ relevant: ["cobertura"] });

    expect(screen.getByRole("checkbox", { name: /Cobertura/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Zoonosis/ })).not.toBeInTheDocument();

    const expander = screen.getByRole("button", { name: /Ver todas las capas/ });
    expect(expander).toHaveAttribute("aria-expanded", "false");
  });

  it("the expander reveals every catalog row and flips its own label", () => {
    renderPanel({ relevant: ["cobertura"] });

    fireEvent.click(screen.getByRole("button", { name: /Ver todas las capas/ }));

    expect(screen.getAllByRole("checkbox")).toHaveLength(PANORAMA_LAYERS.length);
    const collapse = screen.getByRole("button", { name: /Ver solo las capas de la vista/ });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
  });

  it("an active layer outside the vista's set stays visible without expanding", () => {
    renderPanel({ relevant: ["cobertura"], activeIds: ["zoonosis"] });

    expect(screen.getByRole("checkbox", { name: /Zoonosis/ })).toBeInTheDocument();
  });

  it("manual mode (no relevant set) shows all rows and no expander", () => {
    renderPanel({ relevant: null });

    expect(screen.getAllByRole("checkbox")).toHaveLength(PANORAMA_LAYERS.length);
    expect(screen.queryByRole("button", { name: /Ver todas las capas/ })).not.toBeInTheDocument();
  });
});
