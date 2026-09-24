"use client";

// LayerPanel — the legend-as-control (spec §4: the layer list IS the legend).
//
// One toggle per layer: a color swatch + label + live feature count, plus a
// "suprimido" badge when k-anon hid cells and a "capá al máximo (2.000)" note
// when the per-layer cap truncated the result. Toggling a layer asks the parent
// to fetch /api/panorama/[layer] (or drop it). The panel is purely
// presentational — fetch + map mutation live in the parent console.
//
// map-QOL: layers are grouped by their compatibility ROLE (F2, see
// src/modules/panorama/domain/compatibility.ts) so the slot rules are visible
// instead of implicit: BASE layers are exclusive (activating one swaps out the
// current one — radio-like behavior, handled by the parent's onToggle), SIGNAL
// allows at most one, REFERENCE layers stack freely. The progressive-disclosure
// wrapper ("Personalizar") is owned by the parent console — this component
// renders only the grouped list.

import { pluralizeEs } from "@/lib/utils/format";
import { type LayerRole, roleOf } from "@/src/modules/panorama/domain/compatibility";
import { PANORAMA_LAYERS, isTemporalLayer } from "@/src/modules/panorama/domain/layers";
import type { LayerId } from "@/src/modules/panorama/domain/types";

/** Per-layer runtime state surfaced in the legend. */
export type LayerPanelState = {
  active: boolean;
  loading: boolean;
  /** Plotted feature count (after privacy filtering). */
  count: number;
  /** k-anon suppressed cell count (choropleth only); 0 otherwise. */
  suppressedCount: number;
  noLocalityCount?: number;
  /** The 2.000 per-layer cap clipped the result. */
  truncated: boolean;
  /**
   * Honesty (panorama QA 2026-07-14): the last fetch for this layer returned
   * the server's BUDGET/FAILURE fallback, not a real answer — the empty map
   * must read "no pudimos calcular esta capa a tiempo", never "sin datos".
   */
  degraded?: boolean;
  /**
   * F2 compatibility: set when this inactive layer cannot be toggled on due
   * to a compatibility conflict (e.g. a second base or a second signal).
   * The string is an es-AR hint explaining WHY the layer is blocked.
   * Only present on inactive layers — active layers never carry a hint.
   * Cleared automatically once the conflict is resolved.
   */
  compatibilityHint?: string;
};

type Props = {
  states: Record<LayerId, LayerPanelState>;
  onToggle: (id: LayerId) => void;
  /** F4: a time scrub is active — non-temporal layers are flagged not reproducible. */
  scrubbing?: boolean;
  /** map-QOL: per-layer opacity multiplier (0.2..1, default 1). */
  opacities?: Partial<Record<LayerId, number>>;
  /** map-QOL: opacity slider change — only rendered for ACTIVE layers. */
  onOpacity?: (id: LayerId, value: number) => void;
  /**
   * task #78 Part 3: the "solo firmado por matrícula" toggle state. Only the
   * `cobertura` (rabies-coverage) layer honors it; when on, the choropleth counts
   * only vet-signed doses in its numerator.
   */
  verifiedOnly?: boolean;
  /**
   * task #78 Part 3: flip the vet-signed numerator toggle. Rendered ONLY for the
   * active `cobertura` layer. Absent → the checkbox is not shown.
   */
  onToggleVerified?: (id: LayerId) => void;
};

/** Role groups in display order, with es-AR titles that state the slot rule. */
const ROLE_GROUPS: readonly { role: LayerRole; title: string }[] = [
  { role: "base", title: "Base — una a la vez" },
  { role: "signal", title: "Señal — una a la vez" },
  { role: "reference", title: "Referencia — combinables" },
];

