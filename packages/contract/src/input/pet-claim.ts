// What a client may SEND to `POST /api/v1/me/pet-claims`.
//
// FOUR COMMANDS: THE WEB WIZARD'S THREE WRITES, PLUS THE TICKET THE THIRD NEEDS
// ---------------------------------------------------------------------------
// The web's claim wizard has three writes — `lookupForClaimAction`,
// `submitFreeClaimAction` and `submitClaimDisputeAction` — and all three are
// here. The dispute used to be the one deliberate absence in this package: it
// requires at least one evidence FILE, server-side and absolutely (PO decision
// 2026-07-30), because raising one is a permanent, third-party-visible
// accusation — it notifies whoever holds the animal, appends an uneditable
// `custody_dispute_raised` row to its spine, flips `pets.in_custody_dispute`
// (which strips the owner's phone and the finder form off the public
// credential) and opens a case a local authority has to adjudicate. While the
// app could not attach a file, a `dispute` member would have been a command the
// server refused on every call. The app now carries an image picker (the M12
// denuncia photos run on it), so the member landed with D6 (2026-09-25) — the
// "deliberate edit the day this app can carry bytes" this header promised.
//
// THE EVIDENCE TRAVELS AS STAGED KEYS, NEVER AS BYTES. `request_evidence_ticket`
// mints a one-shot upload URL into the private staging bucket — the SAME
// ticket, bucket and key shape as the denuncia's (`welfare/{uuid}.{ext}`, see
// `welfare-report.ts`), because the dispute's evidence ends in the same
// `welfare-evidence` bucket through the same web gate. The phone PUTs the
// photo, then `dispute` names the keys. Nothing is believed about a staged
// object until the server has claimed it (single use), downloaded it and run
// the web's own evidence gate over it, EXIF/GPS strip included.
//
// PHOTOS ONLY, while the web also takes video. The gap is the denuncia's, for
// the denuncia's reason: a phone video keeps where it was shot until the D4b
// neutraliser lands, and this product stores no device location (PO
// 2026-09-24). The COUNT is the web's: five (`MAX_FILES` in
// `lib/infra/welfare-uploads.ts`).
//
// THE IDENTIFIER IS THE AUTHORIZATION, WHICH IS WHY NO SHAPE HERE HAS A TOKEN
// ---------------------------------------------------------------------------
// Both writers resolve the animal FROM `identifierValue` against
// `pet_identifications` and consult no caller-supplied pet token anywhere. That
// is not defence in depth, it is the whole boundary: the public token is printed
// on the tag and listed for every lost animal on `/perdidas` with no login, so a
// token-addressed claim would be a claim anybody could aim at any animal. A
// mismatch is not rejected here — it is unrepresentable.
//
// THE 15-DIGIT RULE IS CHECKED IN THREE PLACES AND THAT IS CORRECT
// ---------------------------------------------------------------------------
// Here (so a phone says it without a round trip), in `lookupForClaimForUser`, and
// in `submitFreeClaimForUser`. The two server copies predate this file and are
// the ones that matter; this one exists to spend no rate-limit budget on a value
// that cannot match anything. It is the ISO 11784/11785 length the web's own
// input pins with `pattern="\d{15}"`.
//
// NO CAP ON THE TATTOO CODE, deliberately. `pet_identifications.code` is
// unbounded `text` and neither writer caps it, so a cap invented here would
// refuse a code the registry already holds — the same reasoning
// `resolvePetIdentityLengths` records for `pets.name` and `pets.color`.

import { z } from "zod";

import type { PetClaimCommandAckV1 } from "../api/pet-claim.ts";
import {
  WELFARE_EVIDENCE_CONTENT_TYPES,
  WELFARE_EVIDENCE_MAX_FILES,
  WELFARE_EVIDENCE_STAGED_PATH_RE,
} from "./welfare-report.ts";

