// lib/org-dashboard.ts — Org operations dashboard projections (Wave 3 Item 17)
//
// Pure projections over the event log and custody rows — no new schema, no
// migrations. All helpers are org-scoped and read-only.
//
// Projections:
//   - intakesLastWeek:     shelter_intake_recorded events in the last 7 days
//   - availableForAdopt:   active shelter_custody pets with adoption_eligible=true
//   - activeAdoptions:     open adoption_application_submitted events (no resolution)
//   - requiresAction:      custody animals with overdue vaccine/deworming or long stay
//
// Import computeOccupancyBreakdown from lib/org-census.ts for the Ocupación KPI.

import { and, count, eq, exists, gt, gte, isNull, lt, notInArray, or, sql } from "drizzle-orm";

import {
  type OrganizationCapability,
  appointments,
  cases,
  // POOL: analyticsDb (session pooler), NOT the OLTP transaction pooler — read-only
  // multi-statement org-dashboard aggregates. supavisor transaction mode (6543) has a
  // measured >100x pathology for this fan-out shape (db/index.ts); session mode serves
  // it normally. Locally analyticsDb falls back to DATABASE_URL (identical dev/test).
  analyticsDb as db,
  fosterProposals,
  organizationCapabilityGrants,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
  serviceOfferings,
  timeSlots,
  welfareReports,
} from "@/db";
import { ageInDays } from "@/lib/domain/queue-aging";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { openObservationStatusSql } from "@/lib/metrics/observation-status";
import { DECOMISO_HANDOFF_STALE_DAYS } from "@/src/modules/cases/domain/case-sla";
import { capabilityAppliesToOrgType } from "@/src/modules/organizations/domain/capabilities";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of days before a stay is considered "long-stay" and surfaces as action-needed. */
export const LONG_STAY_DAYS = 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Today's agenda — powers the solo-clinic agenda-first landing (four-actor lean
// IA critique §3). Same Argentina-TZ midnight-to-midnight window as the full
// agenda page (app/org/[orgToken]/agenda/page.tsx).
// ---------------------------------------------------------------------------

/** One appointment on the org's day view, shaped for the agenda-first landing. */
export type TodayAgendaItem = {
  appointmentToken: string;
  status: string;
  startsAt: Date;
  offeringTitle: string;
  serviceKind: string;
  petName: string;
  petPublicToken: string;
  ownerName: string | null;
};

