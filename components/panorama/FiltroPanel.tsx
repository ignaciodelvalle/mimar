"use client";

// FiltroPanel — the v3 "Filtro" rail panel (task #38 item 3), replacing the
// broken Capas popover. Root problems it fixes (PO, 2026-07):
//   (a) the popover overflowed below the fixed viewport — the RailPanel body
//       scrolls internally now (max-height inside the viewport);
//   (b) rows were too spaced — tighter rows here (min-h-9, py-1);
//   (c) the counter under-scoped — the rail badge now counts overlays + filter
//       deviations (countFiltroModifiers, panorama-labels.ts), computed by the
//       console.
//
// Two tiers (Simple/Detalle, owned by the console via the RailPanel toggle):
//   Simple  → toggles only (compact).
//   Detalle → toggles + per-layer method note (layer.description) + live counts
//             + the opacity / "solo firmado por matrícula" advanced controls.
//
// Toggling ALWAYS delegates to the parent's onToggle → checkCompatibility (the
// F2 role model is untouched); this is a presentational surface only.

import { useState } from "react";

import type { LayerPanelState } from "@/components/panorama/LayerPanel";
import { activeVistaName, shortLayerLabel } from "@/components/panorama/panorama-labels";
import { OpButton } from "@/components/ui/dashboard/OpButton";
import { type LayerRole, roleOf } from "@/src/modules/panorama/domain/compatibility";
import { PANORAMA_LAYERS, isTemporalLayer } from "@/src/modules/panorama/domain/layers";
import type { PresetId } from "@/src/modules/panorama/domain/presets";
import type { LayerId } from "@/src/modules/panorama/domain/types";

type Props = {
  states: Record<LayerId, LayerPanelState>;
  onToggle: (id: LayerId) => void;
  /** Simple (false) / Detalle (true). */
  detail: boolean;
  /** Active vista — drives the de-dup (rows drop the stem the vista states). */
  presetId: PresetId | null;
  /** F4: a time scrub is active — non-temporal layers flagged not reproducible. */
  scrubbing?: boolean;
  opacities?: Partial<Record<LayerId, number>>;
  onOpacity?: (id: LayerId, value: number) => void;
  verifiedOnly?: boolean;
  onToggleVerified?: (id: LayerId) => void;
  /**
   * LOD disclosure (panorama campaign C2): per-ACTIVE-layer hint shown when the
   * layer's zoom band paints the coarser province/national rollup while the scope
   * is drilled. Keyed by layer id; absent entries render nothing. Purely
   * presentational — the console derives it (lodProvinceRollupHint).
   */
  lodRollupHints?: Partial<Record<LayerId, string>>;
  /**
   * WP2 progressive disclosure: the layer ids the active vista actually uses
   * (base — the ACTIVE metric option's base under a metric-selector vista —
   * plus signal/references). When present, only these rows plus any layer the
   * operator hand-activated render by default; the rest sit behind a single
   * panel-wide "Ver todas las capas" expander. Null/absent (manual mode, no
   * active vista) → all rows render, no expander.
   */
  presetRelevantLayerIds?: ReadonlySet<LayerId> | null;
};

const ROLE_GROUPS: readonly { role: LayerRole; title: string }[] = [
  { role: "base", title: "Base — una a la vez" },
  { role: "signal", title: "Señal — una a la vez" },
  { role: "reference", title: "Referencia — combinables" },
];

