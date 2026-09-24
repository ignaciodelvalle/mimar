// RehomeRepository — the Drizzle side of the rehome-by-titular module.
//
// Thin. No auth (that lives at the action edge), no business rules (those live
// in domain/rehome-rules.ts), no notification bodies (those live in the
// use-cases). Every write that participates in the accept transaction takes an
// explicit `tx` so the use-case — not this file — owns the ordering that
// design ADR-1 makes load-bearing.
//
// Lives under src/modules/**/infrastructure/** on purpose: the accept path is a
// writer of `rehome_sponsorship_started`, a titular-only event type, and
// scripts/check-titular-gate.ts only sees writers inside its scan globs.
//
// Cross-module edges (scripts/check-dependency-direction.ts, `rehome:adoption`):
// the eligibility + listing writers and the open-sponsorship predicate are
// REUSED from adoption, never re-implemented — four copies of the catalog
// predicate already drift (design R5); a fifth would be the wrong direction.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  caseEvents,
  cases,
  db,
  organizationCoverage,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { findExistingByKey } from "@/lib/events/event-idempotency";
import { validateEventPayload } from "@/lib/events/event-schemas";
import {
  closeCaseOwned,
  findOpenAdoptionApplicationCase,
  findOpenAdoptionListingCase,
  findOpenCaseForPetAndKind,
  openCase,
} from "@/lib/infra/case-helpers";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";
import {
  endRehomeSponsorship,
  findOpenSponsorship,
} from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";

import type {
  CloseApplicationByTitularArgs,
  CloseListingCaseArgs,
  CloseRequestCaseArgs,
  CoverageArea,
  EndSponsorshipByTitularArgs,
  InsertShelterCustodyArgs,
  InsertSponsorshipStartedArgs,
  MarkEligibleArgs,
  OpenRequestCaseArgs,
  OpenSponsorshipRef,
  PetSummary,
  RehomeRepositoryPort,
  RequestCase,
  RequestWithdrawnByKey,
  SponsorCandidateRow,
  SponsorOrg,
  SponsorshipEndedByKey,
  StrandedApplication,
} from "../application/ports";
import { REHOME_ELIGIBLE_ORG_TYPES } from "../domain/rehome-rules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The `organizations.org_type` enum, as the column types it. */
type SponsorOrgType = (typeof organizations.$inferSelect)["orgType"];

const PET_SUMMARY_COLUMNS = {
  id: pets.id,
  publicToken: pets.publicToken,
  name: pets.name,
  status: pets.status,
  jurisdictionProvince: pets.jurisdictionProvince,
  jurisdictionLocality: pets.jurisdictionLocality,
  localityId: pets.localityId,
  inCustodyDispute: pets.inCustodyDispute,
  rabiesObservationStatus: pets.rabiesObservationStatus,
  adoptionIneligibleUntil: pets.adoptionIneligibleUntil,
} as const;

/**
 * The `reason` a pending application's auto-resolution carries when the
 * titular closes the listing under it. Read back by nothing yet — it is the
 * spine's own record of WHY, beside `auto_generated: true`; the org's
 * finalize cascade writes `another_application_finalized` in the same slot.
 */
export const LISTING_WITHDRAWN_REASON = "listing_withdrawn_by_titular";

/**
 * Close a case and leave the prose the people involved read. The case row
 * carries the category (`resolved` / `cancelled`) and the actor; the timeline
 * entry carries who did what, naming the org — spec REQ-5's "distinguishable
 * from every other `cancelled`". Shared by the org's answer, the titular's
 * cancel and the titular's withdraw.
 *
 * OWNED, not merely idempotent (WU4 review, L-6). `case_events` is append-only
 * by trigger: a closer that lost the race and still wrote its `case_closed`
 * entry would leave the expediente counting two closes with two actors for a
 * case that closed once. `closeCaseOwned` says whether THIS caller won; the
 * note is written only then. The answer and cancel paths hold the case FOR
 * UPDATE and cannot lose; the withdraw's listing-case close is unlocked, and
 * it is the one this protects.
 *
 * `payload.rehome_decision` is READ by components/casos/case-entry-label.ts,
 * which turns the entry into "aceptada por la organización" / "rechazada por
 * la organización" / "cancelado por el titular" on the timeline (REQ-5).
 */
