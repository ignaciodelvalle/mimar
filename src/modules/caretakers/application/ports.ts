// The repository PORT the caretaker use-cases talk to.
//
// Declared in the application layer, implemented by
// infrastructure/caretakers-repository.ts (`satisfies CaretakersRepositoryPort`).
// The dependency points inward: application knows the port, infrastructure
// knows the port, application does NOT know infrastructure. That is what lets
// every use-case test run in the fast `unit` vitest project with a plain object
// literal for a repository — no Drizzle, no database, no serial execution.
//
// No Drizzle row types leak through here on purpose: each method returns the
// narrow shape the use-cases actually read. A `typeof pets.$inferSelect` in a
// port signature would drag @/db into the application layer's import graph and
// move every test in this module into the `db` project.

import type { GrantEndOutcome, GrantStatus } from "../domain/types";

/** The subset of a `pet_caretaker_grants` row the use-cases read. */
export type GrantRow = {
  id: string;
  publicToken: string;
  petId: string;
  grantedByUserId: string;
  caretakerUserId: string | null;
  caretakerEmail: string;
  status: GrantStatus;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
  ownershipId: string | null;
  reminderSentAt: Date | null;
  publicContactConsentAt: Date | null;
};

/** Minimal pet identity for copy and CTA links. Never the whole row. */
export type PetSummary = {
  id: string;
  publicToken: string;
  name: string;
  /**
   * Storage path of the primary photo, or null. Deliberately the PATH and not a
   * URL: signing/prefixing is a storage concern (lib/infra/storage.ts), and a
   * port that returned a URL would drag that decision — and its base-URL
   * environment variable — into the application layer's tests.
   *
   * Read by the `/cuidado/{token}` invitation page, which the spec requires to
   * show the pet's photo: an invitation to care for an animal you cannot see is
   * a form, not a decision.
   */
  primaryPhotoStoragePath: string | null;
};

export type InsertGrantArgs = {
  petId: string;
  grantedByUserId: string;
  caretakerUserId: string | null;
  caretakerEmail: string;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
  now: Date;
};

export type AcceptGrantArgs = {
  grantId: string;
  petId: string;
  caretakerUserId: string;
  grantPublicToken: string;
  endsAt: Date;
  note: string | null;
  /**
   * KEY 2 of the two-key public-contact model (PO 2026-08-19). `true` writes
   * `public_contact_consent_at`; `false` leaves it NULL. Captured HERE and
   * nowhere else, in the same UPDATE as the status flip — the CHECK constraint
   * forbids a consent timestamp on a `pending` row, so a second UPDATE would
   * have to violate it on the way through.
   */
  publicContactConsent: boolean;
  now: Date;
};

export type EndGrantArgs = {
  grantId: string;
  petId: string;
  ownershipId: string;
  outcome: GrantEndOutcome;
  endsAt: Date;
  /** Who is recorded as the author of `caretaker_ended`. Null for the cron. */
  actorUserId: string | null;
  now: Date;
};

export type UpdateGrantStatusArgs = {
  grantId: string;
  status: GrantStatus;
  /**
   * Concurrency guard, the `expirePetTransfers` shape: the UPDATE only fires
   * while the row is STILL in this status. Zero rows back means another writer
   * (a concurrent accept, or the cron) resolved it first.
   */
  expectedStatus: GrantStatus;
  respondedAt: Date | null;
  now: Date;
};

/** One accepted grant that has passed its `ends_at`, as the cron sees it. */
export type ExpirableGrant = GrantRow & { ownershipId: string };

/**
 * The last arrangement on a pet that actually ENDED, narrowed to what the
 * titular's cockpit needs to explain the absence.
 *
 * Separate from `GrantRow` because `ended_at` / `ended_reason` are only ever
 * set on a terminal row: widening `GrantRow` with two fields that are NULL for
 * every live grant would make every use-case read them defensively.
 */
export type EndedGrant = {
  id: string;
  publicToken: string;
  caretakerUserId: string | null;
  /** When the arrangement was DUE to end — what the copy shows. */
  endsAt: Date;
  /** When it actually closed. Drives the "is this still news?" window. */
  endedAt: Date;
  endedReason: GrantEndOutcome | null;
};

/**
 * One OPEN grant a person is a party to, plus the two names and the animal the
 * hub read needs to render it.
 *
 * Separate from `GrantRow` because it is a JOIN, not a row: widening `GrantRow`
 * with a pet name and two display names would make every write path carry three
 * fields it never reads, and would drag the join into `findGrantByIdForUpdate`,
 * which runs under a lock and must stay one table.
 */
