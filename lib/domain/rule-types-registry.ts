// Generalized rule-type registry — the linchpin of the admin-rules-console
// change (design ADR-2). Turns `govt_business_rules` from per-type
// hardcoding into a data + one-form-component system.
//
// Pure module — safe to import from client AND server code. It intentionally
// imports schemas from `lib/infra/business-rules-validators` (which itself has
// NO db import — only zod + an erased type import), so pulling it into a
// client bundle does not drag in the resolver/db bundle. This mirrors why
// `lib/infra/breeds-server.ts` is kept separate from `lib/breeds.ts`.
//
// Replaces:
//   - the 3 duplicated RULE_TYPE_LABEL maps (gob/reglas/page.tsx,
//     jurisdicciones/.../reglas/page.tsx x2)
//   - the RULE_TYPE_DESCRIPTION map
//   - the `parseRulePayloadFromForm` switch (app/actions/business-rules.ts)
//   - the RULE_TYPES_NOT_YET_AVAILABLE set (superseded by the form-component
//     map in app/gob/reglas/.../forms/index.ts — "has a form" now means
//     "has an entry in that map", not a flag duplicated here)
//
// Adding a rule type = 1 entry here + (if enforced) 1 effect hook in
// lib/infra/rule-types-effects.ts + 1 form component + (if new) 1 migration.
// The 4 "promoted" rule types (rabies_observation_window, due_soon_window,
// reminder_windows, long_stay_days) are added by a later commit alongside
// their schemas/defaults/migration — see db/migrations for the CHECK
// constraint widening.

import type { GovtBusinessRuleType } from "@/db";
import {
  BUSINESS_RULES_DEFAULTS,
  type BusinessRulePayloadByType,
  type MpfExportFormatId,
} from "@/lib/domain/business-rules-defaults";
import { BUSINESS_RULE_VALIDATORS } from "@/lib/infra/business-rules-validators";
import { parseRegistriesJson } from "@/lib/infra/parse-registries";
import { pluralizeEs } from "@/lib/utils/format";
import type { z } from "zod";

/**
 * Drives how a rule type's write-consumer resolves the applicable
 * jurisdiction (design ADR-4):
 *   - "pet"                — resolved per-pet, via the pet's own jurisdiction.
 *   - "org"                — resolved per-org, via the org's jurisdiction.
 *   - "jurisdiction-metric" — resolved per jurisdiction GROUP in an aggregate
 *                             projection; falls back to country-level for
 *                             cross-jurisdiction ("global") aggregates.
 *   - "global"              — resolved once, country-level only (no per-row
 *                             jurisdictional variance — e.g. a cron sweep).
 */
export type RuleResolutionScope = "pet" | "org" | "jurisdiction-metric" | "global";

export interface RuleTypeDef<T extends GovtBusinessRuleType = GovtBusinessRuleType> {
  id: T;
  /** es-AR display label. */
  label: string;
  /** Consumer-facing description (shown in the "missing types" list). */
  description: string;
  /** `.strict()` Zod validator — same instance BUSINESS_RULE_VALIDATORS uses. */
  schema: z.ZodSchema;
  /** Hardcoded default payload — the resolver's fallback tier. */
  default: BusinessRulePayloadByType[T];
  /** Parse this rule type's payload out of a submitted <form>. */
  parseFromForm: (formData: FormData) => unknown;
  resolutionScope: RuleResolutionScope;
}

/** Parses a single `{ days: number }`-shaped rule type from its form field. */
function parseDaysField(formData: FormData): { days: number } {
  const raw = (formData.get("days") as string | null)?.trim();
  const days = raw && raw !== "" ? Number.parseInt(raw, 10) : Number.NaN;
  return { days: Number.isNaN(days) ? 0 : days };
}

/**
 * Parses an OPTIONAL integer form field: empty/absent/NaN -> omitted from the
 * payload (the new obligation payloads are all-optional — see
 * business-rules-defaults.ts).
 */
