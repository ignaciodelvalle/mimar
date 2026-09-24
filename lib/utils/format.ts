// Spanish-language formatting helpers for dates, enums, and event labels.
// All UI strings live here so we can change copy without touching components.

import type { EventType } from "@/db/schema";

/**
 * The one timezone every UI date is formatted in. miMAR is an Argentina-only
 * service, so a calendar day is always the Argentine calendar day.
 *
 * WHY THIS MUST BE PINNED (React #418): date formatters run BOTH during SSR
 * (in the server process — UTC on Vercel/CI) and again during client
 * hydration (in the browser — the viewer's zone). Without an explicit
 * `timeZone`, `Intl.DateTimeFormat`/`toLocaleDateString` use the AMBIENT zone,
 * so a date stored near local midnight (e.g. a date-only value at T00:00:00Z)
 * renders as one calendar day on the server and the previous day on the
 * client → the server HTML and client render disagree → hydration mismatch
 * (React error #418), which cascades into blank/frozen paints. Pinning the
 * zone makes SSR and hydration produce byte-identical strings.
 *
 * ANY client-side date formatter MUST pass this as its `timeZone`. Import this
 * constant instead of hardcoding the string so the decision stays in one place.
 */
export const AR_TIME_ZONE = "America/Argentina/Buenos_Aires";

const SPANISH_DATE_FORMAT = new Intl.DateTimeFormat("es-AR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: AR_TIME_ZONE,
});

// hourCycle "h23" for the same reason as the two formatters below it: without
// it, es-AR + hour:"2-digit" renders the hybrid "05:39 p. m." — a zero-padded
// 12-hour clock with a meridiem, which is neither the 24-hour convention the
// rest of the product uses nor a clean 12-hour one. This helper is the
// canonical formatDateTime(), so the leak reached every consumer of it while
// its two neighbours in this file were already fixed (copy audit 2026-08-04).
const SPANISH_DATETIME_FORMAT = new Intl.DateTimeFormat("es-AR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: AR_TIME_ZONE,
});

// A bare "YYYY-MM-DD" string (how Drizzle `date()` columns arrive in app code)
// parsed with `new Date(...)` lands on UTC MIDNIGHT, which every AR-pinned
// formatter below then rolls back to 21:00 of the PREVIOUS calendar day — the
// stored "6/8" renders "5 ago" (Cowork QA v3, M2a). Anchor date-only input at
// noon UTC — the same rule as parseDateInput — so the stored day is the day
// shown in any zone within ±12 h.
const DATE_ONLY_INPUT_RE = /^\d{4}-\d{2}-\d{2}$/;

function coerceDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  return DATE_ONLY_INPUT_RE.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  return SPANISH_DATE_FORMAT.format(date);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  return SPANISH_DATETIME_FORMAT.format(date);
}

// Time-only — "17:47". Added (copy audit 2026-08-04, S2) after the same
// { hour: "2-digit", minute: "2-digit", timeZone: AR_TIME_ZONE } object turned
// up hand-rolled, byte-identical, at 9 call sites (turno slot times, the
// Panorama watermark, the solo-vet agenda) — none of the existing shapes
// dropped day/month/year, so there was no canonical home for "just a clock".
// hourCycle: "h23" for the same reason as SPANISH_DATETIME_FORMAT above.
const SPANISH_TIME_FORMAT = new Intl.DateTimeFormat("es-AR", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: AR_TIME_ZONE,
});

export function formatTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  return SPANISH_TIME_FORMAT.format(date);
}

// Compact date — "7 de jul de 2026". AR-pinned like every formatter here: without an
// explicit timeZone, Intl uses the RUNTIME zone (UTC on the production server),
// so a timestamp near AR midnight renders the wrong calendar day and, worse,
// mismatches between SSR (UTC) and browser hydration (bug #418). This is the
// canonical short form — dozens of call sites previously hand-rolled the same
// { day, month:"short", year } shape, many WITHOUT the timeZone (the off-by-one
// bug this centralises away).
const SPANISH_DATE_SHORT_FORMAT = new Intl.DateTimeFormat("es-AR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: AR_TIME_ZONE,
});

export function formatDateShort(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  return SPANISH_DATE_SHORT_FORMAT.format(date);
}

// Legal-document timestamp (MPF/PPP PDF exports — staging validation
// 2026-07-04, bug 4): seconds precision + an EXPLICIT timezone label. A legal
// PDF printing a bare clock ("generado 06:27:41" for a 17:47 ART generation,
// server clock = UTC) is ambiguous evidence; every legal timestamp must be
// AR-pinned AND say so.
const SPANISH_DATETIME_LEGAL_FORMAT = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  // 24-hour clock — es-AR's Intl default is 12-hour ("05:47:41 p. m."), which
  // reintroduces exactly the am/pm ambiguity this formatter exists to remove.
  hourCycle: "h23",
  timeZone: AR_TIME_ZONE,
});

/**
 * es-AR timestamp for legal/exported documents: "07/07/2026, 17:47:41 (hora
 * de Argentina)". Always pinned to AR_TIME_ZONE with an explicit label —
 * never render a legal clock without its timezone.
 */
export function formatDateTimeLegal(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${SPANISH_DATETIME_LEGAL_FORMAT.format(date)} (hora de Argentina)`;
}

// Parse a "YYYY-MM-DD" string from <input type="date"> into a Date anchored at
// noon UTC of that calendar day. Noon UTC stays on the same calendar date when
// rendered in any timezone within ±12 hours, so the user sees the date they
// picked instead of the previous day. Returns null if the string is empty or
// invalid.
export function parseDateInput(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// "YYYY-MM-DDTHH:mm" (optional ":ss") from <input type="datetime-local">.
const AR_DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/**
 * Parse a "YYYY-MM-DDTHH:mm" string from `<input type="datetime-local">` as
 * ARGENTINE wall-clock time. Returns null for empty/malformed input.
 *
 * WHY (not `new Date(value)`): an offset-less date-time string is parsed in
 * the RUNTIME's local zone — UTC on the server — so "2026-07-08T18:00" typed
 * by an es-AR user becomes 18:00Z = 15:00 AR, three hours early. Our
 * datetime-local defaults are AR wall clock (`nowLocalDatetimeInAr`), so the
 * submitted string must be read back in the same zone. Argentina is UTC-3
 * year-round (no DST since 2009), so a fixed "-03:00" suffix is exact and
 * needs no zone database.
 */
export function parseArDatetimeLocal(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!AR_DATETIME_LOCAL_RE.test(trimmed)) return null;
  const d = new Date(`${trimmed}-03:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// "YYYY-MM-DD" of the CURRENT calendar day in Argentina. en-CA emits the
// ISO-ordered YYYY-MM-DD form; pinning AR_TIME_ZONE makes it the Argentine day.
const AR_ISO_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: AR_TIME_ZONE,
});

/**
 * Today's calendar day in Argentina as "YYYY-MM-DD" — the correct DEFAULT for a
 * `<input type="date">`.
 *
 * WHY (not `new Date().toISOString().slice(0, 10)`): `toISOString()` yields the
 * UTC calendar day. On the server (UTC) or late in the AR evening (UTC-3), that
 * is TOMORROW relative to Argentina — so a "today" default silently becomes a
 * FUTURE date and any form with a "no future date" rule rejects it ("la fecha no
 * puede ser futura"). Formatting through AR_TIME_ZONE returns the real Argentine
 * calendar day, so the default is never spuriously future.
 *
 * `now` is injectable so tests can pin a UTC-tomorrow / AR-today instant.
 */
