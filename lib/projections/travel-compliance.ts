// ---------------------------------------------------------------------------
// Travel compliance projection (movilidad-jurisdiccional Fase 1; rule engine
// widened by viajes-fase-2 Phase 3, design D2/D3)
//
// PURE derivation: (trip context, corridor + airline reference data, pet facts,
// pet events) -> travel obligations view. Sibling to deriveComplianceState —
// it does NOT modify or wrap the domestic 4-card logic (spec R2.1), and
// mirrors its "nothing is fetched, all inputs arrive resolved" contract
// (R2.7).
//
// The pipeline:
//   1. corridor rules and, when an airline AND a modality are chosen, the
//      airline's rules become Contributions (lib/projections/travel-rule-merge);
//   2. they merge per (rule type, document) with each rule type's OWN
//      strictness direction — never a single global "strictest wins";
//   3. each merged rule is evaluated against the libreta
//      (lib/projections/travel-libreta-checks) — microchip before rabies,
//      animal age, deworming window, CVI window, titre — not just displayed;
//   4. an obligation any of whose sources is expired or unverified is
//      degraded (info → warning) and carries a "Verificá" notice. A blocker
//      is never lowered.
//
// Copy: the settled state reads "Registrada en la libreta" — the libreta
// records facts; SENASA and the airline decide. Nothing here promises.
//
// requirementLevel (R2.5-R2.6) exists ONLY on this projection's output. The
// domestic ObligationCard does NOT gain it (R4.3).
// ---------------------------------------------------------------------------

import type { SourceMeta } from "@/lib/domain/travel-freshness";
import type {
  Modality,
  RequirementLevel,
  TravelRuleType,
  TravelSpecies,
} from "@/lib/domain/travel-strictness";
import type { ComplianceTone } from "@/lib/projections/pet-compliance";
import {
  type CheckContext,
  type Evaluation,
  MODALITY_LABELS,
  TRAVEL_DOCUMENT_LABELS,
  type TravelPetFacts,
  dayOfDateOnly,
  dayOfInstant,
  evaluateBreedRestrictions,
  evaluateDeworming,
  evaluateDocumentWindow,
  evaluateEmbargoes,
  evaluateMaxWeight,
  evaluateMicrochipBeforeRabies,
  evaluateMicrochipRequired,
  evaluateMinAnimalAge,
  evaluateRabiesMaxAge,
  evaluateRabiesMinAge,
  evaluateRabiesWait,
  evaluateRequiredVaccines,
  evaluateTiterRequired,
  evaluateTiterWait,
  readLibreta,
} from "@/lib/projections/travel-libreta-checks";
import {
  type MergedRule,
  type RuleSourceRef,
  airlineContributions,
  corridorContributions,
  degradeForFreshness,
  findRule,
  freshnessNotice,
  mergeContributions,
  sourceRef,
  worstFreshness,
} from "@/lib/projections/travel-rule-merge";
import type { Airline, AirlineModalityRule } from "@/lib/reference/airlines";
import type { Corridor } from "@/lib/reference/cross-border-corridors";
import { pluralizeEs, speciesLabelPlural } from "@/lib/utils/format";

export type { TravelPetFacts } from "@/lib/projections/travel-libreta-checks";
export type { RuleSourceRef } from "@/lib/projections/travel-rule-merge";

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
   * (multi-locality). Domestic jurisdictions contribute no travel rule VALUES
   * yet (the govt_business_rules promotion path is deferred, design D4) —
   * they are carried for disclosure and forward-compatibility.
   */
  destinations: TravelJurisdiction[];
  /** Corridors resolved from transport_recorded events. */
  corridors: Corridor[];
  /** Earliest upcoming travel date, when a trip is recorded. */
  travelDate: Date | null;
  /**
   * The pet's events the checks read: vaccinations, dewormings, microchip
   * implants/replacements, weights, lab work, and the CVI
   * (movement_recorded cvi_issued). Callers are titular-only (design D8).
   */
  events: TravelComplianceEvent[];
  /** Species, birth date and breed. Absent → those checks read amber. */
  pet?: TravelPetFacts | null;
  /** The airline the owner chose for the trip, if any. */
  airline?: Airline | null;
  /** How the pet flies. A selector: without it no airline row contributes. */
  modality?: Modality | null;
};

export type TravelObligationKey =
  | TravelRuleType
  | "corridor_rules_pending"
  | "corridor_not_resolved"
  | "modality_not_selected"
  | "airline_modality"
  | "airline_species"
  | "incompatible_windows";

