"use client";

// All-suppressed in-map notice — visual review 2026-07-23 (#1).
//
// When the base layer HAS data in scope but EVERY plotted unit is k-anon
// suppressed, the canvas is 100% hatch/grey and the only explanation was an
// unanchored hover tooltip — operators read it as a broken map. This module
// owns both halves of the fix, extracted from PanoramaConsole/SituationalMap
// (fase-3 split discipline — neither file may keep growing):
//
//   buildAllSuppressedNotice — the console-side derivation. Composes an
//     anchored corner-card text: the privacy treatment at the grain being
//     plotted, plus — only when it carries information — the layer's own
//     headline KPI (KPI_RELATED_LAYERS is the same subject mapping the
//     relevance gate uses). The KPI value is already rendered in the metrics
//     column, so this discloses nothing new and issues no query. It is NOT
//     called "the scope total": see the RA-7 F2 note at the composition site —
//     a Σ(published cells) headline is a sum over nothing in precisely this
//     frame, and a zero there reads as "nothing happened", not as "protegido".
//     Null (card hidden) whenever at least one unit paints a real
//     value — the map explains itself then. Covers BOTH suppression
//     conventions: layers whose server envelope OMITS suppressed cells
//     (features empty, suppressedCount discloses them) and layers that ship
//     them flagged `suppressed: true` (every plotted feature hatched) —
//     `every` is vacuously true on [].
//
//   AllSuppressedNoticeCard — the SituationalMap-side card, anchored
//     bottom-right (bottom-left belongs to the console's LegendPill, top
//     corners to the control clusters; the CabaInset docks top-right ABOVE
//     this). Same card family as the on-canvas controls. pointer-events-none:
//     the geography (hover/click on hatched cells) stays reachable under it.
//     `hidden` mirrors the centered empty overlay's visibility — the two must
//     never stack: when every suppressed cell is OMITTED from the payload the
//     map is truly markless and the centered overlay already states the k-anon
//     treatment; this card covers the OTHER convention (cells shipped
//     flagged+hatched, renderableCount > 0, centered overlay suppressed →
//     previously no notice at all, the "100% grey map" finding).

import { KPI_RELATED_LAYERS } from "@/src/modules/panorama/domain/metric-relevance";
import type { LayerId, PanoramaKpiId } from "@/src/modules/panorama/domain/types";

/** Structural subsets — the console's richer types satisfy these without this
 *  module importing the console/map component graph. */
type NoticeLayerState = { active: boolean; loading: boolean; suppressedCount: number };
type NoticeActiveLayer = {
  id: string;
  /** The grain the layer is actually plotting — the card names it (RA-7 F2). */
  level?: string;
  features: { features: Array<{ properties: unknown }> };
};
type NoticeKpi = { id: PanoramaKpiId; label: string; value: string };

/**
 * Whether a PRE-FORMATTED KPI string is numerically zero — "0", "0%", "0,0%",
 * "0 casos" all qualify; "10" and "0,4%" do not.
 *
 * RA-7 F2 needs this because the notice only ever sees the rendered string, and
 * a zero is the one value it must never republish (see below).
 */
function readsAsZero(value: string): boolean {
  const digits = value.replace(/[^\d]/g, "");
  return digits.length > 0 && /^0+$/.test(digits);
}

export function buildAllSuppressedNotice(args: {
  /** The base (caption) layer painting the map, or null. */
  captionLayer: { id: LayerId } | null;
  /** Per-layer runtime state (the console's LayerPanelState record). */
  states: Record<string, NoticeLayerState | undefined>;
  /** The layers currently mounted on the map (with their features). */
  activeLayers: ReadonlyArray<NoticeActiveLayer>;
  /** The headline KPI strip payload (id + pre-formatted label/value). */
  kpis: ReadonlyArray<NoticeKpi>;
}): string | null {
  const { captionLayer, states, activeLayers, kpis } = args;
  if (captionLayer === null) return null;
  const st = states[captionLayer.id];
  if (!st?.active || st.loading || st.suppressedCount === 0) return null;
  const live = activeLayers.find((l) => l.id === captionLayer.id);
  if (!live) return null;
  const allHidden = live.features.features.every(
    (f) => (f.properties as { suppressed?: boolean } | null)?.suppressed === true,
  );
  if (!allHidden) return null;
  // RA-7 F2 (minor): the copy said "Detalle por localidad" at every grain,
  // including frames whose plotted units ARE provinces. Name the grain the layer
  // is painting — a card that misdescribes what is hidden is a card the operator
  // learns to skim.
  const grain = live.level === "province" ? "provincia" : "localidad";
  const kpi = kpis.find((k) => KPI_RELATED_LAYERS[k.id]?.includes(captionLayer.id));
  // RA-7 F2 — THE ZERO THIS CARD MUST NOT REPUBLISH.
  //
  // This clause used to read "— {label}: {value} en el total del alcance", and
  // it is composed in EXACTLY the frame where every plotted unit is k-anon
  // protected. Any headline that is Σ(published cells) — mortalidad is built
  // that way on purpose, skipping suppressed provinces so the total cannot be
  // reversed by differencing (get-panorama-kpis.ts) — is then a sum over
  // NOTHING, i.e. 0. So an operator scoped to one province with 1-4 deceased
  // read a card that asserted "Mortalidad registrada: 0 en el total del alcance"
  // and admitted the detail was hidden in the same breath. A confident zero is
  // the single most misleading substitution available here: it does not read as
  // "protegido", it reads as "nadie se murió".
  //
  // Two changes, both about not claiming more than is known:
  //  · a zero is DROPPED. There is no informative aggregate to publish when the
  //    only cells in scope are the hidden ones, and silence beats a false floor.
  //  · a non-zero is no longer called "el total del alcance". The card cannot
  //    know how the headline was derived, only that it is the number already on
  //    screen in the metrics column — so it says exactly that, and nothing more.
  const aggregate =
    kpi !== undefined && !readsAsZero(kpi.value)
      ? ` — ${kpi.label}: ${kpi.value} (valor publicado para el alcance)`
      : "";
  return `Detalle por ${grain} protegido por privacidad (k<5)${aggregate}.`;
}

export function AllSuppressedNoticeCard({
  notice,
  /** True while SituationalMap's centered empty overlay is visible (see the
   *  file docblock: the card and the overlay must never stack). */
  hidden,
}: {
  notice: string | null;
  hidden: boolean;
}) {
  if (notice === null || hidden) return null;
  return (
    <p
      role="note"
      className="pointer-events-none absolute bottom-3.5 right-3.5 z-10 max-w-xs rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-2 text-xs leading-snug text-ln-op-ink-2 shadow-md"
    >
      {notice}
    </p>
  );
}
