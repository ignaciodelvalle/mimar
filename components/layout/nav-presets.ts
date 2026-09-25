// Role-specific nav presets for Sidebar and AppHeader.
// Pure module — no side effects, no React, no async.
// All three operator portals (gob, admin, org) use grouped NavSection[].
// Flat derivations are kept for callers that still need NavItem[] (mobile drawer, link-integrity test).

import type { NavSection } from "@/components/ui/dashboard";
import type { NavItem } from "./HeaderNav";

// ---------------------------------------------------------------------------
// Public portal nav — shared by all unauthenticated-accessible portals.
// Intentionally excludes "Mi libreta" (requires auth) and "Inicio" (landing).
// ---------------------------------------------------------------------------

export const PUBLIC_NAV: NavItem[] = [
  { href: "/adoptar", label: "Adoptar", matchPrefix: "/adoptar" },
  { href: "/perdidas", label: "Mascotas perdidas", matchPrefix: "/perdidas" },
  { href: "/refugios", label: "Refugios", matchPrefix: "/refugios" },
  { href: "/denuncias", label: "Denuncias", matchPrefix: "/denuncias" },
];

// ---------------------------------------------------------------------------
// Owner portal
// ---------------------------------------------------------------------------

// Owner nav — 2 items (PO ronda 4, 2026-07-15). The former "Inicio" tab is
// GONE. /inicio is now only a server redirect INTO the most-urgent pet's
// credential (the carousel lives under /mis-mascotas/[token]), so the tab never
// lit up — the carousel marks "Mis mascotas" active (matchPrefix /mis-mascotas),
// leaving "Inicio" perpetually dark — and it created a vet-gating asymmetry
// (/inicio bypassed the vet-landing gate). Removing the tab (SUPERSEDING the
// 2026-07-02 three-item split, decision #645) leaves the two REAL owner
// destinations. The /inicio ROUTE stays (post-login landing + old bookmarks +
// the Asentar fallback target); only its nav entry dies. Identity (Cuenta) is
// the account pill and notifications are the bell — neither is a nav peer.
export const OWNER_NAV: NavItem[] = [
  { href: "/mis-mascotas", label: "Mis mascotas", matchPrefix: "/mis-mascotas" },
  // "Denuncias", not "Denunciar" (flow audit 2026-07-03, PO decision): an
  // action verb pointing at a LIST promised the create flow and delivered
  // status. The noun matches the destination; the list's own "Nueva
  // denuncia" CTA covers the action.
  { href: "/denuncias/mias", label: "Denuncias", matchPrefix: "/denuncias" },
];

// ---------------------------------------------------------------------------
// Org portal
// Sections model: capability-filtered items partitioned into NavSection[].
// Sections that end up empty after filtering are dropped.
//
// Nav diet (2026-07-24, PO-approved, cursor R1 + sentiment): the shelter rail
// had grown into an 18-item ERP sitemap; a shift lead needs today's jobs. The
// rail now leads with the 5 primary JOBS (Ingresos, Custodia, Postulaciones,
// Casos, Equipo) and folds every managerial/setup surface into ONE collapsible
// "Administración" group, collapsed by default. Pure regrouping: no route,
// label, capability gate, or shelterOnly filter changed — every destination
// survives, one tap away at most.
// ---------------------------------------------------------------------------

export type OrgNavOptions = {
  /**
   * Capabilities granted to the viewing member (from getGrantedCapabilities).
   * Capability-gated items (Mascotas, Agenda, Ingresos, Tránsitos, Voluntarios,
   * Operaciones, Check-ins, Servicios, Mordeduras, Permisos, Transferencias,
   * Casos, Miembros) only render when their capability is present. Omit to
   * build the near-empty baseline nav (Panel only, plus any role-gated items).
   */
  granted?: ReadonlySet<string>;
  /**
   * The organization's type (organizations.orgType). A clinic OR
   * sanitary_authority admin implicitly holds every capability, so capability
   * gating alone can't hide the shelter-only modules (Tránsitos, Voluntarios,
   * Adopciones, Check-ins) — they are noise on any non-rehoming org type.
   * Passing orgType filters them out for every type except shelter /
   * rescue_network, mirroring the page-level `capabilityAppliesToOrgType` /
   * SHELTER_ONLY_CAPABILITIES used by the org home cards (UX gate M2, preverify
   * #10).
   */
  orgType?: string;
  /**
   * The viewing member's membership role (organization_memberships.role).
   * Three nav items gate on ROLE, not capability, because their pages do:
   * Maltrato (welfare reports — page restricts to
   * admin/coordinator/member/vet_individual), Configuración (admin-only — the
   * page redirects everyone else), and Cobertura (no dedicated capability
   * exists — the page's own `canManage` check is admin/coordinator-only).
   * Omit to hide all three. QA histórico 2026-07-08 #81 and #2: the sidebar
   * over-exposed modules a zero-capability foster could not actually use,
   * contradicting the panel copy "Cada permiso habilita su módulo en el menú".
   */
  role?: string;
};

// Roles allowed to open the org welfare inbox (mirrors ALLOWED_ROLES in
// app/org/[orgToken]/maltrato/recibidos/page.tsx — sensitive PII surface).
const WELFARE_NAV_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "coordinator",
  "member",
  "vet_individual",
]);