async function closeCaseWithNote(
  args: {
    caseId: string;
    reason: "resolved" | "cancelled";
    closedByUserId: string;
    decision: "accepted" | "declined" | "withdrawn";
    organizationId: string;
    timelineNote: string;
    now: Date;
    /** The titular's cancel keeps its client key here — the ledger `findRequestWithdrawnByKey` reads. */
    clientIdempotencyKey?: string | null;
  },
  client: Tx,
): Promise<{ won: boolean }> {
  const { won } = await closeCaseOwned(
    { caseId: args.caseId, reason: args.reason, closedByUserId: args.closedByUserId },
    client,
  );
  if (!won) return { won: false };
  await client.insert(caseEvents).values({
    caseId: args.caseId,
    entryType: "case_closed",
    notes: args.timelineNote,
    recordedByUserId: args.closedByUserId,
    occurredAt: args.now,
    payload: {
      rehome_decision: args.decision,
      organization_id: args.organizationId,
      ...(args.clientIdempotencyKey ? { client_idempotency_key: args.clientIdempotencyKey } : {}),
    },
  });
  return { won: true };
}

function toRequestCase(row: {
  id: string;
  publicCode: string;
  caseKind: string;
  status: string;
  primaryPetId: string | null;
  receiverOrganizationId: string | null;
  openedByUserId: string | null;
}): RequestCase {
  return {
    id: row.id,
    publicCode: row.publicCode,
    caseKind: row.caseKind,
    status: row.status,
    primaryPetId: row.primaryPetId,
    receiverOrganizationId: row.receiverOrganizationId,
    openedByUserId: row.openedByUserId,
  };
}

