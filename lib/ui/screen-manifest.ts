// lib/ui/screen-manifest.ts — the screen-decision manifest (C6a primitive).
//
// dim-interno:docs/reviews/results/2026-07-22-plan-maestro-integridad.md §C6: "Toda
// pantalla declara su decisión dueña (manifest por pantalla — la lente D3 de
// nuestro audit, ahora obligatoria); si no hay decisión, es reporte o cola,
// no dashboard." This module is the first primitive of that fence: a typed
// registry mapping every gob/admin route to (a) the 5-layer + bandeja model
// it belongs to and (b) the ONE es-AR sentence describing what the operator
// DECIDES there. Queue-shaped screens (Bandeja operativa) get an action
// sentence ("¿tomo/apruebo/resuelvo X?") instead of an analytical question —
// that IS their decision.
//
// SCOPE (2026-07-22, C6a first cut): populated for every top-level gob nav
// route (the 27 items regrouped in components/layout/nav-presets.ts) plus
// their admin twins/admin-only equivalents. Nested detail/form/export routes
// ([id], [publicCode], /nuevo, /export…) are NOT covered here — they are
// grandfathered in scripts/screen-manifest-baseline.json until a future sweep
// gives them their own entries (most are drill-downs FROM an already-declared
// decision, not new dashboard surfaces).
//
// Fence: scripts/check-screen-manifest.ts (pnpm lint:screens) — every
// app/gob/**/page.tsx and app/admin/**/page.tsx route must resolve to an
// entry here OR be listed in the baseline. It also cross-checks that a
// route's `layer` here agrees with the NAV SECTION it actually renders under
// in nav-presets.ts (manifest↔nav consistency — see that script's comments
// for why the two stay separate modules instead of one reading the other).

/** The 5 layers + the cross-cutting queue layer (C6 primitive concept). */
export type ScreenLayer =
  | "briefing"
  | "situacion"
  | "programa"
  | "intervencion"
  | "bandeja"
  | "profundidad";

export type ScreenManifestEntry = {
  /** The route this entry describes, e.g. "/gob/casos". */
  route: string;
  layer: ScreenLayer;
  /**
   * ONE es-AR sentence: what the operator DECIDES on this screen. Analytical
   * surfaces phrase it as a question ("¿dónde se concentra el riesgo?");
   * queue-shaped surfaces phrase it as the action itself ("¿apruebo o
   * rechazo esta solicitud?") — a bandeja's decision IS its per-row action.
   */
  decision: string;
};

/**
 * Reuses a gob entry's decision text for its admin twin (portal-follows-
 * viewer routes: same screen, same question, different chrome/scope). Keeps
 * the two portals' decisions from silently drifting apart — see the module
 * header for why this stays a helper instead of collapsing nav-presets.ts
 * into reading this manifest directly.
 */
function twin(
  adminRoute: string,
  gobEntry: ScreenManifestEntry,
  layer: ScreenLayer,
): ScreenManifestEntry {
  return { route: adminRoute, layer, decision: gobEntry.decision };
}

// ---------------------------------------------------------------------------
// /gob — the 27 top-level nav routes (C6a regroup), grouped by layer to
// mirror components/layout/nav-presets.ts's GOB_NAV_SECTIONS order.
// ---------------------------------------------------------------------------

const GOB_PANEL: ScreenManifestEntry = {
  route: "/gob",
  layer: "briefing",
  // C6b (2026-07-22, plan-maestro-integridad.md §C6): the home page IS the
  // briefing now — a ranked, capped-at-5 "Alertas priorizadas" hero
  // (lib/metrics/briefing-alerts.ts) instead of a KPI wall. This decision
  // sentence names the bounded shape ("3 cosas", not an open-ended list) the
  // PO locked for the briefing layer.
  decision: "¿Qué 3 cosas priorizo hoy?",
};

const GOB_PANORAMA: ScreenManifestEntry = {
  route: "/gob/panorama",
  layer: "situacion",
  decision: "¿Dónde se concentra el riesgo ahora mismo en el mapa de mi jurisdicción?",
};