/** Where the obligation is listed on /viaje (design D5). */
export type TravelObligationGroup = "destino" | "aerolinea" | "libreta";

/** ObligationCard shape (key/label/state/tone/detail/legalFootnote) + the
 * travel-only fields (spec R2.5, design D2). */
export type TravelObligation = {
  /** Unique per obligation: two document windows share a key, never an id. */
  id: string;
  key: TravelObligationKey;
  group: TravelObligationGroup;
  label: string;
  state: string;
  tone: ComplianceTone;
  detail: string | null;
  legalFootnote: string;
  requirementLevel: RequirementLevel;
  /** The corridors/airlines whose value binds. */
  contributingJurisdictions: string[];
  /** Every source behind the obligation, with its freshness. */
  sources: RuleSourceRef[];
  /** "Verificá — …" when any source is expired or unverified; else null. */
  freshnessNotice: string | null;
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
  required_vaccines: "Vacunas requeridas",
  min_animal_age_days: "Edad mínima del animal para viajar",
  parasite_treatment_min_days_before: "Tratamiento antiparasitario · ventana previa",
  rabies_vaccination_max_days_before_travel: "Vacuna antirrábica · antigüedad máxima",
  microchip_required: "Microchip",
  max_weight_kg: "Peso máximo",
  breed_restrictions: "Restricciones de raza",
  embargoes: "Restricciones de temporada o ruta",
  booking_lead_hours: "Reserva anticipada",
};

/** Rule types answered by reading the pet's own events (group "libreta"). */
const LIBRETA_CHECKED = new Set<TravelRuleType>([
  "rabies_vaccination_to_travel_wait_days",
  "rabies_titer_test_wait_days",
  "rabies_vaccination_min_age_days",
  "parasite_treatment_window_days",
  "parasite_treatment_min_days_before",
  "rabies_titer_test_required",
  "microchip_before_vaccination_required",
  "required_vaccines",
  "min_animal_age_days",
  "rabies_vaccination_max_days_before_travel",
  "microchip_required",
]);

const LEVEL_SEVERITY: Record<RequirementLevel, number> = {
  blocker: 0,
  warning: 1,
  info: 2,
};

// ---------------------------------------------------------------------------
// Evaluators per rule type — the map is total, so a new rule type without an
// evaluator fails typecheck. Null = no obligation (a flag nobody demands, or a
// rule another obligation already covers).
// ---------------------------------------------------------------------------

type EvalEnv = { ctx: CheckContext; rules: readonly MergedRule[]; modality: Modality | null };
type Evaluator = (rule: MergedRule, env: EvalEnv) => Evaluation | null;

function num(rule: MergedRule): number {
  return rule.value as number;
}

function flag(rule: MergedRule): boolean {
  return rule.value === true;
}

function list<T>(rule: MergedRule): readonly T[] {
  return rule.value as readonly T[];
}

function informational(state: string, detail: string | null): Evaluation {
  return { tone: "neutral", deadlineLapsed: false, state, detail };
}

function airlineNameOf(rule: MergedRule): string {
  return rule.binding.find((s) => s.kind === "airline")?.label ?? "la aerolínea";
}

