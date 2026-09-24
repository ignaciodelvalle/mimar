// Turnos — turning the server's three lists into what a person reads, and what
// they tapped into what the contract accepts.
//
// PURE, like every other view-model in this app. It owns the es-AR sentence for
// every state and every refusal, and the mapping from a tap to an
// `AppointmentCommandInput`. Nothing here touches the network.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported and not re-stated — the
// rule `transfers-view-model.ts` and `shares-view-model.ts` both follow. What
// lives here is the WORDS: the contract carries codes, the consumer owns its copy.
//
// NOTHING HERE MAY RECOMPUTE `section`, `canCancel` OR `canCheckIn`
// ---------------------------------------------------------------------------
// All three come from the server's clock (`MyAppointmentV1`), and the flattering
// error is the dangerous one in both directions:
//
//   · a device running SLOW would keep drawing "Cancelar" on a turno the clinic
//     has already started, and the tap would be refused by a server that is
//     right — an interface promising something it cannot deliver;
//   · a device running FAST would take the check-in QR away from somebody
//     standing at the desk, which is the one moment the screen exists for.
//
// So this file reads the flags and never derives them. What it DOES own is the
// formatting of `startsAt`/`endsAt`, which is a different thing: presenting an
// instant the server sent is not deciding anything about it.
//
// THE CHECK-IN QR PAYLOAD IS THE WEB'S, BYTE FOR BYTE, AND IT POINTS NOWHERE
// ---------------------------------------------------------------------------
// `checkInQrValue` returns `deepLinkAppUrl("appointment", …)`, which is exactly
// what `/mis-turnos/[appointmentToken]/page.tsx` encodes. That string is a
// KNOWN, DECLARED DEBT and this file does not fix it: `DEEP_LINK_MAP.appointment`
// is the one entry whose `appPath` names no screen in `apps/mobile/app/`
// (`APP_PATH_NAMES_NO_SCREEN`), because it is a placeholder payload for a
// front-desk reader that does not exist yet. A phone that FOLLOWED it would land
// on `+not-found`.
//
// Producing a different string here would be worse than the debt, not better: it
// would mean the browser and the phone print two different codes for the same
// turno, and whatever front desk eventually reads one of them would silently
// refuse the other. The debt belongs to whoever builds the reader; the parity
// belongs here.

import type {
  AppointmentProviderV1,
  AppointmentProviderV1Search,
  AppointmentStatusV1,
  MyAppointmentV1,
  MyAppointmentsV1,
} from "@dim/contract/api";
import type { AppointmentCommandInput, AppointmentCommandInputCode } from "@dim/contract/input";
import {
  appointmentCommandInputSchema,
  firstAppointmentCommandInputCode,
} from "@dim/contract/input";
import { deepLinkAppUrl } from "@dim/contract/links";

import { AR_TIME_ZONE } from "../pets/libreta-view-model";

/** The web's own five words for the five statuses (`/mis-turnos/[token]/page.tsx`). */
export function appointmentStatusLabel(status: AppointmentStatusV1): string {
  switch (status) {
    case "confirmed":
      return "Confirmado";
    case "attended":
      return "Asistido";
    case "cancelled_by_owner":
      return "Cancelado por vos";
    case "cancelled_by_org":
      return "Cancelado por el prestador";
    case "no_show":
      return "No asistió";
  }
}

/**
 * The service, in one line.
 *
 * THE OFFERING'S OWN NAME COMES FIRST because it is what the provider called
 * this service and it is `NOT NULL`. `serviceKindLabel` is the catalogue's word
 * for the KIND, which is coarser — "Vacunación antirrábica" against "Campaña
 * antirrábica — Plaza San Martín" — so it belongs under, as context.
 *
 * NEITHER FALLS BACK TO `serviceKind`. A raw `vaccination_rabies` printed at a
 * person is the exact shape the buscar page was fixed for (QA 2026-08-08,
 * S3-F07), and here there is always a name to show instead.
 */
export function appointmentServiceLabel(appointment: MyAppointmentV1): string {
  return appointment.offeringName;
}

/** The catalogue's word for the kind, or `null` for a code it does not know. */
export function appointmentKindLabel(appointment: MyAppointmentV1): string | null {
  return appointment.serviceKindLabel;
}

/**
 * Who is providing it, collapsing the XOR the way the web does.
 *
 * ONE COPY, HERE. The web writes this collapse twice — once in the list and once
 * in the detail — and the two have already drifted in what they show for a
 * missing provider. The server sends the discriminated union precisely so a
 * client can make the sentence once.
 *
 * Takes BOTH provider types because the sentence needs only name/matrícula —
 * the search variant's professional deliberately carries no phone (PO decision
 * 2026-09-01), and this formatter is exactly the part the two shapes share.
 * `appointmentProviderPhone` below stays `MyAppointments`-only on purpose: a
 * held turno is the relationship that earns the number.
 */
