// ---------------------------------------------------------------------------
// Travel compliance projection (movilidad-jurisdiccional Fase 1)
//
// PURE derivation: (movement context, corridor reference data, pet events) ->
// travel obligations view. Sibling to deriveComplianceState — it does NOT
// modify or wrap the domestic 4-card logic (spec R2.1), and mirrors its
// "nothing is fetched, all inputs arrive resolved" contract (R2.7): the
// /viaje route loads events + corridors and passes them in.
//
// Union semantics (R2.2-R2.4): obligations are the UNION across the pet's
// origin and destination(s). Each rule type merges across contributing
// jurisdictions with its OWN strictness direction from STRICTNESS_DIRECTION
// (min | max | union) — never a single global "strictest wins".
//
// requirementLevel (R2.5-R2.6) exists ONLY on this projection's output. The
// domestic ObligationCard does NOT gain it in Fase 1 (R4.3).
// ---------------------------------------------------------------------------

import {
  type RequirementLevel,
  STRICTNESS_DIRECTION,
  type TravelRuleType,
} from "@/lib/domain/travel-strictness";
import type { ComplianceTone } from "@/lib/projections/pet-compliance";
import type { Corridor } from "@/lib/reference/cross-border-corridors";

export type TravelJurisdiction = {
  country: string;
  province?: string | null;
  locality?: string | null;
};

// Minimal event shape — decoupled from ProjectionEvent so tests stay trivial
// (same approach as ComplianceEvent in pet-compliance.ts).
export type TravelComplianceEvent = {
  eventType: string;
  payload: unknown;
  occurredAt: Date | string;
};

export type TravelComplianceInput = {
  now: Date;
  /** From pets.jurisdictionCountry/Province/Locality. */
  origin: TravelJurisdiction;
  /**
   * Destination jurisdictions resolved from jurisdiction_changed history
   * (multi-locality). In Fase 1 domestic jurisdictions contribute no travel
   * rule VALUES yet (the govt_business_rules promotion path is deferred,
   * design D4) — they are carried for disclosure and forward-compatibility.
   */
  destinations: TravelJurisdiction[];
  /** Corridors resolved from transport_recorded events. */
  corridors: Corridor[];
  /** Earliest upcoming travel date, when a trip is recorded. */
  travelDate: Date | null;
  /** The pet's events (vaccinations etc.) for satisfaction checks. */
  events: TravelComplianceEvent[];
};

/** ObligationCard shape (key/label/state/tone/detail/legalFootnote) + the two
 * travel-only fields (spec R2.5). */
export type TravelObligation = {
  key: TravelRuleType | "corridor_rules_pending" | "corridor_not_resolved";
  label: string;
  state: string;
  tone: ComplianceTone;
  detail: string | null;
  legalFootnote: string;
  requirementLevel: RequirementLevel;
  contributingJurisdictions: string[];
};

// "sin_datos" (R-honesty, QA histórico 2026-07-08 item 3): a foreign
// destination is recorded but no corridor could be resolved for it (no
// transport_recorded event, or only a stale one) — verde would assert
// "requisitos en orden" over zero checked obligations, which verifies
// nothing. Distinct from "amarillo" (obligations ARE known and pending
// review) — this state means we couldn't even look up the corridor.
export type TravelSemaforo = "rojo" | "amarillo" | "verde" | "sin_datos";

export type CorridorDisclosure = {
  id: Corridor["id"];
  label: string;
  version: string;
  effectiveFrom: string;
  sourceUrl: string;
};

export type TravelComplianceState = {
  /** Ordered worst-first (blocker → warning → info). */
  obligations: TravelObligation[];
  /** rojo = any blocker; amarillo = any warning, no blocker; verde otherwise. */
  semaforo: TravelSemaforo;
  /** Per-corridor version/effectiveFrom/sourceUrl for the R3.5 disclaimer. */
  corridorsShown: CorridorDisclosure[];
};

// ---------------------------------------------------------------------------
// Movement context extraction — movement_recorded payloads → aggregation
// inputs. Shared by the /viaje RSC and the travel export use-case so both
// surfaces derive the SAME context from the same events (invariant #3).
// ---------------------------------------------------------------------------

/** A transport stays part of the "current movement context" for 30 days
 * after its travel_date (R4.1: future or recent trips). */
export const RECENT_TRAVEL_WINDOW_MS = 30 * 86400000;

export type TravelContext = {
  destinations: TravelJurisdiction[];
  /** Unique corridor ids from non-stale transport_recorded events. */
  corridorIds: string[];
  /** Earliest relevant travel date — drives deadline evaluation. */
  travelDate: Date | null;
};