function parseOptionalIntField(formData: FormData, name: string): { [k: string]: number } {
  const raw = (formData.get(name) as string | null)?.trim();
  if (!raw) return {};
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? {} : { [name]: value };
}

/** Optional free-text variant: blank/absent -> omitted from the payload. */
function parseOptionalTextField(formData: FormData, name: string): { [k: string]: string } {
  const raw = (formData.get(name) as string | null)?.trim();
  return raw ? { [name]: raw } : {};
}

/** Optional float variant for the compliance_targets percentage fields. */
function parseOptionalPctField(formData: FormData, name: string): { [k: string]: number } {
  const raw = (formData.get(name) as string | null)?.trim();
  if (!raw) return {};
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) ? {} : { [name]: value };
}

function parseProviderChannel(formData: FormData, channel: string) {
  const enabled = formData.get(`enabled_${channel}`) === "on";
  const providerNameRaw = (formData.get(`provider_name_${channel}`) as string | null)?.trim();
  const providerUrlRaw = (formData.get(`provider_url_${channel}`) as string | null)?.trim();
  return {
    enabled,
    ...(providerNameRaw ? { providerName: providerNameRaw } : {}),
    ...(providerUrlRaw ? { providerUrl: providerUrlRaw } : {}),
  };
}

export const RULE_TYPE_REGISTRY: { [K in GovtBusinessRuleType]: RuleTypeDef<K> } = {
  ppp_breed_list: {
    id: "ppp_breed_list",
    label: "Lista de razas PPP",
    description: "Qué razas se consideran Potencialmente Peligrosas en esta jurisdicción.",
    schema: BUSINESS_RULE_VALIDATORS.ppp_breed_list,
    default: BUSINESS_RULES_DEFAULTS.ppp_breed_list,
    resolutionScope: "pet",
    parseFromForm: (formData) => {
      const breeds = (formData.getAll("breeds") as string[])
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { breeds };
    },
  },
  ppp_weight_threshold: {
    id: "ppp_weight_threshold",
    label: "Umbral de peso PPP",
    description: "Si el peso del animal por sí solo dispara el status PPP, y a qué kilos.",
    schema: BUSINESS_RULE_VALIDATORS.ppp_weight_threshold,
    default: BUSINESS_RULES_DEFAULTS.ppp_weight_threshold,
    resolutionScope: "pet",
    parseFromForm: (formData) => {
      const kgRaw = (formData.get("kg") as string | null)?.trim();
      const kg = kgRaw && kgRaw !== "" ? Number.parseFloat(kgRaw) : null;
      const appliesIfBreedNotPPP = formData.get("appliesIfBreedNotPPP") === "on";
      return { kg, appliesIfBreedNotPPP };
    },
  },
  ppp_attestation_required_registries: {
    id: "ppp_attestation_required_registries",
    label: "Registros de atestación requeridos",
    description: "En qué registros oficiales el dueño debe atestar a su mascota PPP.",
    schema: BUSINESS_RULE_VALIDATORS.ppp_attestation_required_registries,
    default: BUSINESS_RULES_DEFAULTS.ppp_attestation_required_registries,
    resolutionScope: "pet",
    parseFromForm: (formData) => {
      const raw = formData.get("registriesJson") as string | null;
      return { registries: parseRegistriesJson(raw) };
    },
  },
  physical_credential_channels: {
    id: "physical_credential_channels",
    label: "Canales de credencial física",
    description:
      "Qué canales de emisión de credencial física están habilitados (QR imprimible, placa grabada, NFC).",
    schema: BUSINESS_RULE_VALIDATORS.physical_credential_channels,
    default: BUSINESS_RULES_DEFAULTS.physical_credential_channels,
    resolutionScope: "pet",
    parseFromForm: (formData) => {
      const printable_qr = formData.get("printable_qr") === "on";
      return {
        printable_qr,
        engraved_plate: parseProviderChannel(formData, "engraved_plate"),
        nfc_tag: parseProviderChannel(formData, "nfc_tag"),
      };
    },
  },
  microchip_required: {
    id: "microchip_required",
    label: "Microchip obligatorio",
    description: "Si esta jurisdicción exige la identificación por microchip.",
    schema: BUSINESS_RULE_VALIDATORS.microchip_required,
    default: BUSINESS_RULES_DEFAULTS.microchip_required,
    resolutionScope: "pet",
    parseFromForm: (formData) => {
      return { required: formData.get("required") === "on" };
    },
  },
  rabies_observation_window: {
    id: "rabies_observation_window",
    label: "Ventana de observación antirrábica",
    description:
      "Días de observación clínica exigidos tras una mordedura, antes de descartar rabia.",
    schema: BUSINESS_RULE_VALIDATORS.rabies_observation_window,
    default: BUSINESS_RULES_DEFAULTS.rabies_observation_window,
    resolutionScope: "jurisdiction-metric",
    parseFromForm: parseDaysField,
  },
  due_soon_window: {
    id: "due_soon_window",
    label: "Ventana 'próximo a vencer'",
    description: "Días de anticipación con los que una vacuna se marca 'próxima a vencer'.",
    schema: BUSINESS_RULE_VALIDATORS.due_soon_window,
    default: BUSINESS_RULES_DEFAULTS.due_soon_window,
    resolutionScope: "pet",
    parseFromForm: parseDaysField,
  },
  reminder_windows: {
    id: "reminder_windows",
    label: "Ventana de recordatorios",
    description: "Con cuántos días de anticipación se generan los recordatorios de vacunación.",
    schema: BUSINESS_RULE_VALIDATORS.reminder_windows,
    default: BUSINESS_RULES_DEFAULTS.reminder_windows,
    resolutionScope: "global",
    parseFromForm: (formData) => {
      const raw = (formData.get("aheadDays") as string | null)?.trim();
      const aheadDays = raw && raw !== "" ? Number.parseInt(raw, 10) : Number.NaN;
      return { aheadDays: Number.isNaN(aheadDays) ? 0 : aheadDays };
    },
  },
  long_stay_days: {
    id: "long_stay_days",
    label: "Umbral de estadía prolongada",
    description: "Días de estadía en refugio a partir de los cuales se marca 'estadía larga'.",
    schema: BUSINESS_RULE_VALIDATORS.long_stay_days,
    default: BUSINESS_RULES_DEFAULTS.long_stay_days,
    resolutionScope: "org",
    parseFromForm: parseDaysField,
  },
  mpf_export_format: {
    id: "mpf_export_format",
    label: "Formato de export a fiscalía (MPF)",
    description:
      "Qué formato usa el PDF de denuncia formal a la fiscalía (MPF) para esta jurisdicción.",
    schema: BUSINESS_RULE_VALIDATORS.mpf_export_format,
    default: BUSINESS_RULES_DEFAULTS.mpf_export_format,
    // Resolved per welfare report by (país, provincia, localidad) — the same
    // tuple resolveBusinessRule always cascades on, not tied to a pet or an
    // org record. "jurisdiction-metric" is the closest existing scope (a
    // per-jurisdiction-tuple resolution, not global/pet/org).
    resolutionScope: "jurisdiction-metric",
    parseFromForm: (formData) => {
      const raw = (formData.get("format") as string | null)?.trim();
      return {
        format: raw && raw.length > 0 ? raw : BUSINESS_RULES_DEFAULTS.mpf_export_format.format,
      };
    },
  },
  // Jurisdiction-aware compliance obligations (migration 0183) — the tier
  // (requirement_level) and legal provenance are table COLUMNS parsed by
  // parseLegalMetadata in the writer, NOT payload fields; these payloads
  // carry only operational parameters (all optional).
  rabies_vaccination: {
    id: "rabies_vaccination",
    label: "Vacunación antirrábica",
    description:
      "Qué exige esta jurisdicción sobre la vacunación antirrábica (nivel de exigencia, frecuencia, edad mínima).",
    schema: BUSINESS_RULE_VALIDATORS.rabies_vaccination,
    default: BUSINESS_RULES_DEFAULTS.rabies_vaccination,
    resolutionScope: "pet",
    parseFromForm: (formData) => ({
      ...parseOptionalIntField(formData, "frequency_months"),
      ...parseOptionalTextField(formData, "frequency_legal_basis"),
      ...parseOptionalIntField(formData, "min_age_months"),
    }),
  },
  sterilization: {
    id: "sterilization",
    label: "Esterilización",
    description:
      "Qué exige esta jurisdicción sobre la esterilización (nivel de exigencia, edad mínima, edad desde la que aplica).",
    schema: BUSINESS_RULE_VALIDATORS.sterilization,
    default: BUSINESS_RULES_DEFAULTS.sterilization,
    resolutionScope: "pet",
    parseFromForm: (formData) => ({
      ...parseOptionalIntField(formData, "min_age_months"),
      ...parseOptionalIntField(formData, "mandatory_from_months"),
    }),
  },
  compliance_targets: {
    id: "compliance_targets",
    label: "Metas de cumplimiento",
    description:
      "Metas locales para los indicadores de cobertura que la normativa jurisdiccional ajusta (antirrábica, microchip, esterilización, atestación PPP).",
    schema: BUSINESS_RULE_VALIDATORS.compliance_targets,
    default: BUSINESS_RULES_DEFAULTS.compliance_targets,
    resolutionScope: "jurisdiction-metric",
    parseFromForm: (formData) => ({
      ...parseOptionalPctField(formData, "rabies_coverage_pct"),
      ...parseOptionalPctField(formData, "microchip_penetration_pct"),
      ...parseOptionalPctField(formData, "sterilization_coverage_pct"),
      ...parseOptionalPctField(formData, "ppp_attestation_pct"),
    }),
  },
};