export function todayIsoInAr(now: Date = new Date()): string {
  return isoDateInAr(now);
}

/**
 * The Argentine calendar day ("YYYY-MM-DD") of an arbitrary instant. Same
 * AR_TIME_ZONE pinning as `todayIsoInAr` (which delegates here) — use it to
 * bucket historical timestamps by their Argentine day (e.g. grouping an activity
 * feed), where "today" semantics would be wrong.
 */
export function isoDateInAr(date: Date): string {
  return AR_ISO_DATE_FORMAT.format(date);
}

// "YYYY-MM-DDTHH:mm" of the CURRENT wall-clock instant in Argentina — the
// correct DEFAULT for a `<input type="datetime-local">`. hourCycle "h23"
// keeps a 24-hour, zero-padded hour (midnight = "00", never "24") matching
// the datetime-local input format exactly.
const AR_ISO_DATETIME_PARTS_FORMAT = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: AR_TIME_ZONE,
});

/**
 * Argentina's current wall-clock instant as "YYYY-MM-DDTHH:mm" — the correct
 * DEFAULT for a `<input type="datetime-local">`.
 *
 * WHY (not `new Date().toISOString().slice(0, 16)`): `toISOString()` yields
 * UTC wall-clock, 3 hours ahead of Argentina. A "right now" default computed
 * that way is off by 3 hours always, and off by a full CALENDAR DAY near
 * midnight (e.g. 00:30 AR is still 03:30Z the same UTC day, but 22:30 AR is
 * already 01:30Z the NEXT UTC day). Building the string from
 * `Intl.DateTimeFormat` parts (rather than string-slicing a formatted
 * output) sidesteps locale punctuation entirely.
 *
 * `now` is injectable so tests can pin a UTC instant and assert the AR
 * wall-clock result, including the 3h offset.
 */
export function nowLocalDatetimeInAr(now: Date = new Date()): string {
  const parts = AR_ISO_DATETIME_PARTS_FORMAT.formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/**
 * Compact numeric AR-pinned date+time — "17/07/2026 04:30" (dd/mm/aaaa HH:mm,
 * 24-hour). Built from `Intl.DateTimeFormat` PARTS (not a formatted string) so
 * the separators are fixed regardless of the es-AR locale's punctuation (which
 * inserts a comma between date and time). AR_TIME_ZONE-pinned like every
 * formatter here — a timestamp near AR midnight never renders the wrong calendar
 * day, and SSR (UTC) and browser hydration produce byte-identical strings.
 * Returns "—" for empty/invalid input.
 */
export function formatDateTimeNumericAr(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = AR_ISO_DATETIME_PARTS_FORMAT.formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

// Compact recent-timestamp form for ops tables — "6 ago, 13:21" (day + short
// month + 24h clock, NO year). Extracted from two byte-identical hand-rolled
// options objects in the admin sistema surfaces (token audit 2026-08-06,
// item 8). The year is dropped on purpose: these are rolling operational
// timestamps (cron last-run and friends) never more than days old.
const SPANISH_DATETIME_SHORT_FORMAT = new Intl.DateTimeFormat("es-AR", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: AR_TIME_ZONE,
});

export function formatDateTimeShortAr(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  return SPANISH_DATETIME_SHORT_FORMAT.format(date);
}

// Compact "DD/MM" AR-pinned date that appends the year ONLY when it differs
// from the CURRENT Argentine calendar year — "18/07" this year, "18/07/2027"
// any other (medianos-sesión-2, finding #1). A bare "Próxima 18/7" is fine
// 364 days out of 365, but silently WRONG the one day a due date crosses into
// next year — it reads as "today" when the real date is a year out. Compares
// AR-calendar years via `isoDateInAr` (never a raw UTC year: `Date#getFullYear`
// runs in the machine's local zone, which flips the day near AR midnight on
// both SSR and hydration — the same #418 class every formatter here guards
// against). `now` is injectable so tests can pin the comparison year.
export function formatDateArOmitCurrentYear(
  value: Date | string | null | undefined,
  now: Date = new Date(),
): string {
  if (!value) return "—";
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = AR_ISO_DATETIME_PARTS_FORMAT.formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const base = `${part("day")}/${part("month")}`;
  const dateYear = isoDateInAr(date).slice(0, 4);
  const nowYear = isoDateInAr(now).slice(0, 4);
  return dateYear === nowYear ? base : `${base}/${dateYear}`;
}

// The dd/mm/aaaa date-entry helpers (isoToArDateDisplay, parseArDateToIso,
// maskArDateInput) live in ./date-input-ar — split out when this module hit
// the 1500-line fence (2026-08-06).

// El diccionario de especies vive en ./species — separado el 2026-08-09,
// cuando este modulo volvio a cruzar el limite de 1500 lineas del fence de
// tamano. Se re-exporta para que los 76 archivos que ya lo importaban de aca
// sigan funcionando sin tocarse.
export { speciesLabel, speciesLabelPlural, speciesOptions } from "./species";

export function sexLabel(sex: string): string {
  switch (sex) {
    case "male":
      return "Macho";
    case "female":
      return "Hembra";
    case "unknown":
      return "No especificado";
    default:
      return sex;
  }
}

/**
 * "Castrada" / "Castrado" agreeing with the pet's sex.
 *
 * Three surfaces inlined this ternary and a fourth — the public credential —
 * shipped "Castrado/a" instead, which is how a QA tester read it about Pampa, a
 * female (ronda 5, 2026-07-16). A slashed both-genders label is the tell that a
 * screen has the fact and is not using it: sex is always on the pet row.
 *
 * "unknown" keeps the slashed form — there it is honest rather than lazy.
 */
export function sterilizedLabel(sex: string): string {
  switch (sex) {
    case "male":
      return "Castrado";
    case "female":
      return "Castrada";
    default:
      return "Castrado/a";
  }
}

/**
 * "Perdida" / "Perdido" agreeing with the pet's sex.
 *
 * Same shape and same reason as sterilizedLabel: the lost listing inlined
 * `sex === "female" ? "Perdida" : "Perdido"`, which calls an unknown-sex pet
 * male. 22k+ pets carry `sex = 'unknown'` — a stray posted by a finder rarely
 * has a known sex, which is exactly the population this listing is for.
 *
 * Accepts null/undefined so a caller holding an optional sex does not have to
 * launder it into "" first — the default branch already says "we don't know",
 * which is the same answer. `LnStatusFlag` is such a caller.
 */
export function lostLabel(sex: string | null | undefined): string {
  switch (sex) {
    case "male":
      return "Perdido";
    case "female":
      return "Perdida";
    default:
      return "Perdido/a";
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Activa";
    case "lost":
      return "Perdida";
    case "deceased":
      return "Fallecida";
    default:
      return status;
  }
}

/**
 * es-AR label for the outcome of a request the owner made or received —
 * foster proposals, approval requests, transfers. They all share the same
 * small vocabulary of endings.
 *
 * Exists because the owner's own case history printed the RAW ENUM: the
 * resolved-foster row read "Estado: accepted" and the decided-approval row read
 * "Resuelta: approved", in the middle of an otherwise fully translated screen.
 * That is the same `CaseStatus.open`-said-five-ways family the 2026-08-01
 * review counted — the raw-enum-leak end of it — and the labels below are not
 * new copy: they are the exact words four other surfaces already hand-roll
 * (app/(app)/transferencias, app/org/[orgToken]/voluntarios/propuestas, and
 * both org transferencias pages). This is the one shared home they can migrate
 * to; nothing forces them to yet.
 *
 * Returns null — never the raw value — for anything unmapped. A caller that
 * cannot name a state must say nothing rather than leak the enum, which is the
 * exact failure being fixed here.
 *
 * `"open"` is included for `custody_transfer_handshake`/`custody_episode`
 * cases (`CaseStatus`, not `RequestStatus`): both org transferencias screens
 * used to hand-roll their own word for it — "Esperando respuesta" (sender)
 * vs "Pendiente de respuesta" (receiver), the same case status said two
 * ways across the same org's two tabs (copy audit 2026-08-04, part of the
 * `CaseStatus.open`-said-five-ways family). They now both import this.
 */
export function requestOutcomeLabel(status: string | null | undefined): string | null {
  switch (status) {
    case "accepted":
    case "approved":
    case "resolved":
      return "Aceptada";
    case "rejected":
      return "Rechazada";
    case "cancelled":
    case "withdrawn":
      return "Cancelada";
    case "expired":
    case "auto_expired":
      return "Expirada";
    case "pending":
    case "open":
      return "Pendiente";
    default:
      return null;
  }
}

/**
 * es-AR label for a `service_offerings` review status. The two gob screens
 * for this entity — the list at /gob/servicios and the detail at
 * /gob/servicios/[offeringToken] — used to hand-roll this map independently;
 * the list said "Pendiente" for `pending_approval` while the detail said
 * "Pendiente de revisión" for the SAME offering (copy audit 2026-08-04).
 * Both now import this instead of re-typing the map.
 */
export function serviceOfferingStatusLabel(status: string): string {
  switch (status) {
    case "pending_approval":
      return "Pendiente de revisión";
    case "approved":
      return "Aprobado";
    case "rejected":
      return "Rechazado";
    default:
      return status;
  }
}

// `accountTypeLabel` and `roleLabel` moved to `lib/domain/role-labels.ts` on
// 2026-09-09 — they are the only readers of the role/account-type enums in this
// file, and a role label changes on a schema event, not a formatting one.

// ---------------------------------------------------------------------------
// Sex-aware lost-mode copy (UI-4)
// ---------------------------------------------------------------------------
//
// The public credential and cockpit must gender the "lost" wording by the
// pet's recorded sex instead of guessing from the name ending. Three cases:
//   - male    → masculine ("perdido")
//   - female  → feminine  ("perdida")
//   - unknown → a sex-neutral phrasing that reads naturally in es-AR and never
//               assumes a gender ("Se perdió" / "Me perdí").
//
// Pure functions — no DOM, exported for unit testing.

export type PetSex = "male" | "female" | "unknown";

function normalizeSex(sex: string | null | undefined): PetSex {
  return sex === "male" || sex === "female" ? sex : "unknown";
}

/** Banner headline, e.g. "ESTÁ PERDIDO" / "ESTÁ PERDIDA" / "SE PERDIÓ". */
export function lostBannerHeadline(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "ESTÁ PERDIDO";
    case "female":
      return "ESTÁ PERDIDA";
    default:
      return "SE PERDIÓ";
  }
}