const GOB_VIGILANCIA: ScreenManifestEntry = {
  route: "/gob/vigilancia",
  layer: "situacion",
  decision: "¿Hay brotes o zoonosis activos que requieren intervención epidemiológica?",
};

const GOB_PERDIDAS: ScreenManifestEntry = {
  route: "/gob/perdidas",
  layer: "situacion",
  decision: "¿Qué mascotas perdidas siguen sin reunificar y necesitan seguimiento?",
};

// F9 fusion (2026-08-01, PO decision on an external-QA navigation gate — two
// nav destinations shared one noun): this screen now OWNS both the
// outcome-vs-target question (resumen, the default) and the depth question
// (analitica) as tabbed vistas.
const GOB_PROGRAMA: ScreenManifestEntry = {
  route: "/gob/programa",
  layer: "programa",
  decision: "¿Estamos cumpliendo el programa en tu jurisdicción, y qué hay detrás de esos números?",
};

// F8 fusion (2026-07-22) — ABSORBED into GOB_PADRON as the "poblacion"
// vista (the default). This route still exists as a page.tsx file
// (permanent redirect into /gob/padron?vista=poblacion, preserving query
// params — see lib/ui/padron-hub-redirect.ts), so it still needs a manifest
// entry to satisfy the coverage fence; it has no nav entry anymore
// (nav-presets.ts GOB_NAV_SECTIONS).
const GOB_POBLACION: ScreenManifestEntry = {
  route: "/gob/poblacion",
  layer: "programa",
  decision: "[Absorbida] Redirige a /gob/padron?vista=poblacion — ver GOB_PADRON.",
};

// F8 fusion (2026-07-22) — ABSORBED into GOB_PADRON as the "censo" vista.
// Same redirect-shim shape as GOB_POBLACION above.
const GOB_CENSO: ScreenManifestEntry = {
  route: "/gob/censo",
  layer: "programa",
  decision: "[Absorbida] Redirige a /gob/padron?vista=censo — ver GOB_PADRON.",
};

// F8 fusion (2026-07-22, PO-approved route unification — both are
// registry-derived Programa surfaces the registry manager reads together):
// this screen now OWNS both the policy-target question (población) and the
// registry-health question (censo) as tabbed vistas.
const GOB_PADRON: ScreenManifestEntry = {
  route: "/gob/padron",
  layer: "programa",
  decision: "¿Crece sano el padrón y contenemos la población?",
};

// F2 fusion (2026-07-22) — ABSORBED into GOB_OPERATIVOS as the "campanas"
// vista. This route still exists as a page.tsx file (permanent redirect into
// /gob/operativos?vista=campanas, preserving query params — see
// lib/ui/operativos-hub-redirect.ts), so it still needs a manifest entry to
// satisfy the coverage fence; it has no nav entry anymore.
const GOB_CAMPANAS: ScreenManifestEntry = {
  route: "/gob/campanas",
  layer: "programa",
  decision: "[Absorbida] Redirige a /gob/operativos?vista=campanas — ver GOB_OPERATIVOS.",
};

const GOB_MORTALIDAD: ScreenManifestEntry = {
  route: "/gob/mortalidad",
  layer: "programa",
  decision: "¿La disposición de fallecimientos es trazable y está dentro de la meta legal?",
};

const GOB_ADOPCIONES: ScreenManifestEntry = {
  route: "/gob/adopciones",
  layer: "programa",
  decision: "¿El ciclo de custodia y adopción fluye o se traba en algún punto?",
};

// F2 fusion (2026-07-22) — ABSORBED into GOB_OPERATIVOS as the "alcance"
// vista (the default). This route still exists as a page.tsx file (permanent
// redirect into /gob/operativos?vista=alcance), so it still needs a manifest
// entry to satisfy the coverage fence; it has no nav entry anymore.
const GOB_OUTREACH: ScreenManifestEntry = {
  route: "/gob/outreach",
  layer: "intervencion",
  decision: "[Absorbida] Redirige a /gob/operativos?vista=alcance — ver GOB_OPERATIVOS.",
};

