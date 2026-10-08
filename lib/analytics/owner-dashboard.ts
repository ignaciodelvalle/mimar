// Data layer for the owner dashboard at /inicio.
//
// Every export is a Promise<…[]> shaped to be consumed by a single widget.
// The page calls them in Promise.all to fan out fetching. Queries are
// indexed and capped at ≤ 10 rows where appropriate so the dashboard
// loads in one round-trip without N+1 surprises.
//
// Helpers in here MUST NOT throw — return empty arrays on no-data so the
// widgets can render the empty state uniformly.

import { isRabiesVaccineName } from "@/lib/reference/lookups";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import {
  appointments,
  attachments,
  db,
  notifications,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
  reminders,
  serviceOfferings,
  timeSlots,
} from "@/db";
import { jurisdictionComplianceInputs } from "@/lib/analytics/compliance-rule-inputs";
import {
  type VaccinationSummary,
  computeVaccinationSummary,
} from "@/lib/domain/libreta-health-status";
import {
  type ReminderVariant,
  getReminderVariant,
  isVaccineReportable,
} from "@/lib/domain/vaccine-reminder-state";
import { excludeAuthorityOnlyClause } from "@/lib/events/events";
import { overlayAmendments } from "@/lib/infra/amendment";
import { amendedPayloadText } from "@/lib/infra/amendment-sql";
import {
  type Jurisdiction,
  canonicalJurisdictionKey,
  resolveBusinessRuleForJurisdictions,
} from "@/lib/infra/business-rules-resolver";
import { notReportedClause } from "@/lib/infra/content-reports";
import {
  excludeResolvedLostEpisodeSql,
  excludeStaleWelcomeSql,
} from "@/lib/infra/notification-reconcile";
import { viewerHoldsPetClause } from "@/lib/infra/pet-holder-clause";
import { batchFetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import {
  type ComplianceEvent,
  type ComplianceState,
  type RabiesReminder,
  type ReservedRabiesTurno,
  deriveComplianceState,
} from "@/lib/projections/pet-compliance";
import { formatWeightKg } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Pets
// ---------------------------------------------------------------------------

/**
 * Maximum number of pet rows loaded into JS on the dashboard.
 *
 * For owners with thousands of pets (high-volume shelters / rescue networks)
 * fetching every row without a bound caused OOM / serialization crashes
 * (production incident digest 3058248096, UX audit item 0.3).
 *
 * Callers that need the *total* count use countPetsForOwner() — a single
 * SQL COUNT(*) that never materialises row data.
 */
export const DASHBOARD_PETS_LIMIT = 50;

export type DashboardPet = {
  id: string;
  publicToken: string;
  name: string;
  species: string;
  status: string;
  pregnancyStatus: string | null;
  color: string | null;
  primaryPhotoStoragePath: string | null;
  ownershipRole: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

/**
 * Paginated pet fetch for the owner dashboard.
 *
 * Returns at most `limit` rows (default DASHBOARD_PETS_LIMIT = 50) so the
 * page stays bounded even for high-volume accounts with thousands of pets.
 * The total ownership count is returned separately so the UI can show
 * "showing N of M" without loading all M rows into memory.
 */
export async function fetchPetsForOwner(
  userId: string,
  limit = DASHBOARD_PETS_LIMIT,
): Promise<{ pets: DashboardPet[]; total: number }> {
  // SQL-side COUNT — never materialises row data regardless of volume.
  const [countRow, rows] = await Promise.all([
    db
      .select({ n: count() })
      .from(ownerships)
      .where(and(eq(ownerships.ownerUserId, userId), isNull(ownerships.endedAt)))
      .then((r) => r[0]),
    db
      .select({
        pet: pets,
        photo: attachments,
        ownershipRole: ownerships.role,
      })
      .from(ownerships)
      .innerJoin(pets, eq(pets.id, ownerships.petId))
      .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
      .where(and(eq(ownerships.ownerUserId, userId), isNull(ownerships.endedAt)))
      // UNIQUE, NOT JUST NEWEST FIRST. `created_at` is the transaction's
      // `now()`, so pets written together tie exactly, and without a unique
      // tail the capped page is a different subset per load. Same key as
      // `listOwnerPets`; see there.
      .orderBy(desc(pets.createdAt), desc(pets.id), desc(ownerships.id))
      .limit(limit),
  ]);

  return {
    total: Number(countRow?.n ?? 0),
    pets: rows.map((r) => ({
      id: r.pet.id,
      publicToken: r.pet.publicToken,
      name: r.pet.name,
      species: r.pet.species,
      status: r.pet.status,
      pregnancyStatus: r.pet.pregnancyStatus,
      color: r.pet.color,
      primaryPhotoStoragePath: r.photo?.storagePath ?? null,
      ownershipRole: r.ownershipRole,
      jurisdictionProvince: r.pet.jurisdictionProvince,
      jurisdictionLocality: r.pet.jurisdictionLocality,
    })),
  };
}

/**
 * Minimal per-pet fields the owner credential carousel RANKING needs.
 * Deliberately narrow (no photo, no jurisdiction) so this can load EVERY live
 * ownership without the row-materialisation cost DASHBOARD_PETS_LIMIT guards.
 */
export type CarouselRankingPet = {
  id: string;
  publicToken: string;
  status: string;
  pregnancyStatus: string | null;
};

/**
 * Every LIVE ownership for the owner-carousel ranking — minimal fields, NO cap.
 *
 * The carousel (on /inicio and the pet profile) ranks the owner's live pets by
 * urgency and shows the most urgent first. Sourcing that ranking from
 * fetchPetsForOwner (capped at DASHBOARD_PETS_LIMIT = 50, newest-first) meant an
 * owner with >50 live pets whose most-urgent pet (e.g. a lost one) was older
 * than the newest 50 would NEVER surface it — /inicio landed on the wrong pet
 * and the swipe never reached it (QA ronda 4, CONFIRMED). Ranking must consider
 * the WHOLE household, so this fetch is uncapped.
 *
 * Only the fields resolveCarouselStatus / rankOwnerCarousel read are selected:
 * id (compliance-batch join), publicToken (swipe target), status +
 * pregnancyStatus (the raw-status fallback). rankOwnerCarousel still caps the
 * DISPLAYED swipe at OWNER_CAROUSEL_CAP — only the ranking INPUT is complete.
 * Deceased pets are excluded in SQL so they never enter the swipe (decision 6).
 *
 * Cost note (perf watchpoint): the caller derives compliance over the returned
 * set (fetchComplianceStatesForPets), so for a high-volume owner this widens
 * that batch to every live pet — the price of an honest urgency ranking. Rows
 * here carry no heavy columns, so the pet fetch itself stays light.
 */
export async function fetchLivePetsForCarouselRanking(
  userId: string,
): Promise<CarouselRankingPet[]> {
  const rows = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      status: pets.status,
      pregnancyStatus: pets.pregnancyStatus,
    })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(
      and(
        eq(ownerships.ownerUserId, userId),
        isNull(ownerships.endedAt),
        ne(pets.status, "deceased"),
      ),
    )
    // Deterministic tiebreak — newest first, same as fetchPetsForOwner, so equal
    // urgency keeps a stable order for the stable-sort rank. `created_at` alone
    // was NOT deterministic (pets written in one transaction tie exactly), so
    // the unique tail is what makes the stable sort's input stable.
    .orderBy(desc(pets.createdAt), desc(pets.id), desc(ownerships.id));

  return rows.map((r) => ({
    id: r.id,
    publicToken: r.publicToken,
    status: r.status,
    pregnancyStatus: r.pregnancyStatus,
  }));
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export type UpcomingAppointment = {
  appointment: { publicToken: string; status: string };
  slot: { startsAt: Date };
  offering: { displayName: string; serviceKind: string; organizationId: string | null };
  pet: { name: string };
  org: { displayName: string } | null;
  provider: { displayName: string } | null;
};

export async function fetchUpcomingAppointments(
  userId: string,
  limit = 5,
  petIdFilter?: string,
): Promise<UpcomingAppointment[]> {
  const now = new Date();
  const rows = await db
    .select({
      appointment: { publicToken: appointments.publicToken, status: appointments.status },
      slot: { startsAt: timeSlots.startsAt },
      offering: {
        displayName: serviceOfferings.displayName,
        serviceKind: serviceOfferings.serviceKind,
        organizationId: serviceOfferings.organizationId,
      },
      pet: { name: pets.name },
      org: { displayName: organizations.displayName },
      provider: { displayName: profiles.displayName },
    })
    .from(appointments)
    .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
    .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
    .innerJoin(pets, eq(pets.id, appointments.petId))
    .leftJoin(organizations, eq(organizations.id, serviceOfferings.organizationId))
    .leftJoin(profiles, eq(profiles.id, serviceOfferings.providerUserId))
    .where(
      and(
        eq(appointments.ownerUserId, userId),
        eq(appointments.status, "confirmed"),
        gte(timeSlots.startsAt, now),
        // owner-ia-redesign P3: optional pet scoping so the pet profile can
        // reuse this fetcher for its own upcoming turnos.
        ...(petIdFilter ? [eq(appointments.petId, petIdFilter)] : []),
      ),
    )
    .orderBy(timeSlots.startsAt)
    .limit(limit);

  // Drizzle's leftJoin returns columns from the joined table that may be
  // null when the join didn't match. The shared AppointmentCard already
  // handles null org/provider; just normalize.
  return rows.map((r) => ({
    appointment: r.appointment,
    slot: r.slot,
    offering: r.offering,
    pet: r.pet,
    org: r.org?.displayName ? { displayName: r.org.displayName } : null,
    provider: r.provider?.displayName ? { displayName: r.provider.displayName } : null,
  }));
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type DashboardNotification = {
  notification: typeof notifications.$inferSelect;
  pet: { publicToken: string; name: string } | null;
};

export async function fetchUnreadNotifications(
  userId: string,
  limit = 5,
): Promise<DashboardNotification[]> {
  const rows = await db
    .select({ notification: notifications, pet: pets })
    .from(notifications)
    .leftJoin(pets, eq(notifications.relatedPetId, pets.id))
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.archivedAt),
        excludeResolvedLostEpisodeSql,
        excludeStaleWelcomeSql,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    notification: r.notification,
    pet: r.pet ? { publicToken: r.pet.publicToken, name: r.pet.name } : null,
  }));
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.archivedAt),
        excludeResolvedLostEpisodeSql,
        excludeStaleWelcomeSql,
      ),
    );
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Ongoing medical treatments — medication_started without medication_stopped
// ---------------------------------------------------------------------------

