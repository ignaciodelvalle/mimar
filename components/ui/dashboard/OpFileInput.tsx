"use client";

import { type ComponentPropsWithRef, useId } from "react";

// OpFileInput — the operator file picker.
//
// WHY THIS EXISTS
// ---------------
// `<input type="file">` was the ONE control the 92-site OpField migration could
// not absorb, and it is the only control in the product that renders text the
// app does not own: the trigger label and the "no file selected" status are
// drawn by the user agent, in the BROWSER's language. In a Chrome running in
// English — which is what an Argentine funcionario's ministry laptop usually
// ships — a decomiso form governed by Ley 14.346 rendered "Choose Files / No
// file chosen" (QA 2026-08-07, three surfaces).
//
// CSS cannot fix this. The `file:` pseudo-element styles the button's BOX but
// not its text, so the previous attempt (file:bg-ln-op-stripe … on the raw
// input) restyled an English button and left the English status beside it. The
// only way to own the words is to hide the native control and drive it from a
// <label>, which is what this component does.
//
// It also fixes a hierarchy inversion the styling could not: Chrome's native
// file button is a filled BLUE control, so on the CSV import wizard it outread
// the screen's actual primary action ("Descargar plantilla", an outline
// button). This trigger is deliberately ghost-weight — the same chrome as
// OpButton's `ghost` variant — so it never competes with the real CTA.
//
// ACCESSIBILITY
// -------------
// The native input stays in the accessibility tree and in the tab order
// (`sr-only`, NOT `display:none`/`hidden`, which would remove it from both).
// The <label> is the visible trigger; clicking it forwards to the input, and
// `peer-focus-visible` paints the focus ring on the label when the INPUT takes
// keyboard focus — otherwise the ring would render on a 1px offscreen box and
// a keyboard user would see nothing. The selection status is `aria-live` so a
// screen-reader user hears what they picked, which the native control gave for
// free and hiding it would otherwise cost.

export type OpFileInputProps = Omit<ComponentPropsWithRef<"input">, "type" | "className"> & {
  /** Visible trigger text. Defaults follow `multiple`. */
  label?: string;
  /**
   * Selection summary shown beside the trigger. Callers that render their own
   * attachment list (DecomisoForm) pass `null` to suppress it rather than
   * state the same thing twice.
   */
  status?: string | null;
  /** Wrapper class — the trigger's own chrome is not overridable by design. */
  className?: string;
};

const TRIGGER_CLASS =
  // Mirrors OpButton `ghost` + size `md` (OpButton.tsx), PLUS the 44px floor
  // OpButton deliberately omits: this label is not a button, it IS the file
  // field's control surface, and the floor is a field rule in both tiers (see
  // OpField's density note). Kept as a literal rather than importing OpButton
  // because the trigger MUST be a <label> for the native click-forwarding, and
  // OpButton renders a <button>/<a>.
  // OpButton's base also carries an arbitrary 7px gap; this does not. That gap
  // separates a button's icon from its label, and this trigger has a single
  // text child — copying it would add a dead arbitrary spacing value, which is
  // what `lint:tokens` ratchets against. (Do not write the class name out even
  // in a comment: that fence scans raw source, comments included.)
  "inline-flex items-center justify-center font-semibold " +
  "rounded-[var(--radius-op-btn,6px)] border transition-colors cursor-pointer select-none " +
  "px-3.5 py-2 text-md min-h-[44px] " +
  "bg-[var(--color-ln-op-card)] text-[var(--color-ln-op-ink)] border-[var(--color-ln-op-line)] " +
  "hover:bg-[var(--color-ln-op-stripe)] active:scale-[0.98] active:opacity-90 " +
  "peer-disabled:cursor-not-allowed peer-disabled:opacity-60 " +
  "peer-focus-visible:outline-none peer-focus-visible:ring-[3px] " +
  "peer-focus-visible:ring-[var(--color-ln-op-celeste-050)]";

export function OpFileInput({ label, status, className, multiple, id, ...rest }: OpFileInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const statusId = `${inputId}-status`;
  const triggerLabel = label ?? (multiple ? "Elegir archivos" : "Elegir archivo");

  return (
    <div className={`flex flex-wrap items-center gap-3 ${className ?? ""}`}>
      {/* The input precedes the label because `peer-*` only reaches LATER
          siblings — reordering these two silently kills the focus ring. */}
      <input
        {...rest}
        id={inputId}
        type="file"
        multiple={multiple}
        className="peer sr-only"
        aria-describedby={status === null ? undefined : statusId}
      />
      <label htmlFor={inputId} className={TRIGGER_CLASS}>
        {triggerLabel}
      </label>
      {status !== null && (
        <span id={statusId} aria-live="polite" className="text-sm text-[var(--color-ln-op-mute)]">
          {status || "Ningún archivo elegido"}
        </span>
      )}
    </div>
  );
}
