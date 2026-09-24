// Org portal landing — operations dashboard (Wave 3 Item 17).
//
// Layout:
//   Header: org name + verification status
//   OrgSetupChecklist (Wave 3 Item 19): guided first-run, auto-hides when complete
//   KPI row (4): Ocupación · Ingresos (semana) · Disponibles · Adopciones en curso
//   OpCard "Requieren acción": prioritized custody queue (overdue health / long-stay)
//   OpCard "Pendientes": casos · transferencias · propuestas (existing 3 KPIs, demoted)
//   Capability action cards
//   Permissions table
//
// Spec: dim-interno:docs/superpowers-private/specs/archive/2026-06-18-wave3-org-ops-handoff.md (Items 17, 19)
// Depends on Item 16: lib/org-census.ts (fetchOrgCensus, computeOccupancyBreakdown)

import { count, desc, eq } from "drizzle-orm";
import Link from "next/link";

import { Icon } from "@/components/Icon";
import { OrgSetupChecklist } from "@/components/OrgSetupChecklist";
import {
  OpBreach,
  OpCard,
  OpCardBody,
  OpCardHead,
  OpCodeBadge,
  OpKpi,
  OpPill,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import {
  type OrganizationCapability,
  db,
  organizationCapabilityGrants,
  organizationCoverage,
  organizationMemberships,
  ownerships,
  petEvents,
  profiles,
  serviceOfferings,
} from "@/db";
import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import { computeOccupancyBreakdown, fetchOrgCensus } from "@/lib/analytics/org-census";
import {
  actionReasonIcon,
  actionReasonLabel,
  applicableOrgQueues,
  fetchActiveAdoptions,
  fetchAvailableForAdoption,
  fetchIntakesLastWeek,
  fetchOrgQueueSignals,
  fetchRequiresAction,
  fetchTodayAgenda,
} from "@/lib/analytics/org-dashboard";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { deriveSetupSteps, isSetupComplete } from "@/lib/infra/org-setup-checklist";
import {
  getOrgQueueCountsCached,
  getProfileCached,
  orgQueueCacheKey,
} from "@/lib/infra/request-cache";
import {
  CAPABILITY_CATALOG,
  capabilityAppliesToOrgType,
} from "@/src/modules/organizations/domain/capabilities";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { OrgDailyLoopOrientation } from "./OrgDailyLoopOrientation";
import { RequestCapabilityForm } from "./RequestCapabilityForm";
import { SoloVetAgendaLanding } from "./SoloVetAgendaLanding";
import { deriveMatriculaStatus } from "./_lib/member-matricula";
import { pendingQueueTone, queueSignalNote } from "./_lib/queue-signal-display";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador/a",
  coordinator: "Coordinador/a",
  member: "Miembro",
  volunteer: "Voluntario/a",
  foster: "Tránsito",
  vet_individual: "Veterinario/a",
};

const ORG_TYPE_LABELS: Record<string, string> = {
  clinic: "Clínica",
  shelter: "Refugio",
  rescue_network: "Red de rescate",
  sanitary_authority: "Autoridad sanitaria",
  other: "Organización",
};

type CapabilityState =
  | { kind: "granted" }
  | { kind: "pending" }
  | { kind: "denied"; reason: string | null }
  | { kind: "revoked"; reason: string | null }
  | { kind: "none" };

const STATE_PILL_TONE: Record<CapabilityState["kind"], "ok" | "open" | "danger" | "neutral"> = {
  granted: "ok",
  pending: "open",
  denied: "danger",
  revoked: "danger",
  none: "neutral",
};

const STATE_PILL_LABEL: Record<CapabilityState["kind"], string> = {
  granted: "Concedido",
  pending: "Pendiente",
  denied: "Denegado",
  revoked: "Revocado",
  none: "No concedido",
};

const STATE_DOT: Record<CapabilityState["kind"], string> = {
  granted: "bg-ln-op-ok",
  pending: "bg-ln-op-warn",
  denied: "bg-ln-op-danger",
  revoked: "bg-ln-op-danger",
  none: "bg-ln-op-line",
};

// ---------------------------------------------------------------------------
// Occupancy KPI helpers (pure)
// ---------------------------------------------------------------------------

type OccupancyDisplay = {
  value: string;
  sub: string | null;
  tone: "ok" | "warn" | "danger" | "neutral";
};

/**
 * Derive display-safe occupancy value + tone from the occupancy breakdown.
 * Reuses computeOccupancyBreakdown (Item 16) logic — no raw SQL here.
 */
