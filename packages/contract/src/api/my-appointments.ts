// `GET /api/v1/me/appointments` — every turno this person booked.
//
// THE FOURTH HUB, AND IT HANGS OFF THE PERSON FOR A DIFFERENT REASON THAN THE
// OTHER THREE
// ---------------------------------------------------------------------------
// `/me/transfers`, `/me/caretaker-grants` and `/me/notifications` cannot name a
// pet because half of what they carry is about animals the caller does not hold.
// This one COULD have been `/pets/{token}/appointments` — every row does name an
// animal — and it is not, because the web's page is not per-pet either: a person
// arriving at `/mis-turnos` is asking "what do I have booked", across every
// animal they are responsible for, in one list ordered by time. Splitting it per
// pet would make the phone ask N times to answer a question the browser answers
// once, and would lose the ordering that is the whole point of the screen.
//
// It also carries rows for animals the caller does not OWN, which is the same
// shape as the other three after all: `bookSlotAction` accepts any active
// ownership role, so a foster or a co-owner books under their own id
// (`app/actions/booking.ts:51-68`). The appointment is theirs; the animal is not.
//
// WHAT A CLIENT MUST NOT DO WITH THIS PAYLOAD
// ---------------------------------------------------------------------------
// DO NOT RECOMPUTE `section`, `capabilities.canCancel` OR `capabilities.canCheckIn`.
// All three are functions of the SERVER'S CLOCK against `startsAt`/`endsAt`, and
// a phone's clock can be days wrong. The failure is not symmetric: a device
// running slow would keep offering a check-in QR for a turno that finished this
// morning, and would offer "Cancelar" on one the clinic has already run. The web
// computes the same three predicates server-side for the same reason
// (`app/(app)/mis-turnos/page.tsx:59-75`, `[appointmentToken]/page.tsx:83-87`).
//
// DO NOT TREAT AN EMPTY LIST AS "NO TENÉS TURNOS" AFTER A FAILED READ. The thing
// being missed is an appointment somebody has to physically attend at a time
// they no longer remember.
//
// PII: WHAT THIS CARRIES
// ---------------------------------------------------------------------------
// The provider's PHONE crosses, and it is not new exposure: the web's detail page
// renders `organizations.phone` and `profiles.phone` unconditionally to the
// appointment's owner (`[appointmentToken]/page.tsx:178-179`), behind the same
// `ownerUserId === caller` guard this endpoint applies. It is the number a person
// needs to call the clinic they are booked at, and it belongs to the PROVIDER,
// never to another citizen.
//
// NO OWNER NOTES. `appointments.notes_from_owner` and `notes_from_org` are two of
// the twenty-one plaintext columns the Ley 25.326 fence named
// (`dim-interno:docs/agents/open-work.md`), and neither is on this wire. The web's detail page
// does not render them either, so withholding them is parity and not a hole.
//
// NO DNI, in any form, and nothing in this feature has ever asked for one.

import type { AppointmentBookedV1 } from "./appointment-search.ts";

export const MY_APPOINTMENTS_PAYLOAD_VERSION = 1;

/**
 * ONE MINUTE, the window `/shares`, `/lost` and `/transfers` all take.
 *
 * The facts on this screen move without the caller doing anything: the clinic
 * marks a turno attended or no-show, the org cancels it, and — the one that does
 * not need anybody at all — the slot's start time passes and a row leaves
 * "Próximos". A five-minute window is five minutes of offering a check-in QR for
 * something that already happened.
 */
export const MY_APPOINTMENTS_STALE_AFTER_MS = 60_000;

/**
 * The five states an appointment can be in.
 *
 * MIRRORED FROM THE `appointment_status_valid` CHECK CONSTRAINT (`db/schema.ts`),
 * which is the authority, and it is FIVE and not six. The web carries a sixth,
 * `"cancelled"`, in two places — the `/mis-turnos` bucket predicate and the detail
 * page's `STATUS_CONFIG` map — and the database cannot produce it: the constraint
 * admits `confirmed`, `attended`, `no_show`, `cancelled_by_owner` and
 * `cancelled_by_org` and nothing else. Those branches are dead code on the web.
 * This union deliberately does NOT copy the dead value across, because a wire
 * vocabulary that names a state no writer can write is a client waiting for
 * something that never arrives.
 */
export const APPOINTMENT_STATUSES_V1 = [
  "confirmed",
  "attended",
  "no_show",
  "cancelled_by_owner",
  "cancelled_by_org",
] as const;
export type AppointmentStatusV1 = (typeof APPOINTMENT_STATUSES_V1)[number];

