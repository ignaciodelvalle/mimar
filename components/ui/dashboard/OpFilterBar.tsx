"use client";

import { useSearchParams } from "next/navigation";
import { type ReactNode, useId, useState } from "react";

import { Icon } from "@/components/Icon";
import { JurisdictionSwitcher } from "@/components/gob/JurisdictionSwitcher";
import { PeriodPicker } from "@/components/gob/PeriodPicker";
import { CopyViewButton } from "@/components/ui/dashboard/CopyViewButton";
import { OpSelect } from "@/components/ui/dashboard/OpField";
import { SavedViewsControl } from "@/components/ui/dashboard/SavedViewsControl";
import {
  PRESET_3Y,
  PRESET_5Y,
  PRESET_30D,
  PRESET_90D,
  PRESET_YTD,
  type PeriodPresetId,
} from "@/lib/metrics/period-presets";
import { serverNavCommit } from "@/lib/ui/filter-commit";

/**
 * OpFilterBar — the unified filter-bar region for operator (gob/admin) list
 * dashboards. One bar, one visual idiom, one keyboard model: every list screen
 * declares its axes and drops them into the SAME bar instead of hand-rolling a
 * bespoke row of controls.
 *
 * Three regions, top to bottom:
 *   1. Header — a compact "Filtros" eyebrow (filter icon + micro-caps label)
 *      that gives the bar an identity instead of an invisible aria-label only.
 *      Page-level `actions` (e.g. "Exportar CSV →") render here too, grouped
 *      with "Copiar vista" at the far right — an export link is a per-screen
 *      action, not a filter, so it lives in the header rather than the rail.
 *   2. Unified rail — period (<PeriodPicker>), optional jurisdiction
 *      (<JurisdictionSwitcher>), and the screen-specific domain axes all flow
 *      and WRAP together in one `flex-wrap` row (not a hard grid), so on a wide
 *      screen they sit on one line and on a narrow one they stack cleanly.
 *      Every control carries the SAME caption treatment; axes render as one
 *      consistent labeled <select> idiom; a free-form `children` slot trails
 *      for anything that doesn't fit the descriptor (a search form, status
 *      tabs…). The two shared controls are reused as-is (not restyled: they
 *      are shared across many surfaces) — only their wrapper alignment is ours.
 *   3. Active-filter chips + "Limpiar todo" — a removable chip per active
 *      non-default filter, derived from the live searchParams and the axis
 *      registry, plus a one-click reset to defaults. No screen had this before.
 *
 * Commit model: EVERY mutation (axis change, chip removal, clear-all) commits
 * through `serverNavCommit` — the sanctioned full-document navigation that is
 * immune to Next 15.5.18's App Router router-drop defect (engram #621/#622).
 * The embedded PeriodPicker / JurisdictionSwitcher already commit the same way.
 * No navigation is hand-rolled here.
 *
 * Accessibility: domain axes are native <select>s wrapped in their own <label>
 * (implicit association) with a matching aria-label — the same aria baseline
 * PeriodPicker/JurisdictionSwitcher already meet. Chips are <button>s with a
 * descriptive aria-label ("Quitar filtro: …"). Mobile-safe: every region wraps
 * (flex-wrap / responsive grid) so nothing overflows at 375px — and at <md the
 * whole bar rests COLLAPSED behind a one-line summary row (identity + active
 * count + active values + chevron) so the panel no longer owns the entire
 * first mobile screen; >=md always renders fully expanded, exactly as before.
 */

/** A single selectable value on a domain axis. `value` is the searchParam value. */
export type OpFilterAxisOption = {
  value: string;
  /** es-AR label shown in the <option> and in the active-filter chip. */
  label: string;
};

/**
 * Declarative descriptor for one screen-specific domain axis (species, status,
 * kind, severity…). The bar renders it as a labeled <select> and, when active,
 * as a removable chip.
 */
export type OpFilterAxis = {
  /** Stable id — used for React keys and the chip id. */
  id: string;
  /** Visible es-AR label ("Especie", "Tipo", "Severidad"…). */
  label: string;
  /** searchParam key this axis reads/writes. */
  paramKey: string;
  /** Selectable options (the "all/any" default is rendered separately). */
  options: OpFilterAxisOption[];
  /**
   * Current value — the value the PAGE already parsed and validated (e.g.
   * maltrato validates `kind` against its enum). Null/"" = default ("all").
   * Preferred over reading the raw searchParam so an invalid URL value never
   * drives the control.
   */
  current: string | null;
  /** Label for the default/"all" option. Default "Todas". */
  allLabel?: string;
};