/** Today's appointments for an org (Argentina time), soonest first. */
export async function fetchTodayAgenda(organizationId: string): Promise<TodayAgendaItem[]> {
  const todayStr = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
  const localMidnight = new Date(`${todayStr}T00:00:00.000-03:00`);
  const localNextMidnight = new Date(localMidnight.getTime() + MS_PER_DAY);

  return db
    .select({
      appointmentToken: appointments.publicToken,
      status: appointments.status,
      startsAt: timeSlots.startsAt,
      offeringTitle: serviceOfferings.displayName,
      serviceKind: serviceOfferings.serviceKind,
      petName: pets.name,
      petPublicToken: pets.publicToken,
      ownerName: profiles.displayName,
    })
    .from(appointments)
    .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
    .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
    .innerJoin(pets, eq(pets.id, appointments.petId))
    .leftJoin(profiles, eq(profiles.id, appointments.ownerUserId))
    .where(
      and(
        eq(appointments.organizationId, organizationId),
        gte(timeSlots.startsAt, localMidnight),
        lt(timeSlots.startsAt, localNextMidnight),
        // Art. 16: an erased pet's name must not surface on the agenda.
        isNull(pets.deletedAt),
      ),
    )
    .orderBy(timeSlots.startsAt);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Aggregated dashboard metrics for an org panel.
 * All counts are non-negative integers; 0 is a valid "all clear" value.
 */
export type OrgDashboardMetrics = {
  /** Animals admitted via shelter_intake_recorded in the last 7 calendar days. */
  intakesLastWeek: number;
  /** Animals currently in shelter_custody with adoption_eligible = true. */
  availableForAdopt: number;
  /** Open adoption applications (submitted, not yet resolved or finalized). */
  activeAdoptions: number;
  /** Animals in custody that have at least one action-required flag. */
  requiresActionCount: number;
};

/** A single animal that requires operator attention. */
export type RequiresActionItem = {
  petId: string;
  petPublicToken: string;
  petName: string;
  petSpecies: string;
  /** Why this animal needs attention — multiple flags may apply. */
  reasons: ActionReason[];
  /** Days in custody (from ownership.startedAt to now), for display. */
  daysInCustody: number;
};

export type ActionReason =
  | "overdue_vaccine"
  | "overdue_deworming"
  | "active_medication_no_dose"
  | "long_stay";

// ---------------------------------------------------------------------------
// Raw SQL helper types for pg results
// ---------------------------------------------------------------------------

type CountRow = { n: string | number };

type ActionRow = {
  pet_id: string;
  pet_public_token: string;
  pet_name: string;
  pet_species: string;
  days_in_custody: string | number;
  overdue_vaccine: boolean;
  overdue_deworming: boolean;
  active_medication_no_dose: boolean;
  long_stay: boolean;
};

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

/**
 * Count shelter_intake_recorded events authored by this org in the last 7 days.
 *
 * Uses authorOrganizationId so only intakes recorded by the org are counted —
 * not intakes on pets in its custody that were authored externally.
 */
export async function fetchIntakesLastWeek(organizationId: string): Promise<number> {
  const since = new Date(Date.now() - 7 * MS_PER_DAY);
  const [row] = await db
    .select({ n: count() })
    .from(petEvents)
    // Art. 16: the intake event survives an erasure (append-only spine); the
    // KPI must stop counting the pet it belongs to.
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(
      and(
        eq(petEvents.eventType, "shelter_intake_recorded"),
        eq(petEvents.authorOrganizationId, organizationId),
        gt(petEvents.occurredAt, since),
        isNull(pets.deletedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Count pets currently in shelter_custody of this org with adoption_eligible = true.
 */
export async function fetchAvailableForAdoption(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(
      and(
        eq(ownerships.ownerOrganizationId, organizationId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
        eq(pets.adoptionEligible, true),
        // Art. 16: mascotas/page.tsx filters the "Disponibles" list this KPI
        // claims to match — the count takes the same filter or the claim lies.
        isNull(pets.deletedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Count open adoption applications for pets under this org's custody.
 *
 * An application is open when there is an adoption_application_submitted event
 * with no subsequent adoption_application_resolved event for the same pet and
 * application, and no adoption_finalized event on the pet.
 *
 * Uses a raw SQL query matching the adopciones/page.tsx pattern (authoritative).
 */
export async function fetchActiveAdoptions(organizationId: string): Promise<number> {
  const rows = await db.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n
    FROM pet_events s
    -- Art. 16: the application events survive an erasure; the pet must not
    -- keep counting (same filter as the adopciones list this count mirrors).
    JOIN pets p
      ON p.id = s.pet_id
      AND p.deleted_at IS NULL
    JOIN ownerships o
      ON o.pet_id = s.pet_id
      AND o.role = 'shelter_custody'
      AND o.ended_at IS NULL
      AND o.owner_organization_id = ${organizationId}
    WHERE s.event_type = 'adoption_application_submitted'
      AND NOT EXISTS (
        SELECT 1 FROM pet_events d
        WHERE d.pet_id = s.pet_id
          AND d.event_type = 'adoption_application_resolved'
          AND d.payload->>'application_event_id' = s.id::text
      )
      AND NOT EXISTS (
        SELECT 1 FROM pet_events f
        WHERE f.pet_id = s.pet_id AND f.event_type = 'adoption_finalized'
      )
  `);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Return the list of animals in this org's active custody that require attention.
 *
 * Flags checked (OR logic — any flag surfaces the animal):
 *   - overdue_vaccine:           latest vaccination_administered.proxima_dosis_at < today
 *   - overdue_deworming:         latest deworming_administered.proxima_dosis_at < today
 *   - active_medication_no_dose: has medication_started with no paired medication_stopped,
 *                                but no medication_dose_taken in the last 24 h
 *   - long_stay:                 ownership.started_at < (now - LONG_STAY_DAYS days)
 *
 * Sorted by daysInCustody descending (longest-stay first).
 * Returns at most 50 results (dashboard queue, not a full list).
 */
export async function fetchRequiresAction(organizationId: string): Promise<RequiresActionItem[]> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10); // YYYY-MM-DD

  // long_stay_days (admin-rules-console, design ADR-4 item 4) — resolved via
  // the ORG's own jurisdiction, once per dashboard render.
  const [org] = await db
    .select({
      jurisdictionCountry: organizations.jurisdictionCountry,
      jurisdictionProvince: organizations.jurisdictionProvince,
      jurisdictionLocality: organizations.jurisdictionLocality,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const longStayRule = await resolveBusinessRule("long_stay_days", {
    country: org?.jurisdictionCountry ?? "AR",
    province: org?.jurisdictionProvince ?? null,
    locality: org?.jurisdictionLocality ?? null,
  });
  const longStayDays = longStayRule.payload.days;

  // Pass timestamps as ISO strings so postgres.js serialises them correctly
  // in raw sql`` templates (Drizzle operators handle Date natively; raw params need explicit ::timestamptz).
  const longStayCutoffIso = new Date(today.getTime() - longStayDays * MS_PER_DAY).toISOString();

  // CTE-based query: compute flags in the inner CTE, then filter on the outer
  // WHERE (not HAVING, which requires GROUP BY). The inner SELECT evaluates
  // each flag as a boolean expression per custody row.
  const rows = await db.execute<ActionRow>(sql`
    WITH flagged AS (
      SELECT
        p.id::text                                                       AS pet_id,
        p.public_token                                                   AS pet_public_token,
        p.name                                                           AS pet_name,
        p.species                                                        AS pet_species,
        EXTRACT(EPOCH FROM (NOW() - o.started_at))::int / 86400         AS days_in_custody,

        -- overdue_vaccine: latest vaccination with proxima_dosis_at in the past
        EXISTS (
          SELECT 1
          FROM pet_events v
          WHERE v.pet_id = p.id
            AND v.event_type = 'vaccination_administered'
            AND v.proxima_dosis_at IS NOT NULL
            AND v.proxima_dosis_at < ${todayStr}::date
            AND NOT EXISTS (
              SELECT 1 FROM pet_events v2
              WHERE v2.pet_id = p.id
                AND v2.event_type = 'vaccination_administered'
                AND v2.occurred_at > v.occurred_at
            )
        ) AS overdue_vaccine,

        -- overdue_deworming: latest deworming with proxima_dosis_at in the past
        EXISTS (
          SELECT 1
          FROM pet_events dw
          WHERE dw.pet_id = p.id
            AND dw.event_type = 'deworming_administered'
            AND dw.proxima_dosis_at IS NOT NULL
            AND dw.proxima_dosis_at < ${todayStr}::date
            AND NOT EXISTS (
              SELECT 1 FROM pet_events dw2
              WHERE dw2.pet_id = p.id
                AND dw2.event_type = 'deworming_administered'
                AND dw2.occurred_at > dw.occurred_at
            )
        ) AS overdue_deworming,

        -- active_medication_no_dose: open medication_started + no dose in last 24h
        EXISTS (
          SELECT 1 FROM pet_events ms
          WHERE ms.pet_id = p.id
            AND ms.event_type = 'medication_started'
            AND NOT EXISTS (
              SELECT 1 FROM pet_events mstop
              WHERE mstop.pet_id = p.id
                AND mstop.event_type = 'medication_stopped'
                AND mstop.payload->>'medication_started_event_id' = ms.id::text
            )
            AND NOT EXISTS (
              SELECT 1 FROM pet_events dose
              WHERE dose.pet_id = p.id
                AND dose.event_type = 'medication_dose_taken'
                AND dose.payload->>'medication_started_event_id' = ms.id::text
                AND dose.occurred_at > NOW() - INTERVAL '24 hours'
            )
        ) AS active_medication_no_dose,

        -- long_stay: custody started before the cutoff date
        (o.started_at < ${longStayCutoffIso}::timestamptz) AS long_stay

      FROM ownerships o
      JOIN pets p ON p.id = o.pet_id
      WHERE o.owner_organization_id = ${organizationId}
        AND o.role = 'shelter_custody'
        AND o.ended_at IS NULL
        -- Art. 16: an erased pet's name must not surface in the action queue.
        AND p.deleted_at IS NULL
    )
    SELECT *
    FROM flagged
    WHERE overdue_vaccine
       OR overdue_deworming
       OR active_medication_no_dose
       OR long_stay
    ORDER BY long_stay DESC, days_in_custody DESC
    LIMIT 50
  `);

  return rows.map((row) => {
    const reasons: ActionReason[] = [];
    if (row.overdue_vaccine) reasons.push("overdue_vaccine");
    if (row.overdue_deworming) reasons.push("overdue_deworming");
    if (row.active_medication_no_dose) reasons.push("active_medication_no_dose");
    if (row.long_stay) reasons.push("long_stay");
    return {
      petId: row.pet_id,
      petPublicToken: row.pet_public_token,
      petName: row.pet_name,
      petSpecies: row.pet_species,
      reasons,
      daysInCustody: Number(row.days_in_custody ?? 0),
    };
  });
}

/**
 * Fetch all four dashboard metrics in parallel.
 *
 * This is the main entry point for the org panel page — runs all projection
 * queries concurrently and returns a flat metrics object.
 */
export async function fetchOrgDashboardMetrics(
  organizationId: string,
): Promise<OrgDashboardMetrics> {
  const [intakesLastWeek, availableForAdopt, activeAdoptions, actionItems] = await Promise.all([
    fetchIntakesLastWeek(organizationId),
    fetchAvailableForAdoption(organizationId),
    fetchActiveAdoptions(organizationId),
    fetchRequiresAction(organizationId),
  ]);
  return {
    intakesLastWeek,
    availableForAdopt,
    activeAdoptions,
    requiresActionCount: actionItems.length,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB — testable without Postgres)
// ---------------------------------------------------------------------------

/** Human-readable label for an ActionReason. */
export function actionReasonLabel(reason: ActionReason): string {
  switch (reason) {
    case "overdue_vaccine":
      return "Vacuna vencida";
    case "overdue_deworming":
      return "Desparasitación vencida";
    case "active_medication_no_dose":
      return "Medicación sin dosis registrada";
    case "long_stay":
      return `Estadía larga (+${LONG_STAY_DAYS} días)`;
  }
}

/** Map an action reason to an a11y-safe icon name (icon + text, never color-only). */
export function actionReasonIcon(reason: ActionReason): string {
  switch (reason) {
    case "overdue_vaccine":
    case "overdue_deworming":
      return "alert-triangle";
    case "active_medication_no_dose":
      return "medicacion";
    case "long_stay":
      return "clock";
  }
}

// ===========================================================================
// Org pending-queue engine (task #18 — org-admin process-clarity)
//
// A single, org-type-gated model of the operator's actionable queues. It powers
// three surfaces from ONE definition + ONE batched fetch:
//   - the panel "Pendientes" card (app/org/[orgToken]/page.tsx)
//   - the sanitary_authority / specialized surfaces (same page)
//   - the nav pending-count badges (app/org/[orgToken]/layout.tsx)
//
// Org-type applicability is derived from the capability model
// (capabilityAppliesToOrgType / SHELTER_ONLY_CAPABILITIES) — the same gate the
// panel action cards and the org nav already use — so a queue is NEVER shown to
// a type that structurally can't have it (no always-zero foster rows on a
// clinic / sanitary authority). Welfare (maltrato) is role-gated, mirroring the
// welfare inbox page + nav, and applies to every org type that receives
// derivations.
// ===========================================================================

/** Stable identifier for each actionable org queue. */
export type OrgQueueKey =
  | "derivedWelfare"
  | "openCases"
  | "rabiesObservations"
  | "pendingTransfers"
  | "pendingFosterProposals"
  | "activeAdoptions"
  | "overdueCheckins"
  | "activeFosters"
  | "pendingPermits";

/**
 * Pure descriptor for an actionable org queue. Gating fields mirror the org nav
 * (`buildOrgNav`) exactly so the panel surface and the sidebar can never
 * disagree about which queues a given member/org-type has.
 */
export type OrgQueueDef = {
  key: OrgQueueKey;
  /** es-AR row label for the Pendientes surface. */
  label: string;
  /** Route path relative to `/org/{orgToken}/` (the click-through target). */
  path: string;
  /**
   * Nav item href suffix (relative to `/org/{orgToken}/`) whose badge this
   * queue feeds. Omitted for queues that have no matching nav item OR that are
   * informational (no badge). Matched against the built nav's item.href.
   */
  navPath?: string;
  requiredCapability?: OrganizationCapability;
  requiredAnyCapability?: readonly OrganizationCapability[];
  requiredRoles?: ReadonlySet<string>;
};

// Welfare inbox roles — mirrors ALLOWED_ROLES in
// app/org/[orgToken]/maltrato/recibidos/page.tsx and WELFARE_NAV_ROLES in
// nav-presets.ts.
const WELFARE_QUEUE_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "coordinator",
  "member",
  "vet_individual",
]);

/**
 * Ordered catalog of actionable org queues (daily-loop priority: welfare and
 * open cases first, adoption pipeline next, informational load last, team admin
 * last). Filtered per org-type + grants + role by `applicableOrgQueues`.
 */
export const ORG_QUEUE_DEFS: readonly OrgQueueDef[] = [
  {
    key: "derivedWelfare",
    label: "Denuncias de maltrato derivadas",
    path: "maltrato/recibidos",
    navPath: "maltrato/recibidos",
    requiredRoles: WELFARE_QUEUE_ROLES,
  },
  {
    key: "openCases",
    label: "Casos abiertos",
    path: "casos",
    navPath: "casos",
    requiredCapability: "pet.read_held",
  },
  {
    // D-6 (Lote D). The vet's ONLY statutory clock had no presence on their own
    // landing: a 10-day rabies observation (Ley 22.953) ran invisibly while the
    // panel showed adoption pipelines. The bite expediente IS the observation
    // (case_kind 'bite_incident' — reportBite opens it and emits
    // rabies_observation_started), so the row links to that kind, filtered open,
    // in the org's own casos list.
    //
    // The count is a SUBSET of what that link shows: it counts only cases whose
    // pet is under an IN-PROGRESS observation, while the list also shows open
    // bite cases whose observation already ended. Same honest asymmetry as the
    // /admin cockpit's "(en curso)" tile (red-team-admin #3), and the label says
    // so rather than letting the two numbers look like a bug.
    //
    // No navPath: the "casos" nav badge already counts every open case, these
    // included. A second queue badging the same item would double-count it.
    key: "rabiesObservations",
    label: "Observaciones antirrábicas en curso",
    path: "casos?kind=bite_incident&status=open",
    requiredCapability: "pet.read_held",
  },
  {
    key: "pendingTransfers",
    label: "Transferencias entrantes pendientes",
    path: "transferencias/recibidas",
    navPath: "transferencias",
    requiredAnyCapability: ["org.transfer.accept"],
  },
  {
    key: "pendingFosterProposals",
    label: "Propuestas de tránsito pendientes",
    path: "voluntarios/propuestas",
    navPath: "voluntarios",
    requiredCapability: "foster.assign",
  },
  {
    key: "activeAdoptions",
    label: "Adopciones en curso",
    path: "adopciones",
    navPath: "adopciones",
    requiredCapability: "adoption.review",
  },
  {
    key: "overdueCheckins",
    label: "Check-ins vencidos",
    path: "checkins",
    navPath: "checkins",
    requiredCapability: "adoption.review",
  },
  {
    key: "activeFosters",
    // Informational load, not a "pending" alert — surfaced on the panel but
    // deliberately NOT badged (no navPath), so the sidebar shows badges only
    // for work that needs a decision.
    label: "Tránsitos activos",
    path: "transitos",
    requiredCapability: "foster.assign",
  },
  {
    key: "pendingPermits",
    label: "Permisos por aprobar",
    path: "admin/permisos",
    navPath: "admin/permisos",
    requiredCapability: "capability.grant",
  },
] as const;

/**
 * Whether a queue applies to the given org-type + grants + role. Capability
 * gates additionally pass through `capabilityAppliesToOrgType`, so a shelter-
 * only capability (foster/adoption) that a clinic/authority admin implicitly
 * holds still does NOT surface its queue for those types.
 */
function queueApplies(
  def: OrgQueueDef,
  orgType: string,
  granted: ReadonlySet<string>,
  role: string | undefined,
): boolean {
  if (def.requiredCapability) {
    const cap = def.requiredCapability;
    if (!(granted.has(cap) && capabilityAppliesToOrgType(cap, orgType))) return false;
  }
  if (def.requiredAnyCapability) {
    const anyOk = def.requiredAnyCapability.some(
      (cap) => granted.has(cap) && capabilityAppliesToOrgType(cap, orgType),
    );
    if (!anyOk) return false;
  }
  if (def.requiredRoles) {
    if (role === undefined || !def.requiredRoles.has(role)) return false;
  }
  return true;
}

/** The ordered queues that apply to this org-type / member, from the catalog. */
export function applicableOrgQueues(
  orgType: string,
  granted: ReadonlySet<string>,
  role: string | undefined,
): OrgQueueDef[] {
  return ORG_QUEUE_DEFS.filter((def) => queueApplies(def, orgType, granted, role));
}

// ---------------------------------------------------------------------------
// Per-queue count helpers (each cheap + indexed). New ones (activeFosters,
// overdueCheckins, derivedWelfare, pendingPermits) fill the inventory gaps the
// pre-verification flagged.
//
// ART. 16 SCOPE LINE, drawn on purpose: counters that count the org's PET
// population (activeFosters, overdueCheckins, activeAdoptions) filter
// `pets.deleted_at` — an erased pet must not keep a seat in them. Counters
// that count the org's own CASE/WORKFLOW rows (openCases, rabiesObservations,
// pendingTransfers, fosterProposals, derivedWelfare, pendingPermits) do NOT:
// each mirrors a list surface (`listCasesForOrg`, transferencias/recibidas)
// that does not filter either, and C2 says badge and list must agree. Whether
// the CASES family should hide an erased pet's identity is that family's
// question — filtering only the badge here would answer it with a lie.
// ---------------------------------------------------------------------------

/**
 * Open cases in this org's casos list — matches `listCasesForOrg`
 * (lib/infra/case-queries.ts) so the badge and the list it links to agree (C2):
 *   - org membership: opener OR active custody holder (same EXISTS-on-ownerships
 *     shape the list uses, avoiding co-owner join fan-out), and
 *   - "open" = closedAt IS NULL (the list's open filter), which counts
 *     `escalated`/`in_progress` cases that a bare status='open' check dropped.
 */
async function countOpenCases(orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(cases)
    .where(
      and(
        or(
          eq(cases.openedByOrganizationId, orgId),
          exists(
            db
              .select({ one: sql`1` })
              .from(ownerships)
              .where(
                and(
                  eq(ownerships.petId, cases.primaryPetId),
                  isNull(ownerships.endedAt),
                  eq(ownerships.ownerOrganizationId, orgId),
                ),
              ),
          ),
        ),
        isNull(cases.closedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Pets under an OPEN rabies observation whose bite expediente belongs to this
 * org (D-6).
 *
 * Org membership uses the SAME predicate as countOpenCases — opener OR active
 * custody holder, the shape `listCasesForOrg` uses — so the tile counts rows the
 * org's own casos list can actually show. Narrowed twice from there: to
 * `bite_incident` (the rabies expediente kind) and to pets whose observation the
 * pets-table cache still marks OPEN. That last predicate is the STATUTORY clock:
 * an observation closed by a professional flips the status even while the case
 * stays open for its own reasons, and this queue is about the observation
 * window, not about case bookkeeping.
 *
 * "Open" includes `window_expired_unclosed` since 2026-08-17. Those are exactly
 * the animals whose observation nobody has closed — and a vet or refugio reading
 * this tile is who can get that closure signed. Keeping the narrow
 * `in_progress` literal would have emptied the tile a day after each window
 * expired, which is when the work STARTS.
 */
async function countRabiesObservations(orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(cases)
    .innerJoin(pets, eq(pets.id, cases.primaryPetId))
    .where(
      and(
        eq(cases.caseKind, "bite_incident"),
        isNull(cases.closedAt),
        openObservationStatusSql(),
        or(
          eq(cases.openedByOrganizationId, orgId),
          exists(
            db
              .select({ one: sql`1` })
              .from(ownerships)
              .where(
                and(
                  eq(ownerships.petId, cases.primaryPetId),
                  isNull(ownerships.endedAt),
                  eq(ownerships.ownerOrganizationId, orgId),
                ),
              ),
          ),
        ),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Open incoming transfers where this org is the receiver — BOTH kinds the
 * transferencias/recibidas inbox shows (C2): routine custody_transfer_handshake
 * AND custody_episode (decomiso) handoffs opened by a sanitary_authority. The
 * decomiso rows carry a hard 7-day legal deadline (Ley 14.346), so omitting them
 * made the badge read `0` while an open state-seizure custody sat in the inbox.
 * Discriminators mirror the inbox queries exactly (receiverOrganizationId +
 * caseKind, decomiso additionally gated on opener.orgType='sanitary_authority').
 */
async function countPendingTransfers(orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(cases)
    .where(
      and(
        eq(cases.receiverOrganizationId, orgId),
        eq(cases.status, "open"),
        or(
          eq(cases.caseKind, "custody_transfer_handshake"),
          and(
            eq(cases.caseKind, "custody_episode"),
            exists(
              db
                .select({ one: sql`1` })
                .from(organizations)
                .where(
                  and(
                    eq(organizations.id, cases.openedByOrganizationId),
                    eq(organizations.orgType, "sanitary_authority"),
                  ),
                ),
            ),
          ),
        ),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Pending foster proposals emitted by this org. */
async function countPendingFosterProposals(orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(fosterProposals)
    .where(and(eq(fosterProposals.organizationId, orgId), eq(fosterProposals.status, "pending")));
  return Number(row?.n ?? 0);
}

/**
 * Active foster placements on pets this org currently holds in custody.
 *
 * Org-scoped-first: DRIVE from this org's active shelter_custody rows (served
 * by `ownerships_owner_organization_id_idx`; the partial unique index
 * `ownerships_one_active_org_shelter_custody_per_pet` keys on pet_id since 0195)
 * and JOIN foster rows by pet_id — the scan is bounded
 * by the org's custody, never the platform-wide foster population. The previous
 * shape put `ownerships f` (all fosters) in the outer position and leaned on the
 * planner decorrelating the EXISTS to reach the org index; the explicit JOIN
 * makes that org-scoping structural, not planner-dependent.
 *
 * No fan-out: `ownerships_one_active_org_shelter_custody_per_pet` guarantees ≤1
 * active ORG-held shelter_custody per pet (a fortiori per (pet, org); the rows
 * this query drives from all carry owner_organization_id), so each matched foster row contributes
 * exactly once — COUNT(*) equals the matched-foster count (same as the old
 * EXISTS), with no dedup needed.
 */
async function countActiveFosters(orgId: string): Promise<number> {
  const rows = await db.execute<{ n: string | number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM ownerships c
    -- Art. 16: neither custody nor foster rows are touched by an erasure;
    -- only the pets row says the animal went dark.
    JOIN pets p
      ON p.id = c.pet_id
      AND p.deleted_at IS NULL
    JOIN ownerships f
      ON f.pet_id = c.pet_id
      AND f.role = 'foster'
      AND f.ended_at IS NULL
    WHERE c.owner_organization_id = ${orgId}
      AND c.role = 'shelter_custody'
      AND c.ended_at IS NULL
  `);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Overdue post-adoption check-in reminders for pets this org adopted out.
 * Promotes the page-local `overdue.length` (checkins/page.tsx) to a shared,
 * bounded count.
 *
 * Org-scoped-first: DRIVE from this org's adoption_finalized events (the
 * previous_owner_organization_id denormalized on the payload bounds the set to
 * this org, ~hundreds of rows) and JOIN overdue post_adoption_checkin reminders
 * by pet_id. `reminders` is the fastest-growing table at national scale (every
 * pet accrues reminders), so it must never be the driver — the previous shape
 * put it in the outer position and relied on the planner decorrelating the
 * EXISTS to avoid a platform-wide reminders scan.
 *
 * DISTINCT on the adopted pet_ids keeps a pet with more than one
 * adoption_finalized event carrying this org (a re-adoption) from
 * double-counting its reminders — one adopted row per pet, preserving the old
 * EXISTS semantics exactly.
 */
async function countOverdueCheckins(orgId: string): Promise<number> {
  const rows = await db.execute<{ n: string | number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM reminders r
    JOIN (
      SELECT DISTINCT e.pet_id
      FROM pet_events e
      -- Art. 16: same filter as checkins/page.tsx, which this count promotes —
      -- the badge and the page must count the same population.
      JOIN pets p ON p.id = e.pet_id AND p.deleted_at IS NULL
      WHERE e.event_type = 'adoption_finalized'
        AND e.payload->>'previous_owner_organization_id' = ${orgId}
    ) adopted ON adopted.pet_id = r.pet_id
    WHERE r.reminder_type = 'post_adoption_checkin'
      AND r.completed_at IS NULL
      AND r.due_at < NOW()
  `);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Welfare reports derived to this org that are still open work: not closed/
 * duplicate/invalid, and not already returned to the government. Fills the
 * inventory gap (maltrato had no count query).
 */
async function countDerivedWelfare(orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(welfareReports)
    .where(
      and(
        eq(welfareReports.derivedToOrganizationId, orgId),
        notInArray(welfareReports.status, ["closed", "duplicate", "invalid"]),
        sql`${welfareReports.orgInterventionStatus} IS DISTINCT FROM 'devuelto'`,
      ),
    );
  return Number(row?.n ?? 0);
}

/** Pending capability-grant requests awaiting an approver in this org. */
async function countPendingPermits(orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(organizationCapabilityGrants)
    .where(
      and(
        eq(organizationCapabilityGrants.organizationId, orgId),
        eq(organizationCapabilityGrants.status, "pending"),
      ),
    );
  return Number(row?.n ?? 0);
}

const QUEUE_COUNTERS: Record<OrgQueueKey, (orgId: string) => Promise<number>> = {
  derivedWelfare: countDerivedWelfare,
  openCases: countOpenCases,
  rabiesObservations: countRabiesObservations,
  pendingTransfers: countPendingTransfers,
  pendingFosterProposals: countPendingFosterProposals,
  activeAdoptions: fetchActiveAdoptions,
  overdueCheckins: countOverdueCheckins,
  activeFosters: countActiveFosters,
  pendingPermits: countPendingPermits,
};

/**
 * Batch-fetch the live counts for exactly the requested queue keys, in
 * parallel. Callers pass the keys from `applicableOrgQueues`, so only queues
 * that apply to this org-type/member ever run a query (ONE shared fetch — the
 * panel surface and the nav badges consume the same result).
 *
 * NEVER-CRASH FAN-OUT (adversarial review 2026-07-10, HIGH 4): uses
 * `Promise.allSettled` — NOT `Promise.all` — so one failing counter (e.g. a
 * `countOverdueCheckins` SQL error) can never abandon its siblings or reject
 * the whole batch. Unlike the panorama KPI strip (which degrades the WHOLE
 * strip on any single fetcher failure — a deliberate all-or-nothing parity
 * contract), each org queue is an independent row with its own click-through:
 * a failed queue degrades to `null` (rendered without a count / badge) while
 * every other queue still shows its live number. Requested-but-failed keys
 * are `null`; keys never requested by the caller default to `0` (unchanged
 * behavior — callers only ever read keys from their own `applicableOrgQueues`
 * list).
 */
export async function fetchOrgQueueCounts(
  orgId: string,
  keys: readonly OrgQueueKey[],
): Promise<Record<OrgQueueKey, number | null>> {
  const unique = Array.from(new Set(keys));
  const settled = await Promise.allSettled(unique.map((key) => QUEUE_COUNTERS[key](orgId)));
  const counts = {
    derivedWelfare: 0,
    openCases: 0,
    rabiesObservations: 0,
    pendingTransfers: 0,
    pendingFosterProposals: 0,
    activeAdoptions: 0,
    overdueCheckins: 0,
    activeFosters: 0,
    pendingPermits: 0,
  } as Record<OrgQueueKey, number | null>;
  unique.forEach((key, i) => {
    const result = settled[i];
    if (result.status === "fulfilled") {
      counts[key] = result.value;
    } else {
      console.error(`[org-dashboard] queue count "${key}" failed`, result.reason);
      counts[key] = null;
    }
  });
  return counts;
}

// ===========================================================================
// Queue SIGNALS — what a count alone cannot say (D-7 / D-10, Lote D)
//
// A count answers "how many?". Two questions the org landing was asking its
// operator to answer by opening every queue:
//
//   D-7  Is any of these past a HARD legal deadline? `pendingQueueTone` decided
//        the pill colour from the queue KEY alone — a pure switch, blind to
//        time — so a decomiso handoff sitting 20 days past the 7-day window of
//        Ley 14.346 painted the same calm "open" tone as one proposed today,
//        while the escalation cron was already paging the authority about it.
//   D-10 How long has the oldest one been waiting? The code itself documented
//        the real case: a panel reading "Todo en orden" beside 2 postulaciones
//        and 2 casos, one of them 35 days old (master test CIU, A-2-b).
//
// DELIBERATELY A SEPARATE FETCH from fetchOrgQueueCounts, not a widened return
// type. The counts feed the nav badges too (app/org/[orgToken]/layout.tsx via
// getOrgQueueCountsCached), and a badge needs a number and nothing else —
// changing that shape would ripple into the layout, the request cache and every
// counts test to serve a panel-only concern. Only the three queues that HAVE a
// deadline or a meaningful wait are covered; asking for any other key returns
// nothing rather than a fabricated zero-age.
//
// Same never-crash posture as the counts: allSettled, and a failed signal is
// simply absent, so the row still renders its count and its link.
// ===========================================================================

/** Aging / deadline facts a queue may carry beyond its count. */
export type OrgQueueSignal = {
  /**
   * AR calendar days the OLDEST pending row has been waiting. null when the
   * queue is empty — never 0-as-unknown.
   */
  oldestAgeDays: number | null;
  /**
   * At least one row is past a hard LEGAL deadline. Only ever true for queues
   * that actually have one (today: decomiso handoffs, Ley 14.346) — a queue
   * with no statutory clock reports false, it does not borrow someone else's.
   */
  hasOverdue: boolean;
};

/** Only these queues carry a signal; the rest have no deadline to report. */
const SIGNAL_QUEUE_KEYS = [
  "pendingTransfers",
  "pendingFosterProposals",
  "activeAdoptions",
] as const satisfies readonly OrgQueueKey[];

type SignalRow = { oldest: Date | string | null; overdue?: number | string | null };

function toSignal(row: SignalRow | undefined, now: Date): OrgQueueSignal {
  const raw = row?.oldest ?? null;
  const oldest = raw === null ? null : raw instanceof Date ? raw : new Date(raw);
  return {
    oldestAgeDays:
      oldest === null || Number.isNaN(oldest.getTime()) ? null : ageInDays(oldest, now),
    hasOverdue: Number(row?.overdue ?? 0) > 0,
  };
}

/**
 * Incoming transfers: age of the oldest open handoff, plus whether any DECOMISO
 * handoff has blown its 7-day window.
 *
 * The overdue predicate mirrors `findStaleDecomisoCandidates` exactly — same
 * discriminators (custody_episode + opener org_type 'sanitary_authority'), same
 * clock (the LATEST custody_transfer_proposed event, so a reassign to another
 * receiver legitimately resets the window), same threshold constant. The tile
 * and the escalation cron therefore cannot disagree about which case is stale.
 */
async function signalPendingTransfers(orgId: string, now: Date): Promise<OrgQueueSignal> {
  const staleBefore = new Date(now.getTime() - DECOMISO_HANDOFF_STALE_DAYS * MS_PER_DAY);
  const rows = await db.execute<SignalRow>(sql`
    SELECT
      MIN(c.opened_at) AS oldest,
      COUNT(*) FILTER (
        WHERE c.case_kind = 'custody_episode'
          AND EXISTS (
            SELECT 1 FROM organizations o
            WHERE o.id = c.opened_by_organization_id
              AND o.org_type = 'sanitary_authority'
          )
          AND (
            SELECT MAX(pe.occurred_at)
            FROM pet_events pe
            WHERE pe.case_id = c.id
              AND pe.event_type = 'custody_transfer_proposed'
          ) < ${staleBefore.toISOString()}::timestamptz
      )::int AS overdue
    FROM cases c
    WHERE c.receiver_organization_id = ${orgId}
      AND c.status = 'open'
      AND (
        c.case_kind = 'custody_transfer_handshake'
        OR (
          c.case_kind = 'custody_episode'
          AND EXISTS (
            SELECT 1 FROM organizations o
            WHERE o.id = c.opened_by_organization_id
              AND o.org_type = 'sanitary_authority'
          )
        )
      )
  `);
  return toSignal(rows[0], now);
}

/**
 * Pending foster proposals: age of the oldest one. No statutory deadline exists
 * for a foster proposal, so `hasOverdue` stays false by construction — the wait
 * is real and worth showing, but calling it "vencida" would invent a rule.
 */
async function signalPendingFosterProposals(orgId: string, now: Date): Promise<OrgQueueSignal> {
  const [row] = await db
    .select({ oldest: sql<Date | null>`min(${fosterProposals.proposedAt})` })
    .from(fosterProposals)
    .where(and(eq(fosterProposals.organizationId, orgId), eq(fosterProposals.status, "pending")));
  return toSignal(row, now);
}

/**
 * Open adoption applications: age of the oldest unresolved postulación. The
 * predicate is `fetchActiveAdoptions`' query verbatim with MIN in place of
 * COUNT, so the age describes exactly the applications the count counts.
 */
async function signalActiveAdoptions(orgId: string, now: Date): Promise<OrgQueueSignal> {
  const rows = await db.execute<SignalRow>(sql`
    SELECT MIN(s.occurred_at) AS oldest
    FROM pet_events s
    -- Art. 16: fetchActiveAdoptions' filter, verbatim — the age must describe
    -- exactly the applications the count counts.
    JOIN pets p
      ON p.id = s.pet_id
      AND p.deleted_at IS NULL
    JOIN ownerships o
      ON o.pet_id = s.pet_id
      AND o.role = 'shelter_custody'
      AND o.ended_at IS NULL
      AND o.owner_organization_id = ${orgId}
    WHERE s.event_type = 'adoption_application_submitted'
      AND NOT EXISTS (
        SELECT 1 FROM pet_events d
        WHERE d.pet_id = s.pet_id
          AND d.event_type = 'adoption_application_resolved'
          AND d.payload->>'application_event_id' = s.id::text
      )
      AND NOT EXISTS (
        SELECT 1 FROM pet_events f
        WHERE f.pet_id = s.pet_id AND f.event_type = 'adoption_finalized'
      )
  `);
  return toSignal(rows[0], now);
}

const QUEUE_SIGNALS: Record<
  (typeof SIGNAL_QUEUE_KEYS)[number],
  (orgId: string, now: Date) => Promise<OrgQueueSignal>
> = {
  pendingTransfers: signalPendingTransfers,
  pendingFosterProposals: signalPendingFosterProposals,
  activeAdoptions: signalActiveAdoptions,
};

/**
 * Batch-fetch the deadline/aging signals for the requested queues, in parallel.
 * Keys with no signal fetcher are skipped silently (they have nothing to
 * report), and a failed one is ABSENT rather than false-y — the caller renders
 * the row without a note instead of asserting "nothing is overdue".
 */
export async function fetchOrgQueueSignals(
  orgId: string,
  keys: readonly OrgQueueKey[],
  now: Date = new Date(),
): Promise<Partial<Record<OrgQueueKey, OrgQueueSignal>>> {
  const wanted = SIGNAL_QUEUE_KEYS.filter((k) => keys.includes(k));
  const settled = await Promise.allSettled(wanted.map((key) => QUEUE_SIGNALS[key](orgId, now)));
  const signals: Partial<Record<OrgQueueKey, OrgQueueSignal>> = {};
  wanted.forEach((key, i) => {
    const result = settled[i];
    if (result.status === "fulfilled") {
      signals[key] = result.value;
    } else {
      console.error(`[org-dashboard] queue signal "${key}" failed`, result.reason);
    }
  });
  return signals;
}
