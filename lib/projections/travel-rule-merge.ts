// Corridor + airline rule merge (viajes-fase-2, design D2).
//
// PURE. A trip's obligations come from two kinds of source: the destination
// corridor(s) (lib/reference/cross-border-corridors.ts) and, when the owner
// names one, the airline and the modality it offers
// (lib/reference/airlines.ts). Both are normalised into `Contribution`s —
// one rule value plus WHERE it came from — then grouped by (rule type,
// document) and merged with the rule type's own STRICTNESS_DIRECTION.
//
// Two rules the merge never bends:
//   · every merged rule keeps the sources that bound it, so the UI can say
//     "Exigido por Iberia" or "Regla del corredor · Chile" and never a bare
//     number from nowhere;
//   · every merged rule carries the WORST freshness of any contributor in its
//     group. A value nobody confirmed, or confirmed too long ago, is never
//     presented as settled — see `freshnessNotice` and degradeForFreshness.
//
// Modality is a SELECTOR, not a rule: it picks which airline row contributes.
// Without one, no airline row contributes at all (the projection asks the
// owner to choose instead).

import {
  type Freshness,
  type SourceMeta,
  type Sourced,
  type Verification,
  freshnessOf,
} from "@/lib/domain/travel-freshness";
import {
  type Modality,
  type RequirementLevel,
  STRICTNESS_DIRECTION,
  type TravelDocument,
  type TravelRuleType,
  type TravelRuleValueByType,
  type TravelSpecies,
} from "@/lib/domain/travel-strictness";
import type { Airline, AirlineDocument, AirlineModalityRule } from "@/lib/reference/airlines";
import type { Corridor, CorridorId } from "@/lib/reference/cross-border-corridors";
import { formatDate } from "@/lib/utils/format";

/** Where one rule value came from, as shown next to the obligation. */
export type RuleSourceRef = {
  kind: "corridor" | "airline";
  id: string;
  /** Corridor label ("Chile") or airline name ("Iberia"). */
  label: string;
  sourceUrl: string;
  lastVerifiedAt: string;
  reviewBy: string;
  verification: Verification;
  note: string | null;
  freshness: Freshness;
};

export type Contribution = {
  ruleType: TravelRuleType;
  value: unknown;
  document: TravelDocument | null;
  source: RuleSourceRef;
  /** max_weight_kg only: whether the airline's limit counts the carrier. */
  includesCarrier?: boolean;
};

export type MergedRule<K extends TravelRuleType = TravelRuleType> = {
  ruleType: K;
  document: TravelDocument | null;
  value: TravelRuleValueByType[K];
  /** The sources whose value binds (min/max) or that demand it (union). */
  binding: RuleSourceRef[];
  /** Every source in the group, binding or not. */
  all: RuleSourceRef[];
  /** Worst freshness across `all`. */
  freshness: Freshness;
  /** max_weight_kg only. */
  includesCarrier: boolean;
};

export function sourceRef(
  kind: RuleSourceRef["kind"],
  id: string,
  label: string,
  meta: SourceMeta,
  now: Date,
): RuleSourceRef {
  return {
    kind,
    id,
    label,
    sourceUrl: meta.sourceUrl,
    lastVerifiedAt: meta.lastVerifiedAt,
    reviewBy: meta.reviewBy,
    verification: meta.verification,
    note: meta.note ?? null,
    freshness: freshnessOf(meta, now),
  };
}

// ---------------------------------------------------------------------------
// Normalisation — corridors
// ---------------------------------------------------------------------------

/**
 * The corridor's rules as contributions. A rule scoped to species the pet is
 * not is skipped; when the species is unknown the rule is kept — assuming it
 * does not apply could only ever hide a requirement.
 */