// Roles allowed to manage coverage zones (mirrors `canManage` in
// app/org/[orgToken]/cobertura/page.tsx — the page has no dedicated
// capability, gating is role-only). QA histórico 2026-07-08 #2: nav must
// match that gate, not leave Cobertura in the un-gated baseline.
const COVERAGE_MANAGE_ROLES: ReadonlySet<string> = new Set(["admin", "coordinator"]);

type OrgNavItem = NavItem & {
  requiredCapability?: string;
  /**
   * Item shown when the member holds ANY of these capabilities (Transferencias —
   * a member can hold org.transfer.propose, org.transfer.accept, or both, since
   * they're independently grantable per admin/permisos).
   */
  requiredAnyCapability?: readonly string[];
  shelterOnly?: boolean;
  /** Item shown only when the member's role is in this set (Maltrato, Configuración, Cobertura). */
  requiredRoles?: ReadonlySet<string>;
};

/**
 * Returns the org nav as grouped NavSection[].
 * Sections are built after capability filtering, so any section left empty
 * (all its items were gated and none were granted) is dropped entirely.
 */
export function buildOrgNav(orgToken: string, opts: OrgNavOptions = {}): NavSection[] {
  const granted = opts.granted ?? new Set<string>();
  const orgType = opts.orgType;
  // Hide the shelter-only modules (Tránsitos, Voluntarios, Operaciones,
  // Check-ins) for org types that don't run the custody-rehoming lifecycle.
  // Mirrors the capability model's SHELTER_ONLY_CAPABILITIES / REHOMING_ORG_TYPES
  // (capabilities.ts): only shelter + rescue_network keep them. A clinic admin
  // AND a sanitary_authority admin implicitly hold every capability, so
  // capability gating alone can't drop these — the org-type gate is the right
  // filter. Preverify #10: the old clinic-only gate left sanitary_authority
  // still surfacing them. When orgType is omitted (link-integrity / full-nav
  // callers), nothing is hidden.
  const hideShelterOnly =
    orgType !== undefined && orgType !== "shelter" && orgType !== "rescue_network";
  const role = opts.role;

  // All candidate items with their section assignment and optional capability
  // gate. Sections ARE the two-tier diet: the unlabeled top (Panel) + the 5
  // primary job buckets, then "Administración" (collapsible, collapsed by
  // default) for everything managerial.
  const allItems: Array<OrgNavItem & { section: string }> = [
    // Unlabeled top — the org home, mirrors the gob/admin Panel-only top.
    { href: `/org/${orgToken}`, label: "Panel", section: "" },
    {
      // Judgment call (nav diet): Agenda is not one of the 5 shelter jobs →
      // Administración for rehoming orgs. But for a clinic/sanitary authority
      // the appointment book IS daily work — surface it in the unlabeled top
      // next to Panel instead of burying it behind the collapsed group.
      href: `/org/${orgToken}/agenda`,
      label: "Agenda",
      matchPrefix: `/org/${orgToken}/agenda`,
      requiredCapability: "appointment.manage",
      section: hideShelterOnly ? "" : "Administración",
    },
    {
      // Atender (walk-in credential → sign a clinical event) is the CLINIC's
      // core daily flow — the route existed and worked but had NO nav item, so
      // the org's #1 job was reachable only via a panel card (red-team
      // 2026-07-24 #2). Surfaced in the unlabeled top for clinics/authorities
      // (where it IS the main work), kept under Administración for rehoming
      // orgs that can also sign events. Gated on event.write — the exact
      // capability the atender flow requires (atender-access.ts).
      href: `/org/${orgToken}/atender`,
      label: "Atender",
      matchPrefix: `/org/${orgToken}/atender`,
      requiredCapability: "event.write",
      section: hideShelterOnly ? "" : "Administración",
    },
    // Ingresos — shelter/rescue intake (the "what entered" job). shelterOnly:
    // a clinic doesn't take shelter intake, and a clinic admin holds implicit
    // all-caps, so without this flag it saw an "Ingresos" item in refugio
    // language that isn't its job (red-team 2026-07-24 #4, same class as the
    // Censo fix).
    {
      href: `/org/${orgToken}/intake`,
      label: "Ingresos",
      matchPrefix: `/org/${orgToken}/intake`,
      requiredCapability: "intake.create",
      section: "Ingresos",
      shelterOnly: true,
    },
    {
      href: `/org/${orgToken}/censo`,
      label: "Censo",
      matchPrefix: `/org/${orgToken}/censo`,
      requiredCapability: "intake.create",
      section: "Ingresos",
      // The census page itself is shelter-only (app/org/[t]/censo/page.tsx
      // SHELTER_TYPES) — without this flag a clinic admin (implicit all-caps)
      // got a nav item leading to an H1-less dead end (cursor citizen UX V1).
      shelterOnly: true,
    },
    // Custodia — the animals the org holds and their foster placements.
    {
      href: `/org/${orgToken}/mascotas`,
      label: "Mascotas",
      matchPrefix: `/org/${orgToken}/mascotas`,
      requiredCapability: "pet.read_held",
      section: "Custodia",
    },
    {
      href: `/org/${orgToken}/transitos`,
      label: "Tránsitos",
      matchPrefix: `/org/${orgToken}/transitos`,
      requiredCapability: "foster.assign",
      section: "Custodia",
      shelterOnly: true,
    },
    {
      // Gated on the cross-org handshake capabilities (spec
      // 2026-05-19-cross-org-transfer-ux): org.transfer.propose covers the
      // sender flow (/transferencias, /transferencias/nueva) and
      // org.transfer.accept covers the receiver flow (/transferencias/recibidas).
      // They're independently grantable (admin/permisos), so a member with
      // either one has a real reason to see this module — OR, not AND.
      // QA histórico 2026-07-08 #2: was un-gated ("membership-level"), which
      // over-exposed the module to zero-capability fosters.
      href: `/org/${orgToken}/transferencias`,
      label: "Transferencias",
      matchPrefix: `/org/${orgToken}/transferencias`,
      requiredAnyCapability: ["org.transfer.propose", "org.transfer.accept"],
      // Nav diet judgment call: the cross-org handshake is an occasional
      // managerial flow, not a shift job — Administración.
      section: "Administración",
    },
    // Postulaciones — the adoption-cycle job (applications + follow-ups).
    // Label matches the target page's H1 ("Postulaciones"): "Operaciones"
    // promised a hub and delivered an applications list, and operators learn
    // not to trust labels (cursor citizen UX R2, 2026-07-24).
    {
      href: `/org/${orgToken}/adopciones`,
      label: "Postulaciones",
      matchPrefix: `/org/${orgToken}/adopciones`,
      requiredCapability: "adoption.review",
      section: "Postulaciones",
      shelterOnly: true,
    },
    {
      // Post-adoption follow-ups belong to the same adoption-cycle job as the
      // applications queue — kept beside Postulaciones, not Administración.
      href: `/org/${orgToken}/checkins`,
      label: "Check-ins",
      matchPrefix: `/org/${orgToken}/checkins`,
      requiredCapability: "adoption.review",
      section: "Postulaciones",
      shelterOnly: true,
    },
    // Casos
    {
      // The case queue (listCasesForOrg) surfaces intake/custody/transfer
      // activity on animals the org holds — same read surface as Mascotas, so
      // it's gated on the same capability. QA histórico 2026-07-08 #2: was
      // un-gated ("membership-level"), over-exposing it to zero-capability
      // fosters.
      href: `/org/${orgToken}/casos`,
      label: "Casos",
      matchPrefix: `/org/${orgToken}/casos`,
      requiredCapability: "pet.read_held",
      section: "Casos",
    },
    {
      href: `/org/${orgToken}/maltrato/recibidos`,
      label: "Maltrato",
      matchPrefix: `/org/${orgToken}/maltrato`,
      requiredRoles: WELFARE_NAV_ROLES,
      section: "Casos",
    },
    {
      // No index page under /mordedura — the report form is the entry point.
      href: `/org/${orgToken}/mordedura/nuevo`,
      label: "Mordeduras",
      matchPrefix: `/org/${orgToken}/mordedura`,
      requiredCapability: "bite.report",
      section: "Casos",
    },
    // Equipo — the people-running-the-shift job (staff, fosters, access).
    {
      // The members page itself is viewable by any member (roster), but the
      // page is only ACTIONABLE (invite/manage) with member.invite — gate
      // nav on that, matching the "member admin" module it represents. QA
      // histórico 2026-07-08 #2: was un-gated, over-exposing it to
      // zero-capability fosters.
      href: `/org/${orgToken}/miembros`,
      label: "Miembros",
      matchPrefix: `/org/${orgToken}/miembros`,
      requiredCapability: "member.invite",
      section: "Equipo",
    },
    {
      href: `/org/${orgToken}/voluntarios`,
      label: "Voluntarios",
      matchPrefix: `/org/${orgToken}/voluntarios`,
      requiredCapability: "foster.assign",
      section: "Equipo",
      shelterOnly: true,
    },
    {
      // Bandeja de mensajes públicos (auditoría 2026-08-04). Gateada en
      // `member.invite` — la misma vara que "Miembros", porque es el permiso
      // que representa "administro esta organización de cara afuera". Sin gate,
      // un miembro con CERO capacidades la veía, y el fence de navegación
      // (con razón) lo rechazó: un foster sin permisos no atiende la
      // correspondencia institucional.
      href: `/org/${orgToken}/mensajes`,
      label: "Mensajes",
      matchPrefix: `/org/${orgToken}/mensajes`,
      requiredCapability: "member.invite",
      section: "Equipo",
    },
    {
      href: `/org/${orgToken}/admin/permisos`,
      label: "Permisos",
      matchPrefix: `/org/${orgToken}/admin`,
      requiredCapability: "capability.grant",
      section: "Equipo",
    },
    // Administración — collapsed managerial/setup group (nav diet).
    {
      href: `/org/${orgToken}/servicios`,
      label: "Servicios",
      matchPrefix: `/org/${orgToken}/servicios`,
      requiredCapability: "service_offering.create",
      section: "Administración",
    },
    {
      // No dedicated capability exists for coverage — the page gates edit
      // access on role (`canManage` = admin/coordinator). Nav mirrors that
      // exact role gate. QA histórico 2026-07-08 #2: was un-gated, over-
      // exposing it to zero-capability fosters.
      href: `/org/${orgToken}/cobertura`,
      label: "Cobertura",
      matchPrefix: `/org/${orgToken}/cobertura`,
      requiredRoles: COVERAGE_MANAGE_ROLES,
      section: "Administración",
    },
    {
      href: `/org/${orgToken}/configuracion`,
      label: "Configuración",
      matchPrefix: `/org/${orgToken}/configuracion`,
      requiredRoles: new Set(["admin"]),
      section: "Administración",
    },
  ];

  // Section order determines render order: unlabeled top (Panel [+ Agenda for
  // non-rehoming orgs]) → the 5 primary jobs → collapsed Administración.
  const SECTION_ORDER = [
    "",
    "Ingresos",
    "Custodia",
    "Postulaciones",
    "Casos",
    "Equipo",
    "Administración",
  ] as const;
  // The one collapsible tier — rendered collapsed by default by OpRailNav /
  // OpMobileDrawer (native <details>). Everything else stays expanded.
  const COLLAPSED_SECTION = "Administración";

  // Filter by capability AND org type (a clinic admin implicitly holds every
  // capability, so the shelter-only modules must be dropped by org type — not
  // capability), then strip internal fields.
  const filtered = allItems
    .filter((item) => !item.requiredCapability || granted.has(item.requiredCapability))
    .filter(
      (item) =>
        !item.requiredAnyCapability || item.requiredAnyCapability.some((cap) => granted.has(cap)),
    )
    .filter((item) => !item.requiredRoles || (role !== undefined && item.requiredRoles.has(role)))
    .filter((item) => !(item.shelterOnly && hideShelterOnly))
    .map(
      ({
        requiredCapability: _cap,
        requiredAnyCapability: _anyCap,
        requiredRoles: _rr,
        shelterOnly: _so,
        section: _sec,
        ...item
      }) => ({
        ...item,
        section: _sec,
      }),
    );

  // Partition into sections, preserving order. Drop empty sections.
  const sections: NavSection[] = [];
  for (const sectionLabel of SECTION_ORDER) {
    const items = filtered
      .filter((item) => item.section === sectionLabel)
      .map(({ section: _sec, ...item }) => item);
    if (items.length > 0) {
      sections.push(
        sectionLabel === COLLAPSED_SECTION
          ? { label: sectionLabel, items, collapsible: true }
          : { label: sectionLabel, items },
      );
    }
  }

  return sections;
}