// F2 fusion (2026-07-22, PO-approved route unification): this screen now OWNS
// both the action pipeline (alcance) and the conversion readout (campañas)
// for the field coordinator's weekly planning question.
const GOB_OPERATIVOS: ScreenManifestEntry = {
  route: "/gob/operativos",
  layer: "intervencion",
  decision: "¿Dónde y cómo intervengo esta semana — y cómo rindieron los operativos ya lanzados?",
};

const GOB_DECOMISOS: ScreenManifestEntry = {
  route: "/gob/decomisos",
  layer: "intervencion",
  decision: "¿Qué decomiso necesito registrar o completar en su trámite?",
};

// F3+F7 fusion (2026-07-22) — ABSORBED into GOB_DIRECTORIO as the
// "credenciales" registro. This route still exists as a page.tsx file
// (permanent redirect into /gob/directorio?registro=credenciales), so it
// still needs a manifest entry to satisfy the coverage fence; it has no nav
// entry anymore (neither in Intervención nor as a standalone route).
const GOB_RUPGA: ScreenManifestEntry = {
  route: "/gob/rupga",
  layer: "intervencion",
  decision: "[Absorbida] Redirige a /gob/directorio?registro=credenciales — ver GOB_DIRECTORIO.",
};

// G5 (obligations-worklist, 2026-08): the cross-domain deadline worklist —
// the one bandeja ranked by VENCIMIENTO instead of by count. Composes the
// three deadline-bearing domains (observaciones antirrábicas, denuncias de
// maltrato, casos regulatorios) into one flat list, most overdue first.
const GOB_ACCIONES: ScreenManifestEntry = {
  route: "/gob/acciones",
  layer: "bandeja",
  decision: "¿Qué obligación vence primero en mi jurisdicción?",
};

const GOB_DENUNCIAS: ScreenManifestEntry = {
  route: "/gob/denuncias",
  layer: "bandeja",
  // F1 fusion (2026-07-22, PO-approved route unification): this screen now
  // OWNS the whole pipeline — Moderación and Triage are tabbed stages
  // (`?etapa=moderacion|triage`) rendered here, not separate destinations.
  decision:
    "¿En qué etapa del recorrido (moderación, triage, caso) tengo trabajo pendiente — y qué denuncia tomo ahora?",
};

// F1 fusion (2026-07-22) — ABSORBED into GOB_DENUNCIAS as stages. These two
// routes still exist as page.tsx files (permanent redirects into
// /gob/denuncias?etapa=..., preserving query params — see
// lib/ui/denuncias-hub-redirect.ts), so they still need a manifest entry to
// satisfy the coverage fence; neither has a nav entry anymore (nav-presets.ts
// GOB_NAV_SECTIONS). Decision text points at the hub instead of restating a
// decision this screen no longer makes on its own.
const GOB_MODERACION: ScreenManifestEntry = {
  route: "/gob/moderacion",
  layer: "bandeja",
  decision: "[Absorbida] Redirige a /gob/denuncias?etapa=moderacion — ver GOB_DENUNCIAS.",
};

const GOB_MALTRATO: ScreenManifestEntry = {
  route: "/gob/maltrato",
  layer: "bandeja",
  decision: "[Absorbida] Redirige a /gob/denuncias?etapa=triage — ver GOB_DENUNCIAS.",
};

const GOB_COLA: ScreenManifestEntry = {
  route: "/gob/cola",
  layer: "bandeja",
  decision: "¿Apruebo o rechazo esta solicitud pendiente (matrícula, organización, credencial)?",
};

