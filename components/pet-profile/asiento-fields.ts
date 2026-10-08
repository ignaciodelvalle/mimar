// asiento-fields — projects a libreta past-event row into the rich "asiento"
// view model the back face renders ("Una sola libreta" redesign). Each asiento
// shows the FULL field set its event type carries — not a single curated line —
// with missing fields surfaced as faint "Sin dato" / "No adjunto" so the record
// reads like a real logbook entry.
//
// PRIVACY (H3): every value here is read from an explicit, whitelisted key set
// (per-type templates below) or, for untemplated types, from
// `eventPayloadDetails` — which is itself the curated es-AR whitelist. Internal
// ids, hashes, and matched_chip_number are NEVER read, so they can never reach
// the DOM (asserted end-to-end in LibretaFace.test.tsx).
//
// PROVENANCE GATE: the stamp is derived from the SAME confidence tier the
// compliance projection uses (computeConfidence) — "Verificado" only for a
// professional/institutional-verified event. A self-declared rabies vaccine
// additionally carries the amber "Falta verificación profesional" warning + a
// "Pedir verificación" action (the turno sheet), mirroring the front-face
// provenance nudge.
//
// WHO wrote it is a SEPARATE question from how trustworthy it is, and the
// projection must answer it from identity (`recorded_by_user_id` vs the
// reader), never from the author's role — see ownerDeclaredSubject.

import type { EventType } from "@/db/schema";
import { doseNextDue } from "@/lib/domain/libreta-health-status";
import {
  INTAKE_CONDITION_LABELS,
  INTAKE_HYDRATION_LABELS,
  INTAKE_MUCOUS_LABELS,
  VISIT_MODALITY_LABELS,
  labelOf,
} from "@/lib/domain/visit-labels";
import { computeConfidence } from "@/lib/events/event-confidence";
import { upcastPayload } from "@/lib/events/event-upcasters";
import {
  TRIP_PAPERS_TICK_TITLE,
  corridorDisplayLabel,
  eventPayloadDetails,
  eventPayloadSummary,
} from "@/lib/events/events";
import { isTripPapersAmendment } from "@/lib/infra/amendment";
import { isRabiesVaccineName } from "@/lib/reference/lookups";
import {
  AR_TIME_ZONE,
  calendarDaysAgoInAr,
  eventTypeLabel,
  isoDateInAr,
  pluralizeEs,
} from "@/lib/utils/format";
import type { HistorialEventRow } from "@/src/modules/pets/application/tab-data/types";

export type AsientoFact = {
  key: string;
  value: string;
  /** Rendered faint (missing / not-attached data). */
  missing?: boolean;
  /** Rendered in the mono face (codes, tokens). */
  mono?: boolean;
};

export type AsientoProvenance = {
  verified: boolean;
  label: string;
};

/**
 * WHO IS READING the libreta. Required (not optional) on every projection call:
 * the stamp says "vos" only when the reader is the recorded author, and an
 * optional parameter is a defect waiting to be re-introduced by the next caller
 * that forgets it.
 */
export type AsientoViewer = {
  /** The signed-in reader. */
  userId: string | null;
  /**
   * The pet's CURRENT titular (single active `role='owner'` ownership), or null
   * when the pet has none. Distinguishes "the titular before you" from "the
   * titular, who simply isn't you" (an org/vet viewer).
   */
  currentOwnerUserId: string | null;
};

export type AsientoView = {
  /** Mono uppercase eyebrow, e.g. "VACUNA · OBLIGATORIA". */
  kind: string;
  /** Serif record title, e.g. "Antirrábica". */
  title: string;
  /** Icon.tsx name. */
  icon: string;
  /** ln-ic-* tint class. */
  tint: string;
  /** Relative label, e.g. "hace 2 días". */
  whenRelative: string;
  /** Absolute date, e.g. "2 jul 2026". */
  whenAbsolute: string;
  facts: AsientoFact[];
  /** Handwritten note (Caveat) — rendered full-width. */
  handwrittenNote?: string;
  /** Weight rows show the trend as an inline sparkline. */
  showSparkline?: boolean;
  provenance: AsientoProvenance;
  /** Amber warning line in the foot. */
  warn?: string;
  /** When set, the foot shows this action instead of "Ver detalle". */
  verifyHref?: string;
  /** Corrected by a later amendment (append-only — a correction is a new asiento). */
  amended?: boolean;
  /** Its only amendments ticked the papers of a trip: not a correction. */
  papersUpdated?: boolean;
};