export function deriveTravelContext(
  movementPayloads: Array<Record<string, unknown>>,
  now: Date,
): TravelContext {
  const destinations: TravelJurisdiction[] = [];
  const corridorIds = new Set<string>();
  let travelDate: Date | null = null;

  for (const p of movementPayloads) {
    if (p.sub_kind === "jurisdiction_changed") {
      destinations.push({
        country: typeof p.to_country === "string" ? p.to_country : "AR",
        province: typeof p.to_province === "string" ? p.to_province : null,
        locality: typeof p.to_locality === "string" ? p.to_locality : null,
      });
    }
    if (p.sub_kind === "transport_recorded" && typeof p.travel_date === "string") {
      const date = new Date(p.travel_date);
      if (!Number.isFinite(date.getTime())) continue;
      if (date.getTime() < now.getTime() - RECENT_TRAVEL_WINDOW_MS) continue; // stale trip
      if (typeof p.corridor_id === "string") corridorIds.add(p.corridor_id);
      if (!travelDate || date < travelDate) travelDate = date;
    }
  }

  return { destinations, corridorIds: [...corridorIds], travelDate };
}

// ---------------------------------------------------------------------------
// requirementLevel mapping (R2.6) — derived purely from tone + deadline
// lapse, never hand-set per corridor.
// ---------------------------------------------------------------------------

export function requirementLevelFor(
  tone: ComplianceTone,
  deadlineLapsed: boolean,
): RequirementLevel {
  if (tone === "over") return "blocker";
  if (tone === "due") return deadlineLapsed ? "blocker" : "warning";
  if (tone === "ok") return "info";
  // neutral (no data yet) → missing data blocks confident travel, but is not
  // a hard fail. ("reserved" does not occur on travel obligations.)
  return "warning";
}

// ---------------------------------------------------------------------------
// es-AR labels per rule type
// ---------------------------------------------------------------------------

const RULE_LABELS: Record<TravelRuleType, string> = {
  document_issuance_window_days: "Certificado sanitario · ventana de emisión",
  rabies_vaccination_to_travel_wait_days: "Vacuna antirrábica · espera previa al viaje",
  rabies_titer_test_wait_days: "Titulación antirrábica · espera previa al viaje",
  quarantine_days_required: "Cuarentena al ingreso",
  rabies_vaccination_min_age_days: "Edad mínima de vacunación antirrábica",
  parasite_treatment_window_days: "Tratamiento antiparasitario · ventana previa",
  rabies_titer_test_required: "Titulación antirrábica (serología)",
  import_permit_required: "Permiso de importación",
  microchip_before_vaccination_required: "Microchip previo a la vacuna antirrábica",
  required_documents: "Documentación a presentar",
  required_vaccines: "Vacunas adicionales requeridas",
};

const LEVEL_SEVERITY: Record<RequirementLevel, number> = {
  blocker: 0,
  warning: 1,
  info: 2,
};

const ONE_DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type NumericContribution = { corridorLabel: string; value: number };
type BooleanContribution = { corridorLabel: string; value: boolean };
type SetContribution = { corridorLabel: string; value: readonly string[] };

function mergeNumeric(
  direction: "min" | "max",
  contributions: NumericContribution[],
): { value: number; contributors: string[] } {
  const values = contributions.map((c) => c.value);
  const merged = direction === "min" ? Math.min(...values) : Math.max(...values);
  return {
    value: merged,
    contributors: contributions.filter((c) => c.value === merged).map((c) => c.corridorLabel),
  };
}

function mergeBoolean(contributions: BooleanContribution[]): {
  value: boolean;
  contributors: string[];
} {
  return {
    value: contributions.some((c) => c.value),
    contributors: contributions.filter((c) => c.value).map((c) => c.corridorLabel),
  };
}

function mergeSet(contributions: SetContribution[]): { value: string[]; contributors: string[] } {
  const union = new Set<string>();
  const contributors: string[] = [];
  for (const c of contributions) {
    if (c.value.length === 0) continue;
    contributors.push(c.corridorLabel);
    for (const item of c.value) union.add(item);
  }
  return { value: [...union], contributors };
}

// The latest rabies vaccination event (by occurredAt), if any. Local copy of
// the pet-compliance matcher — that module's helper is deliberately private
// (R2.1: the domestic projection stays byte-for-byte untouched).
function latestRabiesDoseAt(events: TravelComplianceEvent[]): Date | null {
  const dose = events
    .filter((e) => {
      if (e.eventType !== "vaccination_administered") return false;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const name = typeof p.vaccine_name === "string" ? p.vaccine_name.toLowerCase() : "";
      return /antirr[aá]b|rabi/.test(name);
    })
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())[0];
  return dose ? new Date(dose.occurredAt) : null;
}