// F6 fusion (2026-07-22, PO-approved route unification — the "expediente"
// family: same legal-administrative operator, identical case-file grammar
// of open/parties/resolve): this screen now OWNS both regulatory cases and
// custody disputes as tabbed expedientes (`?expediente=casos|disputas`).
const GOB_CASOS: ScreenManifestEntry = {
  route: "/gob/casos",
  layer: "bandeja",
  decision: "¿Qué caso regulatorio o disputa de tenencia necesita mi próxima acción?",
};

// F6 fusion (2026-07-22) — ABSORBED into GOB_CASOS as the "disputas"
// expediente. This route still exists as a page.tsx file (permanent
// redirect into /gob/casos?expediente=disputas, preserving query params —
// see lib/ui/casos-hub-redirect.ts), so it still needs a manifest entry to
// satisfy the coverage fence; it has no nav entry anymore (nav-presets.ts
// GOB_NAV_SECTIONS). Admin has no /admin/disputas twin — disputes are a
// /gob-only surface (govt jurisdiction custody), so there is no ADMIN_
// counterpart to this entry.
const GOB_DISPUTAS: ScreenManifestEntry = {
  route: "/gob/disputas",
  layer: "bandeja",
  decision: "[Absorbida] Redirige a /gob/casos?expediente=disputas — ver GOB_CASOS.",
};

const GOB_OUTBOX: ScreenManifestEntry = {
  route: "/gob/outbox",
  layer: "bandeja",
  decision: "¿Qué notificación (ENO u otra) quedó sin entregar y necesito reintentar?",
};

const GOB_SUSCRIPCIONES: ScreenManifestEntry = {
  route: "/gob/suscripciones",
  layer: "bandeja",
  decision: "¿Qué umbral de alerta necesito crear o ajustar para mi jurisdicción?",
};

// F9 fusion (2026-08-01) — ABSORBED into GOB_PROGRAMA as the "analitica"
// vista. The question this screen answered ("¿qué tendencia de fondo explica
// el número que vi en Programa?") was itself the tell: a screen whose decision
// is phrased relative to ANOTHER screen belongs inside it. The route still
// exists as a page.tsx (a permanent redirect into
// /gob/programa?vista=analitica, preserving query params — see
// lib/ui/programa-hub-redirect.ts), so it still needs a manifest entry to
// satisfy the coverage fence; it has no nav entry anymore.
const GOB_ANALYTICS: ScreenManifestEntry = {
  route: "/gob/analytics",
  layer: "programa",
  decision: "[Absorbida] Redirige a /gob/programa?vista=analitica — ver GOB_PROGRAMA.",
};

// Bug fix (qa-triage-2026-07-23, finding #11): /gob/analitica is a pure typo
// alias (app/gob/analitica/page.tsx). Since F9 it redirects DIRECTLY into
// /gob/programa?vista=analitica — not through /gob/analytics — so a mistyped
// URL costs one hop, not two. Same shape as GOB_MODERACION/GOB_MALTRATO above
// (a route that still needs a manifest entry to satisfy the coverage fence,
// but makes no decision of its own).
const GOB_ANALITICA: ScreenManifestEntry = {
  route: "/gob/analitica",
  layer: "programa",
  decision: "[Alias de typo] Redirige a /gob/programa?vista=analitica — ver GOB_PROGRAMA.",
};

const GOB_HISTORIAL: ScreenManifestEntry = {
  route: "/gob/historial",
  layer: "profundidad",
  decision: "¿Qué hice yo (o mi equipo) en los últimos días, para auditar mi propia actividad?",
};

const GOB_REGLAS: ScreenManifestEntry = {
  route: "/gob/reglas",
  layer: "profundidad",
  decision: "¿Qué regla de negocio (SLA, umbral) necesito configurar para mi jurisdicción?",
};

// F3+F7 fusion (2026-07-22) — ABSORBED into GOB_DIRECTORIO as the
// "organizaciones" registro (the default). These three routes still exist as
// page.tsx files (permanent redirects into /gob/directorio?registro=...,
// preserving query params — see lib/ui/directorio-hub-redirect.ts), so they
// still need a manifest entry to satisfy the coverage fence; none has a nav
// entry anymore (nav-presets.ts GOB_NAV_SECTIONS).
const GOB_ORGANIZACIONES: ScreenManifestEntry = {
  route: "/gob/organizaciones",
  layer: "profundidad",
  decision: "[Absorbida] Redirige a /gob/directorio?registro=organizaciones — ver GOB_DIRECTORIO.",
};