/**
 * Which of the web's three sections a row belongs to.
 *
 * DECIDED BY THE SERVER, and it is NOT a function of `status` alone — which is
 * exactly why it is on the wire. A `confirmed` row is "próximo" while its slot
 * has not finished and "pasado" once it has, and nothing writes to the row when
 * that moment passes: the transition is the clock's, not a writer's. A client
 * deriving it would be deriving it from a device clock.
 *
 * `upcoming` CLOSES AT `endsAt`, NOT AT `startsAt`, which is one deliberate step
 * away from the web's own predicate. The reason is written out in
 * `listAppointmentsForUser`: the browser drops a turno out of "Próximos" the
 * instant it begins while still offering its check-in QR until it ends, so
 * somebody arriving five minutes late goes looking under the wrong heading for
 * the code they need. Here `section === "upcoming"` and `capabilities.canCheckIn`
 * agree for every confirmed row.
 */
export const APPOINTMENT_SECTIONS_V1 = ["upcoming", "past", "cancelled"] as const;
export type AppointmentSectionV1 = (typeof APPOINTMENT_SECTIONS_V1)[number];

/**
 * What this caller may do with THIS row.
 *
 * BOTH ARE THE SERVER'S CLOCK and neither is re-derivable on a phone — see the
 * header. They are affordance hints and not the rules: `cancelAppointmentByOwner`
 * re-checks ownership, status and the future window under a conditional UPDATE
 * before it frees any capacity.
 *
 * `canCheckIn` IS NOT `canCancel`. The two windows genuinely differ: cancelling
 * closes at `startsAt` (the web refuses "un turno que ya pasó"), while the QR
 * stays valid until `endsAt`, because somebody arriving five minutes late still
 * has to check in. A client that used one flag for both would either take the QR
 * away from a person standing at the desk or offer a cancel button during the
 * consultation.
 */
export type AppointmentCapabilitiesV1 = {
  canCancel: boolean;
  canCheckIn: boolean;
};

/** The animal, named the way the list and the detail both name it. */
export type AppointmentPetV1 = {
  publicToken: string;
  name: string;
};

/**
 * Who is providing the service.
 *
 * A DISCRIMINATED UNION AND NOT A FLAT LABEL, because the underlying column pair
 * is a genuine XOR: `service_offerings` has a `provider_xor` CHECK enforcing that
 * exactly one of `organization_id` / `provider_user_id` is set. The web collapses
 * the two into one string at the point of render, in two files that each wrote
 * their own copy of the collapse; putting the string on the wire would make this
 * a third copy and would put es-AR presentation ("Dr/a. …") in a payload.
 *
 * `unknown` IS REACHABLE AND IS NOT AN ERROR. The joins that resolve the two
 * names are LEFT joins, so a provider profile that was deleted leaves the
 * appointment standing with nothing to name it. The web falls back to
 * "Profesional independiente" there; the client owns that sentence, not this type.
 */
export type AppointmentProviderV1 =
  | {
      kind: "organization";
      displayName: string;
      /** The clinic's number, for the person who has to get there. See the header. */
      phone: string | null;
      /**
       * The OFFERING's own jurisdiction locality, never the organisation's
       * registered address.
       *
       * SAME RULE, SAME INCIDENT `coverageLabel` states in
       * `appointment-search.ts`: on 2026-08-13 a web detail page printed the
       * org's locality while search matched the offering's, so a label named
       * a place the search rejected. `list-appointments-for-user.ts` carried
       * the identical bug on THIS field until 2026-09-04 — a turno booked
       * with an org running offerings away from its own address (outreach
       * campaigns in a different neighbourhood) showed that home address on
       * every turno, regardless of which offering was actually booked.
       */
      locality: string | null;
    }
  | {
      kind: "professional";
      displayName: string;
      /** Matrícula profesional, when the vet has recorded one. */
      matriculaNumber: string | null;
      phone: string | null;
    }
  | { kind: "unknown" };

