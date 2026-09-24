"use client";

// PeriodPanel — the "Período" rail panel body (task #38 item 2). A FLAT vertical
// radio list of period presets (no nested popover, so it never clips inside the
// rail panel's internal scroll).
//
// Commit semantics (panorama QA root-cause #3b, "Root B"): selecting a preset OR
// a custom {from,to} range commits SHALLOW — exactly like scope/layers/asOf — via
// the console's `onPeriodChange`, which pushes ?period/?from/?to through the
// History API and refetches the board client-side. This SUPERSEDES the former
// full `window.location.assign` reload (the jarring page flash the PO flagged;
// custom ranges used to reload TWICE). Selecting "Personalizado…" now only
// REVEALS the date picker — the single commit fires ONCE both endpoints are set.
//
// Two tiers: Simple = the 4 common windows; Detalle = + año en curso / 3 años /
// 5 años / personalizado (with the DateRangePicker).

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { DateRangePicker } from "@/components/gob/DateRangePicker";
import type { DateRange } from "@/components/gob/DateRangePicker";
import type { PeriodPreset } from "@/components/gob/PeriodPicker";
import {
  PRESET_3Y,
  PRESET_5Y,
  PRESET_30D,
  PRESET_90D,
  PRESET_YTD,
} from "@/lib/metrics/period-presets";

// 30d/90d/ytd/3y/5y are single-sourced from lib/metrics/period-presets
// (identical label in PeriodPicker.tsx); 7d keeps its PeriodPanel-specific
// terser rail copy locally — see that module's doc comment for why.
// trailing12m was unified with PeriodPicker's wording (T2.6, 2026-08-01).
const COMMON: ReadonlyArray<{ value: PeriodPreset; label: string }> = [
  { value: "7d", label: "7 días" },
  PRESET_30D,
  PRESET_90D,
  // T2.6 copy alignment (2026-08-01): "Últimos 12 meses" — the same wording
  // PeriodPicker and the view caption ("últimos 12 meses") use, so the two
  // surfaces never name one window two ways. Supersedes the terser "12 meses"
  // rail copy noted in lib/metrics/period-presets.ts.
  { value: "trailing12m", label: "Últimos 12 meses" },
];

const MORE: ReadonlyArray<{ value: PeriodPreset; label: string }> = [
  PRESET_YTD,
  PRESET_3Y,
  PRESET_5Y,
];

type Props = {
  /** The active period preset id (committed period preferred by the caller). */
  activePeriod: string;
  /** Simple (false) / Detalle (true). */
  detail: boolean;
  from: string | null;
  to: string | null;
  /**
   * Commit a período change SHALLOW (no reload). `period` is a preset id or
   * "custom"; for a "custom" commit the {from,to} window is non-null. Mirrors how
   * the console commits scope/layers/asOf — a History push + a client refetch.
   */
  onPeriodChange: (period: string, from: string | null, to: string | null) => void;
  /**
   * T2.6 — true when EVERY active layer is a current-state snapshot
   * (layerIdsAreAllCurrentState): those layers ignore the period outright, and
   * the header honestly says "Estado actual" while this panel used to show a
   * selected "Últimos 90 días" — two period claims over one screen. When set,
   * the selector grays out with one line saying the período does not apply.
   */
  currentStateOnly?: boolean;
};

export function PeriodPanel({
  activePeriod,
  detail,
  from,
  to,
  onPeriodChange,
  currentStateOnly = false,
}: Props) {
  const [customRange, setCustomRange] = useState<DateRange>({ from, to });
  // "Personalizado…" is expanded when the committed period IS custom, or the
  // operator just revealed the picker (before the range is complete — no commit
  // has fired yet, so activePeriod is still the prior window).
  const [customOpen, setCustomOpen] = useState<boolean>(activePeriod === "custom");
  const customActive = activePeriod === "custom" || customOpen;

  function pick(preset: PeriodPreset) {
    setCustomOpen(false);
    setCustomRange({ from: null, to: null });
    onPeriodChange(preset, null, null);
  }

  function revealCustom() {
    // Reveal the date picker WITHOUT committing — the single commit fires from
    // handleCustomRangeChange once BOTH endpoints are set. This kills the old
    // double-reload (pick "custom" → reload, then pick dates → reload again).
    setCustomOpen(true);
  }

  function handleCustomRangeChange(range: DateRange) {
    setCustomRange(range);
    if (range.from && range.to) onPeriodChange("custom", range.from, range.to);
  }

  const options = detail ? [...COMMON, ...MORE] : COMMON;

  return (
    <fieldset className="m-0 flex flex-col gap-0.5 border-0 p-0">
      <legend className="sr-only">Período</legend>
      {/* T2.6: the header says "Estado actual" for this board — echoing a
          selected window here would claim a filter no number on screen
          respects. Say it once, plainly, and gray the radios out. */}
      {currentStateOnly && (
        <p className="px-2.5 pb-1 text-sm leading-snug text-ln-op-mute">
          Esta vista muestra estado actual; el período no aplica.
        </p>
      )}
      {options.map(({ value, label }) => {
        // No highlighted selection over an inert control (T2.6).
        const isActive = !currentStateOnly && activePeriod === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={isActive}
            disabled={currentStateOnly}
            onClick={() => pick(value)}
            className={`flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
              isActive
                ? "bg-ln-op-azul/10 font-semibold text-ln-op-azul"
                : "text-ln-op-ink hover:bg-ln-op-stripe"
            }`}
          >
            <span aria-hidden="true" className="inline-flex w-3 items-center text-ln-op-azul">
              {isActive ? <Icon name="check" size={12} decorative /> : null}
            </span>
            {label}
          </button>
        );
      })}
      {detail && (
        <>
          <button
            type="button"
            aria-pressed={!currentStateOnly && customActive}
            disabled={currentStateOnly}
            onClick={revealCustom}
            className={`flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
              !currentStateOnly && customActive
                ? "bg-ln-op-azul/10 font-semibold text-ln-op-azul"
                : "text-ln-op-ink hover:bg-ln-op-stripe"
            }`}
          >
            <span aria-hidden="true" className="inline-flex w-3 items-center text-ln-op-azul">
              {!currentStateOnly && customActive ? (
                <Icon name="check" size={12} decorative />
              ) : null}
            </span>
            Personalizado…
          </button>
          {!currentStateOnly && customActive && (
            <div className="mt-1 border-t border-ln-op-line-2 pt-2">
              <DateRangePicker value={customRange} onChange={handleCustomRangeChange} />
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}