export const RehomeRepository = {
  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async findPetByToken(publicToken: string): Promise<PetSummary | null> {
    const [row] = await db
      .select(PET_SUMMARY_COLUMNS)
      .from(pets)
      // Art. 16: an erased pet answers like a token that never existed.
      .where(unerasedPetByToken(publicToken))
      .limit(1);
    return row ?? null;
  },

  async findPetById(petId: string, tx?: unknown): Promise<PetSummary | null> {
    const client = (tx as Tx | undefined) ?? db;
    const [row] = await client
      .select(PET_SUMMARY_COLUMNS)
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    return row ?? null;
  },

  /**
   * The user's live `role='owner'` row on the pet. Deliberately NOT the
   * role-agnostic Path-1 lookup of requirePetAccess: a foster, a caretaker and
   * a co-owner all hold a live row on the pet and none of them is the titular
   * this flow needs (spec REQ-1, REQ-14).
   */
  async findLiveOwnerRow(
    petId: string,
    userId: string,
    tx?: unknown,
  ): Promise<{ id: string } | null> {
    const client = (tx as Tx | undefined) ?? db;
    const [row] = await client
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerUserId, userId),
          eq(ownerships.role, "owner"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  /**
   * The transaction-scoped advisory lock on the pet, taken FIRST by every
   * custody writer of this feature (accept, withdraw) and by adoption's
   * finalize — before any row lock. WU5 review: finalize locked the custody
   * row then closed the owner row; the withdraw locked the owner row then
   * closed the custody row — the same two row locks in opposite orders, a
   * deadlock Postgres breaks with 40P01. One lock taken first, in the same
   * place, by both sides, and the row locks under it cannot form a cycle.
   * Same primitive the chip-match, return-to-owner and cross-org transfer
   * writers already serialise on; auto-released at commit/rollback.
   */
  async acquirePetAdvisoryLock(petId: string, tx: unknown): Promise<void> {
    const client = tx as Tx;
    await client.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${petId}))`);
  },

  /**
   * Lock-then-read variant of findLiveOwnerRow for the accept transaction
   * (ADR-1 step 2). Plain `SELECT ... FOR UPDATE`; no explicit lock of the
   * pet itself — that is `acquirePetAdvisoryLock`, taken before this.
   */
  async lockLiveOwnerRow(
    petId: string,
    userId: string,
    tx: unknown,
  ): Promise<{ id: string } | null> {
    const client = tx as Tx;
    const [row] = await client
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerUserId, userId),
          eq(ownerships.role, "owner"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async findOrgById(orgId: string, tx?: unknown): Promise<SponsorOrg | null> {
    const client = (tx as Tx | undefined) ?? db;
    const [row] = await client
      .select({
        id: organizations.id,
        displayName: organizations.displayName,
        publicToken: organizations.publicToken,
        orgType: organizations.orgType,
        verified: organizations.verified,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return row ?? null;
  },

  async findOrgByPublicToken(publicToken: string): Promise<SponsorOrg | null> {
    const [row] = await db
      .select({
        id: organizations.id,
        displayName: organizations.displayName,
        publicToken: organizations.publicToken,
        orgType: organizations.orgType,
        verified: organizations.verified,
      })
      .from(organizations)
      .where(eq(organizations.publicToken, publicToken))
      .limit(1);
    return row ?? null;
  },

  /**
   * The picker's candidates: verified shelters and rescue networks with a
   * coverage row in the province — one row per (org, coverage) pair, the
   * zone predicate left to `listCoveringOrgs`. The same join the web page ran
   * inline until 2026-09-10.
   */
  async findSponsorCandidatesInProvince(province: string): Promise<SponsorCandidateRow[]> {
    const rows = await db
      .select({
        id: organizations.id,
        publicToken: organizations.publicToken,
        displayName: organizations.displayName,
        orgType: organizations.orgType,
        jurisdictionProvince: organizationCoverage.jurisdictionProvince,
        jurisdictionLocality: organizationCoverage.jurisdictionLocality,
      })
      .from(organizations)
      .innerJoin(organizationCoverage, eq(organizationCoverage.organizationId, organizations.id))
      .where(
        and(
          eq(organizations.verified, true),
          // The domain's list, narrowed to the column's enum: `REHOME_ELIGIBLE_ORG_TYPES`
          // is `readonly string[]` on purpose (the rule compares strings), and the
          // column refuses a member outside its enum at the type level.
          inArray(organizations.orgType, [...REHOME_ELIGIBLE_ORG_TYPES] as SponsorOrgType[]),
          eq(organizationCoverage.jurisdictionProvince, province),
        ),
      );
    return rows.map((r) => ({
      id: r.id,
      publicToken: r.publicToken,
      displayName: r.displayName,
      orgType: r.orgType,
      coverage: {
        jurisdictionProvince: r.jurisdictionProvince,
        jurisdictionLocality: r.jurisdictionLocality,
      },
    }));
  },

  /**
   * The org's coverage zones (W-4). Rows only — `validateSponsorCoverage`
   * decides. The picker reads the same table through the same shape, so the
   * page's list and the use-case's refusal cannot drift apart.
   */
  async findOrgCoverage(orgId: string): Promise<CoverageArea[]> {
    return db
      .select({
        jurisdictionProvince: organizationCoverage.jurisdictionProvince,
        jurisdictionLocality: organizationCoverage.jurisdictionLocality,
      })
      .from(organizationCoverage)
      .where(eq(organizationCoverage.organizationId, orgId));
  },

  /**
   * Lock-then-read variant of findOrgById for the accept transaction (ADR-1
   * step 1b; WU3 review M-1 residual). `FOR SHARE`, not `FOR UPDATE`: the
   * accept only needs the verification it read to still hold when it commits
   * — a de-verifying UPDATE must wait behind this transaction — while two
   * accepts of two different requests addressed to the same org must not
   * serialise on the org row.
   */
  async lockOrgForShare(orgId: string, tx: unknown): Promise<SponsorOrg | null> {
    const client = tx as Tx;
    const [row] = await client
      .select({
        id: organizations.id,
        displayName: organizations.displayName,
        publicToken: organizations.publicToken,
        orgType: organizations.orgType,
        verified: organizations.verified,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .for("share");
    return row ?? null;
  },

  async findOpenRequestForPet(petId: string): Promise<RequestCase | null> {
    const row = await findOpenCaseForPetAndKind(petId, "rehome_request");
    return row ? toRequestCase(row) : null;
  },

  async findRequestCaseByPublicCode(publicCode: string): Promise<RequestCase | null> {
    const [row] = await db.select().from(cases).where(eq(cases.publicCode, publicCode)).limit(1);
    return row ? toRequestCase(row) : null;
  },

  /**
   * Re-read under `SELECT ... FOR UPDATE`. The pre-transaction read every
   * use-case does is stale by construction — two org members answering the
   * same request race for this row. The lock serialises them; the loser sees
   * the flipped status and aborts before writing (design ADR-1, mitigation 1).
   */
  async lockRequestCase(caseId: string, tx: unknown): Promise<RequestCase | null> {
    const client = tx as Tx;
    const [row] = await client
      .select()
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1)
      .for("update");
    return row ? toRequestCase(row) : null;
  },

  /**
   * Keyed on the spine — an unmatched `rehome_sponsorship_started` — never on
   * the owner+shelter_custody shape, which also describes a decomiso or an
   * intake. The predicate is adoption's (`findOpenSponsorship`); one copy.
   */
  async hasOpenSponsorship(petId: string, tx?: unknown): Promise<boolean> {
    const client = ((tx as Tx | undefined) ?? db) as Tx;
    const open = await findOpenSponsorship(petId, client);
    return open !== null;
  },

  async countLiveShelterCustody(petId: string, tx: unknown): Promise<number> {
    const client = tx as Tx;
    const [row] = await client
      .select({ n: sql<number>`count(*)::int` })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      );
    return row?.n ?? 0;
  },

  async orgAdminAndCoordinatorUserIds(orgId: string): Promise<string[]> {
    const rows = await db
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, orgId),
          inArray(organizationMemberships.role, ["admin", "coordinator"]),
          isNull(organizationMemberships.leftAt),
        ),
      );
    return rows.map((r) => r.userId);
  },

  async findDisplayName(userId: string): Promise<string | null> {
    const [row] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    return row?.displayName ?? null;
  },

  // -------------------------------------------------------------------------
  // Writes — request
  // -------------------------------------------------------------------------

  /**
   * The titular opens the case; the org is its RECEIVER. `openedByOrganization`
   * stays null by construction, and the org's inbox predicate (WU5) keys on
   * `receiver_organization_id` — the same column the cross-org transfer accept
   * path authorizes against.
   */
  async openRequestCase(args: OpenRequestCaseArgs): Promise<{ id: string; publicCode: string }> {
    const row = await openCase({
      kind: "rehome_request",
      primarySubjectKind: "registered_pet",
      primaryPetId: args.petId,
      jurisdictionProvince: args.jurisdictionProvince,
      jurisdictionLocality: args.jurisdictionLocality,
      localityId: args.localityId,
      openedByUserId: args.titularUserId,
      openedByOrganizationId: null,
      receiverOrganizationId: args.orgId,
      openedReason: { code: "rehome_requested", orgDisplayName: args.orgDisplayName },
    });
    return { id: row.id, publicCode: row.publicCode };
  },

  // -------------------------------------------------------------------------
  // Writes — answer (inside the caller's transaction)
  // -------------------------------------------------------------------------

  /** ADR-1 step 5: the org's row beside the titular's. Nothing is closed here. */
  async insertShelterCustody(args: InsertShelterCustodyArgs, tx: unknown): Promise<{ id: string }> {
    const client = tx as Tx;
    const [row] = await client
      .insert(ownerships)
      .values({
        petId: args.petId,
        ownerOrganizationId: args.orgId,
        role: "shelter_custody",
        startedAt: args.now,
      })
      .returning({ id: ownerships.id });
    return row;
  },

  /**
   * ADR-1 step 6 — the adoption writer, reused: updates the eligibility
   * columns, opens (or attaches to) the org's adoption_listing case and emits
   * adoption_eligibility_set with that case id. The previous state is read
   * here so the event's `previous_state` is honest, as the adoption use-case's
   * own pre-load makes it.
   */
  async markEligibleAndOpenListing(
    args: MarkEligibleArgs,
    tx: unknown,
  ): Promise<{ listingCaseId: string | null }> {
    const client = tx as Tx;
    const [before] = await client
      .select({ eligible: pets.adoptionEligible, reason: pets.adoptionIneligibleReason })
      .from(pets)
      .where(eq(pets.id, args.petId))
      .limit(1);

    await AdoptionRepository.setEligibility(
      {
        petId: args.petId,
        eligible: true,
        ineligibleReason: null,
        ineligibleReasonNotes: null,
        ineligibleUntil: null,
        now: args.now,
        userId: args.userId,
        orgId: args.orgId,
        orgVerified: args.orgVerified,
        previousState: before ? { eligible: before.eligible, reason: before.reason } : null,
      },
      client,
    );

    const listing = await findOpenAdoptionListingCase(args.petId, args.orgId, client);
    return { listingCaseId: listing?.id ?? null };
  },

  /** ADR-1 step 7 — the repository writer, not the use-case (see the use-case header). */
  async publishListing(args: { petId: string; now: Date }, tx: unknown): Promise<void> {
    await AdoptionRepository.setListingStatus(
      { petId: args.petId, action: "publish", currentListedAt: null, now: args.now },
      tx as Tx,
    );
  },

  /**
   * ADR-1 step 8 — the consent fact. Authored by the ORG (this is the org
   * path; `holderRole` is null there), naming the titular who consented in the
   * payload and the custody row it opened. Attached to the REQUEST case, which
   * the caller closes one step later.
   */
  async insertSponsorshipStarted(args: InsertSponsorshipStartedArgs, tx: unknown): Promise<void> {
    const client = tx as Tx;
    await client.insert(petEvents).values({
      petId: args.petId,
      eventType: "rehome_sponsorship_started",
      occurredAt: args.now,
      recordedAt: args.now,
      recordedByUserId: args.recordedByUserId,
      authorRole: "shelter",
      authorOrganizationId: args.orgId,
      authorVerified: args.orgVerified,
      payload: validateEventPayload("rehome_sponsorship_started", {
        ownership_id: args.ownershipId,
        sponsoring_organization_id: args.orgId,
        consented_by_user_id: args.consentedByUserId,
        request_case_public_code: args.requestCasePublicCode,
        listing_case_id: args.listingCaseId,
        note: null,
      }),
      caseId: args.requestCaseId,
    });
  },

  /**
   * ADR-1 step 9 (and the whole of a decline). The case row carries the
   * category (`resolved` / `cancelled`) and the actor; the timeline entry
   * carries the prose the titular reads, naming the org — spec REQ-5's
   * "distinguishable from every other `cancelled`".
   */
  async closeRequestCase(args: CloseRequestCaseArgs, tx: unknown): Promise<void> {
    await closeCaseWithNote(args, tx as Tx);
  },

  // -------------------------------------------------------------------------
  // The ledger — what a replayed withdraw asks before the state guard
  // -------------------------------------------------------------------------

  /**
   * The `rehome_sponsorship_ended` this titular signed under this client key,
   * joined to the custody row it names and that row's org. `findExistingByKey`
   * is the same lookup every idempotent writer on the spine uses; the join is
   * what lets a replay answer with the org the first attempt answered with.
   */
  async findSponsorshipEndedByKey(
    petId: string,
    titularUserId: string,
    key: string,
    tx?: unknown,
  ): Promise<SponsorshipEndedByKey | null> {
    const client = (tx as Tx | undefined) ?? db;
    const event = await findExistingByKey(petId, "rehome_sponsorship_ended", key, client);
    if (!event || event.recordedByUserId !== titularUserId) return null;
    const ownershipId = (event.payload as { ownership_id?: unknown }).ownership_id;
    if (typeof ownershipId !== "string") return null;
    const [custody] = await client
      .select({
        organizationId: ownerships.ownerOrganizationId,
        organizationPublicToken: organizations.publicToken,
      })
      .from(ownerships)
      .leftJoin(organizations, eq(organizations.id, ownerships.ownerOrganizationId))
      .where(eq(ownerships.id, ownershipId))
      .limit(1);
    return {
      ownershipId,
      sponsoringOrganizationId: custody?.organizationId ?? null,
      sponsoringOrganizationPublicToken: custody?.organizationPublicToken ?? null,
    };
  },

  /**
   * The `rehome_request` case this titular closed under this client key: the
   * `case_closed` entry `closeCaseWithNote` wrote, found by the key it kept in
   * its payload, scoped to this pet and this actor.
   */
  async findRequestWithdrawnByKey(
    petId: string,
    titularUserId: string,
    key: string,
    tx?: unknown,
  ): Promise<RequestWithdrawnByKey | null> {
    const client = (tx as Tx | undefined) ?? db;
    const [row] = await client
      .select({
        caseId: cases.id,
        casePublicCode: cases.publicCode,
        receiverOrganizationId: cases.receiverOrganizationId,
      })
      .from(caseEvents)
      .innerJoin(cases, eq(cases.id, caseEvents.caseId))
      .where(
        and(
          eq(cases.primaryPetId, petId),
          eq(cases.caseKind, "rehome_request"),
          eq(caseEvents.entryType, "case_closed"),
          eq(caseEvents.recordedByUserId, titularUserId),
          sql`${caseEvents.payload} ->> 'client_idempotency_key' = ${key}`,
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // -------------------------------------------------------------------------
  // Writes — withdraw (inside the caller's transaction)
  // -------------------------------------------------------------------------

  async findOpenSponsorshipForPet(petId: string, tx?: unknown): Promise<OpenSponsorshipRef | null> {
    return findOpenSponsorship(petId, ((tx as Tx | undefined) ?? db) as Tx);
  },

  /**
   * Closes the custody row the sponsorship opened — by id, never by the
   * (pet, org) shape. `ended: false` means someone already closed it without
   * writing the closing event; the withdraw goes on regardless (REQ-10 — the
   * titular's route back is unconditional) and lint:spine would have named
   * the orphan.
   */
  async endCustodyRow(ownershipId: string, now: Date, tx: unknown): Promise<{ ended: boolean }> {
    const client = tx as Tx;
    const rows = await client
      .update(ownerships)
      .set({ endedAt: now })
      .where(and(eq(ownerships.id, ownershipId), isNull(ownerships.endedAt)))
      .returning({ id: ownerships.id });
    return { ended: rows.length > 0 };
  },

  /** The adoption writer, reused: clears `adoptionListedAt` and the pause. */
  async unpublishListing(args: { petId: string; now: Date }, tx: unknown): Promise<void> {
    await AdoptionRepository.setListingStatus(
      { petId: args.petId, action: "unpublish", currentListedAt: null, now: args.now },
      tx as Tx,
    );
  },

  /**
   * The closing fact, signed by the TITULAR: `owner`, no org, not verified —
   * the person-path authorship every owner-written event carries. Attaches
   * to the open `adoption_listing` case (attaches-when-open), so the caller
   * writes it BEFORE closing that case.
   */
  async endSponsorshipByTitular(args: EndSponsorshipByTitularArgs, tx: unknown): Promise<void> {
    await endRehomeSponsorship(
      {
        petId: args.petId,
        outcome: "withdrawn_by_titular",
        recordedByUserId: args.titularUserId,
        authorRole: "owner",
        authorOrganizationId: null,
        authorVerified: false,
        now: args.now,
        clientIdempotencyKey: args.clientIdempotencyKey,
      },
      tx as Tx,
    );
  },

  async findOpenListingCase(
    petId: string,
    orgId: string,
    tx?: unknown,
  ): Promise<{ id: string; publicCode: string } | null> {
    const row = await findOpenAdoptionListingCase(petId, orgId, (tx as Tx | undefined) ?? db);
    return row ? { id: row.id, publicCode: row.publicCode } : null;
  },

  /** The sponsorship itself, closed `cancelled` by the titular, with the prose both sides read. */
  async closeListingCase(args: CloseListingCaseArgs, tx: unknown): Promise<{ won: boolean }> {
    return closeCaseWithNote({ ...args, reason: "cancelled", decision: "withdrawn" }, tx as Tx);
  },

  // -------------------------------------------------------------------------
  // Writes — the applications a withdraw strands (inside the caller's tx)
  // -------------------------------------------------------------------------

  /**
   * Both predicates are adoption's, reused: the PENDING set is the same read
   * the finalize cascade uses (excluding nobody), the APPROVED-unfinalized
   * set is the adopter still waiting for a finalize that can no longer run.
   */
  async findApplicationsOnListing(petId: string, tx: unknown): Promise<StrandedApplication[]> {
    const client = tx as Tx;
    const pending = await AdoptionRepository.findPendingApplicationsExcluding(petId, null, client);
    const approved = await AdoptionRepository.findApprovedUnfinalizedApplications(petId, client);
    return [
      ...pending.map((a) => ({ ...a, approved: false })),
      ...approved.map((a) => ({ ...a, approved: true })),
    ];
  },

  /**
   * A PENDING application is resolved on the spine as an auto-generated
   * rejection whose reason names the cause, signed by the TITULAR — the
   * person whose act closed the listing, not the org. An APPROVED one keeps
   * its approval: a second, contradictory resolution for the same application
   * would be a lie on an append-only ledger, and its fate is already on the
   * spine as `rehome_sponsorship_ended{withdrawn_by_titular}`. Both get their
   * `adoption_application` case closed with a note the applicant reads.
   */
  async closeApplicationByTitular(args: CloseApplicationByTitularArgs, tx: unknown): Promise<void> {
    const client = tx as Tx;
    const { application } = args;
    if (!application.approved) {
      await AdoptionRepository.resolveApplication(
        {
          petId: args.petId,
          applicationEventId: application.applicationId,
          outcome: "rejected",
          reviewerUserId: args.titularUserId,
          orgId: args.organizationId,
          orgVerified: false,
          reason: LISTING_WITHDRAWN_REASON,
          autoGenerated: true,
          notes: null,
          now: args.now,
          author: { role: "owner", organizationId: null, verified: false },
          // The case is closed BELOW with the titular's own note; the
          // resolver's default close would write the generic one first and
          // win the append-only `case_closed` entry.
          closeCase: false,
        },
        client,
      );
    }
    const appCase = await findOpenAdoptionApplicationCase(
      args.petId,
      application.applicantUserId,
      client,
    );
    if (!appCase) return;
    await closeCaseWithNote(
      {
        caseId: appCase.id,
        reason: "cancelled",
        closedByUserId: args.titularUserId,
        decision: "withdrawn",
        organizationId: args.organizationId,
        timelineNote: `El titular retiró la búsqueda de hogar de ${args.petName}. ${args.organizationDisplayName} ya no acompaña la adopción y esta postulación quedó cerrada; no hace falta hacer nada.`,
        now: args.now,
      },
      client,
    );
  },
} satisfies RehomeRepositoryPort;
