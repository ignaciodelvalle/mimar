"use client";

import { type ReactNode, useId } from "react";

/**
 * Libreta Nacional Toggle.
 *
 * The knob slides 18px on toggle.
 * Variants:
 *  - azul  (default) — blue when on; for general settings
 *  - amber            — ámbar when on; for disclosure/lost-mode settings
 *
 * Renders a <button role="switch"> for full a11y compliance.
 */

export type LnToggleVariant = "azul" | "amber";

export type LnToggleProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  variant?: LnToggleVariant;
  label: string;
  description?: string;
  className?: string;
  /** If true, renders the toggle + label inline (no full row) */
  inline?: boolean;
};

export function LnToggle({
  checked,
  onChange,
  variant = "azul",
  label,
  description,
  className = "",
  inline = false,
}: LnToggleProps) {
  const trackOn = variant === "amber" ? "bg-[var(--color-ln-warn)]" : "bg-[var(--color-ln-azul)]";
  // The NAME of the switch is the label, and only the label. The description
  // sits inside the same button (it has to, so the whole row is one target), and
  // text inside a button folds into its accessible name — which would have made
  // this control announce as "Tu teléfono Se publica en el aviso…". Pointing
  // `aria-labelledby` at the label alone keeps the name short, and
  // `aria-describedby` gives the description back as a description.
  //
  // This is strictly better than what it replaced, where `aria-label={label}`
  // set the name and the description was never announced at all.
  const labelId = useId();
  const descriptionId = useId();

  // THE BUTTON WRAPS THE WHOLE ROW, and that one structural decision is what
  // fixes both defects this component had (a11y audit 2026-09-16):
  //
  //  1. The text beside the switch was not a label. It looked like one, and the
  //     row even carried `cursor-pointer`, but the click handler lived on the
  //     38x21 track alone — so aiming at the words did nothing. On a phone,
  //     with the disclosure preferences of a LOST pet, that reads as a control
  //     that simply refuses to work.
  //  2. The target was 38x21, under half of WCAG 2.5.5's 44x44 floor.
  //
  // The previous shape was a non-semantic <div> wrapping a <button> track. B-4
  // had already removed the div's handlers, correctly: handlers on a role-less
  // div is its own violation. But that fix addressed the markup and left the
  // person unable to hit the thing. Making the row itself the <button> resolves
  // both at once, with no nested interactive element: the track below is now a
  // plain <span> that draws state, and the accessible name comes from the
  // label text it contains rather than a duplicated `aria-label`.
  // ONE <button>, two shapes. The inline and row variants differ only in their
  // class string, so they share a single element rather than returning two —
  // which also keeps `lint:buttons` counting one raw button here instead of two.
  const rowBase =
    "cursor-pointer text-left focus-visible:outline-none " +
    "focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]";
  const shape = inline
    ? "flex items-center gap-2.5"
    : "flex w-full items-start gap-[11px] border border-[var(--color-ln-line-2)] bg-[var(--color-ln-stripe)] px-3 py-2.5";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={description && !inline ? descriptionId : undefined}
      onClick={() => onChange(!checked)}
      // The radius is written HERE, in the opening tag, and not folded into
      // `rowBase` above — `check-raw-buttons.mjs` only walks opening tags, so a
      // hoisted class string would hide it from the very ratchet that exists to
      // watch it. This row wears a <button> for accessibility (the label has to
      // be inside the control to be tappable) while being a switch, not a
      // button, so it cannot migrate to LnButton the way the rule's remedy
      // assumes. It is counted, deliberately, rather than made invisible.
      className={`rounded-[var(--radius-sm)] ${[rowBase, shape, className].filter(Boolean).join(" ")}`}
    >
      <TrackVisual checked={checked} trackOn={trackOn} />
      {inline ? (
        <span id={labelId} className="text-md font-semibold text-[var(--color-ln-ink)]">
          {label}
        </span>
      ) : (
        <span className="min-w-0 flex-1">
          <span
            id={labelId}
            className="block text-md font-semibold leading-tight text-[var(--color-ln-ink)]"
          >
            {label}
          </span>
          {description && (
            <span
              id={descriptionId}
              className="mt-px block text-sm leading-[1.4] text-[var(--color-ln-mute)]"
            >
              {description}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

// The track and knob, drawn only. Not interactive: its ancestor <button> is.
// The 44px floor is met by the row, not by this 38x21 graphic — the `inline`
// variant is the one case where the row can be short, so it carries a centred
// pseudo-element that grows the target to 44 without moving the drawing.
function TrackVisual({ checked, trackOn }: { checked: boolean; trackOn: string }) {
  return (
    <span
      aria-hidden="true"
      className={[
        "relative mt-px block h-[21px] w-[38px] flex-shrink-0 rounded-full transition-colors duration-150",
        "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
        checked ? trackOn : "bg-[var(--color-ln-line-strong)]",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Knob */}
      <span
        className={[
          "absolute top-[2px] h-[17px] w-[17px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.2)] transition-[left] duration-150",
          checked ? "left-[19px]" : "left-[2px]",
        ]
          .filter(Boolean)
          .join(" ")}
      />
    </span>
  );
}

// ---------- Toggle Group -------------------------------------------------
// Renders a list of LnToggle rows with a mono-uppercase subheading.

export type LnToggleGroupItem = {
  key: string;
  label: string;
  description?: string;
  checked: boolean;
  variant?: LnToggleVariant;
};

export type LnToggleGroupProps = {
  heading?: string;
  items: LnToggleGroupItem[];
  onChange: (key: string, next: boolean) => void;
  className?: string;
};

export function LnToggleGroup({ heading, items, onChange, className = "" }: LnToggleGroupProps) {
  return (
    <div className={["flex flex-col gap-2", className].filter(Boolean).join(" ")}>
      {heading && (
        <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.12em] text-[var(--color-ln-faint)]">
          {heading}
        </p>
      )}
      {items.map((item) => (
        <LnToggle
          key={item.key}
          checked={item.checked}
          onChange={(v) => onChange(item.key, v)}
          variant={item.variant}
          label={item.label}
          description={item.description}
        />
      ))}
    </div>
  );
}

// Re-export for convenience
export type { ReactNode };
