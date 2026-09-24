// What a client may SEND to `POST /api/v1/me/appointments`.
//
// TWO COMMANDS, AND THE THREE THAT ARE MISSING ARE THE POINT
// ---------------------------------------------------------------------------
// The web's booking surface has four writes. Three of them —
// `markAppointmentAttended`, `markAppointmentNoShow`, `cancelAppointmentByOrg` —
// are the PROVIDER'S, reached from `/org/{token}/agenda`, and they belong to an
// org member acting on somebody else's turno. A citizen wallet has no operator
// surface, so putting any of them here would be the phone doing something the
// owner's browser cannot.
//
// The fourth is `bookSlotAction`. Its absence used to be a SCOPE line and this
// paragraph used to say so: "when it lands it joins this union as a second
// member, which is why this is a discriminated union over `command` and not a
// bare object with a token — a schema shaped for one command has to be rewritten
// to admit a second, and rewriting a wire schema is a version bump." IT LANDED,
// as `book`, and it cost exactly what that sentence predicted it would: one more
// member and no version bump.
//
// WHY `book` IS HERE AND NOT ON THE SEARCH ROUTES
// ---------------------------------------------------------------------------
// The two reads it depends on are `/api/v1/appointments` and
// `/api/v1/appointments/{offeringToken}`, and the write could have hung off
// either. It does not, because a write's home is the resource it MUTATES and not
// the one it reads: booking inserts an `appointments` row that belongs to the
// caller, and `/me/appointments` is where the caller's appointments live. The two
// commands then also share an anchor — each is a transaction across three tables
// that moves a place between people — so they share a rate-limit family without
// anyone having to argue that they should.
//
// WHAT CANCELLING ACTUALLY MUTATES, SAID PLAINLY
// ---------------------------------------------------------------------------
// `appointments.status` → `cancelled_by_owner`, `cancelled_at`,
// `cancelled_by_user_id`, and a DECREMENT of `time_slots.bookings_count` that
// frees the place for somebody else. Nothing on the event spine: an appointment
// is not an asiento, and a turno nobody attended produced no fact about the
// animal. Invariant #2 is untouched rather than bent.
//
// It does append a NOTIFICATION to each member of the provider org, which is a
// consequence and not a fact — see the writer.
//
// NO IDEMPOTENCY KEY, AND THE ENDPOINT ASKS FOR NONE
// ---------------------------------------------------------------------------
// `cancelAppointmentByOwner` takes no `clientIdempotencyKey`. What it has instead
// is an UPDATE conditional on `status = 'confirmed'` — the TOCTOU guard that
// stops two concurrent cancels from each decrementing `bookings_count` and
// double-freeing a place. That REFUSES a replay rather than absorbing one, which
// is a different promise and must not be sold as the same: after a timeout,
// `appointment_already_resolved` may mean the first attempt landed, OR that the
// clinic cancelled it from their side in the meantime. A caller must re-read.

import { z } from "zod";

import type { AppointmentCommandAckV1 } from "../api/my-appointments.ts";

/**
 * The per-field codes a client can act on locally.
 *
 * SCREAMING_SNAKE, like every other input module here, and deliberately NOT the
 * `lowercase_snake` of `@dim/contract/api`'s error vocabulary: these are refusals
 * a client computes for ITSELF before any round trip, and the two casings are how
 * a reader tells "the server said no" from "the form did".
 */
export const APPOINTMENT_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "APPOINTMENT_TOKEN_REQUIRED",
  "SLOT_REQUIRED",
  "PET_REQUIRED",
] as const;

export type AppointmentCommandInputCode = (typeof APPOINTMENT_COMMAND_INPUT_CODES)[number];

/**
 * One appointment token, as the endpoint receives it.
 *
 * SHAPE ONLY, NEVER EXISTENCE, and never the `APT-XXXX-XXXX` pattern either. The
 * token format is generated server-side (`generateAppointmentToken`) and pinning
 * it here would make the contract refuse a token the server legitimately minted
 * the day that generator changes — a client validating its own server's output.
 * A non-empty string is all a client can honestly check before the round trip.
 */
const appointmentToken = z
  .string({ error: "APPOINTMENT_TOKEN_REQUIRED" })
  .trim()
  .min(1, { error: "APPOINTMENT_TOKEN_REQUIRED" });