/** First-person hero line spoken by the pet, e.g. "Estoy perdido" / "Me perdí". */
export function lostFirstPersonLine(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "Estoy perdido";
    case "female":
      return "Estoy perdida";
    default:
      return "Me perdí";
  }
}

/** Third-person "está perdid{o|a}" / "se perdió" used in cockpit/share copy. */
export function lostThirdPersonPhrase(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "está perdido";
    case "female":
      return "está perdida";
    default:
      return "se perdió";
  }
}

/** Mark-found button / past-participle wording, e.g. "encontrado" / "encontrada". */
export function foundParticiple(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "encontrado";
    case "female":
      return "encontrada";
    default:
      // Neutral: "encontrada/o" reads as the inclusive form when sex is unknown.
      return "encontrada/o";
  }
}

/** Finder-claims-custody CTA, e.g. "La tengo conmigo" / "Lo tengo conmigo". */
export function foundPossessivePhrase(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "Lo tengo conmigo";
    case "female":
      return "La tengo conmigo";
    default:
      // Neutral: sidesteps the lo/la pronoun when sex is unknown.
      return "Está conmigo";
  }
}

/** Sighting CTA/headline, e.g. "La vi cerca de acá" / "Lo vi cerca de acá". Used
 * both as the sighting-form page headline and the lower-commitment CTA button
 * next to foundPossessivePhrase on the lost public credential — the two must
 * agree with the pet's recorded sex, not default to feminine. */
export function sightingPhrase(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "Lo vi cerca de acá";
    case "female":
      return "La vi cerca de acá";
    default:
      // Neutral: sidesteps the lo/la pronoun when sex is unknown.
      return "Vi a la mascota cerca de acá";
  }
}

/** Found-report prompt on a NOT-lost public credential (sticky action bar,
 * cursor citizen review P3) — the finder path stays useful for a
 * found-but-not-marked-lost pet. Voseo imperative with enclitic pronoun. */
export function foundReportPrompt(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "¿Lo encontraste? Reportalo";
    case "female":
      return "¿La encontraste? Reportala";
    default:
      // Neutral: sidesteps the lo/la pronoun when sex is unknown.
      return "¿Encontraste a esta mascota? Reportá";
  }
}

/**
 * Owner-side action label / sheet title: "Marcar como perdido" / "Marcar como
 * perdida" / "Marcar como perdido/a". Ciclo-perdido sweep (tester ronda
 * 2026-07-16): the mark-lost sheet title, the perdida page heading, and the
 * cartel guard CTA all hardcoded the feminine form. The "/a" neutral matches
 * the roleLabel "Dueño/a" convention.
 */
export function markLostActionLabel(sex: string | null | undefined): string {
  return `Marcar como ${lostAdjective(sex)}`;
}

/**
 * El adjetivo solo — la ÚNICA decisión de género de esta familia.
 *
 * Existe porque la pasada de 2026-07-16 arregló las tres etiquetas peladas y se
 * le escapó una cuarta: el `<h1>` de MarkLostWizard interpola el nombre
 * (`Marcar ${petName} como perdida`), así que no era el label pelado y ningún
 * barrido por texto exacto lo encontró. Con el adjetivo aparte, las dos formas
 * salen de un único switch y no puede volver a pasar.
 */
function lostAdjective(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "perdido";
    case "female":
      return "perdida";
    default:
      // El "/a" neutro sigue la convención de roleLabel ("Dueño/a").
      return "perdido/a";
  }
}

/**
 * Igual que `markLostActionLabel` pero con el nombre de la mascota adentro:
 * "Marcar Tero como perdido".
 *
 * El wizard tenía este título fijo en FEMENINO mientras su `<h2>` y su `<p>`
 * estaban fijos en MASCULINO, así que siempre había uno mal — fuera macho o
 * hembra (hallazgo S2-F07).
 */
export function markLostTitleForPet(petName: string, sex: string | null | undefined): string {
  return `Marcar ${petName} como ${lostAdjective(sex)}`;
}

/** Sighting-form question, e.g. "¿Cuándo lo viste?" / "¿Cuándo la viste?".
 * Neutral sidesteps the lo/la pronoun when sex is unknown. */
