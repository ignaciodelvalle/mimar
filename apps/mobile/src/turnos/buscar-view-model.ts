// Every sentence the BUSCAR and RESERVAR screens draw, and the one command they
// send — as functions over the payload, with no React anywhere.
//
// WHY THE COPY IS HERE AND NOT IN THE SCREENS
// ---------------------------------------------------------------------------
// The same reason `turnos-view-model.ts` gives: a sentence built inside a
// component is a sentence testable only by rendering, and rendering a React Native
// tree to assert a string is three orders of magnitude of machinery for a `toBe`.
// Everything here is a pure function of the wire payload.
//
// WHAT IT DELIBERATELY DOES NOT DO
// ---------------------------------------------------------------------------
// It does not decide `canBook`, it does not decide which slots exist, and it does
// not decide whether an offering is bookable. All three are the server's, all
// three depend on state this app does not hold — a partial unique index on
// (pet, offering), the slot's `bookings_count` at read time, the offering's
// approval status — and re-deriving any of them here would be a second copy of an
// authorization rule on the client side of the wire.

import type {
  BookableOfferingV1,
  BookablePetV1,
  BookableSlotV1,
  BookingBlockedReasonV1,
  ServiceKindOptionV1,
} from "@dim/contract/api";
import {
  type AppointmentCommandInput,
  type AppointmentCommandInputCode,
  appointmentCommandInputSchema,
  firstAppointmentCommandInputCode,
} from "@dim/contract/input";

import { appointmentInputCodeMessage, appointmentPriceLabel } from "./turnos-view-model";

/**
 * Argentina, always — a turno is at a PLACE, at an hour that place keeps.
 *
 * The same constant `turnos-view-model.ts` pins, for the same reason it states:
 * a traveller's phone showing a Bariloche appointment in Madrid time would be
 * right about the instant and useless about the morning.
 */
const AR_TIME_ZONE = "America/Argentina/Buenos_Aires";

/**
 * `es-AR` capitalises neither weekdays nor months, and a heading has to start
 * somewhere. The web does it with `::first-letter`, which is CSS this app does
 * not have.
 */
function capitalizeFirst(text: string): string {
  return text.length === 0 ? text : text[0]?.toUpperCase() + text.slice(1);
}

/**
 * The heading for one offering: the provider's own name for the service.
 *
 * `displayName` AND NOT THE SERVICE-KIND LABEL. `display_name` is `text NOT NULL`
 * so it is always there, and it is what the provider chose to call this — "Campaña
 * antirrábica — Plaza San Martín" says more than "Vacunación antirrábica" to
 * somebody deciding where to go.
 */
export function offeringTitle(offering: BookableOfferingV1): string {
  return offering.displayName;
}

/**
 * The catalogue label, or `null`.
 *
 * `null` FOR A CODE THE CATALOGUE DOES NOT KNOW, and the screen then draws
 * nothing rather than a raw `snake_case` code. That is the exact shape QA
 * 2026-08-08 (S3-F07) found on the web's buscar page, where an unvalidated param
 * became the page's `<h1>`.
 */
export function offeringKindLabel(offering: BookableOfferingV1): string | null {
  return offering.serviceKindLabel;
}

/**
 * Price · duration · coverage, as one meta line.
 *
 * THE PARTS THAT ARE ABSENT ARE DROPPED, not rendered as an empty segment: a
 * trailing " · " is how a meta line tells the reader that something failed to
 * load, and here nothing did.
 */
