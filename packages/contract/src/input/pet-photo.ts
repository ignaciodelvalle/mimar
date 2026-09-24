// Client-input contract for the PET PHOTO —
// `POST /api/v1/pets/{publicToken}/photo`.
//
// TWO COMMANDS, ONE URL, AND THE TWO ARE ONE ACT
// ---------------------------------------------------------------------------
// Setting a pet's photo from a phone is a round trip the client cannot do in a
// single request, because the bytes must not travel through our function:
//
//   1. `request_ticket` — the server authorizes the caller against the pet,
//      picks the object key itself, and mints a short-lived signed upload URL
//      into a PRIVATE staging bucket.
//   2. the client PUTs the bytes straight to Supabase Storage with that URL.
//      Nothing of ours is in the path, on purpose: a 5 MB photo through a
//      serverless function is bandwidth we pay for twice and a request-body
//      ceiling we do not control.
//   3. `confirm` — the server re-authorizes, FETCHES the staged bytes, and only
//      then decides whether they are an image at all.
//
// Two sibling URLs would be two copies of one bearer check, one limiter pair and
// one access guard, kept in agreement by hand — the argument `lost-mode.ts`
// makes for six commands and `writers.ts` makes for eleven kinds.
//
// WHY `contentType` IS ON THE REQUEST AND WHY IT DECIDES ALMOST NOTHING
// ---------------------------------------------------------------------------
// The staging bucket declares `allowed_mime_types` (migration 0206), and the
// Storage API compares an upload's declared type against that list. So the
// ticket has to name a type for the PUT to be accepted at all. What it does NOT
// do is establish that the bytes are an image: a caller may declare
// `image/jpeg` and send an SVG, an HTML document or a ZIP. That is settled at
// `confirm`, by magic bytes, over the bytes that actually arrived
// (`detectRasterMime` in lib/media/validate.ts).
//
// Its ONE real job here is choosing the object key's extension — server-side,
// from this closed list, never from a filename. A client filename in an object
// key is a path-traversal and an enumeration surface at once, which is why
// `lib/infra/uploads.ts` has derived the extension from the validated MIME
// since it was written.
//
// WHAT IS NOT HERE, AND WHY:
//   · `publicToken` — a PATH segment. A body naming it too would be a second
//     source for one identity.
//   · A BUCKET or a full object key on `request_ticket`. The server picks both.
//     A caller that could name its own key could write into another pet's
//     prefix, or probe for one.
//   · A CAPTION. `attachments.caption` exists and no web photo form writes one;
//     adding a field on this door alone would make the two doors disagree about
//     what a pet photo is.
//   · A SIZE. The client's number is a claim; the bucket's `file_size_limit` is
//     the enforcement, and it runs whether or not our code does.

import { z } from "zod";

/**
 * The content types a ticket may be minted for — the same three
 * `lib/media/validate.ts` whitelists and the same three the staging bucket
 * declares.
 *
 * SVG IS ABSENT AND THAT IS THE WHOLE LIST'S REASON FOR BEING A WHITELIST. A
 * pet photo ends up in a PUBLIC bucket, served from the Supabase origin; an SVG
 * there is stored XSS. The exclusion is structural — a format is in this list or
 * it does not exist to this endpoint — rather than a rule somebody has to
 * remember to apply.
 *
 * Restated in the contract package rather than imported from `lib/media` for the
 * reason every constant here is: `packages/contract` is the only thing a React
 * Native app can install, and it may not reach into the web app's `lib/`. The
 * two lists are kept equal by `__tests__/pet-photo-upload.test.ts`, which
 * asserts them against each other — not by anyone noticing.
 */
export const PET_PHOTO_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PetPhotoContentType = (typeof PET_PHOTO_CONTENT_TYPES)[number];

export const PET_PHOTO_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "CONTENT_TYPE_INVALID",
  "STAGED_PATH_REQUIRED",
] as const;
export type PetPhotoCommandInputCode = (typeof PET_PHOTO_COMMAND_INPUT_CODES)[number];

const requestTicket = z.object({
  command: z.literal("request_ticket"),
  contentType: z.enum(PET_PHOTO_CONTENT_TYPES, { message: "CONTENT_TYPE_INVALID" }),
});

/**
 * `confirm` carries the staged key the ticket handed back, and NOTHING ELSE.
 *
 * IT IS A CLAIM, NOT A CAPABILITY. The server does not trust this string: it
 * re-derives the prefix the key must have had for THIS pet and refuses anything
 * that does not match, so a caller cannot point `confirm` at another pet's
 * staged object, at a key it composed, or anywhere outside the staging bucket.
 * The shape rule below (no `..`, no leading slash, one directory deep) exists so
 * an obviously-malformed value is a 400 rather than a Storage round trip; it is
 * NOT the check that matters, and reading it as one would be the mistake this
 * paragraph exists to prevent.
 */
const confirm = z.object({
  command: z.literal("confirm"),
  stagedPath: z
    .string()
    .trim()
    .min(1, { message: "STAGED_PATH_REQUIRED" })
    .max(200, { message: "STAGED_PATH_REQUIRED" })
    // uuid/uuid.ext — the only shape the server ever mints. Anchored on both
    // ends, so a traversal segment cannot ride along after a valid prefix.
    .regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/, {
      message: "STAGED_PATH_REQUIRED",
    }),
});

export const petPhotoCommandInputSchema = z.discriminatedUnion("command", [requestTicket, confirm]);

export type PetPhotoCommandInput = z.infer<typeof petPhotoCommandInputSchema>;
export type PetPhotoCommand = PetPhotoCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstLostCommandInputCode` — same shape, same reason.
 */
export function firstPetPhotoCommandInputCode(
  error: z.ZodError<unknown>,
): PetPhotoCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((PET_PHOTO_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as PetPhotoCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