export function sightedWhenQuestion(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "¿Cuándo lo viste?";
    case "female":
      return "¿Cuándo la viste?";
    default:
      return "¿Cuándo viste a la mascota?";
  }
}

/** "si lo viste" / "si la viste" / "si viste a la mascota" — share-message
 * fragment; must agree with the pet, never default to feminine. */
export function lostSeenCallout(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "si lo viste";
    case "female":
      return "si la viste";
    default:
      return "si viste a la mascota";
  }
}

/**
 * Generic lost-mode share message (WhatsApp / native share) for surfaces with
 * NO disclosure data (MergedShareSheet): names only the pet, flexed by sex.
 * e.g. "Rocco está perdido. Mirá su credencial y avisanos si lo viste:"
 */
export function lostShareMessage(petName: string, sex: string | null | undefined): string {
  return `${petName} ${lostThirdPersonPhrase(sex)}. Mirá su credencial y avisanos ${lostSeenCallout(sex)}:`;
}

/**
 * Bandeja / workflow-item title for an active lost episode, e.g.
 * "Rocco está reportado como perdido" / "Michi está reportada como perdida".
 * Neutral rewords to avoid the participle: "Se reportó la pérdida de X".
 */
export function lostReportedTitle(petName: string, sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return `${petName} está reportado como perdido`;
    case "female":
      return `${petName} está reportada como perdida`;
    default:
      return `Se reportó la pérdida de ${petName}`;
  }
}

/**
 * Cartel/A4 poster headline. Sex-correct where known; the neutral form is the
 * classic street-poster "SE BUSCA" (tester fix #3a) rather than a slashed
 * "PERDIDO/A" — a poster headline must read at a glance.
 */
export function lostPosterHeadline(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "PERDIDO";
    case "female":
      return "PERDIDA";
    default:
      return "SE BUSCA";
  }
}

/** "Última vez visto" / "Última vez vista" section heading (cartel + public
 * credential). Slashed inclusive form when sex is unknown. */
export function lastSeenHeadingLabel(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "Última vez visto";
    case "female":
      return "Última vez vista";
    default:
      return "Última vez visto/a";
  }
}

/** Cartel guard prompt when the pet is not lost yet, e.g. "Marcalo como
 * perdido primero para generar el cartel." Neutral rewords around the clitic. */
export function markLostFirstPrompt(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "Marcalo como perdido primero para generar el cartel.";
    case "female":
      return "Marcala como perdida primero para generar el cartel.";
    default:
      return "Reportá su pérdida primero para generar el cartel.";
  }
}

/**
 * Registration badge word on the pet credential, e.g. "Rocco **Registrado**"
 * / "Michi **Registrada**". QA histórico 2026-07-08 #2: the badge was
 * hardcoded feminine ("Inscripta"), disagreeing with a male pet's name
 * ("Rocco Inscripta"). Neutral "/a" (matching the existing roleLabel
 * "Dueño/a" convention) covers pets with no recorded sex.
 *
 * PO 2026-07-30: the word moved from "Inscripto/a" to "Registrado/a". The
 * credential's own vocabulary already says "registrada" everywhere else
 * (`pet_registered`, the `registered` status flag, "Registro Nacional"), and
 * "inscripto" read as a second, competing act.
 */
export function registeredAdjective(sex: string | null | undefined): string {
  switch (normalizeSex(sex)) {
    case "male":
      return "Registrado";
    case "female":
      return "Registrada";
    default:
      return "Registrado/a";
  }
}

/**
 * Gender-agrees a `lib/ui/pet-situation.ts` situation label with the pet's
 * recorded sex. PET_SITUATIONS labels default to feminine (documented there
 * as "feminine default, matching the app's copy") because most situation
 * labels are invariant noun phrases ("En tratamiento", "En adopción") where
 * gender doesn't apply — only "Perdida" and "Fallecida" are adjectives that
 * must actually agree with the pet. "Preñada" is intentionally excluded:
 * pregnancy is exclusively a female state, so it never regenders.
 * QA histórico 2026-07-08 #2: swept the credential's situation skin for the
 * same masculine/feminine disagreement as the Inscripta badge.
 */
export function situationLabelForSex(label: string, sex: string | null | undefined): string {
  if (normalizeSex(sex) !== "male") return label;
  const MASCULINE_BY_FEMININE_LABEL: Record<string, string> = {
    Perdida: "Perdido",
    Fallecida: "Fallecido",
  };
  return MASCULINE_BY_FEMININE_LABEL[label] ?? label;
}

// Exhaustive map — must have exactly one entry per EventType.
// If you add a new entry to EVENT_TYPES, TypeScript will fail here until
// you add a corresponding label. Use `satisfies` so inference stays narrow.
const EVENT_TYPE_LABELS = {
  // Lifecycle
  pet_registered: "Mascota registrada",
  pet_profile_updated: "Perfil actualizado",
  status_changed: "Cambio de estado",
  death_recorded: "Fallecimiento",
  // Preventive medicine
  vaccination_administered: "Vacuna administrada",
  deworming_administered: "Antiparasitario",
  sterilization_performed: "Esterilización",
  // Medication
  medication_started: "Inicio de medicación",
  medication_stopped: "Fin de medicación",
  // Clinical encounters
  vet_visit_logged: "Visita al veterinario",
  // Body metrics
  weight_recorded: "Peso registrado",
  // Identification & legal
  microchip_implanted: "Microchip implantado",
  microchip_replaced: "Reemplazo de microchip",
  tattoo_recorded: "Tatuaje registrado",
  tattoo_updated: "Tatuaje actualizado",
  dangerous_breed_attested: "Atestación de raza peligrosa",
  // Free-form
  note_added: "Nota",
  // System / observed
  credential_scanned: "Credencial escaneada",
  incident_reported: "Incidente reportado",
  rabies_observation_started: "Observación antirrábica iniciada",
  rabies_observation_ended: "Observación antirrábica finalizada",
  // Medication adherence
  medication_dose_taken: "Dosis administrada",
  // Non-owner reporting
  symptom_observed: "Síntoma observado",
  abandonment_reported: "Abandono reportado",
  maltreatment_reported: "Maltrato reportado",
  // Unified clinical information
  clinical_info_logged: "Información clínica",
  // Custody & adoption
  shelter_intake_recorded: "Ingreso al refugio",
  foster_assigned: "Tránsito asignado",
  foster_ended: "Tránsito finalizado",
  adoption_application_submitted: "Postulación de adopción enviada",
  adoption_application_resolved: "Postulación de adopción resuelta",
  adoption_finalized: "Adopción finalizada",
  post_adoption_checkin: "Seguimiento post-adopción",
  adoption_reversed: "Adopción revertida",
  custody_transferred: "Custodia transferida",
  ownership_claimed: "Mascota reclamada",
  // Lost & Found
  custody_transfer_proposed: "Propuesta de devolución",
  custody_transfer_cancelled: "Propuesta de devolución cancelada",
  // Custody disputes
  custody_dispute_raised: "Disputa de custodia iniciada",
  custody_dispute_resolved: "Disputa de custodia resuelta",
  // Foster volunteers pool
  foster_proposed: "Propuesta de tránsito",
  foster_proposal_resolved: "Propuesta de tránsito resuelta",
  foster_co_foster_allowed: "Co-tránsito habilitado",
  // Adoption eligibility
  adoption_eligibility_set: "Elegibilidad para adopción actualizada",
  // Surveillance
  outbreak_signal: "Señal de brote",
  disease_reported: "Enfermedad reportada",
  // Jurisdictional mobility
  movement_recorded: "Movilidad registrada",
  // Correction by amendment — Wave 2 Item 15 (principle #2, 2026-06-19)
  event_amended: "Corrección registrada",
  // Physical tag (chapa) lifecycle — migration 0169
  tag_activated: "Chapa activada",
  tag_revoked: "Chapa dada de baja",
  // Cuidado temporal (custodia-temporal, 0189). "Cuidado temporal" es el
  // vocabulario provisorio: la decisión de nomenclatura sigue abierta con el PO
  // (Q1), así que estas dos etiquetas son el único lugar donde hay que tocarla.
  caretaker_designated: "Cuidado temporal iniciado",
  caretaker_ended: "Cuidado temporal finalizado",
  // Rehome sponsorship (rehome-by-titular). "Apadrinamiento" y no "custodia":
  // el animal se queda en la casa del titular y la organización acompaña la
  // adopción. Decirle custodia acá repetiría en la libreta la afirmación falsa
  // que el resto del cambio existe para desactivar.
  rehome_sponsorship_started: "Apadrinamiento de adopción iniciado",
  rehome_sponsorship_ended: "Apadrinamiento de adopción finalizado",
  // Moderación de contenido. "Reportado" y NUNCA "denunciado": en este producto
  // `denuncia` ya nombra una denuncia por maltrato (Ley 14.346), con nueve tipos
  // y cuatro severidades, que se rutea a una autoridad real. Usar esa palabra
  // acá sugeriría un expediente donde sólo hay un mensaje ocultado.
  content_reported: "Contenido reportado",
} satisfies Record<EventType, string>;

