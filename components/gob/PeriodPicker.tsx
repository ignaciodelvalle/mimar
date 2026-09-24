"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { useCommittedPeriod } from "@/components/panorama/committed-period-context";
import {
  PRESET_3Y,
  PRESET_5Y,
  PRESET_30D,
  PRESET_90D,
  PRESET_YTD,
  type PeriodPresetId,
} from "@/lib/metrics/period-presets";
import { serverNavCommit } from "@/lib/ui/filter-commit";

import { DateRangePicker } from "./DateRangePicker";
import type { DateRange } from "./DateRangePicker";

/**
 * Selector de período para dashboards.
 *
 * Chips de presets (7d / 30d / 90d / ytd) + toggle "Personalizado" que despliega
 * el `<DateRangePicker>` inline. Cada selección actualiza los searchParams vía
 * una navegación de documento completa (`window.location.assign`) — NO usa
 * `router.replace`/`router.refresh` (ver nota de diseño más abajo, misma
 * razón que JurisdictionSwitcher.tsx).
 *
 * Comportamiento:
 *  - Seleccionar un preset → setea `?period=<preset>` y limpia `?from` y `?to`.
 *  - Seleccionar "Personalizado" → setea `?period=custom`. El DateRangePicker
 *    aparece; al completar el rango setea `?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 *  - El chip activo queda visualmente destacado (fondo ln-azul / texto blanco).
 *
 * Accesibilidad:
 *  - Cada chip es un `<button>` con `aria-pressed` para indicar el estado activo.
 *  - Focus ring visible en todos los chips (global focus ring de globals.css).
 *  - El DateRangePicker ya provee labels propios via htmlFor.
 *
 * @example
 * ```tsx
 * <PeriodPicker defaultPreset="30d" />
 * ```
 */

// Alias kept for existing consumers (PeriodPanel.tsx and friends import
// `PeriodPreset` from here). The canonical id union now lives in
// lib/metrics/period-presets.ts, shared with PeriodPanel.tsx — see that
// module for why the (id, label) pairs are only partially centralized.
export type PeriodPreset = PeriodPresetId;

export type PeriodPickerProps = {
  /** Preset por defecto cuando no hay searchParam. Default "30d". */
  defaultPreset?: PeriodPreset;
  /** Clave del searchParam para el preset. Default "period". */
  presetParamKey?: string;
  /** Claves de searchParam para el rango personalizado. Default { from: "from", to: "to" }. */
  customParamKeys?: { from: string; to: string };
  /**
   * Mostrar los chips multi-año ("3 años" / "5 años"). Solo lo usa el Panorama,
   * cuya reproducción temporal abarca la historia sembrada (varios años). Los
   * dashboards de detalle NO los muestran (mantienen su ventana corta). Default false.
   */
  multiYear?: boolean;
  className?: string;
};

type PresetConfig = {
  value: PeriodPreset;
  label: string;
};

// 30d/90d/ytd are single-sourced from lib/metrics/period-presets (identical
// label in PeriodPanel.tsx); 7d/trailing12m keep their PeriodPicker-specific
// copy locally — see the module doc comment there for why.
const PRESETS: PresetConfig[] = [
  { value: "7d", label: "Últimos 7 días" },
  PRESET_30D,
  PRESET_90D,
  { value: "trailing12m", label: "Últimos 12 meses" },
  PRESET_YTD,
];

/** Multi-year chips appended only when `multiYear` is set (Panorama-only). */
const MULTI_YEAR_PRESETS: PresetConfig[] = [PRESET_3Y, PRESET_5Y];

// Operator-only component (rendered exclusively on /gob, /admin dashboards,
// OpFilterBar and Panorama) — uses ln-op-* tokens, not the citizen ln-*
// palette (audit 2026-07-19, consistency/skin-validation).
const chipBase =
  "inline-flex items-center px-3.5 py-1.5 rounded-full text-sm font-medium border " +
  "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul focus-visible:ring-offset-1 " +
  "min-h-11 cursor-pointer";