export function corridorContributions(
  corridor: Corridor,
  species: TravelSpecies | null,
  now: Date,
): Contribution[] {
  const out: Contribution[] = [];
  for (const [ruleType, envelope] of Object.entries(corridor.rules)) {
    if (!envelope) continue;
    if (species && envelope.appliesToSpecies && !envelope.appliesToSpecies.includes(species)) {
      continue;
    }
    // A document window that names no document is the CVI's — the one every
    // corridor demands — so it merges with an airline's health-certificate
    // window instead of standing apart from it.
    const document =
      envelope.document ?? (ruleType === "document_issuance_window_days" ? "senasa_cvi" : null);
    out.push({
      ruleType: ruleType as TravelRuleType,
      value: envelope.value,
      document,
      source: sourceRef("corridor", corridor.id, corridor.label, envelope, now),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalisation — airlines (design D2 mapping)
// ---------------------------------------------------------------------------

/** es-AR name of each document an airline checks at the counter. */
export const AIRLINE_DOCUMENT_LABELS: Record<AirlineDocument, string> = {
  vet_health_certificate: "Certificado de salud veterinario",
  rabies_certificate: "Certificado de vacunación antirrábica",
  senasa_cvi: "Certificado Veterinario Internacional (CVI) — SENASA",
  senasa_boarding_permit: "Permiso de embarque SENASA",
  airline_form: "Formulario propio de la aerolínea",
};

/**
 * Which document an airline's issuance window binds. Every corridor miMAR
 * knows is outbound from Argentina, and for an outbound international trip
 * the health certificate the counter checks IS the SENASA CVI — so an
 * airline's "health certificate within 10 days" tightens the CVI window
 * (spec: "Airline tighter"). Other documents keep their own window.
 */
export function windowDocumentFor(doc: AirlineDocument): TravelDocument {
  return doc === "vet_health_certificate" ? "senasa_cvi" : doc;
}

function airlineMinAge(
  rule: AirlineModalityRule,
  corridorIds: readonly CorridorId[],
): number | null {
  const minAge = rule.minAgeDays?.value;
  if (!minAge) return null;
  const international = minAge.international ?? minAge.default;
  if (corridorIds.length === 0) return international;
  return Math.max(...corridorIds.map((id) => minAge.byCorridor?.[id] ?? international));
}

function push<T>(
  out: Contribution[],
  ruleType: TravelRuleType,
  leaf: Sourced<T>,
  value: unknown,
  ref: (meta: SourceMeta) => RuleSourceRef,
  extra: Partial<Contribution> = {},
): void {
  out.push({ ruleType, value, document: null, source: ref(leaf), ...extra });
}

function documentContributions(
  rule: AirlineModalityRule,
  ref: (meta: SourceMeta) => RuleSourceRef,
): Contribution[] {
  const leaf = rule.requiredDocuments;
  if (!leaf) return [];
  const out: Contribution[] = [];
  for (const doc of leaf.value) {
    if (doc.maxDaysBeforeFlight !== undefined) {
      push(out, "document_issuance_window_days", leaf, doc.maxDaysBeforeFlight, ref, {
        document: windowDocumentFor(doc.doc),
      });
    }
    if (doc.minDaysSinceDose !== undefined) {
      push(out, "rabies_vaccination_to_travel_wait_days", leaf, doc.minDaysSinceDose, ref);
    }
    if (doc.maxDaysSinceDose !== undefined) {
      push(out, "rabies_vaccination_max_days_before_travel", leaf, doc.maxDaysSinceDose, ref);
    }
  }
  const labels = leaf.value.map((d) => AIRLINE_DOCUMENT_LABELS[d.doc]);
  if (labels.length > 0) push(out, "required_documents", leaf, labels, ref);
  return out;
}

/** The chosen airline row's rules as contributions (design D2 mapping). */
export function airlineContributions(
  airline: Airline,
  modality: Modality,
  corridorIds: readonly CorridorId[],
  now: Date,
): Contribution[] {
  const rule = airline.modalities[modality];
  if (!rule) return [];
  const ref = (meta: SourceMeta) => sourceRef("airline", airline.id, airline.name, meta, now);
  const out: Contribution[] = [];

  const minAge = airlineMinAge(rule, corridorIds);
  if (rule.minAgeDays && minAge !== null) {
    push(out, "min_animal_age_days", rule.minAgeDays, minAge, ref);
  }
  if (rule.maxWeightKg) {
    push(out, "max_weight_kg", rule.maxWeightKg, rule.maxWeightKg.value.kg, ref, {
      includesCarrier: rule.maxWeightKg.value.includesCarrier,
    });
  }
  if (rule.breedRestrictions) {
    const applicable = rule.breedRestrictions.value.filter((r) => r.appliesTo.includes(modality));
    if (applicable.length > 0) {
      push(out, "breed_restrictions", rule.breedRestrictions, applicable, ref);
    }
  }
  out.push(...documentContributions(rule, ref));
  if (rule.embargoes && rule.embargoes.value.length > 0) {
    push(out, "embargoes", rule.embargoes, rule.embargoes.value, ref);
  }
  if (rule.bookingLeadHours) {
    push(out, "booking_lead_hours", rule.bookingLeadHours, rule.bookingLeadHours.value, ref);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const FRESHNESS_RANK: Record<Freshness, number> = { fresh: 0, expired: 1, unverified: 2 };

export function worstFreshness(sources: readonly RuleSourceRef[]): Freshness {
  let worst: Freshness = "fresh";
  for (const s of sources) {
    if (FRESHNESS_RANK[s.freshness] > FRESHNESS_RANK[worst]) worst = s.freshness;
  }
  return worst;
}

function uniqueSources(sources: RuleSourceRef[]): RuleSourceRef[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const key = `${s.kind}:${s.id}:${s.sourceUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeGroup(group: Contribution[]): MergedRule {
  const [first] = group;
  const ruleType = first.ruleType;
  const direction = STRICTNESS_DIRECTION[ruleType];
  const all = uniqueSources(group.map((c) => c.source));
  const base = {
    ruleType,
    document: first.document,
    all,
    freshness: worstFreshness(all),
    includesCarrier: false,
  };

  if (direction === "min" || direction === "max") {
    const values = group.map((c) => c.value as number);
    const value = direction === "min" ? Math.min(...values) : Math.max(...values);
    const bindingGroup = group.filter((c) => c.value === value);
    return {
      ...base,
      value,
      binding: uniqueSources(bindingGroup.map((c) => c.source)),
      includesCarrier: bindingGroup.some((c) => c.includesCarrier === true),
    } as MergedRule;
  }

  if (typeof first.value === "boolean") {
    const demanding = group.filter((c) => c.value === true);
    return {
      ...base,
      value: demanding.length > 0,
      binding: uniqueSources(demanding.map((c) => c.source)),
    } as MergedRule;
  }

  // Set union — the traveler carries every item, never a subset.
  const union = new Map<string, unknown>();
  const contributing: Contribution[] = [];
  for (const c of group) {
    const items = c.value as readonly unknown[];
    if (items.length === 0) continue;
    contributing.push(c);
    for (const item of items) union.set(JSON.stringify(item), item);
  }
  return {
    ...base,
    value: [...union.values()],
    binding: uniqueSources(contributing.map((c) => c.source)),
  } as MergedRule;
}

/** Groups by (rule type, document) and merges each group by its direction. */
export function mergeContributions(contributions: readonly Contribution[]): MergedRule[] {
  const groups = new Map<string, Contribution[]>();
  for (const c of contributions) {
    const key = `${c.ruleType}|${c.document ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  return [...groups.values()].map(mergeGroup);
}

/** The merged rule of `ruleType` (and `document`, for windows), if any. */
export function findRule<K extends TravelRuleType>(
  rules: readonly MergedRule[],
  ruleType: K,
  document: TravelDocument | null = null,
): MergedRule<K> | undefined {
  return rules.find(
    (r) => r.ruleType === ruleType && (document === null || r.document === document),
  ) as MergedRule<K> | undefined;
}

// ---------------------------------------------------------------------------
// Freshness → what the owner is told
// ---------------------------------------------------------------------------

/**
 * The amber line an obligation carries when any source behind it is not
 * fresh (spec travel-reference-freshness). Null when every source is fresh.
 */
export function freshnessNotice(sources: readonly RuleSourceRef[]): string | null {
  const worst = worstFreshness(sources);
  if (worst === "fresh") return null;
  if (worst === "unverified") return "Verificá — dato sin confirmar con la fuente";
  const oldest = sources
    .filter((s) => s.freshness === "expired")
    .map((s) => s.lastVerifiedAt)
    .sort()[0];
  return `Verificá — dato sin revisar desde el ${formatDate(oldest)}`;
}

/**
 * Degrades an obligation whose sources are not all fresh. It only ever
 * RAISES the level: info becomes a warning, and a blocker stays a blocker. A
 * false red costs the owner a phone call; a false amber-to-green could cost a
 * denied boarding (design D2).
 */
export function degradeForFreshness(
  level: RequirementLevel,
  freshness: Freshness,
): RequirementLevel {
  if (freshness === "fresh") return level;
  return level === "info" ? "warning" : level;
}
