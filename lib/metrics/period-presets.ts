// Shared period-preset id+label definitions (Item — dedupe sweep).
//
// <PeriodPicker> (components/gob/PeriodPicker.tsx) and <PeriodPanel>
// (components/panorama/PeriodPanel.tsx) each render their own preset chip
// list, tied together only by the shared `PeriodPreset` id union and
// `resolveAnalyticsPeriod` (lib/analytics/analytics-period.ts). Their two
// label tables used to be hand-copied in both files, which let a rename in
// one silently drift from the other.
//
// This module is the single source for the presets whose id AND label are
// IDENTICAL in both callers today. Each picker still decides which subset it
// EXPOSES and in what order/tiering (PeriodPicker's flat chip row vs
// PeriodPanel's Simple/Detalle two-tier rail) — only the shared (id, label)
// pairs live here.
//
// NOT centralized here — deliberately left local to each component:
//   "7d"          — PeriodPicker: "Últimos 7 días" · PeriodPanel: "7 días"
//   "trailing12m" — PeriodPicker: "Últimos 12 meses" · PeriodPanel: "12 meses"
// These two have surface-specific copy (PeriodPicker's fuller sentence vs
// PeriodPanel's terser rail label). Forcing one shared label would silently
// change visible UI text on one of the two surfaces, so they stay put — flag
// for a follow-up if a copy pass ever wants to unify them intentionally.

// Canonical preset id union. Owned here (not in PeriodPicker.tsx) so this
// module has no dependency on the "use client" component — PeriodPicker.tsx
// re-exports it as `PeriodPreset` so its existing consumers (PeriodPanel.tsx
// and friends) are unaffected.
export type PeriodPresetId = "7d" | "30d" | "90d" | "ytd" | "trailing12m" | "3y" | "5y" | "custom";

/**
 * The SAME vocabulary as `PeriodPresetId`, at runtime (RA-2 F11).
 *
 * A type union alone cannot stop a consumer from hand-rolling its own branch
 * set — `/gob/analytics/export` did exactly that, recognised `"1y"` (a value
 * NOTHING emits), silently defaulted `"trailing12m"` and `"ytd"` to 30 days,
 * and then persisted that wrong window into the export's audit_log row as if
 * it were the requested one. Any consumer that must reject an unrecognised
 * value instead of guessing validates against this array.
 *
 * Derived from an exhaustive `Record<PeriodPresetId, true>` so the two CANNOT
 * drift: a new member of the union fails the typecheck here until it is listed,
 * and a listed id that is not in the union fails too.
 */
const PERIOD_PRESET_PRESENCE: Record<PeriodPresetId, true> = {
  "7d": true,
  "30d": true,
  "90d": true,
  ytd: true,
  trailing12m: true,
  "3y": true,
  "5y": true,
  custom: true,
};

export const PERIOD_PRESET_IDS = Object.keys(PERIOD_PRESET_PRESENCE) as readonly PeriodPresetId[];

/** Runtime membership test for the canonical preset vocabulary. */
export function isPeriodPresetId(value: unknown): value is PeriodPresetId {
  return typeof value === "string" && (PERIOD_PRESET_IDS as readonly string[]).includes(value);
}

export type PeriodPresetOption = {
  value: PeriodPresetId;
  label: string;
};

export const PRESET_30D: PeriodPresetOption = { value: "30d", label: "30 días" };
export const PRESET_90D: PeriodPresetOption = { value: "90d", label: "90 días" };
export const PRESET_YTD: PeriodPresetOption = { value: "ytd", label: "Año en curso" };
export const PRESET_3Y: PeriodPresetOption = { value: "3y", label: "3 años" };
export const PRESET_5Y: PeriodPresetOption = { value: "5y", label: "5 años" };

// ---------------------------------------------------------------------------
// Period-axis single-sourcing (RANK 1 consolidation).
//
// The id→window-length table and the two default-preset constants used to
// live in lib/analytics/analytics-period.ts, separate from the (id, label)
// pairs above. That let the resolver's day counts and the picker's labels
// drift independently even though they describe the SAME axis. Both now live
// here; analytics-period.ts's resolveAnalyticsPeriod (the RESOLVER — ytd/
// custom-range parsing, the "now" anchor, the invalid-input fallback) reads
// this table instead of hardcoding its own copy of the day counts, and
// re-exports the two constants below so existing importers of
// "@/lib/analytics/analytics-period" are unaffected.
// ---------------------------------------------------------------------------

/**
 * Window length (in days) for every preset backed by a fixed trailing
 * window. "ytd" (Jan 1 of the current year → now) and "custom" (explicit
 * `from`/`to`) are not fixed-day-count presets — resolveAnalyticsPeriod
 * resolves them specially, so they have no entry here.
 */
export const PRESET_WINDOW_DAYS: Record<Exclude<PeriodPresetId, "ytd" | "custom">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  trailing12m: 365,
  "3y": 3 * 365,
  "5y": 5 * 365,
};

/**
 * Default preset for admin/gob dashboards that use a trailing-12m server window.
 * Shared between server pages and <PeriodPicker defaultPreset> so the chip label
 * always matches the data window on first load (C32).
 */
export const DEFAULT_DASHBOARD_PRESET = "trailing12m" as const;

/**
 * Default preset for the Panorama situational console (map + time scrubber).
 * Panorama defaults to a multi-year window so the temporal reproduction spans
 * the seeded history (system "started" ~3 years ago) instead of a short recent
 * slice. Scoped to Panorama only — the detail dashboards keep their own defaults.
 */
export const PANORAMA_DEFAULT_PRESET = "3y" as const;
