"use client";

// PanoramaSuppressionNotice — first-class k-anon disclosure (panorama-redesign
// Fase 1). Promotes the "sin localidad" / suppressed-cell badges out of the
// "Personalizar" details so the operator sees the privacy treatment WITHOUT
// any click.
//
// PRIVACY: this component re-renders the SAME envelope counts LayerPanel
// already shows one click away (suppressedCount / noLocalityCount per layer).
// A count OF suppressed cells is not itself a suppressed value — no k=5 math
// is computed, read, or altered here. Never derives a rate from anything.

import type { LayerPanelState } from "@/components/panorama/LayerPanel";
import {
  type SuppressionContribution,
  activeNoLocalityRecords,
  activeSuppressedCells,
} from "@/components/panorama/panorama-console-helpers";
import type { LayerId } from "@/src/modules/panorama/domain/types";

type Props = {
  /** Per-layer runtime state owned by PanoramaConsole (same record LayerPanel gets). */
  states: Record<LayerId, LayerPanelState>;
};

function breakdownTitle(breakdown: SuppressionContribution[]): string {
  return breakdown.map((b) => `${b.label}: ${b.value.toLocaleString("es-AR")}`).join(" · ");
}

// Pill style mirrors the LayerPanel badges (same tokens, text-only — the
// wording itself is the signal, never color alone).
const PILL_CLASS =
  "inline-flex items-center rounded-full border border-ln-op-line bg-ln-op-card px-2.5 py-1 text-xs text-ln-op-mute";

export function PanoramaSuppressionNotice({ states }: Props) {
  // RA-7 F6: this pill and the exported PNG footer answer the SAME question, so
  // they read the SAME function (panorama-console-helpers). They used to be two
  // reduces with two different active/loading rules, and drifted apart on screen
  // for the duration of every refetch.
  const suppressed = activeSuppressedCells(states);
  const noLocality = activeNoLocalityRecords(states);

  if (suppressed.total === 0 && noLocality.total === 0) return null;

  return (
    <div className="flex flex-wrap gap-2" role="note" aria-label="Tratamiento de privacidad">
      {suppressed.total > 0 && (
        <span className={PILL_CLASS} title={breakdownTitle(suppressed.breakdown)}>
          {/* RA-7 F6: NAME THE UNIVERSE. This is the view-wide total — the same
              figure the exported PNG footer carries. The dock's Registros caption
              and the ranking line publish SMALLER numbers because they measure
              narrower sets (one total's own cells; one layer). Without each
              saying what it counts, a reader seeing 12 here and 3 there reads a
              contradiction rather than a subset. */}
          {/* Agreement runs past the noun: with total === 1 this used to read
              "1 celdas … ocultas", disagreeing twice. pluralizeEs handles the
              noun but not the participle, so the two forms are spelled out. */}
          {`${suppressed.total.toLocaleString("es-AR")} ${
            suppressed.total === 1
              ? "celda con menos de 5 casos oculta"
              : "celdas con menos de 5 casos ocultas"
          } por privacidad (k-anonimato) en las capas activas de esta vista`}
        </span>
      )}
      {noLocality.total > 0 && (
        <span className={PILL_CLASS} title={breakdownTitle(noLocality.breakdown)}>
          {`${noLocality.total.toLocaleString("es-AR")} ${
            noLocality.total === 1
              ? "registro sin localidad asignada — visible"
              : "registros sin localidad asignada — visibles"
          } solo a nivel provincial`}
        </span>
      )}
    </div>
  );
}
