"use client";

// FilterChips — a compact, ALWAYS-VISIBLE strip of the conditions that qualify
// everything below (scope, period, data cutoff).
//
// WHY: the "Alcance y período" controls ship behind a collapsed disclosure, so
// the verdict (map + KPIs) was visible while the CONDITIONS that produced it
// were hidden a click away (PO: "verdict visible, conditions hidden"). This strip
// keeps them on screen; a clickable chip opens the full control it summarizes.
//
// This is the app-wide FilterBar seed (task #53) — deliberately generic and
// presentational (it owns no state, no data). The app-wide migration is separate;
// for now only Panorama mounts it.
//
// English identifiers, es-AR user copy (project invariant #4).

/** One condition chip: a "label: value" pill, optionally clickable to open the
 * control it summarizes. */
export type FilterChip = {
  /** Short prefix naming the dimension ("Alcance", "Período", "Al"). */
  label: string;
  /** The active value ("Nacional", "últimos 90 días", "último evento 14:37"). */
  value: string;
  /** Opens the underlying control. Omit → the chip is a static read-out. */
  onClick?: () => void;
  /** Accessible name for the button (defaults to `Editar {label}`). */
  ariaLabel?: string;
};

type Props = {
  chips: FilterChip[];
};

export function FilterChips({ chips }: Props) {
  return (
    // A toolbar of related chip controls (no semantic-HTML equivalent — a form
    // <fieldset> would be wrong here since there are no captioned inputs).
    <div
      role="toolbar"
      aria-label="Condiciones activas de la vista"
      className="flex flex-wrap items-center gap-1.5"
    >
      {chips.map((chip) => {
        const content = (
          <>
            <span className="text-ln-op-mute">{chip.label}:</span>{" "}
            <span className="font-semibold text-ln-op-ink">{chip.value}</span>
          </>
        );
        const className =
          "inline-flex items-center gap-1 rounded-full border border-ln-op-line bg-ln-op-card px-2.5 py-1 text-xs";
        if (chip.onClick) {
          return (
            <button
              key={chip.label}
              type="button"
              onClick={chip.onClick}
              aria-label={chip.ariaLabel ?? `Editar ${chip.label}`}
              className={`${className} text-ln-op-ink-2 transition-colors hover:border-ln-op-azul/50`}
            >
              {content}
            </button>
          );
        }
        return (
          <span key={chip.label} className={`${className} text-ln-op-ink-2`}>
            {content}
          </span>
        );
      })}
    </div>
  );
}
