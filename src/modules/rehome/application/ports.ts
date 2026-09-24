// The repository PORT the rehome use-cases talk to.
//
// Declared in the application layer, implemented by
// infrastructure/rehome-repository.ts (`satisfies RehomeRepositoryPort`). No
// Drizzle row types leak through: each method returns the narrow shape the
// use-cases read, so the application layer never imports @/db.
//
// Transaction handles are `unknown` here and cast in infrastructure — the
// use-case owns the ORDER of the accept transaction (design ADR-1), the
// repository owns the SQL of each step.
//
// Three parts: the REQUEST part (the titular asks), the ANSWER part (the org
// accepts or declines) and the WITHDRAW part (the titular cancels a pending
// request or ends a running sponsorship). Each use-case depends on its own
// part only.

import type { CoverageArea } from "../domain/rehome-rules";

// Re-exported so infrastructure imports the coverage row shape from the port
// it implements, like every other shape here — the definition stays in the
// domain, next to the predicate that reads it.
export type { CoverageArea };

export type PetSummary = {
  id: string;
  publicToken: string;
  name: string;
  status: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  localityId: string | null;
  inCustodyDispute: boolean | null;
  rabiesObservationStatus: string | null;
  /** A time-boxed ineligibility left by an earlier custodian (accept step 4, L-3). */
  adoptionIneligibleUntil: Date | null;
};

export type SponsorOrg = {
  id: string;
  displayName: string;
  publicToken: string;
  orgType: string;
  verified: boolean;
};

/** The subset of a `cases` row the rehome flow reads. */
export type RequestCase = {
  id: string;
  publicCode: string;
  caseKind: string;
  status: string;
  primaryPetId: string | null;
  receiverOrganizationId: string | null;
  openedByUserId: string | null;
};

export type OpenRequestCaseArgs = {
  petId: string;
  titularUserId: string;
  orgId: string;
  orgDisplayName: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  localityId: string | null;
};

export interface RehomeRequestPort {
  findPetByToken(publicToken: string): Promise<PetSummary | null>;
  /** The user's live `role='owner'` row on the pet — never foster, never caretaker. */
  findLiveOwnerRow(petId: string, userId: string, tx?: unknown): Promise<{ id: string } | null>;
  findOrgById(orgId: string, tx?: unknown): Promise<SponsorOrg | null>;
  /**
   * The org by its PUBLIC token — what the bearer door is handed, since a
   * client is never given an internal id (`@dim/contract/api`'s rule). The
   * web form posts ids and never calls this.
   */
  findOrgByPublicToken(publicToken: string): Promise<SponsorOrg | null>;
  /**
   * The org's `organization_coverage` rows — the zones it works in. The rule
   * (`validateSponsorCoverage`) decides; this only fetches. Same rows the
   * picker joins on, so the two cannot disagree about who covers what.
   */
  findOrgCoverage(orgId: string): Promise<CoverageArea[]>;
  findOpenRequestForPet(petId: string): Promise<RequestCase | null>;
  /** An accepted sponsorship with no matching end event, keyed on the spine. */
  hasOpenSponsorship(petId: string, tx?: unknown): Promise<boolean>;
  orgAdminAndCoordinatorUserIds(orgId: string): Promise<string[]>;
  findDisplayName(userId: string): Promise<string | null>;
  openRequestCase(args: OpenRequestCaseArgs): Promise<{ id: string; publicCode: string }>;
}

export type InsertShelterCustodyArgs = { petId: string; orgId: string; now: Date };

export type MarkEligibleArgs = {
  petId: string;
  /** The accepting org member — the eligibility and listing are the org's act. */
  userId: string;
  orgId: string;
  orgVerified: boolean;
  now: Date;
};

export type InsertSponsorshipStartedArgs = {
  petId: string;
  /** The consent case, still open at this instant (attachment: requires-open). */
  requestCaseId: string;
  requestCasePublicCode: string;
  /** The `shelter_custody` row this sponsorship opened — payload.ownership_id. */
  ownershipId: string;
  listingCaseId: string | null;
  consentedByUserId: string;
  recordedByUserId: string;
  orgId: string;
  orgVerified: boolean;
  now: Date;
};

export type CloseRequestCaseArgs = {
  caseId: string;
  reason: "resolved" | "cancelled";
  closedByUserId: string;
  /** `withdrawn` is the titular's own cancel before an answer (REQ-3). */
  decision: "accepted" | "declined" | "withdrawn";
  organizationId: string;
  /** The `case_closed` timeline note the titular reads (spec REQ-5). */
  timelineNote: string;
  now: Date;
  /**
   * The client's replay key, kept on the `case_closed` entry so a retried
   * cancel can be recognised as the SAME cancel (`findRequestWithdrawnByKey`).
   * Null from the web, which sends none.
   */
  clientIdempotencyKey?: string | null;
};