const GOB_USUARIOS: ScreenManifestEntry = {
  route: "/gob/usuarios",
  layer: "profundidad",
  decision: "[Absorbida] Redirige a /gob/directorio?registro=usuarios — ver GOB_DIRECTORIO.",
};

const GOB_SERVICIOS: ScreenManifestEntry = {
  route: "/gob/servicios",
  layer: "profundidad",
  decision: "[Absorbida] Redirige a /gob/directorio?registro=servicios — ver GOB_DIRECTORIO.",
};

// F3+F7 fusion (2026-07-22, PO-approved route unification): this screen now
// OWNS registry-entity management across all four registers — same roster
// grammar (search, verify/revoke actions, scope) for each.
const GOB_DIRECTORIO: ScreenManifestEntry = {
  route: "/gob/directorio",
  layer: "profundidad",
  decision:
    "¿Esta entidad (organización, usuario, servicio, credencial RUPGA) es legítima y está bien registrada?",
};

// ---------------------------------------------------------------------------
// /admin — twins reuse the gob decision text (portal-follows-viewer); the
// admin-only surfaces (no gob equivalent) get their own entry.
// ---------------------------------------------------------------------------

const ADMIN_PANEL = twin("/admin", GOB_PANEL, "briefing");
const ADMIN_PANORAMA = twin("/admin/panorama", GOB_PANORAMA, "situacion");
const ADMIN_PROGRAMA = twin("/admin/programa", GOB_PROGRAMA, "programa");

// Admin-only, no gob twin: issuing physical tags is a national supply act, not
// a jurisdictional one. Sits in "programa" next to ADMIN_PROGRAMA, whose
// per-locality demand card is the INPUT to this decision (A1, 2026-08-05).
// Action-shaped surface, so the decision reads as the action.
const ADMIN_CHAPAS: ScreenManifestEntry = {
  route: "/admin/chapas",
  layer: "programa",
  decision: "Emito un lote de chapas en blanco y entrego sus códigos de activación.",
};

// NOT twin()s of GOB_CENSO/GOB_POBLACION: F8 fusion (2026-07-22) absorbed
// both into the gob Padrón hub, but /admin/censo and /admin/poblacion
// redirect into the ADMIN's OWN Padrón hub (/admin/padron — its own hub
// page rendering admin-only screens, not a thin re-export), never
// /gob/padron. Reusing the gob entries' now-"absorbed" decision text would
// point at the wrong hub.
const ADMIN_CENSO: ScreenManifestEntry = {
  route: "/admin/censo",
  layer: "programa",
  decision: "[Absorbida] Redirige a /admin/padron?vista=censo — ver ADMIN_PADRON.",
};
const ADMIN_ADOPCIONES = twin("/admin/adopciones", GOB_ADOPCIONES, "programa");
const ADMIN_POBLACION: ScreenManifestEntry = {
  route: "/admin/poblacion",
  layer: "programa",
  decision: "[Absorbida] Redirige a /admin/padron?vista=poblacion — ver ADMIN_PADRON.",
};
// NOT a twin() of GOB_PADRON either: the admin hub renders genuinely
// different screens (national ranked tables, no jurisdiction filter), but
// it answers the SAME decision question at national scope — twin()'s
// "reuse the gob decision text verbatim" is accurate here (unlike the two
// absorbed shims above, which point at a DIFFERENT hub route).
const ADMIN_PADRON = twin("/admin/padron", GOB_PADRON, "programa");
const ADMIN_COLA = twin("/admin/cola", GOB_COLA, "bandeja");