export function eventTypeLabel(eventType: EventType): string {
  return EVENT_TYPE_LABELS[eventType];
}

/**
 * Whole ARGENTINE calendar days elapsed from `date` to `now` (negative when
 * `date` is in the future). Compares `isoDateInAr` day strings — NOT elapsed
 * milliseconds: an event at 20:00 yesterday viewed at 10:00 today is only 14
 * elapsed hours, but it IS one calendar day ago. Elapsed-floor day math calls
 * that "hoy" (and calls 24–48h elapsed "ayer" even when it is two calendar
 * days back near midnight) — the exact bug class this helper replaces.
 */
export function calendarDaysAgoInAr(date: Date, now: Date = new Date()): number {
  const utcMidnightOfArDay = (d: Date) => Date.parse(`${isoDateInAr(d)}T00:00:00Z`);
  return Math.round((utcMidnightOfArDay(now) - utcMidnightOfArDay(date)) / 86_400_000);
}

/**
 * Calendar-day chip for a date (or a pre-computed AR "YYYY-MM-DD" day string):
 * "hoy", "ayer", or a compact "d/M" — the gob activity-feed dayChip pattern,
 * centralised. Day identity is the ARGENTINE calendar day (calendarDaysAgoInAr).
 */
export function relativeDayLabel(date: Date | string, now: Date = new Date()): string {
  const day = typeof date === "string" ? date : isoDateInAr(date);
  if (day === todayIsoInAr(now)) return "hoy";
  if (day === isoDateInAr(new Date(now.getTime() - 86_400_000))) return "ayer";
  const [, m, d] = day.split("-");
  return `${Number(d)}/${Number(m)}`;
}

export function relativeTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "ahora";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  // Day-level labels are ARGENTINE-calendar-based (calendarDaysAgoInAr): the
  // old elapsed math said "hace 14 h" for 20:00-yesterday viewed at 10:00
  // today, and "ayer" for anything 24–48h old even when that lands two
  // calendar days back. Hour granularity applies only within the same AR day.
  const dayDiff = calendarDaysAgoInAr(date, now);
  if (dayDiff <= 0) return `hace ${Math.floor(diffMin / 60)} h`;
  if (dayDiff === 1) return "ayer";
  if (dayDiff < 7) return `hace ${dayDiff} días`;
  if (dayDiff < 30) return `hace ${Math.floor(dayDiff / 7)} sem`;
  return formatDate(date);
}

/**
 * Compact "hace Nd" formatter for operator-dense lists (e.g. outreach overdue
 * tables) where the day count itself is the prioritisation signal.
 *
 * Guards against absurd outputs:
 *  - null / NaN / epoch-sentinel (getTime() === 0, used for "no record") → "—"
 *  - <= 0 days → "hoy"
 *  - up to ~10 years → `hace Nd` (real overdue values stay legible: 400d, 900d…)
 *  - beyond ~10 years → absolute date, NEVER `hace 20624d`
 *
 * The 10-year cap exists because anything larger can only be a bad/sentinel
 * date, not a real "days since" value worth showing as a relative count.
 */
const RELATIVE_DAYS_ABSOLUTE_THRESHOLD = 3650; // ~10 years

export function relativeDaysShort(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = coerceDate(value);
  const t = date.getTime();
  if (Number.isNaN(t) || t === 0) return "—";
  // AR-calendar days, not elapsed-ms floor — 20:00 yesterday viewed at 10:00
  // today is "hace 1d", never "hoy" (calendarDaysAgoInAr rationale).
  const days = calendarDaysAgoInAr(date);
  if (days <= 0) return "hoy";
  if (days <= RELATIVE_DAYS_ABSOLUTE_THRESHOLD) return `hace ${days}d`;
  return formatDate(date);
}

export function notificationSeverityLabel(severity: string): string {
  switch (severity) {
    case "info":
      return "Info";
    case "success":
      return "Listo";
    case "warning":
      return "Atención";
    case "urgent":
      return "Urgente";
    default:
      return severity;
  }
}

// ---------------------------------------------------------------------------
// Phone normalization for tel: hrefs (UI-4 fix 6)
// ---------------------------------------------------------------------------
//
// Produces a dialable value for a tel: href from a raw, human-entered AR phone.
// Conservative: when confident, returns E.164 (+54…); otherwise returns the
// digits-only form so the link still dials something rather than choking on
// spaces/dashes/parens. The display string can keep its pretty form.
//
// Rules (best-effort, AR-centric):
//   - Already starts with "+": strip non-digits after the leading +, keep it.
//   - Starts with "00": treat as international prefix → "+" + rest.
//   - Starts with "0" (national trunk) or "15" handling is intentionally NOT
//     attempted (mobile 15 prefixes are ambiguous without an area code split);
//     we only confidently prepend +54 when the local number, after dropping a
//     single leading 0, has a plausible AR length (10 digits).
//   - Otherwise: return digits only (no guessing).
export function normalizePhoneForTel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // International, explicit "+".
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits ? `+${digits}` : null;
  }

  // International access code "00…" → "+…".
  if (trimmed.startsWith("00")) {
    const digits = trimmed.slice(2).replace(/\D/g, "");
    return digits ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  // Already carries the AR country code.
  if (digits.startsWith("54")) {
    return `+${digits}`;
  }

  // National form with leading trunk "0": drop it. A plausible AR national
  // significant number is 10 digits (area code + subscriber). Only then are we
  // confident enough to stamp +54.
  if (digits.startsWith("0")) {
    const national = digits.replace(/^0+/, "");
    if (national.length === 10) return `+54${national}`;
    return national; // digits-only fallback — not confidently AR.
  }

  // Bare 10-digit national number (no trunk, no country code) → +54.
  if (digits.length === 10) return `+54${digits}`;

  // Anything else: conservative digits-only fallback.
  return digits;
}