/** What a papers tick is called in the libreta (QA 2026-10-07, copy 8). */
export const TRIP_PAPERS_UPDATED_LABEL = TRIP_PAPERS_TICK_TITLE;

// ---------------------------------------------------------------------------
// Trip papers ticks — presentation-only grouping
// ---------------------------------------------------------------------------
//
// Ticking a trip's checklist ("Lo tengo") writes one `event_amended` per tick,
// so a person getting a trip's papers in order on one afternoon left five
// identical "Papeles del viaje actualizados" asientos in a row. The LOG IS
// UNTOUCHED — every tick stays its own append-only event and keeps its own
// detail page; what changes is that consecutive ticks of the SAME trip on the
// SAME Argentine day are DRAWN as one row: "Papeles del viaje actualizados ·
// 5 cambios · Chile". The app's libreta (apps/mobile/src/pets/
// libreta-view-model.ts) draws the same row from the same facts.

/** What the libreta knows about the trip a tick points at. */
export type TripPapersTrip = {
  /** es-AR destination, e.g. "Chile". */
  country: string | null;
  /** The trip's departure day, formatted like every other asiento date. */
  travelDate: string | null;
};

/** Trip event id → what the tick asientos print about it. */
export type TripPapersContext = ReadonlyMap<string, TripPapersTrip>;

/** The fact keys a tick carries, which the app groups on (no ids on the wire). */
export const TRIP_PAPERS_DESTINATION_KEY = "Destino";
export const TRIP_PAPERS_TRAVEL_DATE_KEY = "Fecha del viaje";

/** A plain YYYY-MM-DD is a calendar day: read at noon so no zone moves it. */
function calendarDay(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return isValidDate(date) ? date : null;
}

/**
 * The trips a libreta's rows describe, keyed by event id — read from the
 * `transport_recorded` movement rows already in the read (no extra query).
 */
export function tripPapersContext(rows: ReadonlyArray<HistorialEventRow>): TripPapersContext {
  const trips = new Map<string, TripPapersTrip>();
  for (const row of rows) {
    const trip = tripPapersTripOf(row);
    if (trip) trips.set(row.id, trip);
  }
  return trips;
}

/**
 * What a tick prints about ONE trip row, or null when the row is not a trip.
 * The libreta's context and the tick's own detail screen both read it, so a
 * tick says the same destination in the list and when it is opened.
 */
export function tripPapersTripOf(
  row: Pick<HistorialEventRow, "eventType" | "payload">,
): TripPapersTrip | null {
  if (row.eventType !== "movement_recorded") return null;
  const p = (upcastPayload(row.eventType as EventType, row.payload) ?? {}) as P;
  if (p.sub_kind !== "transport_recorded") return null;
  const corridor = str(p, "corridor_id");
  const day = calendarDay(p.travel_date);
  return {
    country: corridor ? corridorDisplayLabel(corridor) : null,
    travelDate: day ? formatAbsolute(day) : null,
  };
}

/**
 * The grouping key of a papers tick — its trip and its Argentine day — or null
 * for every other row. Two ticks group only when this is equal AND they are
 * adjacent in the timeline.
 *
 * A TICK WHOSE TRIP IS NOT IN THE READ NEVER GROUPS. A long libreta's capped
 * read can keep the ticks and lose the trip row; the app cannot tell such
 * ticks apart (no id crosses the wire, and the trip's facts are missing), so
 * both platforms take the same safe side and draw them one by one.
 */
export function tripPapersTickKey(
  row: Pick<HistorialEventRow, "eventType" | "payload" | "occurredAt">,
  trips: TripPapersContext,
): string | null {
  if (row.eventType !== "event_amended" || !isTripPapersAmendment(row.payload)) return null;
  const target = (row.payload as { target_event_id?: unknown } | null)?.target_event_id;
  const date = new Date(row.occurredAt);
  if (typeof target !== "string" || !trips.has(target) || !isValidDate(date)) return null;
  return `${target}|${isoDateInAr(date)}`;
}

