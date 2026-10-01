// The travel PDF, from the phone (viajes-fase-2, task 6.5): ask the server for
// the PDF of the trip on screen, download it, hand the file to the share sheet.
//
// NOTHING IS DRAWN HERE. The server renders the PDF from the same reading the
// screen draws (`loadTravelView`), stores it and answers a signed link — the
// link the web's "Descargar documentación de viaje" button opens. The phone
// only carries the file, so the semáforo on paper is the one on the screen.

import { type SessionPort, apiFailureMessage } from "../api/client";
import { requestPetTravelExport } from "../api/endpoints";
import { safeFileName, sharePdfFromUrl } from "../native/file-share";

export type TravelExportShareResult =
  /** The sheet opened and closed. Whether something was sent is unknowable. */
  | { kind: "closed" }
  /** A sentence for the person — never a raw error. */
  | { kind: "failed"; message: string };

export const TRAVEL_EXPORT_FAILED = "No pudimos traer el PDF del viaje. Probá de nuevo.";
export const TRAVEL_EXPORT_NO_SHARE_TARGET =
  "Este teléfono no tiene ninguna app para compartir o guardar el PDF.";

export async function shareTravelExport(
  session: SessionPort,
  publicToken: string,
  petName: string,
  tripEventId: string | null,
): Promise<TravelExportShareResult> {
  const result = await requestPetTravelExport(session, publicToken, tripEventId);
  if (result.outcome !== "ok") {
    return { kind: "failed", message: apiFailureMessage(result) ?? TRAVEL_EXPORT_FAILED };
  }

  const shared = await sharePdfFromUrl(
    result.payload.pdfUrl,
    safeFileName(`viaje ${petName}`, "pdf"),
    `Viaje de ${petName}`,
  );
  switch (shared.outcome) {
    case "closed":
      return { kind: "closed" };
    case "unavailable":
      return { kind: "failed", message: TRAVEL_EXPORT_NO_SHARE_TARGET };
    case "failed":
      // A dropped download and a sheet that would not open read the same to
      // the person: try again. The detail stays out of the UI.
      return { kind: "failed", message: TRAVEL_EXPORT_FAILED };
  }
}