/**
 * Flat derived list — use where NavItem[] is required
 * (e.g. link-integrity tests, mobile drawer fallback).
 */
export function buildOrgNavFlat(orgToken: string, opts: OrgNavOptions = {}): NavItem[] {
  return buildOrgNav(orgToken, opts).flatMap((s) => s.items);
}

// ---------------------------------------------------------------------------
// Gobierno (/gob)
// Sections model: grouped NavSection[]. GOB_NAV (flat) is derived from
// GOB_NAV_SECTIONS and kept for backward compatibility with existing tests.
// ---------------------------------------------------------------------------

// C6a nav regroup (2026-07-22, dim-interno:docs/reviews/results/2026-07-22-plan-maestro-integridad.md
// §C6): regroups the 26 EXISTING routes under the operator mental model
// (BRIEFING → SITUACIÓN → PROGRAMA → INTERVENCIÓN → PROFUNDIDAD, plus the
// cross-cutting BANDEJA OPERATIVA for queue-shaped work) instead of mirroring
// the module tree. PO-locked: regroup only — no route moves/renames. The one
// new href is /gob/denuncias (the Denuncias hub, see app/gob/denuncias/page.tsx),
// which is additive: Moderación/Maltrato keep their own nav entries too.
//
// Judgment calls (reported alongside this change):
//  - Adopciones: not named in any C6a layer bullet. It is an outcome-vs-target
//    program dashboard (KPI row + funnel + trend, "¿funciona el ciclo de
//    colocación?"), not a review queue — placed in Programa, next to
//    Censo/Población/Campañas/Mortalidad which share that shape.
//  - RUPGA: originally kept in Intervención as a per-row ACTION console
//    (revocar credencial), not a passive registry view — SUPERSEDED by the
//    F3+F7 fusion below, which absorbs it into the Directorio hub instead.
//  - /gob/sistema has no nav entry today (folded into /gob/programa,
//    2026-07-09 audit; route survives only as a deep-link redirect) — nothing
//    to regroup, so Profundidad's "Sistema" is a no-op here.
/** The padrón sanitario export — the one /gob rail entry gated per viewer. */
export const GOB_PADRON_EXPORT_HREF = "/gob/analytics/export";

