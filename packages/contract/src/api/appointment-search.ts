// `GET /api/v1/appointments` and `GET /api/v1/appointments/{offeringToken}` —
// finding a turno, and everything the confirm screen needs to take one.
//
// TWO READS AND ONE WRITE ARE ONE CAPABILITY
// ---------------------------------------------------------------------------
// A search that cannot book lists slots nobody can take; a book with no search is
// unreachable. So these payloads are shaped around the write that follows them
// (`command: "book"` on `POST /api/v1/me/appointments`) rather than around the
// two web pages they mirror: every refusal `bookSlotWriter` can produce is either
// impossible by construction of what these reads return, or is carried here as a
// flag the client renders instead of discovering by tapping.
//
// WHY THE WRITE IS NOT ON THESE ROUTES
// ---------------------------------------------------------------------------
// It hangs off `/me/appointments`, beside `cancel`, because the two are the two
// halves of one person's relationship to a turno and they share an anchor: both
// are a transaction across three tables that moves a place between people. The
// input union in `@dim/contract/input`'s `appointment.ts` was shaped from the
// start to admit `book` as a second member without a version bump, and its own
// comment said so; this is that member arriving.
//
// WHAT THIS SURFACE CARRIES ABOUT OTHER PEOPLE: NOTHING. `placesLeft` is a
// count of a slot's remaining capacity, which is a fact about the SLOT and is
// already on the web's own grid ("2 lugares"). No name, no count of who booked,
// no queue position — the same refusal `MyAdoptionApplicationsV1` makes (D17).
//
// PII: the ORGANIZATION'S phone crosses — the clinic's public number, the one
// a person needs to call the place they are about to book at, with precedent
// on the org public profile. The PROFESSIONAL'S phone does NOT (PO decision
// 2026-09-01): `profiles.phone` is a personal number, this payload reaches any
// authenticated caller with no relationship to the offering, and the two web
// pages this endpoint mirrors never selected it — one omits it with a written
// comment, after the 2026-08-13 incident. `MyAppointmentsV1` still carries it
// for a turno the caller already HOLDS, which is the relationship that earns
// it. No owner notes, no DNI, and nothing about the caller's own pets beyond
// a token and a name.

export const APPOINTMENT_SEARCH_PAYLOAD_VERSION = 1;

/**
 * THIRTY SECONDS, and it is the shortest window on this surface.
 *
 * Every other read here is a list of things about the caller that only the caller
 * changes. This one is a list of PLACES, and the whole point of the screen is
 * that somebody else may take one while it is on screen: `bookings_count` moves
 * without the reader doing anything. `MY_APPOINTMENTS_STALE_AFTER_MS` is 60s for
 * facts that move when a clinic acts; a free campaign's 08:00 slot moves faster
 * than that at the moment the campaign opens.
 *
 * It is NOT a promise that a slot still exists — nothing can be. The client's
 * protection against the race is the write's refusal, and the write refuses under
 * an advisory lock (see `AppointmentBookedV1`).
 */
export const APPOINTMENT_SEARCH_STALE_AFTER_MS = 30_000;

/**
 * How far ahead each read looks. Both are the WEB's own windows, carried on the
 * wire so a client can say "en 7 días" without inventing the number.
 */
export const APPOINTMENT_SEARCH_LIST_WINDOW_DAYS = 7;
export const APPOINTMENT_OFFERING_WINDOW_DAYS = 60;

/**
 * One entry of the service catalogue, for the picker that opens the flow.
 *
 * IT IS ON THE WIRE BECAUSE THE CATALOGUE IS NOT REACHABLE FROM A PHONE.
 * `lib/reference/service-kinds.ts` lives inside the Next app, and the same
 * argument that put `serviceKindLabel` on `MyAppointmentV1` puts the whole list
 * here: a client that hard-coded twelve es-AR labels would print a stale one the
 * day a kind is added, and a client that printed the raw `snake_case` code is the
 * exact defect QA 2026-08-08 (S3-F07) found on the buscar page.
 */