/** Period-axis config — mirrors the subset of <PeriodPicker> props the bar forwards. */
export type OpFilterBarPeriod = {
  /** Default preset (also decides when the period counts as "active"). Default "30d". */
  defaultPreset?: PeriodPresetId;
  multiYear?: boolean;
  /** searchParam key for the preset. Default "period". */
  paramKey?: string;
  /** searchParam keys for a custom range. Default { from: "from", to: "to" }. */
  customParamKeys?: { from: string; to: string };
};

/** Jurisdiction-axis config — forwarded to <JurisdictionSwitcher> and used to label chips. */
export type OpFilterBarJurisdiction = {
  allowedProvinces: Array<{ code: string; name: string }>;
  localities?: Array<{ slug: string; name: string }>;
  paramKeys?: { province: string; locality: string };
  dropParamsOnNavigate?: readonly string[];
};

export type OpFilterBarProps = {
  /** Period axis config. Only used when `showPeriod` is true; omit to use defaults. */
  period?: OpFilterBarPeriod;
  /**
   * Whether to render the Período control and its active-filter chip. Default
   * true. Set false on period-agnostic screens (e.g. a live triage queue) where
   * the period param drives nothing downstream — a rendered-but-dead control.
   */
  showPeriod?: boolean;
  /** Jurisdiction axis config. Rendered only when provided (screen has scope). */
  jurisdiction?: OpFilterBarJurisdiction;
  /** Screen-specific domain axes, rendered as consistent labeled selects. */
  axes?: OpFilterAxis[];
  /**
   * Extra searchParam keys to DROP on any filter mutation (axis change, chip
   * removal, clear-all) — e.g. a keyset pagination `cursor` that a filter
   * change invalidates. Also dropped by "Limpiar todo".
   */
  resetParamsOnChange?: readonly string[];
  /**
   * Free-form slot for controls that don't fit the axis descriptor (a search
   * form, the existing status/queue tabs…). Rendered in the domain-axes region.
   */
  children?: ReactNode;
  /**
   * Page-level action(s) — typically an "Exportar CSV →" link. Rendered in the
   * HEADER row, grouped with "Copiar vista" at the far right, so a screen's
   * export action lives INSIDE the bar instead of floating as a page-level
   * sibling next to it.
   */
  actions?: ReactNode;
  /**
   * Saved views (Fase C, 2026-07-21) — when provided, renders a compact
   * "Vistas guardadas" control in the header, next to "Copiar vista", backed
   * by localStorage under this exact key (see SavedViewsControl). MUST be a
   * stable, screen-scoped key (e.g. "op-saved-views:perdidas:v1") so one
   * screen's saved views never mix with another's. Omitted by default — this
   * is opt-in per screen, not a blanket rollout across every OpFilterBar
   * consumer.
   */
  savedViewsKey?: string;
  className?: string;
};

// Chip labels for the period axis. The 5 fixed presets are single-sourced from
// lib/metrics/period-presets (no drift); "7d"/"trailing12m" keep a bar-local
// TERSE copy and "custom" its own — exactly the split PeriodPicker itself makes
// (see the period-presets.ts module doc: those two labels are deliberately
// surface-specific, so a new surface like this bar owns its own terse copy).
const PERIOD_CHIP_LABELS: Record<string, string> = {
  "7d": "7 días",
  [PRESET_30D.value]: PRESET_30D.label,
  [PRESET_90D.value]: PRESET_90D.label,
  trailing12m: "Últimos 12 meses",
  [PRESET_YTD.value]: PRESET_YTD.label,
  [PRESET_3Y.value]: PRESET_3Y.label,
  [PRESET_5Y.value]: PRESET_5Y.label,
  custom: "personalizado",
};

/**
 * Honesty copy for an unresolved ?province/?locality param (fail-closed:
 * nothing narrowed). Single-sourced — the <md collapsed summary AND the >=md
 * notice row (red-team 2026-07 finding #4) must tell the same truth; before
 * that fix only mobile said it and desktop silently fell back mandate-wide.
 */