export const GOB_NAV_SECTIONS: NavSection[] = [
  // Unlabeled/top — the Briefing. This IS the Briefing's home now (PO decision
  // 2026-08-01): the label was "Panel", which read as a synonym of the
  // "Panorama" entry one section below, so a funcionario opening the rail had
  // two general-overview nouns and no way to tell which one to click. The
  // screen's own layer has been called `briefing` since C6b
  // (lib/ui/screen-manifest.ts) and its hero comes from
  // lib/metrics/briefing-alerts.ts — the label now says what the screen already
  // is. Route and matchPrefix are untouched; only the surface word changed.
  // /org keeps "Panel": that rail has no Panorama to collide with.
  {
    label: "",
    items: [{ href: "/gob", label: "Briefing" }],
  },
  {
    // Situational/risk surfaces — "what does the map look like right now".
    label: "Situación",
    items: [
      // T1.5 (2026-08-01): the menu entry names the CANONICAL default vista
      // explicitly instead of a bare /gob/panorama. A bare URL lets the
      // console's saved-board restore silently rewrite what "Panorama" opens —
      // a menu click must always land on the same screen. Pinned to the gob
      // role default ("sintomas", 30d — app/gob/panorama/page.tsx); an admin
      // browsing /gob follows the gob-operator contract via the explicit
      // deep-link semantics. Typed/bookmarked bare URLs keep the restore.
      {
        href: "/gob/panorama?preset=sintomas&period=30d",
        label: "Panorama",
        matchPrefix: "/gob/panorama",
      },
      { href: "/gob/vigilancia", label: "Vigilancia", matchPrefix: "/gob/vigilancia" },
      // Cola ENO (2026-09-09): the legal-notification queue — outbox rows bound
      // for an external authority (eno_authority / govt_webhook), ordered by
      // statutory deadline, breached first. It is a PRESET of /gob/outbox
      // (`?preset=eno`, lib/infra/outbox-query.ts), not a second page: the
      // same builder, the same table, one more column (disease · plazo legal).
      // Sits beside Vigilancia because it answers the surveillance question
      // ("¿qué aviso legal vence primero?"), while the bare "Bandeja de salida"
      // entry below stays the operational whole. No matchPrefix on purpose:
      // the active state is computed on the pathname, and /gob/outbox already
      // belongs to the Bandeja entry — two highlights would be a lie.
      { href: "/gob/outbox?preset=eno", label: "Cola ENO" },
      { href: "/gob/perdidas", label: "Pérdidas", matchPrefix: "/gob/perdidas" },
      // /gob/observaciones shipped on 2026-08-10 and the nav entry did not.
      // Every other absent /gob route in this file carries a comment saying it
      // is an absorbed redirect; this one was simply missing, so the only way in
      // was to already know the URL — for a queue that runs a 10-day legal
      // clock.
      //
      // Section is NOT a judgment call: screen-manifest.ts declares this route
      // layer "situacion", and check-screen-manifest fails when nav and the
      // manifest disagree. It caught me putting this under Bandeja operativa
      // because a queue felt like a queue. The admin twin sits in Situación too.
      { href: "/gob/observaciones", label: "Observaciones", matchPrefix: "/gob/observaciones" },
    ],
  },
  {
    // Outcome-vs-target program surfaces.
    //
    // F8 fusion (2026-07-22, PO-approved route unification — both are
    // registry-derived Programa surfaces the registry manager reads
    // together): Padrón ABSORBS Población + Censo as tabbed vistas
    // (`?vista=poblacion|censo`) of ONE screen. /gob/poblacion and /gob/censo
    // survive only as permanent redirects into /gob/padron?vista=... for old
    // links/bookmarks; neither has its own nav entry anymore.
    //
    // F9 fusion (2026-08-01, PO decision on an external-QA navigation gate):
    // Programa ABSORBS Analítica (formerly in Profundidad, below) as tabbed
    // vistas (`?vista=resumen|analitica`) of ONE screen. Two nav destinations
    // shared one noun — the /gob briefing alerts read "Ver en Programa →" and
    // landed here, while four KPI tiles in the same panel landed on
    // /gob/analytics, whose h1 said "Analítica". /gob/analytics (and the
    // /gob/analitica typo alias) survive only as permanent redirects into
    // /gob/programa?vista=... for old links/bookmarks; neither has its own nav
    // entry anymore.
    label: "Programa",
    items: [
      // Paquete gov-vis — exec summary (highest-level view, leads the layer)
      { href: "/gob/programa", label: "Programa", matchPrefix: "/gob/programa" },
      { href: "/gob/padron", label: "Padrón", matchPrefix: "/gob/padron" },
      { href: "/gob/mortalidad", label: "Mortalidad", matchPrefix: "/gob/mortalidad" },
      // Judgment call: custody/adoption pipeline dashboard (KPI+funnel+trend),
      // not a review queue — grouped with the other outcome dashboards.
      { href: "/gob/adopciones", label: "Adopciones", matchPrefix: "/gob/adopciones" },
      // ADDED 2026-09-23 — the "Padrón sanitario para SENASA" export
      // (app/gob/analytics/export/page.tsx) had NO direct path from this
      // menu: an operator had to open Programa, switch to its "Analítica"
      // tab (?vista=analitica, the F9 fusion below), and only then find the
      // "Exportar datos" CTA. The page's own header comment even claimed
      // /gob/analytics still carried a GOB_NAV_SECTIONS entry — stale since
      // the F9 fusion removed it. The label says "padrón sanitario", NOT
      // "SENASA": this file is shared with citizen-facing menus and
      // __tests__/state-endorsement-fence.test.ts forbids naming a state body
      // here outside a norm citation. The destination page (gob-only) still
      // names the SENASA format in its own heading.
      //
      // Shown only to who may export — see gobNavSectionsFor below.
      {
        href: GOB_PADRON_EXPORT_HREF,
        label: "Exportar padrón sanitario",
        matchPrefix: GOB_PADRON_EXPORT_HREF,
      },
    ],
  },
  {
    // Field/action surfaces — the operator DOES something to a specific target.
    // F2 fusion (2026-07-22, PO-approved route unification — same worker,
    // same weekly planning moment): Operativos ABSORBS Campañas (formerly in
    // Programa) and Alcance comunitario as tabbed views
    // (`?vista=campanas|alcance`) of ONE screen — "¿dónde y cómo intervengo
    // esta semana?". /gob/campanas and /gob/outreach survive only as
    // permanent redirects into /gob/operativos?vista=... for old links/
    // bookmarks; neither has its own nav entry anymore.
    //
    // F3+F7 fusion (2026-07-22): RUPGA's standalone entry is ALSO absorbed —
    // it becomes the Directorio hub's "Credenciales" tab (Profundidad
    // section below), so Intervención now holds only the two genuine field-
    // action surfaces. /gob/rupga survives as a permanent redirect into
    // /gob/directorio?registro=credenciales.
    label: "Intervención",
    items: [
      { href: "/gob/operativos", label: "Operativos", matchPrefix: "/gob/operativos" },
      { href: "/gob/decomisos", label: "Decomisos", matchPrefix: "/gob/decomisos" },
    ],
  },
  {
    // Queue-shaped work: inbox → tomar → actuar → cerrar. F1 fusion
    // (2026-07-22, PO-approved route unification — same worker, same daily
    // moment, same decision family): Denuncias ABSORBS Moderación and
    // Maltrato as tabbed stages (`?etapa=moderacion|triage`) of ONE screen —
    // superseding the earlier C6a additive hub (which kept them as separate
    // nav siblings). /gob/moderacion and /gob/maltrato survive only as
    // permanent redirects into /gob/denuncias?etapa=... for old links/
    // bookmarks; neither has its own nav entry anymore.
    //
    // F6 fusion (2026-07-22, PO-approved route unification — the "expediente"
    // family, same legal-administrative operator, identical case-file
    // grammar of open/parties/resolve): Casos ABSORBS Disputas as a tabbed
    // expediente (`?expediente=casos|disputas`) of ONE screen. /gob/disputas
    // survives only as a permanent redirect into /gob/casos?expediente=
    // disputas for old links/bookmarks; it has no nav entry anymore.
    label: "Bandeja operativa",
    items: [
      // G5 (obligations-worklist, 2026-08): the cross-domain deadline
      // worklist LEADS the section — it answers "¿qué vence primero?"
      // across every queue below it, so it is the section's entry point.
      { href: "/gob/acciones", label: "Acciones que vencen", matchPrefix: "/gob/acciones" },
      { href: "/gob/denuncias", label: "Denuncias", matchPrefix: "/gob/denuncias" },
      // Renamed from "Cola" (PO interview 2026-07-23, item 5): "Cola" alone
      // read as ambiguous against "cola de denuncias" — the approvals queue
      // (matrícula/organización/credencial requests) needed its own name.
      { href: "/gob/cola", label: "Aprobaciones", matchPrefix: "/gob/cola" },
      { href: "/gob/casos", label: "Casos", matchPrefix: "/gob/casos" },
      // /gob/sistema deliberately EXCLUDED — folded into /gob/programa for govt
      // operators (2026-07-09 audit). Route still exists as a redirect for deep
      // links but is no longer in nav.
      { href: "/gob/outbox", label: "Bandeja de salida", matchPrefix: "/gob/outbox" },
      // Promoted out of the /gob/programa "Alertas y suscripciones" sub-panel
      // (2026-07-21) — threshold alert subscription management now has its
      // own destination. Admin twin: /admin/suscripciones.
      {
        href: "/gob/suscripciones",
        label: "Alertas y suscripciones",
        matchPrefix: "/gob/suscripciones",
      },
    ],
  },
  {
    // Analyst/admin-config surfaces — deep-dive, not day-to-day triage.
    // F3+F7 fusion (2026-07-22, PO-approved route unification — registry-
    // entity management, identical roster grammar): Directorio ABSORBS
    // Organizaciones, Usuarios, Servicios, and RUPGA (the "Credenciales" tab)
    // as tabbed registers (`?registro=organizaciones|usuarios|servicios|
    // credenciales`) of ONE screen. /gob/organizaciones, /gob/usuarios,
    // /gob/servicios and /gob/rupga survive only as permanent redirects into
    // /gob/directorio?registro=... for old links/bookmarks; none has its own
    // nav entry anymore — RUPGA's former Intervención entry (above) is GONE
    // too, its revocation console body relocated as-is into the
    // "Credenciales" tab.
    //
    // F9 fusion (2026-08-01): "Analítica" is GONE from this section — it is
    // now the Programa hub's second vista (see the Programa section above).
    label: "Profundidad",
    items: [
      { href: "/gob/historial", label: "Historial", matchPrefix: "/gob/historial" },
      { href: "/gob/reglas", label: "Reglas", matchPrefix: "/gob/reglas" },
      { href: "/gob/directorio", label: "Directorio", matchPrefix: "/gob/directorio" },
    ],
  },
];

