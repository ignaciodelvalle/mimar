// FosterRepository — thin Drizzle wrapper for the foster domain.
// All write methods accept an optional `tx` parameter for use inside
// db.transaction(), mirroring the openCase(input, tx) pattern.
// No auth logic — auth lives at the action / use-case edge.

import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";

import {
  db,
  fosterProposals,
  fosterVolunteers,
  notifications,
  organizationCapabilityGrants,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import type { CoverageArea } from "@/lib/domain/org-coverage";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, findOpenCaseForPetAndKind, openCase } from "@/lib/infra/case-helpers";
import { type CronBudgetHeaders, effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";
import { coverageDecisionMode, loadOrgCoverageAreas } from "@/lib/place/coverage";

import { insertConvertFosterToOwner } from "./foster-convert-to-owner-writer";
import { insertEndFoster } from "./foster-end-writer";
import { listFosterHubRowsForVolunteer } from "./foster-hub-reader";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

type PetRow = typeof pets.$inferSelect;
type VolunteerRow = typeof fosterVolunteers.$inferSelect;
type ProposalRow = typeof fosterProposals.$inferSelect;

type InsertFosterOwnershipArgs = {
  petId: string;
  ownerUserId: string;
  allowCoFoster?: boolean;
  startedAt?: Date;
};

type WithdrawVolunteerArgs = {
  userId: string;
  now: Date;
};

export type ExpireStats = {
  candidates: number;
  expired: number;
  errors: number;
};

// Keyset/drain bounds for expirePendingProposals (review 23 fleet extension):
// bound each SELECT and drain the backlog within the run instead of loading ALL
// expired pending proposals at once.
const EXPIRE_PROPOSALS_BATCH_SIZE = 500;
const EXPIRE_PROPOSALS_MAX_DURATION_MS = 45_000;

// ---------------------------------------------------------------------------
// Helper — org foster coordinator user ids
// ---------------------------------------------------------------------------

async function getOrgFosterCoordinatorUserIds(
  orgId: string,
  client: DbOrTx = db,
): Promise<string[]> {
  const ids = new Set<string>();

  const admins = await (client as typeof db)
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, orgId),
        eq(organizationMemberships.role, "admin"),
        isNull(organizationMemberships.leftAt),
      ),
    );
  for (const a of admins) ids.add(a.userId);

  const explicit = await (client as typeof db)
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .innerJoin(
      organizationCapabilityGrants,
      and(
        eq(organizationCapabilityGrants.membershipId, organizationMemberships.id),
        eq(organizationCapabilityGrants.capability, "foster.assign"),
        eq(organizationCapabilityGrants.status, "approved"),
      ),
    )
    .where(
      and(
        eq(organizationMemberships.organizationId, orgId),
        isNull(organizationMemberships.leftAt),
      ),
    );
  for (const e of explicit) ids.add(e.userId);

  return Array.from(ids);
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const FosterRepository = {
  // -------------------------------------------------------------------------
  // Pet / org reads
  // -------------------------------------------------------------------------

  /**
   * Finds a pet by public token currently under active shelter_custody by the
   * given org. Returns the pet row or null.
   */
  async findShelterPetByToken(
    petPublicToken: string,
    organizationId: string,
    tx?: Tx,
  ): Promise<PetRow | null> {
    const client = tx ?? db;
    const [row] = await client
      .select({ pet: pets })
      .from(pets)
      .innerJoin(ownerships, eq(ownerships.petId, pets.id))
      .where(
        and(
          // Art. 16: an erased pet answers like a token that never existed.
          unerasedPetByToken(petPublicToken),
          eq(ownerships.ownerOrganizationId, organizationId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    return row?.pet ?? null;
  },

  /**
   * Finds an active (non-left) membership for (userId, orgId). Returns { id }
   * or null.
   */
  async findActiveMembership(
    userId: string,
    orgId: string,
    tx?: Tx,
  ): Promise<{ id: string } | null> {
    const client = tx ?? db;
    const [row] = await client
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.organizationId, orgId),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // -------------------------------------------------------------------------
  // Foster ownership reads
  // -------------------------------------------------------------------------

  /**
   * Finds all active (endedAt IS NULL) foster ownership rows for a pet.
   * Returns an array with id and allowCoFoster for each.
   */
  async findActiveFosterRows(
    petId: string,
    tx?: Tx,
  ): Promise<{ id: string; ownerUserId: string | null; allowCoFoster: boolean | null }[]> {
    const client = tx ?? db;
    const rows = await client
      .select({
        id: ownerships.id,
        ownerUserId: ownerships.ownerUserId,
        allowCoFoster: ownerships.allowCoFoster,
      })
      .from(ownerships)
      .where(
        and(eq(ownerships.petId, petId), eq(ownerships.role, "foster"), isNull(ownerships.endedAt)),
      );
    return rows;
  },

  // -------------------------------------------------------------------------
  // Foster ownership writes
  // -------------------------------------------------------------------------

  /**
   * Inserts a new foster ownership row. Must be called inside a tx when used
   * as part of a larger atomic operation (e.g. acceptFosterProposal).
   */
  async insertFosterOwnership(args: InsertFosterOwnershipArgs, tx: Tx): Promise<{ id: string }> {
    const [row] = await tx
      .insert(ownerships)
      .values({
        petId: args.petId,
        ownerUserId: args.ownerUserId,
        role: "foster",
        startedAt: args.startedAt ?? new Date(),
        allowCoFoster: args.allowCoFoster ?? false,
      })
      .returning({ id: ownerships.id });
    return row;
  },

  /**
   * Ends an active foster ownership row by setting endedAt.
   */
  async endFosterOwnership(id: string, endedAt: Date, tx: Tx): Promise<void> {
    await tx.update(ownerships).set({ endedAt }).where(eq(ownerships.id, id));
  },

  // -------------------------------------------------------------------------
  // Pet event writes
  // -------------------------------------------------------------------------

  // insertPetEvent is intentionally NOT exposed as a generic helper because
  // eventType and authorRole are strongly-typed Postgres enums — callers use
  // tx.insert(petEvents).values({...}) directly with validated payloads.
  // This keeps the type system happy and mirrors the adoption-repository pattern.

  // -------------------------------------------------------------------------
  // Proposal reads
  // -------------------------------------------------------------------------

  /**
   * Finds a foster proposal by its public token. Returns the full row or null.
   */
  async findProposalByToken(token: string, tx?: Tx): Promise<ProposalRow | null> {
    const client = tx ?? db;
    const [row] = await client
      .select()
      .from(fosterProposals)
      .where(eq(fosterProposals.publicToken, token))
      .limit(1);
    return row ?? null;
  },

  /**
   * Checks whether a duplicate pending proposal exists for the (org, volunteer,
   * pet) triple. Returns true if one exists.
   */
  async findDuplicatePending(
    orgId: string,
    volunteerUserId: string,
    petId: string,
    tx?: Tx,
  ): Promise<boolean> {
    const client = tx ?? db;
    const [row] = await client
      .select({ id: fosterProposals.id })
      .from(fosterProposals)
      .where(
        and(
          eq(fosterProposals.organizationId, orgId),
          eq(fosterProposals.volunteerUserId, volunteerUserId),
          eq(fosterProposals.petId, petId),
          eq(fosterProposals.status, "pending"),
        ),
      )
      .limit(1);
    return !!row;
  },

  /**
   * Finds all pending proposals for a volunteer, optionally excluding one by id.
   */
  async pendingProposalsForVolunteer(
    userId: string,
    excludeId?: string,
    tx?: Tx,
  ): Promise<ProposalRow[]> {
    const client = tx ?? db;
    const conditions = [
      eq(fosterProposals.volunteerUserId, userId),
      eq(fosterProposals.status, "pending"),
    ];
    if (excludeId) conditions.push(ne(fosterProposals.id, excludeId));
    return client
      .select()
      .from(fosterProposals)
      .where(and(...conditions));
  },

  // -------------------------------------------------------------------------
  // Proposal writes
  // -------------------------------------------------------------------------

  /**
   * Inserts a new foster proposal row.
   */
  async insertProposal(args: typeof fosterProposals.$inferInsert, tx: Tx): Promise<{ id: string }> {
    const [row] = await tx
      .insert(fosterProposals)
      .values(args)
      .returning({ id: fosterProposals.id });
    return row;
  },

  /**
   * Updates a foster proposal's status (+ optional associated fields).
   */
  async updateProposalStatus(
    id: string,
    updates: Partial<typeof fosterProposals.$inferInsert>,
    tx: Tx,
  ): Promise<void> {
    await tx.update(fosterProposals).set(updates).where(eq(fosterProposals.id, id));
  },

  // -------------------------------------------------------------------------
  // Volunteer reads
  // -------------------------------------------------------------------------

  /**
   * Finds a foster volunteer row by userId. Returns the full row or null.
   */
  async findVolunteerByUserId(userId: string, tx?: Tx): Promise<VolunteerRow | null> {
    const client = tx ?? db;
    const [row] = await client
      .select()
      .from(fosterVolunteers)
      .where(eq(fosterVolunteers.userId, userId))
      .limit(1);
    return row ?? null;
  },

  /**
   * Returns user ids of org members who hold the foster.assign capability
   * (admins + explicit grants). Used for notification fan-out.
   */
  async orgFosterCoordinatorUserIds(orgId: string, tx?: Tx): Promise<string[]> {
    return getOrgFosterCoordinatorUserIds(orgId, tx ?? db);
  },

  /**
   * Fetches all pending proposals whose expiresAt is before `now`.
   * Used by the expirer sweep.
   */
  async expirablePending(now: Date): Promise<ProposalRow[]> {
    return db
      .select()
      .from(fosterProposals)
      .where(and(eq(fosterProposals.status, "pending"), lt(fosterProposals.expiresAt, now)));
  },

  // -------------------------------------------------------------------------
  // Volunteer writes
  // -------------------------------------------------------------------------

  /**
   * Upserts a foster volunteer row (INSERT or UPDATE). Both branches store
   * `canonicalProvince` (the caller's canonicalProvinceNameForStorage
   * result), never the raw input (A10-6).
   *
   * Returns the volunteer's id and updated availableSlots.
   */
  async upsertVolunteer(
    args: {
      userId: string;
      input: {
        mode: "enroll" | "update_preferences_only";
        status: "active" | "paused";
        jurisdictionProvince?: string | null;
        jurisdictionLocality?: string | null;
        acceptsDogs: boolean;
        acceptsCats: boolean;
        acceptsOtherSpecies: boolean;
        acceptsSizeSmall: boolean;
        acceptsSizeMedium: boolean;
        acceptsSizeLarge: boolean;
        acceptsPuppies: boolean;
        acceptsSeniors: boolean;
        acceptsChronicConditions: boolean;
        acceptsDangerousBreeds: boolean;
        maxDurationWeeks?: number | null;
        householdOtherPets?: boolean | null;
        householdKids?: boolean | null;
        notes?: string | null;
      };
      newSlots: number;
      now: Date;
      canonicalProvince: string | null;
    },
    tx: Tx,
  ): Promise<{ id: string; availableSlots: number }> {
    const { userId, input, newSlots, now, canonicalProvince } = args;

    const [existing] = await tx
      .select({ id: fosterVolunteers.id })
      .from(fosterVolunteers)
      .where(eq(fosterVolunteers.userId, userId))
      .limit(1);

    const sharedFields = {
      status: input.status,
      acceptsDogs: input.acceptsDogs,
      acceptsCats: input.acceptsCats,
      acceptsOtherSpecies: input.acceptsOtherSpecies,
      acceptsSizeSmall: input.acceptsSizeSmall,
      acceptsSizeMedium: input.acceptsSizeMedium,
      acceptsSizeLarge: input.acceptsSizeLarge,
      acceptsPuppies: input.acceptsPuppies,
      acceptsSeniors: input.acceptsSeniors,
      acceptsChronicConditions: input.acceptsChronicConditions,
      acceptsDangerousBreeds: input.acceptsDangerousBreeds,
      maxDurationWeeks: input.maxDurationWeeks ?? null,
      householdOtherPets: input.householdOtherPets ?? null,
      householdKids: input.householdKids ?? null,
      notes: input.notes?.trim() || null,
    };

    if (!existing) {
      // INSERT branch — apply canonical province normalization.
      const [inserted] = await tx
        .insert(fosterVolunteers)
        .values({
          userId,
          availableSlots: newSlots,
          jurisdictionProvince: canonicalProvince,
          jurisdictionLocality: input.jurisdictionLocality ?? null,
          createdAt: now,
          updatedAt: now,
          ...sharedFields,
        })
        .returning({ id: fosterVolunteers.id, availableSlots: fosterVolunteers.availableSlots });
      return inserted;
    }

    // UPDATE branch — the same canonical province as INSERT (A10-6). Storing
    // the raw input here made a volunteer who enrolled fine fail on a later
    // save: 0055's foster_volunteers_jurisdiction_province_canonical CHECK
    // rejects "Cordoba", and "Córdoba" is what INSERT had written.
    const [updated] = await tx
      .update(fosterVolunteers)
      .set({
        availableSlots: newSlots,
        jurisdictionProvince: canonicalProvince,
        jurisdictionLocality: input.jurisdictionLocality ?? null,
        updatedAt: now,
        ...sharedFields,
      })
      .where(eq(fosterVolunteers.id, existing.id))
      .returning({ id: fosterVolunteers.id, availableSlots: fosterVolunteers.availableSlots });
    return updated;
  },

  /**
   * Directly sets the volunteer's availableSlots. Used for D16 decrement
   * inside acceptFosterProposal.
   */
  async setVolunteerSlots(volunteerId: string, slots: number, now: Date, tx: Tx): Promise<void> {
    await tx
      .update(fosterVolunteers)
      .set({ availableSlots: slots, updatedAt: now })
      .where(eq(fosterVolunteers.id, volunteerId));
  },

  /**
   * Withdraws a volunteer: status → withdrawn, slots → 0, and cascades
   * cancellation of all pending proposals with reason='volunteer_withdrew'.
   *
   * PARITY QUIRK: events emitted during withdraw cascade do NOT include
   * caseId and do NOT close the proposal cases (matches original action
   * behavior — preserve as-is).
   */
  async withdrawVolunteer(args: WithdrawVolunteerArgs, tx: Tx): Promise<void> {
    const { userId, now } = args;

    const [existing] = await tx
      .select()
      .from(fosterVolunteers)
      .where(eq(fosterVolunteers.userId, userId))
      .limit(1);
    if (!existing) {
      throw new Error("No estás inscripto en el pool de voluntarios.");
    }

    await tx
      .update(fosterVolunteers)
      .set({ status: "withdrawn", availableSlots: 0, updatedAt: now })
      .where(eq(fosterVolunteers.id, existing.id));

    const pendingProposals = await tx
      .select()
      .from(fosterProposals)
      .where(
        and(eq(fosterProposals.volunteerUserId, userId), eq(fosterProposals.status, "pending")),
      );

    for (const p of pendingProposals) {
      await tx
        .update(fosterProposals)
        .set({
          status: "cancelled",
          cancelledAt: now,
          cancelledByUserId: userId,
          cancellationReason: "volunteer_withdrew",
          updatedAt: now,
        })
        .where(eq(fosterProposals.id, p.id));

      const payload = validateEventPayload("foster_proposal_resolved", {
        proposal_public_token: p.publicToken,
        outcome: "cancelled",
        cancellation_reason: "volunteer_withdrew",
        auto_cancelled: true,
      });

      // PARITY QUIRK: no caseId on the event, no case close.
      await tx.insert(petEvents).values({
        petId: p.petId,
        eventType: "foster_proposal_resolved",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: userId,
        authorRole: "owner",
        authorOrganizationId: null,
        authorVerified: false,
        payload,
      });
    }
  },

  // -------------------------------------------------------------------------
  // Task 2.4: Expirer — per-row tx + status recheck
  // -------------------------------------------------------------------------

  /**
   * Sweeps expired pending proposals. Each candidate gets its own tx with a
   * status recheck (anti-race). Returns stats {candidates, expired, errors}.
   *
   * Parity: recordedByUserId = null (system), authorRole = 'system',
   * auto_expired close reason, notifications emitted but NOT awaited here
   * (caller can choose to flush or ignore them).
   *
   * Bounded (review 23 fleet extension): previously this loaded EVERY expired
   * pending proposal into memory in one unbounded SELECT. It now keyset-paginates
   * over id in batches of EXPIRE_PROPOSALS_BATCH_SIZE, draining until the scope is
   * empty or the wall-clock budget elapses. The cursor advances past every row
   * fetched (expired OR errored) so an errored row is not re-fetched within the
   * same run — expired rows also drop out of the `pending` scope, so a backlog
   * drains across successive runs.
   */
  async expirePendingProposals(
    now: Date,
    // budgetHeaders (RN #9 half b): the deadline becomes min(own ceiling, the
    // dispatcher's share) so a late start cannot cross the 60 s hard kill.
    opts?: { batchSize?: number; maxDurationMs?: number; budgetHeaders?: CronBudgetHeaders },
  ): Promise<ExpireStats> {
    const batchSize = opts?.batchSize ?? EXPIRE_PROPOSALS_BATCH_SIZE;
    const own = opts?.maxDurationMs ?? EXPIRE_PROPOSALS_MAX_DURATION_MS;
    const maxDurationMs = opts?.budgetHeaders ? effectiveDeadlineMs(own, opts.budgetHeaders) : own;
    const startedAt = Date.now();

    let candidateCount = 0;
    let expired = 0;
    let errors = 0;
    let cursor: string | null = null;

    for (;;) {
      if (Date.now() - startedAt >= maxDurationMs) break;

      const candidates = await db
        .select()
        .from(fosterProposals)
        .where(
          and(
            eq(fosterProposals.status, "pending"),
            lt(fosterProposals.expiresAt, now),
            ...(cursor ? [gt(fosterProposals.id, cursor)] : []),
          ),
        )
        .orderBy(asc(fosterProposals.id))
        .limit(batchSize);

      if (candidates.length === 0) break;

      for (const p of candidates) {
        candidateCount += 1;
        cursor = p.id;
        try {
          await db.transaction(async (tx) => {
            // Status recheck — defense against race with accept/reject/cancel.
            const [fresh] = await tx
              .select({ status: fosterProposals.status })
              .from(fosterProposals)
              .where(eq(fosterProposals.id, p.id))
              .limit(1);
            if (!fresh || fresh.status !== "pending") return;

            await tx
              .update(fosterProposals)
              .set({ status: "expired", updatedAt: now })
              .where(eq(fosterProposals.id, p.id));

            // Resolve case_id (new rows have it directly; pre-migration rows
            // fall back to open-case query).
            const proposalCaseId =
              p.caseId ??
              (await findOpenCaseForPetAndKind(p.petId, "foster_proposal", tx))?.id ??
              null;

            const payload = validateEventPayload("foster_proposal_resolved", {
              proposal_public_token: p.publicToken,
              outcome: "expired",
            });
            await tx.insert(petEvents).values({
              petId: p.petId,
              eventType: "foster_proposal_resolved",
              occurredAt: now,
              recordedAt: now,
              recordedByUserId: null,
              authorRole: "system",
              authorOrganizationId: p.organizationId,
              authorVerified: false,
              payload,
              caseId: proposalCaseId,
            });

            if (proposalCaseId) {
              await closeCase({ caseId: proposalCaseId, reason: "auto_expired" }, tx);
            }

            // Notifications (best-effort — emitted inside tx, flushed by caller).
            await tx.insert(notifications).values({
              userId: p.volunteerUserId,
              notificationType: "foster_proposal_expired",
              severity: "info",
              title: "Una propuesta de tránsito expiró",
              body: "La propuesta que recibiste expiró sin respuesta. Si te interesa, pedile al refugio que vuelva a proponer.",
              relatedPetId: p.petId,
              ctaLabel: "Ver propuestas",
              ctaUrl: "/cuenta/transitos/propuestas",
            });

            // Resolve the org token so coordinators get a working CTA into the pool.
            const [orgRow] = await tx
              .select({ publicToken: organizations.publicToken })
              .from(organizations)
              .where(eq(organizations.id, p.organizationId))
              .limit(1);
            const orgCoordinators = await getOrgFosterCoordinatorUserIds(p.organizationId, tx);
            for (const uid of orgCoordinators) {
              await tx.insert(notifications).values({
                userId: uid,
                notificationType: "foster_proposal_expired",
                severity: "info",
                title: "Tu propuesta de tránsito expiró",
                body: "El voluntario no respondió en 7 días. Probá con otro candidato del pool.",
                relatedPetId: p.petId,
                ctaLabel: "Ver propuestas",
                ctaUrl: orgRow ? `/org/${orgRow.publicToken}/voluntarios/propuestas` : "/org",
              });
            }
          });
          expired += 1;
        } catch (err) {
          console.error("[FosterRepository.expirePendingProposals] failed for", p.id, err);
          errors += 1;
        }
      }

      if (candidates.length < batchSize) break; // last page
    }

    return { candidates: candidateCount, expired, errors };
  },

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Finds volunteers matching the given filters. Returns raw rows for the
   * application layer to score and sort.
   */
  async searchVolunteers(
    filters: {
      province?: string | null;
      locality?: string | null;
      species?: "dog" | "cat" | "other";
    },
    limit: number,
  ): Promise<(VolunteerRow & { displayName: string })[]> {
    const conditions: ReturnType<typeof eq>[] = [
      eq(fosterVolunteers.status, "active"),
      sql`${fosterVolunteers.availableSlots} > 0` as unknown as ReturnType<typeof eq>,
    ];
    if (filters.province) {
      conditions.push(eq(fosterVolunteers.jurisdictionProvince, filters.province));
    }
    if (filters.locality) {
      conditions.push(eq(fosterVolunteers.jurisdictionLocality, filters.locality));
    }
    if (filters.species === "dog") conditions.push(eq(fosterVolunteers.acceptsDogs, true));
    if (filters.species === "cat") conditions.push(eq(fosterVolunteers.acceptsCats, true));
    if (filters.species === "other")
      conditions.push(eq(fosterVolunteers.acceptsOtherSpecies, true));

    const rows = await db
      .select({
        volunteer: fosterVolunteers,
        displayName: profiles.displayName,
      })
      .from(fosterVolunteers)
      .innerJoin(profiles, eq(profiles.id, fosterVolunteers.userId))
      .where(and(...conditions))
      .limit(limit);
    return rows.map((r) => ({ ...r.volunteer, displayName: r.displayName ?? "" }));
  },

  /**
   * Returns a map of volunteerUserId → accepted-proposal count. Used for
   * experience sorting in searchFosterVolunteers.
   */
  async acceptedCountsByVolunteer(): Promise<Map<string, number>> {
    const counts = await db
      .select({
        userId: fosterProposals.volunteerUserId,
        count: sql<number>`count(*)::int`,
      })
      .from(fosterProposals)
      .where(eq(fosterProposals.status, "accepted"))
      .groupBy(fosterProposals.volunteerUserId);
    const map = new Map<string, number>();
    for (const c of counts) map.set(c.userId, c.count);
    return map;
  },

  // -------------------------------------------------------------------------
  // Composite atomic write methods (use-case boundaries)
  //
  // These bundle event insert + case operations into one tx call so use-cases
  // remain unit-testable with a fake repo.
  // -------------------------------------------------------------------------

  /**
   * Atomic: insert foster ownership + open foster_placement case + emit
   * foster_assigned event. Must be called inside a db.transaction().
   * Returns the new ownership id and the case id.
   */
  async insertAssignFoster(
    args: {
      petId: string;
      petName: string;
      petJurisdictionProvince: string | null;
      petJurisdictionLocality: string | null;
      fosterUserId: string;
      expectedWeeks: number | null;
      notes: string | null;
      actorUserId: string;
      actorOrgId: string;
      actorOrgVerified: boolean;
      actorOrgDisplayName: string;
      now: Date;
    },
    tx: Tx,
  ): Promise<{ ownershipId: string; caseId: string }> {
    // Idempotency guard (projection-writes audit §6): the use-case checks
    // "one foster at a time" OUTSIDE the tx, so a double-submit could pass
    // that check twice. Serialize on the pet (same advisory-lock pattern as
    // the return-to-owner writers) and re-verify inside the tx.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${args.petId}))`);
    const [activeFoster] = await tx
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, args.petId),
          eq(ownerships.role, "foster"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    if (activeFoster) {
      throw new Error("Este animal ya tiene un tránsito activo. Finalizalo antes de asignar otro.");
    }

    const [ownership] = await tx
      .insert(ownerships)
      .values({
        petId: args.petId,
        ownerUserId: args.fosterUserId,
        role: "foster",
        startedAt: args.now,
      })
      .returning({ id: ownerships.id });

    const caseRow = await openCase(
      {
        kind: "foster_placement",
        primarySubjectKind: "registered_pet",
        primaryPetId: args.petId,
        jurisdictionProvince: args.petJurisdictionProvince,
        jurisdictionLocality: args.petJurisdictionLocality,
        openedByUserId: args.actorUserId,
        openedByOrganizationId: args.actorOrgId,
        openedReason: {
          code: "foster_placement_assigned",
          actorOrgDisplayName: args.actorOrgDisplayName,
          // `|| null`, not `?? null`: the prose template this replaces tested
          // truthiness, so 0 meant "no duration". Keeping that exact semantic
          // means params and prose agree instead of storing a 0 that the
          // positive-int schema would reject on read.
          expectedWeeks: args.expectedWeeks || null,
        },
      },
      tx,
    );

    const payload = validateEventPayload("foster_assigned", {
      foster_user_id: args.fosterUserId,
      expected_weeks: args.expectedWeeks,
      notes: args.notes,
    });
    await tx.insert(petEvents).values({
      petId: args.petId,
      eventType: "foster_assigned",
      occurredAt: args.now,
      recordedAt: args.now,
      recordedByUserId: args.actorUserId,
      authorRole: "shelter",
      authorOrganizationId: args.actorOrgId,
      authorVerified: args.actorOrgVerified,
      payload,
      caseId: caseRow.id,
    });

    return { ownershipId: ownership.id, caseId: caseRow.id };
  },

  /**
   * Atomic: end foster ownership + emit foster_ended event + close the
   * foster_placement case, under the pet advisory lock.
   *
   * Moved to ./foster-end-writer.ts (2026-08-23) for the same reason the
   * convert writer moved two days earlier: this file lives on a size ratchet
   * and the M-8 lock + checked re-read grew this method past it. Its header
   * says why the destination had to stay inside this module infrastructure
   * layer. Kept as a delegating member so every caller and every test double
   * still reaches it through the repository.
   */
  insertEndFoster,

  /**
   * Atomic: open foster_proposal case + insert proposal row + emit
   * foster_proposed event. Returns the proposal id and public token.
   */
  async insertProposeFoster(
    args: {
      petId: string;
      petName: string;
      petJurisdictionProvince: string | null;
      petJurisdictionLocality: string | null;
      volunteerUserId: string;
      proposedByUserId: string;
      orgId: string;
      orgVerified: boolean;
      orgDisplayName: string;
      orgToken: string;
      publicToken: string;
      proposedDurationWeeks: number | null;
      proposedNotes: string | null;
      matchWarnings: string[];
      expiresAt: Date;
      now: Date;
    },
    tx: Tx,
  ): Promise<{ proposalId: string; caseId: string }> {
    const caseRow = await openCase(
      {
        kind: "foster_proposal",
        primarySubjectKind: "registered_pet",
        primaryPetId: args.petId,
        openedByUserId: args.proposedByUserId,
        openedByOrganizationId: args.orgId,
        jurisdictionProvince: args.petJurisdictionProvince,
        jurisdictionLocality: args.petJurisdictionLocality,
        // The volunteer + org ids are AUDIT-only: they belong in the prose
        // (as they always have) but never in params, so the renderer cannot
        // reach them. Hence no params on this code.
        openedReason: { code: "foster_proposal_sent" },
        openedReasonAudit: { volunteerUserId: args.volunteerUserId, orgId: args.orgId },
      },
      tx,
    );

    const [proposal] = await tx
      .insert(fosterProposals)
      .values({
        publicToken: args.publicToken,
        organizationId: args.orgId,
        volunteerUserId: args.volunteerUserId,
        petId: args.petId,
        proposedByUserId: args.proposedByUserId,
        proposedAt: args.now,
        proposedDurationWeeks: args.proposedDurationWeeks,
        proposedNotes: args.proposedNotes,
        matchWarnings: args.matchWarnings,
        expiresAt: args.expiresAt,
        status: "pending",
        caseId: caseRow.id,
        createdAt: args.now,
        updatedAt: args.now,
      })
      .returning({ id: fosterProposals.id });

    const payload = validateEventPayload("foster_proposed", {
      proposal_public_token: args.publicToken,
      volunteer_user_id: args.volunteerUserId,
      proposed_duration_weeks: args.proposedDurationWeeks,
      match_warnings: args.matchWarnings,
    });
    await tx.insert(petEvents).values({
      petId: args.petId,
      eventType: "foster_proposed",
      occurredAt: args.now,
      recordedAt: args.now,
      recordedByUserId: args.proposedByUserId,
      authorRole: "shelter",
      authorOrganizationId: args.orgId,
      authorVerified: args.orgVerified,
      payload,
      caseId: caseRow.id,
    });

    return { proposalId: proposal.id, caseId: caseRow.id };
  },

  /**
   * Atomic: accept foster proposal — insert ownership FIRST, then single
   * proposal UPDATE (satisfies CHECK constraint), emit events, close case,
   * optionally emit co-foster event, decrement slot, D18 cascade.
   *
   * Returns ownershipId, newSlots, cascadeCancelledTokens, and collected
   * notification targets for fan-out (flushed post-tx by the use-case).
   */
  async insertAcceptFosterProposal(
    args: {
      proposal: ProposalRow;
      petId: string;
      petName: string;
      volunteerUserId: string;
      volunteerId: string;
      volunteerCurrentSlots: number;
      allowCoFoster: boolean;
      responseNotes: string | null;
      actorUserId: string;
      actorOrgId: string;
      now: Date;
    },
    tx: Tx,
  ): Promise<{
    ownershipId: string;
    newSlots: number;
    cascadeCancelledTokens: string[];
    cascadeOrgNotifyTargets: { orgId: string; petId: string }[];
    acceptingOrgCoordinatorIds: string[];
    actorDisplayName: string | null;
  }> {
    // Insert foster ownership FIRST (satisfies CHECK constraint ordering).
    const [fosterOwnership] = await tx
      .insert(ownerships)
      .values({
        petId: args.petId,
        ownerUserId: args.volunteerUserId,
        role: "foster",
        startedAt: args.now,
        allowCoFoster: args.allowCoFoster,
      })
      .returning({ id: ownerships.id });

    // Single proposal UPDATE with resolvedOwnershipId set simultaneously.
    await tx
      .update(fosterProposals)
      .set({
        status: "accepted",
        respondedAt: args.now,
        responseNotes: args.responseNotes,
        resolvedOwnershipId: fosterOwnership.id,
        updatedAt: args.now,
      })
      .where(eq(fosterProposals.id, args.proposal.id));

    // Resolve case_id for the accepted proposal.
    const proposalCaseId =
      args.proposal.caseId ??
      (await findOpenCaseForPetAndKind(args.petId, "foster_proposal", tx))?.id ??
      null;

    // authorVerified for foster_assigned used to be hardcoded `true` ("PARITY:
    // design §parity quirk 3", tracked as AF-L3 in dim-interno:docs/reviews/tier4-decisions.md).
    // That stamped "verified by an organization" onto the libreta's authorship
    // line for orgs that had never passed personería review — a small lie, but a
    // lie in the one log whose job is to say who vouched for what. The direct
    // assignment path already reads organizations.verified; this one now does
    // too, so the two paths cannot disagree about the same org.
    const [assigningOrg] = args.proposal.organizationId
      ? await tx
          .select({ verified: organizations.verified })
          .from(organizations)
          .where(eq(organizations.id, args.proposal.organizationId))
          .limit(1)
      : [];
    // Fail closed: no org row resolved → not verified.
    const assigningOrgVerified = assigningOrg?.verified === true;

    // Emit foster_proposal_resolved (authorVerified=false) + foster_assigned.
    const acceptedPayload = validateEventPayload("foster_proposal_resolved", {
      proposal_public_token: args.proposal.publicToken,
      outcome: "accepted",
      response_notes: args.responseNotes,
    });
    const assignedPayload = validateEventPayload("foster_assigned", {
      foster_user_id: args.volunteerUserId,
      expected_weeks: args.proposal.proposedDurationWeeks,
      notes: args.responseNotes,
    });
    await tx.insert(petEvents).values([
      {
        petId: args.petId,
        eventType: "foster_proposal_resolved",
        occurredAt: args.now,
        recordedAt: args.now,
        recordedByUserId: args.actorUserId,
        authorRole: "owner",
        authorOrganizationId: null,
        authorVerified: false,
        payload: acceptedPayload,
        caseId: proposalCaseId,
      },
      {
        petId: args.petId,
        eventType: "foster_assigned",
        occurredAt: args.now,
        recordedAt: args.now,
        recordedByUserId: args.actorUserId,
        authorRole: "shelter",
        authorOrganizationId: args.proposal.organizationId,
        authorVerified: assigningOrgVerified,
        payload: assignedPayload,
        caseId: proposalCaseId,
      },
    ]);

    if (proposalCaseId) {
      await closeCase(
        { caseId: proposalCaseId, reason: "resolved", closedByUserId: args.actorUserId },
        tx,
      );
    }

    // Optional co-foster event.
    if (args.allowCoFoster) {
      const coFosterPayload = validateEventPayload("foster_co_foster_allowed", {
        allow_co_foster: true,
        foster_ownership_id: fosterOwnership.id,
      });
      await tx.insert(petEvents).values({
        petId: args.petId,
        eventType: "foster_co_foster_allowed",
        occurredAt: args.now,
        recordedAt: args.now,
        recordedByUserId: args.actorUserId,
        authorRole: "owner",
        authorOrganizationId: null,
        authorVerified: false,
        payload: coFosterPayload,
      });
    }

    // D16 — slot decrement.
    const newSlots = args.volunteerCurrentSlots - 1;
    await tx
      .update(fosterVolunteers)
      .set({ availableSlots: newSlots, updatedAt: args.now })
      .where(eq(fosterVolunteers.id, args.volunteerId));

    // D18 cascade when last slot consumed.
    const cascadeCancelledTokens: string[] = [];
    const cascadeOrgNotifyTargets: { orgId: string; petId: string }[] = [];

    if (newSlots === 0) {
      const others = await tx
        .select()
        .from(fosterProposals)
        .where(
          and(
            eq(fosterProposals.volunteerUserId, args.volunteerUserId),
            eq(fosterProposals.status, "pending"),
            ne(fosterProposals.id, args.proposal.id),
          ),
        );
      for (const p of others) {
        await tx
          .update(fosterProposals)
          .set({
            status: "cancelled",
            cancelledAt: args.now,
            cancelledByUserId: args.actorUserId,
            cancellationReason: "volunteer_accepted_another",
            updatedAt: args.now,
          })
          .where(eq(fosterProposals.id, p.id));

        const otherCaseId =
          p.caseId ?? (await findOpenCaseForPetAndKind(p.petId, "foster_proposal", tx))?.id ?? null;

        const cancelPayload = validateEventPayload("foster_proposal_resolved", {
          proposal_public_token: p.publicToken,
          outcome: "cancelled",
          cancellation_reason: "volunteer_accepted_another",
          auto_cancelled: true,
        });
        await tx.insert(petEvents).values({
          petId: p.petId,
          eventType: "foster_proposal_resolved",
          occurredAt: args.now,
          recordedAt: args.now,
          recordedByUserId: args.actorUserId,
          authorRole: "owner",
          authorOrganizationId: null,
          authorVerified: false,
          payload: cancelPayload,
          caseId: otherCaseId,
        });

        if (otherCaseId) {
          await closeCase(
            { caseId: otherCaseId, reason: "cancelled", closedByUserId: args.actorUserId },
            tx,
          );
        }

        cascadeCancelledTokens.push(p.publicToken);
        cascadeOrgNotifyTargets.push({ orgId: p.organizationId, petId: p.petId });
      }
    }

    // Resolve accepting org coordinator ids + actor display name for notifications.
    const acceptingOrgCoordinatorIds = await getOrgFosterCoordinatorUserIds(
      args.proposal.organizationId,
      tx,
    );
    const [actorProfile] = await tx
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, args.actorUserId))
      .limit(1);

    return {
      ownershipId: fosterOwnership.id,
      newSlots,
      cascadeCancelledTokens,
      cascadeOrgNotifyTargets,
      acceptingOrgCoordinatorIds,
      actorDisplayName: actorProfile?.displayName ?? null,
    };
  },

  /**
   * Atomic: reject a foster proposal — update status, emit event, close case.
   * Returns orgCoordinatorIds for notification fan-out.
   */
  async insertRejectFosterProposal(
    args: {
      proposal: ProposalRow;
      rejectionReason: string;
      responseNotes: string | null;
      actorUserId: string;
      now: Date;
    },
    tx: Tx,
  ): Promise<{ orgCoordinatorIds: string[] }> {
    await tx
      .update(fosterProposals)
      .set({
        status: "rejected",
        respondedAt: args.now,
        responseNotes: args.responseNotes,
        rejectionReason: args.rejectionReason,
        updatedAt: args.now,
      })
      .where(eq(fosterProposals.id, args.proposal.id));

    const proposalCaseId =
      args.proposal.caseId ??
      (await findOpenCaseForPetAndKind(args.proposal.petId, "foster_proposal", tx))?.id ??
      null;

    const payload = validateEventPayload("foster_proposal_resolved", {
      proposal_public_token: args.proposal.publicToken,
      outcome: "rejected",
      rejection_reason: args.rejectionReason,
      response_notes: args.responseNotes,
    });
    await tx.insert(petEvents).values({
      petId: args.proposal.petId,
      eventType: "foster_proposal_resolved",
      occurredAt: args.now,
      recordedAt: args.now,
      recordedByUserId: args.actorUserId,
      authorRole: "owner",
      authorOrganizationId: null,
      authorVerified: false,
      payload,
      caseId: proposalCaseId,
    });

    if (proposalCaseId) {
      await closeCase(
        { caseId: proposalCaseId, reason: "resolved", closedByUserId: args.actorUserId },
        tx,
      );
    }

    const orgCoordinatorIds = await getOrgFosterCoordinatorUserIds(
      args.proposal.organizationId,
      tx,
    );
    return { orgCoordinatorIds };
  },

  /**
   * Atomic: cancel a foster proposal (org-initiated). Emits event, closes case,
   * returns volunteer userId for notification.
   */
  async insertCancelFosterProposal(
    args: {
      proposal: ProposalRow;
      cancellationReason: string;
      actorUserId: string;
      now: Date;
    },
    tx: Tx,
  ): Promise<{ volunteerUserId: string }> {
    await tx
      .update(fosterProposals)
      .set({
        status: "cancelled",
        cancelledAt: args.now,
        cancelledByUserId: args.actorUserId,
        cancellationReason: args.cancellationReason,
        updatedAt: args.now,
      })
      .where(eq(fosterProposals.id, args.proposal.id));

    const proposalCaseId =
      args.proposal.caseId ??
      (await findOpenCaseForPetAndKind(args.proposal.petId, "foster_proposal", tx))?.id ??
      null;

    const payload = validateEventPayload("foster_proposal_resolved", {
      proposal_public_token: args.proposal.publicToken,
      outcome: "cancelled",
      cancellation_reason: args.cancellationReason,
      auto_cancelled: false,
    });
    await tx.insert(petEvents).values({
      petId: args.proposal.petId,
      eventType: "foster_proposal_resolved",
      occurredAt: args.now,
      recordedAt: args.now,
      recordedByUserId: args.actorUserId,
      authorRole: "shelter",
      authorOrganizationId: args.proposal.organizationId,
      authorVerified: true,
      payload,
      caseId: proposalCaseId,
    });

    if (proposalCaseId) {
      await closeCase(
        { caseId: proposalCaseId, reason: "cancelled", closedByUserId: args.actorUserId },
        tx,
      );
    }

    return { volunteerUserId: args.proposal.volunteerUserId };
  },

  /**
   * Atomic: set co-foster allowed flag + emit foster_co_foster_allowed event
   * (attached to open foster_placement case).
   */
  async insertSetCoFosterAllowed(
    args: {
      ownershipId: string;
      petId: string;
      allowCoFoster: boolean;
      actorUserId: string;
      now: Date;
    },
    tx: Tx,
  ): Promise<void> {
    await tx
      .update(ownerships)
      .set({ allowCoFoster: args.allowCoFoster })
      .where(eq(ownerships.id, args.ownershipId));

    const caseRow = await findOpenCaseForPetAndKind(args.petId, "foster_placement", tx);

    const payload = validateEventPayload("foster_co_foster_allowed", {
      allow_co_foster: args.allowCoFoster,
      foster_ownership_id: args.ownershipId,
    });
    await tx.insert(petEvents).values({
      petId: args.petId,
      eventType: "foster_co_foster_allowed",
      occurredAt: args.now,
      recordedAt: args.now,
      recordedByUserId: args.actorUserId,
      authorRole: "owner",
      authorOrganizationId: null,
      authorVerified: false,
      payload,
      caseId: caseRow?.id ?? null,
    });
  },

  // -------------------------------------------------------------------------
  // Convert-foster-to-owner + rehome helpers
  // -------------------------------------------------------------------------

  /**
   * Finds a pet by its public token. Returns the full pet row or null.
   * Used by convert-foster-to-owner and find-rehome-orgs use-cases.
   */
  async findPetByToken(publicToken: string, tx?: Tx): Promise<PetRow | null> {
    const client = tx ?? db;
    const [row] = await client
      .select()
      .from(pets)
      // Art. 16: an erased pet answers like a token that never existed.
      .where(unerasedPetByToken(publicToken))
      .limit(1);
    return row ?? null;
  },

  /**
   * Finds the active foster ownership row for a pet scoped to the given
   * userId. Returns id + petId or null. Used as the server-side auth boundary
   * for convert-foster-to-owner and send-rehome-request.
   */
  async findActiveFosterByUser(
    petId: string,
    userId: string,
    tx?: Tx,
  ): Promise<{ id: string; ownerUserId: string; petId: string } | null> {
    const client = tx ?? db;
    const [row] = await client
      .select({ id: ownerships.id, ownerUserId: ownerships.ownerUserId, petId: ownerships.petId })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerUserId, userId),
          eq(ownerships.role, "foster"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    return row?.ownerUserId ? (row as { id: string; ownerUserId: string; petId: string }) : null;
  },

  /**
   * Resolves an organization's public token by id. Used to build org-portal
   * CTA URLs (/org/{token}/...) for coordinator notifications.
   */
  async orgPublicTokenById(orgId: string, tx?: Tx): Promise<string | null> {
    const client = tx ?? db;
    const [row] = await client
      .select({ publicToken: organizations.publicToken })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return row?.publicToken ?? null;
  },

  /**
   * Finds an organization by id. Returns a minimal shape for rehome-request
   * validation (orgType, verified) or null.
   */
  async findOrgById(
    orgId: string,
    tx?: Tx,
  ): Promise<{ id: string; displayName: string; orgType: string; verified: boolean } | null> {
    const client = tx ?? db;
    const [row] = await client
      .select({
        id: organizations.id,
        displayName: organizations.displayName,
        orgType: organizations.orgType,
        verified: organizations.verified,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return row ?? null;
  },

  /**
   * The org's coverage zones (W-4, foster half). Rows only — `orgCoversZone`
   * (lib/domain/org-coverage.ts) decides. Same shape as the rehome
   * repository's `findOrgCoverage` and the picker's query, so the page's list
   * and the use-case's refusal cannot drift apart.
   */
  async findOrgCoverage(orgId: string, tx?: Tx): Promise<CoverageArea[]> {
    // Id-aware rows (localidades-por-id D5).
    return loadOrgCoverageAreas(orgId, tx ?? db);
  },

  /** The `coverage` flag, as the pure predicate reads it (localidades-por-id D5). */
  async coverageMode(): Promise<"name" | "id"> {
    return coverageDecisionMode();
  },

  /**
   * Returns userId list for admin + coordinator members of an org.
   * Used for notification fan-out in sendRehomeRequest.
   */
  async orgAdminAndCoordinatorUserIds(orgId: string, tx?: Tx): Promise<Array<{ userId: string }>> {
    const client = tx ?? db;
    return (client as typeof db)
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, orgId),
          inArray(organizationMemberships.role, ["admin", "coordinator"]),
          isNull(organizationMemberships.leftAt),
        ),
      );
  },

  /**
   * Atomic: convert foster -> owner in one transaction.
   *
   * Moved to ./foster-convert-to-owner-writer.ts (2026-08-21) to get this file
   * off its size ratchet — its header says why the destination had to stay
   * inside this module's infrastructure layer. Kept as a delegating member so
   * every caller and every test double still reaches it through the repository.
   */
  insertConvertFosterToOwner,

  /**
   * Checks whether the given organization currently has active shelter_custody
   * of the pet identified by petId. Used as a defense-in-depth re-check during
   * proposal acceptance (org may have released custody after proposal was made).
   */
  async findOrgCustodyByPetId(
    petId: string,
    orgId: string,
    tx?: Tx,
  ): Promise<{ id: string } | null> {
    const client = tx ?? db;
    const [row] = await client
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, orgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  /**
   * Finds a foster ownership row by id that belongs to the given user and is
   * currently active (endedAt IS NULL). Returns the row or null.
   */
  async findActiveFosterOwnershipById(
    id: string,
    userId: string,
    tx?: Tx,
  ): Promise<{ id: string; petId: string } | null> {
    const client = tx ?? db;
    const [row] = await client
      .select({ id: ownerships.id, petId: ownerships.petId })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.id, id),
          eq(ownerships.role, "foster"),
          eq(ownerships.ownerUserId, userId),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  /**
   * The `/api/v1/me/foster` hub read. Extracted to `foster-hub-reader.ts` —
   * see that file's own header for why it is not inline here.
   */
  listHubRowsForVolunteer: (userId: string, tx?: Tx) =>
    listFosterHubRowsForVolunteer(userId, tx ?? db),

  /**
   * Finds a user profile by id. Used for D13 pre-conditions.
   */
  async findProfileById(
    userId: string,
    tx?: Tx,
  ): Promise<{
    id: string;
    accountType: string | null;
    role: string | null;
    dniVerified: boolean | null;
    displayName: string | null;
    phone: string | null;
  } | null> {
    const client = tx ?? db;
    const [row] = await client
      .select({
        id: profiles.id,
        accountType: profiles.accountType,
        role: profiles.role,
        dniVerified: profiles.dniVerified,
        displayName: profiles.displayName,
        phone: profiles.phone,
      })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    return row ?? null;
  },
};
