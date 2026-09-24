// The ContextBar's contract with the rail: it CITES, it never forks.
//
// The bar exists because "¿qué estoy mirando y de qué período?" was answered in
// four-to-six places at once. A bar that recomputes those answers would be the
// fifth. These tests pin the two ways that could silently happen:
//
//   1. a segment stops citing a shared derivation and hardcodes/re-derives it;
//   2. a segment's id drifts from the rail panel id it is supposed to share
//      state with — which does not throw, does not fail typecheck, and quietly
//      produces a SECOND panel instance opened from the other trigger.

import { describe, expect, it } from "vitest";

import type { RailItem } from "@/components/panorama/PanoramaRail";
import { buildContextSegments, railPanelBody } from "@/components/panorama/context-bar-model";

const RAIL_ITEMS: RailItem[] = [
  {
    id: "periodo",
    icon: "periodo",
    label: "Período",
    kind: "panel",
    detail: true,
    render: (detail) => `periodo-body:${detail}`,
  },
  {
    id: "filtro",
    icon: "capas",
    label: "Capas del mapa",
    kind: "panel",
    detail: true,
    render: (detail) => `filtro-body:${detail}`,
  },
  { id: "actualizar", icon: "actualizar", label: "Actualizar", kind: "action", onClick: () => {} },
];

function segments(over: Partial<Parameters<typeof buildContextSegments>[0]> = {}) {
  return buildContextSegments({
    railItems: RAIL_ITEMS,
    periodLabel: "últimos 90 días",
    activeLayerCount: 3,
    modifierCount: 2,
    ...over,
  });
}

describe("railPanelBody — one definition, therefore one instance", () => {
  it("returns the rail item's OWN render output, at the item's own detail tier", () => {
    // Not a copy, not a re-render with different arguments: the bar shows the
    // exact body the rail icon would show.
    expect(railPanelBody(RAIL_ITEMS, "periodo")).toBe("periodo-body:true");
    expect(railPanelBody(RAIL_ITEMS, "filtro")).toBe("filtro-body:true");
  });

  it("returns null for an ACTION rail item — actions have no panel to share", () => {
    // Dropping the `kind === "panel"` guard makes this throw "item.render is not
    // a function" (verified by mutation). Noted honestly: a mutant that keeps a
    // `render` truthiness check SURVIVES this test, because the two guards are
    // redundant at runtime — `kind` is what keeps the types honest, `render`
    // presence is what the behavior actually rests on.
    expect(railPanelBody(RAIL_ITEMS, "actualizar")).toBeNull();
  });

  it("returns null for an id the rail does not have", () => {
    expect(railPanelBody(RAIL_ITEMS, "no-existe")).toBeNull();
  });
});

describe("buildContextSegments — every value is a citation", () => {
  it("EVERY segment id is a real rail PANEL id — this is what makes the state shared", () => {
    // The single-instance invariant is enforced by id equality and nothing else.
    // Rename "filtro" here (or there) and both triggers keep working while
    // quietly owning two different panels.
    for (const segment of segments()) {
      const railItem = RAIL_ITEMS.find((i) => i.id === segment.id);
      expect(railItem, `segment "${segment.id}" has no rail panel to share`).toBeDefined();
      expect(railItem?.kind).toBe("panel");
    }
  });

  it("the período segment shows the caller's period label verbatim", () => {
    const periodo = segments({ periodLabel: "estado actual · al 12/03/2026" }).find(
      (s) => s.id === "periodo",
    );
    expect(periodo?.value).toBe("estado actual · al 12/03/2026");
  });

  it("capitalizes the período in CSS, never by forking the string", () => {
    // `periodLabel` is a mid-sentence phrase in the caption, the PNG footer and
    // the informe. A second, capitalized variant is a second source of truth.
    const periodo = segments().find((s) => s.id === "periodo");
    expect(periodo?.value).toBe("últimos 90 días");
    expect(periodo?.valueClassName).toContain("first-letter:uppercase");
  });

  it("the capas segment shows the ACTIVE LAYER count, pluralized by the shared helper", () => {
    expect(segments({ activeLayerCount: 1 }).find((s) => s.id === "filtro")?.value).toBe("1 capa");
    expect(segments({ activeLayerCount: 3 }).find((s) => s.id === "filtro")?.value).toBe("3 capas");
    expect(segments({ activeLayerCount: 0 }).find((s) => s.id === "filtro")?.value).toBe("0 capas");
  });

  it("the badge is the MODIFIER count, and it is never the same number as the value", () => {
    // Four figures for "cuántas capas" is exactly the defect this screen keeps
    // reproducing. These two numbers are different questions and must stay so.
    const capas = segments({ activeLayerCount: 3, modifierCount: 2 }).find(
      (s) => s.id === "filtro",
    );
    expect(capas?.value).toBe("3 capas");
    expect(capas?.badge).toBe(2);
  });

  it("the badge always carries an accessible name — a bare integer never ships", () => {
    // The rail learned this (filtroBadgeAriaLabel); the bar must not relearn it.
    for (const count of [1, 2, 7]) {
      const capas = segments({ modifierCount: count }).find((s) => s.id === "filtro");
      expect(capas?.badgeLabel).toBe(
        count === 1 ? "1 ajuste sobre la vista" : `${count} ajustes sobre la vista`,
      );
      expect(capas?.badgeLabel).not.toBe(String(count));
    }
  });

  it("every segment names the ACT for assistive tech and keeps its value visible", () => {
    // ScopePillSummary.tsx's lesson, generalized: the verb may be sr-only, the
    // VALUE may not. `changeLabel` is the verb slot; `value` is rendered plain.
    for (const segment of segments()) {
      expect(segment.changeLabel, `segment "${segment.id}" has no verb`).toBeTruthy();
      expect(segment.value).toBeTruthy();
      expect(segment.panelTitle).toBeTruthy();
    }
  });
});