const EVALUATORS: Record<TravelRuleType, Evaluator> = {
  document_issuance_window_days: (r, { ctx }) => evaluateDocumentWindow(num(r), r.document, ctx),
  rabies_vaccination_to_travel_wait_days: (r, { ctx }) => evaluateRabiesWait(num(r), ctx),
  rabies_titer_test_wait_days: (r, { ctx }) => evaluateTiterWait(num(r), ctx),
  quarantine_days_required: (r) =>
    informational("A verificar", `Prever ${num(r)} días de cuarentena al ingreso`),
  rabies_vaccination_min_age_days: (r, { ctx }) => evaluateRabiesMinAge(num(r), ctx),
  parasite_treatment_window_days: (r, { ctx, rules }) =>
    evaluateDeworming(
      num(r),
      findRule(rules, "parasite_treatment_min_days_before")?.value ?? null,
      ctx,
    ),
  // The floor is evaluated WITH the ceiling when there is one.
  parasite_treatment_min_days_before: (r, { ctx, rules }) =>
    findRule(rules, "parasite_treatment_window_days") ? null : evaluateDeworming(null, num(r), ctx),
  rabies_titer_test_required: (r, { ctx }) => (flag(r) ? evaluateTiterRequired(ctx) : null),
  import_permit_required: (r) =>
    flag(r)
      ? informational(
          "Requerido: verificá con la autoridad del destino",
          "Permiso de importación del país de destino",
        )
      : null,
  microchip_before_vaccination_required: (r, { ctx }) =>
    flag(r) ? evaluateMicrochipBeforeRabies(ctx) : null,
  // A checklist of papers is information by design (design D3) — otherwise
  // green could never be reached; freshness can still raise it to a warning.
  required_documents: (r) =>
    list<string>(r).length > 0
      ? { ...informational("Llevá esta documentación", list<string>(r).join(" · ")), level: "info" }
      : null,
  required_vaccines: (r, { ctx }) =>
    list<string>(r).length > 0 ? evaluateRequiredVaccines(list<string>(r), ctx) : null,
  min_animal_age_days: (r, { ctx }) => evaluateMinAnimalAge(num(r), ctx),
  rabies_vaccination_max_days_before_travel: (r, { ctx }) => evaluateRabiesMaxAge(num(r), ctx),
  microchip_required: (r, { ctx }) => (flag(r) ? evaluateMicrochipRequired(ctx) : null),
  max_weight_kg: (r, { ctx }) =>
    evaluateMaxWeight(num(r), r.includesCarrier, airlineNameOf(r), ctx),
  breed_restrictions: (r, { ctx, modality }) =>
    modality ? evaluateBreedRestrictions(list(r), airlineNameOf(r), modality, ctx) : null,
  embargoes: (r, { ctx }) => evaluateEmbargoes(list(r), airlineNameOf(r), ctx),
  booking_lead_hours: (r) => ({
    ...informational(
      "A tener en cuenta",
      `Reservá el lugar de la mascota con al menos ${num(r)} ${pluralizeEs(num(r), "hora")} de anticipación`,
    ),
    level: "info",
  }),
};

// ---------------------------------------------------------------------------
// Obligation building
// ---------------------------------------------------------------------------