/**
 * es-AR labels for the requirement tier (govt_business_rules.requirement_level,
 * migration 0183) — shared by the console forms and listings.
 */
export const REQUIREMENT_LEVEL_LABELS = {
  mandatory: "Obligatorio",
  recommended: "Recomendado",
  not_regulated: "No regulado",
  optional: "Opcional",
} as const;

/**
 * es-AR labels for each mpf_export_format enum value — see
 * lib/domain/business-rules-defaults.ts for why there is exactly one today.
 */
export const MPF_EXPORT_FORMAT_LABELS: Record<MpfExportFormatId, string> = {
  estandar_nacional: "Estándar nacional (PDF libre, Ley 14.346)",
};

export function getRuleTypeDef<T extends GovtBusinessRuleType>(ruleType: T): RuleTypeDef<T> {
  return RULE_TYPE_REGISTRY[ruleType] as RuleTypeDef<T>;
}

/**
 * es-AR label per resolveBusinessRule() cascade `source` — shared vocabulary
 * between the govt read-only lens (app/gob/reglas/page.tsx) and the admin
 * cascade-editing lens (app/gob/reglas/[country]/[province]/[locality]/
 * page.tsx). Previously only the govt lens showed this; the admin lens's
 * "Tipos sin excepción" section displayed the hardcoded system default with
 * no indication a higher jurisdiction level might actually govern instead
 * (E5, 2026-07-21 facades harvest).
 */