export type UserGrantRow = {
  grant: GrantRow;
  petName: string;
  petToken: string;
  petSpecies: string;
  /** `profiles.display_name` of the titular who granted it. */
  grantedByDisplayName: string | null;
  /** Same, for the caretaker — null until they have an account with a name. */
  caretakerDisplayName: string | null;
};

export interface CaretakersRepositoryPort {
  // --- reads ---------------------------------------------------------------
  findGrantByToken(publicToken: string): Promise<GrantRow | null>;
  findGrantByIdForUpdate(grantId: string, tx: unknown): Promise<GrantRow | null>;
  /** The `pending` OR `accepted` grant for a pet, if any. At most one of each. */
  findOpenGrantsForPet(petId: string): Promise<GrantRow[]>;
  /**
   * Every OPEN grant this person is a party to, in EITHER role.
   *
   * THE ADDRESSEE PREDICATE LIVES IN THE REPOSITORY, ONCE, for the reason
   * `listTransfersForUser` records after paying for the alternative: the SQL half
   * decides which invitations a person is SHOWN and the application half decides
   * which they may ANSWER, and a drift between them is not symmetric. A widened
   * SQL shows somebody an invitation they cannot accept; a narrowed one hides a
   * live arrangement.
   *
   * `caretakerEmail` is matched only when `caretaker_user_id IS NULL`, which is
   * the same pair `accept-caretaker-grant.ts` and `getGrantForViewer` compare —
   * an id once the account resolved, an e-mail only while it has not. An EMPTY
   * `callerEmail` degrades to the id predicates alone, which is right: a session
   * with no address cannot be the addressee of an open invitation, and
   * `eq(col, "")` would match a row nobody can own.
   */
  listGrantsForUser(args: { userId: string; callerEmail: string }): Promise<UserGrantRow[]>;
  /**
   * The most recently ENDED arrangement on this pet, or null.
   *
   * `ended` only — not `rejected`/`cancelled`/`expired`. Those three never
   * became an arrangement, so there is no access to have lapsed and nothing for
   * the cockpit to explain.
   */
  findLastEndedGrantForPet(petId: string): Promise<EndedGrant | null>;
  findPetSummaryById(petId: string): Promise<PetSummary | null>;
  /**
   * Does `userId` still hold a LIVE, non-caretaker ownership row on this pet?
   *
   * The one ownership question this module asks. It exists because the port had
   * no ownership read at all, which made `acceptCaretakerGrant` STRUCTURALLY
   * incapable of noticing that the pet had changed hands since the invitation
   * was minted (H4): the invitee could accept onto a stranger's pet days after
   * a transfer, an adoption finalize, a decomiso or a resolved dispute.
   *
   * Non-caretaker on purpose — the same shape `requireTitularAccess` uses. A
   * caretaker must not be able to name a sub-caretaker, so a granter who has
   * since become a mere caretaker on the pet is no longer an authority for this.
   *
   * Takes the transaction: the answer is only worth having under the same lock
   * as the grant re-read. Outside it, a hand-off committing in between makes the
   * check a stale read of exactly the state it is meant to reject.
   */
  hasLiveTitularOwnership(petId: string, userId: string, tx: unknown): Promise<boolean>;
  findUserIdByEmail(email: string): Promise<string | null>;
  findDisplayName(userId: string): Promise<string | null>;
  findEmailByUserId(userId: string): Promise<string | null>;

  // --- cron scans ----------------------------------------------------------
  findExpirableInvitations(before: Date, limit?: number): Promise<GrantRow[]>;
  findExpirableGrants(now: Date, limit?: number): Promise<ExpirableGrant[]>;
  findGrantsNeedingReminder(now: Date, windowEnd: Date, limit?: number): Promise<GrantRow[]>;
  markReminderSent(grantId: string, now: Date): Promise<number>;

  // --- writes --------------------------------------------------------------
  insertGrant(args: InsertGrantArgs): Promise<{ id: string; publicToken: string }>;
  updateGrantStatus(args: UpdateGrantStatusArgs, tx?: unknown): Promise<number>;
  /**
   * ATOMIC. Writes the `ownerships(role='caretaker')` row, the
   * `caretaker_designated` event and the grant UPDATE inside ONE transaction.
   * A caretaker with access and no event is a hole in the spine; an event with
   * no access is a lie in it. Neither may exist alone.
   */
  insertAcceptGrant(args: AcceptGrantArgs, tx: unknown): Promise<{ ownershipId: string }>;
  /** ATOMIC. Closes the ownership row, emits `caretaker_ended`, ends the grant. */
  insertEndGrant(args: EndGrantArgs, tx: unknown): Promise<{ ended: boolean }>;
}