// NOT a twin() of GOB_CASOS: F6 fusion (2026-07-22) absorbed /gob/disputas
// into the Casos hub as a tabbed expediente, but /admin/casos has no
// disputas twin (disputes are a /gob-only surface — govt jurisdiction
// custody) — it remains its own single-purpose, non-tabbed screen. Reusing
// GOB_CASOS's now-dual-expediente decision text via twin() would incorrectly
// describe this still-cases-only screen. Own entry, own (original,
// pre-fusion) decision.
const ADMIN_CASOS: ScreenManifestEntry = {
  route: "/admin/casos",
  layer: "bandeja",
  decision: "¿Qué caso regulatorio necesita mi próxima acción?",
};

// NOT a twin() of GOB_MODERACION (different route string, same fused
// destination): fix (adversarial-admin 2026-07-23) closed the gap the F1
// fusion (2026-07-22) left open — /admin/moderacion now ALSO permanently
// redirects into /gob/denuncias?etapa=moderacion (see app/admin/moderacion/
// page.tsx), same as its gob twin. Own entry (own route string) so the
// coverage fence still requires one per route, but the decision text now
// points at the hub instead of restating a decision this screen no longer
// makes on its own — same shape as GOB_MODERACION/GOB_MALTRATO above.
const ADMIN_MODERACION: ScreenManifestEntry = {
  route: "/admin/moderacion",
  layer: "bandeja",
  decision: "[Absorbida] Redirige a /gob/denuncias?etapa=moderacion — ver GOB_DENUNCIAS.",
};
const ADMIN_OUTBOX = twin("/admin/outbox", GOB_OUTBOX, "bandeja");
const ADMIN_SUSCRIPCIONES = twin("/admin/suscripciones", GOB_SUSCRIPCIONES, "bandeja");

// NOT twin()s of the absorbed GOB_* entries: F3+F7 fusion (2026-07-22) gave
// admin its OWN /admin/directorio hub (thin re-export mirroring the gob hub's
// tabs, admin-scoped chrome — the "preferred if cheap" admin story) rather
// than bouncing an admin viewer into /gob/directorio. /admin/usuarios,
// /admin/organizaciones and /admin/servicios now redirect into
// /admin/directorio?registro=..., NOT /gob/directorio — twin()'s "reuse the
// gob entry's decision text verbatim" would wrongly describe a redirect
// target that doesn't apply to this portal.
const ADMIN_USUARIOS: ScreenManifestEntry = {
  route: "/admin/usuarios",
  layer: "profundidad",
  decision: "[Absorbida] Redirige a /admin/directorio?registro=usuarios — ver ADMIN_DIRECTORIO.",
};
const ADMIN_ORGANIZACIONES: ScreenManifestEntry = {
  route: "/admin/organizaciones",
  layer: "profundidad",
  decision:
    "[Absorbida] Redirige a /admin/directorio?registro=organizaciones — ver ADMIN_DIRECTORIO.",
};
const ADMIN_SERVICIOS: ScreenManifestEntry = {
  route: "/admin/servicios",
  layer: "profundidad",
  decision: "[Absorbida] Redirige a /admin/directorio?registro=servicios — ver ADMIN_DIRECTORIO.",
};
const ADMIN_DIRECTORIO = twin("/admin/directorio", GOB_DIRECTORIO, "profundidad");
const ADMIN_REGLAS = twin("/admin/reglas", GOB_REGLAS, "profundidad");

// NOT a twin() of GOB_HISTORIAL anymore: audit-trail fusion (2026-08-02)
// absorbed /admin/historial into the Auditoría hub as the "actividad" vista
// — both admin surfaces queried the same audit_log at the same universal
// admin scope. The route still exists as a page.tsx file (permanent redirect
// into /admin/auditoria?vista=actividad, preserving query params — see
// lib/ui/auditoria-hub-redirect.ts), so it still needs a manifest entry to
// satisfy the coverage fence; it has no nav entry anymore. /gob/historial is
// NOT absorbed — the govt twin is jurisdiction-scoped and keeps its own
// route, decision and nav entry (GOB_HISTORIAL above is untouched).
const ADMIN_HISTORIAL: ScreenManifestEntry = {
  route: "/admin/historial",
  layer: "profundidad",
  decision: "[Absorbida] Redirige a /admin/auditoria?vista=actividad — ver ADMIN_AUDITORIA.",
};