export function LayerPanel({
  states,
  onToggle,
  scrubbing = false,
  opacities = {},
  onOpacity,
  verifiedOnly = false,
  onToggleVerified,
}: Props) {
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">Capas del mapa</legend>
      {ROLE_GROUPS.map(({ role, title }) => {
        const layers = PANORAMA_LAYERS.filter((l) => roleOf(l) === role);
        if (layers.length === 0) return null;
        return (
          <div key={role} className="space-y-1">
            <p className="text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute">{title}</p>
            <ul className="space-y-1">
              {layers.map((layer) => {
                const st = states[layer.id];
                const active = st?.active ?? false;
                // Under a scrub, layers with no time dimension can't be reproduced
                // as-of-t — flag and visually de-emphasise them in the legend.
                const notReproducible = scrubbing && !isTemporalLayer(layer.id);
                // F2 compatibility: an inactive layer may be blocked due to a
                // conflict with the currently active set. The hint explains why.
                const compatibilityHint = !active
                  ? (st?.compatibilityHint ?? undefined)
                  : undefined;
                const isBlocked = Boolean(compatibilityHint);
                return (
                  <li key={layer.id}>
                    <label
                      className={`flex min-h-11 items-center gap-2.5 rounded-[var(--radius-md)] px-1.5 py-1 text-sm text-ln-op-ink-2 ${
                        isBlocked
                          ? "cursor-not-allowed opacity-40"
                          : "cursor-pointer hover:bg-ln-op-card"
                      } ${notReproducible ? "opacity-50" : ""}`}
                      title={compatibilityHint}
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-current"
                        checked={active}
                        disabled={isBlocked}
                        aria-disabled={isBlocked}
                        aria-describedby={isBlocked ? `compat-hint-${layer.id}` : undefined}
                        onChange={() => {
                          if (!isBlocked) onToggle(layer.id);
                        }}
                      />
                      <span
                        className="inline-block h-3 w-3 shrink-0 rounded-full border border-ln-op-line"
                        style={{ background: layer.color }}
                        aria-hidden="true"
                      />
                      <span className="flex-1">{layer.label}</span>
                      {notReproducible && (
                        <span
                          className="rounded-full border border-ln-op-line bg-ln-op-card px-1.5 py-0.5 text-xs text-ln-op-mute"
                          title="Esta capa no tiene dimensión temporal: muestra el estado actual, no reproducible en el tiempo."
                        >
                          no reproducible en el tiempo
                        </span>
                      )}
                      {st?.loading && (
                        <span className="text-sm text-ln-op-mute" aria-live="polite">
                          cargando…
                        </span>
                      )}
                      {active && !st?.loading && (
                        <span className="tabular-nums text-sm text-ln-op-mute">
                          {st.count.toLocaleString("es-AR")}
                        </span>
                      )}
                      {active && !st?.loading && st.suppressedCount > 0 && (
                        <span
                          className="rounded-full border border-ln-op-line bg-ln-op-card px-1.5 py-0.5 text-xs text-ln-op-mute"
                          title="Celdas ocultas por privacidad (k-anonimato, k=5)"
                        >
                          {st.suppressedCount} {pluralizeEs(st.suppressedCount, "suprimido")}
                        </span>
                      )}
                      {active && !st?.loading && (st.noLocalityCount ?? 0) > 0 && (
                        <span
                          className="rounded-full border border-ln-op-line bg-ln-op-card px-1.5 py-0.5 text-xs text-ln-op-mute"
                          title="Registros con provincia pero sin localidad asignada — visibles en el nivel provincial, no en este mapa"
                        >
                          {st.noLocalityCount} sin localidad
                        </span>
                      )}
                      {active && !st?.loading && st.truncated && (
                        <span
                          className="rounded-full border border-ln-op-warn-bd bg-ln-op-warn-bg px-1.5 py-0.5 text-xs text-ln-op-ink-2"
                          title="Se alcanzó el tope por capa; hay más registros fuera de la vista."
                        >
                          capá al máximo (2.000)
                        </span>
                      )}
                      {isBlocked && (
                        <span
                          className="rounded-full border border-ln-op-line bg-ln-op-card px-1.5 py-0.5 text-xs text-ln-op-mute"
                          aria-hidden="true"
                        >
                          bloqueada
                        </span>
                      )}
                    </label>
                    {/* Inline helper text — visible (not color-only), associated to the
                      checkbox via aria-describedby. Placed outside the <label> so it
                      renders below the row and is perceivable without relying on color. */}
                    {isBlocked && compatibilityHint && (
                      <p
                        id={`compat-hint-${layer.id}`}
                        className="mt-0.5 px-1.5 text-xs text-ln-op-mute"
                        role="note"
                      >
                        {compatibilityHint}
                      </p>
                    )}
                    {/* map-QOL: per-layer opacity slider — advanced control,
                        only for ACTIVE layers, lives inside Personalizar. */}
                    {active && onOpacity && (
                      <div className="flex items-center gap-2 px-1.5 pb-0.5 pl-8">
                        <label htmlFor={`opacity-${layer.id}`} className="text-xs text-ln-op-mute">
                          Opacidad
                        </label>
                        <input
                          id={`opacity-${layer.id}`}
                          type="range"
                          min={0.2}
                          max={1}
                          step={0.1}
                          value={opacities[layer.id] ?? 1}
                          onChange={(e) => onOpacity(layer.id, Number(e.target.value))}
                          className="h-1.5 w-24 accent-current"
                          aria-label={`Opacidad de la capa ${layer.label}`}
                        />
                        <span className="tabular-nums text-xs text-ln-op-mute">
                          {Math.round((opacities[layer.id] ?? 1) * 100)}%
                        </span>
                      </div>
                    )}
                    {/* task #78 Part 3 — "solo firmado por matrícula": narrows the
                        rabies-coverage numerator to vet-signed doses. ONLY the
                        active cobertura layer shows it.
                        Discoverability (staging QA 2026-07-08 #3): rendered as a
                        bordered, non-muted control CARD (not a tiny grey line that
                        reads as part of the opacity slider) with a caption that
                        explains what it does, so an operator finds it at a glance
                        when the antirrábica-coverage layer is active. */}
                    {active && onToggleVerified && layer.id === "cobertura" && (
                      <div className="mt-1 mr-1.5 ml-8">
                        <label className="flex cursor-pointer items-start gap-2 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-2 py-1.5 text-ln-op-ink-2 transition-colors hover:border-ln-op-ink-2">
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 shrink-0 accent-current"
                            checked={verifiedOnly}
                            onChange={() => onToggleVerified(layer.id)}
                          />
                          <span className="flex flex-col gap-0.5">
                            <span className="text-xs font-semibold">
                              Solo firmado por matrícula
                            </span>
                            <span className="text-xs leading-snug text-ln-op-mute">
                              Cuenta solo las dosis firmadas por un veterinario matriculado
                              (verificado) — la porción que el registro oficial cuenta como «al
                              día».
                            </span>
                          </span>
                        </label>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </fieldset>
  );
}
