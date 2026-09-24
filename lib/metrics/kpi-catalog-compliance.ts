// lib/metrics/kpi-catalog-compliance.ts — the MANDATED-DENOMINATOR compliance
// slice of the KPI catalog (jurisdiction-compliance WU4a, spec MN1/MN3).
//
// WHY THIS MODULE EXISTS (same two structural reasons as kpi-catalog-queues.ts)
// -----------------------------------------------------------------------------
// 1. ADR-5 dual-report: C1's legacy bruta metric ("Penetración de microchip",
//    all-pets denominator) must stay UNCHANGED — DB-configured alert thresholds
//    reference its definition. The honest complement — compliance computed over
//    the jurisdictions where the obligation is actually MANDATORY (resolved
//    requirement_level, WU1 columns) — is a NEW descriptor family, not an edit.
// 2. kpi-catalog.ts sits against its file-size ratchet (scripts/
//    file-size-baseline.json) — new descriptor families live in sibling
//    modules (kpi-catalog-queues.ts precedent) and are spread back in.
//
// CONTRACT: ordinary `KpiDefinition`s — kpi-catalog.ts spreads
// COMPLIANCE_KPI_CATALOG into KPI_CATALOG, so `KPI_CATALOG.<id>` / getKpiInfo /
// <OpKpi descriptorId> behave identically to a main-file entry.
// scripts/check-metric-contract.ts lists this file in CATALOG_PATHS (added in
// the SAME commit that created it) so the dead-guard rule covers these.
//
// LABEL PRECISION: a catalogued label RESERVES its exact string repo-wide
// (scripts/check-metric-labels.ts). Every label below carries the "(donde es
// obligatorio/a)" qualifier so it can NEVER be read as — or collide with —
// its bruta sibling ("Penetración de microchip" is RESERVED and semantically
// different: another denominator).
//
// SHARED HONESTY NOTES for all three entries:
//   - `semaphore: { paintAgainst: "none" }` and NO `target`: where an
//     obligation is mandatory the only legally defensible target is 100%, and
//     painting a platform-registration number red against 100 repeats the
//     red-team #7 class (a registry-adoption gap dressed as a legal breach).
//     These tiles report the mandated-denominator fact; verdict tones stay on
//     the bruta tiles' programmatic targets.
//   - `guards: { zeroDenominator: "dash" }`: until the legal baseline (WU2) is
//     signed off and seeded, NO jurisdiction resolves a mandate, so the
//     denominator is 0 everywhere — the tile must dash, never fabricate "0%".
//   - The denominator basis (which jurisdictions mandate) resolves through
//     lib/analytics/mandating-jurisdictions.ts: matched rule rows only; a
//     `not_regulated` locality override under a `mandatory` province is
//     EXCLUDED (cascade-correctness, the family's sharpest bug risk).

import type { KpiDefinition } from "./kpi-catalog";

/** Stable ids for the mandated-compliance descriptors. Snake_case, never reused. */
export type ComplianceKpiId =
  | "microchip_compliance_mandated"
  | "rabies_compliance_mandated"
  | "sterilization_compliance_mandated";