/**
 * The /gob rail for ONE viewer. GOB_NAV_SECTIONS is the full catalogue (the
 * screen-manifest fence and the breadcrumbs read it); the rail a person sees
 * drops the padrón sanitario export when they may not use it. The caller
 * passes the verdict of the page's own predicate
 * (app/gob/analytics/export/export-access.ts canExportPadronSanitario) — this
 * module does not restate the rule. Before this, a govt official with no
 * jurisdiction was offered an entry that led to a lock screen (PO, 2026-09-25).
 * A section left empty is dropped.
 */
export function gobNavSectionsFor(viewer: { canExportPadronSanitario: boolean }): NavSection[] {
  if (viewer.canExportPadronSanitario) return GOB_NAV_SECTIONS;
  return GOB_NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.href !== GOB_PADRON_EXPORT_HREF),
  })).filter((section) => section.items.length > 0);
}

/** Flat derived list — use where a NavItem[] is required (e.g. mobile drawer). */
export const GOB_NAV_FLAT: NavItem[] = GOB_NAV_SECTIONS.flatMap((s) => s.items);

/**
 * Backward-compatible flat constant kept for existing tests and any caller
 * that imports GOB_NAV directly.
 */
export const GOB_NAV: NavItem[] = GOB_NAV_FLAT;

