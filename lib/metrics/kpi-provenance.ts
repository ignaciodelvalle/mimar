// lib/metrics/kpi-provenance.ts — es-AR provenance formulas for every catalogued KPI.
//
// "¿De dónde sale este número?" — the ProvenanceCard (components/ui/dashboard/
// ProvenanceCard.tsx) answers that question for any KPI tile carrying a
// `descriptorId`. Its "Fórmula" line comes from HERE, not from the catalog's
// `ui.formula`.
//
// RELATIONSHIP WITH kpi-catalog.ts's `ui.formula` (documented, deliberate):
//   - `ui.formula` (19 entries) is the ⓘ popover's SQL-ish shorthand — es-AR
//     labels mixed with predicate fragments (COUNT/WHERE/status='…'). It stays
//     where it is; the popover keeps rendering it unchanged.
//   - `formulaEs` (ALL entries, enforced by kpi-provenance.test.ts) is one
//     terse, fully es-AR sentence/fraction per KPI, derived from the catalog's
//     own numerator/denominator/window prose. The ProvenanceCard prefers this.
//   - Consolidating the two into one field is a known follow-up, not done here.
//
// ACCURACY RULE: a formula that lies is worse than none. Every sentence below
// was derived from the catalog entry's numerator/denominator/cadence — where a
// metric is genuinely composite, the sentence says so honestly ("unión de…",
// "dos conteos independientes…") instead of inventing a fraction. Numbers that
// live in lib/metrics/targets.ts / anonymity.ts are interpolated from those
// constants, never retyped.
//
// This module is NEW (kpi-catalog.ts sits at its exact file-size ratchet
// ceiling and may not grow) and stays pure/client-safe: type-only + constant
// imports, no components, no DB.

import { ANONYMITY_K } from "./anonymity";
import type { KpiBasis, KpiId, KpiWindow } from "./kpi-catalog";
import { TARGETS } from "./targets";

/** es-AR provenance copy for one catalogued KPI. Keep minimal — extend only
 *  when the ProvenanceCard genuinely needs a new field. */
export type KpiProvenance = {
  /** ONE terse, accurate es-AR sentence/fraction: what the number is made of. */
  formulaEs: string;
};

/**
 * Complete by construction: a `Record<KpiId, …>` (not Partial) so adding a new
 * KpiId to the catalog fails `tsc` here until its provenance formula is
 * written — the compiler enforces the same completeness the test fences.
 */
