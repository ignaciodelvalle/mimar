// Travel rules checked against the libreta (viajes-fase-2, design D3).
//
// PURE. Until Phase 3 several travel rules were only DISPLAYED — "Microchip
// previo a la vacuna antirrábica: Requerido" whatever the libreta said. Each
// evaluator below reads the pet's actual events and answers with a tone and
// an es-AR state. Three rules hold throughout:
//
//   · the green-ish answer is "Registrada en la libreta", never a promise —
//     the libreta records what happened; SENASA and the airline decide;
//   · an unknown or ESTIMATED underlying date (an implant date nobody knows, an
//     estimated birth date) is amber, never green;
//   · a check the libreta cannot answer (a titre RESULT, a miasis certificate)
//     stays a warning, never green.
//
// Calendar days, not instants: an event's day is its Argentine calendar day;
// a date-only value (travel date, CVI issue date, birth date) is its own day.

import type {
  BreedRestriction,
  Embargo,
  Modality,
  RequirementLevel,
  TravelDocument,
} from "@/lib/domain/travel-strictness";
import type { ConfidenceTier } from "@/lib/events/event-confidence";
import type { ComplianceTone } from "@/lib/projections/pet-compliance";
import { brachycephalicBreedsFor } from "@/lib/reference/brachycephalic-breeds";
import {
  SPECIAL_BREED_OPTIONS,
  breedListIncludesResolved,
  resolveBreedLabel,
} from "@/lib/reference/breeds";
import { formatDate, isoDateInAr } from "@/lib/utils/format";
import { normalizeText } from "@/lib/utils/text-normalize";

export type Evaluation = {
  tone: ComplianceTone;
  deadlineLapsed: boolean;
  state: string;
  detail: string | null;
  /** Forces the level (e.g. a checklist that is information by design). */
  level?: RequirementLevel;
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type TravelLibretaEvent = {
  eventType: string;
  payload: unknown;
  occurredAt: Date | string;
  /**
   * Who stands behind the entry (computeConfidence over the row's author
   * columns). For travel, only `professional_verified` and
   * `institutional_verified` VERIFY a fact; anything else only DECLARES it
   * (PO 2026-10-07). Every reader of the spine passes it — loadTravelView
   * does. ABSENT means the caller vouches for the entry (pure fixtures).
   */
  confidenceTier?: ConfidenceTier | null;
};

/** The tiers that verify a fact for travel (PO 2026-10-07). */
export const TRAVEL_VERIFIED_TIERS: ReadonlySet<ConfidenceTier> = new Set<ConfidenceTier>([
  "professional_verified",
  "institutional_verified",
]);

/**
 * The medical facts a trip checks. A paper the owner copies (the CVI) and a
 * weight are the owner's to record: those are read from every entry.
 */
const MEDICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "vaccination_administered",
  "deworming_administered",
  "microchip_implanted",
  "microchip_replaced",
  "clinical_info_logged",
]);

/** Whether an entry verifies its fact for travel. */
export function verifiesForTravel(e: TravelLibretaEvent): boolean {
  if (e.confidenceTier === undefined || e.confidenceTier === null) return true;
  return TRAVEL_VERIFIED_TIERS.has(e.confidenceTier);
}

/** The pet facts the travel checks need, from the `pets` row. */
export type TravelPetFacts = {
  species: string | null;
  /** pets.dateOfBirth — a date-only string or a Date. */
  dateOfBirth: Date | string | null;
  birthDateIsEstimated: boolean;
  breed: string | null;
};

type DewormingType = "internal" | "external" | "both";

