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
   * START (left) slot. On a front face this is the mark; a caller that turns
   * the card and mirrors it on the back passes the flip control here instead,
   * so the DOM order (and Tab order) matches what is drawn. When null, paints
   * the decorative mark.
   */
  brand?: ReactNode;
  /**
   * END (right) slot: the turn control on a front face, the mark on a mirrored
   * back face. Null on compact / throttle / degraded.
   */
  flip?: ReactNode;
}) {
  return (
    <div className={compact ? "pc-band pc-band--compact" : "pc-band"}>
      {!compact && <span className="pc-band-latent" aria-hidden="true" />}
      <div className="pc-band-head">
        {/* Balance column = the start slot. Mirroring happens in the caller's
            DOM order (DocumentChrome), not with CSS `order`. */}
        <span className="pc-band-balance">{brand ?? <PublicCredentialBrandMark />}</span>
        <span className="pc-band-doctype">{subtitle}</span>
        <span className="pc-band-trim">{flip}</span>
      </div>
    </div>
  );
}
