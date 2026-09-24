"use client";

// DocumentChrome — the shared framed-sheet chrome that makes both faces read
// as ONE physical two-sided credential ("Una sola libreta" redesign). Wraps a
// face's inner content with: the blue pinstripe band (carrying the certificate
// title + the "Dar vuelta / Ver credencial" turn button), the certificate
// hairline frame, and the body. Rendered by FlipCard around each face so the
// server-rendered CredentialFace and the client LibretaFace share the exact
// same document shell without either owning the flip mechanics.
//
// The turn button is the ONLY flip trigger (tarjeta-todo, re-affirming PO
// decision #645 — the segmented Credencial/Libreta control above the card was
// removed): it carries the full accessible-nav contract (descriptive
// "Girar a …" name + aria-pressed toggle state), and its band styling was made
// more prominent (larger hit target — see .ln-turn) to match its promotion to
// sole switcher. The band icon spins 180° on hover as a tactile "turn" cue
// (disabled under prefers-reduced-motion via CSS).

import { Icon } from "@/components/Icon";
import type { PetSituationKey, PetSituationTone } from "@/lib/ui/pet-situation";
import type { ReactNode } from "react";
import type { FlipCardFace } from "./FlipCard";

/** The band's situation payload (pet-state-header). The LABEL arrives already
 *  gender-agreed (situationLabelForSex at the caller) so the chrome stays dumb
 *  — it never re-derives copy, it just paints band + chip. */
export type ChromeSituation = {
  key: PetSituationKey;
  tone: PetSituationTone;
  label: string;
  icon: string;
};

type DocumentChromeProps = {
  face: FlipCardFace;
  onFlip: () => void;
  /** Whether the Libreta (back) face is the one currently showing — drives the
   *  turn button's aria-pressed so the flip control carries the toggle state
   *  the removed tab title bar used to own. */
  isLibretaActive: boolean;
  /** Active pet situation — recolors the band (data-situation CSS variants)
   *  and renders the state chip on BOTH faces. Null = default blue band. */
  situation?: ChromeSituation | null;
  children: ReactNode;
};

export function DocumentChrome({
  face,
  onFlip,
  isLibretaActive,
  situation,
  children,
}: DocumentChromeProps) {
  const isCredencial = face === "credencial";
  const bandSubtitle = isCredencial ? "Credencial · frente" : "Libreta · dorso";
  const turnLabel = isCredencial ? "Dar vuelta" : "Ver credencial";
  // The accessible name always names the TARGET face (unchanged wording — the
  // flip interaction is keyed off "Girar a …" elsewhere in the profile).
  const turnAria = isCredencial ? "Girar a Libreta" : "Girar a Credencial";

  return (
    <div className="ln-face" data-situation={situation?.key}>
      <div className="ln-frame" aria-hidden />
      <div className="ln-band" aria-hidden>
        <p className="ln-band-title">
          Libreta Sanitaria Nacional
          <small>{bandSubtitle}</small>
        </p>
      </div>
      {/* State chip — the band's textual situation carrier (icon + label, never
          color alone). Sits over the band but OUTSIDE the aria-hidden wrapper
          (same pattern as the turn button): on the back face this chip is the
          ONLY textual carrier of the state, so it must be accessible text. */}
      {situation && (
        <span className="ln-band-chip" data-section="band-situation-chip">
          <Icon name={situation.icon} size="sm" decorative />
          {situation.label}
        </span>
      )}
      {/* Turn button sits over the band but outside the aria-hidden wrapper so
          it keeps its accessible name. */}
      <button
        type="button"
        className="ln-turn"
        onClick={onFlip}
        aria-label={turnAria}
        aria-pressed={isLibretaActive}
      >
        <Icon name="girar" size="sm" decorative />
        {turnLabel}
      </button>
      <div className="ln-body">{children}</div>
    </div>
  );
}