export const KPI_PROVENANCE: Record<KpiId, KpiProvenance> = {
  rabies_coverage_dogs_12m: {
    formulaEs:
      "Perros del padrón con al menos una vacuna antirrábica en los últimos 12 meses ÷ perros activos o extraviados del padrón × 100.",
  },
  rabies_vaccination_rate_all_species: {
    formulaEs:
      "Mascotas activas de cualquier especie con al menos una dosis antirrábica registrada alguna vez ÷ mascotas activas del padrón × 100 (histórico, sin ventana temporal).",
  },
  sterilization_coverage_population: {
    formulaEs:
      "Mascotas con al menos una esterilización registrada, alguna vez ÷ mascotas activas o extraviadas del alcance × 100.",
  },
  sterilizations_per_month: {
    formulaEs:
      "Esterilizaciones registradas en los últimos 30 días; la variación compara contra los 30 días previos.",
  },
  bites_per_10k: {
    formulaEs:
      "Mordeduras reportadas en los últimos 12 meses ÷ (población humana del censo ÷ 10.000).",
  },
  active_zoonosis_signals: {
    formulaEs:
      "Señales activas: unión de mascotas con observación rábica en curso o caso de mordedura abierto (sin duplicar), más notificaciones de leptospirosis e hidatidosis de los últimos 30 días.",
  },
  open_rabies_observations: {
    formulaEs: "Mascotas con una observación antirrábica en curso, al momento de la consulta.",
  },
  open_bite_cases: {
    formulaEs: "Expedientes de mordedura abiertos, al momento de la consulta.",
  },
  notified_diseases: {
    formulaEs:
      "Eventos de enfermedad notificada registrados en los últimos 30 días (todas las enfermedades, no solo leptospirosis e hidatidosis).",
  },
  microchip_penetration: {
    formulaEs:
      "Mascotas activas o extraviadas con microchip ISO activo ÷ mascotas activas o extraviadas del alcance × 100.",
  },
  // Mandated-denominator family (jurisdiction-compliance WU4a) — the honest
  // twins: same numerators as sus gemelas brutas, denominator restricted to
  // jurisdictions whose RESOLVED rules actually mandate the obligation.
  microchip_compliance_mandated: {
    formulaEs:
      "Mascotas activas o extraviadas con microchip ISO activo ÷ mascotas activas o extraviadas SOLO en jurisdicciones cuya normativa cargada declara el microchip obligatorio × 100.",
  },
  rabies_compliance_mandated: {
    formulaEs:
      "Perros activos o extraviados con dosis antirrábica vigente (últimos 12 meses) ÷ perros activos o extraviados SOLO en jurisdicciones cuya normativa cargada declara la vacunación obligatoria × 100.",
  },
  sterilization_compliance_mandated: {
    formulaEs:
      "Mascotas activas o extraviadas con al menos una esterilización registrada ÷ mascotas activas o extraviadas SOLO en jurisdicciones cuya normativa cargada declara la esterilización obligatoria × 100.",
  },
  ppp_registry_compliance: {
    formulaEs:
      "Mascotas PPP con atestación registrada en miMAR ÷ mascotas PPP activas × 100 (mide adopción del flujo en la plataforma, no cumplimiento registral externo).",
  },
  open_welfare_reports: {
    formulaEs:
      "Denuncias ciudadanas sin estado terminal (ni cerradas ni duplicadas), al momento de la consulta.",
  },
  my_assigned_welfare_reports: {
    formulaEs:
      "Denuncias de maltrato asignadas a tu usuario, sin estado terminal y sin moderación pendiente, al momento de la consulta.",
  },
  mortality_disposal_traceability: {
    formulaEs:
      "Fallecimientos con método de disposición conocido e instalación registrada ÷ fallecimientos del período × 100.",
  },
  mortality_deaths_12m: {
    formulaEs:
      "Fallecimientos registrados en los últimos 12 meses (conteo; la trazabilidad que lo acompaña usa esta misma base).",
  },
  active_pregnancies: {
    formulaEs: "Mascotas con preñez en curso registrada, al momento de la consulta.",
  },
  sterilization_natalidad_ratio: {
    formulaEs:
      "Esterilizaciones del período ÷ nacimientos vivos registrados en el mismo período (solo preñeces en seguimiento — subestima la natalidad real).",
  },
  data_quality_completeness: {
    formulaEs:
      "Mascotas con localidad, sexo conocido y microchip activo ÷ mascotas activas o extraviadas del alcance × 100.",
  },
  custody_return_rate: {
    formulaEs:
      "Adopciones revertidas en el período ÷ adopciones finalizadas en el mismo período × 100 (conteos independientes, no una cohorte seguida).",
  },
  shelter_occupancy_national: {
    formulaEs:
      "Custodias de refugio activas ÷ capacidad total declarada por los refugios × 100 (nacional; capacidad autoinformada).",
  },
  deworming_coverage_population: {
    formulaEs:
      "Mascotas con al menos una desparasitación en los últimos 12 meses ÷ mascotas activas o extraviadas del alcance × 100.",
  },
  vet_access_per_1k_locality: {
    formulaEs:
      "Actos veterinarios del período por localidad ÷ (mascotas activas de la localidad ÷ 1.000).",
  },
  movement_volume: {
    formulaEs:
      "Movimientos registrados en el período, desglosados por tipo (cambio de jurisdicción, CVI emitido, transporte).",
  },
  adoption_application_conversion: {
    formulaEs:
      "Postulaciones de adopción aprobadas ÷ postulaciones presentadas en el período × 100 (conteos independientes, no una cohorte seguida).",
  },
  eno_sla_compliance: {
    formulaEs:
      "Notificaciones ENO entregadas dentro del plazo ÷ notificaciones ENO entregadas en el período × 100 (mide la cola interna, no la entrega externa).",
  },
  reunification_rate: {
    formulaEs:
      "Episodios de pérdida de los últimos 30 días que volvieron a estado activo ÷ episodios de pérdida de la misma ventana × 100.",
  },
  bite_escalation_gap: {
    formulaEs:
      "Dos conteos independientes mostrados en par: mordeduras reportadas en los últimos 12 meses junto a observaciones rábicas abiertas ahora — no es una fracción.",
  },
  outbreak_signals_untriaged: {
    formulaEs:
      "Se\u00f1ales de brote de los \u00faltimos 30 d\u00edas que no tienen ning\u00fan expediente de investigaci\u00f3n vinculado. Se lee contra 'Casos bajo investigaci\u00f3n activa': un cero all\u00e1 con un n\u00famero alto ac\u00e1 significa que nadie tri\u00f3, no que no pase nada.",
  },
  outbreak_active_signals: {
    formulaEs:
      "Señales de brote registradas en los últimos 30 días (cuenta avisos emitidos dentro de la ventana, no señales 'abiertas': una señal no tiene estado que se cierre).",
  },
  rabies_observation_cases_open: {
    formulaEs:
      "Expedientes de mordedura abiertos o escalados, al momento de la consulta (cuenta expedientes, no mascotas en observación).",
  },
  pets_registered_today: {
    formulaEs:
      "Mascotas dadas de alta desde las 00:00 de hoy, hora argentina (día en curso, parcial).",
  },
  vaccinations_weekly: {
    formulaEs:
      "Vacunaciones registradas en los últimos 7 días; la variación compara contra los 7 días previos.",
  },
  outbreak_investigations_active: {
    formulaEs:
      "Expedientes de investigación de brote abiertos o escalados, al momento de la consulta.",
  },
  rabies_observation_compliance_10d: {
    formulaEs:
      "Observaciones rábicas cerradas dentro del plazo legal ÷ observaciones cerradas en el período × 100.",
  },
  amr_density: {
    formulaEs:
      "Inicios de tratamiento antimicrobiano del período ÷ (mascotas activas del alcance ÷ 1.000).",
  },
  registry_total_pets: {
    formulaEs: "Mascotas con estado activo o extraviado en el padrón, al momento de la consulta.",
  },
  queue_oldest_pending_days: {
    formulaEs:
      "Días transcurridos desde la creación de la solicitud pendiente más antigua de la cola de aprobaciones.",
  },
  alerted_provinces_below_target: {
    formulaEs:
      "Provincias con al menos una métrica programática (antirrábica, esterilización o microchip) por debajo de su meta.",
  },
  registry_active_pets: {
    formulaEs: "Mascotas con estado activo (excluye extraviadas), al momento de la consulta.",
  },
  registry_dormant_pets: {
    formulaEs: `Mascotas sin actividad de propietario en los últimos ${TARGETS.DORMANT_MONTHS} meses ÷ mascotas activas o extraviadas del alcance × 100 (excluye escaneos de credencial).`,
  },
  registry_incomplete_profiles: {
    formulaEs:
      "Mascotas sin al menos uno de: microchip activo, sexo conocido o localidad ÷ mascotas activas o extraviadas del alcance × 100.",
  },
  registered_births: {
    formulaEs: "Nacimientos vivos de preñeces en seguimiento registrados en el período.",
  },
  net_registry_inflow: {
    formulaEs:
      "Altas de mascotas más nacimientos registrados, menos fallecimientos del período (balance direccional, no crecimiento poblacional real).",
  },
  shelter_custody_occupied: {
    formulaEs: "Custodias de refugio activas, al momento de la consulta.",
  },
  foster_active_placements: {
    formulaEs: "Colocaciones de tránsito activas, al momento de la consulta.",
  },
  adoptions_finalized: {
    formulaEs:
      "Adopciones finalizadas en el período; la variación compara contra el período previo.",
  },
  campaign_enrollment: {
    formulaEs:
      "Turnos reservados en campañas (confirmados, asistidos o con ausencia) en el período; no cuenta cancelados.",
  },
  campaign_completion_rate: {
    formulaEs: "Turnos asistidos ÷ turnos reservados en el mismo período × 100.",
  },
  campaign_attendance: {
    formulaEs: "Turnos asistidos en campañas en el período.",
  },
  campaign_no_show: {
    formulaEs: "Turnos con ausencia (sin asistencia) en campañas en el período.",
  },
  campaign_sanitary_outcome: {
    formulaEs:
      "Prestaciones sanitarias (vacunación, esterilización o desparasitación) vinculadas a turnos asistidos de campañas en el período.",
  },
  outreach_overdue_rabies_count: {
    formulaEs:
      "Mascotas activas con la antirrábica vencida (más de ~365 días) o nunca vacunadas; el pipeline trae hasta 500 filas, por lo que puede subestimar el total.",
  },
  outreach_stray_scan_areas: {
    formulaEs:
      "Localidades con al menos un escaneo de credencial no-propio en el período (proxy de animal callejero).",
  },
  outreach_sterilization_vets_ranked: {
    formulaEs: "Veterinarios/as con al menos una esterilización registrada en el período.",
  },
  mortality_deaths_period: {
    formulaEs:
      "Fallecimientos registrados en el período seleccionado; la variación compara contra el período previo.",
  },
  mortality_unknown_disposal_rate: {
    formulaEs:
      "Fallecimientos sin método de disposición registrado ÷ fallecimientos del período × 100.",
  },
  mortality_reportable_share: {
    formulaEs:
      "Fallecimientos por enfermedades de notificación obligatoria ÷ fallecimientos del período × 100.",
  },
  lost_pets_active_stock: {
    formulaEs: "Mascotas con estado extraviado, al momento de la consulta.",
  },
  lost_pets_recovered_30d: {
    formulaEs:
      "Recuperaciones (de extraviado a activo) ocurridas en los últimos 30 días, sin importar cuándo empezó el episodio.",
  },
  lost_pets_avg_days_active: {
    formulaEs: "Promedio de días desde la pérdida, entre las mascotas actualmente extraviadas.",
  },
  reunification_median_recovery_days: {
    formulaEs:
      "Mediana de días entre la pérdida y la recuperación, sobre episodios recuperados en los últimos 30 días.",
  },
  acquisition_adoption_rate: {
    formulaEs:
      "Altas por adopción en los últimos 12 meses ÷ altas totales del mismo período × 100.",
  },
  custody_disputes_open: {
    formulaEs: "Disputas de custodia en curso (abiertas o escaladas), al momento de la consulta.",
  },
  seizures_period_count: {
    formulaEs: "Ingresos a refugio por incautación (decomiso) registrados en el período.",
  },
  maltrato_unassigned_count: {
    formulaEs:
      "Denuncias de maltrato sin asignar y sin estado terminal, al momento de la consulta.",
  },
  maltrato_assigned_to_me_count: {
    formulaEs:
      "Denuncias de maltrato asignadas a tu usuario, abiertas o en curso, al momento de la consulta.",
  },
  maltrato_in_progress_count: {
    formulaEs: "Denuncias de maltrato en investigación, al momento de la consulta.",
  },
  maltrato_closed_30d_count: {
    formulaEs: "Denuncias de maltrato cerradas en los últimos 30 días.",
  },
  territorial_index_provinces_evaluated: {
    formulaEs: `Provincias con al menos ${ANONYMITY_K} mascotas activas (piso de anonimato) evaluables para el índice territorial.`,
  },
  territorial_index_average_score: {
    formulaEs:
      "Suma de los puntajes compuestos provinciales (promedio de antirrábica, esterilización y microchip contra sus metas) ÷ provincias evaluadas (promedio simple, no ponderado por población).",
  },
  policy_outcome_rule_changes_analyzed: {
    formulaEs:
      "Cambios de reglas jurisdiccionales con una métrica agregada disponible para comparar su antes y después (ventana fija anclada a cada cambio).",
  },
  ghost_records_count: {
    formulaEs: `Mascotas activas sin titular registrado y sin actividad reciente, en provincias evaluadas (excluye provincias con menos de ${ANONYMITY_K} mascotas activas o sin provincia asignada).`,
  },
  queue_pending_total: {
    formulaEs:
      "Solicitudes de la cola de aprobaciones en estado pendiente, al momento de la consulta.",
  },
  queue_decisions_7d: {
    formulaEs:
      "Aprobaciones más rechazos registrados en los últimos 7 días; la variación compara contra una semana previa aproximada.",
  },
  // Lote D (D-1 / D-5) — the /admin cockpit's eight queues and the two /gob
  // cola tiles that shipped without a descriptor. All are live "now" counts.
  queue_approvals_role_upgrade_vet: {
    formulaEs:
      "Solicitudes de alta de matrícula veterinaria en estado pendiente, al momento de la consulta.",
  },
  queue_approvals_org_verification: {
    formulaEs:
      "Solicitudes de verificación de organizaciones en estado pendiente, a nivel nacional, al momento de la consulta.",
  },
  queue_approvals_service_dog_credential: {
    formulaEs:
      "Solicitudes de verificación de credencial RUPGA (perro de asistencia) en estado pendiente, al momento de la consulta.",
  },
  queue_moderation_pending: {
    formulaEs:
      "Denuncias marcadas por las heurísticas de moderación cuya moderación todavía no fue resuelta, al momento de la consulta.",
  },
  queue_alerts_open: {
    formulaEs:
      "Disparos de alerta en estado no terminal (abiertos), al momento de la consulta — el mismo conteo que alimenta el badge del nav y la bandeja de alertas.",
  },
  queue_outbox_sla_breaches: {
    formulaEs:
      "Filas del outbox todavía pendientes cuyo plazo de SLA de despacho ya venció, al momento de la consulta.",
  },
  queue_cases_open_national: {
    formulaEs:
      "Casos sin fecha de cierre (closed_at nulo) en todo el país, al momento de la consulta.",
  },
  queue_rabies_observations_in_progress: {
    formulaEs:
      "Mascotas cuyo estado de observación antirrábica es «en curso», a nivel nacional, al momento de la consulta.",
  },
  queue_org_verification_scoped: {
    formulaEs:
      "Solicitudes de habilitación de organizaciones pendientes visibles en la jurisdicción del funcionario, al momento de la consulta.",
  },
  queue_regulatory_cases_open: {
    formulaEs:
      "Casos regulatorios abiertos dentro de la jurisdicción (o de la provincia/localidad filtrada), al momento de la consulta.",
  },
};