export interface RehomeAnswerPort {
  findRequestCaseByPublicCode(publicCode: string): Promise<RequestCase | null>;
  /** `pg_advisory_xact_lock(hashtext(petId))` — the FIRST lock of every custody writer (lock order). */
  acquirePetAdvisoryLock(petId: string, tx: unknown): Promise<void>;
  /** Re-read under `SELECT ... FOR UPDATE`: the pre-transaction read is stale. */
  lockRequestCase(caseId: string, tx: unknown): Promise<RequestCase | null>;
  findPetById(petId: string, tx?: unknown): Promise<PetSummary | null>;
  /**
   * The ACCEPTING org, re-read inside the transaction under `SELECT ... FOR
   * SHARE` (ADR-1 step 1b). A de-verification committing between a plain read
   * and the custody insert would otherwise be signed `verified: true`.
   */
  lockOrgForShare(orgId: string, tx: unknown): Promise<SponsorOrg | null>;
  /**
   * The titular's live `owner` row, under `SELECT ... FOR UPDATE` (ADR-1 step
   * 2). A transfer committing between this read and the custody insert would
   * otherwise grant custody on an ex-owner's consent; the lock makes the
   * transfer's own close of the row wait behind this transaction.
   */
  lockLiveOwnerRow(petId: string, userId: string, tx: unknown): Promise<{ id: string } | null>;
  countLiveShelterCustody(petId: string, tx: unknown): Promise<number>;
  findDisplayName(userId: string): Promise<string | null>;
  insertShelterCustody(args: InsertShelterCustodyArgs, tx: unknown): Promise<{ id: string }>;
  /** Reuses the adoption writer: sets eligibility, emits its event, opens the listing case. */
  markEligibleAndOpenListing(
    args: MarkEligibleArgs,
    tx: unknown,
  ): Promise<{ listingCaseId: string | null }>;
  publishListing(args: { petId: string; now: Date }, tx: unknown): Promise<void>;
  insertSponsorshipStarted(args: InsertSponsorshipStartedArgs, tx: unknown): Promise<void>;
  closeRequestCase(args: CloseRequestCaseArgs, tx: unknown): Promise<void>;
}

/** The unmatched `rehome_sponsorship_started`, keyed on the spine. */
export type OpenSponsorshipRef = { ownershipId: string; sponsoringOrganizationId: string };

export type EndSponsorshipByTitularArgs = {
  petId: string;
  titularUserId: string;
  now: Date;
  /** Stamped on `rehome_sponsorship_ended` so a replay can find its own fact. */
  clientIdempotencyKey: string | null;
};

/**
 * THE LEDGER'S ANSWER to "did this exact withdraw already happen?" — the
 * `rehome_sponsorship_ended` the titular wrote under this key, joined back to
 * the custody row it closed and the org that held it, so a replay can answer
 * with the same facts the first attempt did.
 */
export type SponsorshipEndedByKey = {
  ownershipId: string;
  sponsoringOrganizationId: string | null;
  sponsoringOrganizationPublicToken: string | null;
};

/** The ledger's answer for a cancel: the `rehome_request` case this key closed. */
export type RequestWithdrawnByKey = {
  caseId: string;
  casePublicCode: string;
  receiverOrganizationId: string | null;
};

export type CloseListingCaseArgs = {
  caseId: string;
  closedByUserId: string;
  organizationId: string;
  /** The `case_closed` timeline note both the titular and the org read. */
  timelineNote: string;
  now: Date;
};

/**
 * An application the titular's withdraw leaves with nothing to wait for:
 * PENDING (never reviewed) or APPROVED but not finalized. The two are closed
 * differently — see `closeApplicationByTitular`.
 */
export type StrandedApplication = {
  applicationId: string;
  applicantUserId: string;
  approved: boolean;
};

export type CloseApplicationByTitularArgs = {
  petId: string;
  petName: string;
  application: StrandedApplication;
  titularUserId: string;
  organizationId: string;
  organizationDisplayName: string;
  now: Date;
};