const ADMIN_ALERTAS: ScreenManifestEntry = {
  route: "/admin/alertas",
  layer: "bandeja",
  decision: "¿Reconozco, investigo o cierro esta alerta de umbral?",
};

// LAYER NOTE (leanness sweep, 2026-08-02): this screen's actual shape is a
// per-case deadline queue — "bandeja" is the semantically honest layer for
// it. Left as "situacion" on purpose: nav-presets.ts places /admin/observaciones
// under the "Situación" section (admin has no dedicated Vigilancia screen, so
// this fills that role — see the ADMIN_NAV_SECTIONS comment above), and
// scripts/check-screen-manifest.ts's manifest↔nav cross-check FAILS the
// moment this declares "bandeja" while the nav keeps it under Situación.
// Moving it to Bandeja operativa would be a real (if small) nav change, not a
// one-line manifest fix — out of scope for a leanness/dedup pass. Revisit
// together with nav-presets.ts if/when admin gets a dedicated bandeja section.
const ADMIN_OBSERVACIONES: ScreenManifestEntry = {
  route: "/admin/observaciones",
  layer: "situacion",
  decision: "¿Qué observación de rabia en curso necesita seguimiento o cierre?",
};

// El gemelo de gobierno de ADMIN_OBSERVACIONES (2026-08-10). Es la MISMA
// pantalla —`app/gob/observaciones/page.tsx` re-exporta el componente— servida
// bajo el otro portal, porque el layout de /admin rebota al rol govt y la
// observación antirrábica es competencia sanitaria. Misma decisión, mismo layer:
// nav-presets la ubica en la sección Situación de gobierno igual que su gemela.
const GOB_OBSERVACIONES: ScreenManifestEntry = {
  route: "/gob/observaciones",
  layer: "situacion",
  decision: "¿Qué observación de rabia en curso necesita seguimiento o cierre?",
};

const ADMIN_INTELIGENCIA: ScreenManifestEntry = {
  route: "/admin/inteligencia",
  layer: "profundidad",
  decision: "¿Qué provincia se aparta del índice compuesto y por qué (política, calidad de dato)?",
};

const ADMIN_SISTEMA: ScreenManifestEntry = {
  route: "/admin/sistema",
  layer: "profundidad",
  decision: "¿Algún cron dejó de correr y necesito reintentarlo o escalarlo?",
};

// Audit-trail fusion (2026-08-02, structural convergence): this screen now
// OWNS both readings of the admin audit log as tabbed vistas
// (?vista=sensibles|actividad) — the global sensitive-changes registro (its
// pre-fusion view, the default) and the period-scoped operator-activity
// audit absorbed from /admin/historial. Both vistas query the SAME audit_log
// at the SAME universal admin scope.
const ADMIN_AUDITORIA: ScreenManifestEntry = {
  route: "/admin/auditoria",
  layer: "profundidad",
  decision: "¿Quién hizo qué (cambio sensible o actividad del período), y necesito investigarlo?",
};

// Privileged-accounts fusion (2026-08-02, mirroring the F3 Directorio hub
// shape): /admin/govts and /admin/admins collapse into the /admin/cuentas
// hub as tabbed registers (?registro=govts|admins). Both routes still exist
// as page.tsx files (permanent redirects into /admin/cuentas?registro=...,
// preserving query params — see lib/ui/cuentas-hub-redirect.ts), so they
// still need a manifest entry to satisfy the coverage fence; neither has a
// nav entry anymore. Their nested detail/form routes ([userId], /new) are
// UNCHANGED and stay baselined.
const ADMIN_GOVTS: ScreenManifestEntry = {
  route: "/admin/govts",
  layer: "profundidad",
  decision: "[Absorbida] Redirige a /admin/cuentas?registro=govts — ver ADMIN_CUENTAS.",
};