export type OngoingMedication = {
  eventId: string;
  petName: string;
  petPublicToken: string;
  drugName: string;
  frequency: string | null;
  startedAt: Date;
};

export async function fetchOngoingMedications(userId: string): Promise<OngoingMedication[]> {
  // drug_name/frequency are amendable (medication_started): a prescription
  // corrected from one drug to another must show the CORRECTED value here,
  // not the raw payload one (see lib/analytics/surveillance-metrics.ts
  // fetchAmrDensity for the same class of fix on drug_code).
  const drugName = amendedPayloadText("drug_name", {
    id: sql`e.id`,
    payload: sql`e.payload`,
    petId: sql`e.pet_id`,
  });
  const frequency = amendedPayloadText("frequency", {
    id: sql`e.id`,
    payload: sql`e.payload`,
    petId: sql`e.pet_id`,
  });
  const rows = await db.execute<{
    event_id: string;
    pet_name: string;
    pet_public_token: string;
    drug_name: string;
    frequency: string | null;
    started_at: string;
  }>(sql`
    SELECT
      e.id::text AS event_id,
      p.name AS pet_name,
      p.public_token AS pet_public_token,
      COALESCE(${drugName}, 'Medicación') AS drug_name,
      ${frequency} AS frequency,
      e.occurred_at::text AS started_at
    FROM pet_events e
    JOIN pets p ON p.id = e.pet_id
    JOIN ownerships o ON o.pet_id = p.id
     AND o.owner_user_id = ${userId}
     AND o.ended_at IS NULL
    WHERE e.event_type = 'medication_started'
      AND NOT EXISTS (
        SELECT 1 FROM pet_events stop
        WHERE stop.event_type = 'medication_stopped'
          AND stop.pet_id = e.pet_id
          AND stop.payload->>'medication_started_event_id' = e.id::text
      )
    ORDER BY e.occurred_at DESC
    LIMIT 20
  `);

  return rows.map((r) => ({
    eventId: r.event_id,
    petName: r.pet_name,
    petPublicToken: r.pet_public_token,
    drugName: r.drug_name,
    frequency: r.frequency,
    startedAt: new Date(r.started_at),
  }));
}