function footnoteFor(contributors: string[]): string {
  const scope = contributors.length > 0 ? contributors.join(" · ") : "corredores registrados";
  return `Regla del corredor de viaje · ${scope}`;
}

// ---------------------------------------------------------------------------
// Per-rule-type evaluation → tone + state + detail
// ---------------------------------------------------------------------------

type Evaluation = { tone: ComplianceTone; deadlineLapsed: boolean; state: string; detail: string };

function evaluateRabiesWait(waitDays: number, input: TravelComplianceInput): Evaluation {
  const doseAt = latestRabiesDoseAt(input.events);
  const base = `Mínimo ${waitDays} días entre la vacuna antirrábica y el viaje`;
  if (!input.travelDate) {
    return { tone: "neutral", deadlineLapsed: false, state: "Sin fecha de viaje", detail: base };
  }
  if (doseAt) {
    const readyAt = new Date(doseAt.getTime() + waitDays * ONE_DAY_MS);
    if (readyAt <= input.travelDate) {
      return { tone: "ok", deadlineLapsed: false, state: "Cumplida", detail: base };
    }
    // The recorded dose cannot satisfy the wait before the travel date.
    return { tone: "over", deadlineLapsed: true, state: "No llega a cumplirse", detail: base };
  }
  // No dose on record: still satisfiable if vaccinating today leaves enough
  // wait before the trip.
  const lastChance = new Date(input.travelDate.getTime() - waitDays * ONE_DAY_MS);
  const lapsed = input.now > lastChance;
  return {
    tone: "due",
    deadlineLapsed: lapsed,
    state: lapsed ? "Plazo vencido" : "Pendiente",
    detail: base,
  };
}

function evaluateInformationalDays(ruleType: TravelRuleType, value: number): Evaluation {
  const details: Partial<Record<TravelRuleType, string>> = {
    document_issuance_window_days: `Emitir el certificado como máximo ${value} días antes del viaje`,
    rabies_titer_test_wait_days: `Esperar ${value} días desde la titulación antes de viajar`,
    quarantine_days_required: `Prever ${value} días de cuarentena al ingreso`,
    rabies_vaccination_min_age_days: `Edad mínima de ${value} días al recibir la vacuna antirrábica`,
    parasite_treatment_window_days: `Aplicar el tratamiento como máximo ${value} días antes del viaje`,
  };
  return {
    tone: "neutral",
    deadlineLapsed: false,
    state: "A verificar",
    detail: details[ruleType] ?? `${value} días`,
  };
}

// ---------------------------------------------------------------------------
// Main derivation
// ---------------------------------------------------------------------------