export function offeringMetaLabel(offering: BookableOfferingV1): string {
  const parts = [
    appointmentPriceLabel(offering.priceArs),
    `${offering.durationMinutes} min`,
    offering.coverageLabel,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join(" · ");
}

/**
 * "3 turnos disponibles en 7 días", with the window from the PAYLOAD.
 *
 * THE NUMBER OF DAYS IS NOT A LITERAL HERE. The list read looks seven days ahead
 * and the offering read looks sixty, and both put their own figure on the wire
 * precisely so this sentence cannot claim the wrong one — which is what a
 * hard-coded "7" on a screen showing a sixty-day grid would do.
 */
export function offeringAvailabilityLabel(
  offering: BookableOfferingV1,
  windowDays: number,
): string {
  const turnos = offering.slotsInWindow === 1 ? "turno disponible" : "turnos disponibles";
  const days = windowDays === 1 ? "día" : "días";
  return `${offering.slotsInWindow} ${turnos} en ${windowDays} ${days}`;
}

/**
 * The place the search actually ran in, as a person would name it.
 *
 * LOCALITY AND PROVINCE TOGETHER when both are known, because the locality alone
 * is ambiguous across the country and this string now labels a CONTROL rather
 * than a passive note: "San Martín" names a place in most provinces, and somebody
 * about to decide whether to change it needs to know which one they are in.
 *
 * `null` WHEN NEITHER HALF IS KNOWN. That is a national search, and the caller
 * says so in its own words rather than getting an empty string to interpolate.
 */
export function jurisdictionPlaceLabel(view: {
  appliedProvince: string | null;
  appliedLocality: string | null;
}): string | null {
  const { appliedLocality: locality, appliedProvince: province } = view;
  if (locality && province) return `${locality}, ${province}`;
  return locality ?? province ?? null;
}

/**
 * The label on the row that OPENS the locality picker.
 *
 * IT IS A CONTROL AND NOT A CAPTION, which is what changed on 2026-09-04. Until
 * then this screen could not filter by locality at all: it drew a sentence saying
 * where the server had looked, and the empty state told people to go to the
 * website to look somewhere else. The row says the same fact and is the way to
 * change it, so the two cannot drift apart — there is only one place the zone is
 * named, and tapping it is how you edit what it says.
 *
 * ALWAYS A STRING, unlike the note below. A search with no jurisdiction is
 * national and the row must still be drawn, because for somebody with no animal
 * registered yet it is the ONLY way to narrow the search at all.
 */
export function jurisdictionRowLabel(view: {
  appliedProvince: string | null;
  appliedLocality: string | null;
}): string {
  const place = jurisdictionPlaceLabel(view);
  return place === null ? "Buscando en todo el país" : `Buscar cerca de: ${place}`;
}

/**
 * The row's second line — what tapping it does, worded for the state it is in.
 *
 * IT STARTS WITH THE VERB THE TESTER GUIDE NAMES. `dim-interno:docs/mobile/guia-tester.md`
 * tells people to tap "Cambiar", and a caption reading "Tocá para modificar…"
 * would send them hunting for a control that is under their thumb. `ListRow` has
 * no trailing action slot, so the caption IS the affordance's name — which is why
 * the word is first and not buried mid-sentence.
 */
export function jurisdictionRowCaption(view: {
  appliedProvince: string | null;
  appliedLocality: string | null;
}): string {
  return jurisdictionPlaceLabel(view) === null ? "Elegir una localidad." : "Cambiar la localidad.";
}

/**
 * Where a GUESSED jurisdiction came from — and nothing else.
 *
 * `null` FOR EVERY OTHER CASE, and that is the whole of this function now. It
 * used to carry two sentences: "Buscando en X." for a chosen place and "Buscando
 * cerca de X, la zona donde registraste tu primera mascota." for a guessed one.
 * The first arm existed only because nothing else on the screen named the place;
 * `jurisdictionRowLabel` now does, and a second line repeating it under the
 * control that sets it is furniture.
 *
 * WHAT SURVIVES IS THE PART THE ROW CANNOT SAY: that nobody chose this. The
 * browser prefills its filter form from the person's first registered pet and
 * draws those values as if they had been typed, so somebody whose animal is
 * registered in another province concludes their barrio has no campaigns when
 * they never chose their barrio. That is the defect `jurisdictionSource` is on
 * the wire for, and it is not fixed by a control — a prefilled control still
 * reads as a choice.
 */
export function jurisdictionNoteLabel(view: {
  appliedProvince: string | null;
  appliedLocality: string | null;
  jurisdictionSource: "requested" | "defaulted-from-pet" | "none";
}): string | null {
  if (view.jurisdictionSource !== "defaulted-from-pet") return null;
  if (jurisdictionPlaceLabel(view) === null) return null;
  return "Es la zona donde registraste tu primera mascota. Podés cambiarla.";
}

/** The empty result, said in the words of the search that produced it. */
export function noResultsLabel(view: {
  appliedProvince: string | null;
  appliedLocality: string | null;
}): string {
  const place = view.appliedLocality ?? view.appliedProvince;
  return place
    ? `No hay turnos disponibles en ${place} para este servicio. Probá otra localidad.`
    : "No hay turnos disponibles para este servicio en los próximos días.";
}

/** The picker's rows, straight off the wire — the catalogue is the server's. */
export function serviceKindRows(options: ServiceKindOptionV1[]): ServiceKindOptionV1[] {
  return options;
}

/**
 * One slot, as a button label: the 24-hour clock in Argentine time.
 *
 * `hour12: false` STATED, not inherited. `es-AR` resolves to a 12-hour clock in
 * some ICU builds and to 24 in others, so leaving it to the locale means the same
 * slot reads "8:30" on one device and "8:30 a. m." on another — measured in this
 * app already, not theorised.
 */
export function slotTimeLabel(slot: BookableSlotV1): string {
  const date = new Date(slot.startsAt);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: AR_TIME_ZONE,
  }).format(date);
}