/**
 * One tick's line inside a collapsed row, numbered in the order they happened
 * (the timeline is newest first, so the first entry is the last change).
 */
export function tripPapersTickLabel(indexNewestFirst: number, total: number): string {
  return `Cambio ${total - indexNewestFirst} de ${total}`;
}

/** "Papeles del viaje actualizados · 3 cambios · Chile". */
export function tripPapersGroupLabel(count: number, country: string | null): string {
  return [TRIP_PAPERS_UPDATED_LABEL, `${count} ${pluralizeEs(count, "cambio")}`, country]
    .filter(Boolean)
    .join(" · ");
}

export type TripPapersCollapsed<E> =
  | { kind: "single"; entry: E }
  | { kind: "papers"; entries: E[] };

/**
 * Collapse RUNS of adjacent entries that share a non-null key into one group;
 * everything else passes through in order. A run of one stays a single entry —
 * one tick is already one row.
 */
export function collapseTripPaperTicks<E>(
  entries: ReadonlyArray<E>,
  keyOf: (entry: E) => string | null,
): TripPapersCollapsed<E>[] {
  const out: TripPapersCollapsed<E>[] = [];
  let runKey: string | null = null;
  let run: E[] = [];
  const flush = () => {
    if (run.length === 1) out.push({ kind: "single", entry: run[0] as E });
    else if (run.length > 1) out.push({ kind: "papers", entries: run });
    run = [];
    runKey = null;
  };
  for (const entry of entries) {
    const key = keyOf(entry);
    if (key !== null && key === runKey) {
      run.push(entry);
      continue;
    }
    flush();
    if (key === null) out.push({ kind: "single", entry });
    else {
      runKey = key;
      run = [entry];
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function isValidDate(date: Date): boolean {
  return Number.isFinite(date.getTime());
}

function formatAbsolute(date: Date): string {
  if (!isValidDate(date)) return "sin fecha";
  // timeZone pinned — this projection feeds AsientoCard inside the client
  // LibretaFace, so it runs on both SSR and hydration. Without the pin a record
  // dated near midnight flips calendar day between renders → React #418.
  return date.toLocaleDateString("es-AR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: AR_TIME_ZONE,
  });
}

// Exported for focused purity tests: given a fixed `now`, the label is a pure
// function of (date, now) — the property the hydration-determinism fix relies
// on (LibretaFace threads a single mount-stable `now` into every call).
export function formatRelative(date: Date, now: Date): string {
  if (!isValidDate(date)) return "";
  // AR-calendar days, not elapsed-ms floor: an asiento from 20:00 yesterday
  // viewed at 10:00 today is "ayer", never "hoy" (calendarDaysAgoInAr).
  const days = calendarDaysAgoInAr(date, now);
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  if (days < 14) return "hace 1 semana";
  if (days < 30) return `hace ${Math.floor(days / 7)} sem.`;
  if (days < 60) return "hace 1 mes";
  if (days < 365) return `hace ${Math.floor(days / 30)} meses`;
  const years = Math.floor(days / 365);
  return years === 1 ? "hace 1 año" : `hace ${years} años`;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

// `citedProfessional` is an optional free-text professional the RECORD names
// (e.g. a vaccine's `administered_by` = "Dra. Paz — MP 4821"). It changes the
// wording but NEVER the tier: naming a vet is a CLAIM, only their signature is
// verification (#43 tiers are the source of truth). The two must read as
// unmistakably different (#45): "cité a mi vet" ≠ "mi vet firmó el asiento".

// WHOSE declaration an owner-declared asiento is, decided by IDENTITY rather
// than by role (transfer-provenance fix). The old code inferred "vos" from
// `authorRole === "owner"` alone, which is a statement about the author's
// RELATIONSHIP TO THE PET, not about who is reading — so after
// `transfer_custody` the incoming titular saw the outgoing titular's asientos
// signed "Cargado por vos". A libreta that reassigns authorship on every change
// of hands is not a ledger; the spine records `recorded_by_user_id` precisely so
// the projection never has to guess.
type OwnerDeclaredSubject = "you" | "holder" | "former_holder";

function ownerDeclaredSubject(row: HistorialEventRow, viewer: AsientoViewer): OwnerDeclaredSubject {
  const authorUserId = row.recordedByUserId;
  // No recorded author (legacy rows, pre-`recorded_by_user_id` writers): we
  // cannot PROVE the reader wrote it, so we never claim they did. "El titular"
  // is true of whoever declared it either way.
  if (!authorUserId) return "holder";
  if (viewer.userId && authorUserId === viewer.userId) return "you";
  // A pet has at most ONE active `role='owner'` ownership
  // (`ownerships_one_active_owner_per_pet`), so an owner-declared asiento whose
  // author is NOT the current titular was written by a PREVIOUS titular — the
  // transfer case, and the one a funcionario checks first.
  if (viewer.currentOwnerUserId && authorUserId !== viewer.currentOwnerUserId) {
    return "former_holder";
  }
  // Author IS the current titular, but the reader is someone else (an org/vet
  // viewer on the shared libreta). Still not "vos".
  return "holder";
}

function subjectPhrase(subject: OwnerDeclaredSubject): string {
  switch (subject) {
    case "you":
      return "vos";
    case "former_holder":
      return "el titular anterior";
    case "holder":
      return "el titular";
  }
}

function deriveProvenance(
  row: HistorialEventRow,
  viewer: AsientoViewer,
  citedProfessional?: string | null,
): AsientoProvenance {
  const tier = computeConfidence({
    authorRole: row.authorRole,
    authorVerified: row.authorVerified,
    authorOrganizationId: row.authorOrganizationId,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  });
  if (tier === "institutional_verified") {
    return { verified: true, label: "Verificado · Registro miMAR" };
  }
  if (tier === "professional_verified") {
    // The matriculated vet SIGNED the asiento — name them when the record cites
    // one, so "Verificado por Dra. Paz (MP 4821)" reads as real verification.
    return {
      verified: true,
      label: citedProfessional ? `Verificado por ${citedProfessional}` : "Verificado por vet",
    };
  }
  if (tier === "org_registered") {
    // A named organization recorded it, but no matriculated professional signed
    // (#43 VET keystone) — a valid record, NOT verification. WHO surfacing
    // (C5, 2026-07-21 facades harvest): name the org when the loader resolved
    // one (authorOrgName), instead of the generic "la organización" — the
    // operator ledger names the actor; the owner-facing stamp should too,
    // without exposing any individual staffer's personal name (org identity
    // is not PII the way a person's name would be).
    return {
      verified: false,
      label: row.authorOrgName
        ? `Registrado por ${row.authorOrgName}`
        : "Registrado por la organización",
    };
  }
  // A third-party scanner (anonymous QR scan — e.g. a lost-pet sighting
  // reported from the public /p page) is NEVER the owner. "Cargado por vos"
  // would misattribute a stranger's report to the titular (QA A4: a /p
  // sighting rendered "NOTA · CARGADO POR VOS" in the owner's own libreta).
  // `finder` is the same stranger with a name attached — it fell through to the
  // owner branch and inherited the same false stamp.
  if (row.authorRole === "scanner" || row.authorRole === "finder") {
    return { verified: false, label: "Reportado por un tercero" };
  }
  // Automated writes (cron closers, backfills). Nobody declared this.
  if (row.authorRole === "system") {
    return { verified: false, label: "Registrado automáticamente" };
  }
  // A professional/institutional role that cleared NO verification tier above
  // (an unverified vet, a govt actor without `authorVerified`). It is not an
  // owner declaration, so it must not borrow the titular's voice — but it is
  // not verification either.
  if (row.authorRole !== "owner") {
    return { verified: false, label: "Registrado sin verificar" };
  }
  // Owner-declared (self_reported / corroborated / unverified). WHO the "vos"
  // refers to is an identity question — see ownerDeclaredSubject.
  const subject = ownerDeclaredSubject(row, viewer);
  // When the owner NAMES a professional they only CITE (did not sign), say so
  // explicitly so a named vet never masquerades as verification (#45 QA §2).
  if (citedProfessional) {
    // Voseo only holds in the second person; a third-party subject conjugates.
    const verb = subject === "you" ? "citás" : "cita";
    return {
      verified: false,
      label: `Declarado por ${subjectPhrase(subject)} — ${verb} a ${citedProfessional}`,
    };
  }
  return { verified: false, label: `Cargado por ${subjectPhrase(subject)}` };
}

// ---------------------------------------------------------------------------
// Icon / tint per event type
// ---------------------------------------------------------------------------

const ICON_TINT: Record<string, { icon: string; tint: string }> = {
  vaccination_administered: { icon: "vacuna", tint: "ln-ic-warn" },
  deworming_administered: { icon: "medicacion", tint: "ln-ic-verde" },
  weight_recorded: { icon: "peso", tint: "ln-ic-azul" },
  sterilization_performed: { icon: "esterilizacion", tint: "ln-ic-rosa" },
  microchip_implanted: { icon: "microchip", tint: "ln-ic-azul" },
  microchip_replaced: { icon: "microchip-reemplazo", tint: "ln-ic-azul" },
  note_added: { icon: "nota", tint: "ln-ic-amarillo" },
  vet_visit_logged: { icon: "vet", tint: "ln-ic-azul" },
  clinical_info_logged: { icon: "clinico", tint: "ln-ic-violeta" },
  condition_at_intake_recorded: { icon: "vet", tint: "ln-ic-azul" },
  medication_started: { icon: "medicacion", tint: "ln-ic-violeta" },
  medication_stopped: { icon: "medicacion-fin", tint: "ln-ic-violeta" },
  medication_dose_taken: { icon: "medicacion", tint: "ln-ic-violeta" },
  death_recorded: { icon: "fallecimiento", tint: "ln-ic-gris" },
  dangerous_breed_attested: { icon: "shield", tint: "ln-ic-azul" },
  ownership_claimed: { icon: "credential", tint: "ln-ic-azul" },
  movement_recorded: { icon: "map-pin", tint: "ln-ic-azul" },
};

function iconTintFor(eventType: string): { icon: string; tint: string } {
  return ICON_TINT[eventType] ?? { icon: "nota", tint: "ln-ic-gris" };
}

// ---------------------------------------------------------------------------
// Value helpers over the upcasted, whitelisted payload
// ---------------------------------------------------------------------------

type P = Record<string, unknown>;

function str(p: P, key: string): string | null {
  const v = p[key];
  if (typeof v === "string" && v.trim().length > 0) return v;
  if (typeof v === "number") return String(v);
  return null;
}

function dateStr(p: P, key: string): string | null {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? formatAbsolute(d) : null;
}

/** A fact that shows the value or a faint placeholder when absent. */
function fact(
  key: string,
  value: string | null,
  placeholder: string,
  opts: { mono?: boolean } = {},
): AsientoFact {
  return value ? { key, value, mono: opts.mono } : { key, value: placeholder, missing: true };
}

// Rabies is recognised by THE shared matcher (isRabiesVaccineName, folded for
// accents and case) — one rule across every surface (surface audit 2026-10-07).

// ---------------------------------------------------------------------------
// "Aplicó" attribution fallback (staging validation 2026-07-04, bug 1)
// ---------------------------------------------------------------------------
//
// When a vaccine record does NOT name a professional (`administered_by` empty),
// the attribution must derive from the SIGNER, never default to "Declarado por
// el titular": a clinic-signed asiento previously showed the "Verificado por
// vet" stamp AND "Aplicó: Declarado por el titular" in the same card — a
// direct contradiction of the trust value prop. Role-based on purpose (not
// tier-based): the confirmed_by_lab tier bumper can lift an OWNER-declared
// dose to institutional_verified, and that record is still owner-declared for
// attribution purposes.
// Exported (2026-08-18): the shared-libreta vaccine ledger
// (LibretaSanitariaView) had grown its OWN signer fallback with different
// strings — the same event read "Profesional matriculado (firma verificada)"
// on one surface and "Vet. M.N. <matrícula>" on another, and an org-signed
// dose fell through to "—" there while the asiento named the organization.
// One attributor, every surface. The narrowed parameter type is exactly the
// fields the function reads, so callers without a full HistorialEventRow
// (the shared-libreta loader carries no matrícula/org name) can still use it
// and degrade to the generic branch strings.
export function applierAttribution(
  row: Pick<HistorialEventRow, "authorRole" | "authorVerified" | "authorOrganizationId"> &
    Partial<Pick<HistorialEventRow, "vetMatricula" | "authorOrgName">>,
  administeredBy: string | null,
): { value: string; missing: boolean } {
  if (administeredBy) return { value: administeredBy, missing: false };
  if (row.authorRole === "vet" && row.authorVerified) {
    if (row.vetMatricula) return { value: `Vet. M.N. ${row.vetMatricula}`, missing: false };
    return {
      value: row.authorOrgName
        ? `Vet. matriculado/a — ${row.authorOrgName}`
        : "Vet. matriculado/a (firma verificada)",
      missing: false,
    };
  }
  if ((row.authorRole === "shelter" || row.authorRole === "govt") && row.authorOrganizationId) {
    return { value: row.authorOrgName ?? "La organización", missing: false };
  }
  return { value: "Declarado por el titular", missing: true };
}

// ---------------------------------------------------------------------------
// Main projection
// ---------------------------------------------------------------------------

// `viewer` sits BEFORE the defaulted `now` on purpose: it has no safe default.
// A defaulted/optional viewer is how "Cargado por vos" became a claim nobody
// checked — every call site must state who is reading.
export function toAsientoView(
  row: HistorialEventRow,
  petPublicToken: string,
  viewer: AsientoViewer,
  now: Date = new Date(),
  // The trips the read holds (`tripPapersContext`), so a papers tick can say
  // which trip it ticked. Optional: without it a tick still renders, unnamed.
  trips: TripPapersContext = new Map(),
): AsientoView {
  const eventType = row.eventType;
  const p = (upcastPayload(eventType as EventType, row.payload) ?? {}) as P;
  const { icon, tint } = iconTintFor(eventType);
  const provenance = deriveProvenance(row, viewer);
  const aplicada = formatAbsolute(new Date(row.occurredAt));

  const base = {
    icon,
    tint,
    whenRelative: formatRelative(new Date(row.occurredAt), now),
    whenAbsolute: aplicada,
    provenance,
    amended: Boolean(row.amendedAt),
    papersUpdated: Boolean(row.papersUpdatedAt),
  };

  // A "Lo tengo" tick is the owner keeping a trip's checklist, not a
  // correction: it is named for what it is.
  if (eventType === "event_amended" && isTripPapersAmendment(row.payload)) {
    const target = (row.payload as { target_event_id?: unknown } | null)?.target_event_id;
    const trip = typeof target === "string" ? trips.get(target) : undefined;
    const facts: AsientoFact[] = [{ key: "Fecha", value: aplicada }];
    if (trip?.country) facts.push({ key: TRIP_PAPERS_DESTINATION_KEY, value: trip.country });
    if (trip?.travelDate) facts.push({ key: TRIP_PAPERS_TRAVEL_DATE_KEY, value: trip.travelDate });
    return {
      ...base,
      kind: "Viaje",
      title: TRIP_PAPERS_UPDATED_LABEL,
      facts,
    };
  }

  switch (eventType) {
    case "vaccination_administered": {
      const name = str(p, "vaccine_name");
      const isRabies = isRabiesVaccineName(name ?? "");
      const administeredBy = str(p, "administered_by");
      // Recompute provenance WITH the cited professional so a vaccine that names
      // "Dra. Paz — MP 4821" reads correctly: verified → "Verificado por Dra.
      // Paz…"; owner-declared → "Declarado por vos — citás a Dra. Paz…" (#45).
      const vaccineProvenance = deriveProvenance(row, viewer, administeredBy);
      // Signer-derived fallback — must never contradict the provenance stamp
      // (see applierAttribution docblock).
      const aplico = applierAttribution(row, administeredBy);
      // THE next-due derivation the libreta back reads (doseNextDue): a dose
      // with no written date shows the catalog-interval date as what it is — a
      // suggestion, "Refuerzo sugerido", the front's own words — instead of
      // "Vence: Sin dato" beside a back that said "Vigente" (QA v14 P2a).
      const due = doseNextDue(name, row.occurredAt, p);
      const facts: AsientoFact[] = [
        { key: "Aplicada", value: aplicada },
        fact(
          due.dueSource === "derived" ? "Refuerzo sugerido" : "Vence",
          due.nextDueAt ? formatAbsolute(due.nextDueAt) : null,
          "Sin dato",
        ),
        fact("Vía", str(p, "route"), "Sin dato"),
        {
          key: "Aplicó",
          value: aplico.value,
          missing: aplico.missing,
        },
        fact("Laboratorio", str(p, "brand"), "Sin dato"),
        fact("Lote", str(p, "batch"), "No adjunto"),
      ];
      const needsVerification = !vaccineProvenance.verified;
      return {
        ...base,
        provenance: vaccineProvenance,
        kind: isRabies ? "Vacuna · obligatoria" : "Vacuna",
        title: name ?? "Vacuna",
        facts,
        // When the owner cited a professional, the record is waiting on THAT
        // vet's confirmation — say so instead of the generic "falta
        // verificación", which read as if no vet was involved at all (#45).
        warn: needsVerification
          ? administeredBy
            ? "Pendiente de confirmación del profesional"
            : "Falta verificación profesional"
          : undefined,
        verifyHref:
          needsVerification && isRabies
            ? `/mis-mascotas/${petPublicToken}?sheet=turno-antirrabica`
            : undefined,
      };
    }

    case "deworming_administered": {
      const typeRaw = str(p, "type");
      const typeLabel =
        typeRaw === "internal"
          ? "interno"
          : typeRaw === "external"
            ? "externo"
            : typeRaw === "both"
              ? "interno + externo"
              : null;
      return {
        ...base,
        kind: typeLabel ? `Antiparasitario · ${typeLabel}` : "Antiparasitario",
        title: str(p, "product") ?? "Antiparasitario",
        facts: [
          // The route is INFERRED from the type (the payload has no route
          // field), so each type maps to its own label — the old else-branch
          // stamped "Oral" on a "both" product, contradicting the "interno +
          // externo" eyebrow one line above (9-role external run, 2026-08-18).
          // Unknown type → "Sin dato", never a guess.
          fact(
            "Vía",
            typeRaw === "external"
              ? "Externa"
              : typeRaw === "both"
                ? "Oral + externa"
                : typeRaw === "internal"
                  ? "Oral"
                  : null,
            "Sin dato",
          ),
          fact("Dosis", str(p, "dose"), "Sin dato"),
          { key: "Aplicada", value: aplicada },
          fact("Próxima dosis", dateStr(p, "next_due_at"), "Sin dato"),
        ],
      };
    }

    case "weight_recorded": {
      // The weight payload only carries `kg` (no method/context in the schema),
      // so the asiento shows the value (title) + the trend sparkline — no
      // phantom "Sin dato" rows for fields the event never had.
      const kg = str(p, "kg");
      return {
        ...base,
        kind: "Peso",
        title: kg ? `${kg} kg` : "Peso",
        showSparkline: true,
        facts: [],
      };
    }

    case "sterilization_performed": {
      const procedure = str(p, "procedure");
      const procedureLabel =
        procedure === "castration"
          ? "castración"
          : procedure === "spay"
            ? "ovariectomía"
            : procedure;
      return {
        ...base,
        kind: "Esterilización",
        title: procedureLabel ? `Esterilización · ${procedureLabel}` : "Esterilización",
        facts: [
          fact("Procedimiento", procedureLabel, "Sin dato"),
          { key: "Aplicada", value: aplicada },
          fact("Realizada por", str(p, "performed_by"), "Sin dato"),
          fact("Clínica", str(p, "clinic"), "Sin dato"),
        ],
      };
    }

    case "microchip_implanted": {
      return {
        ...base,
        kind: "Identificación · microchip",
        title: "Microchip",
        facts: [
          fact("Número", str(p, "chip_number"), "Sin dato", { mono: true }),
          { key: "Aplicada", value: aplicada },
          fact("Implantado por", str(p, "implanted_by"), "Sin dato"),
          fact("Ubicación", str(p, "location_on_body"), "Sin dato"),
        ],
      };
    }

    case "vet_visit_logged": {
      return {
        ...base,
        kind: "Visita veterinaria",
        title: str(p, "reason") ?? "Visita veterinaria",
        facts: [
          { key: "Fecha", value: aplicada },
          fact("Veterinario", str(p, "vet_name"), "Sin dato"),
          fact("Clínica", str(p, "clinic"), "Sin dato"),
          fact("Diagnóstico", str(p, "diagnosis"), "Sin dato"),
        ],
      };
    }

    case "condition_at_intake_recorded": {
      // vet-visit-record: how the animal arrived. Present-only vitals — a vet
      // who took no temperature did not record "sin dato", they recorded less.
      const vitals = (p.vitals ?? {}) as P;
      const optional = (key: string, value: string | null): AsientoFact[] =>
        value ? [{ key, value }] : [];
      const num = (key: string, unit: string): string | null => {
        const v = vitals[key];
        return typeof v === "number" ? `${String(v).replace(".", ",")}${unit}` : null;
      };
      const condition = labelOf(INTAKE_CONDITION_LABELS, p.general_condition);
      return {
        ...base,
        kind: "Estado al ingreso",
        title: condition ? `Estado general: ${condition}` : "Estado al ingreso",
        handwrittenNote: str(p, "findings") ?? undefined,
        facts: [
          { key: "Fecha", value: aplicada },
          fact("Motivo de consulta", str(p, "presenting_complaint"), "Sin dato"),
          ...optional("Modalidad", labelOf(VISIT_MODALITY_LABELS, p.modality)),
          ...optional("Temperatura", num("temperature_c", " °C")),
          ...optional("Frec. cardíaca", num("heart_rate_bpm", " lpm")),
          ...optional("Frec. respiratoria", num("respiratory_rate_rpm", " rpm")),
          ...optional("Condición corporal", num("body_condition_score", "/9")),
          ...optional("Hidratación", labelOf(INTAKE_HYDRATION_LABELS, vitals.hydration)),
          ...optional("Mucosas", labelOf(INTAKE_MUCOUS_LABELS, vitals.mucous_membranes)),
        ],
      };
    }

    case "note_added": {
      const text = str(p, "text");
      // A sighting is a THIRD-PARTY report (note_added, kind="sighting",
      // authorRole="scanner") loaded from the public /p page while the pet is
      // lost — not an owner note. It must read as such in the libreta timeline:
      // an "Avistaje" eyebrow + third-party provenance (deriveProvenance's
      // scanner branch), never "NOTA · CARGADO POR VOS" (QA A4).
      if (str(p, "kind") === "sighting") {
        const finderName = str(p, "finderName");
        return {
          ...base,
          icon: "map-pin",
          tint: "ln-ic-azul",
          kind: "Avistaje",
          title: finderName ? `Avistaje · ${finderName}` : "Avistaje de un tercero",
          handwrittenNote: text ?? undefined,
          facts: text ? [] : [{ key: "Reporte", value: "Sin descripción", missing: true }],
        };
      }
      return {
        ...base,
        kind: "Nota",
        title: str(p, "category")?.replace(/_/g, " ") ?? "Nota",
        handwrittenNote: text ?? undefined,
        facts: text ? [] : [{ key: "Anotación", value: "Sin texto", missing: true }],
      };
    }

    default: {
      // Fallback for every other type: reuse the curated (whitelisted)
      // key→value rows so the record still reads richly, with the summary as
      // the title. Present-only (no "Sin dato" placeholders) — the template
      // types above own the full-field-set treatment.
      const summary = eventPayloadSummary(eventType, row.payload);
      const details = eventPayloadDetails(eventType, row.payload);
      const facts: AsientoFact[] = [
        { key: "Fecha", value: aplicada },
        ...details.map((d) => ({ key: d.label, value: d.value })),
      ];
      return {
        ...base,
        kind: eventTypeLabel(eventType as EventType),
        title: summary.primary ?? eventTypeLabel(eventType as EventType),
        facts,
      };
    }
  }
}