export type LibretaFacts = {
  /** Rabies dose days, ascending. */
  rabiesDoses: number[];
  /** Microchip implants, ascending by day. */
  chipImplants: { day: number; dateKnown: boolean }[];
  /** Any microchip_replaced on record (a replacement or a revocation). */
  chipReplaced: boolean;
  /** The chip on record was revoked with no replacement. */
  chipRevoked: boolean;
  dewormings: { day: number; type: DewormingType }[];
  /** The most recently issued CVI. */
  latestCvi: { issuedDay: number; validUntilDay: number | null } | null;
  latestWeightKg: number | null;
  /** Rabies antibody titre lab records, ascending by day. */
  titerTests: number[];
  /** Every vaccine name on record, lower-cased and without accents. */
  vaccineNames: string[];
  /**
   * The same facts read from EVERY entry, declared ones included — present only
   * when some medical entry is merely declared. The checks run on the verified
   * facts; this is what tells "met on the owner's word" apart from "not met".
   */
  withDeclared?: LibretaFacts | null;
};

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Day number of a YYYY-MM-DD string. */
function dayOfIso(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

/** The Argentine calendar day of an instant (an event's occurredAt, `now`). */
export function dayOfInstant(value: Date | string): number {
  if (typeof value === "string" && DATE_ONLY.test(value)) return dayOfIso(value);
  return dayOfIso(isoDateInAr(new Date(value)));
}

/**
 * The day of a date-only value (travel date, CVI dates, birth date). A Date
 * built from "YYYY-MM-DD" sits at UTC midnight — its UTC date IS the day.
 */
export function dayOfDateOnly(value: Date | string): number | null {
  if (typeof value === "string") {
    if (DATE_ONLY.test(value)) return dayOfIso(value);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : dayOfIso(parsed.toISOString().slice(0, 10));
  }
  return Number.isNaN(value.getTime()) ? null : dayOfIso(value.toISOString().slice(0, 10));
}

/** A day number back to an es-AR date ("15 de agosto de 2026"). */
export function formatDay(day: number): string {
  return formatDate(new Date(day * DAY_MS).toISOString().slice(0, 10));
}

function fold(text: string): string {
  return normalizeText(text);
}

const RABIES = /antirrab|rabi/;
const TITER = /titul|anticuerp|favn|serolog|titer|titre/;

function payloadOf(e: TravelLibretaEvent): Record<string, unknown> {
  return (e.payload ?? {}) as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readCvi(events: readonly TravelLibretaEvent[]): LibretaFacts["latestCvi"] {
  let latest: LibretaFacts["latestCvi"] = null;
  for (const e of events) {
    const p = payloadOf(e);
    if (e.eventType !== "movement_recorded" || p.sub_kind !== "cvi_issued") continue;
    const issuedDay = dayOfDateOnly(str(p.issued_date));
    if (issuedDay === null) continue;
    const validUntilDay = p.valid_until ? dayOfDateOnly(str(p.valid_until)) : null;
    if (!latest || issuedDay > latest.issuedDay) latest = { issuedDay, validUntilDay };
  }
  return latest;
}

function readWeight(events: readonly TravelLibretaEvent[]): number | null {
  const latest = events
    .filter((e) => e.eventType === "weight_recorded")
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())[0];
  if (!latest) return null;
  const kg = Number.parseFloat(str(payloadOf(latest).kg).replace(",", "."));
  return Number.isFinite(kg) ? kg : null;
}

function isTiterRecord(e: TravelLibretaEvent): boolean {
  const p = payloadOf(e);
  if (e.eventType !== "clinical_info_logged" || p.sub_kind !== "lab_work") return false;
  const text = fold(`${str(p.title)} ${str(p.details)}`);
  return TITER.test(text) && RABIES.test(text);
}

/**
 * Everything the travel checks read from the libreta. Medical facts come from
 * VERIFIED entries only; `withDeclared` re-reads them from every entry when
 * some are merely declared (QA 2026-10-07, bug 1: an owner's own entry closed
 * the requirement).
 */
export function readLibreta(events: readonly TravelLibretaEvent[]): LibretaFacts {
  const trusted = events.filter(
    (e) => !MEDICAL_EVENT_TYPES.has(e.eventType) || verifiesForTravel(e),
  );
  const facts = readFacts(trusted, events);
  const declaredExists = trusted.length < events.length;
  return { ...facts, withDeclared: declaredExists ? readFacts(events, events) : null };
}

/** The medical facts of `events`, plus the CVI and the weight from `all`. */
function readFacts(
  events: readonly TravelLibretaEvent[],
  all: readonly TravelLibretaEvent[],
): LibretaFacts {
  const asc = (xs: number[]) => xs.sort((a, b) => a - b);
  const vaccinations = events.filter((e) => e.eventType === "vaccination_administered");
  const vaccineNames = vaccinations.map((e) => fold(str(payloadOf(e).vaccine_name)));
  const replacements = events
    .filter((e) => e.eventType === "microchip_replaced")
    .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
  const lastReplacement = replacements[replacements.length - 1];
  return {
    rabiesDoses: asc(
      vaccinations
        .filter((e) => RABIES.test(fold(str(payloadOf(e).vaccine_name))))
        .map((e) => dayOfInstant(e.occurredAt)),
    ),
    chipImplants: events
      .filter((e) => e.eventType === "microchip_implanted")
      .map((e) => ({
        day: dayOfInstant(e.occurredAt),
        dateKnown: payloadOf(e).implant_date_known !== false,
      }))
      .sort((a, b) => a.day - b.day),
    chipReplaced: replacements.length > 0,
    chipRevoked: lastReplacement ? payloadOf(lastReplacement).new_chip_number === null : false,
    dewormings: events
      .filter((e) => e.eventType === "deworming_administered")
      .map((e) => ({
        day: dayOfInstant(e.occurredAt),
        type: payloadOf(e).type as DewormingType,
      }))
      .filter((d) => d.type === "internal" || d.type === "external" || d.type === "both"),
    latestCvi: readCvi(all),
    latestWeightKg: readWeight(all),
    titerTests: asc(events.filter(isTiterRecord).map((e) => dayOfInstant(e.occurredAt))),
    vaccineNames,
  };
}

/** What every evaluator may read. */
export type CheckContext = {
  today: number;
  travelDay: number | null;
  pet: TravelPetFacts | null;
  libreta: LibretaFacts;
  /**
   * The paper the destination asks for, as IT names it ("CZI"). Null when the
   * reading spans several destinations: then the generic "CVI".
   */
  paper?: { name: string; shortName: string } | null;
};

/** Short name of the trip's paper: "CZI", "CVI Mercosur", or "CVI". */
function paperShort(ctx: CheckContext): string {
  return ctx.paper?.shortName ?? "CVI";
}

/** What a lapsed deadline says next (QA 2026-10-07, copy 6). */
const NEXT_STEP_MOVE_DATE = "Consultá con tu veterinaria si conviene mover la fecha del viaje.";
const NEXT_STEP_NEW_PAPER =
  "Consultá con tu veterinaria si conviene un certificado nuevo o mover la fecha del viaje.";

const NO_TRAVEL_DATE: Evaluation = {
  tone: "neutral",
  deadlineLapsed: false,
  state: "Sin fecha de viaje",
  detail: null,
};

const REGISTERED = "Registrada en la libreta";

function withDetail(e: Evaluation, detail: string): Evaluation {
  return { ...e, detail };
}

function last(xs: readonly number[]): number | null {
  return xs.length > 0 ? xs[xs.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Rabies
// ---------------------------------------------------------------------------

export function evaluateRabiesWait(waitDays: number, ctx: CheckContext): Evaluation {
  const detail = `Mínimo ${waitDays} días entre la vacuna antirrábica y el viaje`;
  if (ctx.travelDay === null) return withDetail(NO_TRAVEL_DATE, detail);
  const dose = last(ctx.libreta.rabiesDoses);
  if (dose !== null) {
    if (dose + waitDays <= ctx.travelDay) {
      return { tone: "ok", deadlineLapsed: false, state: REGISTERED, detail };
    }
    return {
      tone: "over",
      deadlineLapsed: true,
      state: "La última dosis no llega a la espera antes del viaje",
      detail,
    };
  }
  // No dose on record: still reachable if vaccinating today leaves the wait.
  const lapsed = ctx.today > ctx.travelDay - waitDays;
  return {
    tone: "due",
    deadlineLapsed: lapsed,
    state: lapsed
      ? `Plazo vencido: aunque se vacune hoy, no llega a los ${waitDays} días antes del viaje. ${NEXT_STEP_MOVE_DATE}`
      : "Pendiente",
    detail,
  };
}

export function evaluateRabiesMaxAge(maxDays: number, ctx: CheckContext): Evaluation {
  const detail = `La última antirrábica puede tener como máximo ${maxDays} días al viajar`;
  if (ctx.travelDay === null) return withDetail(NO_TRAVEL_DATE, detail);
  const dose = last(ctx.libreta.rabiesDoses);
  if (dose === null) {
    return { tone: "due", deadlineLapsed: false, state: "Sin antirrábica registrada", detail };
  }
  if (ctx.travelDay - dose > maxDays) {
    return {
      tone: "due",
      deadlineLapsed: false,
      state: "La última dosis es anterior a lo que se acepta: consultá a tu veterinario",
      detail,
    };
  }
  return { tone: "ok", deadlineLapsed: false, state: REGISTERED, detail };
}

function birthDay(ctx: CheckContext): number | null {
  return ctx.pet?.dateOfBirth ? dayOfDateOnly(ctx.pet.dateOfBirth) : null;
}

const NO_BIRTH_DATE: Evaluation = {
  tone: "neutral",
  deadlineLapsed: false,
  state: "Sin fecha de nacimiento en la libreta",
  detail: null,
};

const ESTIMATED_BIRTH: Evaluation = {
  tone: "neutral",
  deadlineLapsed: false,
  state: "Fecha de nacimiento estimada: verificá la edad con tu veterinario",
  detail: null,
};

export function evaluateRabiesMinAge(minAgeDays: number, ctx: CheckContext): Evaluation {
  const detail = `Edad mínima de ${minAgeDays} días al recibir la vacuna antirrábica`;
  const born = birthDay(ctx);
  if (born === null) return withDetail(NO_BIRTH_DATE, detail);
  const dose = last(ctx.libreta.rabiesDoses);
  if (dose === null) {
    return { tone: "neutral", deadlineLapsed: false, state: "Sin antirrábica registrada", detail };
  }
  if (dose - born < minAgeDays) {
    return {
      tone: "over",
      deadlineLapsed: true,
      state: "La antirrábica se aplicó antes de la edad mínima: hay que revacunar",
      detail,
    };
  }
  if (ctx.pet?.birthDateIsEstimated) return withDetail(ESTIMATED_BIRTH, detail);
  return { tone: "ok", deadlineLapsed: false, state: REGISTERED, detail };
}

// ---------------------------------------------------------------------------
// Animal age on the travel date
// ---------------------------------------------------------------------------

export function evaluateMinAnimalAge(minAgeDays: number, ctx: CheckContext): Evaluation {
  const detail = `Edad mínima del animal el día del viaje: ${minAgeDays} días`;
  const born = birthDay(ctx);
  if (born === null) return withDetail(NO_BIRTH_DATE, detail);
  if (ctx.travelDay === null) return withDetail(NO_TRAVEL_DATE, detail);
  const ageAtTravel = ctx.travelDay - born;
  if (ageAtTravel < minAgeDays) {
    return {
      tone: "over",
      deadlineLapsed: true,
      state: `No alcanza la edad mínima: el día del viaje va a tener ${ageAtTravel} días`,
      detail,
    };
  }
  if (ctx.pet?.birthDateIsEstimated) return withDetail(ESTIMATED_BIRTH, detail);
  return { tone: "ok", deadlineLapsed: false, state: REGISTERED, detail };
}

// ---------------------------------------------------------------------------
// Microchip
// ---------------------------------------------------------------------------

export function evaluateMicrochipRequired(ctx: CheckContext, acceptsTattoo = false): Evaluation {
  const detail = acceptsTattoo
    ? "Microchip ISO 11784/11785 o tatuaje obligatorio; lo registra tu veterinaria"
    : "Microchip ISO 11784/11785 obligatorio; lo registra tu veterinaria";
  const { chipImplants, chipRevoked } = ctx.libreta;
  if (chipImplants.length === 0 || chipRevoked) {
    return { tone: "due", deadlineLapsed: false, state: "Sin microchip registrado", detail };
  }
  return { tone: "ok", deadlineLapsed: false, state: "Registrado en la libreta", detail };
}

/**
 * The first implant against the latest rabies dose (design D3): a dose that
 * precedes the chip does not count for destinations that demand the order.
 */
export function evaluateMicrochipBeforeRabies(ctx: CheckContext): Evaluation {
  const detail = "El microchip tiene que implantarse antes de la vacuna antirrábica";
  const [firstChip] = ctx.libreta.chipImplants;
  const dose = last(ctx.libreta.rabiesDoses);
  if (!firstChip) {
    return { tone: "due", deadlineLapsed: false, state: "Sin microchip registrado", detail };
  }
  if (dose === null) {
    return { tone: "due", deadlineLapsed: false, state: "Sin antirrábica registrada", detail };
  }
  if (dose < firstChip.day) {
    return {
      tone: "over",
      deadlineLapsed: true,
      state: "La antirrábica es anterior al microchip: hay que revacunar",
      detail,
    };
  }
  if (!firstChip.dateKnown) {
    return {
      tone: "neutral",
      deadlineLapsed: false,
      state:
        "La fecha de implante del microchip no se conoce: verificá el orden con tu veterinario",
      detail,
    };
  }
  if (ctx.libreta.chipReplaced) {
    return {
      tone: "neutral",
      deadlineLapsed: false,
      state: "El microchip fue reemplazado: verificá el orden con tu veterinario",
      detail,
    };
  }
  return {
    tone: "ok",
    deadlineLapsed: false,
    state: "Registrada en la libreta: microchip antes de la antirrábica",
    detail,
  };
}

// ---------------------------------------------------------------------------
// Deworming window (Chile 5–30 before the CZI, Brasil/Uruguay ≤15 before the CVI)
// ---------------------------------------------------------------------------

function dewormingDetail(ceiling: number | null, floor: number | null, paper: string): string {
  const what = "Antiparasitario interno y externo";
  if (ceiling !== null && floor !== null) {
    return `${what} entre ${floor} y ${ceiling} días antes del ${paper}`;
  }
  if (ceiling !== null) return `${what} hasta ${ceiling} días antes del ${paper}`;
  return `${what} al menos ${floor} días antes del ${paper}`;
}

function covers(doses: readonly { type: DewormingType }[]): {
  internal: boolean;
  external: boolean;
} {
  return {
    internal: doses.some((d) => d.type === "internal" || d.type === "both"),
    external: doses.some((d) => d.type === "external" || d.type === "both"),
  };
}

function missingCoverageState(coverage: { internal: boolean; external: boolean }): string {
  if (coverage.internal) return "Falta el antiparasitario externo dentro de la ventana";
  if (coverage.external) return "Falta el antiparasitario interno dentro de la ventana";
  return "Sin antiparasitario registrado dentro de la ventana";
}

/**
 * Both internal and external coverage inside the window before the CVI (a
 * `both` dose, or one of each). Anchored on the CVI's issue date when one is
 * recorded; otherwise on the travel date, and then never better than amber —
 * the real anchor is a date that does not exist yet.
 */
export function evaluateDeworming(
  ceiling: number | null,
  floor: number | null,
  ctx: CheckContext,
): Evaluation {
  const paper = paperShort(ctx);
  const detail = dewormingDetail(ceiling, floor, paper);
  const cvi = ctx.libreta.latestCvi;
  const anchor = cvi?.issuedDay ?? ctx.travelDay;
  if (anchor === null) return withDetail(NO_TRAVEL_DATE, detail);
  const earliest = ceiling === null ? Number.NEGATIVE_INFINITY : anchor - ceiling;
  const latest = anchor - (floor ?? 0);
  const inWindow = ctx.libreta.dewormings.filter((d) => d.day >= earliest && d.day <= latest);
  const coverage = covers(inWindow);

  if (coverage.internal && coverage.external) {
    if (cvi) {
      return { tone: "ok", deadlineLapsed: false, state: "Registrado en la libreta", detail };
    }
    return {
      tone: "neutral",
      deadlineLapsed: false,
      state: `Registrado en la libreta; la ventana se confirma con la fecha del ${paper}`,
      detail,
    };
  }
  if (cvi) {
    return {
      tone: "over",
      deadlineLapsed: true,
      state: `${missingCoverageState(coverage)} antes del ${paper} del ${formatDay(cvi.issuedDay)}. ${NEXT_STEP_NEW_PAPER}`,
      detail,
    };
  }
  const lapsed = ctx.today > latest;
  return {
    tone: "due",
    deadlineLapsed: lapsed,
    state: lapsed
      ? `Plazo vencido: ya no entra en la ventana antes del viaje. ${NEXT_STEP_MOVE_DATE}`
      : missingCoverageState(coverage),
    detail,
  };
}

// ---------------------------------------------------------------------------
// Document windows
// ---------------------------------------------------------------------------

export const TRAVEL_DOCUMENT_LABELS: Record<TravelDocument, string> = {
  senasa_cvi: "Certificado Veterinario Internacional (CVI)",
  miasis_certificate: "Certificado Libre de Miasis",
  vet_health_certificate: "Certificado de salud veterinario",
  rabies_certificate: "Certificado de vacunación antirrábica",
  senasa_boarding_permit: "Permiso de embarque SENASA",
  airline_form: "Formulario de la aerolínea",
};

/**
 * The CVI's issue date must fall in [travel − window, travel], and a
 * `valid_until` before the trip blocks. Any other document cannot be read
 * from the libreta and stays a warning.
 */
export function evaluateDocumentWindow(
  windowDays: number,
  document: TravelDocument | null,
  ctx: CheckContext,
): Evaluation {
  const doc = document ?? "senasa_cvi";
  const isPaper = doc === "senasa_cvi";
  const name = isPaper && ctx.paper ? ctx.paper.name : TRAVEL_DOCUMENT_LABELS[doc];
  const detail = `Emitir el ${name} como máximo ${windowDays} días antes del viaje`;
  if (!isPaper) {
    return { tone: "neutral", deadlineLapsed: false, state: "A verificar", detail };
  }
  if (ctx.travelDay === null) return withDetail(NO_TRAVEL_DATE, detail);
  const paper = paperShort(ctx);
  const opens = ctx.travelDay - windowDays;
  const cvi = ctx.libreta.latestCvi;
  if (!cvi) {
    const lapsed = ctx.today > ctx.travelDay;
    // The range starts TODAY once it opened: a day already gone is not a day
    // anybody can still ask for (QA 2026-10-07, copy 6).
    const from = opens > ctx.today ? `desde el ${formatDay(opens)}` : "desde hoy";
    return {
      tone: "due",
      deadlineLapsed: lapsed,
      state: lapsed
        ? "Plazo vencido: la fecha del viaje ya pasó. Si el viaje cambió de fecha, cancelalo y creá uno con la fecha nueva."
        : `Pendiente: pedí el ${paper} ${from} y hasta el ${formatDay(ctx.travelDay)}`,
      detail,
    };
  }
  if (cvi.validUntilDay !== null && cvi.validUntilDay < ctx.travelDay) {
    return {
      tone: "over",
      deadlineLapsed: true,
      state: `El ${paper} vence antes del viaje. ${NEXT_STEP_NEW_PAPER}`,
      detail,
    };
  }
  if (cvi.issuedDay < opens) {
    return {
      tone: "over",
      deadlineLapsed: true,
      state: `El ${paper} se emitió antes de la ventana. ${NEXT_STEP_NEW_PAPER}`,
      detail,
    };
  }
  if (cvi.issuedDay > ctx.travelDay) {
    return {
      tone: "neutral",
      deadlineLapsed: false,
      state: `La fecha de emisión del ${paper} es posterior al viaje: revisala`,
      detail,
    };
  }
  return { tone: "ok", deadlineLapsed: false, state: "Registrado en la libreta", detail };
}

// ---------------------------------------------------------------------------
// Rabies antibody titre — where a destination demands it
// ---------------------------------------------------------------------------

/**
 * Only the RECORD of a titre can be read: the result lives in a lab report
 * the libreta does not parse. A recorded titre is therefore still a warning.
 */
export function evaluateTiterRequired(ctx: CheckContext): Evaluation {
  const detail = "Análisis de anticuerpos antirrábicos (titulación) en laboratorio autorizado";
  if (ctx.libreta.titerTests.length === 0) {
    return { tone: "due", deadlineLapsed: false, state: "Sin titulación registrada", detail };
  }
  return {
    tone: "neutral",
    deadlineLapsed: false,
    state: "Registrada en la libreta: verificá el resultado con el laboratorio",
    detail,
  };
}

export function evaluateTiterWait(waitDays: number, ctx: CheckContext): Evaluation {
  const detail = `Esperar ${waitDays} días desde la titulación antes de viajar`;
  const titer = last(ctx.libreta.titerTests);
  if (titer === null) {
    return { tone: "neutral", deadlineLapsed: false, state: "Sin titulación registrada", detail };
  }
  if (ctx.travelDay === null) return withDetail(NO_TRAVEL_DATE, detail);
  if (titer + waitDays > ctx.travelDay) {
    return {
      tone: "over",
      deadlineLapsed: true,
      state: "La titulación no llega a la espera antes del viaje",
      detail,
    };
  }
  return { tone: "ok", deadlineLapsed: false, state: REGISTERED, detail };
}

// ---------------------------------------------------------------------------
// Vaccines
// ---------------------------------------------------------------------------

function vaccineRecorded(required: string, names: readonly string[]): boolean {
  const wanted = fold(required);
  if (RABIES.test(wanted)) return names.some((n) => RABIES.test(n));
  return names.some((n) => n.includes(wanted));
}

export function evaluateRequiredVaccines(
  vaccines: readonly string[],
  ctx: CheckContext,
): Evaluation {
  const detail = vaccines.join(" · ");
  const missing = vaccines.filter((v) => !vaccineRecorded(v, ctx.libreta.vaccineNames));
  if (missing.length === 0) {
    return { tone: "ok", deadlineLapsed: false, state: "Registradas en la libreta", detail };
  }
  return {
    tone: "due",
    deadlineLapsed: false,
    state: `Falta registrar: ${missing.join(", ")}`,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Airline: weight, breed, embargoes
// ---------------------------------------------------------------------------

export const MODALITY_LABELS: Record<Modality, string> = {
  cabin: "cabina",
  hold: "bodega",
  cargo: "carga",
};

export function evaluateMaxWeight(
  maxKg: number,
  includesCarrier: boolean,
  airlineName: string,
  ctx: CheckContext,
): Evaluation {
  const detail = `Según lo publicado por ${airlineName}, peso máximo ${maxKg} kg${
    includesCarrier ? " con el bolso o canil" : ""
  }`;
  const kg = ctx.libreta.latestWeightKg;
  if (kg === null) {
    return { tone: "neutral", deadlineLapsed: false, state: "Sin peso registrado", detail };
  }
  if (kg > maxKg) {
    return {
      tone: "over",
      deadlineLapsed: true,
      state: `El último peso registrado (${kg} kg) supera el máximo`,
      detail,
    };
  }
  if (includesCarrier) {
    return {
      tone: "neutral",
      deadlineLapsed: false,
      state: `Último peso registrado: ${kg} kg. Sumale el bolso o canil`,
      detail,
    };
  }
  return { tone: "ok", deadlineLapsed: false, state: "Peso registrado dentro del máximo", detail };
}

function restrictionMatches(r: BreedRestriction, label: string, species: string): boolean {
  const list = r.breeds === "BRACHYCEPHALIC_LIST" ? brachycephalicBreedsFor(species) : r.breeds;
  return breedListIncludesResolved(list, label);
}

function restrictionEvaluation(
  r: BreedRestriction,
  label: string,
  airlineName: string,
  modality: Modality,
): Evaluation | null {
  const policy = `Según la política publicada por ${airlineName}`;
  const confirm = "Confirmalo con la aerolínea antes de reservar.";
  if (r.effect === "banned") {
    return {
      tone: "over",
      deadlineLapsed: true,
      state: `${policy}, el ${label} no viaja en ${MODALITY_LABELS[modality]}. ${confirm}`,
      detail: null,
    };
  }
  if (r.effect === "muzzle") {
    return {
      tone: "neutral",
      deadlineLapsed: false,
      state: `${policy}, el ${label} debe viajar con bozal. ${confirm}`,
      detail: null,
    };
  }
  if (modality !== "cabin") {
    return {
      tone: "over",
      deadlineLapsed: true,
      state: `${policy}, el ${label} solo viaja en cabina. ${confirm}`,
      detail: null,
    };
  }
  return null;
}

const EVALUATION_RANK: Record<ComplianceTone, number> = {
  over: 0,
  due: 1,
  neutral: 2,
  reserved: 3,
  ok: 4,
};

/**
 * The pet's breed against the airline's restrictions for the chosen
 * modality. Attributed and neutral (design D1): miMAR never labels a breed
 * "peligrosa" in its own voice. A breed that cannot be resolved to the
 * catalogue — or that is "Mixto / Cruza" — is amber: we could not confirm it.
 */
export function evaluateBreedRestrictions(
  restrictions: readonly BreedRestriction[],
  airlineName: string,
  modality: Modality,
  ctx: CheckContext,
): Evaluation {
  const detail = `Restricciones de raza publicadas por ${airlineName}`;
  const label = ctx.pet?.breed ? resolveBreedLabel(ctx.pet.breed) : null;
  if (!label || (SPECIAL_BREED_OPTIONS as readonly string[]).includes(label)) {
    return {
      tone: "neutral",
      deadlineLapsed: false,
      state: `No pudimos confirmar la raza con la lista de ${airlineName}`,
      detail,
    };
  }
  const species = ctx.pet?.species ?? "";
  const hits = restrictions
    .filter((r) => restrictionMatches(r, label, species))
    .map((r) => restrictionEvaluation(r, label, airlineName, modality))
    .filter((e): e is Evaluation => e !== null)
    .sort((a, b) => EVALUATION_RANK[a.tone] - EVALUATION_RANK[b.tone]);
  if (hits.length > 0) return { ...hits[0], detail };
  return {
    tone: "ok",
    deadlineLapsed: false,
    state: `La raza no figura en las restricciones publicadas por ${airlineName}`,
    detail,
  };
}

function mmdd(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(5, 10);
}

function inSeason(e: Embargo, day: number): boolean {
  if (e.kind !== "seasonal" || !e.from || !e.to) return false;
  const d = mmdd(day);
  return e.from <= e.to ? d >= e.from && d <= e.to : d >= e.from || d <= e.to;
}

export function evaluateEmbargoes(
  embargoes: readonly Embargo[],
  airlineName: string,
  ctx: CheckContext,
): Evaluation {
  const detail = embargoes.map((e) => e.note).join(" · ");
  const travelDay = ctx.travelDay;
  const hit = travelDay === null ? undefined : embargoes.find((e) => inSeason(e, travelDay));
  if (hit) {
    return {
      tone: "over",
      deadlineLapsed: true,
      state: `Según lo publicado por ${airlineName}, no lleva mascotas en la fecha del viaje`,
      detail,
    };
  }
  return {
    tone: "neutral",
    deadlineLapsed: false,
    state: `Restricciones publicadas por ${airlineName}`,
    detail,
    level: "info",
  };
}