/**
 * "2 lugares", or `null` when the count says nothing.
 *
 * DRAWN ONLY WHEN THE SLOT HOLDS MORE THAN ONE, which is what the web does: "1
 * lugar" on an ordinary consultation is noise, and every slot in the grid has at
 * least one by construction.
 */
export function slotPlacesLabel(slot: BookableSlotV1): string | null {
  if (slot.placesLeft <= 1) return null;
  return `${slot.placesLeft} lugares`;
}

/** The heading for one day of the grid: "Jueves 3 de septiembre". */
export function slotDayHeading(startsAtIso: string): string {
  const date = new Date(startsAtIso);
  if (Number.isNaN(date.getTime())) return "Fecha desconocida";
  // THE THREE PARTS ARE FORMATTED SEPARATELY AND JOINED HERE rather than asked of
  // one `DateTimeFormat` with `weekday`+`day`+`month`. That combination lets ICU
  // assemble the sentence, and the assembly is BUILD-DEPENDENT — the same options
  // produce "jueves, 3 de septiembre" under full ICU and "jueves 3 de septiembre"
  // elsewhere, a comma that appears and disappears depending on which Hermes the
  // phone shipped with. The same trap `appointmentWhenLabel` records.
  const parts = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("es-AR", { ...options, timeZone: AR_TIME_ZONE }).format(date);
  return `${capitalizeFirst(parts({ weekday: "long" }))} ${parts({ day: "numeric" })} de ${parts({
    month: "long",
  })}`;
}

/** The grid, grouped by Argentine calendar day, in the server's order. */
export type SlotDay = { key: string; heading: string; slots: BookableSlotV1[] };

export function groupSlotsByDay(slots: BookableSlotV1[]): SlotDay[] {
  const days: SlotDay[] = [];
  const byKey = new Map<string, SlotDay>();

  for (const slot of slots) {
    const date = new Date(slot.startsAt);
    // A SLOT WITH AN UNREADABLE DATE IS DROPPED, not filed under "Fecha
    // desconocida". A time nobody can name is a time nobody can arrive at, and a
    // bookable button under it would be an appointment somebody cannot keep.
    if (Number.isNaN(date.getTime())) continue;
    const key = new Intl.DateTimeFormat("es-AR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: AR_TIME_ZONE,
    }).format(date);

    const existing = byKey.get(key);
    if (existing) {
      existing.slots.push(slot);
      continue;
    }
    // ORDER IS THE SERVER'S — the grid arrives soonest-first, so the first slot of
    // a day is what names it and the days come out in the order they occur.
    const day: SlotDay = { key, heading: slotDayHeading(slot.startsAt), slots: [slot] };
    byKey.set(key, day);
    days.push(day);
  }

  return days;
}

/** es-AR for each reason an animal cannot be booked into THIS offering. */
export function blockedReasonLabel(reason: BookingBlockedReasonV1): string {
  switch (reason) {
    case "already_booked_in_offering":
      // NAMES THE CAMPAIGN AND NOT THE SLOT. The rule is per (pet, offering): the
      // animal already holds a place in this campaign, and picking a different
      // time will not change that. Copy that said "ya tiene este turno" would send
      // somebody to try the next hour.
      return "Ya tiene un turno reservado en este servicio.";
  }
}

/**
 * The shape a pet's public token always has on the wire: `DIM-XXXX-XXXX`.
 *
 * `DIM` fixed, because `BookablePetV1.publicToken` is always a PET token —
 * the other prefixed shapes this system generates (`LBR`, `APR`, `OFR`, `APT`,
 * `INV`, `TAG`; `lib/infra/publicToken.ts`) belong to other entities and never
 * reach this screen. Case-insensitive because the check is about SHAPE, not
 * about the generator's own uppercase alphabet.
 */