/**
 * The per-field codes a client can act on locally.
 *
 * SCREAMING_SNAKE, like every other input module here, and deliberately NOT the
 * `lowercase_snake` of `@dim/contract/api`'s error vocabulary: these are refusals
 * a client computes for ITSELF before any round trip, and the two casings are how
 * a reader tells "the server said no" from "the form did".
 */
export const PET_CLAIM_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "IDENTIFIER_KIND_REQUIRED",
  "IDENTIFIER_REQUIRED",
  "MICROCHIP_MUST_BE_15_DIGITS",
  "REASON_TOO_SHORT",
  "REASON_TOO_LONG",
  "EVIDENCE_REQUIRED",
  "EVIDENCE_TOO_MANY",
  "EVIDENCE_INVALID",
  "CONTENT_TYPE_INVALID",
] as const;

export type PetClaimCommandInputCode = (typeof PET_CLAIM_COMMAND_INPUT_CODES)[number];

/**
 * The two private identifiers a claim may be proved with.
 *
 * THE WEB'S OWN TWO, and the pairing with the canonical `pet_identifications.kind`
 * is the SERVER'S job, not this file's: `microchip` maps to `microchip_iso` and
 * `tattoo` maps to `tattoo` inside both use-cases. Sending the storage vocabulary
 * over the wire would make a client name a database enum.
 */
export const PET_CLAIM_IDENTIFIER_KINDS = ["microchip", "tattoo"] as const;
export type PetClaimIdentifierKind = (typeof PET_CLAIM_IDENTIFIER_KINDS)[number];

/** ISO 11784/11785 — exactly fifteen digits, the pattern both writers enforce. */
export const MICROCHIP_DIGITS = 15;
const MICROCHIP_RE = /^\d{15}$/;

const identifierFields = {
  identifierKind: z.enum(PET_CLAIM_IDENTIFIER_KINDS, { error: "IDENTIFIER_KIND_REQUIRED" }),
  identifierValue: z
    .string({ error: "IDENTIFIER_REQUIRED" })
    .trim()
    .min(1, { error: "IDENTIFIER_REQUIRED" }),
};

/**
 * The cross-field half: a microchip is fifteen digits, a tattoo is anything.
 *
 * A `superRefine` AND NOT A BRANCH PER KIND, because the kind is not the
 * discriminator — `command` is — and a second discriminated union nested inside
 * the first would make the four combinations four schemas.
 */
function refineIdentifier(
  value: { identifierKind: PetClaimIdentifierKind; identifierValue: string },
  ctx: z.RefinementCtx,
): void {
  if (value.identifierKind !== "microchip") return;
  if (MICROCHIP_RE.test(value.identifierValue)) return;
  ctx.addIssue({
    code: "custom",
    message: "MICROCHIP_MUST_BE_15_DIGITS",
    path: ["identifierValue"],
  });
}

/** ¿DE QUIÉN ES? — resolve the identifier and say what may be done about it. */
const lookup = z
  .object({ command: z.literal("lookup"), ...identifierFields })
  .superRefine(refineIdentifier);

/**
 * RECLAMARLA. Only ever legitimate for an animal with NO active custody.
 *
 * IT CARRIES THE IDENTIFIER AGAIN RATHER THAN A HANDLE FROM THE LOOKUP, and that
 * repetition is the security property, not an ergonomic miss. The writer re-runs
 * the resolution from the value inside its own transaction, so there is no
 * lookup-issued handle to steal, replay or guess — and no window in which a
 * client could point a claim at an animal the lookup never returned.
 */
const claimFree = z
  .object({ command: z.literal("claim_free"), ...identifierFields })
  .superRefine(refineIdentifier);

/**
 * The explanation's bounds — the web's own two numbers, from
 * `submitClaimDisputeForUser` (at least 20 characters once trimmed, at most
 * 2000) and the wizard's `minLength`/`maxLength`. The use-case re-checks both
 * and is the copy that governs; these let a phone count characters live.
 */
export const CLAIM_DISPUTE_REASON_MIN_LENGTH = 20;
export const CLAIM_DISPUTE_REASON_MAX_LENGTH = 2000;

