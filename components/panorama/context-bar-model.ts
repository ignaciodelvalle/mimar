// buildContextSegments — what the panorama's ContextBar SAYS, derived once.
//
// Pure, and deliberately so: the bar's whole reason to exist is that a decision
// maker should never have to assemble "¿qué estoy mirando y de qué período?"
// from four surfaces. That only holds if the bar CITES the numbers the rest of
// the screen already publishes instead of computing its own. Keeping the
// derivation here — out of the 5.000-line console, and unit-testable without a
// map — is how that stays checkable.
//
// Every value below is a citation:
//   · `periodLabel`      → `buildViewMeta`'s one period string (dock meta,
//                           Registros caption, PNG footer and informe cite it too)
//   · `activeLayerCount` → `capasCountLabel`, the same helper the dock meta cites
//   · `modifierCount`    → the rail's badge number, carrying the rail's own
//                           accessible name so it can never read as a layer count
//
// Nothing here recomputes a scope label: the scope segment is the
// ScopeDisclosure, which reads `resolveScopeLabel` (scope-truth.ts) directly.

import type { ContextBarSegment } from "@/components/panorama/ContextBar";
import type { RailItem, RailPanelItem } from "@/components/panorama/PanoramaRail";
import { capasCountLabel, filtroBadgeAriaLabel } from "@/components/panorama/panorama-labels";

/**
 * The ONE lookup that makes "same panel, one instance" true: a bar segment's
 * body is the rail item's own `render()` closure, never a second copy of it.
 * Returns null for an unknown or action-only id.
 */
export function railPanelBody(railItems: readonly RailItem[], id: string) {
  const item = railItems.find((i): i is RailPanelItem => i.kind === "panel" && i.id === id);
  return item ? item.render(item.detail) : null;
}

export function buildContextSegments(input: {
  railItems: readonly RailItem[];
  /** `viewMeta.periodLabel` — cited, never re-derived. */
  periodLabel: string;
  /** Layers actually painted on the map. */
  activeLayerCount: number;
  /** Modifiers beyond the vista's defaults — the rail's badge number. */
  modifierCount: number;
}): ContextBarSegment[] {
  const { railItems, periodLabel, activeLayerCount, modifierCount } = input;
  return [
    {
      id: "periodo",
      changeLabel: "período",
      value: periodLabel,
      // `periodLabel` is a mid-sentence phrase everywhere else it appears
      // ("… últimos 90 días."). Capitalizing it in CSS keeps the pill reading
      // like a heading without forking the string into a second variant.
      valueClassName: "first-letter:uppercase",
      panelTitle: "Período",
      render: () => railPanelBody(railItems, "periodo"),
    },
    {
      // The rail's layer panel is still keyed "filtro" internally (H11 renamed
      // only the label); sharing the id is what shares the state.
      id: "filtro",
      changeLabel: "capas del mapa",
      value: capasCountLabel(activeLayerCount),
      badge: modifierCount,
      badgeLabel: filtroBadgeAriaLabel(modifierCount),
      panelTitle: "Capas del mapa",
      render: () => railPanelBody(railItems, "filtro"),
    },
  ];
}
