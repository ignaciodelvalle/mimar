// Operator vocabulary glossary — C2 · Contrato de Lenguaje Operativo
// (restricted vocabulary + glossary primitive, 2026-07-22 plan-maestro).
//
// Every operator-facing acronym gets EXACTLY one canonical expansion + one-
// line purpose HERE — nowhere else. A screen that needs to introduce an
// acronym imports expandAcronym() instead of writing its own paraphrase, so
// two screens can never define the same term two different ways (the
// "glosario ausente (PPP/ENO/AMR)" S2 symptom in the audit).
//
// SOURCING RULE (do not invent): every expansion below is grounded in an
// authoritative source already in this codebase or its docs — see each
// entry's `source`. An acronym with no authoritative source found is left
// out entirely rather than guessed; see the TODO note at the bottom of this
// file for the one case that hit that rule.

export type AcronymEntry = {
  acronym: string;
  /** Full canonical expansion, es-AR. */
  expansion: string;
  /** One-line purpose — what this registry/measure is FOR, not just its name. */
  purpose: string;
  /** Where the expansion is grounded (file:line or law), for future audits. */
  source: string;
};

export const OPERATOR_GLOSSARY: Record<string, AcronymEntry> = {
  RUPGA: {
    acronym: "RUPGA",
    expansion: "Registro de Usuarias y Usuarios de Perros de Guía o de Asistencia",
    purpose:
      "Registro nacional (ANDIS) que acredita el vínculo entre una persona y su perro guía o de asistencia — la credencial habilita el acceso a espacios públicos y transporte (Ley 26.858, Decreto 792/2019, Resolución ANDIS 2588/2022).",
    source: "docs/superpowers/specs/archive/2026-05-17-additional-species-design.md:399",
  },
  PPP: {
    acronym: "PPP",
    expansion: "Razas Potencialmente Peligrosas",
    purpose:
      "Régimen de razas potencialmente peligrosas: el dueño/a debe atestar el registro provincial/municipal correspondiente (Ley CABA 4078 / Ley Prov. 14.107) — mide adopción del registro, no un veredicto de peligrosidad individual.",
    source: "lib/metrics/kpi-catalog.ts:409,425 (ppp_registry_compliance)",
  },
  ENO: {
    acronym: "ENO",
    expansion: "Enfermedades de Notificación Obligatoria",
    purpose:
      "Enfermedades que la autoridad sanitaria exige notificar (lepto, hidatidosis, rabia, etc.) — miMAR genera y audita la notificación en su propia bandeja de salida; la transmisión EXTERNA a la autoridad depende de un endpoint receptor todavía pendiente.",
    source: "db/schema.ts:2189, db/migrations/0048_event_notification_outbox.sql",
  },
  AMR: {
    acronym: "AMR",
    expansion: "Resistencia Antimicrobiana",
    purpose:
      "Vigilancia de uso de antimicrobianos (antibióticos) por cada 1.000 mascotas activas — una señal de presión de resistencia, no un diagnóstico de resistencia confirmada.",
    source: "AGENTS.md:873 (fetchAmrDensity, lib/drugs.ts isAntimicrobial)",
  },
  SLA: {
    acronym: "SLA",
    expansion: "Acuerdo de Nivel de Servicio",
    purpose:
      "El plazo máximo (según severidad) para actuar sobre una denuncia o notificación antes de que se considere vencida — ver SlaBadge (components/ui/dashboard) para la lectura honesta de días vencidos vs. el tier.",
    source: "app/gob/maltrato/_lib/welfare-sla.ts",
  },
  MPF: {
    acronym: "MPF",
    expansion: "Ministerio Público Fiscal",
    purpose:
      "La fiscalía a la que miMAR exporta el legajo de una denuncia de maltrato (Ley 14.346) — el export nombra la fecha del hecho vs. la fecha de conocimiento, brecha con valor de defensa institucional.",
    source: "AGENTS.md:1128, src/modules/welfare/application/generate-mpf-export.ts",
  },
};

/**
 * First-use expansion string: "Expansión (SIGLA)" — the canonical shape for
 * an h1/subtitle's first mention of a glossary acronym. Returns the acronym
 * UNEXPANDED if it isn't catalogued — this function never invents a term; an
 * uncatalogued acronym is a signal to add it to OPERATOR_GLOSSARY, not to
 * guess its meaning inline at the call site.
 */
export function expandAcronym(acronym: string): string {
  const entry = OPERATOR_GLOSSARY[acronym];
  if (!entry) return acronym;
  return `${entry.expansion} (${entry.acronym})`;
}

/** The one-line purpose for a catalogued acronym, or null if uncatalogued. */
export function acronymPurpose(acronym: string): string | null {
  return OPERATOR_GLOSSARY[acronym]?.purpose ?? null;
}

// ---------------------------------------------------------------------------
// TODO (reported, not guessed): the plan-maestro brief also named a handful of
// operator acronyms it wanted catalogued alongside RUPGA/PPP/ENO/AMR/SLA/MPF.
// Every one of those six now has an authoritative source above. No OTHER
// operator acronym search (grepping AGENTS.md + app/gob + app/admin page
// headers) turned up a distinct, uncatalogued acronym in current use that
// would need its own TODO entry here — if a future audit finds one, add it
// as `{ acronym, expansion: "TODO — no authoritative source found", ... }`
// rather than inventing the expansion.
// ---------------------------------------------------------------------------