// ---------------------------------------------------------------------------
// Living-pet localities (for the regulations placeholder)
// ---------------------------------------------------------------------------

export async function fetchLivingPetLocalities(
  userId: string,
): Promise<Array<{ province: string; locality: string | null }>> {
  const rows = await db
    .selectDistinct({
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(ownerships.ownerUserId, userId),
        isNull(ownerships.endedAt),
        ne(pets.status, "deceased"),
        isNotNull(pets.jurisdictionProvince),
      ),
    );
  return rows
    .filter((r): r is { province: string; locality: string | null } => r.province !== null)
    .map((r) => ({ province: r.province, locality: r.locality }));
}

// ---------------------------------------------------------------------------
// Active vaccine reminders
// ---------------------------------------------------------------------------

export type ActiveReminderRow = {
  reminderId: string;
  petId: string;
  petName: string;
  petToken: string;
  petSpecies: string;
  title: string;
  dueAt: Date;
  daysUntilDue: number;
  variant: ReminderVariant;
  isReportable: boolean;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Variant priority for sorting: lowest number = highest priority.
const VARIANT_ORDER: Record<ReminderVariant, number> = {
  overdue_critical: 0,
  overdue: 1,
  due_soon: 2,
  upcoming: 3,
  success: 4,
};

async function fetchActiveRemindersBase(
  userId: string,
  petIdFilter?: string,
  rowLimit?: number,
): Promise<ActiveReminderRow[]> {
  const now = new Date();

  // Decision D4: fetch pending reminders ordered by urgency.
  // A row cap is applied when rowLimit is provided (dashboard path) to prevent
  // materialising thousands of rows for high-volume owners. Per-pet drilldown
  // paths pass no limit so the full pet history is available.
  const query = db
    .select({
      reminderId: reminders.id,
      petId: pets.id,
      petName: pets.name,
      petToken: pets.publicToken,
      petSpecies: pets.species,
      petLocality: pets.jurisdictionLocality,
      title: reminders.title,
      dueAt: reminders.dueAt,
    })
    .from(reminders)
    .innerJoin(pets, eq(pets.id, reminders.petId))
    // Re-scope to pets the user CURRENTLY owns. A reminder carries the userId of
    // whoever created it, but ownership can move (transfer, seed reassignment):
    // a reminder left behind on a since-reassigned pet must NOT surface on the
    // creator's /inicio, or the owner sees an alert for a pet they no longer own
    // and cannot act on (UX gate M4 — "Firulais" non-owned-pet alert). The
    // ownership join makes the reminder query obey the same owner-scope as every
    // other dashboard read.
    .innerJoin(
      ownerships,
      and(
        eq(ownerships.petId, reminders.petId),
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    )
    .where(
      and(
        eq(reminders.userId, userId),
        eq(reminders.reminderType, "vaccine"),
        isNull(reminders.completedAt),
        or(isNull(reminders.snoozedUntil), lte(reminders.snoozedUntil, now)),
        ...(petIdFilter ? [eq(reminders.petId, petIdFilter)] : []),
      ),
    )
    .orderBy(reminders.dueAt);

  const rows = rowLimit ? await query.limit(rowLimit) : await query;

  return rows
    .map((r) => {
      const daysUntilDue = Math.round((r.dueAt.getTime() - now.getTime()) / MS_PER_DAY);
      const reportable = isVaccineReportable(r.title, r.petSpecies, r.petLocality ?? "");
      const variant = getReminderVariant(daysUntilDue, reportable);
      return {
        reminderId: r.reminderId,
        petId: r.petId,
        petName: r.petName,
        petToken: r.petToken,
        petSpecies: r.petSpecies,
        title: r.title,
        dueAt: r.dueAt,
        daysUntilDue,
        variant,
        isReportable: reportable,
      };
    })
    .sort((a, b) => {
      const orderDiff = VARIANT_ORDER[a.variant] - VARIANT_ORDER[b.variant];
      if (orderDiff !== 0) return orderDiff;
      return a.dueAt.getTime() - b.dueAt.getTime();
    });
}

/**
 * Maximum reminder rows returned to the dashboard.
 *
 * The dashboard widget shows at most 4 rows (reminders.slice(0, 4)) and the
 * KPI counter only needs the total count — not full rows. Loading thousands of
 * reminder rows for a high-volume owner wastes memory and serialization time.
 *
 * Callers that need the exact count use countActiveReminders() instead.
 */
export const DASHBOARD_REMINDERS_LIMIT = 100;

/**
 * Active vaccine reminders for an owner, capped at DASHBOARD_REMINDERS_LIMIT.
 *
 * Decision D4 intent (count parity) is preserved: the KPI counter on /inicio
 * should use countActiveReminders() for the accurate total, while this function
 * returns the highest-priority rows for display. For accounts with ≤ 100 pending
 * reminders the count equals the array length, so existing callers that relied
 * on `reminders.length` for the count see no change in typical usage.
 *
 * For high-volume owners the count may exceed the limit — callers should use
 * countActiveReminders() when they need the precise total.
 *
 * Ordered by variant priority: overdue_critical → overdue → due_soon → upcoming.
 * Within a variant, oldest dueAt first.
 */
export async function fetchActiveReminders(userId: string): Promise<ActiveReminderRow[]> {
  return fetchActiveRemindersBase(userId, undefined, DASHBOARD_REMINDERS_LIMIT);
}

/**
 * SQL COUNT of pending vaccine reminders for an owner — no rows materialised.
 * Use this for the dashboard KPI counter when you need the precise total
 * independently of the DASHBOARD_REMINDERS_LIMIT cap on fetchActiveReminders.
 */
export async function countActiveReminders(userId: string): Promise<number> {
  const now = new Date();
  const [row] = await db
    .select({ n: count() })
    .from(reminders)
    // Same current-ownership re-scope as fetchActiveRemindersBase so the KPI
    // count never includes a reminder for a since-reassigned pet (UX gate M4).
    .innerJoin(
      ownerships,
      and(
        eq(ownerships.petId, reminders.petId),
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    )
    .where(
      and(
        eq(reminders.userId, userId),
        eq(reminders.reminderType, "vaccine"),
        isNull(reminders.completedAt),
        or(isNull(reminders.snoozedUntil), lte(reminders.snoozedUntil, now)),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Same as fetchActiveReminders but scoped to a single pet.
 * Used by PetReminders on the pet detail page. No row cap — per-pet volumes
 * are small and the full history is needed for accurate state display.
 */
export async function fetchActiveRemindersForPet(
  userId: string,
  petId: string,
): Promise<ActiveReminderRow[]> {
  return fetchActiveRemindersBase(userId, petId);
}

// ---------------------------------------------------------------------------
// Batch compliance projection — one status truth across surfaces
// ---------------------------------------------------------------------------

// Event types deriveComplianceState reads. A subset of
// PROFILE_V2_TYPED_EVENT_TYPES — the lists only need the obligation events,
// not medication/pregnancy/scan history.
const COMPLIANCE_EVENT_TYPES = [
  "vaccination_administered",
  "sterilization_performed",
  "microchip_implanted",
  "dangerous_breed_attested",
  // Corrections — fetched so overlayAmendments projects corrected payloads
  // before deriveComplianceState reads them (projection-cron audit
  // 2026-07-03 A). Inert beyond the overlay: the deriver filters by type.
  "event_amended",
] as const;

// Same rabies-reminder matcher the pet-profile header uses.
// Rabies is recognised by THE shared matcher (isRabiesVaccineName, folded for
// accents and case) — one rule across every surface (surface audit 2026-10-07).

/**
 * Derive the compliance projection for a batch of pets in 4 bounded queries,
 * so list surfaces (/inicio registry, /mis-mascotas) can show the SAME
 * AL DÍA / REGISTRADA chip the pet-profile header derives — QA round 2
 * (2026-07-03 #4) caught three different status truths for one pet.
 *
 * `microchipCode` is now sourced from `batchFetchActiveIdentifications` (one
 * bounded query keyed by petId, same source the profile header uses via
 * `fetchActiveIdentifications`) so a pet with a declared chip reads "Microchip
 * declarado" on the list exactly as it does on the profile, instead of the
 * "Sin registro" the previous `null` produced (QA: list vs profile mismatch).
 *
 * Never throws — returns an empty map when petIds is empty.
 */
export async function fetchComplianceStatesForPets(
  userId: string,
  petIds: string[],
): Promise<Map<string, ComplianceState>> {
  if (petIds.length === 0) return new Map();
  const now = new Date();

  // Bind the chip read to the caller BEFORE fetching it.
  //
  // This signature reads as authorized — `userId` first, `petIds` second — but
  // until now `userId` only filtered the `reminders` lookup below (`eq(
  // reminders.userId, userId)`). `petIds` went straight into
  // batchFetchActiveIdentifications, whose result lands in the microchip
  // ObligationCard's `detail` as the raw 15-digit canonical code
  // (lib/projections/pet-compliance.ts deriveMicrochip). So the function
  // answered "give me the chip of any pet id" for any caller.
  //
  // No live caller abuses that — all three resolve petIds from an
  // ownership-bound query first (mis-mascotas/page.tsx, inicio/page.tsx,
  // mis-mascotas/[publicToken]/page.tsx, all via the same
  // `ownerships.ownerUserId = userId AND ended_at IS NULL` predicate). But a
  // parameter that LOOKS like the authorization and isn't is exactly the shape
  // of both microchip disclosures fixed on 2026-07-31: a caller-chosen pet id
  // plus a guard that only proves identity. The next caller inherits the trap.
  //
  // Only the identifications read is narrowed. Events/reminders/turnos keep the
  // full petIds so no card silently disappears — an unowned pet now yields a
  // "Sin registro" microchip card instead of the code, never a crash.
  const ownedPetRows = await db
    .select({ petId: ownerships.petId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.ownerUserId, userId),
        isNull(ownerships.endedAt),
        inArray(ownerships.petId, petIds),
      ),
    );
  const chipReadablePetIds = [...new Set(ownedPetRows.map((r) => r.petId))];

  const [eventRows, reminderRows, petRows, turnoRows, identsByPet] = await Promise.all([
    // Obligation events with provenance (H1: only professional/institutional
    // events clear an obligation). `id` feeds overlayAmendments' target match.
    db
      .select({
        id: petEvents.id,
        petId: petEvents.petId,
        eventType: petEvents.eventType,
        payload: petEvents.payload,
        occurredAt: petEvents.occurredAt,
        authorRole: petEvents.authorRole,
        authorVerified: petEvents.authorVerified,
        authorOrganizationId: petEvents.authorOrganizationId,
      })
      .from(petEvents)
      .where(
        and(
          inArray(petEvents.petId, petIds),
          inArray(petEvents.eventType, [...COMPLIANCE_EVENT_TYPES]),
        ),
      )
      .orderBy(asc(petEvents.occurredAt)),
    // Open vaccine reminders for these pets (variant computed below — same
    // derivation as fetchActiveRemindersBase).
    db
      .select({
        petId: reminders.petId,
        title: reminders.title,
        dueAt: reminders.dueAt,
        petSpecies: pets.species,
        petLocality: pets.jurisdictionLocality,
      })
      .from(reminders)
      .innerJoin(pets, eq(pets.id, reminders.petId))
      .where(
        and(
          eq(reminders.userId, userId),
          eq(reminders.reminderType, "vaccine"),
          isNull(reminders.completedAt),
          or(isNull(reminders.snoozedUntil), lte(reminders.snoozedUntil, now)),
          inArray(reminders.petId, petIds),
        ),
      ),
    // PPP jurisdiction gate + PPP-determinability inputs. species/breed/weight are
    // needed so a DOG missing breed and/or weight surfaces the "Faltan datos" PPP
    // obligation on the LIST exactly as it does on the profile (review 02-6): the
    // profile passes these to deriveComplianceState but the list omitted them, so
    // the indeterminado card was silently absent from /inicio.
    db
      .select({
        id: pets.id,
        ppp: pets.potentiallyDangerousBreed,
        species: pets.species,
        breed: pets.breed,
        estimatedWeightKg: pets.estimatedWeightKg,
        // Age input for the rule-driven age gates (T1-G1) — the list must judge
        // "aún no corresponde" exactly as the profile does.
        dateOfBirth: pets.dateOfBirth,
        // Jurisdiction pair for the microchip_required rule resolution below —
        // the LIST must gate the microchip card exactly as the profile does
        // (adversarial review 2026-07-18 W2: omitting it re-shows "falta
        // microchip" on /inicio for pets whose jurisdiction opted out).
        jurisdictionProvince: pets.jurisdictionProvince,
        jurisdictionLocality: pets.jurisdictionLocality,
      })
      .from(pets)
      .where(inArray(pets.id, petIds)),
    // Reserved rabies turnos (WS-2) — presence flips the rabies card to
    // "Turno reservado", which is NOT ok, matching the header.
    db
      .select({ petId: appointments.petId, slotStartsAt: timeSlots.startsAt })
      .from(appointments)
      .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
      .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
      .where(
        and(
          inArray(appointments.petId, petIds),
          eq(appointments.status, "confirmed"),
          eq(serviceOfferings.serviceKind, "vaccination_rabies"),
          gte(timeSlots.startsAt, now),
        ),
      )
      .orderBy(asc(timeSlots.startsAt)),
    // Active chip/tattoo rows (bounded — one query keyed by petId, list capped
    // at 200). Feeds `microchipCode` so the list's microchip card matches the
    // profile's "Declarado" wording instead of "Sin registro".
    // Keyed by chipReadablePetIds, NOT petIds — see the ownership intersection
    // above; this is the only read in this function that returns PII.
    batchFetchActiveIdentifications(chipReadablePetIds),
  ]);

  // Project corrections BEFORE grouping (D2 at the read boundary —
  // projection-cron audit 2026-07-03 A): an amended dose date/name feeds the
  // compliance chip corrected. One global pass works because event ids are
  // unique and amendments always target same-pet events.
  const projectedEventRows = overlayAmendments(eventRows);

  const eventsByPet = new Map<string, ComplianceEvent[]>();
  for (const r of projectedEventRows) {
    const list = eventsByPet.get(r.petId) ?? [];
    list.push({
      eventType: r.eventType,
      payload: r.payload,
      occurredAt: r.occurredAt,
      authorRole: r.authorRole,
      authorVerified: r.authorVerified,
      authorOrganizationId: r.authorOrganizationId,
    });
    eventsByPet.set(r.petId, list);
  }

  // Highest-priority rabies reminder per pet — same variant ordering the
  // dashboard uses, then first title match (mirrors the profile header's
  // petActiveReminders.find).
  const rabiesReminderByPet = new Map<string, RabiesReminder>();
  const reminderCandidates = reminderRows
    .filter((r) => isRabiesVaccineName(r.title))
    .map((r) => {
      const daysUntilDue = Math.round((r.dueAt.getTime() - now.getTime()) / MS_PER_DAY);
      const reportable = isVaccineReportable(r.title, r.petSpecies, r.petLocality ?? "");
      return {
        petId: r.petId,
        dueAt: r.dueAt,
        variant: getReminderVariant(daysUntilDue, reportable),
      };
    })
    .sort((a, b) => {
      const orderDiff = VARIANT_ORDER[a.variant] - VARIANT_ORDER[b.variant];
      if (orderDiff !== 0) return orderDiff;
      return a.dueAt.getTime() - b.dueAt.getTime();
    });
  for (const r of reminderCandidates) {
    if (!rabiesReminderByPet.has(r.petId)) {
      rabiesReminderByPet.set(r.petId, { variant: r.variant, dueAt: r.dueAt });
    }
  }

  const turnoByPet = new Map<string, ReservedRabiesTurno>();
  for (const r of turnoRows) {
    if (r.petId !== null && !turnoByPet.has(r.petId)) {
      turnoByPet.set(r.petId, { date: r.slotStartsAt, provider: null });
    }
  }

  const petInfoByPet = new Map(petRows.map((r) => [r.id, r]));

  // Resolve the three tiered obligation rules once per DISTINCT jurisdiction
  // (spec CS1 — the pre-tier version resolved microchip_required only). The
  // rule resolver cascades per call and an owner's pets cluster in few
  // jurisdictions, so this stays O(distinct jurisdictions × 3 rule types),
  // never O(pets) — same batch pattern, widened. Same tiers the profile
  // threads; NULL tiers preserve the pre-tier behavior via the
  // obligationRuleInfo / microchipObligationRuleInfo (OR5) fallbacks.
  const distinctJurisdictions = new Map<string, Jurisdiction>();
  for (const r of petRows) {
    const jurisdiction: Jurisdiction = {
      province: r.jurisdictionProvince,
      locality: r.jurisdictionLocality,
    };
    distinctJurisdictions.set(canonicalJurisdictionKey(jurisdiction), jurisdiction);
  }
  const jurisdictionList = [...distinctJurisdictions.values()];
  const [rabiesRuleByKey, sterilizationRuleByKey, microchipRuleByKey] = await Promise.all([
    resolveBusinessRuleForJurisdictions("rabies_vaccination", jurisdictionList),
    resolveBusinessRuleForJurisdictions("sterilization", jurisdictionList),
    resolveBusinessRuleForJurisdictions("microchip_required", jurisdictionList),
  ]);

  const result = new Map<string, ComplianceState>();
  for (const petId of petIds) {
    const petInfo = petInfoByPet.get(petId);
    const jurisdictionKey = canonicalJurisdictionKey({
      province: petInfo?.jurisdictionProvince ?? null,
      locality: petInfo?.jurisdictionLocality ?? null,
    });
    result.set(
      petId,
      deriveComplianceState({
        now,
        events: eventsByPet.get(petId) ?? [],
        rabiesReminder: rabiesReminderByPet.get(petId) ?? null,
        reservedRabiesTurno: turnoByPet.get(petId) ?? null,
        microchipCode: identsByPet.get(petId)?.microchip?.code ?? null,
        pppApplies: Boolean(petInfo?.ppp),
        ...jurisdictionComplianceInputs(
          rabiesRuleByKey.get(jurisdictionKey),
          sterilizationRuleByKey.get(jurisdictionKey),
          microchipRuleByKey.get(jurisdictionKey),
        ),
        dateOfBirth: petInfo?.dateOfBirth ?? null,
        // Same PPP-determinability inputs the profile passes (review 02-6).
        species: petInfo?.species ?? null,
        breed: petInfo?.breed ?? null,
        estimatedWeightKg: petInfo?.estimatedWeightKg ?? null,
      }),
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Batch vaccination summaries — the owner-home credential carousel (task #9)
// ---------------------------------------------------------------------------

// Event types the vaccine-vigencia summary reads. vaccination_administered is
// the dose record; event_amended is overlaid first so a corrected dose date /
// next_due feeds the summary corrected (same read-boundary D2 pattern as
// fetchComplianceStatesForPets).
const VACCINE_SUMMARY_EVENT_TYPES = ["vaccination_administered", "event_amended"] as const;

/**
 * Per-pet vaccine-vigencia summary (Vigente / Por vencer / Vencida counts) for
 * a bounded set of pets — the credential carousel card body on /inicio.
 *
 * Reuses the SAME pure derivation the libreta face and VacunasStatusBadges use
 * (`computeVaccinationSummary`), so a card's badge counts can never disagree
 * with the pet profile. One bounded, indexed query keyed by petId (the carousel
 * is capped at OWNER_CAROUSEL_CAP pets), then pure per-pet derivation.
 *
 * Never throws — returns an empty map when `petSpecies` is empty.
 */
export async function fetchVaccinationSummariesForPets(
  petSpecies: Array<{ petId: string; species: string }>,
): Promise<Map<string, VaccinationSummary>> {
  if (petSpecies.length === 0) return new Map();
  const petIds = petSpecies.map((p) => p.petId);
  const now = new Date();

  const eventRows = await db
    .select({
      id: petEvents.id,
      petId: petEvents.petId,
      eventType: petEvents.eventType,
      payload: petEvents.payload,
      occurredAt: petEvents.occurredAt,
      // Provenance only (QA v14 P2a review): without the author columns every
      // dose had no provenance and an owner-declared one counted as "Vigente"
      // on the card, against the credential front's "Declarada".
      authorRole: petEvents.authorRole,
      authorVerified: petEvents.authorVerified,
      authorOrganizationId: petEvents.authorOrganizationId,
    })
    .from(petEvents)
    .where(
      and(
        inArray(petEvents.petId, petIds),
        inArray(petEvents.eventType, [...VACCINE_SUMMARY_EVENT_TYPES]),
      ),
    )
    .orderBy(asc(petEvents.occurredAt));

  // Project corrections BEFORE grouping (D2 at the read boundary), same as the
  // compliance batch loader above.
  const eventsByPet = new Map<
    string,
    Array<{
      eventType: string;
      occurredAt: Date;
      payload: unknown;
      authorRole: string;
      authorVerified: boolean;
      authorOrganizationId: string | null;
    }>
  >();
  for (const r of overlayAmendments(eventRows)) {
    const list = eventsByPet.get(r.petId) ?? [];
    list.push({
      eventType: r.eventType,
      occurredAt: r.occurredAt,
      payload: r.payload,
      authorRole: r.authorRole,
      authorVerified: r.authorVerified,
      authorOrganizationId: r.authorOrganizationId,
    });
    eventsByPet.set(r.petId, list);
  }

  const result = new Map<string, VaccinationSummary>();
  for (const { petId, species } of petSpecies) {
    result.set(petId, computeVaccinationSummary(eventsByPet.get(petId) ?? [], species, now));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Notifications by category (for /notificaciones tab filtering — C4)
// ---------------------------------------------------------------------------

export type NotificationCategoryCounts = {
  all: number;
  health: number;
  custody: number;
  adoption: number;
  welfare: number;
  admin: number;
  perdidas: number;
  perdidasUrgent: number;
};

/**
 * Count UNREAD (read_at IS NULL), non-archived notifications for a user,
 * optionally scoped to a category. Spans ALL rows — not a single page.
 *
 * The /notificaciones header used to derive its "N sin leer" figure by
 * filtering the current ≤100-row page in memory, so an owner with more than a
 * page of unread notifications saw an understated count (consistency review
 * 2026-07-04 C.3). This aggregate is the authoritative count.
 */
export async function fetchUnreadNotificationCount(
  userId: string,
  category?: string,
): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n
    FROM notifications
    WHERE user_id = ${userId}
      AND archived_at IS NULL
      AND read_at IS NULL
      AND ${excludeResolvedLostEpisodeSql}
      AND ${excludeStaleWelcomeSql}
      ${category ? sql`AND category = ${category}` : sql``}
  `);
  return Number(rows[0]?.n ?? "0");
}

/**
 * Returns per-category counts for non-archived notifications scoped to a user.
 * Notifications without a category are counted in 'all' only.
 */
export async function fetchNotificationCategoryCounts(
  userId: string,
): Promise<NotificationCategoryCounts> {
  const rows = await db.execute<{
    category: string | null;
    severity: string | null;
    n: string;
  }>(sql`
    SELECT category, severity, COUNT(*)::text AS n
    FROM notifications
    WHERE user_id = ${userId}
      AND archived_at IS NULL
      AND ${excludeResolvedLostEpisodeSql}
      AND ${excludeStaleWelcomeSql}
    GROUP BY category, severity
  `);

  const counts: NotificationCategoryCounts = {
    all: 0,
    health: 0,
    custody: 0,
    adoption: 0,
    welfare: 0,
    admin: 0,
    perdidas: 0,
    perdidasUrgent: 0,
  };

  for (const r of rows) {
    const n = Number(r.n);
    counts.all += n;
    const cat = r.category;
    if (cat === "health") counts.health += n;
    else if (cat === "custody") counts.custody += n;
    else if (cat === "adoption") counts.adoption += n;
    else if (cat === "welfare") counts.welfare += n;
    else if (cat === "admin") counts.admin += n;
    else if (cat === "perdidas") {
      counts.perdidas += n;
      if (r.severity === "urgent") counts.perdidasUrgent += n;
    }
    // null category → counted in 'all' only (already added above)
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Pet weight history (Chunk J — PetWeightChart data source)
// ---------------------------------------------------------------------------

export type PetWeightSample = {
  date: Date;
  kg: number;
};

/**
 * Latest weight_recorded events for a pet within the last 12 months,
 * ordered ascending by occurredAt. Payload kg is stored as either a string
 * or a number depending on recording path — normalised to number here.
 *
 * Returns an empty array (never throws) when there are no qualifying events
 * or the pet has no weight history.
 *
 * `viewerId` is the ACCESS PREDICATE, not a label (A01-5, 2026-09-18): the
 * query only returns rows for a pet the viewer holds (viewerHoldsPetClause), so
 * a caller that skipped requirePetAccess gets an empty history, not the pet's.
 */
export async function fetchPetWeightHistory(
  viewerId: string,
  petId: string,
): Promise<PetWeightSample[]> {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);

  // Fetched with the pet's event_amended rows and projected in TS (was a
  // SQL-side payload->>'kg' read) so a CORRECTED weight flows into the
  // sparkline — projection-cron audit 2026-07-03 A. Amendments are fetched
  // unwindowed: a correction recorded today can target a dose from months ago.
  const rows = await db
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        viewerHoldsPetClause(viewerId, petEvents.petId),
        or(
          and(
            eq(petEvents.eventType, "weight_recorded"),
            gte(petEvents.occurredAt, twelveMonthsAgo),
          ),
          eq(petEvents.eventType, "event_amended"),
        ),
      ),
    )
    .orderBy(asc(petEvents.occurredAt));

  const samples: PetWeightSample[] = [];
  for (const r of overlayAmendments(rows)) {
    if (r.eventType !== "weight_recorded") continue;
    const raw = (r.payload as Record<string, unknown>).kg;
    const kg = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
    if (!Number.isFinite(kg)) continue;
    samples.push({ date: new Date(r.occurredAt), kg });
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Pet profile v2 — targeted event queries
// ---------------------------------------------------------------------------

/**
 * Whitelisted event types for the pet profile v2 page.
 *
 * These are the only event types fetched for state-computing components
 * (PetCurrentStateSection, AchievementsSection) and for the collapsed
 * PetHealthTimeline preview (recentFive — all types).
 *
 * Guard rule: every event_type consumed by ACHIEVEMENTS_CATALOG computeStatus
 * functions AND by state-computing components MUST be listed here. The test
 * in __tests__/pet-profile-v2-events.test.ts asserts this invariant.
 */
export const PROFILE_V2_TYPED_EVENT_TYPES = [
  // Medication lifecycle — Cuidados próximos state + A4 / estado actual
  "medication_started",
  "medication_stopped",
  // Pregnancy — A4 achievement (live birth): the actual event type is
  // clinical_info_logged with sub_kind='pregnancy'; there are no standalone
  // pregnancy_started / pregnancy_ended event types in the DB.
  "clinical_info_logged",
  // Vaccination — rabies observation label + A-future vaccine state
  "vaccination_administered",
  // Adoption — A2 achievement
  "adoption_finalized",
  // Lost-and-found — A3 achievement
  "status_changed",
  // Weight — Estado actual weight + "hace X" suffix
  "weight_recorded",
  // Sterilization — Estado actual sterilized flag
  "sterilization_performed",
  // Tattoo — Estado actual (R5, fold from tattoo-identifier)
  "tattoo_recorded",
  // Microchip — Estado actual chip line
  "microchip_recorded",
  "microchip_implanted",
  // PPP attestation — Credencial compliance stamp + ppp row (pet-document-redesign REQ-10.1).
  // Was missing from this whitelist, so fetchPetEventsForProfileV2 silently
  // dropped the event before it reached derivePpp or the direct ppp.attested
  // prop, making an attested PPP always render "Atestación pendiente".
  "dangerous_breed_attested",
  // Corrections — fetched so overlayAmendments can project corrected payloads
  // over the typed stream (projection-cron audit 2026-07-03 A). Consumers
  // filter by eventType, so the extra rows are inert beyond the overlay.
  "event_amended",
] as const;

export type ProfileV2TypedEventType = (typeof PROFILE_V2_TYPED_EVENT_TYPES)[number];

/**
 * Metadata-only projection of a pet event — used by the collapsed
 * PetHealthTimeline header preview. No attachment URLs, no full payload.
 */
export interface PetEventMetadata {
  id: string;
  eventType: string;
  occurredAt: Date;
  /**
   * Short preview label for the collapsed timeline header, derived per event
   * type from the payload keys the writer schemas actually emit (see
   * deriveEventSummary). Null for event types with nothing sensible to preview.
   */
  summary: string | null;
}

/**
 * Return shape of fetchPetEventsForProfileV2.
 */
export interface PetProfileV2Events {
  /**
   * Whitelisted event types used by state-computing components
   * (achievements, PetCurrentStateSection, PetHealthTimeline state).
   * Ordered ASC by occurred_at.
   */
  typedEvents: (typeof petEvents.$inferSelect)[];
  /**
   * Last 5 events overall, metadata only — no attachment URL signing.
   * Used by the collapsed PetHealthTimeline header preview.
   */
  recentFive: PetEventMetadata[];
}

/**
 * Derive the collapsed-timeline preview line for an event, reading ONLY keys the
 * writer schemas in lib/events/event-schemas.ts actually emit.
 *
 * The header preview historically read `payload.summary`, a key NO schema ever
 * writes — so the line was always null in production (lint:events ghost-key
 * finding). Each case below maps an event type to its most human-meaningful
 * payload field; types with nothing worth previewing fall through to null.
 */
function deriveEventSummary(eventType: string, payload: Record<string, unknown>): string | null {
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  switch (eventType) {
    case "note_added":
      return str(payload.text);
    case "vaccination_administered":
      return str(payload.vaccine_name);
    case "deworming_administered":
      return str(payload.product);
    case "medication_started":
      return str(payload.drug_name);
    case "weight_recorded": {
      // Owner-facing preview — es-AR comma, not the stored dot.
      return formatWeightKg(str(payload.kg));
    }
    case "vet_visit_logged":
      // diagnosis is the headline when present; otherwise the visit reason.
      return str(payload.diagnosis) ?? str(payload.reason);
    case "clinical_info_logged":
      return str(payload.title);
    case "incident_reported":
      return str(payload.injuries_summary);
    default:
      return null;
  }
}

/**
 * Targeted pet event queries for the v2 pet profile page.
 *
 * Runs two parallel Drizzle queries:
 *   - Query A: whitelisted event types for state computation (no signing)
 *   - Query B: last 5 events, metadata only (no signing)
 *
 * This replaces the legacy "fetch everything + sign all attachments" pattern
 * and reduces profile load from O(N) to O(1) queries.
 *
 * Both queries carry viewerHoldsPetClause (A01-5, 2026-09-18): a viewer who
 * does not hold the pet gets an empty history even if the caller forgot the
 * access check. The caller's requirePetAccess stays the gate; this is the floor.
 */
export async function fetchPetEventsForProfileV2(
  viewerId: string,
  petId: string,
): Promise<PetProfileV2Events> {
  const [typedRows, recentRows] = await Promise.all([
    // Query A — whitelisted events for state computation, oldest first.
    // INTENTIONALLY UNCAPPED: typedEvents is consumed by achievement replay
    // (getEarnedAchievements), pregnancy state derivation, medication tracking,
    // rabies observation, and PetCurrentStateSection — all of which need the
    // COMPLETE ordered history to compute correct state. An arbitrary DESC cap
    // would silently produce wrong achievements and stale state for long-lived
    // pets. Only the whitelist (PROFILE_V2_TYPED_EVENT_TYPES) bounds the row
    // count; most pets have ≤ 50 whitelisted events in their lifetime.
    // Revisit if profiling shows a specific pet accumulating > 500 typed events.
    db
      .select()
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          viewerHoldsPetClause(viewerId, petEvents.petId),
          inArray(petEvents.eventType, [...PROFILE_V2_TYPED_EVENT_TYPES]),
        ),
      )
      .orderBy(asc(petEvents.occurredAt)),
    // Query B — last 5 events, metadata only. Authority-only surveillance
    // signals are excluded like every owner surface (§6).
    db
      .select({
        id: petEvents.id,
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        payload: petEvents.payload,
      })
      .from(petEvents)
      // NO type filter here, which is why this one leaked: `deriveEventSummary`
      // renders `payload.text` for `note_added`, so a reported lost-feed message
      // was previewable in the owner's "últimos movimientos" strip. Found by the
      // coverage fence.
      .where(
        and(
          eq(petEvents.petId, petId),
          viewerHoldsPetClause(viewerId, petEvents.petId),
          excludeAuthorityOnlyClause(),
          notReportedClause(),
        ),
      )
      .orderBy(desc(petEvents.occurredAt))
      .limit(5),
  ]);

  const recentFive: PetEventMetadata[] = recentRows.map(
    (r: { id: string; eventType: string; occurredAt: Date; payload: unknown }) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const summary = deriveEventSummary(r.eventType, payload);
      return {
        id: r.id,
        eventType: r.eventType,
        occurredAt: r.occurredAt instanceof Date ? r.occurredAt : new Date(r.occurredAt as string),
        summary,
      };
    },
  );

  // Project corrections over the typed stream (D2 at the read boundary —
  // projection-cron audit 2026-07-03 A): compliance stamps, pregnancy state,
  // rabies observation and achievements all read corrected payloads.
  return { typedEvents: overlayAmendments(typedRows), recentFive };
}

// ---------------------------------------------------------------------------
// Count helpers for /cuenta/transitos hub badges
// ---------------------------------------------------------------------------

// The owner-scoped pending counters live in their own module (file-size fence,
// 2026-08-01). Re-exported so every existing import of this file still resolves.
export * from "./owner-pending-counts";

// The owner's casos (open + previous workflows) live in their own module
// (file-size fence, 2026-10-06). Re-exported for the same reason.
export * from "./owner-cases";