/** CANCELAR UN TURNO PROPIO. The owner's side; the provider's cancel is not here. */
const cancel = z.object({ command: z.literal("cancel"), appointmentToken });

/**
 * The slot being taken, as `GET /api/v1/appointments/{offeringToken}` handed it
 * over.
 *
 * A UUID AND NOT A MINTED TOKEN — the one identifier on this surface that is.
 * `time_slots` has no `public_token` column; the web's own URL carries the raw id
 * (`/turnos/buscar/{offering}/reservar/{slotId}`), and minting a second
 * identifier for a materialised slot would be a migration rather than a contract
 * decision. SHAPE ONLY: this validates that the string could be a uuid, which is
 * the most a client can honestly check before the round trip. Existence, capacity,
 * the offering's status and the future window are ALL re-resolved inside the
 * booking transaction under an advisory lock, so nothing here is a guard.
 */
const slotId = z.string({ error: "SLOT_REQUIRED" }).trim().uuid({ error: "SLOT_REQUIRED" });

/**
 * WHICH ANIMAL, by its public token.
 *
 * NOT A PET UUID, and that asymmetry with `slotId` above is deliberate rather
 * than an inconsistency: `pets.public_token` exists, it is the identifier every
 * other endpoint on this surface takes, and it is the only one a phone ever
 * holds. The pattern is NOT pinned here (`DIM-XXXX-XXXX`) for
 * `appointmentToken`'s reason — a client must not validate its own server's
 * output format.
 *
 * IT IS NOT A CAPABILITY EITHER. The writer resolves the animal from this token
 * AND the caller's session together, and answers the same refusal for "not yours"
 * and for "erased" (Ley 25.326 art. 16), so a stranger's token buys nothing.
 */
const petPublicToken = z.string({ error: "PET_REQUIRED" }).trim().min(1, { error: "PET_REQUIRED" });

/**
 * RESERVAR UN TURNO. The owner's side of the web's `bookSlotAction`.
 *
 * NO `Idempotency-Key`, AND THE ENDPOINT ASKS FOR NONE — the same refusal to
 * promise `cancel` makes, arrived at from the other direction. `bookSlotWriter`
 * takes no `clientIdempotencyKey`; what it has instead is a `pg_advisory_xact_lock`
 * on the slot plus TWO partial unique indexes (`appointments_one_live_per_pet_slot`
 * from migration 0177, `appointments_one_live_per_pet_offering` from 0181), and
 * those REFUSE a replay rather than absorbing one. So a retry after a timeout that
 * in fact committed comes back as a refusal — indistinguishable, on the wire, from
 * somebody else having taken the last place. A caller must RE-READ the slot grid,
 * never re-send.
 */
const book = z.object({ command: z.literal("book"), slotId, petPublicToken });

export const appointmentCommandInputSchema = z.discriminatedUnion("command", [cancel, book]);

export type AppointmentCommandInput = z.infer<typeof appointmentCommandInputSchema>;
export type AppointmentCommand = AppointmentCommandInput["command"];

/**
 * A COMPILE-TIME proof that the schema's command union and the command the ack
 * type names are the same set, in both directions.
 *
 * The api entry point has to name the command on `AppointmentCommandAckV1`
 * without pulling zod in, so the vocabulary exists twice — once as a literal type
 * over there and once as a discriminated union here. This is what stops the pair
 * from drifting: a second command added to one and forgotten in the other is a
 * type error HERE, in the package, rather than an ack nothing can produce.
 *
 * It costs nothing at runtime (the assignment erases with the types) and it is
 * strictly better than a test, because it cannot be forgotten in a file nobody
 * opens while adding a command. Same instrument `notification.ts` uses.
 */
type CommandsAgree = [AppointmentCommand] extends [AppointmentCommandAckV1["command"]]
  ? [AppointmentCommandAckV1["command"]] extends [AppointmentCommand]
    ? true
    : never
  : never;
const _commandsAgree: CommandsAgree = true;
void _commandsAgree;

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstTransferCommandInputCode` — same shape, same reason.
 */
export function firstAppointmentCommandInputCode(
  error: z.ZodError<unknown>,
): AppointmentCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((APPOINTMENT_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as AppointmentCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