const PET_TOKEN_SHAPE = /^DIM-[A-Z0-9]+-[A-Z0-9]+$/i;

/**
 * The last block of a `DIM-XXXX-XXXX` token — the shortest thing on the wire
 * that tells two animals apart.
 *
 * WHY THE TOKEN AND NOT THE SPECIES (native QA batch 2, C2). The obvious
 * disambiguator is "Rocco · Perro", and it is not available: `BookablePetV1`
 * carries `publicToken`, `name`, `canBook` and `blockedReason` and nothing else
 * (packages/contract/src/api/appointment-search.ts). Adding species would be a
 * contract change, a payload version and a server edit for a picker label —
 * and it would still not separate two dogs with one name, which is the case
 * that produced the finding. The token does, because the token IS the identity
 * in this system (invariant #1) and it is already in hand.
 *
 * THE LAST BLOCK AND NOT THE WHOLE TOKEN, because the row is read at a glance
 * beside a name: `DIM-PAMP-0001` doubles the label's length to add four
 * characters of signal. Two of a person's own animals sharing a last block is
 * possible and is not what this fixes — it fixes the picker that offered two
 * identical rows.
 *
 * Returns "" for anything that does not match `PET_TOKEN_SHAPE`, and the
 * caller then falls back to the bare name rather than printing a stray
 * separator. THIS IS A REAL CHECK AND NOT MERELY "IS THERE A HYPHEN" (code
 * review #5, 2026-09-04): a bare `split("-")` on a name with no hyphen at all —
 * `"Rocco"` — has exactly one block, so the old code upper-cased the whole
 * string and printed "Rocco · ROCCO", a disambiguator manufactured from the
 * animal's own name. The doc comment already claimed "" for anything not
 * token-shaped; the shape now has a definition that makes the claim true.
 */
export function petTokenSuffix(publicToken: string): string {
  const trimmed = publicToken.trim();
  if (!PET_TOKEN_SHAPE.test(trimmed)) return "";
  const blocks = trimmed.split("-");
  const last = blocks[blocks.length - 1] ?? "";
  return last.toUpperCase();
}

/** One pet's row label: its name, a disambiguator, plus why it cannot be chosen. */
export function petChoiceLabel(pet: BookablePetV1): string {
  const suffix = petTokenSuffix(pet.publicToken);
  // The disambiguator goes on BOTH arms. A blocked row is the one a person
  // stares at longest — they are working out which of their animals is already
  // booked — so it is the last row that should be ambiguous about which animal
  // it names.
  const named = suffix === "" ? pet.name : `${pet.name} · ${suffix}`;
  if (pet.canBook || pet.blockedReason === null) return named;
  return `${named} — ${blockedReasonLabel(pet.blockedReason)}`;
}

/**
 * What to say when the caller has no animal to book for.
 *
 * NOT "no encontramos tus mascotas". An empty list here is a person who has not
 * registered one yet, which is a thing they can fix in the app, and the sentence
 * has to say so.
 */
export function noBookablePetsLabel(): string {
  return "Necesitás una mascota registrada para reservar un turno.";
}

export type CommandResult =
  | { ok: true; input: AppointmentCommandInput }
  | { ok: false; message: string; code: AppointmentCommandInputCode | null };

/**
 * RESERVAR EL TURNO.
 *
 * VALIDATED AGAINST THE CONTRACT'S OWN SCHEMA, never against a local copy of its
 * rules: the client runs the same parse the server does, so a field error gets a
 * message under the right control instead of arriving as a 400 with no detail.
 *
 * NO IDEMPOTENCY KEY, and unlike most writes in this app that is not an omission.
 * `bookSlotWriter` takes no `clientIdempotencyKey`; what it has is a
 * `pg_advisory_xact_lock` on the slot plus two partial unique indexes, and those
 * REFUSE a replay rather than absorbing one. So after a timeout the screen's job
 * is to RE-READ the grid, never to re-send: the refusal a retry gets back is
 * indistinguishable from somebody else having taken the last place.
 */
export function buildBookSlot(args: { slotId: string; petPublicToken: string }): CommandResult {
  const parsed = appointmentCommandInputSchema.safeParse({
    command: "book",
    slotId: args.slotId,
    petPublicToken: args.petPublicToken,
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstAppointmentCommandInputCode(parsed.error);
  return { ok: false, code, message: appointmentInputCodeMessage(code) };
}