export type ServiceKindOptionV1 = {
  /** The catalogue code, e.g. `vaccination_rabies`. What the search takes. */
  code: string;
  /** The es-AR label. What a person reads. */
  label: string;
};

/**
 * Who provides the service — the SAME union `MyAppointmentV1.provider` uses.
 *
 * Deliberately the same type and not a near-copy: a client rendering a provider
 * on the turnos list and on a search result is rendering one thing, and two
 * unions that differ by a field are two rendering paths that drift.
 *
 * `unknown` IS REACHABLE AND IS NOT AN ERROR — the joins that resolve the names
 * are LEFT joins, so a deleted profile leaves an offering with nothing to name it.
 * The es-AR fallback ("Profesional independiente") is the client's, not this
 * type's.
 */
export type AppointmentProviderV1Search =
  | {
      kind: "organization";
      displayName: string;
      /** The clinic's number, for the person who has to get there. */
      phone: string | null;
      /**
       * The OFFERING's own jurisdiction locality, never the organisation's
       * registered address.
       *
       * SAME RULE, SAME 2026-08-13 INCIDENT `coverageLabel` states above: a
       * label naming the org's own address instead of the offering's names a
       * place the search itself rejects. `search-bookable-slots.ts`'s
       * `resolveProvider` carried the org's locality on THIS field until
       * 2026-09-04 — `coverageLabel` was fixed in 2026-08-13 and this nested
       * field was not, so an org running an offering away from its own
       * address still showed its home address here.
       */
      locality: string | null;
    }
  | {
      kind: "professional";
      displayName: string;
      matriculaNumber: string | null;
      // No `phone` — see the PII note in this file's header.
    }
  | { kind: "unknown" };

/** One offering that has at least one takeable slot. */
export type BookableOfferingV1 = {
  /** `OFR-XXXX-XXXX`. The handle the detail read takes. */
  offeringToken: string;
  /**
   * What the provider called this service.
   *
   * ALWAYS PRESENT (`display_name` is `text NOT NULL`), which is why it and not
   * the service-kind label is the heading a client should draw.
   */
  displayName: string;
  description: string | null;
  /** The catalogue code. OPEN VOCABULARY — `service_kind` is `text` with no CHECK. */
  serviceKind: string;
  /** The es-AR label, or `null` for a code seeded outside the catalogue. */
  serviceKindLabel: string | null;
  provider: AppointmentProviderV1Search;
  durationMinutes: number;
  /**
   * Price in ARS, or `null` for a free service.
   *
   * A NUMBER ON THE WIRE, not the `numeric` column's string, for
   * `MyAppointmentV1.priceArs`'s reason. `null` means GRATUITO and must not be
   * rendered as `$0` — the free campaigns are most of what this screen is for.
   */
  priceArs: number | null;
  /**
   * Where this offering is valid, as the SEARCH understands it.
   *
   * DERIVED FROM THE OFFERING'S OWN jurisdiction and never from the
   * organisation's address. On 2026-08-13 the web's detail page printed the org's
   * locality ("Recoleta") while the search matched the offering's ("Ciudad
   * Autónoma de Buenos Aires"), so the label named a place the search rejects and
   * a citizen who typed it got nothing.
   */
  coverageLabel: string | null;
  /**
   * How many takeable slots fall inside the window this payload's read used —
   * seven days for the list, sixty for the detail.
   *
   * THE TWO READS PUT DIFFERENT NUMBERS HERE, deliberately, because they mean
   * "what a person can act on in the answer they are looking at". A client must
   * label it with the window it came from and must not carry the list's figure
   * onto the detail screen.
   */
  slotsInWindow: number;
  /** The soonest of them, ISO-8601 with offset. */
  nextSlotAt: string;
};