// ---------------------------------------------------------------------------
// Death-cause labels (es-AR) — item 3.4 UX audit
//
// Maps DEATH_CAUSES enum values (English keys, from death-rules.ts) to their
// Spanish display labels. The underlying values are NEVER changed here.
// ---------------------------------------------------------------------------

const DEATH_CAUSE_LABELS: Record<string, string> = {
  known: "Causa conocida",
  unknown: "Causa desconocida",
  natural: "Muerte natural",
  disease: "Enfermedad",
  accident: "Accidente",
  euthanasia: "Eutanasia",
  sudden: "Muerte súbita",
  violent: "Causa violenta",
  other: "Otra causa",
};

/**
 * Returns the es-AR display label for a death cause value.
 * Falls back to the raw value if unrecognized (forward-compat).
 */
export function deathCauseLabel(cause: string | null | undefined): string {
  if (!cause) return "—";
  return DEATH_CAUSE_LABELS[cause] ?? cause;
}

// ---------------------------------------------------------------------------
// Disposition-method labels (es-AR) — item 3.4 UX audit
//
// Maps DispositionMethod enum values (English keys) to Spanish display labels.
// ---------------------------------------------------------------------------

const DISPOSITION_METHOD_LABELS: Record<string, string> = {
  cremation_collective: "Cremación colectiva",
  cremation_individual_ashes: "Cremación individual con cenizas",
  authorized_cemetery: "Cementerio habilitado",
  owner_burial: "Entierro en domicilio",
  household_waste: "Residuos domiciliarios",
  rendering: "Reciclaje sanitario",
  unknown: "Sin especificar",
};

/**
 * Returns the es-AR display label for a disposition method value.
 * Falls back to the raw value if unrecognized (forward-compat).
 */
export function dispositionMethodLabel(method: string | null | undefined): string {
  if (!method) return "—";
  return DISPOSITION_METHOD_LABELS[method] ?? method;
}

