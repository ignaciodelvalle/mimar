// The two pet-photo commands, once the route has decided the caller may act.
//
// SPLIT OUT FOR THE REASON `lost/commands.ts` IS, and the split line is the
// same: everything ABOVE it decides WHO is asking and WHETHER they may, and
// lives in the route handler's own body because `check-api-v1-envelope` reads
// handler bodies and does not follow calls — a guard one indirection away reads
// as absent, and a reader auditing who may reach a URL should find the answer
// at the URL. Everything BELOW it is what the act does, and belongs where it can
// be read without the bearer plumbing around it.
//
// This file therefore takes a `petId` and a `userId` that have already been
// established. It authorizes nothing and must not start: two places deciding one
// question is how the two answers drift.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { confirmPetPhoto, mintPetPhotoTicket } from "@/lib/infra/pet-photo-upload";
import type { PetPhotoCommandInput } from "@dim/contract/input";

export async function runPhotoCommand(params: {
  petId: string;
  userId: string;
  input: PetPhotoCommandInput;
}): Promise<Response> {
  const { petId, userId, input } = params;

  if (input.command === "request_ticket") {
    const result = await mintPetPhotoTicket(petId, input.contentType);
    // 201: the ticket is a thing that now exists and has an address. The pet's
    // photo has not changed and this response never claims it has.
    return result.ok ? apiV1Json(result.ticket, { status: 201 }) : apiV1Error(result.code, 500);
  }

  const confirmed = await confirmPetPhoto({ petId, userId, stagedPath: input.stagedPath });
  if (confirmed.ok) return apiV1Json(confirmed.photo, { status: 200 });

  // The animal was erased between the ticket and the confirm. 404, the same
  // answer this surface gives for a pet the caller may not see: under PO-4 an
  // erased pet and one that never existed are not distinguishable on the wire.
  if (confirmed.code === "pet_gone") return apiV1Error("not_found", 404);

  // 400 for "that is not a photo" — the request was well-formed and the FILE is
  // the problem, which is a different instruction to the person holding the
  // phone. 500 for the rest, where nothing they can change would help.
  return apiV1Error(confirmed.code, confirmed.code === "photo_not_an_image" ? 400 : 500);
}
