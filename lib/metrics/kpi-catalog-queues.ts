// lib/metrics/kpi-catalog-queues.ts — the OPERATIONAL-QUEUE slice of the KPI catalog.
//
// WHY THIS MODULE EXISTS (two reasons, both structural)
// -----------------------------------------------------
// 1. Lote D / D-1: the /admin home cockpit (components/admin/QueueHealthCockpit.tsx)
//    rendered eight queue tiles through a bespoke `QueueTile` — a label, a raw
//    count and an ad-hoc tone, with NO descriptor, no ⓘ, no "Ver origen". It was
//    the largest descriptor-less reporting surface of either operator portal.
//    Every one of those tiles now resolves a descriptor from here, and so do the
//    two /gob home cola tiles that had none ("Habilitación de organizaciones",
//    "Casos regulatorios" — D-5).
// 2. kpi-catalog.ts sits at its EXACT file-size ratchet ceiling
//    (scripts/file-size-baseline.json, check-file-size.ts) and may not grow —
//    the same constraint that already pushed kpi-guards.ts, kpi-target-copy.ts
//    and kpi-provenance.ts out of it. The three pre-existing `queue_*`
//    descriptors moved here with their comments intact so the whole queue family
//    lives in one place rather than being split by an accident of file size.
//
// CONTRACT: these are ordinary `KpiDefinition`s — kpi-catalog.ts spreads
// QUEUE_KPI_CATALOG into KPI_CATALOG, so `KPI_CATALOG.<id>` / `getKpiInfo` /
// `getKpiProvenance` / <OpKpi descriptorId> all behave identically to an entry
// declared in the main file. scripts/check-metric-contract.ts parses BOTH files
// for guard declarations, so the dead-guard rule keeps covering these.
//
// LABEL PRECISION (same lesson queue_pending_total already learned, see its own
// comment): a catalogued label RESERVES that exact string repo-wide — the
// registry-import fence (scripts/check-metric-labels.ts) then fails any .tsx
// that retypes it. Several tiles' original copy was a generic UI noun already in
// use as a page title, a choropleth scale label or a filter option ("Casos
// abiertos", "Moderación de denuncias", "Credenciales RUPGA"), which are
// genuinely OTHER surfaces, not this metric. So each label below is qualified
// until it names one metric and one only — and the render sites display exactly
// that qualified string, because a tile whose name differs from its descriptor's
// name is the very drift this catalog exists to stop.
//
// SHARED HONESTY NOTE for every entry below: an operational queue has no legal
// or programmatic TARGET — "zero pending" is not a statute, it is an operator's
// preference. So none of these carry `target`, and all declare
// `semaphore: { paintAgainst: "none" }`: the warm tone a tile paints when a
// queue is non-empty is a WORKLOAD signal, never a compliance verdict. The one
// tile whose non-zero value IS a missed deadline (outbox SLA breaches) says so
// in its own caveat rather than borrowing a target it does not have.

import type { KpiDefinition } from "./kpi-catalog";

/** Stable ids for the operational-queue descriptors. Snake_case, never reused. */
export type QueueKpiId =
  | "queue_pending_total"
  | "queue_decisions_7d"
  | "queue_oldest_pending_days"
  | "queue_approvals_role_upgrade_vet"
  | "queue_approvals_org_verification"
  | "queue_approvals_service_dog_credential"
  | "queue_moderation_pending"
  | "queue_alerts_open"
  | "queue_outbox_sla_breaches"
  | "queue_cases_open_national"
  | "queue_rabies_observations_in_progress"
  | "queue_org_verification_scoped"
  | "queue_regulatory_cases_open";

