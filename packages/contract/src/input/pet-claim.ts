// What a client may SEND to `POST /api/v1/me/pet-claims`.
//
// TWO COMMANDS, AND THE THIRD ONE'S ABSENCE IS A RULE RATHER THAN SCOPE
// ---------------------------------------------------------------------------
// The web's claim wizard has three writes. `lookupForClaimAction` and
// `submitFreeClaimAction` are here. `submitClaimDisputeAction` is NOT, and it is
// the only omission in this package's input modules that is a refusal instead of
// a scope line.
//
// A dispute requires at least one evidence FILE, server-side and absolutely:
// `submit-claim-dispute.ts` filters empty entries and returns
// "Adjuntá al menos una foto o un video como prueba" when nothing survives (PO
// decision 2026-07-30). The gate exists because raising one is not a request but
// a permanent, third-party-visible accusation — it notifies the registered owner,
// appends an uneditable `custody_dispute_raised` row to the animal's spine, flips
// `pets.in_custody_dispute` (which strips the owner's phone and the finder form
// off the public credential, on exactly the animals a finder needs to reach), and
// opens a case a local authority has to adjudicate.
//
// This transport is JSON and this app cannot attach a file — an image picker is a
// native module, which is an EAS build. A `dispute` member here would therefore
// be a command the server must refuse on every single call. That is strictly
// worse than not offering it: a client would draw the control, the person would
// write two hundred characters explaining why the dog is theirs, and the answer
// would always be no. So the union has two members, `active_owner` sends a client
// to the browser, and adding the third is a deliberate edit the day this app can
// carry bytes.
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

export const petClaimCommandInputSchema = z.discriminatedUnion("command", [lookup, claimFree]);

export type PetClaimCommandInput = z.infer<typeof petClaimCommandInputSchema>;
export type PetClaimCommand = PetClaimCommandInput["command"];

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