export interface RehomeWithdrawPort {
  findPetByToken(publicToken: string): Promise<PetSummary | null>;
  findLiveOwnerRow(petId: string, userId: string, tx?: unknown): Promise<{ id: string } | null>;
  /** `pg_advisory_xact_lock(hashtext(petId))` — the FIRST lock of every custody writer (lock order). */
  acquirePetAdvisoryLock(petId: string, tx: unknown): Promise<void>;
  /** The titular's live `owner` row, FOR UPDATE: the withdraw is the titular's act and no one else's. */
  lockLiveOwnerRow(petId: string, userId: string, tx: unknown): Promise<{ id: string } | null>;
  findOrgById(orgId: string, tx?: unknown): Promise<SponsorOrg | null>;
  orgAdminAndCoordinatorUserIds(orgId: string): Promise<string[]>;
  findDisplayName(userId: string): Promise<string | null>;
  // --- the ledger, asked BEFORE the state guard (both withdraws) ---
  /**
   * The `rehome_sponsorship_ended` THIS titular wrote on THIS pet under this
   * client key, or null. Read under the pet advisory lock inside the withdraw
   * transaction, so two replays of one key serialise on the same answer.
   */
  findSponsorshipEndedByKey(
    petId: string,
    titularUserId: string,
    key: string,
    tx?: unknown,
  ): Promise<SponsorshipEndedByKey | null>;
  /** The `rehome_request` case THIS titular closed on THIS pet under this client key, or null. */
  findRequestWithdrawnByKey(
    petId: string,
    titularUserId: string,
    key: string,
    tx?: unknown,
  ): Promise<RequestWithdrawnByKey | null>;
  // --- withdraw an active sponsorship ---
  findOpenSponsorshipForPet(petId: string, tx?: unknown): Promise<OpenSponsorshipRef | null>;
  /** Closes the custody row the sponsorship opened. `ended: false` when it was already closed. */
  endCustodyRow(ownershipId: string, now: Date, tx: unknown): Promise<{ ended: boolean }>;
  /** Clears `adoptionListedAt` and `adoptionListingPausedAt` — the adoption writer, reused. */
  unpublishListing(args: { petId: string; now: Date }, tx: unknown): Promise<void>;
  /** `rehome_sponsorship_ended{withdrawn_by_titular}`, signed by the titular. */
  endSponsorshipByTitular(args: EndSponsorshipByTitularArgs, tx: unknown): Promise<void>;
  findOpenListingCase(
    petId: string,
    orgId: string,
    tx?: unknown,
  ): Promise<{ id: string; publicCode: string } | null>;
  /** `won: false` when another closer got there first — the note is then NOT written. */
  closeListingCase(args: CloseListingCaseArgs, tx: unknown): Promise<{ won: boolean }>;
  /** Every application on the listing the withdraw is about to close. */
  findApplicationsOnListing(petId: string, tx: unknown): Promise<StrandedApplication[]>;
  /**
   * Closes one stranded application: a PENDING one gets an auto-generated
   * `adoption_application_resolved{rejected, reason: listing_withdrawn_by_titular}`
   * signed by the titular; an APPROVED one keeps its approval as the single
   * resolution on the spine. Both get their `adoption_application` case closed.
   */
  closeApplicationByTitular(args: CloseApplicationByTitularArgs, tx: unknown): Promise<void>;
  // --- cancel a pending request ---
  findOpenRequestForPet(petId: string): Promise<RequestCase | null>;
  lockRequestCase(caseId: string, tx: unknown): Promise<RequestCase | null>;
  closeRequestCase(args: CloseRequestCaseArgs, tx: unknown): Promise<void>;
}

/**
 * The READ side the titular's surface needs — one state out of three (none /
 * pending / active), derived from the open request case and the spine. No
 * transaction: the page reads, the actions write.
 */
export interface RehomeStatePort {
  findOpenRequestForPet(petId: string): Promise<RequestCase | null>;
  findOpenSponsorshipForPet(petId: string, tx?: unknown): Promise<OpenSponsorshipRef | null>;
  findOpenListingCase(
    petId: string,
    orgId: string,
    tx?: unknown,
  ): Promise<{ id: string; publicCode: string } | null>;
  findOrgById(orgId: string, tx?: unknown): Promise<SponsorOrg | null>;
}

/**
 * One (org, coverage row) pair: a verified shelter or rescue network and one
 * zone it declares. An org with three coverage rows in the province comes back
 * three times; `listCoveringOrgs` folds them and applies the zone predicate.
 */
export type SponsorCandidateRow = {
  id: string;
  publicToken: string;
  displayName: string;
  orgType: string;
  coverage: CoverageArea;
};

/** The READ behind the picker — the web page's and the bearer door's, once. */
export interface RehomeCandidatesPort {
  /**
   * Verified shelters and rescue networks with at least one coverage row in
   * the province. The PROVINCE narrows the query; whether a row reaches the
   * pet's locality is `coverageAreaCoversZone`'s decision, made by the caller.
   */
  findSponsorCandidatesInProvince(province: string): Promise<SponsorCandidateRow[]>;
}

export type RehomeRepositoryPort = RehomeRequestPort &
  RehomeAnswerPort &
  RehomeWithdrawPort &
  RehomeStatePort &
  RehomeCandidatesPort;
