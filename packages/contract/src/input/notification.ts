// What a client may SEND to `POST /api/v1/me/notifications`.
//
// THREE COMMANDS, AND THEY ARE THE WEB'S THREE
// ---------------------------------------------------------------------------
// `markNotificationReadAction`, `markAllNotificationsReadAction` and
// `archiveNotificationAction` (app/actions/notifications.ts) are every write the
// browser can make to an inbox. There is no fourth here, and there must not be:
// a phone that could delete a notification, or mark one UNread, would be doing
// something no browser can, which is not parity in the direction this programme
// measures.
//
// WHAT THESE WRITES ACTUALLY MUTATE, SAID PLAINLY
// ---------------------------------------------------------------------------
// `notifications.read_at` and `notifications.archived_at`. Nothing else, and
// NOTHING ON THE EVENT SPINE. A read receipt is not a fact about an animal — it
// is a fact about a person's inbox — so invariant #2 is untouched rather than
// bent: there is no asiento to append and no correction to record. Nor is either
// column a CACHE of anything (invariant #3): they are not derived from the spine
// and no re-derivation could reconstruct them. They are operational state whose
// only source of truth is the tap that set them.
//
// `mark_read` TAKES A LIST, AND THAT IS THE ONE PLACE THIS CONTRACT IS NOT A
// TRANSCRIPTION OF THE WEB'S. The server action marks ONE row, because a browser
// form posts one submission per button. A phone marking a screenful one row at a
// time would spend one HTTP round trip per tap against a per-user limiter, on a
// screen whose whole job is to be tapped through — so the command takes an array
// and the single-row case is an array of one. The endpoint's rate-limit family is
// sized against that shape (`lib/infra/api-v1-limits.ts`); a client that ignored
// the batch would be refused by the ceiling that assumes it.
//
// `archive` TAKES ONE, deliberately, and the asymmetry is the ACT's rather than
// the transport's: archiving is how a row leaves the inbox for good, and a
// mis-tap that took twelve rows with it has no undo anywhere in this product.
// Marking read is recoverable by reading; archiving is not recoverable at all.

import { z } from "zod";

import {
  MY_NOTIFICATIONS_PAGE_LIMIT,
  type NotificationCommandV1,
} from "../api/my-notifications.ts";

/**
 * The per-field codes a client can act on locally.
 *
 * SCREAMING_SNAKE, like every other input module here, and deliberately NOT the
 * `lowercase_snake` of `@dim/contract/api`'s error vocabulary: these are refusals
 * a client computes for ITSELF before any round trip, and the two casings are how
 * a reader tells "the server said no" from "the form did".
 */
export const NOTIFICATION_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "NOTIFICATION_ID_REQUIRED",
  "NOTIFICATION_IDS_REQUIRED",
  "TOO_MANY_NOTIFICATION_IDS",
] as const;

export type NotificationCommandInputCode = (typeof NOTIFICATION_COMMAND_INPUT_CODES)[number];

/**
 * How many rows one `mark_read` may name.
 *
 * THE PAGE LIMIT ITSELF, imported rather than restated: the largest honest batch
 * is "everything on the screen", the screen holds one page, and a cap above the
 * page a client can hold is a cap that bounds nothing. Two numbers that must
 * agree, written twice, is the drift this package exists to prevent — and the
 * arrow points this way safely because `@dim/contract/api` carries no runtime
 * dependency, so importing a constant from it never drags zod into a consumer
 * that only reads an inbox.
 */
export const NOTIFICATION_MARK_READ_MAX_IDS = MY_NOTIFICATIONS_PAGE_LIMIT;

/**
 * One notification id, as the endpoint receives it.
 *
 * SHAPE ONLY, NEVER EXISTENCE. `notifications.id` is a uuid and this does not
 * check that it is one, for the reason the transfer contract refuses to check an
 * address: a client that could learn "no such notification" from a well-formed
 * id it guessed would have an oracle, and the write is scoped to the caller's own
 * rows anyway — an id belonging to somebody else updates nothing and answers the
 * same as an id belonging to nobody.
 */
const notificationId = z
  .string({ error: "NOTIFICATION_ID_REQUIRED" })
  .trim()
  .min(1, { error: "NOTIFICATION_ID_REQUIRED" });

/** MARK ROWS READ. One or many; see the header for why this is the batched one. */
const markRead = z.object({
  command: z.literal("mark_read"),
  notificationIds: z
    .array(notificationId, { error: "NOTIFICATION_IDS_REQUIRED" })
    .min(1, { error: "NOTIFICATION_IDS_REQUIRED" })
    .max(NOTIFICATION_MARK_READ_MAX_IDS, { error: "TOO_MANY_NOTIFICATION_IDS" }),
});

/**
 * MARK THE WHOLE INBOX READ.
 *
 * Takes nothing, and could not usefully take a category filter: the web's button
 * clears everything unread regardless of which tab is showing
 * (`markAllNotificationsRead` has no category predicate), so a scoped version
 * here would be a phone doing something a browser cannot.
 */
const markAllRead = z.object({ command: z.literal("mark_all_read") });

/** ARCHIVE ONE ROW. Singular on purpose — see the header. */
const archive = z.object({ command: z.literal("archive"), notificationId });

export const notificationCommandInputSchema = z.discriminatedUnion("command", [
  markRead,
  markAllRead,
  archive,
]);

export type NotificationCommandInput = z.infer<typeof notificationCommandInputSchema>;
export type NotificationCommand = NotificationCommandInput["command"];

/**
 * A COMPILE-TIME proof that the schema's command union and the api entry point's
 * `NOTIFICATION_COMMANDS_V1` are the same set, in both directions.
 *
 * The api entry point declares the list so the ack type can name a command
 * without pulling zod in — which means the vocabulary exists twice, once as a
 * frozen array and once as a discriminated union. This is what stops the pair
 * from drifting: a fourth command added to one and forgotten in the other is a
 * type error HERE, in the package, rather than a payload nothing can produce.
 *
 * It costs nothing at runtime (the assignment erases with the types) and it is
 * strictly better than a test, because it cannot be forgotten in a file nobody
 * opens while adding a command.
 */
type CommandsAgree = [NotificationCommand] extends [NotificationCommandV1]
  ? [NotificationCommandV1] extends [NotificationCommand]
    ? true
    : never
  : never;
const _commandsAgree: CommandsAgree = true;
void _commandsAgree;

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstTransferCommandInputCode` — same shape, same reason.
 */
export function firstNotificationCommandInputCode(
  error: z.ZodError<unknown>,
): NotificationCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((NOTIFICATION_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as NotificationCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
