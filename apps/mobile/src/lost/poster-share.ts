// The lost-pet poster, from the phone (M13): fetch the server's finished HTML,
// print it to an A4 PDF on the device, hand the PDF to the share sheet.
//
// THE PRIVACY DECISION IS NOT HERE, and that is the design. What the poster
// may print about the titular — first name, phone, last-seen place — is
// resolved and filtered on the server by the same function the web's cartel
// page uses (`GET /api/v1/pets/{token}/poster`). This file never sees the raw
// fields; it cannot print a caretaker's phone because it is never given one.

import { PET_POSTER_PAGE_POINTS } from "@dim/contract/api";

import { type SessionPort, apiFailureMessage } from "../api/client";
import { fetchPetPoster } from "../api/endpoints";
import { safeFileName, sharePdfFromHtml } from "../native/file-share";

export type PosterShareResult =
  /** The sheet opened and closed; `hasPhoto` drives the web's no-photo warning. */
  | { kind: "closed"; hasPhoto: boolean }
  /** The animal is not marked lost (any more): nothing to print. */
  | { kind: "not_lost" }
  /** A sentence for the person — never a raw error. */
  | { kind: "failed"; message: string };

export const POSTER_FAILED_TO_RENDER = "No pudimos armar el PDF del cartel. Probá de nuevo.";
export const POSTER_NO_SHARE_TARGET =
  "Este teléfono no tiene ninguna app para compartir o imprimir el cartel.";

export async function sharePoster(
  session: SessionPort,
  publicToken: string,
): Promise<PosterShareResult> {
  const result = await fetchPetPoster(session, publicToken);
  if (result.outcome !== "ok") {
    return {
      kind: "failed",
      message: apiFailureMessage(result) ?? "No pudimos traer el cartel. Probá de nuevo.",
    };
  }
  const poster = result.payload;
  if (!poster.available) return { kind: "not_lost" };

  const shared = await sharePdfFromHtml(
    poster.html,
    PET_POSTER_PAGE_POINTS,
    safeFileName(`cartel ${poster.petName}`, "pdf"),
    `Cartel de ${poster.petName}`,
  );
  switch (shared.outcome) {
    case "closed":
      return { kind: "closed", hasPhoto: poster.hasPhoto };
    case "unavailable":
      return { kind: "failed", message: POSTER_NO_SHARE_TARGET };
    case "failed":
      // Rendering and the sheet fail for different reasons, but the person's
      // next step is the same: try again. The detail stays out of the UI.
      return { kind: "failed", message: POSTER_FAILED_TO_RENDER };
  }
}