const chipActive = "bg-ln-op-azul text-white border-ln-op-azul";
const chipInactive =
  "bg-ln-op-card text-ln-op-ink-2 border-ln-op-line hover:border-ln-op-line-2 hover:text-ln-op-ink";

export function PeriodPicker({
  defaultPreset = "30d",
  presetParamKey = "period",
  customParamKeys = { from: "from", to: "to" },
  multiYear = false,
  className = "",
}: PeriodPickerProps) {
  const searchParams = useSearchParams();
  // W2 fix: a shallow client-side period commit (Panorama presets) isn't visible
  // to useSearchParams(); prefer the console's committed period so the active chip
  // matches the loaded data. null (no provider / nothing committed) → searchParams.
  const committedPeriod = useCommittedPeriod();

  const presets = multiYear ? [...PRESETS, ...MULTI_YEAR_PRESETS] : PRESETS;

  const activePreset =
    (committedPeriod as PeriodPreset | null) ??
    (searchParams.get(presetParamKey) as PeriodPreset | null) ??
    defaultPreset;

  const fromValue = searchParams.get(customParamKeys.from) ?? null;
  const toValue = searchParams.get(customParamKeys.to) ?? null;

  // Estado local del DateRangePicker (controlled).
  const [customRange, setCustomRange] = useState<DateRange>({
    from: fromValue,
    to: toValue,
  });

  // Design note (router-drop defect, engram #621/#622 — same reasoning as
  // JurisdictionSwitcher.tsx / components/gob/JurisdictionSwitcher.tsx and
  // fixed here for the identical reason, noted as adjacent debt in
  // b0a5c7af): dashboards on this surface (Panorama, vigilancia, etc.) are
  // SERVER-rendered from `searchParams` on every request, so a
  // client-router transition (router.replace/router.refresh) is exposed to
  // Next 15.5.18's App Router silently dropping its own RSC fetch in
  // production. A full document navigation is the one mechanism proven
  // immune — the browser's native GET cannot be silently dropped, and it
  // always re-runs the server component with the new searchParams.
  function updateParams(updates: Record<string, string | null>) {
    serverNavCommit(searchParams.toString())(updates);
  }

  function handlePresetClick(preset: PeriodPreset) {
    setCustomRange({ from: null, to: null });
    updateParams({
      [presetParamKey]: preset,
      [customParamKeys.from]: null,
      [customParamKeys.to]: null,
    });
  }

  function handleCustomRangeChange(range: DateRange) {
    setCustomRange(range);
    // Solo persistimos cuando ambos extremos están definidos.
    if (range.from && range.to) {
      updateParams({
        [presetParamKey]: "custom",
        [customParamKeys.from]: range.from,
        [customParamKeys.to]: range.to,
      });
    }
  }

  return (
    <div className={`flex flex-col gap-3 ${className}`.trim()}>
      {/* Fila de chips */}
      <fieldset className="flex flex-wrap gap-2 border-none p-0 m-0">
        <legend className="sr-only">Seleccionar período</legend>
        {presets.map(({ value, label }) => {
          const isActive = activePreset === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={isActive}
              onClick={() => handlePresetClick(value)}
              className={`${chipBase} ${isActive ? chipActive : chipInactive}`}
            >
              {label}
            </button>
          );
        })}

        {/* Toggle "Personalizado" */}
        <button
          type="button"
          aria-pressed={activePreset === "custom"}
          onClick={() => handlePresetClick("custom")}
          className={`${chipBase} ${activePreset === "custom" ? chipActive : chipInactive}`}
        >
          Personalizado
        </button>
      </fieldset>

      {/* DateRangePicker inline — solo visible cuando preset === "custom" */}
      {activePreset === "custom" && (
        <DateRangePicker value={customRange} onChange={handleCustomRangeChange} />
      )}
    </div>
  );
}