function deriveOccupancyDisplay(
  total: { count: number; capacity: number | null; pct: number | null; overCapacity: boolean },
  noCapacityDeclared: boolean,
): OccupancyDisplay {
  if (total.count === 0 && noCapacityDeclared) {
    return { value: "—", sub: "Sin animales aún", tone: "neutral" };
  }
  if (noCapacityDeclared) {
    return {
      value: String(total.count),
      sub: "en custodia · sin capacidad declarada",
      tone: "neutral",
    };
  }
  const pct = total.pct ?? 0;
  const tone: OccupancyDisplay["tone"] = total.overCapacity ? "danger" : pct >= 80 ? "warn" : "ok";
  const sub = total.overCapacity
    ? `Sobre capacidad (${total.count} / ${total.capacity ?? 0})`
    : `${total.count} / ${total.capacity ?? 0} lugares`;
  return { value: `${pct}%`, sub, tone };
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function OrgDashboardPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { user, organization, membership } = await requireOrgAccessByToken(orgToken);

  const profile = await getProfileCached(user.id);
  const userRole = profile?.role ?? "owner";

  const granted = await getGrantedCapabilities(membership);
  const isAdmin = membership.role === "admin";
  const orgType = organization.orgType;
  const isShelter = orgType === "shelter";
  const isClinic = orgType === "clinic";
  const isSanitaryAuthority = orgType === "sanitary_authority";
  // Org-type specialization (#43 item 2): a granted capability is only surfaced
  // when it is also relevant to the org_type. This is what stops a clinic ADMIN
  // — who implicitly holds every capability — from seeing refugio modules
  // (Adopciones, Foster/Tránsitos, custodia). See capabilityAppliesToOrgType.
  const showCap = (capability: OrganizationCapability): boolean =>
    granted.has(capability) && capabilityAppliesToOrgType(capability, orgType);
  const isRehoming = orgType === "shelter" || orgType === "rescue_network";
  const canDecideRequests = granted.has("capability.grant");
  const canReadHeld = showCap("pet.read_held");
  const canIntake = showCap("intake.create");
  const canReviewAdoptions = showCap("adoption.review");
  const canAssignFoster = showCap("foster.assign");
  const canWriteEvents = granted.has("event.write");
  const canReportBite = granted.has("bite.report");

  const grantHistory = isAdmin
    ? []
    : await db
        .select({
          capability: organizationCapabilityGrants.capability,
          status: organizationCapabilityGrants.status,
          decisionReason: organizationCapabilityGrants.decisionReason,
          requestedAt: organizationCapabilityGrants.requestedAt,
        })
        .from(organizationCapabilityGrants)
        .where(eq(organizationCapabilityGrants.membershipId, membership.id))
        .orderBy(desc(organizationCapabilityGrants.requestedAt));

  const stateByCapability = new Map<string, CapabilityState>();
  for (const row of grantHistory) {
    if (stateByCapability.has(row.capability)) continue;
    if (row.status === "approved") {
      stateByCapability.set(row.capability, { kind: "granted" });
    } else if (row.status === "pending") {
      stateByCapability.set(row.capability, { kind: "pending" });
    } else if (row.status === "denied") {
      stateByCapability.set(row.capability, { kind: "denied", reason: row.decisionReason });
    } else if (row.status === "revoked") {
      // Review F1 (post-B1): decisionReason now keeps the ORIGINAL GRANT's
      // reason (revoke is status-only, provenance preserved) — rendering it
      // here labeled a revocation with the approval's motive. The revoke's
      // own reason lives in the capability_revoked audit payload and the
      // member's notification; this surface states the fact without a motive.
      stateByCapability.set(row.capability, { kind: "revoked", reason: null });
    }
  }

  function stateFor(capability: OrganizationCapability): CapabilityState {
    if (granted.has(capability)) return { kind: "granted" };
    return stateByCapability.get(capability) ?? { kind: "none" };
  }

  const canCreateServices = granted.has("service_offering.create");

  // D-9 (Lote D) — the acting member's matrícula, as a STATUS instead of a
  // conditional clause. Fetched only for members who can actually sign a
  // clinical event, because that is the only context where the licence changes
  // anything (the same gate the "Registrar / firmar evento clínico" card uses).
  // A dedicated 2-column select: getProfileCached's contract deliberately keeps
  // its column set to what every guard/layout needs, and pages needing more
  // fetch their own (see its header comment).
  const matricula = canWriteEvents
    ? await db
        .select({
          matriculaNumber: profiles.matriculaNumber,
          matriculaVerified: profiles.matriculaVerified,
        })
        .from(profiles)
        .where(eq(profiles.id, user.id))
        .limit(1)
        .then(([row]) => (row ? deriveMatriculaStatus(row) : null))
    : null;

  // Header renders in BOTH the data and the degraded branches below. It reads
  // only `organization` / `membership` / `userRole`, all resolved by the auth
  // guard before any dashboard query runs, so a degraded DB still leaves the
  // operator a titled page (and the org nav rail, which lives in the layout)
  // instead of a bare error.
  const header = (
    <header className="space-y-1">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
        Panel de {ORG_TYPE_LABELS[organization.orgType] ?? "organización"}
      </p>
      <h1 className="text-title font-semibold text-ln-op-ink">{organization.displayName}</h1>
      <p className="text-md text-ln-op-mute">
        Actuando como{" "}
        <strong className="text-ln-op-ink-2">
          {ROLE_LABELS[membership.role] ?? membership.role}
        </strong>
        {membership.title ? ` — ${membership.title}` : ""}
        {/* Portal links are gated on userRole below — each link carries its
            own leading separator so a plain org member never sees a dangling
            "·" with nothing after it. */}
        {userRole === "admin" && (
          <>
            {" · "}
            <Link href="/admin" className="text-ln-op-azul hover:underline">
              Admin
            </Link>
          </>
        )}
        {(userRole === "govt" || userRole === "admin") && (
          <>
            {" · "}
            <Link href="/gob" className="text-ln-op-azul hover:underline">
              Gobierno
            </Link>
          </>
        )}
      </p>
      {/* D-9: the acting vet's licence status, at a glance. Sits beside the
          org's own verification breach on purpose — the two are the same
          question at two levels (is this signature worth anything?), and a
          reader who sees the org verified must not have to infer that their
          OWN matrícula still is not. A pill, not a breach: an unverified
          matrícula is a limitation on what a signature means, not an
          emergency, and the detail line names that consequence rather than
          restating the state. */}
      {matricula && (
        <p className="flex flex-wrap items-center gap-2 pt-0.5 text-sm text-ln-op-mute">
          <OpPill tone={matricula.tone}>{matricula.label}</OpPill>
          <span className="min-w-0">
            {matricula.detail}
            {matricula.href && (
              <>
                {" "}
                <Link href={matricula.href} className="text-ln-op-azul hover:underline">
                  Cargar matrícula
                </Link>
              </>
            )}
          </span>
        </p>
      )}
      {!organization.verified && (
        <OpBreach
          title="Verificación pendiente"
          detail="Los eventos que registres se marcarán como no verificados hasta que la documentación sea aprobada."
        />
      )}
    </header>
  );

  /** Degraded panel: the header stays, the body says so honestly. */
  const degradedPanel = (reason: "timeout" | "error", correlationId?: string) => (
    <div className="space-y-6">
      {header}
      <AnalyticsLoadFallback
        reason={reason}
        correlationId={correlationId}
        retryHref={`/org/${orgToken}`}
      />
    </div>
  );

  // Setup checklist inputs (Item 19) — run in parallel with dashboard projections.
  //
  // `firstAnimalRow` is an EXISTENCE probe, not a count: the checklist only asks
  // "is there at least one?". fetchOrgCensus (the panel's own pet counter, below)
  // is deliberately NOT reused here — it GROUP BYs species, it is only fetched
  // for `isShelter` (the intake step also applies to rescue_network), and it
  // narrows to role='shelter_custody' while the custody list the step leads to
  // shows every active ownership role. A `limit(1)` on the same predicate as the
  // list is both cheaper and the one that matches what the operator will see.
  // `isRehoming` (above) is the same shelter|rescue_network custody gate the
  // checklist applies to its own firstAnimal step — one predicate, one meaning.
  //
  // BOUNDED (2026-08-09 resilience pass). This is the first of three SEQUENTIAL
  // stages on the org panel, none of which had a deadline: unbounded, a
  // degraded pooler left an organization's landing page hanging with no error
  // and nothing in the logs — the same failure the /gob portal was fixed for.
  const setupLoad = await loadWithTimeout(
    Promise.all([
      db
        .select({ n: count() })
        .from(organizationCoverage)
        .where(eq(organizationCoverage.organizationId, organization.id)),
      db
        .select({ n: count() })
        .from(organizationMemberships)
        .where(eq(organizationMemberships.organizationId, organization.id)),
      canCreateServices
        ? db
            .select({ n: count() })
            .from(serviceOfferings)
            .where(eq(serviceOfferings.organizationId, organization.id))
        : Promise.resolve([{ n: 0 }]),
      // NO `isNull(endedAt)` — see OrgSetupInput.hasEverHeldAnimal. That one
      // clause was the S3-F04 bug: it made the checklist ask "do you hold an
      // animal RIGHT NOW?" to answer "did you register your first animal?", so a
      // shelter that adopted out its last animal got the whole checklist back.
      // Ownership rows survive a transfer with `endedAt` set, so the unfiltered
      // query is the record of what happened.
      isRehoming
        ? db
            .select({ id: ownerships.id })
            .from(ownerships)
            .where(eq(ownerships.ownerOrganizationId, organization.id))
            .limit(1)
        : Promise.resolve([]),
      // Non-custody orgs (clinic, sanitary authority) lead with their first
      // SIGNED EVENT instead. Straight off the spine via
      // pet_events.authorOrganizationId, which carries its own partial index.
      isRehoming
        ? Promise.resolve([])
        : db
            .select({ id: petEvents.id })
            .from(petEvents)
            .where(eq(petEvents.authorOrganizationId, organization.id))
            .limit(1),
    ]),
  );
  if (!setupLoad.ok) return degradedPanel(setupLoad.reason, setupLoad.id);
  const [coverageCountRow, memberCountRow, servicesCountRow, firstAnimalRow, firstSignedEventRow] =
    setupLoad.value;

  const setupSteps = deriveSetupSteps({
    orgType: organization.orgType,
    hasEverHeldAnimal: firstAnimalRow.length > 0,
    hasSignedEvent: firstSignedEventRow.length > 0,
    hasCoverage: (coverageCountRow[0]?.n ?? 0) > 0,
    memberCount: memberCountRow[0]?.n ?? 1,
    canCreateServices,
    hasServices: (servicesCountRow[0]?.n ?? 0) > 0,
    hasCapacityDeclared:
      organization.capacityDogs !== null ||
      organization.capacityCats !== null ||
      organization.capacityOther !== null ||
      organization.capacityTotal !== null,
    isVerified: organization.verified,
  });

  const showChecklist = !isSetupComplete(setupSteps);

  // Solo-clinic agenda-first landing (four-actor lean IA critique §3): a
  // one-person clinic with scheduling lands on today's agenda — the issuer's
  // daily loop — instead of the shelter-oriented ops dashboard below. Detected
  // by org SHAPE (clinic + single member), not by membership role: vet_individual
  // is a staff role usable inside multi-member clinics, while a real solo
  // practitioner is the sole admin of their own clinic (and thus holds every
  // capability). The org nav rail still exposes every other section.
  //
  // First-run (task #17): the solo path used to return here BEFORE the setup
  // checklist branch below, so a freshly-created solo clinic landed in a dead
  // empty agenda ("No hay turnos") with no path to publish services / declare
  // coverage / start verification — the onboarding checklist built for exactly
  // this account was skipped for it. We now surface the same OrgSetupChecklist
  // above the agenda while setup is incomplete (the sole member is the admin, so
  // isAdmin is always true on this path). It auto-hides once every step is done.
  if (
    organization.orgType === "clinic" &&
    (memberCountRow[0]?.n ?? 0) === 1 &&
    granted.has("appointment.manage")
  ) {
    // BOUNDED — this landing IS today's agenda, so an unbounded fetch here
    // hangs the one screen a solo clinic opens every morning. Degrading is not
    // an option worth faking: an empty agenda would read as "no tenés turnos
    // hoy", which is the opposite of the truth.
    const agendaLoad = await loadWithTimeout(fetchTodayAgenda(organization.id));
    if (!agendaLoad.ok) return degradedPanel(agendaLoad.reason, agendaLoad.id);
    return (
      <SoloVetAgendaLanding
        orgToken={orgToken}
        orgName={organization.displayName}
        appointments={agendaLoad.value}
        checklistSteps={showChecklist && isAdmin ? setupSteps : null}
      />
    );
  }

  // Org-type-gated pending-queue surface (task #18). The applicable queues are
  // derived from the capability model + role (same gate as the nav), so a queue
  // structurally impossible for this org-type (e.g. foster proposals on a
  // clinic) is never surfaced. ONE batched fetch covers every visible row —
  // and it's the SAME request-memoized fetch the layout above already ran for
  // the nav badges (getOrgQueueCountsCached, keyed by (orgId, sorted queue
  // keys)), so this call is a cache hit, not a second round of queries
  // (adversarial review 2026-07-10, MED 11).
  const orgQueues = applicableOrgQueues(orgType, granted, membership.role);

  // Whether the derived-welfare (maltrato) queue applies to this member/org —
  // reuses the SAME role+type gate as the Pendientes row, so the authority's
  // "Maltrato derivado" module card and its Pendientes count can never disagree
  // about visibility (#45 fix 4).
  const hasWelfareQueue = orgQueues.some((q) => q.key === "derivedWelfare");

  // Dashboard projections — all run in parallel.
  // Occupancy requires fetchOrgCensus + org capacity columns (Item 16).
  // getOrgQueueCountsCached itself never rejects on an individual counter
  // failure — a bad query degrades just that key to `null` (HIGH 4) — so it
  // can safely sit inside this Promise.all without risking the whole panel.
  //
  // BOUNDED, and MERGED with the shelter KPI batch that used to follow it as a
  // third sequential stage. Nothing in that batch consumed a result from this
  // one — `isShelter` is known well before either — so the serialization only
  // ever added latency, and on a slow DB it added it twice over.
  const dashboardLoad = await loadWithTimeout(
    Promise.all([
      getOrgQueueCountsCached(organization.id, orgQueueCacheKey(orgQueues.map((q) => q.key))),
      // D-7 / D-10: the deadline + aging facts a count cannot carry. A separate
      // fetch on purpose — the counts above are ALSO the nav badges, which want
      // a number and nothing else (see fetchOrgQueueSignals' own comment). Only
      // three queues have anything to report, so this is at most three small
      // aggregates, and each degrades alone.
      fetchOrgQueueSignals(
        organization.id,
        orgQueues.map((q) => q.key),
      ),
      isShelter ? fetchOrgCensus(organization.id) : Promise.resolve(null),
      isShelter ? fetchRequiresAction(organization.id) : Promise.resolve([]),
      // Shelter-only KPIs. Non-shelters resolve to 0 without touching the DB —
      // the tiles that read them are not rendered for those org types.
      isShelter ? fetchIntakesLastWeek(organization.id) : Promise.resolve(0),
      isShelter ? fetchAvailableForAdoption(organization.id) : Promise.resolve(0),
      isShelter ? fetchActiveAdoptions(organization.id) : Promise.resolve(0),
    ]),
  );
  if (!dashboardLoad.ok) return degradedPanel(dashboardLoad.reason, dashboardLoad.id);
  const [
    queueCounts,
    queueSignals,
    census,
    actionItems,
    intakesLastWeek,
    availableForAdopt,
    activeAdoptions,
  ] = dashboardLoad.value;

  // Occupancy breakdown — only meaningful for shelters with capacity columns.
  const occupancyBreakdown =
    isShelter && census !== null
      ? computeOccupancyBreakdown(census, {
          capacityDogs: organization.capacityDogs ?? null,
          capacityCats: organization.capacityCats ?? null,
          capacityOther: organization.capacityOther ?? null,
          capacityTotal: organization.capacityTotal ?? null,
        })
      : null;

  const occupancyDisplay = occupancyBreakdown
    ? deriveOccupancyDisplay(occupancyBreakdown.total, occupancyBreakdown.noCapacityDeclared)
    : null;

  // Role-first lead (four-actor lean IA critique §4): land a non-admin member in
  // their primary job, derived from granted capabilities. Admins keep the full
  // ops overview below. Priority follows the daily loop; each surface is one the
  // capability action cards already link to (no new routes).
  const primaryJob: { href: string; label: string; description: string } | null = (() => {
    if (isAdmin) return null;
    if (granted.has("appointment.manage"))
      return {
        href: `/org/${orgToken}/agenda`,
        label: "Agenda de hoy",
        description: "Tus turnos del día para atender.",
      };
    if (canAssignFoster)
      return {
        href: `/org/${orgToken}/transitos`,
        label: "Tránsitos activos",
        description: "Las mascotas en tránsito que coordinás.",
      };
    if (canReviewAdoptions)
      return {
        href: `/org/${orgToken}/checkins`,
        label: "Check-ins post-adopción",
        description: "El seguimiento de adoptantes que te toca.",
      };
    if (canIntake)
      return {
        href: `/org/${orgToken}/intake`,
        label: "Registrar ingreso",
        description: "Dar de alta animales que entran a custodia.",
      };
    if (canReadHeld)
      return {
        href: `/org/${orgToken}/mascotas`,
        label: "Animales en custodia",
        description: "El listado de animales a tu cargo.",
      };
    return null;
  })();

  return (
    <div className="space-y-6">
      {/* Page header — hoisted above the loads so the degraded branches keep it. */}
      {header}

      {/* Role-first lead (critique §4): a non-admin member's primary job, up top. */}
      {primaryJob && (
        <OpCard>
          <OpCardHead title="Tu tarea principal" />
          <OpCardBody className="p-0">
            <Link
              href={primaryJob.href}
              className="block p-4 no-underline transition-colors hover:bg-ln-op-stripe"
            >
              <p className="text-sm font-semibold text-ln-op-ink">{primaryJob.label}</p>
              <p className="mt-1 text-sm text-ln-op-mute">{primaryJob.description}</p>
            </Link>
          </OpCardBody>
        </OpCard>
      )}

      {/* Setup checklist (Item 19) — shown to admins until all steps complete. */}
      {showChecklist && isAdmin && (
        <OrgSetupChecklist steps={setupSteps} orgToken={orgToken} autoFocusFirst />
      )}

      {/* Post-onboarding transition (task #18): once setup is complete the
          checklist is gone — this one-time, org-type-aware "your daily loop"
          orientation takes its place instead of nothing. Client-side dismissal
          persists in localStorage; renders null once dismissed. */}
      {!showChecklist && isAdmin && (
        <OrgDailyLoopOrientation orgToken={orgToken} orgType={orgType} />
      )}

      {/* KPI row — shelter operations metrics (Item 17, shelters only) */}
      {isShelter && (
        <section
          aria-label="Métricas de operación"
          className="grid grid-cols-2 sm:grid-cols-4 gap-3"
        >
          {/* Ocupación — from Item 16 occupancy projection */}
          <OpKpi
            label="Ocupación"
            value={occupancyDisplay?.value ?? "—"}
            tone={occupancyDisplay?.tone ?? "neutral"}
            sub={occupancyDisplay?.sub ?? undefined}
            href={`/org/${orgToken}/censo`}
            info={{
              definition: "Porcentaje de ocupación sobre la capacidad máxima declarada.",
              formula: "animales en custodia / capacidad total × 100",
              caveat: "Solo disponible cuando la organización declaró su capacidad máxima.",
            }}
          />

          {/* Ingresos (semana) — consolidated: always renders OpKpi, empty-state via value="—" */}
          <OpKpi
            label="Ingresos (semana)"
            value={intakesLastWeek === 0 ? "—" : intakesLastWeek}
            tone={intakesLastWeek === 0 ? "neutral" : "blue"}
            sub={intakesLastWeek === 0 ? "Sin ingresos esta semana" : undefined}
            href={intakesLastWeek > 0 ? `/org/${orgToken}/intake` : undefined}
            info={{
              definition: "Cantidad de animales ingresados a custodia en los últimos 7 días.",
            }}
          />

          {/* Disponibles para adopción — consolidated */}
          <OpKpi
            label="Disponibles"
            value={availableForAdopt === 0 ? "—" : availableForAdopt}
            tone={availableForAdopt === 0 ? "neutral" : "ok"}
            sub={availableForAdopt === 0 ? "Sin animales disponibles" : "para adopción"}
            href={
              availableForAdopt > 0 ? `/org/${orgToken}/mascotas?adoptionEligible=true` : undefined
            }
            info={{
              definition: "Animales con estado 'disponible para adopción' en este momento.",
            }}
          />

          {/* Adopciones en curso — consolidated */}
          <OpKpi
            label="Adopciones en curso"
            value={activeAdoptions === 0 ? "—" : activeAdoptions}
            tone={activeAdoptions === 0 ? "neutral" : "warn"}
            sub={activeAdoptions === 0 ? "Sin postulaciones activas" : undefined}
            href={activeAdoptions > 0 ? `/org/${orgToken}/adopciones` : undefined}
            info={{
              definition:
                "Procesos de adopción activos (postulaciones en evaluación o seguimiento).",
            }}
          />
        </section>
      )}

      {/* OpCard "Requieren acción" — shelters only */}
      {isShelter && (
        <OpCard accent={actionItems.length > 0 ? "warn" : undefined}>
          <OpCardHead
            // Names its population — ANIMALES. As "Requieren acción" it was the
            // only block on the panel claiming to say what needs doing, and it
            // said "Todo en orden" while the sidebar of the same screen showed 2
            // postulaciones and 2 casos pendientes, one of them 35 days old
            // (master test CIU, A-2-b). It never counted queues and was never
            // meant to — the sibling "Pendientes" card owns those — so the title
            // was the only thing overreaching. The list's own aria-label has
            // read "Animales que requieren atención" the whole time.
            title="Animales que requieren atención"
            actions={
              actionItems.length > 0 ? (
                <Link
                  href={`/org/${orgToken}/mascotas`}
                  className="text-sm text-ln-op-azul hover:underline no-underline"
                >
                  Ver todos →
                </Link>
              ) : undefined
            }
          />
          <OpCardBody className={actionItems.length === 0 ? "p-0" : undefined}>
            {actionItems.length === 0 ? (
              /* Positive empty state — no bare 0-count (spec edge/a11y) */
              <div className="flex items-center gap-3 px-4 py-5">
                <Icon name="check-circle" size="md" className="text-ln-op-ok shrink-0" decorative />
                <div>
                  <p className="text-md font-semibold text-ln-op-ink">
                    Ningún animal requiere atención
                  </p>
                  <p className="text-sm text-ln-op-mute">
                    Mirá igual las colas de "Pendientes" más abajo.
                  </p>
                </div>
              </div>
            ) : (
              <ul
                aria-label="Animales que requieren atención"
                className="divide-y divide-ln-op-line-2"
              >
                {actionItems.map((item) => (
                  <li key={item.petId} className="flex items-start gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-md font-semibold text-ln-op-ink truncate">
                        <Link
                          href={`/org/${orgToken}/mascotas/${item.petPublicToken}`}
                          className="hover:underline no-underline text-ln-op-ink"
                        >
                          {item.petName}
                        </Link>
                      </p>
                      {/* icon + text for each flag — never color-only (a11y Item 11 pattern) */}
                      <ul className="flex flex-wrap gap-2" aria-label="Motivos">
                        {item.reasons.map((reason) => (
                          <li key={reason} className="flex items-center gap-1">
                            <Icon
                              name={actionReasonIcon(reason)}
                              size="sm"
                              className="text-ln-op-warn shrink-0"
                              decorative
                            />
                            <span className="text-sm text-ln-op-warn font-medium">
                              {actionReasonLabel(reason)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <span className="text-sm text-ln-op-mute whitespace-nowrap pt-0.5">
                      {item.daysInCustody}d en custodia
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </OpCardBody>
        </OpCard>
      )}

      {/* OpCard "Pendientes" — org-type-gated, complete actionable surface
          (task #18). Every queue this org-type actually has, each a live count
          that is itself a next-step shortcut to the filtered queue. No
          structurally always-zero rows: applicability comes from the capability
          model + role, the same gate the nav uses.

          A queue's count query can fail independently of its siblings — n is
          `null` in that case (adversarial review 2026-07-10, HIGH 4). The row
          still renders (the link keeps working) but WITHOUT a badge, instead
          of the whole panel 500ing or lying with a fabricated 0. */}
      {orgQueues.length > 0 && (
        <OpCard>
          <OpCardHead title="Pendientes" />
          <OpCardBody className="p-0">
            <ul className="divide-y divide-ln-op-line-2">
              {orgQueues.map((q) => {
                const n = queueCounts[q.key];
                // A signal only ever qualifies a NON-EMPTY queue: an empty one
                // has no oldest row and nothing past a deadline, and a stale
                // note beside a "0" would be the worst of both.
                const signal = n !== null && n > 0 ? queueSignals[q.key] : undefined;
                const note = queueSignalNote(signal);
                return (
                  <li key={q.key} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <Link
                        href={`/org/${orgToken}/${q.path}`}
                        className="text-md text-ln-op-ink hover:underline no-underline"
                      >
                        {q.label}
                      </Link>
                      {note && <p className="mt-0.5 text-sm text-ln-op-mute">{note}</p>}
                    </div>
                    {n !== null && <OpPill tone={pendingQueueTone(q.key, n, signal)}>{n}</OpPill>}
                  </li>
                );
              })}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      {/* Capability action cards — NAVIGATIONAL entry points only (#45 fix 2,
          MERGE). The three actionable quick-cards that used to live here
          (Propuestas emitidas, Tránsitos activos, Check-ins post-adopción) were
          the SAME queues the "Pendientes" card above already lists with live
          counts (pendingFosterProposals / activeFosters / overdueCheckins) — a
          second, counter-less copy of a counted surface. They were removed so
          "Pendientes" is the ONE actionable surface (what's pending, with
          counts, in one place). What remains here are pure entry points that
          are NOT pending queues: the custody list, the intake action, the
          volunteer search pool, and the no-apt list. Hidden entirely for the
          sanitary_authority (a regulator does not run custody intake — its lead
          is Casos/Maltrato, below; #45 fix 4). */}
      {!isSanitaryAuthority && (canReadHeld || canIntake || canAssignFoster) && (
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {canReadHeld && (
            <Link
              href={`/org/${orgToken}/mascotas`}
              className="block rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 hover:bg-ln-op-stripe transition-colors no-underline"
            >
              <p className="text-md font-semibold text-ln-op-ink">Animales en custodia</p>
              <p className="text-sm text-ln-op-mute mt-1">
                Listado de animales bajo custodia activa de la organización.
              </p>
            </Link>
          )}
          {canIntake && (
            <Link
              href={`/org/${orgToken}/intake`}
              className="block rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 hover:bg-ln-op-stripe transition-colors no-underline"
            >
              <p className="text-md font-semibold text-ln-op-ink">Registrar ingreso</p>
              <p className="text-sm text-ln-op-mute mt-1">
                Dar de alta un animal que entra a custodia de la organización.
              </p>
            </Link>
          )}
          {canAssignFoster && (
            <Link
              href={`/org/${orgToken}/voluntarios`}
              className="block rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 hover:bg-ln-op-stripe transition-colors no-underline"
            >
              <p className="text-md font-semibold text-ln-op-ink">Pool de voluntarios</p>
              <p className="text-sm text-ln-op-mute mt-1">
                Buscar voluntarios y proponer tránsitos.
              </p>
            </Link>
          )}
          {canIntake && isRehoming && (
            <Link
              href={`/org/${orgToken}/pets/no-aptas`}
              className="block rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 hover:bg-ln-op-stripe transition-colors no-underline"
            >
              <p className="text-md font-semibold text-ln-op-ink">
                Mascotas no aptas para adopción
              </p>
              <p className="text-sm text-ln-op-mute mt-1">
                Animales marcados como no aptos, agrupados por motivo.
              </p>
            </Link>
          )}
        </section>
      )}

      {/* UX 3.6 (b): module entry points by org type. The operations panel above
          is shelter-only; clinics and health authorities previously landed on a
          thin panel with no actionable modules. Surface their primary modules
          here, capability-gated so the links never dead-end. */}
      {isClinic &&
        (canWriteEvents ||
          canReportBite ||
          granted.has("appointment.manage") ||
          canCreateServices) && (
          <section
            aria-label="Módulos de la clínica"
            className="grid grid-cols-1 sm:grid-cols-2 gap-3"
          >
            {/* Vet home (#43 item 3): the clinic's primary action is signing a
                clinical event — it leads the module grid (accent card). Adoption
                is demoted (hidden entirely for clinics by the org-type filter). */}
            {canWriteEvents && (
              <Link
                href={`/org/${orgToken}/atender`}
                className="block rounded-[var(--radius-md)] border border-ln-op-azul bg-ln-op-card p-4 hover:bg-ln-op-stripe transition-colors no-underline sm:col-span-2"
              >
                <p className="text-md font-semibold text-ln-op-ink">
                  Registrar / firmar evento clínico
                </p>
                <p className="text-sm text-ln-op-mute mt-1">
                  Ingresá el código de la credencial que te muestra el dueño y cargá una vacuna,
                  cirugía u otro evento clínico. Si tenés matrícula verificada, se firma como
                  verificado por profesional.
                </p>
              </Link>
            )}
            {granted.has("appointment.manage") && (
              <Link
                href={`/org/${orgToken}/agenda`}
                className="block rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 hover:bg-ln-op-stripe transition-colors no-underline"
              >
                <p className="text-md font-semibold text-ln-op-ink">Turnos de hoy</p>
                <p className="text-sm text-ln-op-mute mt-1">
                  La agenda del día: asistencia, ausencias y cancelaciones.
                </p>
              </Link>
            )}
            {canReportBite && (
              <Link
                href={`/org/${orgToken}/mordedura/nuevo`}
                className="block rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 hover:bg-ln-op-stripe transition-colors no-underline"
              >
                <p className="text-md font-semibold text-ln-op-ink">Reportar mordedura</p>
                <p className="text-sm text-ln-op-mute mt-1">
                  Registrar una mordedura e iniciar la observación antirrábica.
                </p>
              </Link>
            )}
            {canCreateServices && (
              <Link
                href={`/org/${orgToken}/servicios`}
                className="block rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 hover:bg-ln-op-stripe transition-colors no-underline"
              >
                <p className="text-md font-semibold text-ln-op-ink">Servicios</p>
                <p className="text-sm text-ln-op-mute mt-1">
                  Publicar y gestionar ofrecimientos de servicios.
                </p>
              </Link>
            )}
          </section>
        )}

      {/* Sanitary authority module grid (#45 fix 4). A regulator's lead is its
          fiscalización work — Casos + Maltrato derivado — NOT custody intake
          (the generic custody/intake cards above are hidden for this type). The
          accent card leads with Casos; the derived-welfare inbox sits right
          beside it so "Maltrato derivado" is a first-class entry point, not a
          menu hunt. Both are also counted rows in "Pendientes" above; these are
          the navigational entry points (Mordeduras opens a NEW report — not a
          queue). */}
      {isSanitaryAuthority && (
        <section
          aria-label="Módulos de la autoridad sanitaria"
          className="grid grid-cols-1 sm:grid-cols-2 gap-3"
        >
          <Link
            href={`/org/${orgToken}/casos`}
            className="block rounded-[var(--radius-md)] border border-ln-op-azul bg-ln-op-card p-4 hover:bg-ln-op-stripe transition-colors no-underline"
          >
            <p className="text-md font-semibold text-ln-op-ink">Casos</p>
            <p className="text-sm text-ln-op-mute mt-1">Expedientes abiertos por la autoridad.</p>
          </Link>
          {hasWelfareQueue && (
            <Link
              href={`/org/${orgToken}/maltrato/recibidos`}
              className="block rounded-[var(--radius-md)] border border-ln-op-azul bg-ln-op-card p-4 hover:bg-ln-op-stripe transition-colors no-underline"
            >
              <p className="text-md font-semibold text-ln-op-ink">Maltrato derivado</p>
              <p className="text-sm text-ln-op-mute mt-1">
                Denuncias de maltrato derivadas a la autoridad para fiscalización.
              </p>
            </Link>
          )}
          {granted.has("bite.report") && (
            <Link
              href={`/org/${orgToken}/mordedura/nuevo`}
              className="block rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 hover:bg-ln-op-stripe transition-colors no-underline"
            >
              <p className="text-md font-semibold text-ln-op-ink">Mordeduras</p>
              <p className="text-sm text-ln-op-mute mt-1">
                Registrar una mordedura e iniciar la observación antirrábica.
              </p>
            </Link>
          )}
        </section>
      )}

      {/* Permissions table */}
      <OpCard>
        <OpCardHead
          title="Tus permisos"
          actions={
            <div className="flex items-center gap-2">
              {isAdmin && <OpPill tone="ok">Admin · todos los permisos</OpPill>}
              {canDecideRequests && (
                <Link
                  href={`/org/${orgToken}/admin/permisos`}
                  className="text-sm text-ln-op-azul hover:underline no-underline"
                >
                  Revisar solicitudes →
                </Link>
              )}
            </div>
          }
        />
        <OpCardBody className="p-0">
          {/* UX 3.6 (a): nav modules gated by capability disappear silently. This
              line explains the link and points to the request path below, so a
              missing section reads as "ask for access" instead of a dead end. */}
          {!isAdmin && (
            <p className="px-4 pt-3 text-sm text-ln-op-mute">
              Cada permiso habilita su módulo en el menú. Si no ves una sección que esperabas, pedí
              el permiso correspondiente acá abajo y un admin lo aprueba.
            </p>
          )}
          {/* #45 fix 3: for an admin every row is "Concedido" — pure noise for
              daily work — so the catalog is collapsed behind a disclosure (still
              one click away). Non-admins keep it open: for them it is actionable
              (request access via the inline forms). Rendered with a single
              <details> so the long capability map is never duplicated: for
              non-admins it is force-open with the summary hidden. */}
          {isAdmin && (
            <p className="px-4 pt-3 text-sm text-ln-op-mute">
              Como admin tenés todos los permisos concedidos. Desplegá la lista solo si necesitás
              revisar el detalle.
            </p>
          )}
          <details open={!isAdmin} className="group">
            <summary
              className={`list-none px-4 py-2 text-sm font-medium text-ln-op-azul ${
                isAdmin ? "cursor-pointer hover:underline" : "hidden"
              }`}
            >
              Ver todos los permisos
            </summary>
            <ul className="divide-y divide-ln-op-line">
              {CAPABILITY_CATALOG.filter((entry) =>
                // Org-type specialization (#43 item 2): hide pure-shelter permissions
                // (foster/adoption/custody) from clinics and health authorities.
                capabilityAppliesToOrgType(entry.capability, orgType),
              ).map((entry) => {
                const state = stateFor(entry.capability);
                const showRequestForm =
                  !isAdmin &&
                  (state.kind === "none" || state.kind === "denied" || state.kind === "revoked");
                return (
                  <li key={entry.capability} className="flex items-start gap-3 px-4 py-3">
                    <span
                      aria-hidden
                      className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${STATE_DOT[state.kind]}`}
                    />
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-md font-medium text-ln-op-ink">
                        {entry.label}
                        <OpCodeBadge tone="neutral">{entry.capability}</OpCodeBadge>
                      </p>
                      <p className="text-sm text-ln-op-mute">{entry.description}</p>
                      {(state.kind === "denied" || state.kind === "revoked") && state.reason && (
                        <p className="text-sm italic text-ln-op-faint">Motivo: {state.reason}</p>
                      )}
                      {showRequestForm && (
                        <div className="pt-1">
                          <RequestCapabilityForm
                            capability={entry.capability}
                            label={entry.label}
                            orgToken={orgToken}
                          />
                        </div>
                      )}
                    </div>
                    <OpPill tone={STATE_PILL_TONE[state.kind]}>
                      {STATE_PILL_LABEL[state.kind]}
                    </OpPill>
                  </li>
                );
              })}
            </ul>
          </details>
        </OpCardBody>
      </OpCard>
    </div>
  );
}
