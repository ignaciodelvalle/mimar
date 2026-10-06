"use client";

import { Icon } from "@/components/Icon";
import { CardTurnButton } from "@/components/credential/CardTurnButton";
import { PublicCredentialBrandMark } from "@/components/credential/PublicCredentialBrandMark";
import { PublicDocumentBand } from "@/components/credential/PublicDocumentBand";
import type { PetSituationKey, PetSituationTone } from "@/lib/ui/pet-situation";
import { chromeForSurface } from "@dim/contract/credential";
import type { ReactNode } from "react";
import type { FlipCardFace } from "./FlipCard";

const OWNER_CHROME = chromeForSurface("owner");

/**
 * The band names the DOCUMENT TYPE of the face on show — "Credencial · frente"
 * / "Libreta · dorso" (PO-approved band). The owner recipe is two-faced, so
 * its back subtitle is never null; there is deliberately no `?? title`
 * fallback (it was unreachable, and a fence that asserted the title was
 * asserting a string nobody saw). If the contract ever drops the back, fail
 * at load instead of painting an unnamed band.
 */
function ownerBackDoctype(): string {
  const back = OWNER_CHROME.subtitleBack;
  if (back === null) throw new Error("owner credential chrome has no back-face doctype");
  return back;
}
const OWNER_BACK_DOCTYPE = ownerBackDoctype();

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
  /** Active pet situation. Stamped on both faces so the flip keeps the tint.
   *  The words render on the libreta face here; the credencial face paints
   *  them under the name (CredentialFace) so the label is not said twice. */
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
  const bandSubtitle = isCredencial ? OWNER_CHROME.subtitleFront : OWNER_BACK_DOCTYPE;
  // The accessible name always names the TARGET face (unchanged wording — the
  // flip interaction is keyed off "Girar a …" elsewhere in the profile).
  const turnAria = isCredencial ? "Girar a Libreta" : "Girar a Credencial";
  // The mark turns the sheet too (pointer convenience, landing parity), but it
  // is a SECOND control: two buttons sharing one name and one toggle state read
  // to a screen reader as the same control listed twice, and make "Girar a …"
  // ambiguous for every query keyed on it. The flip button owns the name and
  // aria-pressed; the mark says what it is and what it does.
  const markAria = isCredencial
    ? "Marca miMAR: mostrar la libreta"
    : "Marca miMAR: mostrar la credencial";
  // The front chip lives under the name, inside CredentialFace — one label on
  // the face the reader is looking at. The libreta face has no identity row,
  // so the same words ride here and the flip does not drop the state.
  const showBackChip = !isCredencial && situation != null && OWNER_CHROME.showSituationChip;

  return (
    <div
      className="pc-cred ln-face"
      data-face={isCredencial ? "front" : "back"}
      data-situation={situation?.key}
    >
      <PublicDocumentBand
        subtitle={bandSubtitle}
        brand={
          <CardTurnButton skin="pc-band-mark-hit" onClick={onFlip} label={markAria}>
            <PublicCredentialBrandMark />
          </CardTurnButton>
        }
        flip={
          <CardTurnButton
            skin="pc-band-flip"
            onClick={onFlip}
            label={turnAria}
            pressed={isLibretaActive}
          >
            {isCredencial ? "↻" : "↺"}
          </CardTurnButton>
        }
      />
      {showBackChip && situation ? (
        <div className="pc-chips">
          <span
            className="pc-sit-chip ln-band-chip"
            data-section="band-situation-chip"
            role={situation.key === "perdida" ? "alert" : undefined}
          >
            <Icon name={situation.icon} size="sm" decorative />
            {situation.label}
          </span>
        </div>
      ) : null}
      <div className="ln-body">{children}</div>
    </div>
  );
}