// ---------------------------------------------------------------------------
// Admin (/admin)
// Sections model: grouped NavSection[]. ADMIN_NAV (flat) is derived from
// ADMIN_NAV_SECTIONS and kept for backward compatibility.
// The outbox badge is injected at runtime in app/admin/layout.tsx by mapping
// over ADMIN_NAV_SECTIONS directly — not stored here.
// ---------------------------------------------------------------------------

// C6a nav regroup (2026-07-22) — mirrors the GOB_NAV_SECTIONS regroup above
// where the same screens exist. Admin has no Intervención-layer screens
// (no outreach/decomisos/rupga routes under /admin), so that layer is simply
// absent here rather than shipped empty. Judgment calls:
//  - /admin/observaciones (rabies-observation follow-up tracking, in_progress/
//    completed status) is the admin-only epidemiological surveillance surface
//    — admin has no dedicated "Vigilancia" screen, so this fills that role.
//    Placed in Situación, mirroring the plan's "vigilancia se parte:
//    epidemiología→Situación" split.
//  - /admin/inteligencia (territorial composite index, policy→outcome,
//    per-province data quality) is a deep analyst surface, not a day-to-day
//    program dashboard — Profundidad, not Programa.
//  - /admin/sistema, /admin/auditoria, /admin/libro, /admin/govts,
//    /admin/admins: admin-only config/identity/audit surfaces with no gob
//    twin — all Profundidad (analyst/admin-config), same layer as their
//    closest gob relatives (Reglas/Directorio).
export const ADMIN_NAV_SECTIONS: NavSection[] = [
  // Same Panel→Briefing rename as GOB_NAV_SECTIONS above, and for the same
  // reason: /admin also ships a "Panorama" entry in the section right below.
  {
    label: "",
    items: [{ href: "/admin", label: "Briefing" }],
  },
  {
    label: "Situación",
    items: [
      // T1.5 (2026-08-01): explicit canonical default vista — same rationale as
      // the /gob/panorama entry above. Admin's default is DEFAULT_PANORAMA_
      // PRESET_ID ("bienestar", 90d — src/modules/panorama/domain/presets.ts).
      {
        href: "/admin/panorama?preset=bienestar&period=90d",
        label: "Panorama",
        matchPrefix: "/admin/panorama",
      },
      { href: "/admin/observaciones", label: "Observaciones", matchPrefix: "/admin/observaciones" },
    ],
  },
  {
    // F8 fusion (2026-07-22): Censo/Población (each its own genuine admin
    // screen — a national ranked table + forecast on top of the gob panels,
    // NOT a thin re-export) collapse into ONE /admin/padron entry, mirroring
    // the gob Padrón hub's tabs (?vista=poblacion|censo) with admin's own
    // hub page (app/admin/padron/page.tsx renders the admin-only screens —
    // not a thin re-export, since the admin bodies genuinely diverge from
    // gob's). /admin/poblacion and /admin/censo now redirect into
    // /admin/padron?vista=... rather than rendering inline.
    label: "Programa",
    items: [
      // Paquete H — exec summary / programa (top of section: highest-level view first)
      { href: "/admin/programa", label: "Programa", matchPrefix: "/admin/programa" },
      { href: "/admin/padron", label: "Padrón", matchPrefix: "/admin/padron" },
      { href: "/admin/adopciones", label: "Adopciones", matchPrefix: "/admin/adopciones" },
      // Emisión de chapas físicas. Had no entry anywhere in the product: the
      // only way in was to already know the URL, so the knowledge lived in a
      // person instead of the screen. That matters more here than on a
      // dashboard, because this page is the ORIGIN of the whole chapa circuit
      // that /t/[serial] and /cuenta/chapas/activar depend on, and it emits the
      // single artifact that ever carries the plaintext activation codes (the
      // DB keeps only their peppered HMAC).
      //
      // Section chosen by the manifest, not by taste: screen-manifest.ts:364-368
      // already files it under `layer: "programa"`.
      { href: "/admin/chapas", label: "Chapas", matchPrefix: "/admin/chapas" },
    ],
  },
  {
    label: "Bandeja operativa",
    items: [
      // Aprobaciones/Usuarios/Organizaciones/Reglas/Servicios exist under BOTH
      // /admin and /gob (portal-follows-viewer, 2026-07-02) — thin /admin/*
      // wrappers re-export the /gob page; chrome comes from each segment's
      // layout. The admin nav links to the /admin/* copy so an admin never
      // leaves the admin chrome. The old /admin→/gob 308s for these paths are
      // GONE. Label renamed from "Cola" (PO interview 2026-07-23, item 5) —
      // see the /gob/cola entry above for the rationale.
      { href: "/admin/cola", label: "Aprobaciones", matchPrefix: "/admin/cola" },
      { href: "/admin/alertas", label: "Alertas", matchPrefix: "/admin/alertas" },
      // Promoted out of the /admin/programa "Alertas y suscripciones"
      // sub-panel (2026-07-21) — thin wrapper over /gob/suscripciones
      // (portal-follows-viewer). Sits next to the alert INBOX (/admin/alertas)
      // since both are part of the same threshold-alert domain.
      {
        href: "/admin/suscripciones",
        label: "Alertas y suscripciones",
        matchPrefix: "/admin/suscripciones",
      },
      { href: "/admin/casos", label: "Casos", matchPrefix: "/admin/casos" },
      // DOCUMENTED cross-portal exception (prepush-review-3 2026-07-23):
      // /admin/moderacion permanently redirects into the gob Denuncias hub
      // (?etapa=moderacion) — the admin lands in gob chrome, unlike its
      // Bandeja siblings. Kept because the [id] detail routes still live under
      // /admin/moderacion/ (matchPrefix highlighting) and the hub screen is
      // role-aware (admin keeps the escalation-inbox semantics via
      // includeEscalated). A thin admin-scoped hub stub is the fase-3 cleanup
      // if the chrome jump bothers operators in practice.
      // T4.9 (2026-08-01): label-only fix — this entry ALWAYS lands the admin
      // in gob chrome (the redirect above), so an unadorned "Moderación" reads
      // as an in-portal link and the chrome jump surprises the operator. Match
      // DetailDrawer's existing "abre en portal Gobierno ↗" convention instead
      // of building an in-portal stub (out of scope per the backlog item).
      {
        href: "/admin/moderacion",
        label: "Moderación ↗ Gobierno",
        matchPrefix: "/admin/moderacion",
      },
      { href: "/admin/outbox", label: "Bandeja de salida", matchPrefix: "/admin/outbox" },
    ],
  },
  {
    // F3+F7 fusion (2026-07-22): Usuarios/Organizaciones/Servicios (each a
    // dual-portal thin wrapper, portal-follows-viewer) collapse into ONE
    // /admin/directorio entry — the admin-scoped mirror of the gob Directorio
    // hub (thin re-export, same registry tabs, admin chrome). The admin
    // wrappers (app/admin/usuarios, app/admin/organizaciones,
    // app/admin/servicios) now redirect into /admin/directorio?registro=...
    // rather than rendering inline — same relocation shape as the gob side,
    // just staying inside /admin so an admin viewer never bounces into gob
    // chrome (portal-follows-viewer).
    label: "Profundidad",
    items: [
      { href: "/admin/inteligencia", label: "Inteligencia", matchPrefix: "/admin/inteligencia" },
      { href: "/admin/sistema", label: "Sistema", matchPrefix: "/admin/sistema" },
      { href: "/admin/auditoria", label: "Auditoría", matchPrefix: "/admin/auditoria" },
      // Privileged-accounts fusion (2026-08-02): "Cuentas gobierno" +
      // "Administradores" collapse into ONE /admin/cuentas hub entry
      // (?registro=govts|admins), mirroring the F3 Directorio hub shape. The
      // old /admin/govts and /admin/admins list routes survive only as
      // permanent redirects; their [userId]/new detail routes are unchanged
      // (rail highlighting for those deep pages is accepted collateral, same
      // as the Directorio fusion's offering-detail routes). Label keeps the
      // "Cuentas" noun the A3 rename fought for — never a bare "Gobiernos"
      // that collides with the Portales menu's "Ir a Gobierno".
      { href: "/admin/cuentas", label: "Cuentas privilegiadas", matchPrefix: "/admin/cuentas" },
      { href: "/admin/directorio", label: "Directorio", matchPrefix: "/admin/directorio" },
      // Reglas exists under both portals (portal-follows-viewer,
      // admin-rules-console) — admin nav points at the /admin/* copy so an
      // admin drilling into a jurisdiction or a rule form stays in /admin
      // chrome. Only the renamed /admin/jurisdicciones bookmark still 308s
      // (to /admin/reglas).
      { href: "/admin/reglas", label: "Reglas", matchPrefix: "/admin/reglas" },
      // /admin/historial REMOVED from nav (audit-trail fusion, 2026-08-02):
      // absorbed into the Auditoría hub as the "Actividad" vista
      // (?vista=sensibles|actividad) — both admin surfaces queried the same
      // audit_log at the same universal scope. The route survives only as a
      // permanent redirect into /admin/auditoria?vista=actividad for old
      // links/bookmarks. /gob/historial (jurisdiction-scoped) keeps its own
      // nav entry above — the govt twin is NOT part of the fusion.
      // WS-L — Libro de eventos (event-sourcing visible; read-only).
      { href: "/admin/libro", label: "Libro de eventos", matchPrefix: "/admin/libro" },
    ],
  },
];

/** Flat derived list — use where a NavItem[] is required (e.g. mobile drawer or badge injection). */
export const ADMIN_NAV_FLAT: NavItem[] = ADMIN_NAV_SECTIONS.flatMap((s) => s.items);

/**
 * Backward-compatible flat constant kept for existing tests and any caller
 * that imports ADMIN_NAV directly.
 */
export const ADMIN_NAV: NavItem[] = ADMIN_NAV_FLAT;
