// Client-input contract for ACOMPAÑAMIENTO DE ADOPCIÓN —
// `POST /api/v1/pets/{publicToken}/rehome`, the titular's three acts.
//
// THE OTHER HALF OF A BANNER THE APP COULD ONLY READ. `OwnerPetRehomeBannerV1`
// (owner-pet-detail.ts) has told the titular "hay una propuesta pendiente con
// X" / "X está buscándole un nuevo hogar" since the face was built; nothing on
// this surface could ask for one, cancel one or end one. These three commands
// reach the IDENTICAL use-cases the web's `buscar-hogar` page reaches
// (`requestRehomeSponsorship`, `withdrawRehomeRequest`,
// `withdrawRehomeSponsorship` in src/modules/rehome/application), which is what
// closes the three `write:*` entries `scripts/check-owner-surface-parity.ts`
// carried for them — a parallel implementation would not.
//
// THREE COMMANDS, ONE URL, the shape `/lost`, `/shares` and `/return` use: one
// bearer check, one limiter pair, one access guard. And ONE GUARD for all
// three, which is the rule worth reading before touching this file: every one
// is TITULAR-ONLY in the narrowest sense the web has — `requireTitularAccess`
// PLUS `holderRole === "owner"` (`src/modules/rehome/actions.ts`, "AUTH-SCOPE
// CONTRACT"). A co-owner passes `requireTitularAccess` everywhere else on this
// surface and is refused HERE, because consenting to hand an animal's listing
// to an org, and taking it back, are the legal owner's alone (spec REQ-1,
// REQ-14). The read's `capabilities` say so per command.
//
// `request_sponsorship` NAMES THE ORG BY ITS PUBLIC TOKEN, never by id — the
// rule every DTO on this surface keeps (`PetRegisteredV1`: an internal id is
// what a stolen access token buys). The web form posts ids; the door resolves
// the token and hands the use-case the id it has always taken.
//
// THE TWO WITHDRAWS REQUIRE AN `Idempotency-Key`, AND IT IS HONOURED. Each
// one's success invalidates its own precondition — once the request is
// cancelled there is "nothing pending", once the sponsorship is ended there is
// "nothing active" — so a retry after a lost response would be refused
// forever. The use-cases keep the key on the closing fact and ask that ledger
// BEFORE the state guard; the ack reports `replayed: true`. `request_sponsorship`
// takes NO key, deliberately: a replay of it meets the open request the first
// attempt created and answers `rehome_already_open`, the transfer surface's
// "re-read, do not re-send" shape, because a request is what the org's inbox
// is holding and absorbing a second one would be inventing consent twice.

import { z } from "zod";

export const REHOME_COMMAND_INPUT_CODES = ["COMMAND_REQUIRED", "ORG_REQUIRED"] as const;
export type RehomeCommandInputCode = (typeof REHOME_COMMAND_INPUT_CODES)[number];

/** Ask a verified org (a shelter or a rescue network covering the pet's zone) to sponsor. */
const requestSponsorship = z.object({
  command: z.literal("request_sponsorship"),
  orgPublicToken: z.string({ error: "ORG_REQUIRED" }).trim().min(1, { error: "ORG_REQUIRED" }),
});

/** Cancel the pending request before the org answers (REQ-3). */
const withdrawRequest = z.object({
  command: z.literal("withdraw_request"),
});

/** End the running sponsorship: the animal leaves the search, the org loses custody (REQ-8). */
const withdrawSponsorship = z.object({
  command: z.literal("withdraw_sponsorship"),
});

export const rehomeCommandInputSchema = z.discriminatedUnion("command", [
  requestSponsorship,
  withdrawRequest,
  withdrawSponsorship,
]);

export type RehomeCommandInput = z.infer<typeof rehomeCommandInputSchema>;
export type RehomeCommand = RehomeCommandInput["command"];

/** The commands whose writers keep a replay key — the ones the header requires it for. */
export const REHOME_COMMANDS_REQUIRING_IDEMPOTENCY_KEY: readonly RehomeCommand[] = [
  "withdraw_request",
  "withdraw_sponsorship",
];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstPetMoveCommandInputCode` — same shape, same reason.
 */
export function firstRehomeCommandInputCode(
  error: z.ZodError<unknown>,
): RehomeCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((REHOME_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as RehomeCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