export type ResolvedRuleSource = "default" | "country" | "province" | "locality";

export const RULE_SOURCE_LABEL: Record<ResolvedRuleSource, string> = {
  default: "Default nacional",
  country: "Override país (AR)",
  province: "Override provincia",
  locality: "Override localidad",
};

/**
 * es-AR one-line summary of a rule payload for console listings — replaces
 * dumping truncated raw JSON at the operator (QA round 2 2026-07-03 #7).
 * Total over unknown/legacy payload shapes: falls back to compact JSON rather
 * than throwing, since historic rows may predate the current schema.
 */
export function summarizeRulePayload(ruleType: GovtBusinessRuleType, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (ruleType) {
    case "ppp_breed_list": {
      const breeds = Array.isArray(p.breeds) ? (p.breeds as string[]) : [];
      if (breeds.length === 0) return "Sin razas listadas";
      const shown = breeds.slice(0, 3).join(", ");
      const rest = breeds.length - 3;
      return `${breeds.length} ${breeds.length === 1 ? "raza" : "razas"}: ${shown}${rest > 0 ? ` y ${rest} más` : ""}`;
    }
    case "ppp_weight_threshold": {
      if (typeof p.kg !== "number") return "Sin umbral de peso";
      return `${p.kg} kg${p.appliesIfBreedNotPPP ? " · aplica aunque la raza no esté listada" : ""}`;
    }
    case "ppp_attestation_required_registries": {
      const registries = Array.isArray(p.registries) ? p.registries : [];
      return registries.length === 0
        ? "Ningún registro requerido"
        : `${registries.length} ${registries.length === 1 ? "registro requerido" : "registros requeridos"}`;
    }
    case "physical_credential_channels": {
      const enabled: string[] = [];
      if (p.printable_qr) enabled.push("QR imprimible");
      if ((p.engraved_plate as { enabled?: boolean } | undefined)?.enabled)
        enabled.push("placa grabada");
      if ((p.nfc_tag as { enabled?: boolean } | undefined)?.enabled) enabled.push("NFC");
      return enabled.length === 0 ? "Sin canales habilitados" : enabled.join(" · ");
    }
    case "microchip_required": {
      return p.required ? "Microchip obligatorio" : "Microchip no obligatorio";
    }
    case "rabies_observation_window":
    case "due_soon_window":
    case "long_stay_days": {
      return typeof p.days === "number"
        ? `${p.days} ${pluralizeEs(p.days, "día")}`
        : JSON.stringify(payload);
    }
    case "reminder_windows": {
      return typeof p.aheadDays === "number"
        ? `${p.aheadDays} ${pluralizeEs(p.aheadDays, "día")} de anticipación`
        : JSON.stringify(payload);
    }
    case "mpf_export_format": {
      const format = typeof p.format === "string" ? (p.format as MpfExportFormatId) : null;
      return format
        ? (MPF_EXPORT_FORMAT_LABELS[format] ?? format)
        : "Sin formato de export configurado";
    }
    // Obligation types (migration 0183): the tier + citation live in table
    // COLUMNS, so the payload summary covers only the operational parameters.
    case "rabies_vaccination": {
      const parts: string[] = [];
      if (typeof p.frequency_months === "number")
        parts.push(
          typeof p.frequency_legal_basis === "string" && p.frequency_legal_basis.trim()
            ? `refuerzo cada ${p.frequency_months} ${pluralizeEs(p.frequency_months, "mes")} (${p.frequency_legal_basis.trim()})`
            : `refuerzo cada ${p.frequency_months} ${pluralizeEs(p.frequency_months, "mes")}`,
        );
      if (typeof p.min_age_months === "number")
        parts.push(`desde los ${p.min_age_months} ${pluralizeEs(p.min_age_months, "mes")}`);
      return parts.length === 0 ? "Sin parámetros configurados" : parts.join(" · ");
    }
    case "sterilization": {
      const parts: string[] = [];
      if (typeof p.min_age_months === "number")
        parts.push(`edad mínima ${p.min_age_months} ${pluralizeEs(p.min_age_months, "mes")}`);
      if (typeof p.mandatory_from_months === "number")
        parts.push(
          `aplica desde los ${p.mandatory_from_months} ${pluralizeEs(p.mandatory_from_months, "mes")}`,
        );
      return parts.length === 0 ? "Sin parámetros configurados" : parts.join(" · ");
    }
    case "compliance_targets": {
      const labels: Record<string, string> = {
        rabies_coverage_pct: "antirrábica",
        microchip_penetration_pct: "microchip",
        sterilization_coverage_pct: "esterilización",
        ppp_attestation_pct: "atestación PPP",
      };
      const parts = Object.entries(labels)
        .filter(([key]) => typeof p[key] === "number")
        .map(([key, label]) => `${label} ${p[key]}%`);
      return parts.length === 0 ? "Sin metas configuradas" : parts.join(" · ");
    }
    default:
      return JSON.stringify(payload);
  }
}