const ADMIN_ADMINS: ScreenManifestEntry = {
  route: "/admin/admins",
  layer: "profundidad",
  decision: "[Absorbida] Redirige a /admin/cuentas?registro=admins — ver ADMIN_CUENTAS.",
};

// The hub OWNS privileged-account administration across both registers —
// same roster grammar (search, alta, per-account drill, deactivate) over two
// deliberately distinct panels (govt_assignments jurisdiction alta vs admin
// grant/revoke — a tab shell, never a merged query).
const ADMIN_CUENTAS: ScreenManifestEntry = {
  route: "/admin/cuentas",
  layer: "profundidad",
  decision: "¿Quién puede operar con privilegios (gobierno o admin), y con qué alcance?",
};

const ADMIN_LIBRO: ScreenManifestEntry = {
  route: "/admin/libro",
  layer: "profundidad",
  decision: "¿Qué evento de dominio necesito auditar en su forma cruda (event-sourcing)?",
};

/**
 * The full registry — every entry above, in one array. Order is cosmetic
 * (portal, then layer); lookups are by `route` via {@link getScreenManifestEntry}.
 */
export const SCREEN_MANIFEST: readonly ScreenManifestEntry[] = [
  // /gob
  GOB_PANEL,
  GOB_PANORAMA,
  GOB_VIGILANCIA,
  GOB_PERDIDAS,
  GOB_PROGRAMA,
  GOB_ANALYTICS,
  GOB_ANALITICA,
  GOB_PADRON,
  GOB_POBLACION,
  GOB_CENSO,
  GOB_CAMPANAS,
  GOB_MORTALIDAD,
  GOB_ADOPCIONES,
  GOB_OUTREACH,
  GOB_OPERATIVOS,
  GOB_DECOMISOS,
  GOB_RUPGA,
  GOB_ACCIONES,
  GOB_DENUNCIAS,
  GOB_MODERACION,
  GOB_MALTRATO,
  GOB_COLA,
  GOB_CASOS,
  GOB_DISPUTAS,
  GOB_OUTBOX,
  GOB_SUSCRIPCIONES,
  GOB_HISTORIAL,
  GOB_REGLAS,
  GOB_ORGANIZACIONES,
  GOB_USUARIOS,
  GOB_SERVICIOS,
  GOB_DIRECTORIO,
  GOB_OBSERVACIONES,
  // /admin
  ADMIN_PANEL,
  ADMIN_PANORAMA,
  ADMIN_OBSERVACIONES,
  ADMIN_PROGRAMA,
  ADMIN_CHAPAS,
  ADMIN_PADRON,
  ADMIN_CENSO,
  ADMIN_ADOPCIONES,
  ADMIN_POBLACION,
  ADMIN_COLA,
  ADMIN_ALERTAS,
  ADMIN_SUSCRIPCIONES,
  ADMIN_CASOS,
  ADMIN_MODERACION,
  ADMIN_OUTBOX,
  ADMIN_INTELIGENCIA,
  ADMIN_SISTEMA,
  ADMIN_AUDITORIA,
  ADMIN_USUARIOS,
  ADMIN_GOVTS,
  ADMIN_ADMINS,
  ADMIN_CUENTAS,
  ADMIN_ORGANIZACIONES,
  ADMIN_REGLAS,
  ADMIN_HISTORIAL,
  ADMIN_LIBRO,
  ADMIN_SERVICIOS,
  ADMIN_DIRECTORIO,
];

const BY_ROUTE: ReadonlyMap<string, ScreenManifestEntry> = new Map(
  SCREEN_MANIFEST.map((e) => [e.route, e]),
);

/** Look up a route's manifest entry, if one exists. */
export function getScreenManifestEntry(route: string): ScreenManifestEntry | undefined {
  return BY_ROUTE.get(route);
}