// ---------------------------------------------------------------------------
// Notification-type labels (es-AR) — item 3.4 UX audit
//
// Maps notification_type string values (English snake_case keys stored in DB)
// to human-readable Spanish labels for the NotificationCard chip.
// Only types that actually reach the notification surface are mapped here;
// any unknown type falls back gracefully to the raw code.
// ---------------------------------------------------------------------------

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  // Adoption
  adoption_application_approved: "Adopción aprobada",
  adoption_application_closed: "Adopción cerrada",
  adoption_application_received: "Postulación recibida",
  adoption_application_rejected: "Adopción rechazada",
  adoption_application_withdrawn: "Postulación retirada",
  adoption_finalized: "Adopción finalizada",
  adoption_info_requested: "Info de adopción solicitada",
  // Amendments
  admin_event_amended: "Evento corregido por admin",
  // Appointments
  appointment_cancelled_by_org: "Turno cancelado por la organización",
  appointment_attended: "Turno atendido",
  appointment_cancelled_by_owner: "Turno cancelado",
  appointment_no_show: "Turno ausente",
  // Approval requests
  approval_request_approved: "Solicitud aprobada",
  approval_request_auto_expired: "Solicitud vencida automáticamente",
  approval_request_info_requested: "Más información solicitada",
  approval_request_pending_authority: "Solicitud pendiente de aprobación",
  approval_request_proposed_authority: "Nueva solicitud de aprobación",
  approval_request_rejected: "Solicitud rechazada",
  approval_request_submitted_self: "Solicitud enviada",
  // Bites
  bite_reported_authority: "Mordedura reportada a autoridad",
  bite_reported_by_org_owner: "Mordedura reportada por organización",
  // Capabilities
  capability_granted: "Permiso otorgado",
  capability_request: "Solicitud de permiso",
  capability_approved: "Permiso aprobado",
  capability_rejected: "Permiso rechazado",
  // Chip
  chip_match_notification_owner: "Coincidencia de microchip detectada",
  microchip_duplicate_detected: "Microchip duplicado detectado",
  microchip_fraud_detected: "Posible fraude de microchip",
  microchip_updated_by_institution: "Microchip actualizado por institución",
  // Cross-org transfers
  cross_org_transfer_accepted_receiver: "Transferencia aceptada",
  cross_org_transfer_accepted_sender: "Transferencia aceptada por receptor",
  cross_org_transfer_cancelled_receiver: "Transferencia cancelada",
  cross_org_transfer_proposed_receiver: "Propuesta de transferencia recibida",
  cross_org_transfer_proposed_sender: "Propuesta de transferencia enviada",
  cross_org_transfer_rejected_sender: "Transferencia rechazada",
  // Custody
  custody_dispute_party_added: "Disputa de custodia: parte agregada",
  custody_dispute_raised_against_you: "Disputa de custodia iniciada en tu contra",
  custody_dispute_raised_by_you: "Disputa de custodia iniciada por vos",
  custody_dispute_resolved: "Disputa de custodia resuelta",
  case_escalated_by_operator: "Expediente escalado por un operador",
  custody_dispute_stale: "Disputa de custodia sin movimiento",
  custody_received: "Custodia recibida",
  custody_transfer_accepted_owner_side: "Devolución aceptada por el dueño",
  custody_transfer_auto_cancelled: "Devolución cancelada automáticamente",
  custody_transfer_proposal_owner: "Propuesta de devolución",
  // Decomiso
  decomiso_confirmed_admin: "Decomiso confirmado (admin)",
  decomiso_confirmed_govt: "Decomiso confirmado",
  decomiso_handoff_accepted_govt: "Handoff de decomiso aceptado",
  decomiso_handoff_accepted_receiver: "Handoff de decomiso aceptado por receptor",
  decomiso_handoff_proposed_receiver: "Propuesta de handoff de decomiso recibida",
  decomiso_handoff_rejected_govt: "Handoff de decomiso rechazado",
  decomiso_handoff_stale: "Handoff de decomiso sin movimiento",
  decomiso_owner_lost_custody: "Animal decomisado — custodia transferida",
  // ENO / disease
  eno_disease_diagnosis: "Diagnóstico ENO registrado",
  eno_pet_disease_diagnosis: "Diagnóstico ENO en tu mascota",
  outbreak_signal_detected: "Señal de brote detectada",
  // Foster
  foster_assigned: "Tránsito asignado",
  foster_converted_to_owner: "Tránsito convertido en adopción",
  foster_ended: "Tránsito finalizado",
  foster_ended_by_adoption: "Tránsito finalizado por adopción",
  foster_ended_by_death: "Tránsito finalizado por fallecimiento",
  foster_ended_by_transfer: "Tránsito finalizado por transferencia",
  foster_proposal_accepted_org: "Propuesta de tránsito aceptada",
  foster_proposal_auto_cancelled_org: "Propuesta de tránsito cancelada automáticamente",
  foster_proposal_cancelled_volunteer: "Propuesta de tránsito cancelada por voluntario",
  foster_proposal_expired: "Propuesta de tránsito vencida",
  foster_proposal_received: "Propuesta de tránsito recibida",
  foster_proposal_rejected_org: "Propuesta de tránsito rechazada",
  foster_volunteer_reenroll_prompt: "Recordatorio para re-inscribirse como tránsito",
  // Govt / institutional
  admin_deactivated: "Cuenta admin desactivada",
  govt_deactivated: "Cuenta govt desactivada",
  govt_locality_assigned: "Localidad asignada",
  govt_locality_revoked: "Localidad revocada",
  govt_self_deactivated_admin_notice: "Auto-baja de operador govt",
  govt_self_deactivated_cascade_notice: "Cuenta govt dada de baja en cascada",
  institutional_account_created: "Cuenta institucional creada",
  operator_credentials_reset: "Credenciales de operador reseteadas",
  // Lost & Found
  lost_episode_resolved_broadcast: "Mascota encontrada — difusión",
  lost_episode_resolved_owner: "Mascota encontrada",
  lost_pet_broadcast: "Alerta de mascota perdida",
  // Taxonomy (tester fix #1): a sighting is NOT a hallazgo. New sighting rows
  // carry pet_sighting; pet_found_report stays mapped so pre-taxonomy rows
  // (old sightings AND found reports) keep rendering a sane label.
  pet_sighting: "Avistaje reportado",
  pet_found_report: "Reporte de mascota encontrada",
  pet_in_possession: "Mascota en posesión",
  anonymous_reports_overflow: "Muchos avisos sobre tu mascota",
  // Org
  free_pet_claimed: "Mascota libre reclamada",
  org_invitation_accepted: "Invitación a organización aceptada",
  org_invitation_created: "Invitación a organización enviada",
  org_membership_removed: "Salida de la organización",
  org_verification_granted: "Verificación de organización otorgada",
  org_verification_revoked: "Verificación de organización revocada",
  // Pet transfers
  pet_transfer_accepted: "Transferencia de mascota aceptada",
  pet_transfer_cancelled: "Transferencia de mascota cancelada",
  pet_transfer_expired: "Transferencia de mascota vencida",
  pet_transfer_initiated: "Transferencia de mascota iniciada",
  pet_transfer_received: "Transferencia de mascota recibida",
  pet_transfer_rejected: "Transferencia de mascota rechazada",
  // Post-adoption
  post_adoption_checkin_due: "Seguimiento post-adopción pendiente",
  post_adoption_checkin_missed: "Seguimiento post-adopción no realizado",
  post_adoption_checkin_received: "Seguimiento post-adopción recibido",
  // PPP / breed rules
  ppp_breed_list_updated_now_applies: "Lista de razas PPP actualizada — aplica a tu mascota",
  ppp_registration_reminder: "Recordatorio: registrá tu mascota PPP",
  // Pregnancy
  pregnancy_ended_owner: "Gestación finalizada",
  pregnancy_started_owner: "Gestación registrada",
  // Profile
  profile_self_updated: "Perfil actualizado",
  self_resignation_confirmed: "Baja confirmada",
  stub_profile_claimed: "Perfil reclamado",
  // Rabies observation
  rabies_observation_completed_dead_authority: "Observación antirrábica: animal fallecido",
  rabies_observation_completed_negative_owner: "Observación antirrábica finalizada — negativo",
  rabies_observation_completed_professional_owner: "Observación antirrábica finalizada",
  rabies_observation_escalation_owner: "Observación antirrábica: requiere atención",
  rabies_observation_pending_review: "Observación antirrábica pendiente de revisión",
  rabies_observation_started_owner: "Observación antirrábica iniciada",
  rabies_observation_window_expired_owner: "Observación antirrábica: período cumplido",
  // Revocations / service
  revocation_executed_org: "Revocación de verificación ejecutada",
  revocation_executed_vet: "Revocación de matrícula ejecutada",
  service_dog_credential_revoked: "Credencial de perro de asistencia revocada",
  service_offering_approved: "Servicio aprobado",
  service_offering_pending_authority: "Servicio pendiente de aprobación",
  service_offering_rejected: "Servicio rechazado",
  service_offering_submitted: "Servicio enviado para revisión",
  shelter_intake_confirmed: "Ingreso al refugio confirmado",
  // Welfare
  welfare_denuncia_stale_govt: "Denuncia de bienestar sin movimiento",
  welfare_org_intervention_note: "Nota de intervención de bienestar",
  welfare_org_intervention_returned: "Devolución post-intervención registrada",
  welfare_org_intervention_taken: "Mascota tomada en custodia por intervención",
  welfare_org_side_confirmed_reporter: "Denuncia de bienestar confirmada",
  welfare_org_side_critical_received: "Denuncia de bienestar crítica recibida",
  welfare_report_derived_to_org: "Denuncia derivada a organización",
  welfare_report_rederived_away: "Denuncia re-derivada a otra organización",
  welfare_report_status_changed: "Estado de denuncia actualizado",
  // Vaccines — one notificationType covers both "due soon" and "already
  // overdue" (the body carries the specifics), so the label must not assert
  // "próxima a vencer": it sat on a dose expired 117 days earlier (9-role
  // external run, 2026-08-18).
  vaccine_due: "Vencimiento de vacuna",
  // Rehome (rehome-by-titular: the titular asks a verified org to sponsor the
  // adoption listing; accept/decline go back to the titular)
  rehome_request_received: "Solicitud de re-hogar recibida",
  rehome_request_accepted: "Solicitud de nuevo hogar aceptada",
  rehome_request_declined: "Solicitud de nuevo hogar rechazada",
  // The titular's two exits (WU4): both go to the org's admins.
  rehome_request_withdrawn: "Solicitud de nuevo hogar cancelada por el titular",
  rehome_sponsorship_withdrawn: "Acompañamiento de adopción dado de baja",
  // The death cascade (WU7): the org's admins, when a sponsored pet dies.
  rehome_sponsorship_ended_by_death: "Acompañamiento de adopción terminado por fallecimiento",
  // Scans
  first_stranger_scan: "Primer escaneo de un desconocido",
  // Onboarding
  welcome: "Bienvenida",
};

/**
 * es-AR label for a rabies-observation close outcome. Short prose form used in
 * notification bodies so the owner never sees the raw enum value
 * ("outcome: negative"). Mirrors the option copy in CloseObservationForm.
 */
const RABIES_OUTCOME_LABELS: Record<string, string> = {
  negative: "resultado negativo (animal sano)",
  positive_rabies: "resultado positivo (rabia confirmada o sospechada)",
  dead: "fallecimiento durante la observación",
  lost_to_followup: "sin seguimiento (animal perdido o sin contacto)",
};

export function rabiesObservationOutcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) return "resultado no especificado";
  return RABIES_OUTCOME_LABELS[outcome] ?? outcome;
}

/**
 * Returns the es-AR human label for a notification_type code.
 * Falls back to the raw code for unknown types (forward-compat).
 */
export function notificationTypeLabel(notificationType: string | null | undefined): string {
  if (!notificationType) return "—";
  return NOTIFICATION_TYPE_LABELS[notificationType] ?? notificationType;
}

/**
 * Cap a potentially large count for display so alarming raw numbers are not
 * surfaced to owners (UX 3.5 item 6). Returns a string: the number itself
 * when ≤ cap, or "${cap}+" when above. Default cap is 99.
 *
 * @example capCount(264)  // "99+"
 * @example capCount(5)    // "5"
 * @example capCount(99)   // "99"
 * @example capCount(100)  // "99+"
 */
export function capCount(n: number, cap = 99): string {
  return n > cap ? `${cap}+` : String(n);
}