export function appointmentProviderLabel(
  provider: AppointmentProviderV1 | AppointmentProviderV1Search,
): string {
  switch (provider.kind) {
    case "organization":
      return provider.displayName;
    case "professional": {
      // The web shows a FIRST NAME only, plus the matrícula when there is one.
      const firstName = provider.displayName.trim().split(/\s+/)[0] ?? provider.displayName;
      return provider.matriculaNumber
        ? `Dr/a. ${firstName} · Mat. ${provider.matriculaNumber}`
        : `Dr/a. ${firstName}`;
    }
    case "unknown":
      // The LEFT join found nobody. The web says this rather than leaving a gap,
      // and it is honest: the turno is with somebody, we just cannot name them.
      return "Profesional independiente";
  }
}

/** The provider's phone, when the payload carries one. `null` for `unknown`. */
export function appointmentProviderPhone(provider: AppointmentProviderV1): string | null {
  return provider.kind === "unknown" ? null : provider.phone;
}

/**
 * The price, or the word for its absence.
 *
 * `null` IS "GRATUITO" AND NEVER "$0". A free vaccination campaign and a service
 * somebody priced at zero are different facts, and only one of them is a thing
 * this product has.
 */
export function appointmentPriceLabel(priceArs: number | null): string {
  if (priceArs === null) return "Gratuito";
  return `$${priceArs.toLocaleString("es-AR")}`;
}

/**
 * When it is, as one sentence: the Argentine calendar day and the 24-hour clock.
 *
 * `hour12: false` STATED, not inherited — es-AR resolves to a 12-hour clock in
 * some ICU builds and to 24 in others, so leaving it to the locale means the same
 * turno reads "8:30" on one device and "8:30 a. m." on another. That is measured
 * in this app already (`event-detail-view-model.ts`), not theorised.
 *
 * PINNED TO ARGENTINA, on a device set to any zone. A turno is at a place, at an
 * hour that place keeps; a traveller's phone showing a Bariloche appointment in
 * Madrid time would be right about the instant and useless about the morning.
 */
export function appointmentWhenLabel(startsAtIso: string): string {
  const date = new Date(startsAtIso);
  if (Number.isNaN(date.getTime())) return "Fecha desconocida";
  // THE THREE PARTS ARE FORMATTED SEPARATELY AND JOINED HERE, rather than asked
  // of one `DateTimeFormat` with `weekday`+`day`+`month`. That combination lets
  // ICU assemble the sentence, and the assembly is BUILD-DEPENDENT: the same
  // options produce "jueves, 3 de septiembre" under Node's full ICU and
  // "jueves 3 de septiembre" elsewhere — a comma that appears and disappears
  // depending on which Hermes the phone shipped with. Same class of problem as
  // the `hour12` note below, found the same way: a test that pinned the sentence.
  const parts = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("es-AR", { ...options, timeZone: AR_TIME_ZONE }).format(date);
  const weekday = parts({ weekday: "long" });
  const day = parts({ day: "numeric" });
  const month = parts({ month: "long" });
  const clock = new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: AR_TIME_ZONE,
  }).format(date);
  return `${capitalizeFirst(weekday)} ${day} de ${month} a las ${clock}`;
}

/** The short form for a list row: `dd/mm/aaaa · HH:MM`. */
export function appointmentShortWhenLabel(startsAtIso: string): string {
  const date = new Date(startsAtIso);
  if (Number.isNaN(date.getTime())) return "Fecha desconocida";
  const day = new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: AR_TIME_ZONE,
  }).format(date);
  const clock = new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: AR_TIME_ZONE,
  }).format(date);
  return `${day} · ${clock}`;
}

/**
 * `es-AR` capitalises neither weekdays nor months, and a sentence has to start
 * somewhere. The web does the same with `::first-letter`, which is CSS this app
 * does not have.
 */
function capitalizeFirst(text: string): string {
  return text.length === 0 ? text : text[0]?.toUpperCase() + text.slice(1);
}

/**
 * What the QR encodes. See this file's header for why it is the web's string and
 * why it is a declared debt rather than a bug to fix here.
 */
export function checkInQrValue(appointmentToken: string): string {
  return deepLinkAppUrl("appointment", { appointmentToken });
}

/**
 * Every row the payload holds, in one array.
 *
 * For the DETAIL screen, which is reached by tapping a row and has to find it
 * again by token. The union of the three lists is exactly the set this caller is
 * authorized to see — the server built them from `owner_user_id` and dropped
 * every erased animal — so a token that is not in it is one this person may not
 * read, and the screen can say so without a second round trip. Same instrument
 * `allTransfers` is.
 */
export function allAppointments(payload: MyAppointmentsV1): MyAppointmentV1[] {
  return [...payload.upcoming, ...payload.past, ...payload.cancelled];
}

/** One row by its token, or `null` when this caller has no such turno. */
export function findAppointment(
  payload: MyAppointmentsV1,
  appointmentToken: string,
): MyAppointmentV1 | null {
  return allAppointments(payload).find((a) => a.appointmentToken === appointmentToken) ?? null;
}

