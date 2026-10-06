/** Navy document band shared by /p/ and /t/ — landing chrome, no holo foil. */

import type { ReactNode } from "react";

import { PublicCredentialBrandMark } from "./PublicCredentialBrandMark";

export function PublicDocumentBand({
  subtitle,
  compact = false,
  brand = null,
  flip = null,
}: {
  subtitle: string;
  /** No photo rising into the band — /t/ and fail-soft sheets. */
  compact?: boolean;
  /**
   * Left-column control (usually the mark). When null, paints the decorative
   * mark. Callers that can turn the card pass a button with the same mark so
   * both corners flip.
   */
  brand?: ReactNode;
  /** Landing-style turn control. Null on compact / throttle / degraded. */
  flip?: ReactNode;
}) {
  return (
    <div className={compact ? "pc-band pc-band--compact" : "pc-band"}>
      {!compact && <span className="pc-band-latent" aria-hidden="true" />}
      <div className="pc-band-head">
        {/* Balance column — order swaps with .pc-band-trim on data-face="back"
            (landing lp-hcard-head-balance), so mark and flip stay mirrored. */}
        <span className="pc-band-balance">{brand ?? <PublicCredentialBrandMark />}</span>
        <span className="pc-band-doctype">{subtitle}</span>
        <span className="pc-band-trim">{flip}</span>
      </div>
    </div>
  );
}