// ---------------------------------------------------------------------------
// Numeric KPI / metric formatters (es-AR) — KPI precision audit 2026-07-07
// ---------------------------------------------------------------------------
//
// The operator + government dashboards render percentages, rates, and counts.
// es-AR uses a COMMA decimal separator and a DOT thousands separator
// ("1.982", "41,3%"). A bare template literal (`${x}%`) and `toFixed()` both
// emit a DOT decimal ("41.3%") — the WRONG locale. Every KPI/metric display
// MUST route through these helpers instead of formatting inline.
//
// Precision rules (PO KPI-precision directive):
//   - Percentages: 1 decimal ("41,3%"); exactly 0 or 100 render clean.
//   - Rates (per 10k, per capita) and averages/durations: 1 decimal.
//   - Counts: integer, thousands-separated — never a fake decimal.
//   - Deltas: same precision as their base metric, with an explicit sign.
//
// Precision must SURVIVE to this layer: fetchers return full-precision numbers
// and the DISPLAY decides how many decimals to show. Do NOT round a percentage
// to a whole integer in the fetcher — that discards the decimal before it can
// ever reach a formatter.

const AR_COUNT_FORMAT = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });

/** Cache one fixed-decimal es-AR formatter per decimal count (usually 1). */
const arDecimalFormatters = new Map<number, Intl.NumberFormat>();
function arDecimalFormat(decimals: number): Intl.NumberFormat {
  let fmt = arDecimalFormatters.get(decimals);
  if (!fmt) {
    fmt = new Intl.NumberFormat("es-AR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    arDecimalFormatters.set(decimals, fmt);
  }
  return fmt;
}

/** es-AR integer with a thousands separator ("1.982"). Non-finite → "—". */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return AR_COUNT_FORMAT.format(Math.round(value));
}

/**
 * es-AR percentage, 1 decimal by default ("41,3%"). Exactly 0 or 100 render
 * clean ("0%" / "100%"). Non-finite → "—". `value` is a 0–100 percentage,
 * NOT a 0–1 fraction.
 */
export function formatPercent(
  value: number | null | undefined,
  options: { decimals?: number } = {},
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const { decimals = 1 } = options;
  if (value === 0) return "0%";
  if (value === 100) return "100%";
  return `${arDecimalFormat(decimals).format(value)}%`;
}

/**
 * es-AR decimal rate WITHOUT a unit suffix, 1 decimal by default ("3,5"). For
 * per-10k / per-capita rates and averages/durations (días promedio); the caller
 * appends the unit label. Non-finite → "—".
 */
export function formatRate(
  value: number | null | undefined,
  options: { decimals?: number } = {},
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const { decimals = 1 } = options;
  return arDecimalFormat(decimals).format(value);
}

/**
 * es-AR signed delta ("+2,4", "-1,0", "0,0"). Precision matches the base metric
 * via `decimals` (default 1); `unit` appends a suffix ("pp", "%"). Non-finite →
 * "—".
 */
export function formatDelta(
  value: number | null | undefined,
  options: { decimals?: number; unit?: string } = {},
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const { decimals = 1, unit = "" } = options;
  const fmt = new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: "exceptZero",
  });
  return `${fmt.format(value)}${unit}`;
}

/**
 * es-AR pet weight WITH its unit: `"12,5 kg"`, `"22,75 kg"`, `"9 kg"`.
 *
 * Weight is the one measurement that reaches a CITIZEN surface — the owner
 * timeline and the printable libreta sanitaria — and it arrives as the STRING
 * the `weight_recorded` payload stores (`{ kg: "12.50" }`, produced by
 * `toFixed(2)` in src/modules/events/actions.ts). Both call sites used to
 * interpolate that string raw, so an Argentine libreta printed "12.50 kg" with
 * an English decimal point, and two tests asserted that output as correct.
 *
 * Formatting rules:
 *  - Comma decimal separator (`es-AR`), like every other number in the app.
 *  - Up to 2 decimals, and NO padding zeros: the stored "12.50" is 12,5 — the
 *    second decimal is an artefact of the storage format, not a measurement.
 *  - Non-numeric / non-finite input → `null`, so a caller can omit the row
 *    rather than print "NaN kg". (Unlike the KPI helpers, whose "—" makes
 *    sense inside a fixed tile grid, this one appears mid-sentence.)
 */
export function formatWeightKg(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n)} kg`;
}

// ---------------------------------------------------------------------------
// Spanish pluralization (Wave M)
// ---------------------------------------------------------------------------
//
// Dozens of surfaces inlined `${n} evento${n === 1 ? "" : "s"}`-shaped
// ternaries — each one a chance to pick the wrong suffix ("señals",
// "animals") or drift in wording. This is the ONE place count-agreement
// lives; scripts/check-pluralize-es.ts bans new ad-hoc ternaries.

/**
 * Pluralize a Spanish noun by count: returns `singular` when `n === 1`, else
 * the plural form.
 *
 * Default plural (when `plural` is omitted) follows the regular rules:
 *   - ends in "z"  → "-ces"  ("vez" → "veces")
 *   - ends in a vowel (incl. accented) → "+s" ("evento" → "eventos")
 *   - otherwise → "+es" ("señal" → "señales", "mes" → "meses")
 *
 * Pass `plural` explicitly for irregulars the rules cannot derive — accent
 * shifts ("camión" → "camiones"), invariants ("lunes" → "lunes"), or
 * multi-word phrases ("regla provincial" → "reglas provinciales").
 */
// The implementation moved to @dim/contract so the citizen app and the pure
// contract package share it; this re-export keeps every existing import path.
import { pluralizeEs } from "@dim/contract/reference";

export { pluralizeEs };

/**
 * "hace N día(s)" with correct singular agreement — "hace 1 día", never "hace
 * 1 días". Several call sites (admin observaciones relative-time, vaccine_due
 * notification bodies, outreach-reminder bodies) hand-rolled `hace ${n} días`
 * without the `n === 1` branch that `lostTimeLabel` (lib/infra/lost-listing.ts)
 * already got right — this is the one shared home for that phrase so it can't
 * drift again.
 */
export function formatDiasAgo(n: number): string {
  return `hace ${n} ${pluralizeEs(n, "día")}`;
}

/**
 * Age from a date of birth, counted UP TO `until` when the animal has died.
 *
 * Without a cut-off this counted to today for every pet, including the dead
 * ones: Kabosu (died 2024) read "20 años" and Hachikō (died 1935) read "102
 * años" on their public credentials — a number that is absurd on its face for
 * the historical record and quietly wrong for a pet that died last month
 * (master test CIU, B0b/B0c). A life has a length; it stops at the end of it.
 *
 * `until` is the death date. Callers pass it whenever they have it; omitting it
 * keeps the previous behaviour for living animals, which is correct for them.
 */
export function ageFromDateOfBirth(
  dateOfBirth: string | null | undefined,
  until?: Date | string | null,
): string | null {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const cutoff = until ? new Date(until) : null;
  const now = cutoff && !Number.isNaN(cutoff.getTime()) ? cutoff : new Date();
  let years = now.getFullYear() - dob.getFullYear();
  let months = now.getMonth() - dob.getMonth();
  if (months < 0 || (months === 0 && now.getDate() < dob.getDate())) {
    years -= 1;
    months += 12;
  }
  if (years > 0) {
    return `${years} ${pluralizeEs(years, "año")}`;
  }
  if (months > 0) {
    return `${months} ${pluralizeEs(months, "mes")}`;
  }
  return "menos de un mes";
}
