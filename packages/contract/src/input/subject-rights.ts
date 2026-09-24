// What a client may SEND to `POST /api/v1/me/privacy` — the supresión.
//
// ONE COMMAND, AND IT IS STILL A DISCRIMINATED UNION
// ---------------------------------------------------------------------------
// `erase_account` is the only write this surface has, so a bare
// `{ reason: string }` would parse the same requests today. It is a
// `discriminatedUnion` on `command` anyway, for the reason the transfers and
// notifications inputs are: a body with no verb in it cannot be extended
// without either changing the shape of every existing client's request or
// growing a second, verbless parse path beside the first. The right that WILL
// arrive here is rectificación (art. 16 is the same article as the one this
// implements, and the "R" in ARCO is not served anywhere in this product yet) —
// and when it does, it is one more member rather than a migration.
//
// THE EXPORT IS NOT HERE, because it takes no input at all. `GET /me/privacy`
// carries a bearer token and nothing else; there is no body to validate, which
// is precisely why the read is a GET and not a third command.
//
// THE REASON IS MANDATORY AND THAT IS THE WEB'S RULE, NOT A NEW ONE
// ---------------------------------------------------------------------------
// `eraseSubjectDataFor` refuses anything under five characters and the web form
// disables its confirm button below the same number. This schema states it a
// third time on purpose: a client that validates locally shows the person WHY
// the button is dead before they tap it, and the server's copy is the backstop
// for a client out of step with this file. Neither is redundant — one is
// feedback, the other is enforcement.

import { z } from "zod";

/**
 * The minimum length of a stated reason.
 *
 * FIVE, matching `AMEND_REASON_MIN_LENGTH` and the erasure use-case's own guard.
 * It is not a quality bar and cannot be — "nada" is five characters. What it
 * bounds is the empty submission, so the `erasure_reason` the RPC records is at
 * least an attempt at an answer rather than a blank the audit row cannot use.
 */
export const ERASURE_REASON_MIN_LENGTH = 5;

/**
 * The maximum, matching the web textarea's `maxLength={500}`.
 *
 * A ceiling the CLIENT can enforce, so a person who pasted an essay is told by
 * their own screen instead of by a 400 after the round trip. The server parses
 * the same bound, which is what makes the two agree.
 */
export const ERASURE_REASON_MAX_LENGTH = 500;

/**
 * The per-field codes a client can act on locally.
 *
 * SCREAMING_SNAKE, like every other input module here, and deliberately NOT the
 * `lowercase_snake` of `@dim/contract/api`'s error vocabulary: these are refusals
 * a client computes for ITSELF before any round trip.
 */
export const SUBJECT_RIGHTS_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "REASON_TOO_SHORT",
  "REASON_TOO_LONG",
] as const;

export type SubjectRightsCommandInputCode = (typeof SUBJECT_RIGHTS_COMMAND_INPUT_CODES)[number];

const eraseAccount = z.object({
  command: z.literal("erase_account"),
  /**
   * The subject's own words, trimmed. Stored verbatim by `erase_subject_data`
   * in the audit row it writes — which is why the trim happens HERE and not at
   * the call site: a reason of eight spaces must be refused as empty, not
   * recorded as eight spaces.
   */
  reason: z
    .string({ error: "REASON_TOO_SHORT" })
    .trim()
    .min(ERASURE_REASON_MIN_LENGTH, { error: "REASON_TOO_SHORT" })
    .max(ERASURE_REASON_MAX_LENGTH, { error: "REASON_TOO_LONG" }),
});

export const subjectRightsCommandInputSchema = z.discriminatedUnion("command", [eraseAccount]);

export type SubjectRightsCommandInput = z.infer<typeof subjectRightsCommandInputSchema>;
export type SubjectRightsCommand = SubjectRightsCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstNotificationCommandInputCode` — same shape, same reason.
 */
export function firstSubjectRightsCommandInputCode(
  error: z.ZodError<unknown>,
): SubjectRightsCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((SUBJECT_RIGHTS_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as SubjectRightsCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
