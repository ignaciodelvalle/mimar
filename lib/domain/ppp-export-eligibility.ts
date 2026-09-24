// Who may emit the RUPPPA registration PDF (CABA, Ley 5470 / Ord. 41.831) from
// the owner's pet page — and what the page says to everyone else.
//
// Pure and client-safe on purpose: the owner page needs the gate, and the PDF
// renderer that used to hold CABA_PROVINCE (lib/analytics/ppp-exports.ts) pulls
// pdf-lib in with it. The renderer now re-exports the constant from here, so
// the gate the page shows and the gate the use-case enforces
// (src/modules/pets/application/ppp-export/generate-ppp-export.ts) read ONE
// value.
//
// The use-case's own checks stay authoritative; this only decides what the
// page OFFERS. Both require the LEGAL owner (the use-case since security
// review 2026-09 — it used to accept any open ownership row). A foster or
// transit holder has an open ownership row too, but registering a potentially
// dangerous dog is the titular's personal duty, not the person keeping it this
// week.

/** Canonical province value for CABA (CHECK constraint since migration 0055). */
export const CABA_PROVINCE = "CABA";

export type PppExportAvailability = { kind: "available" } | { kind: "unavailable"; reason: string };

export const PPP_EXPORT_OUTSIDE_CABA =
  "La constancia para el registro RUPPPA es de la Ciudad de Buenos Aires. Para la jurisdicción de esta mascota todavía no la emitimos: consultá el registro de tu municipio.";

/**
 * `null` when the PPP export does not concern this viewer at all (not the legal
 * owner, or the pet is not flagged as potentially dangerous) — the page then
 * shows nothing about it.
 */
export function pppExportAvailability(input: {
  isLegalOwner: boolean;
  potentiallyDangerousBreed: boolean | null;
  jurisdictionProvince: string | null;
}): PppExportAvailability | null {
  if (!input.isLegalOwner || input.potentiallyDangerousBreed !== true) return null;
  if (input.jurisdictionProvince !== CABA_PROVINCE) {
    return { kind: "unavailable", reason: PPP_EXPORT_OUTSIDE_CABA };
  }
  return { kind: "available" };
}