export const COMPLIANCE_KPI_CATALOG: Record<ComplianceKpiId, KpiDefinition> = {
  microchip_compliance_mandated: {
    id: "microchip_compliance_mandated",
    label: "Cumplimiento microchip (donde es obligatorio)",
    numerator:
      "COUNT active/lost pets with ≥1 active microchip_iso identification, in jurisdictions whose resolved microchip_required rule is an actual mandate (OR5 gate over matched rows)",
    denominator:
      "COUNT active/lost pets in scope whose (province, locality) resolves a microchip mandate — resolveMandatingJurisdictions('microchip_required')",
    source: "pets, pet_identifications, govt_business_rules (requirement_level)",
    fetcherName: "fetchMicrochipComplianceInMandated",
    fetcherPath: "lib/analytics/compliance-metrics.ts",
    cadence: "point-in-time snapshot",
    unit: "percent",
    suppression: "none (no per-locality breakdown published)",
    caveat:
      "Denominador SOLO donde la normativa cargada declara el microchip obligatorio (filas resueltas de govt_business_rules; el default de plataforma nunca crea obligación). Gemela de 'Penetración de microchip' (denominador bruto, intacta — continuidad de umbrales de alerta, ADR-5). Sin filas de obligación cargadas, el denominador es 0 y el tile muestra '—' (estado honesto, no un error).",
    window: "all_time",
    species: "all_species",
    basis: "ratio",
    question:
      "En las jurisdicciones donde el microchip es legalmente obligatorio, ¿qué porcentaje de mascotas del padrón cumple?",
    semaphore: { paintAgainst: "none" },
    guards: { zeroDenominator: "dash" },
    ui: {
      definition:
        "Porcentaje de mascotas activas/extraviadas con microchip ISO activo, contando SOLO las jurisdicciones donde la normativa cargada declara el microchip obligatorio.",
      formula:
        "COUNT(pets con chip ISO activo en jurisdicciones con obligación resuelta) / COUNT(pets activos/extraviados en esas jurisdicciones)",
      caveat:
        "Si ninguna jurisdicción de la cobertura tiene una regla de obligatoriedad cargada, no hay denominador y el tile muestra '—'.",
    },
  },

  rabies_compliance_mandated: {
    id: "rabies_compliance_mandated",
    label: "Vacunación antirrábica (donde es obligatoria)",
    numerator:
      "COUNT active/lost dogs with a currently-valid rabies dose (shared rabiesVaccinatedExists predicate, fixed trailing 12m ending at ctx.period.until), in jurisdictions whose resolved rabies_vaccination rule is explicitly 'mandatory'",
    denominator:
      "COUNT active/lost dogs in scope whose (province, locality) resolves requirement_level='mandatory' — resolveMandatingJurisdictions('rabies_vaccination')",
    source: "pets, pet_events (vaccination_administered), govt_business_rules (requirement_level)",
    fetcherName: "fetchRabiesComplianceInMandated",
    fetcherPath: "lib/analytics/compliance-metrics.ts",
    cadence:
      "fixed trailing 12 months ending at ctx.period.until (annual legal cadence — same anchoring as rabies_coverage_dogs_12m)",
    unit: "percent",
    suppression: "none (no per-locality breakdown published)",
    caveat:
      "Denominador SOLO donde rabies_vaccination resuelve nivel 'mandatory' en govt_business_rules — una fila sin nivel establecido no crea obligación para esta métrica (a diferencia del panel del dueño, que preserva el comportamiento pre-nivel). DISTINTA de 'Cobertura antirrábica — perros (12 meses)' (denominador bruto, intacta).",
    window: "12m",
    species: "dogs",
    basis: "ratio",
    question:
      "En las jurisdicciones donde la vacunación antirrábica es legalmente obligatoria, ¿qué porcentaje de perros del padrón está al día?",
    semaphore: { paintAgainst: "none" },
    guards: { zeroDenominator: "dash" },
    ui: {
      definition:
        "Porcentaje de perros activos/extraviados con una dosis antirrábica vigente (últimos 12 meses), contando SOLO las jurisdicciones donde la normativa cargada declara la vacunación obligatoria.",
      formula:
        "COUNT(perros con dosis antirrábica vigente en jurisdicciones con obligación resuelta) / COUNT(perros activos/extraviados en esas jurisdicciones)",
      caveat:
        "Si ninguna jurisdicción de la cobertura tiene una regla de obligatoriedad cargada, no hay denominador y el tile muestra '—'.",
    },
  },

  sterilization_compliance_mandated: {
    id: "sterilization_compliance_mandated",
    label: "Esterilización (donde es obligatoria)",
    numerator:
      "COUNT active/lost pets with ≥1 sterilization_performed event, in jurisdictions whose resolved sterilization rule is explicitly 'mandatory'",
    denominator:
      "COUNT active/lost pets in scope whose (province, locality) resolves requirement_level='mandatory' — resolveMandatingJurisdictions('sterilization')",
    source: "pets, pet_events (sterilization_performed), govt_business_rules (requirement_level)",
    fetcherName: "fetchSterilizationComplianceInMandated",
    fetcherPath: "lib/analytics/compliance-metrics.ts",
    cadence: "point-in-time snapshot (all-time sterilization events)",
    unit: "percent",
    suppression: "none (no per-locality breakdown published)",
    caveat:
      "Denominador SOLO donde sterilization resuelve nivel 'mandatory' en govt_business_rules. DISTINTA de 'Cobertura de esterilización' (benchmark programático sobre el padrón completo, intacta).",
    window: "all_time",
    species: "all_species",
    basis: "ratio",
    question:
      "En las jurisdicciones donde la esterilización es legalmente obligatoria, ¿qué porcentaje de mascotas del padrón cumple?",
    semaphore: { paintAgainst: "none" },
    guards: { zeroDenominator: "dash" },
    ui: {
      definition:
        "Porcentaje de mascotas activas/extraviadas con al menos un evento de esterilización registrado, contando SOLO las jurisdicciones donde la normativa cargada declara la esterilización obligatoria.",
      formula:
        "COUNT(pets esterilizados en jurisdicciones con obligación resuelta) / COUNT(pets activos/extraviados en esas jurisdicciones)",
      caveat:
        "Si ninguna jurisdicción de la cobertura tiene una regla de obligatoriedad cargada, no hay denominador y el tile muestra '—'.",
    },
  },
};