/** One slot a person can actually take. */
export type BookableSlotV1 = {
  /**
   * The slot's opaque id — what `command: "book"` takes.
   *
   * IT IS A UUID AND NOT A MINTED TOKEN, which is the one place this surface
   * differs from every sibling. `time_slots` has no `public_token` column; the
   * web's own URL carries the uuid (`/turnos/buscar/{offering}/reservar/{slotId}`)
   * and minting a second identifier for it would be a migration. A client must
   * treat it as opaque and must never construct one: it is not a capability —
   * booking re-resolves the slot, its offering's status and the caller's custody
   * inside the transaction.
   */
  slotId: string;
  /** When it starts, ISO-8601 with offset. */
  startsAt: string;
  /** When it ends. */
  endsAt: string;
  /**
   * `capacity - bookings_count` at READ TIME. Always ≥ 1 — a full slot is absent.
   *
   * A HINT AND NOT A RESERVATION. It can be stale by the time somebody taps, which
   * is the whole reason `APPOINTMENT_SEARCH_STALE_AFTER_MS` is thirty seconds and
   * the reason the write re-reads under `pg_advisory_xact_lock`. A client should
   * draw it only when `capacity > 1` (the web does the same), because "1 lugar" on
   * an ordinary consultation says nothing.
   */
  placesLeft: number;
};

/**
 * Why an animal the caller holds cannot be booked into THIS offering.
 *
 * A CLOSED VOCABULARY so the client owns the sentence, and it has exactly one
 * member — which is the interesting part. A deceased or erased animal is NOT in
 * `BookableOfferingDetailV1.pets` at all: it is dropped by the read, because a
 * memorial row on a booking form is not an affordance and "listed and refused" is
 * a different answer from "not yours to book".
 */
export const BOOKING_BLOCKED_REASONS_V1 = ["already_booked_in_offering"] as const;
export type BookingBlockedReasonV1 = (typeof BOOKING_BLOCKED_REASONS_V1)[number];

/**
 * One of the caller's animals, and whether this offering will take it.
 *
 * `canBook` IS THE SERVER'S AND MUST NOT BE DERIVED. It looks like
 * `blockedReason === null` and deriving it would still be wrong for the reason
 * `PetClaimLookupAckV1.canClaim` states: the rule behind it is the writer's, it is
 * re-checked inside the booking transaction, and a client that computed the
 * affordance would be keeping a second copy of an authorization rule.
 *
 * The rule it stands for is the campaign-level identity guard: ONE confirmed
 * appointment per (pet, offering). It exists because the per-SLOT guard let the
 * same animal take the 08:00 AND the 08:15 of one free campaign — N slots, N
 * eaten places (QA A3, 2026-08-13) — and the per-slot advisory lock cannot
 * serialise two submits against different slots, so a partial unique index is the
 * real guard and this flag is only the affordance.
 */
export type BookablePetV1 = {
  /** `DIM-XXXX-XXXX`. What `command: "book"` names the animal with. */
  publicToken: string;
  name: string;
  canBook: boolean;
  /** Why not, when `canBook` is false; `null` when it is true. */
  blockedReason: BookingBlockedReasonV1 | null;
};

/**
 * `GET /api/v1/appointments` — the catalogue, or one service's results.
 *
 * TWO SHAPES IN ONE PAYLOAD, AND THE PICKER IS NOT A SEPARATE ROUTE. The web does
 * the same thing on one URL: `/turnos/buscar` with no `service_kind` renders the
 * twelve-row picker, and with one renders the results. Splitting them here would
 * add a route, a bucket and a payload version to serve a twelve-item constant.
 *
 * `serviceKind` IS `null` WHEN NO SERVICE WAS CHOSEN — or when the one asked for
 * is not in the catalogue. AN UNRECOGNISED CODE IS TREATED AS ABSENT AND IS NEVER
 * ECHOED: QA 2026-08-08 (S3-F07) loaded `?service_kind=spay_female_dog` and got a
 * 200 whose heading read `spay_female_dog`, because the page used the raw param as
 * its `<h1>`. Falling through to the picker is what the app already does for a
 * missing param, and an unknown service is exactly that.
 */
