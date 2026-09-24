// The one function that walks a photo through ticket → PUT → confirm.
//
// WHY IT EXISTS AS A MODULE and not as a callback inside the screen: the three
// calls have an ORDER, two short-circuit rules and a step signal, and that is
// logic a test must be able to drive without rendering anything. The screen
// owns what each outcome LOOKS like; this file owns what happens next.
//
// THE RULES, in one place:
//
//   1. THE STEPS RUN IN ORDER and each failure STOPS THE WALK. A confirm after
//      a failed PUT would ask the server to bless bytes that never landed; a
//      PUT after a refused ticket has no URL to aim at.
//   2. NOTHING HERE RETRIES. Whether to try again is the person's call — every
//      failure arm's copy says what a retry would honestly do
//      (`petPhotoFailureMessage`), and an automatic retry loop over a
//      metered upload on somebody's phone plan is not this module's decision
//      to make.
//   3. THE TICKET DIES HERE. It is passed straight from `requestPetPhotoTicket`
//      to `uploadPetPhotoBytes` and never stored, logged or returned — the
//      contract's own rule for a bearer capability (`pet-photo.ts`: it belongs
//      in the upload call and it dies with it). A failure result carries the
//      STAGE, never the ticket.
//   4. `onStep` fires BEFORE each step starts, so the label on screen names
//      the work in flight, not the work already done.

import type { PetPhotoUpdatedV1 } from "@dim/contract/api";
import type { ApiResult, SessionPort } from "../api/client";
import { confirmPetPhoto, requestPetPhotoTicket, uploadPetPhotoBytes } from "../api/endpoints";

import type {
  AcceptedImage,
  PetPhotoUploadFailure,
  PetPhotoUploadStep,
} from "./pet-photo-view-model";

export type PetPhotoUploadResult =
  | { outcome: "done"; photo: PetPhotoUpdatedV1 }
  | { outcome: "failed"; failure: PetPhotoUploadFailure };

/** A refused ApiResult, with the payload arm typed away for the failure union. */
function refused<T>(result: Exclude<ApiResult<T>, { outcome: "ok" }>) {
  return result as Exclude<ApiResult<never>, { outcome: "ok" }>;
}

export async function runPetPhotoUpload(
  session: SessionPort,
  publicToken: string,
  image: AcceptedImage,
  onStep: (step: PetPhotoUploadStep) => void = () => {},
): Promise<PetPhotoUploadResult> {
  onStep("ticket");
  const ticket = await requestPetPhotoTicket(session, publicToken, image.contentType);
  if (ticket.outcome !== "ok") {
    return { outcome: "failed", failure: { stage: "ticket", result: refused(ticket) } };
  }

  onStep("put");
  const put = await uploadPetPhotoBytes(ticket.payload, image.bytes, image.contentType);
  if (put.outcome !== "ok") {
    // The three refusal arms are forwarded BY NAME rather than folded together,
    // because they disagree about what the person should do next and only the
    // step that made the call knows which one happened. See the measured table
    // above `uploadPetPhotoBytes`.
    return {
      outcome: "failed",
      failure: { stage: "put", kind: put.outcome, detail: put.detail },
    };
  }

  onStep("confirm");
  const confirmed = await confirmPetPhoto(session, publicToken, ticket.payload.stagedPath);
  if (confirmed.outcome !== "ok") {
    return { outcome: "failed", failure: { stage: "confirm", result: refused(confirmed) } };
  }
  return { outcome: "done", photo: confirmed.payload };
}