/** One turno, from the side of the person who booked it. */
export type MyAppointmentV1 = {
  /** `APT-XXXX-XXXX`. The handle every command takes, and what the QR encodes. */
  appointmentToken: string;
  status: AppointmentStatusV1;
  section: AppointmentSectionV1;
  pet: AppointmentPetV1;
  /**
   * The offering's own name — what the provider called this service.
   *
   * ALWAYS PRESENT (`display_name` is `text NOT NULL`), which is why it and not
   * the service-kind label is the heading a client should draw.
   */
  offeringName: string;
  /**
   * The catalogue code (`vaccination_rabies`, …).
   *
   * OPEN VOCABULARY, typed `string` and not a union, for the reason every sibling
   * payload types `species` as one: `service_offerings.service_kind` is
   * `text NOT NULL` with no CHECK, so a closed union here would be this file
   * asserting a constraint the column does not have.
   */
  serviceKind: string;
  /**
   * The es-AR label for that code, or `null` when the catalogue does not know it.
   *
   * RESOLVED SERVER-SIDE, because the catalogue lives in `lib/reference/
   * service-kinds.ts` — inside the Next app, where a native client cannot reach
   * it. `null` is the honest answer for a code seeded outside the catalogue, and
   * a client should fall back to `offeringName` rather than printing a raw
   * snake_case code at somebody: that is the exact shape the buscar page was
   * fixed for (QA 2026-08-08, S3-F07).
   */
  serviceKindLabel: string | null;
  provider: AppointmentProviderV1;
  durationMinutes: number;
  /**
   * Price in ARS, or `null` for a free service.
   *
   * A NUMBER ON THE WIRE, not the `numeric` column's string. `price_ars` is
   * `numeric(10,2)`, which the driver hands back as a string to avoid float
   * surprises; the JSON here is a number because every consumer immediately
   * formats it, and two clients each writing their own `Number(...)` is two
   * chances to disagree about what an empty string means. `null` means GRATUITO
   * and must not be rendered as `$0`.
   */
  priceArs: number | null;
  /** When the slot starts, ISO-8601 with offset. */
  startsAt: string;
  /** When it ends — the boundary `canCheckIn` closes at. */
  endsAt: string;
  capabilities: AppointmentCapabilitiesV1;
};

/**
 * The hub, in the web's own three sections.
 *
 * SPLIT SERVER-SIDE rather than handed over flat with a `section` field to filter
 * on — and the `section` field is carried anyway, which looks redundant until you
 * ask what a DETAIL screen does with it. The lists are what the list screen
 * renders; the field is what the detail screen reads after finding its row by
 * token, without having to remember which array it came out of.
 *
 * ORDERING IS THE SERVER'S. `upcoming` is soonest-first, because the next thing a
 * person has to attend is the answer to the question they opened the screen with.
 * `past` and `cancelled` are newest-first, which is the web's order for both.
 * Note that this differs from the web's single `ORDER BY starts_at DESC` over
 * everything: that put the FURTHEST-AWAY appointment at the top of "Próximos",
 * which reads as the next one and is not.
 */
export type MyAppointmentsV1 = {
  payloadVersion: typeof MY_APPOINTMENTS_PAYLOAD_VERSION;
  /** The three envelope fields §6 requires on every read. Built by `apiV1Envelope`. */
  issuedAt: string;
  staleAfter: string;
  /** Confirmed and still ahead. Soonest first. */
  upcoming: MyAppointmentV1[];
  /** Attended, or confirmed-and-behind. Newest first. */
  past: MyAppointmentV1[];
  /** Cancelled by either side, and no-shows. Newest first. */
  cancelled: MyAppointmentV1[];
};

/**
 * What `POST /api/v1/me/appointments` answers for `command: "cancel"`.
 *
 * `changed` IS ALWAYS TRUE HERE, for `TransferCommandAckV1.changed`'s reason
 * rather than `ShareCommandAckV1.changed`'s: the cancel writer flips the row with
 * an UPDATE conditional on `status = 'confirmed'`, so a replay matches zero rows
 * and is REFUSED (`appointment_already_resolved`), never absorbed as a no-op
 * success. The field is carried so a client written against this surface's shared
 * ack shape needs no special case, and so the day a command learns to absorb a
 * replay it has somewhere to say so without a version bump.
 */
export type AppointmentCancelledV1 = {
  command: "cancel";
  changed: boolean;
  /** The turno that was acted on. */
  appointmentToken: string;
};

/**
 * What `POST /api/v1/me/appointments` answers, over both commands.
 *
 * A UNION SINCE `book` LANDED, and the two arms deliberately do NOT share a
 * shape. The cancel arm carries `changed` because the day a command learns to
 * absorb a replay it needs somewhere to say so; the booking arm does not, because
 * a booking either minted an appointment or was refused and a boolean that is
 * always `true` on its only success arm describes nothing. Widening the cancel
 * arm's shape onto the new one to keep them "consistent" would have put a field
 * on the wire whose value no reader could act on.
 *
 * The discriminant is `command`, and `@dim/contract/input`'s `appointment.ts`
 * carries a compile-time proof that this union's commands and the input schema's
 * are the same set in both directions.
 */
export type AppointmentCommandAckV1 = AppointmentCancelledV1 | AppointmentBookedV1;