export function deriveTravelCompliance(input: TravelComplianceInput): TravelComplianceState {
  const obligations: TravelObligation[] = [];

  const corridorsWithRules = input.corridors.filter((c) => Object.keys(c.rules).length > 0);
  const corridorsPending = input.corridors.filter((c) => Object.keys(c.rules).length === 0);

  // Collect contributions per rule type across all corridors touching the trip.
  const numericByType = new Map<TravelRuleType, NumericContribution[]>();
  const booleanByType = new Map<TravelRuleType, BooleanContribution[]>();
  const setByType = new Map<TravelRuleType, SetContribution[]>();

  for (const corridor of corridorsWithRules) {
    for (const [ruleTypeRaw, value] of Object.entries(corridor.rules)) {
      const ruleType = ruleTypeRaw as TravelRuleType;
      if (typeof value === "number") {
        const list = numericByType.get(ruleType) ?? [];
        list.push({ corridorLabel: corridor.label, value });
        numericByType.set(ruleType, list);
      } else if (typeof value === "boolean") {
        const list = booleanByType.get(ruleType) ?? [];
        list.push({ corridorLabel: corridor.label, value });
        booleanByType.set(ruleType, list);
      } else if (Array.isArray(value)) {
        const list = setByType.get(ruleType) ?? [];
        list.push({ corridorLabel: corridor.label, value });
        setByType.set(ruleType, list);
      }
    }
  }

  // Numeric rules — merged per direction (S5 min / S6 max).
  for (const [ruleType, contributions] of numericByType) {
    const direction = STRICTNESS_DIRECTION[ruleType];
    if (direction === "union") continue; // shape mismatch — union rules are not numeric
    const { value, contributors } = mergeNumeric(direction, contributions);
    const evaluation =
      ruleType === "rabies_vaccination_to_travel_wait_days"
        ? evaluateRabiesWait(value, input)
        : evaluateInformationalDays(ruleType, value);
    obligations.push({
      key: ruleType,
      label: RULE_LABELS[ruleType],
      state: evaluation.state,
      tone: evaluation.tone,
      detail: evaluation.detail,
      legalFootnote: footnoteFor(contributors),
      requirementLevel: requirementLevelFor(evaluation.tone, evaluation.deadlineLapsed),
      contributingJurisdictions: contributors,
    });
  }

  // Boolean union rules — required if ANY corridor requires it. A rule that
  // no corridor requires produces no obligation (nothing to comply with).
  for (const [ruleType, contributions] of booleanByType) {
    const { value, contributors } = mergeBoolean(contributions);
    if (!value) continue;
    obligations.push({
      key: ruleType,
      label: RULE_LABELS[ruleType],
      state: "Requerido",
      tone: "neutral",
      detail: null,
      legalFootnote: footnoteFor(contributors),
      requirementLevel: requirementLevelFor("neutral", false),
      contributingJurisdictions: contributors,
    });
  }

  // Set union rules — the traveler carries the union, never a subset (S7).
  for (const [ruleType, contributions] of setByType) {
    const { value, contributors } = mergeSet(contributions);
    if (value.length === 0) continue;
    obligations.push({
      key: ruleType,
      label: RULE_LABELS[ruleType],
      state: "A presentar",
      tone: "neutral",
      detail: value.join(" · "),
      legalFootnote: footnoteFor(contributors),
      requirementLevel: requirementLevelFor("neutral", false),
      contributingJurisdictions: contributors,
    });
  }

  // Citation-pending corridors: rule values have not been validated yet, so
  // the semáforo must NOT read verde off missing data — one explicit warning
  // covering every pending corridor.
  if (corridorsPending.length > 0) {
    const labels = corridorsPending.map((c) => c.label);
    obligations.push({
      key: "corridor_rules_pending",
      label: "Requisitos del corredor",
      state: "Pendiente de validación oficial",
      tone: "neutral",
      detail:
        "Los valores regulatorios de este corredor todavía no fueron validados con la fuente oficial.",
      legalFootnote: footnoteFor(labels),
      requirementLevel: requirementLevelFor("neutral", false),
      contributingJurisdictions: labels,
    });
  }

  // Corridor NOT resolved at all (R-honesty, QA histórico 2026-07-08 item 3):
  // a foreign destination is on record, but zero corridors were resolved for
  // it — no transport_recorded event carries a corridor_id, or the only one
  // is stale (>30 days, see RECENT_TRAVEL_WINDOW_MS). This is DIFFERENT from
  // corridorsPending above: that case means "we found the corridor, its
  // rules just aren't loaded yet"; this case means "we never even looked up
  // a corridor for this route". Neither should render verde. Display
  // honesty only — this does not invent a rule to check.
  const hasForeignDestination = input.destinations.some((d) => d.country !== "AR");
  const corridorNotResolved = hasForeignDestination && input.corridors.length === 0;
  if (corridorNotResolved) {
    obligations.push({
      key: "corridor_not_resolved",
      label: "Requisitos del corredor",
      state: "Verificación no disponible",
      tone: "neutral",
      detail:
        "Sin requisitos cargados para este corredor — no se pudo resolver un corredor para el destino informado. Registrá el transporte del viaje para intentar resolverlo.",
      legalFootnote: "Sin corredor resuelto para el destino informado.",
      requirementLevel: requirementLevelFor("neutral", false),
      contributingJurisdictions: [],
    });
  }

  obligations.sort(
    (a, b) => LEVEL_SEVERITY[a.requirementLevel] - LEVEL_SEVERITY[b.requirementLevel],
  );

  // "corridor_not_resolved" is deliberately excluded from the generic
  // warning bucket below — it must resolve to "sin_datos", not "amarillo"
  // (that state is reserved for obligations we DID resolve and that are
  // genuinely pending). Any OTHER blocker/warning still wins over sin_datos.
  const semaforo: TravelSemaforo = obligations.some((o) => o.requirementLevel === "blocker")
    ? "rojo"
    : obligations.some((o) => o.requirementLevel === "warning" && o.key !== "corridor_not_resolved")
      ? "amarillo"
      : corridorNotResolved
        ? "sin_datos"
        : "verde";

  return {
    obligations,
    semaforo,
    corridorsShown: input.corridors.map((c) => ({
      id: c.id,
      label: c.label,
      version: c.version,
      effectiveFrom: c.effectiveFrom,
      sourceUrl: c.sourceUrl,
    })),
  };
}