const UNRESOLVED_JURISDICTION_NOTICE = "Filtro no reconocido — mostrando tu cobertura completa";

type ActiveChip = {
  id: string;
  label: string;
  /**
   * The bare value ("90 días", "CABA", "Perro") — the chip `label` above keeps
   * its "Axis: value" form; this feeds the <md collapsed-bar summary, where the
   * axis prefixes would eat the whole line.
   */
  valueLabel: string;
  /** Param updates that REMOVE this filter (values are null → deleted). */
  clear: Record<string, string | null>;
};

// Derives the removable active-filter chips from the LIVE searchParams
// (period/jurisdiction) and the page's already-validated axis `current` — the
// source of truth for what's on screen. Pulled out of the component so
// OpFilterBar's own cognitive complexity stays under the lint budget.
function buildActiveChips(params: {
  searchParams: URLSearchParams;
  showPeriod: boolean;
  periodKey: string;
  fromKey: string;
  toKey: string;
  defaultPreset: PeriodPresetId;
  jurisdiction?: OpFilterBarJurisdiction;
  provinceKey: string;
  localityKey: string;
  axes: OpFilterAxis[];
}): ActiveChip[] {
  const {
    searchParams,
    showPeriod,
    periodKey,
    fromKey,
    toKey,
    defaultPreset,
    jurisdiction,
    provinceKey,
    localityKey,
    axes,
  } = params;
  const chips: ActiveChip[] = [];

  const activePreset = searchParams.get(periodKey);
  if (showPeriod && activePreset && activePreset !== defaultPreset) {
    const label = PERIOD_CHIP_LABELS[activePreset] ?? activePreset;
    chips.push({
      id: "period",
      label: `Período: ${label}`,
      valueLabel: label,
      clear: { [periodKey]: null, [fromKey]: null, [toKey]: null },
    });
  }

  if (jurisdiction) {
    const province = searchParams.get(provinceKey);
    const locality = searchParams.get(localityKey);
    // Chip honesty (visual review 2026-07-23 #9): only a param that RESOLVES
    // against the allowed set gets a chip. resolveJurisdictionScope is
    // fail-closed — an invalid ?province (e.g. a name where the ISO code
    // belongs) narrows NOTHING — so the old `?? province` fallback fabricated
    // a removable "Provincia: CABA ×" chip (and a filter-count badge) for a
    // filter that was never applied, directly contradicting the select, which
    // honestly showed "Todas". An unresolvable param renders no chip.
    if (province) {
      const name = jurisdiction.allowedProvinces.find((p) => p.code === province)?.name;
      if (name) {
        chips.push({
          id: "province",
          label: `Provincia: ${name}`,
          valueLabel: name,
          // Clearing the province also clears the locality (a locality without its
          // province is meaningless — same rule JurisdictionSwitcher enforces).
          clear: { [provinceKey]: null, [localityKey]: null },
        });
      }
    }
    if (locality) {
      const name = jurisdiction.localities?.find((l) => l.slug === locality)?.name;
      if (name) {
        chips.push({
          id: "locality",
          label: `Localidad: ${name}`,
          valueLabel: name,
          clear: { [localityKey]: null },
        });
      }
    }
  }

  for (const axis of axes) {
    if (axis.current) {
      const label = axis.options.find((o) => o.value === axis.current)?.label ?? axis.current;
      chips.push({
        id: axis.id,
        label: `${axis.label}: ${label}`,
        valueLabel: label,
        clear: { [axis.paramKey]: null },
      });
    }
  }

  return chips;
}

/**
 * <md summary line for the collapsed bar: the active values joined
 * ("Últimos 12 meses · CABA · Perro"), falling back to the default period (nothing
 * narrowed, but the window is still worth a glance) or a plain "no filters"
 * note. Module-level so OpFilterBar's own cognitive complexity stays under
 * the lint budget.
 *
 * Summary honesty (red-team 2026-07): a ?province/?locality param that does
 * NOT resolve against the allowed set correctly narrows nothing (fail-closed)
 * and renders no chip — but the summary then claimed "Sin filtros activos"
 * while the URL plainly carried a filter the viewer intended. When no chip
 * resolved AND a raw jurisdiction param was present, say so instead of
 * asserting there are no filters. Resolution itself is untouched.
 */
