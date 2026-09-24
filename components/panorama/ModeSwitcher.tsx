"use client";

// task #24 fase 1 — the "Modo" switcher (IA axis 2: HOW the map paints).
//
// ONE control on the map that projects `capabilities.mapModes` — the
// declarative list of spatial encodings the current view may select. Today
// that is "auto" (the layer-derived encoding) and "bivariate" (the Riesgo 3×3
// when eligible); the #33 viz-suite modes (delta choropleth, reporting lag,
// as-of, density heatmap) mount HERE as new options, never as separate rail
// icons or ad-hoc toggles (anti-sprawl guardrail, viz-suite plan §organizing
// principle). The switcher is dumb presentation: the console assembles the
// options (labels, per-mode disabled state + honest note) and owns the state.
//
// English identifiers, es-AR user copy arrives via the options (invariant #4).

export type ModeOption = {
  /** The mode id ("auto" | an EncodingId) — the value onChange reports. */
  id: string;
  /** es-AR label shown on the segment. */
  label: string;
  /** Selectable but currently unavailable (e.g. bivariate mid-scrub). */
  disabled?: boolean;
  /** Tooltip explaining a disabled segment (honesty over mystery). */
  title?: string;
};

type Props = {
  /** The selectable modes, in display order. Hidden entirely when < 2 (a
   *  one-option switcher is noise — "auto" alone means there is no choice). */
  options: ModeOption[];
  /** The ACTIVE mode id. */
  value: string;
  onChange: (id: string) => void;
  /** Optional heading + sub for the surrounding card (the console passes the
   *  question the modes answer). */
  heading?: string;
  sub?: string;
  /** Optional live note under the segments (e.g. why a mode is disabled). */
  note?: string | null;
};

export function ModeSwitcher({ options, value, onChange, heading, sub, note }: Props) {
  if (options.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-2">
      {(heading || sub) && (
        <div className="flex flex-col">
          {heading && <span className="text-sm font-semibold text-ln-op-ink-2">{heading}</span>}
          {sub && <span className="text-xs text-ln-op-mute">{sub}</span>}
        </div>
      )}
      <fieldset className="m-0 inline-flex overflow-hidden rounded-[var(--radius-md)] border border-ln-op-line p-0">
        <legend className="sr-only">Modo del mapa</legend>
        {options.map((opt) => {
          const active = opt.id === value;
          return (
            <button
              key={opt.id}
              type="button"
              aria-pressed={active}
              disabled={opt.disabled}
              title={opt.title}
              onClick={() => onChange(opt.id)}
              className={`px-2.5 py-1 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? "bg-ln-op-azul/10 text-ln-op-azul"
                  : "bg-ln-op-card text-ln-op-ink-2 hover:bg-ln-op-stripe"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </fieldset>
      {note && (
        <p className="w-full text-xs text-ln-op-mute" aria-live="polite">
          {note}
        </p>
      )}
    </div>
  );
}
