// Client-input contract for the owner's trips —
// `POST /api/v1/pets/{publicToken}/travel` (viajes-fase-2, design D4/D5).
//
// FOUR COMMANDS BEHIND ONE URL, the shape `/reminders` and `/lost` use:
// `record_trip`, `record_cvi`, `cancel_trip` and `confirm_trip_document` (the
// owner's "Lo tengo" for one paper of a trip). All four reach the IDENTICAL
// use-cases the web's Server Actions reach (src/modules/pets/application/
// travel/), so a phone and a browser recording the same trip cannot drift into
// two notions of what a duplicate is or who may write one.
//
// `Idempotency-Key` IS REQUIRED ON ALL FOUR. Each command appends a row on the
// append-only spine, and a phone on a subway retries after a timeout that may
// well have committed; the key makes that retry answer the first write
// (`replayed: true`) instead of appending a second trip.
//
// WHAT THIS SCHEMA DOES NOT CHECK, AND WHO DOES. The plausible window of a
// date (a trip from yesterday to a year ahead; a CVI issued in the last year,
// not in the future) depends on TODAY, which the server owns; so does whether
// an airline slug is in the registry this build carries. Both are server
// refusals (`travel_input_invalid`). This schema checks shape: real calendar
// days, a corridor from the closed set, a CVI valid-until not before its issue.

import { z } from "zod";
import { isRealArDay } from "./ar-calendar-day.ts";

/** `"YYYY-MM-DD"` — what `<input type="date">` posts. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The five corridors. A closed set, pinned to the server's `CORRIDOR_IDS`
 * (lib/reference/cross-border-corridors.ts) by a test — this package may not
 * import server code, so the pin is how the two cannot drift.
 */
export const TRAVEL_CORRIDOR_IDS = ["chile", "uruguay", "brasil", "ue_espana", "usa"] as const;
export type TravelCorridorId = (typeof TRAVEL_CORRIDOR_IDS)[number];

export const TRAVEL_MODES = ["air", "land", "sea"] as const;
export const TRAVEL_MODALITIES = ["cabin", "hold", "cargo"] as const;

export const PET_TRAVEL_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "CORRIDOR_REQUIRED",
  "TRAVEL_DATE_REQUIRED",
  "TRAVEL_DATE_INVALID",
  "CVI_NUMBER_REQUIRED",
  "ISSUED_DATE_REQUIRED",
  "ISSUED_DATE_INVALID",
  "VALID_UNTIL_INVALID",
  "VALID_UNTIL_BEFORE_ISSUED",
  "TRIP_ID_REQUIRED",
  "DOCUMENT_REQUIRED",
] as const;
export type PetTravelCommandInputCode = (typeof PET_TRAVEL_COMMAND_INPUT_CODES)[number];

/** A required `YYYY-MM-DD` that names a day that exists. */
function isoDay(required: PetTravelCommandInputCode, invalid: PetTravelCommandInputCode) {
  return z
    .string({ error: required })
    .trim()
    .min(1, { error: required })
    .regex(ISO_DATE_RE, { error: invalid })
    .refine(isRealArDay, { error: invalid });
}

/** Absent, blank and `null` all mean "not stated". */
const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

const recordTrip = z.object({
  command: z.literal("record_trip"),
  corridorId: z.enum(TRAVEL_CORRIDOR_IDS, { error: "CORRIDOR_REQUIRED" }),
  travelDate: isoDay("TRAVEL_DATE_REQUIRED", "TRAVEL_DATE_INVALID"),
  mode: z
    .enum(TRAVEL_MODES)
    .nullish()
    .transform((v) => v ?? null),
  /** A slug of the server's airline registry; the server refuses an unknown one. */
  airlineId: optionalText,
  intendedModality: z
    .enum(TRAVEL_MODALITIES)
    .nullish()
    .transform((v) => v ?? null),
});

const recordCvi = z
  .object({
    command: z.literal("record_cvi"),
    cviNumber: z
      .string({ error: "CVI_NUMBER_REQUIRED" })
      .trim()
      .min(1, { error: "CVI_NUMBER_REQUIRED" }),
    issuedDate: isoDay("ISSUED_DATE_REQUIRED", "ISSUED_DATE_INVALID"),
    validUntil: z
      .string()
      .trim()
      .nullish()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || (ISO_DATE_RE.test(v) && isRealArDay(v)), {
        error: "VALID_UNTIL_INVALID",
      }),
  })
  .refine((c) => c.validUntil === null || c.validUntil >= c.issuedDate, {
    error: "VALID_UNTIL_BEFORE_ISSUED",
    path: ["validUntil"],
  });

/** Cancel a trip, by the `transport_recorded` row's id. */
const cancelTrip = z.object({
  command: z.literal("cancel_trip"),
  tripEventId: z.uuid({ error: "TRIP_ID_REQUIRED" }),
});

/**
 * "Lo tengo" for one document of a trip (`confirmed: true`), or the tick taken
 * back (`false`). `document` is the label exactly as the trip's obligation
 * lists it; the server refuses one the trip does not list
 * (`travel_input_invalid`), so nothing typed ever reaches the record.
 */
const confirmTripDocument = z.object({
  command: z.literal("confirm_trip_document"),
  tripEventId: z.uuid({ error: "TRIP_ID_REQUIRED" }),
  document: z
    .string({ error: "DOCUMENT_REQUIRED" })
    .trim()
    .min(1, { error: "DOCUMENT_REQUIRED" })
    .max(300, { error: "DOCUMENT_REQUIRED" }),
  confirmed: z.boolean({ error: "DOCUMENT_REQUIRED" }),
});

export const petTravelCommandInputSchema = z.discriminatedUnion("command", [
  recordTrip,
  recordCvi,
  cancelTrip,
  confirmTripDocument,
]);

export type PetTravelCommandInput = z.infer<typeof petTravelCommandInputSchema>;
export type PetTravelCommand = PetTravelCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Same shape as `firstVaccineReminderCommandInputCode`.
 */
export function firstPetTravelCommandInputCode(
  error: z.ZodError<unknown>,
): PetTravelCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((PET_TRAVEL_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as PetTravelCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