function buildMobileSummary(
  chips: ActiveChip[],
  showPeriod: boolean,
  defaultPreset: PeriodPresetId,
  hasUnresolvedJurisdictionParam: boolean,
): string {
  const parts = chips.map((c) => c.valueLabel);
  if (parts.length === 0 && hasUnresolvedJurisdictionParam) {
    return UNRESOLVED_JURISDICTION_NOTICE;
  }
  if (parts.length === 0 && showPeriod) {
    parts.push(PERIOD_CHIP_LABELS[defaultPreset] ?? defaultPreset);
  }
  return parts.length > 0 ? parts.join(" · ") : "Sin filtros activos";
}

/**
 * True when a raw ?province/?locality param sits in the URL but resolved to no
 * chip (invalid code/slug → fail-closed, nothing narrowed). Feeds the summary
 * honesty branch in buildMobileSummary — never the resolution itself.
 * Module-level so OpFilterBar stays under the cognitive-complexity budget.
 */
function detectUnresolvedJurisdictionParam(params: {
  searchParams: URLSearchParams;
  jurisdiction?: OpFilterBarJurisdiction;
  provinceKey: string;
  localityKey: string;
  chips: ActiveChip[];
}): boolean {
  const { searchParams, jurisdiction, provinceKey, localityKey, chips } = params;
  if (!jurisdiction) return false;
  const provinceUnresolved =
    Boolean(searchParams.get(provinceKey)) && !chips.some((c) => c.id === "province");
  const localityUnresolved =
    Boolean(searchParams.get(localityKey)) && !chips.some((c) => c.id === "locality");
  return provinceUnresolved || localityUnresolved;
}

/**
 * Active-filter count badge — one definition, rendered in BOTH the desktop
 * header and the <md summary row (only one is ever displayed at a time).
 */
function FilterCountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-ln-op-azul px-1.5 text-xs font-semibold leading-none text-white"
      aria-label={`Filtros activos: ${count}`}
    >
      {count}
    </span>
  );
}

// One caption treatment for every control the bar owns (Período + axes), sized
// text-sm to MATCH the JurisdictionSwitcher's own Provincia/Localidad labels
// (which are text-sm and cannot be restyled here — shared component), so the
// rail reads as one consistent set of captioned controls, not three sizes.
const captionClasses = "text-sm font-medium text-ln-op-ink-2";

const chipClasses =
  "inline-flex items-center gap-1.5 rounded-full border border-ln-op-line bg-ln-op-stripe " +
  "px-3 py-1 text-xs font-medium text-ln-op-ink min-h-8 " +
  "hover:border-ln-op-mute focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul";

const clearAllClasses =
  "inline-flex items-center min-h-8 rounded px-1 text-xs font-semibold text-ln-op-azul " +
  "underline underline-offset-2 hover:text-ln-op-azul-700 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul";