export function FiltroPanel({
  states,
  onToggle,
  detail,
  presetId,
  scrubbing = false,
  opacities = {},
  onOpacity,
  verifiedOnly = false,
  onToggleVerified,
  lodRollupHints = {},
  presetRelevantLayerIds = null,
}: Props) {
  const vista = activeVistaName(presetId);
  const [showAll, setShowAll] = useState(false);
  // A row is always visible when it is vista-relevant OR already active (a
  // hand-picked layer must never be swallowed by the collapse); only
  // "inactive ∧ not relevant" hides behind the expander.
  const rowVisible = (id: LayerId): boolean =>
    showAll ||
    presetRelevantLayerIds === null ||
    presetRelevantLayerIds.has(id) ||
    (states[id]?.active ?? false);
  const hiddenCount = PANORAMA_LAYERS.filter((l) => !rowVisible(l.id)).length;
  return (
    <div className="space-y-2">
      {vista && (
        // The vista name is stated ONCE here so the rows below can drop the stem
        // it carries (de-dup, item 5).
        <p className="text-xs text-ln-op-mute">
          Vista · <span className="font-semibold text-ln-op-ink-2">{vista}</span>
        </p>
      )}
      {ROLE_GROUPS.map(({ role, title }) => {
        const layers = PANORAMA_LAYERS.filter((l) => roleOf(l) === role && rowVisible(l.id));
        if (layers.length === 0) return null;
        return (
          <fieldset key={role} className="m-0 space-y-0.5 border-0 p-0">
            <legend className="text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute">
              {title}
            </legend>
            <ul className="space-y-0.5">
              {layers.map((layer) => {
                const st = states[layer.id];
                const active = st?.active ?? false;
                const notReproducible = scrubbing && !isTemporalLayer(layer.id);
                const compatibilityHint = !active
                  ? (st?.compatibilityHint ?? undefined)
                  : undefined;
                const isBlocked = Boolean(compatibilityHint);
                // LOD disclosure — only meaningful on an ACTIVE layer (an inactive
                // layer paints nothing, so there is no coarse rollup to explain).
                const lodHint = active ? lodRollupHints[layer.id] : undefined;
                const rowLabel = shortLayerLabel(presetId, layer.id, layer.label);
                return (
                  <li key={layer.id}>
                    <label
                      className={`flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] px-1.5 py-0.5 text-sm text-ln-op-ink-2 ${
                        isBlocked
                          ? "cursor-not-allowed opacity-40"
                          : "cursor-pointer hover:bg-ln-op-stripe"
                      } ${notReproducible ? "opacity-50" : ""}`}
                      title={compatibilityHint ?? layer.description}
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 shrink-0 accent-current"
                        checked={active}
                        disabled={isBlocked}
                        aria-disabled={isBlocked}
                        aria-describedby={
                          isBlocked
                            ? `filtro-hint-${layer.id}`
                            : lodHint
                              ? `filtro-lod-${layer.id}`
                              : undefined
                        }
                        onChange={() => {
                          if (!isBlocked) onToggle(layer.id);
                        }}
                      />
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-ln-op-line"
                        style={{ background: layer.color }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{rowLabel}</span>
                      {detail && active && !st?.loading && (
                        <span className="shrink-0 tabular-nums text-xs text-ln-op-mute">
                          {st.count.toLocaleString("es-AR")}
                        </span>
                      )}
                      {st?.loading && (
                        <span className="shrink-0 text-xs text-ln-op-mute" aria-live="polite">
                          cargando…
                        </span>
                      )}
                      {detail && active && !st?.loading && st.suppressedCount > 0 && (
                        <span
                          className="shrink-0 rounded-full border border-ln-op-line px-1.5 text-xs text-ln-op-mute"
                          title="Celdas ocultas por privacidad (k-anonimato, k=5)"
                        >
                          {st.suppressedCount} supr.
                        </span>
                      )}
                    </label>
                    {/* Detalle: the honest one-line method note (layer.description). */}
                    {detail && (
                      <p className="px-1.5 pb-1 pl-8 text-xs leading-snug text-ln-op-faint">
                        {layer.description}
                      </p>
                    )}
                    {/* Compatibility hint — visible (not color-only), associated. */}
                    {isBlocked && compatibilityHint && (
                      <p
                        id={`filtro-hint-${layer.id}`}
                        className="px-1.5 pl-8 text-xs text-ln-op-mute"
                      >
                        {compatibilityHint}
                      </p>
                    )}
                    {/* LOD disclosure — this active layer is painting the coarser
                        province/national rollup because the camera is zoomed out,
                        even though the scope reads a drilled province/locality.
                        Visible, associated, and never color-only. */}
                    {lodHint && (
                      <p
                        id={`filtro-lod-${layer.id}`}
                        className="px-1.5 pl-8 text-xs leading-snug text-ln-op-mute"
                        role="note"
                      >
                        {lodHint}
                      </p>
                    )}
                    {/* Detalle advanced controls for the ACTIVE layer. */}
                    {detail && active && onOpacity && (
                      <div className="flex items-center gap-2 px-1.5 pb-1 pl-8">
                        <label
                          htmlFor={`filtro-opacity-${layer.id}`}
                          className="text-xs text-ln-op-mute"
                        >
                          Opacidad
                        </label>
                        <input
                          id={`filtro-opacity-${layer.id}`}
                          type="range"
                          min={0.2}
                          max={1}
                          step={0.1}
                          value={opacities[layer.id] ?? 1}
                          onChange={(e) => onOpacity(layer.id, Number(e.target.value))}
                          className="h-1.5 w-24 accent-current"
                          aria-label={`Opacidad de la capa ${rowLabel}`}
                        />
                      </div>
                    )}
                    {detail && active && onToggleVerified && layer.id === "cobertura" && (
                      <label className="mr-1.5 mb-1 ml-8 flex cursor-pointer items-start gap-2 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-2 py-1.5 text-ln-op-ink-2 hover:border-ln-op-ink-2">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0 accent-current"
                          checked={verifiedOnly}
                          onChange={() => onToggleVerified(layer.id)}
                        />
                        <span className="flex flex-col gap-0.5">
                          <span className="text-xs font-semibold">Solo firmado por matrícula</span>
                          <span className="text-xs leading-snug text-ln-op-mute">
                            Cuenta solo las dosis firmadas por un veterinario matriculado.
                          </span>
                        </span>
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
      {(hiddenCount > 0 || (showAll && presetRelevantLayerIds !== null)) && (
        <OpButton
          variant="ghost"
          size="sm"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
          className="w-fit px-1 py-1 text-xs font-medium text-ln-op-azul hover:underline"
        >
          {showAll ? "Ver solo las capas de la vista" : `Ver todas las capas (${hiddenCount} más)`}
        </OpButton>
      )}
      {!detail && (
        <p className="text-xs leading-snug text-ln-op-faint">
          Cambiá a Detalle para ver qué mide cada capa y sus conteos.
        </p>
      )}
    </div>
  );
}
