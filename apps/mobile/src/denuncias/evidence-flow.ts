// Evidence photos from the phone (M12, D6): one photo → a staged key.
//
// THE PET PHOTO'S PIPELINE, END TO END, with nothing new in it. The picker is
// the same port (`native/image-picker-port.ts`, whose adapter re-encodes to
// JPEG and drops EXIF on the device); the acceptance rules are the pet photo's
// (`acceptPickedImage`: JPG/PNG/WebP, HEIC refused with its own sentence); the
// PUT is `uploadPetPhotoBytes` — a Uint8Array body, never a Blob, because
// Android drops a Blob's content-type and the bucket refuses octet-stream.
//
// What differs per caller is only WHO MINTS THE TICKET: `request_evidence_ticket`
// on the denuncia door, or the same command on the claim door for a dispute
// (D6). Both mint into the same private staging bucket with a key that names
// nobody (`welfare/{uuid}.{ext}`), and the server then runs the WEB's own gate
// over every staged photo at filing time — the EXIF/GPS strip included,
// failing closed — so the on-device strip is a first line, not the guarantee.

import type { PetPhotoTicketV1 } from "@dim/contract/api";
import type { WelfareEvidenceContentType } from "@dim/contract/input";

import { type ApiResult, type SessionPort, apiFailureMessage } from "../api/client";
import { sendWelfareReportCommand, uploadPetPhotoBytes } from "../api/endpoints";

export type StagedEvidence = {
  /** What the filing names in `evidence`. */
  stagedPath: string;
  /** Device-local, for the thumbnail only. */
  previewUri: string | null;
};

export type StageEvidenceResult =
  | { outcome: "staged"; evidence: StagedEvidence }
  | { outcome: "failed"; message: string };

/** One picked, accepted photo, ready to stage. */
export type EvidenceImage = {
  bytes: Uint8Array;
  contentType: WelfareEvidenceContentType;
  previewUri: string | null;
};

export const EVIDENCE_UPLOAD_FAILED =
  "No pudimos subir la foto. Revisá tu conexión y probá de nuevo, o enviá la denuncia sin ella.";
export const EVIDENCE_FILE_REFUSED =
  "No pudimos usar esa foto: tiene que ser JPG, PNG o WebP de hasta 5 MB. Probá con otra.";

/**
 * Mint a ticket through `requestTicket`, then PUT the bytes to it.
 *
 * `requestTicket` answers the door's own ack narrowed to the ticket; a `null`
 * payload means the door answered some other command (unreachable, and still
 * given a sentence). `uploadFailed` is the caller's sentence for a transport
 * failure, because the way forward differs: a denuncia can go without the
 * photo, a dispute cannot.
 */
export async function stageEvidencePhoto(
  requestTicket: (
    contentType: WelfareEvidenceContentType,
  ) => Promise<ApiResult<PetPhotoTicketV1 | null>>,
  image: EvidenceImage,
  uploadFailed: string,
): Promise<StageEvidenceResult> {
  const ticket = await requestTicket(image.contentType);
  if (ticket.outcome !== "ok") {
    return { outcome: "failed", message: apiFailureMessage(ticket) ?? uploadFailed };
  }
  if (ticket.payload === null) return { outcome: "failed", message: uploadFailed };

  const put = await uploadPetPhotoBytes(ticket.payload, image.bytes, image.contentType);
  if (put.outcome === "ok") {
    return {
      outcome: "staged",
      evidence: { stagedPath: ticket.payload.stagedPath, previewUri: image.previewUri },
    };
  }
  // The FILE was refused by the bucket (type or size): a retry cannot cure it.
  // Anything else — an expired ticket, no signal — a retry mints a new ticket.
  return {
    outcome: "failed",
    message: put.outcome === "rejected" ? EVIDENCE_FILE_REFUSED : uploadFailed,
  };
}

/** The denuncia door's ticket. */
export function stageDenunciaPhoto(
  session: SessionPort,
  image: EvidenceImage,
): Promise<StageEvidenceResult> {
  return stageEvidencePhoto(
    async (contentType) => {
      const result = await sendWelfareReportCommand(session, {
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
    EVIDENCE_UPLOAD_FAILED,
  );
}