/** How many rows are on the screen, for the header's count. */
export function appointmentsTotal(payload: MyAppointmentsV1): number {
  return allAppointments(payload).length;
}

/**
 * The header's one line, derived from THE BUCKETS ACTUALLY RENDERED.
 *
 * The web learned this the hard way: its count came from the query's row total
 * while the page rendered three filtered buckets, so a `cancelled_by_org` turno
 * that fell out of every bucket still counted — "3 turnos" over two cards
 * (state-honesty audit). Here the count and the lists come from the same three
 * arrays by construction, which is why this takes the payload and not a number.
 */
export function appointmentsTotalLabel(payload: MyAppointmentsV1): string {
  const total = appointmentsTotal(payload);
  if (total === 0) return "No tenés turnos reservados.";
  return total === 1 ? "1 turno en total." : `${total} turnos en total.`;
}

/**
 * The three empties, which are three different facts.
 *
 * A single "no hay nada" would tell somebody with a turno booked for next Tuesday
 * that they have none.
 */
export function emptyUpcomingLabel(): string {
  return "No tenés turnos próximos.";
}

export function emptyPastLabel(): string {
  return "Todavía no fuiste a ningún turno.";
}

export type CommandResult =
  | { ok: true; input: AppointmentCommandInput }
  | { ok: false; message: string; code: AppointmentCommandInputCode | null };

function validated(wire: unknown): CommandResult {
  const parsed = appointmentCommandInputSchema.safeParse(wire);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstAppointmentCommandInputCode(parsed.error);
  return { ok: false, code, message: appointmentInputCodeMessage(code) };
}

/**
 * CANCELAR EL TURNO.
 *
 * NO IDEMPOTENCY KEY, and unlike most writes in this app that is not an
 * omission: the endpoint does not read the header, because
 * `cancelAppointmentByOwner` takes no `clientIdempotencyKey`. What protects a
 * retry is an UPDATE conditional on `status = 'confirmed'`, which REFUSES a
 * replay rather than absorbing it — so the screen's job after a failure is to
 * RE-READ, never to re-send. `apps/mobile/src/pets/idempotency.ts` explains what
 * the header buys where it IS honoured.
 */
export function buildCancelAppointment(appointmentToken: string): CommandResult {
  return validated({ command: "cancel", appointmentToken });
}

/** es-AR copy for each input code. Exhaustive: every code has a sentence. */
export function appointmentInputCodeMessage(code: AppointmentCommandInputCode | null): string {
  if (code === null) {
    // The parse failed on something the contract does not name — a client and a
    // contract out of step. Honest about being unable to say more.
    return "Revisá los datos: hay un campo que la app no pudo interpretar.";
  }
  switch (code) {
    case "COMMAND_REQUIRED":
      return "La app no pudo armar la acción. Volvé a intentar.";
    case "APPOINTMENT_TOKEN_REQUIRED":
      return "No pudimos identificar el turno. Actualizá la pantalla y volvé a intentar.";
    // THE TWO BOOKING CODES. Both are reachable only when the SCREEN and the
    // payload disagree — the slot id and the pet token both come off a read the
    // screen is already holding — so neither sentence blames the person for a
    // field they never filled in. "Actualizá" is the honest instruction: the grid
    // it was built from is stale.
    case "SLOT_REQUIRED":
      return "No pudimos identificar el horario. Actualizá la pantalla y elegí de nuevo.";
    case "PET_REQUIRED":
      return "Elegí para qué mascota es el turno.";
  }
}

/**
 * The Google Calendar TEMPLATE URL for a reserved turno — the add-to-calendar
 * path that costs NO permission.
 *
 * DELIBERATELY NOT `expo-calendar`. The native module needs READ/WRITE
 * calendar permissions, which expands the Play Data Safety declaration — a
 * surface the PO signs, not something a QOL item grows silently — and its
 * silent-insert UX needs a calendar picker anyway. The template URL opens the
 * person's own calendar app with the event PREFILLED and lets them tap
 * "guardar": zero deps, zero permissions, and the person sees exactly what is
 * being written. If the PO ever wants silent insert, expo-calendar is the
 * upgrade path and this helper keeps building the event's fields.
 *
 * Dates travel in UTC basic format (YYYYMMDDTHHMMSSZ) — the calendar app
 * renders them in the phone's zone, so no AR-zone math happens here.
 */
export function appointmentCalendarUrl(appointment: MyAppointmentV1): string | null {
  const start = new Date(appointment.startsAt);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + appointment.durationMinutes * 60_000);
  const basic = (d: Date) =>
    d
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${appointmentServiceLabel(appointment)} — ${appointment.pet.name}`,
    dates: `${basic(start)}/${basic(end)}`,
    details: `Turno reservado en miMAR con ${appointmentProviderLabel(appointment.provider)}.`,
  });
  const locality =
    appointment.provider.kind === "organization" ? appointment.provider.locality : null;
  if (locality !== null) params.set("location", locality);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