export function OpFilterBar({
  period,
  showPeriod = true,
  jurisdiction,
  axes = [],
  resetParamsOnChange = [],
  children,
  actions,
  savedViewsKey,
  className = "",
}: OpFilterBarProps) {
  const searchParams = useSearchParams();
  const uid = useId();

  // Mobile collapse (mobile-polish 2026-07): at <md the full bar used to own
  // the entire first screen — zero data visible without scrolling. It now
  // rests as ONE summary row (identity + active count + active values +
  // chevron); tapping it expands the full panel in place. >=md is untouched:
  // the summary row is md:hidden and the panel body is forced visible by
  // md:block, so this state only ever matters below md.
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const mobilePanelId = `${uid}-panel`;

  const periodKey = period?.paramKey ?? "period";
  const fromKey = period?.customParamKeys?.from ?? "from";
  const toKey = period?.customParamKeys?.to ?? "to";
  const defaultPreset: PeriodPresetId = period?.defaultPreset ?? "30d";

  const provinceKey = jurisdiction?.paramKeys?.province ?? "province";
  const localityKey = jurisdiction?.paramKeys?.locality ?? "locality";

  // Single commit path — every mutation flows through the sanctioned
  // full-document navigation, dropping any filter-invalidated params (cursor…).
  function commit(updates: Record<string, string | null>) {
    serverNavCommit(searchParams.toString())(updates, resetParamsOnChange);
  }

  function handleAxisChange(axis: OpFilterAxis, value: string) {
    // "" → null deletes the param, returning the axis to its "all" default.
    commit({ [axis.paramKey]: value || null });
  }

  // ---- Active-filter chips -------------------------------------------------
  const chips = buildActiveChips({
    searchParams,
    showPeriod,
    periodKey,
    fromKey,
    toKey,
    defaultPreset,
    jurisdiction,
    provinceKey,
    localityKey,
    axes,
  });

  function handleClearAll() {
    const updates: Record<string, string | null> = {
      [periodKey]: null,
      [fromKey]: null,
      [toKey]: null,
    };
    if (jurisdiction) {
      updates[provinceKey] = null;
      updates[localityKey] = null;
    }
    for (const axis of axes) updates[axis.paramKey] = null;
    commit(updates);
  }

  // Sparse case (only period and/or jurisdiction — no domain axes and no
  // free-form children, e.g. censo/poblacion/adopciones/campanas): the bar
  // renders just the header + one scope row, so the same p-4/space-y-4 rhythm
  // used for the rich axes screens (perdidas/maltrato) reads as an oversized
  // empty box. Tighten padding + rhythm a notch ONLY in that case — rich-axes
  // screens are untouched (hasDomainGroup is true there).
  const hasDomainGroup = axes.length > 0 || Boolean(children);
  const rhythm = hasDomainGroup ? "space-y-4" : "space-y-3";

  const hasUnresolvedJurisdictionParam = detectUnresolvedJurisdictionParam({
    searchParams,
    jurisdiction,
    provinceKey,
    localityKey,
    chips,
  });
  const mobileSummary = buildMobileSummary(
    chips,
    showPeriod,
    defaultPreset,
    hasUnresolvedJurisdictionParam,
  );

  return (
    <section
      aria-label="Filtros"
      className={[
        rhythm,
        hasDomainGroup ? "p-4" : "p-3.5",
        "rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Mobile summary row (<md only) — the collapsed bar in one tappable
          line: identity + active count + a compact readout of the active
          values + chevron. Tapping toggles the full panel below in place. */}
      <button
        type="button"
        aria-expanded={mobileExpanded}
        aria-controls={mobilePanelId}
        onClick={() => setMobileExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-ln-op-mute md:hidden"
      >
        <Icon name="filter" size={15} decorative />
        <span className="text-xs font-semibold uppercase tracking-[0.08em]">Filtros</span>
        <FilterCountBadge count={chips.length} />
        <span className="min-w-0 flex-1 truncate text-xs text-ln-op-ink-2">{mobileSummary}</span>
        <Icon
          name="chevron-down"
          size={16}
          decorative
          className={`flex-shrink-0 transition-transform ${mobileExpanded ? "rotate-180" : ""}`}
        />
      </button>

      {/* Region 1 — header: bar identity + active-filter count at a glance
          (the count summarizes; the removable chips below carry the detail).
          Page-level `actions` (e.g. "Exportar CSV →"), "Vistas guardadas"
          (opt-in via `savedViewsKey` — Fase C, 2026-07-21) and "Copiar vista"
          are grouped together at the far right — the URL already carries
          every active filter (period/jurisdiction/domain axes are all
          searchParams), so "Copiar vista" is a shareable link one click away
          and "Vistas guardadas" lets the operator NAME + recall that same URL
          later, and `actions` lives in the SAME bar instead of floating
          beside it. Hidden <md — the summary row above carries the identity
          there, and the header actions re-render inside the expanded panel. */}
      <div className="hidden items-center gap-2 text-ln-op-mute md:flex">
        <Icon name="filter" size={15} decorative />
        <span className="text-xs font-semibold uppercase tracking-[0.08em]">Filtros</span>
        <FilterCountBadge count={chips.length} />
        <div className="flex items-center gap-2 ml-auto">
          {actions}
          {savedViewsKey && <SavedViewsControl storageKey={savedViewsKey} />}
          <CopyViewButton />
        </div>
      </div>

      {/* Panel body — regions 2 + 3. <md it renders only while the summary row
          above is expanded; md:block force-shows it on desktop regardless of
          the mobile toggle, so >=md is byte-identical to the pre-collapse bar. */}
      <div id={mobilePanelId} className={mobileExpanded ? rhythm : `hidden md:block ${rhythm}`}>
        {/* Header actions, mobile edition — the desktop header (region 1) is
          hidden <md, so Exportar/Vistas guardadas/Copiar vista re-render here
          inside the expanded panel (display:none keeps the hidden copy out of
          the a11y tree, so the controls never double up). */}
        <div className="flex flex-wrap items-center gap-2 md:hidden">
          {actions}
          {savedViewsKey && <SavedViewsControl storageKey={savedViewsKey} />}
          <CopyViewButton />
        </div>

        {/* Region 2 — unified rail, grouped by kind: SCOPE (period + jurisdiction:
          "which universe") is set apart from DOMAIN filters (species / kind /
          severity: "which subset of it"). The split is carried by proximity +
          a hairline divider that only shows when the two groups sit inline
          (sm+); on a narrow screen the groups stack and the divider vanishes,
          so grouping never fights the responsive wrap. No boxes, no group
          labels — the structure encodes the scope-vs-content distinction on
          its own. */}
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          {/* Scope group — period (optional) + optional jurisdiction. Omitted
            entirely when neither is present, so the domain group below never
            grows a stray divider with nothing to its left. */}
          {(showPeriod || jurisdiction) && (
            <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
              {showPeriod && (
                <div className="flex w-full flex-col gap-1 sm:w-auto">
                  <span className={captionClasses}>Período</span>
                  <PeriodPicker
                    defaultPreset={defaultPreset}
                    multiYear={period?.multiYear}
                    presetParamKey={periodKey}
                    customParamKeys={{ from: fromKey, to: toKey }}
                  />
                </div>
              )}

              {jurisdiction && (
                <div className="w-full sm:w-auto sm:min-w-[17rem]">
                  <JurisdictionSwitcher
                    allowedProvinces={jurisdiction.allowedProvinces}
                    localities={jurisdiction.localities}
                    paramKeys={{ province: provinceKey, locality: localityKey }}
                    dropParamsOnNavigate={jurisdiction.dropParamsOnNavigate}
                  />
                </div>
              )}
            </div>
          )}

          {/* Domain group — screen-specific axes + free-form slot, set off from
            the scope group by a hairline divider (sm+ only). The divider only
            applies when a scope group actually rendered above it. */}
          {(axes.length > 0 || children) && (
            <div
              className={[
                "flex flex-wrap items-end gap-x-4 gap-y-3",
                (showPeriod || jurisdiction) && "sm:border-l sm:border-ln-op-line-2 sm:pl-5",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {axes.map((axis) => {
                const selectId = `${uid}-${axis.id}`;
                return (
                  <label
                    key={axis.id}
                    htmlFor={selectId}
                    className="flex w-full flex-col gap-1 sm:w-auto"
                  >
                    <span className={captionClasses}>{axis.label}</span>
                    <OpSelect
                      id={selectId}
                      className="min-h-11 w-full sm:w-auto sm:min-w-[9rem]"
                      value={axis.current ?? ""}
                      onChange={(e) => handleAxisChange(axis, e.target.value)}
                      aria-label={axis.label}
                    >
                      <option value="">{axis.allLabel ?? "Todas"}</option>
                      {axis.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </OpSelect>
                  </label>
                );
              })}

              {children}
            </div>
          )}
        </div>

        {/* Desktop honesty notice (red-team 2026-07 #4): an unresolved
            ?province/?locality (fail-closed, nothing narrowed) was only
            confessed in the <md collapsed summary — on desktop the bar
            silently showed mandate-wide data with no signal. Same
            single-sourced copy, rendered >=md only (the mobile summary row
            already carries it below md), muted like the chips-row label. */}
        {hasUnresolvedJurisdictionParam && (
          <p className="hidden border-t border-ln-op-line-2 pt-3 text-xs font-medium text-ln-op-mute md:block">
            {UNRESOLVED_JURISDICTION_NOTICE}
          </p>
        )}

        {/* Region 3 — active-filter chips + clear-all */}
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-ln-op-line-2 pt-3">
            <span className="text-xs font-medium text-ln-op-mute">Filtros activos:</span>
            {chips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                onClick={() => commit(chip.clear)}
                className={chipClasses}
                aria-label={`Quitar filtro: ${chip.label}`}
              >
                <span>{chip.label}</span>
                <Icon name="close" size={14} decorative />
              </button>
            ))}
            <button type="button" onClick={handleClearAll} className={clearAllClasses}>
              Limpiar todo
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
