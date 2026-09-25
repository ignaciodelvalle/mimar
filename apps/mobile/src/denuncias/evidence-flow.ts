// Denuncia evidence from the phone (M12): one photo → a staged key.
//
// THE PET PHOTO'S PIPELINE, END TO END, with nothing new in it. The picker is
// the same port (`native/image-picker-port.ts`, whose adapter re-encodes to
// JPEG and drops EXIF on the device); the acceptance rules are the pet photo's
// (`acceptPickedImage`: JPG/PNG/WebP, HEIC refused with its own sentence); the
// PUT is `uploadPetPhotoBytes` — a Uint8Array body, never a Blob, because
// Android drops a Blob's content-type and the bucket refuses octet-stream.
//
// What is new is only WHO MINTS THE TICKET: `request_evidence_ticket` on the
// denuncia door, whose key names nobody (`welfare/{uuid}.{ext}`). The server
// then runs the WEB's own gate over every staged photo at filing time — the
// EXIF/GPS strip included, failing closed — so the on-device strip is a first
// line, not the guarantee.

import type { WelfareEvidenceContentType } from "@dim/contract/input";

import { type SessionPort, apiFailureMessage } from "../api/client";
import { sendWelfareReportCommand, uploadPetPhotoBytes } from "../api/endpoints";

export type StagedEvidence = {
  /** What `file` names in `evidence`. */
  stagedPath: string;
  /** Device-local, for the thumbnail only. */
  previewUri: string | null;
};

export type StageEvidenceResult =
  | { outcome: "staged"; evidence: StagedEvidence }
  | { outcome: "failed"; message: string };

export const EVIDENCE_UPLOAD_FAILED =
  "No pudimos subir la foto. Revisá tu conexión y probá de nuevo, o enviá la denuncia sin ella.";
export const EVIDENCE_FILE_REFUSED =
  "No pudimos usar esa foto: tiene que ser JPG, PNG o WebP de hasta 5 MB. Probá con otra.";

export async function stageDenunciaPhoto(
  session: SessionPort,
  image: { bytes: Uint8Array; contentType: WelfareEvidenceContentType; previewUri: string | null },
): Promise<StageEvidenceResult> {
  const ticket = await sendWelfareReportCommand(session, {
    command: "request_evidence_ticket",
    contentType: image.contentType,
  });
  if (ticket.outcome !== "ok") {
    return { outcome: "failed", message: apiFailureMessage(ticket) ?? EVIDENCE_UPLOAD_FAILED };
  }
  if (ticket.payload.command !== "request_evidence_ticket") {
    return { outcome: "failed", message: EVIDENCE_UPLOAD_FAILED };
  }

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
    message: put.outcome === "rejected" ? EVIDENCE_FILE_REFUSED : EVIDENCE_UPLOAD_FAILED,
  };
}
