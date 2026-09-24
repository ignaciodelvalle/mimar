// LA FOTO DEL TATUAJE — los DOS pasos que la dejan lista para el asiento.
//
// `pet-photo-upload-flow.ts` walks THREE steps (ticket → PUT → confirm) because
// a pet photo's confirm is its own endpoint. A tattoo has no third call of its
// own: the asiento IS the confirm. `POST /pets/{token}/events` with
// `kind: "tattoo"` carries the `stagedPath` this module produces, and the
// server claims those bytes into `event-attachments` inside the same request
// that appends the event.
//
// SO THE PHOTO IS STAGED WHEN IT IS PICKED, NOT WHEN THE FORM IS SUBMITTED, and
// that ordering is the point of this module existing separately:
//
//   · A PERSON LEARNS THE UPLOAD FAILED WHILE THEY ARE STILL LOOKING AT THE
//     PHOTO, not after they finished six more fields. The web's file input
//     gives the same immediacy for free; a phone on a weak link does not.
//   · A REFUSED FIELD COSTS NO MEGABYTES. Staging at submit time would upload
//     the file, then have the contract refuse a missing `tattooCode`, and the
//     next attempt would upload it again.
//   · A STAGED OBJECT SURVIVES THE FORM. The signed PUT's window is two hours
//     (`SUPABASE_SIGNED_UPLOAD_VALIDITY_SECONDS`), so a person who takes ten
//     minutes over the rest of the fields still has a valid staged path.
//
// NOTHING HERE RETRIES, the same rule `pet-photo-upload-flow.ts` states: every
// failure arm's sentence already says what a retry would honestly do, and an
// automatic loop over a metered upload on somebody's phone plan is not this
// module's decision.
//
// THE TICKET DIES HERE. It goes from `requestPetPhotoTicket` straight into
// `uploadPetPhotoBytes` and is never stored, logged or returned — only the
// staged path survives, which is a name and not a capability.

import type { SessionPort } from "../api/client";
import { requestPetPhotoTicket, uploadPetPhotoBytes } from "../api/endpoints";

import type { AcceptedImage, PetPhotoUploadFailure } from "./pet-photo-view-model";

export type TattooPhotoStageResult =
  /** The bytes are in `uploads-staging`. This path goes in the asiento's body. */
  { outcome: "staged"; stagedPath: string } | { outcome: "failed"; failure: PetPhotoUploadFailure };

export async function stageTattooPhoto(
  session: SessionPort,
  publicToken: string,
  image: AcceptedImage,
): Promise<TattooPhotoStageResult> {
  const ticket = await requestPetPhotoTicket(session, publicToken, image.contentType);
  if (ticket.outcome !== "ok") {
    return {
      outcome: "failed",
      // The `never` payload arm is typed away for the failure union, exactly as
      // `refused()` does next door. A refusal carries no payload by
      // construction, so the cast removes a branch nobody can reach.
      failure: {
        stage: "ticket",
        result: ticket as Exclude<typeof ticket, { outcome: "ok" }>,
      },
    };
  }

  const put = await uploadPetPhotoBytes(ticket.payload, image.bytes, image.contentType);
  if (put.outcome !== "ok") {
    // Forwarded by name, same as the pet-photo flow: a tattoo photo the bucket
    // refuses by type or size is not a ticket that expired, and telling the
    // person to retry would be advice that cannot work.
    return {
      outcome: "failed",
      failure: { stage: "put", kind: put.outcome, detail: put.detail },
    };
  }

  return { outcome: "staged", stagedPath: ticket.payload.stagedPath };
}