/** At least one photo, at most the web's five. */
export const CLAIM_EVIDENCE_MAX_FILES = WELFARE_EVIDENCE_MAX_FILES;
/** Photos only — see the header for why not the web's video. */
export const CLAIM_EVIDENCE_CONTENT_TYPES = WELFARE_EVIDENCE_CONTENT_TYPES;
export type ClaimEvidenceContentType = (typeof CLAIM_EVIDENCE_CONTENT_TYPES)[number];

/**
 * ¿TENÉS FOTOS? — mint a one-shot upload URL for ONE evidence photo.
 *
 * NO IDENTIFIER, deliberately: a ticket authorizes one 5 MB write into a
 * private bucket and nothing else, and asking for the chip here would put the
 * evidence that authorizes a claim on a request that does not need it.
 */
const requestEvidenceTicket = z.object({
  command: z.literal("request_evidence_ticket"),
  contentType: z.enum(CLAIM_EVIDENCE_CONTENT_TYPES, { error: "CONTENT_TYPE_INVALID" }),
});

/**
 * INICIAR UNA DISPUTA — raise a `custody_dispute` against whoever holds the
 * animal, with an explanation and at least one photo.
 *
 * THE IDENTIFIER AGAIN, for `claim_free`'s reason: the writer re-resolves the
 * animal from it, so there is no lookup-issued handle to replay and no token a
 * caller could aim at an animal the lookup never returned.
 */
const dispute = z
  .object({
    command: z.literal("dispute"),
    ...identifierFields,
    reason: z
      .string({ error: "REASON_TOO_SHORT" })
      .trim()
      .min(CLAIM_DISPUTE_REASON_MIN_LENGTH, { error: "REASON_TOO_SHORT" })
      .max(CLAIM_DISPUTE_REASON_MAX_LENGTH, { error: "REASON_TOO_LONG" }),
    evidence: z
      .array(z.string().regex(WELFARE_EVIDENCE_STAGED_PATH_RE, { error: "EVIDENCE_INVALID" }), {
        error: "EVIDENCE_REQUIRED",
      })
      .min(1, { error: "EVIDENCE_REQUIRED" })
      .max(CLAIM_EVIDENCE_MAX_FILES, { error: "EVIDENCE_TOO_MANY" })
      // The same key twice is one photo claimed twice: the second claim finds
      // the object already moved and the whole dispute is refused. Refused here
      // instead, where a client can say why.
      .refine((keys) => new Set(keys).size === keys.length, { error: "EVIDENCE_INVALID" }),
  })
  .superRefine(refineIdentifier);

export const petClaimCommandInputSchema = z.discriminatedUnion("command", [
  lookup,
  claimFree,
  requestEvidenceTicket,
  dispute,
]);

export type PetClaimCommandInput = z.infer<typeof petClaimCommandInputSchema>;
export type PetClaimCommand = PetClaimCommandInput["command"];
export type PetClaimDisputeInput = z.infer<typeof dispute>;

/**
 * A COMPILE-TIME proof that the schema's command union and the commands the acks
 * name are the same set, in both directions.
 *
 * The api entry point has to name the command on `PetClaimCommandAckV1` without
 * pulling zod in, so the vocabulary exists twice — once as literal types over
 * there and once as a discriminated union here. This is what stops the pair from
 * drifting: a command added to one and forgotten in the other is a type error
 * HERE, in the package, rather than an ack nothing can produce. Same instrument
 * `appointment.ts` and `notification.ts` use.
 */
type CommandsAgree = [PetClaimCommand] extends [PetClaimCommandAckV1["command"]]
  ? [PetClaimCommandAckV1["command"]] extends [PetClaimCommand]
    ? true
    : never
  : never;
const _commandsAgree: CommandsAgree = true;
void _commandsAgree;

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstAppointmentCommandInputCode` — same shape, same reason.
 */
export function firstPetClaimCommandInputCode(
  error: z.ZodError<unknown>,
): PetClaimCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((PET_CLAIM_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as PetClaimCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
