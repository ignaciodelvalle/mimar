"use client";

// SimpleDetalleToggle — the shared two-tier disclosure control (task #38 item 2).
//
// The TimeScrubber (scrubDetail) and CapasBox (capasDetail) each hand-rolled the
// same Simple/Detalle segmented fieldset. The v3 rail applies the SAME two-tier
// idiom to EVERY panel, so the control is extracted once here: Simple = the
// essentials, Detalle = everything. Purely presentational; the owner holds the
// boolean and decides what each tier renders.

type Props = {
  /** Simple (false) / Detalle (true). */
  detail: boolean;
  onChange: (detail: boolean) => void;
  /** Accessible name of the thing being toggled, e.g. "de la vista". */
  labelSuffix: string;
};

export function SimpleDetalleToggle({ detail, onChange, labelSuffix }: Props) {
  return (
    <fieldset className="m-0 inline-flex overflow-hidden rounded-[var(--radius-md)] border border-ln-op-line p-0">
      <legend className="sr-only">Nivel de detalle {labelSuffix}</legend>
      <button
        type="button"
        aria-pressed={!detail}
        aria-label={`Modo simple ${labelSuffix}`}
        onClick={() => onChange(false)}
        className={`px-2.5 py-1 text-sm font-medium transition-colors ${
          !detail
            ? "bg-ln-op-azul/10 text-ln-op-azul"
            : "bg-ln-op-card text-ln-op-ink-2 hover:bg-ln-op-stripe"
        }`}
      >
        Simple
      </button>
      <button
        type="button"
        aria-pressed={detail}
        aria-label={`Modo detalle ${labelSuffix}`}
        onClick={() => onChange(true)}
        className={`px-2.5 py-1 text-sm font-medium transition-colors ${
          detail
            ? "bg-ln-op-azul/10 text-ln-op-azul"
            : "bg-ln-op-card text-ln-op-ink-2 hover:bg-ln-op-stripe"
        }`}
      >
        Detalle
      </button>
    </fieldset>
  );
}