export type AppointmentSearchV1 = {
  payloadVersion: typeof APPOINTMENT_SEARCH_PAYLOAD_VERSION;
  /** The three envelope fields §6 requires on every read. Built by `apiV1Envelope`. */
  issuedAt: string;
  staleAfter: string;
  /** The whole catalogue, always — a client redraws the picker without a second call. */
  serviceKinds: ServiceKindOptionV1[];
  /** The service these results are for, or `null` when none was chosen. */
  serviceKind: string | null;
  /** The jurisdiction the search actually ran with, AFTER the server's default. */
  appliedProvince: string | null;
  appliedLocality: string | null;
  /**
   * Whether the jurisdiction above was SUPPLIED by the caller or filled in from
   * the caller's first pet.
   *
   * ON THE WIRE BECAUSE THE CLIENT CANNOT TELL. The web prefills the search from
   * the person's first registered pet (`buscar/page.tsx:48-70`) and then draws the
   * filter form with those values in it, which reads as "this is what you asked
   * for". A client that showed a prefilled locality with no sign that it was
   * guessed would have somebody conclude their barrio has no campaigns when they
   * never chose their barrio.
   */
  jurisdictionSource: "requested" | "defaulted-from-pet" | "none";
  /** Empty when no service was chosen, and empty when the service has no slots. */
  results: BookableOfferingV1[];
  /** Seven, carried so a client can say "en 7 días" without inventing it. */
  windowDays: typeof APPOINTMENT_SEARCH_LIST_WINDOW_DAYS;
};

/**
 * `GET /api/v1/appointments/{offeringToken}` — one offering, its grid, and the
 * animals that may take a place.
 *
 * A 404 IS THE ONLY REFUSAL AND IT COVERS "NOT APPROVED". A pending, paused or
 * archived offering answers identically to a token that names nothing, which is
 * what the web's page does (`notFound()` at `[offeringToken]/page.tsx:43`). A
 * distinct answer would make this URL an oracle for which offerings exist and
 * which are merely switched off.
 *
 * `pets` MAY BE EMPTY and that is not an error — it is a person with no animal
 * registered yet, and the client sends them to the alta form, exactly as the web
 * does. It must NOT be rendered as "no encontramos tus mascotas".
 */
export type BookableOfferingDetailV1 = {
  payloadVersion: typeof APPOINTMENT_SEARCH_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  offering: BookableOfferingV1;
  slots: BookableSlotV1[];
  pets: BookablePetV1[];
  /** Sixty, carried for the same reason `windowDays` is on the list. */
  windowDays: typeof APPOINTMENT_OFFERING_WINDOW_DAYS;
};

/**
 * What `POST /api/v1/me/appointments` answers for `command: "book"`.
 *
 * THE TOKEN COMES BACK BECAUSE THE CLIENT CANNOT CONSTRUCT IT. `APT-XXXX-XXXX` is
 * minted inside the transaction, and it is the handle every later command — and
 * the check-in QR — takes. A client navigates to the turno with it, which is what
 * the web does (`bookSlotAction` returns `redirectTo: /mis-turnos/{token}`).
 *
 * NO `changed` FIELD, unlike the cancel ack, and the difference is real rather
 * than cosmetic: a cancel that matched nothing is REFUSED, so its `changed` is
 * always `true` and exists only for the shared shape. A booking either minted an
 * appointment or refused; there is no third state to report, and a boolean that is
 * always `true` on the one arm that can carry it says nothing.
 */
export type AppointmentBookedV1 = {
  command: "book";
  /** `APT-XXXX-XXXX`. */
  appointmentToken: string;
};