function uniqueSources(sources: readonly RuleSourceRef[]): RuleSourceRef[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const key = `${s.kind}:${s.id}:${s.sourceUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueLabels(sources: readonly RuleSourceRef[]): string[] {
  return [...new Set(sources.map((s) => s.label))];
}

function footnoteFor(sources: readonly RuleSourceRef[]): string {
  const corridors = uniqueLabels(sources.filter((s) => s.kind === "corridor"));
  const airlines = uniqueLabels(sources.filter((s) => s.kind === "airline"));
  const parts: string[] = [];
  if (corridors.length > 0) parts.push(`Regla del corredor de viaje · ${corridors.join(" · ")}`);
  if (airlines.length > 0) {
    parts.push(`Política publicada por ${airlines.join(" · ")} — verificá con tu aerolínea`);
  }
  return parts.length > 0
    ? parts.join(" · ")
    : "Regla del corredor de viaje · corredores registrados";
}

function groupFor(rule: MergedRule, binding: readonly RuleSourceRef[]): TravelObligationGroup {
  if (LIBRETA_CHECKED.has(rule.ruleType)) return "libreta";
  if (rule.ruleType === "document_issuance_window_days" && rule.document === "senasa_cvi") {
    return "libreta";
  }
  return binding.length > 0 && binding.every((s) => s.kind === "airline") ? "aerolinea" : "destino";
}

function labelFor(rule: MergedRule): string {
  if (rule.ruleType === "document_issuance_window_days" && rule.document) {
    return `${TRAVEL_DOCUMENT_LABELS[rule.document]} · ventana de emisión`;
  }
  return RULE_LABELS[rule.ruleType];
}

/**
 * The floor and the ceiling of the deworming window are ONE obligation; the
 * ceiling's obligation also carries the floor's sources.
 */
function companionsOf(rule: MergedRule, rules: readonly MergedRule[]): MergedRule[] {
  if (rule.ruleType !== "parasite_treatment_window_days") return [];
  const floor = findRule(rules, "parasite_treatment_min_days_before");
  return floor ? [floor] : [];
}

function ruleObligation(
  rule: MergedRule,
  evaluation: Evaluation,
  companions: readonly MergedRule[],
): TravelObligation {
  const binding = uniqueSources([...rule.binding, ...companions.flatMap((c) => c.binding)]);
  const all = uniqueSources([...rule.all, ...companions.flatMap((c) => c.all)]);
  const base = evaluation.level ?? requirementLevelFor(evaluation.tone, evaluation.deadlineLapsed);
  return {
    id: rule.document ? `${rule.ruleType}:${rule.document}` : rule.ruleType,
    key: rule.ruleType,
    group: groupFor(rule, binding),
    label: labelFor(rule),
    state: evaluation.state,
    tone: evaluation.tone,
    detail: evaluation.detail,
    legalFootnote: footnoteFor(binding),
    requirementLevel: degradeForFreshness(base, worstFreshness(all)),
    contributingJurisdictions: uniqueLabels(binding),
    sources: all,
    freshnessNotice: freshnessNotice(all),
  };
}

/** A floor above its ceiling can never be met: a blocker, never a guess. */
function incompatibleWindows(rules: readonly MergedRule[]): {
  obligations: TravelObligation[];
  skip: Set<TravelRuleType>;
} {
  const pairs: [TravelRuleType, TravelRuleType, string][] = [
    [
      "parasite_treatment_min_days_before",
      "parasite_treatment_window_days",
      "Las fuentes piden el antiparasitario en ventanas que no se superponen",
    ],
    [
      "rabies_vaccination_to_travel_wait_days",
      "rabies_vaccination_max_days_before_travel",
      "Las fuentes piden una antirrábica más vieja y más nueva a la vez",
    ],
  ];
  const obligations: TravelObligation[] = [];
  const skip = new Set<TravelRuleType>();
  for (const [floorType, ceilingType, detail] of pairs) {
    const floor = findRule(rules, floorType);
    const ceiling = findRule(rules, ceilingType);
    if (!floor || !ceiling || num(floor) <= num(ceiling)) continue;
    skip.add(floorType);
    skip.add(ceilingType);
    const obligation = ruleObligation(
      ceiling,
      { tone: "over", deadlineLapsed: true, state: "Ventanas incompatibles", detail },
      [floor],
    );
    obligations.push({
      ...obligation,
      id: `incompatible_windows:${ceilingType}`,
      key: "incompatible_windows",
    });
  }
  return { obligations, skip };
}

function ruleObligations(rules: readonly MergedRule[], env: EvalEnv): TravelObligation[] {
  const { obligations, skip } = incompatibleWindows(rules);
  for (const rule of rules) {
    if (skip.has(rule.ruleType)) continue;
    const evaluation = EVALUATORS[rule.ruleType](rule, env);
    if (!evaluation) continue;
    obligations.push(ruleObligation(rule, evaluation, companionsOf(rule, rules)));
  }
  return obligations;
}

// ---------------------------------------------------------------------------
// Airline gates — facts about the airline row itself, not rule types
// ---------------------------------------------------------------------------

function airlineObligation(
  airline: Airline,
  key: TravelObligationKey,
  evaluation: Evaluation,
  meta: SourceMeta,
  now: Date,
): TravelObligation {
  const source = sourceRef("airline", airline.id, airline.name, meta, now);
  const base = requirementLevelFor(evaluation.tone, evaluation.deadlineLapsed);
  return {
    id: key,
    key,
    group: "aerolinea",
    label: `Aerolínea · ${airline.name}`,
    state: evaluation.state,
    tone: evaluation.tone,
    detail: evaluation.detail,
    legalFootnote: footnoteFor([source]),
    requirementLevel: degradeForFreshness(base, source.freshness),
    contributingJurisdictions: [airline.name],
    sources: [source],
    freshnessNotice: freshnessNotice([source]),
  };
}

function airlineHeaderMeta(airline: Airline): SourceMeta {
  return {
    sourceUrl: airline.sourceUrl,
    lastVerifiedAt: airline.lastVerifiedAt,
    reviewBy: airline.reviewBy,
    verification: "verified",
  };
}

function modalityGate(airline: Airline, modality: Modality, now: Date): TravelObligation | null {
  const row: AirlineModalityRule | undefined = airline.modalities[modality];
  const where = MODALITY_LABELS[modality];
  if (!row) {
    return airlineObligation(
      airline,
      "airline_modality",
      informational(`Sin datos publicados por ${airline.name} para ${where}`, null),
      airlineHeaderMeta(airline),
      now,
    );
  }
  if (row.offered.value === "no") {
    return airlineObligation(
      airline,
      "airline_modality",
      {
        tone: "over",
        deadlineLapsed: true,
        state: `Según lo publicado por ${airline.name}, no lleva mascotas en ${where}`,
        detail: row.offered.note ?? null,
      },
      row.offered,
      now,
    );
  }
  if (row.offered.value === "restricted") {
    return airlineObligation(
      airline,
      "airline_modality",
      {
        tone: "neutral",
        deadlineLapsed: false,
        state: `Según lo publicado por ${airline.name}, lleva mascotas en ${where} con restricciones`,
        detail: row.offered.note ?? null,
      },
      row.offered,
      now,
    );
  }
  return null;
}

function speciesGate(
  airline: Airline,
  modality: Modality,
  species: string | null,
  now: Date,
): TravelObligation | null {
  const accepted = airline.modalities[modality]?.species;
  if (!accepted || !species) return null;
  if ((accepted.value as readonly string[]).includes(species)) return null;
  const who =
    species === "dog" || species === "cat"
      ? speciesLabelPlural(species).toLowerCase()
      : "esta especie";
  return airlineObligation(
    airline,
    "airline_species",
    {
      tone: "over",
      deadlineLapsed: true,
      state: `Según lo publicado por ${airline.name}, no lleva ${who} en ${MODALITY_LABELS[modality]}`,
      detail: null,
    },
    accepted,
    now,
  );
}

function airlineGates(
  airline: Airline,
  modality: Modality | null,
  species: string | null,
  now: Date,
): TravelObligation[] {
  if (!modality) {
    return [
      airlineObligation(
        airline,
        "modality_not_selected",
        {
          tone: "neutral",
          deadlineLapsed: false,
          state: "Elegí cabina, bodega o carga",
          detail: `Los requisitos de ${airline.name} dependen de cómo viaja la mascota`,
        },
        airlineHeaderMeta(airline),
        now,
      ),
    ];
  }
  return [
    modalityGate(airline, modality, now),
    speciesGate(airline, modality, species, now),
  ].filter((o): o is TravelObligation => o !== null);
}

// ---------------------------------------------------------------------------
// Main derivation
// ---------------------------------------------------------------------------

function travelSpecies(species: string | null | undefined): TravelSpecies | null {
  return species === "dog" || species === "cat" ? species : null;
}

function honestyObligation(
  key: "corridor_rules_pending" | "corridor_not_resolved",
  state: string,
  detail: string,
  legalFootnote: string,
  labels: string[],
): TravelObligation {
  return {
    id: key,
    key,
    group: "destino",
    label: "Requisitos del corredor",
    state,
    tone: "neutral",
    detail,
    legalFootnote,
    requirementLevel: requirementLevelFor("neutral", false),
    contributingJurisdictions: labels,
    sources: [],
    freshnessNotice: null,
  };
}

export function deriveTravelCompliance(input: TravelComplianceInput): TravelComplianceState {
  const { now } = input;
  const species = travelSpecies(input.pet?.species);
  const corridorsWithRules = input.corridors.filter((c) => Object.keys(c.rules).length > 0);
  const corridorsPending = input.corridors.filter((c) => Object.keys(c.rules).length === 0);
  const modality = input.airline ? (input.modality ?? null) : null;

  const contributions = corridorsWithRules.flatMap((c) => corridorContributions(c, species, now));
  if (input.airline && modality) {
    const corridorIds = input.corridors.map((c) => c.id);
    contributions.push(...airlineContributions(input.airline, modality, corridorIds, now));
  }
  const rules = mergeContributions(contributions);

  const ctx: CheckContext = {
    today: dayOfInstant(now),
    travelDay: input.travelDate ? dayOfDateOnly(input.travelDate) : null,
    pet: input.pet ?? null,
    libreta: readLibreta(input.events),
  };
  const obligations = ruleObligations(rules, { ctx, rules, modality });
  if (input.airline) {
    obligations.push(...airlineGates(input.airline, modality, input.pet?.species ?? null, now));
  }

  // Citation-pending corridors: rule values have not been validated yet, so
  // the semáforo must NOT read verde off missing data — one explicit warning
  // covering every pending corridor.
  if (corridorsPending.length > 0) {
    const labels = corridorsPending.map((c) => c.label);
    obligations.push(
      honestyObligation(
        "corridor_rules_pending",
        "Pendiente de validación oficial",
        "Los valores regulatorios de este corredor todavía no fueron validados con la fuente oficial.",
        `Regla del corredor de viaje · ${labels.join(" · ")}`,
        labels,
      ),
    );
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
    obligations.push(
      honestyObligation(
        "corridor_not_resolved",
        "Verificación no disponible",
        "Sin requisitos cargados para este corredor — no se pudo resolver un corredor para el destino informado. Registrá el transporte del viaje para intentar resolverlo.",
        "Sin corredor resuelto para el destino informado.",
        [],
      ),
    );
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