export const QUEUE_KPI_CATALOG: Record<QueueKpiId, KpiDefinition> = {
  queue_pending_total: {
    id: "queue_pending_total",
    // C1 label precision (2026-07-22): renamed from bare "Cola pendiente" —
    // that string collided (registry-import fence, lint:metric-labels) with
    // the SAME KPI rendered on components/admin/AdminKpiStrip.tsx (outside
    // this sweep's scope) and generic comment prose elsewhere discussing
    // "the pending queue" informally. The disambiguating "(aprobaciones)"
    // suffix is gone as of the PO interview 2026-07-23 nav rename ("Cola" →
    // "Aprobaciones", item 5): the word itself now disambiguates from
    // moderación/alertas/outbox queues, so the parenthetical is redundant.
    // AdminKpiStrip.tsx's twin was renamed the same way — still allowlisted
    // in scripts/check-metric-labels.ts under the new name (national vs
    // jurisdiction-scoped wording, same legitimate reuse as before).
    label: "Aprobaciones pendientes",
    numerator: "COUNT approval-queue rows where status='pending', in scope",
    denominator: "n/a — absolute count",
    source: "cola de aprobaciones (ver fetchQueueHealth / fetchQueueHealthScoped)",
    fetcherName: "fetchQueueHealth (admin) / fetchQueueHealthScoped (govt) (pendingTotal)",
    fetcherPath: "lib/analytics/admin-metrics.ts",
    cadence: "'now' live snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Sin meta formal — el tono de atención (ámbar cuando >0) es una señal operativa de carga de trabajo, no un veredicto de cumplimiento.",
    window: "now",
    species: "n/a",
    basis: "stock",
    methodologyVersion: 2, // K8: label renamed 2026-07-22/23 (see above)
    question: "¿Cuántas solicitudes de aprobación están pendientes en la cobertura?",
    semaphore: { paintAgainst: "none" },
  },

  // T4.10 (2026-08-01): AdminKpiStrip's delta painted a colored verdict against ANY prior-week base, incl. 1-2 decisions — noise, not a trend.
  queue_decisions_7d: {
    id: "queue_decisions_7d",
    label: "Decisiones 7d",
    numerator: "COUNT request_approved + request_rejected audit_log rows in the trailing 7 days",
    denominator: "n/a — flow count vs an approximated prior-7d baseline (decisionsDeltaPct)",
    source: "audit_log (request_approved, request_rejected)",
    fetcherName: "fetchDecisionsMetrics",
    fetcherPath: "lib/analytics/admin-metrics.ts",
    cadence: "trailing 7d vs an approximated prior 7d (decisionsDeltaPct, lib/metrics/targets.ts)",
    unit: "count",
    suppression: "none",
    caveat:
      "Sin baseline dedicado de semana previa — se aproxima desde los días 8-30 de la ventana de 30d (decisionsDeltaPct). Compartido por /admin y /admin/sistema (C28).",
    window: "7d",
    species: "n/a",
    basis: "flow",
    question: "¿Cuántas decisiones se tomaron esta semana y cómo viene la tendencia?",
    semaphore: { paintAgainst: "none" },
    // Same floor as sterilizations_per_month — below priorBase=5 the % swing is noise.
    guards: { unstableDeltaBase: { minPriorBase: 5 } },
    ui: {
      definition:
        "Decisiones (aprobaciones + rechazos) tomadas en los últimos 7 días, con variación vs la semana anterior (aproximada).",
      formula: "request_approved + request_rejected en audit_log (últimos 7d) vs semana previa",
    },
  },

  queue_oldest_pending_days: {
    id: "queue_oldest_pending_days",
    label: "Antigüedad de la cola de aprobaciones",
    numerator: "MAX(now() − created_at) sobre filas pendientes de la cola de aprobaciones, en días",
    denominator:
      "n/a — absolute count (days), paired with pendingTotal / pending14dPlus / pending30dPlus / pending60dPlus buckets",
    source: "cola de aprobaciones (ver fetchQueueHealth / fetchQueueHealthScoped)",
    fetcherName: "fetchQueueHealth (admin) / fetchQueueHealthScoped (govt)",
    fetcherPath: "lib/analytics/admin-metrics.ts",
    cadence: "'now' live snapshot",
    unit: "days",
    suppression: "none",
    caveat:
      "Los umbrales de color (14/30 días) son heurísticas operativas internas, no una meta legal o programática con fuente citable — por eso semaphore: none pese a que el tile sigue pintando ámbar/rojo por antigüedad.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question:
      "¿Cuántos días de antigüedad tiene la solicitud pendiente más vieja en la cola de aprobaciones?",
    semaphore: { paintAgainst: "none" },
  },

  // -------------------------------------------------------------------------
  // D-1 — the /admin home cockpit's eight tiles. The three approval tiles read
  // the SAME single aggregate query (fetchApprovalQueueByType) as
  // queue_pending_total above, split per `approval_requests.type`; each names
  // its own field in `fetcherName` so the /gob-home coverage test and
  // findKpiByFetcherName can still tell them apart.
  // -------------------------------------------------------------------------

  queue_approvals_role_upgrade_vet: {
    id: "queue_approvals_role_upgrade_vet",
    label: "Matrículas veterinarias por verificar",
    numerator:
      "COUNT approval_requests where status='pending' AND type='role_upgrade_vet' (national, unscoped)",
    denominator: "n/a — absolute count",
    source: "approval_requests",
    fetcherName: "fetchApprovalQueueByType (roleUpgradeVet)",
    fetcherPath: "lib/analytics/admin-metrics.ts",
    cadence: "'now' live snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Cuenta SOLICITUDES pendientes de verificación de matrícula, no veterinarios con matrícula verificada. Un 0 aquí significa 'nada esperando decisión', nunca 'no hay matrículas sin verificar' — una matrícula nunca presentada no genera fila.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántas solicitudes de alta de matrícula veterinaria esperan una decisión?",
    semaphore: { paintAgainst: "none" },
    ui: {
      definition:
        "Solicitudes de verificación de matrícula veterinaria pendientes de decisión, a nivel nacional.",
      formula: "COUNT approval_requests WHERE status='pending' AND type='role_upgrade_vet'",
      caveat:
        "Un profesional que nunca envió su matrícula no aparece acá: la cola mide lo presentado, no lo faltante.",
    },
  },

  queue_approvals_org_verification: {
    id: "queue_approvals_org_verification",
    label: "Verificación de organizaciones (nacional)",
    numerator:
      "COUNT approval_requests where status='pending' AND type='organization_verification' (national, unscoped)",
    denominator: "n/a — absolute count",
    source: "approval_requests",
    fetcherName: "fetchApprovalQueueByType (organizationVerification)",
    fetcherPath: "lib/analytics/admin-metrics.ts",
    cadence: "'now' live snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Vista NACIONAL de la misma cola que /gob ve acotada a su jurisdicción (queue_org_verification_scoped, otro fetcher y otro predicado de scope) — los dos números pueden diferir legítimamente.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántas organizaciones esperan una decisión de verificación?",
    semaphore: { paintAgainst: "none" },
    ui: {
      definition:
        "Solicitudes de verificación de organizaciones pendientes de decisión, a nivel nacional.",
      formula:
        "COUNT approval_requests WHERE status='pending' AND type='organization_verification'",
    },
  },

  queue_approvals_service_dog_credential: {
    id: "queue_approvals_service_dog_credential",
    label: "Credenciales RUPGA por verificar",
    numerator:
      "COUNT approval_requests where status='pending' AND type='service_dog_credential_verification'",
    denominator: "n/a — absolute count",
    source: "approval_requests",
    fetcherName: "fetchApprovalQueueByType (serviceDogCredentialVerification)",
    fetcherPath: "lib/analytics/admin-metrics.ts",
    cadence: "'now' live snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Credenciales de perro de asistencia (RUPGA) presentadas y aún sin decidir. No mide el padrón de perros de asistencia acreditados.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántas credenciales RUPGA esperan verificación?",
    semaphore: { paintAgainst: "none" },
    ui: {
      definition:
        "Credenciales de perro de asistencia (RUPGA) presentadas y pendientes de verificación.",
      formula:
        "COUNT approval_requests WHERE status='pending' AND type='service_dog_credential_verification'",
    },
  },

  queue_moderation_pending: {
    id: "queue_moderation_pending",
    label: "Denuncias en moderación",
    numerator:
      "COUNT welfare_reports where flagged_at IS NOT NULL AND moderation_resolved_at IS NULL",
    denominator: "n/a — absolute count",
    source: "welfare_reports",
    fetcherName: "countModerationPending",
    fetcherPath: "lib/analytics/admin-metrics.ts",
    cadence: "'now' live snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Cuenta denuncias MARCADAS por las heurísticas de moderación y todavía sin resolver — mismo predicado que el filtro «Pendientes» de la etapa Moderación del hub de Denuncias. Una denuncia problemática que las heurísticas no marcaron no está acá.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántas denuncias marcadas por moderación esperan resolución?",
    semaphore: { paintAgainst: "none" },
    ui: {
      definition:
        "Denuncias marcadas por las heurísticas de moderación y todavía sin resolver, en todo el país.",
      formula:
        "COUNT welfare_reports WHERE flagged_at IS NOT NULL AND moderation_resolved_at IS NULL",
      caveat: "Solo lo que las heurísticas marcaron: no es una auditoría de todas las denuncias.",
    },
  },

  queue_alerts_open: {
    id: "queue_alerts_open",
    label: "Alertas disparadas abiertas",
    numerator: "COUNT alert firings in a non-terminal state (countOpenAlertFirings)",
    denominator: "n/a — absolute count",
    source: "alert_firings (ver lib/metrics/alert-firing-inbox)",
    fetcherName: "countOpenAlertFirings",
    fetcherPath: "lib/metrics/alert-firing-inbox.ts",
    cadence: "'now' live snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Cuenta disparos de alerta abiertos, no condiciones de alerta existentes: una regla que nadie configuró nunca dispara. El mismo helper alimenta el badge del nav y la bandeja /admin/alertas, así que las tres superficies no pueden divergir.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántas alertas disparadas siguen abiertas y sin cerrar?",
    semaphore: { paintAgainst: "none" },
    ui: {
      definition: "Disparos de alerta en estado no terminal (abiertos), en todo el país.",
      caveat:
        "Depende de qué reglas de alerta estén configuradas: sin regla no hay disparo, y un 0 no prueba ausencia de riesgo.",
    },
  },

  queue_outbox_sla_breaches: {
    id: "queue_outbox_sla_breaches",
    label: "Vencimientos de SLA (outbox)",
    numerator: "COUNT outbox rows still pending AND past their SLA deadline (countOutboxBreaches)",
    denominator: "n/a — absolute count",
    source: "outbox (ver lib/infra/outbox-queries)",
    fetcherName: "countOutboxBreaches",
    fetcherPath: "lib/infra/outbox-queries.ts",
    cadence: "'now' live snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "A diferencia del resto de las colas, un valor > 0 acá SÍ es un plazo incumplido (el SLA interno de despacho del outbox), y por eso el tile pinta rojo y no ámbar. Sigue sin `target`: el SLA es una definición operativa del sistema, no una meta legal citable.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántos despachos del outbox pasaron su plazo de SLA sin salir?",
    semaphore: { paintAgainst: "none" },
    ui: {
      definition: "Filas del outbox todavía pendientes que ya pasaron su plazo de SLA de despacho.",
      caveat: "Es un incumplimiento de plazo interno del sistema, no una infracción normativa.",
    },
  },

  queue_cases_open_national: {
    id: "queue_cases_open_national",
    label: "Casos abiertos (nacional)",
    numerator: "COUNT cases where closed_at IS NULL (national, unscoped)",
    denominator: "n/a — absolute count",
    source: "cases",
    fetcherName: "countOpenCases (admin-metrics)",
    fetcherPath: "lib/analytics/admin-metrics.ts",
    cadence: "'now' live snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "«Abierto» = closed_at IS NULL — el mismo predicado que la vista por defecto de /admin/casos, así que incluye estados no terminales (escalated/in_progress) que una lista de status codificada a mano se perdería. INVENTARIO en curso, no una alarma: el tile se pinta neutro a propósito, cualquiera sea el número (W2). Vista NACIONAL; el gemelo jurisdiccional es queue_regulatory_cases_open.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántos casos siguen abiertos en toda la plataforma?",
    semaphore: { paintAgainst: "none" },
    ui: {
      definition: "Casos sin cerrar (closed_at IS NULL) en todo el país, en este momento.",
      formula: "COUNT cases WHERE closed_at IS NULL",
      caveat:
        "Es inventario de trabajo en curso, no una cola vencida: el tile no pinta tono de alarma por más alto que sea.",
    },
  },

  queue_rabies_observations_in_progress: {
    id: "queue_rabies_observations_in_progress",
    label: "Observaciones antirrábicas abiertas",
    numerator:
      "COUNT pets where rabies_observation_status IN ('in_progress','window_expired_unclosed') (national, unscoped)",
    denominator: "n/a — absolute count",
    source: "pets (rabies_observation_status)",
    fetcherName: "countRabiesInProgress",
    fetcherPath: "lib/analytics/admin-metrics.ts",
    cadence: "'now' live snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Observaciones ABIERTAS: en curso, o con el período vencido y sin cierre profesional (estado agregado el 2026-08-17, cuando el barrido dejó de cerrarlas como negativas por su cuenta). /admin/observaciones además lista las cerradas hace poco, así que un 0 acá convive legítimamente con una lista no vacía (red-team-admin #3). No mide cumplimiento del plazo legal — eso es rabies_observation_compliance_10d.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántas mascotas tienen hoy una observación antirrábica sin cerrar?",
    semaphore: { paintAgainst: "none" },
    ui: {
      definition:
        "Mascotas con una observación antirrábica sin cerrar en este momento, en todo el país: en curso, o con el período vencido y sin cierre profesional.",
      formula:
        "COUNT pets WHERE rabies_observation_status IN ('in_progress','window_expired_unclosed')",
      caveat:
        "No dice si esas observaciones están dentro del plazo legal (Ley 22.953) — esa es otra métrica.",
    },
  },

  // -------------------------------------------------------------------------
  // D-5 — the two /gob home cola tiles that shipped without a descriptor while
  // their three siblings had one. Both are JURISDICTION-SCOPED twins of admin
  // queues above: different fetcher, different scope predicate, so they are
  // separate descriptors rather than a reused id.
  // -------------------------------------------------------------------------

  queue_org_verification_scoped: {
    id: "queue_org_verification_scoped",
    label: "Habilitación de organizaciones (jurisdicción)",
    numerator:
      "COUNT pending approval_requests of type='organization_verification' VISIBLE to the actor (same visibleRequestsClause scope predicate as countVisiblePendingRequests)",
    denominator: "n/a — absolute count",
    source: "approval_requests (scoped by the viewer's jurisdictions)",
    fetcherName: "countVisiblePendingRequestsByType (organization_verification)",
    fetcherPath: "lib/analytics/govt-home-kpis.ts",
    cadence: "'now' live snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Acotado a la jurisdicción del funcionario por el MISMO predicado de visibilidad que la cola de aprobaciones (visibleRequestsClause) — puede diferir del total nacional (queue_approvals_org_verification) sin que ninguno esté mal.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántas organizaciones de mi jurisdicción esperan una decisión de habilitación?",
    semaphore: { paintAgainst: "none" },
    ui: {
      definition:
        "Solicitudes de habilitación de organizaciones pendientes de decisión, visibles en tu jurisdicción.",
      caveat: "Es tu recorte jurisdiccional: el número nacional que ve Admin puede ser mayor.",
    },
  },

  queue_regulatory_cases_open: {
    id: "queue_regulatory_cases_open",
    label: "Casos regulatorios abiertos",
    numerator:
      "COUNT open cases matching CASOS_QUEUE_FILTERS within the viewer's jurisdiction (countCasesForGovt) or the selected province/locality (countCasesForAdmin)",
    denominator: "n/a — absolute count",
    source: "cases (scoped by the viewer's jurisdictions / the active filter)",
    fetcherName: "countCasesForGovt / countCasesForAdmin",
    fetcherPath: "lib/infra/case-queries.ts",
    cadence: "'now' live snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Cuenta y enlace comparten el MISMO filtro de jurisdicción activo: un tile que cuenta una provincia y linkea a la lista nacional sería la misma mentira dicha dos veces. Gemelo jurisdiccional de queue_cases_open_national (otro fetcher, otro scope).",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántos casos regulatorios abiertos hay en mi jurisdicción?",
    semaphore: { paintAgainst: "none" },
    ui: {
      definition:
        "Casos regulatorios abiertos en tu jurisdicción (o en la provincia/localidad filtrada), en este momento.",
      caveat:
        "El número respeta el filtro de jurisdicción activo en la pantalla, igual que el enlace del tile.",
    },
  },
};
