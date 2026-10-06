// The card-turn control — the one primitive behind every "turn the credential
// over" affordance: the flip glyph and the brand mark in the /p/ and owner
// band (`pc-band-flip`, `pc-band-mark-hit`) and the landing carnet's flip
// (`lp-hcard-flip`).
//
// WHY NOT LnButton. These controls are glyphs pressed into the laminate: no
// fill, no border, no padding, the sunk ink and the 44px hit come from the
// band's own CSS, and they turn with the card in 3D. LnButton's pill,
// padding and colours would paint a button ON the card instead of a mark IN
// it. What the design-system fence (scripts/check-raw-buttons.mjs) protects —
// one place that owns the element, its type, its accessible name and its
// toggle state — lives here instead, for all four surfaces at once, rather
// than as seven hand-rolled <button>s that had already drifted (two shared one
// name and one aria-pressed on the owner page).
//
// `skin` is a closed list on purpose: a new caller picks an existing band
// skin or adds one here, where the next reader sees every turn control.

import type { ReactNode } from "react";

export type CardTurnSkin = "pc-band-flip" | "pc-band-mark-hit" | "lp-hcard-flip";

export function CardTurnButton({
  skin,
  label,
  pressed,
  title,
  disabled,
  onClick,
  children,
}: {
  skin: CardTurnSkin;
  /** Accessible name. Name the TARGET face ("Girar a Libreta"), or say what a
   *  secondary control is ("Marca miMAR: …") — never two controls, one name. */
  label: string;
  /** Toggle state. Give it to ONE control per band; omit on the others. */
  pressed?: boolean;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={skin}
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
