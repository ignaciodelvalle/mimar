// A dispute's evidence photo → a staged key, through the CLAIM door's ticket (D6).
//
// The denuncia's pipeline (`denuncias/evidence-flow.ts`) with the one thing that
// differs: the ticket is minted by `request_evidence_ticket` on
// `POST /api/v1/me/pet-claims`, which spends the caller's own media budget. The
// key it hands back names nobody and the server judges the photo with the web's
// gate — EXIF/GPS strip included — when the dispute is sent.

import type { SessionPort } from "../api/client";
import { sendPetClaimCommand } from "../api/endpoints";
import {
  type EvidenceImage,
  type StageEvidenceResult,
  stageEvidencePhoto,
} from "../denuncias/evidence-flow";

/** Unlike the denuncia's, a dispute cannot go without the photo — so no "sin ella". */
export const DISPUTE_UPLOAD_FAILED =
  "No pudimos subir la foto. Revisá tu conexión y probá de nuevo: la disputa necesita al menos una.";

export function stageDisputePhoto(
  session: SessionPort,
  image: EvidenceImage,
): Promise<StageEvidenceResult> {
  return stageEvidencePhoto(
    async (contentType) => {
      const result = await sendPetClaimCommand(session, {
        command: "request_evidence_ticket",
        contentType,
      });
      if (result.outcome !== "ok") return result;
      return {
        outcome: "ok",
        payload: result.payload.command === "request_evidence_ticket" ? result.payload : null,
      };
    },
    image,
    DISPUTE_UPLOAD_FAILED,
  );
}