/** Resolve a KPI's provenance copy. Total by construction (Record<KpiId, …>),
 *  kept as a function so call sites mirror `getKpiInfo(id)`. */
export function getKpiProvenance(id: KpiId): KpiProvenance {
  return KPI_PROVENANCE[id];
}

// ---------------------------------------------------------------------------
// es-AR renderings of the catalog's machine-readable window/basis tags — the
// ProvenanceCard's "Período / base temporal" line when the render site does
// not thread a live period label. These RESTATE what the catalog declares
// (the same axis `derivedPeriodInvariant` reads); they never recompute a
// window from data.
// ---------------------------------------------------------------------------

const WINDOW_LABEL_ES: Record<KpiWindow, string> = {
  now: "Al momento de la consulta",
  "7d": "Últimos 7 días",
  "30d": "Últimos 30 días",
  "12m": "Últimos 12 meses",
  all_time: "Histórico, sin ventana temporal",
  period: "Según el período seleccionado en la vista",
  mixed: "Ventanas mixtas (ver la definición de la métrica)",
};

const BASIS_LABEL_ES: Record<KpiBasis, string> = {
  stock: "stock (foto a un momento dado)",
  flow: "flujo (eventos de la ventana)",
  ratio: "razón (numerador sobre denominador)",
};

/** "Últimos 12 meses · razón (numerador sobre denominador)" — catalog-static. */
export function describeWindowBasisEs(window: KpiWindow, basis: KpiBasis): string {
  return `${WINDOW_LABEL_ES[window]} · ${BASIS_LABEL_ES[basis]}`;
}
