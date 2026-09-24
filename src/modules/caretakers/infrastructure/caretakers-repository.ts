// CaretakersRepository — the Drizzle side of the caretakers module.
//
// Thin. No auth (that lives at the action edge), no business rules (those live
// in domain/), no notification bodies (those live in the use-cases). Every
// write method that participates in an invariant takes an explicit `tx` so the
// caller — not this file — decides the transaction boundary.
//
// Satisfies `CaretakersRepositoryPort` (application/ports.ts). The `satisfies`
// clause at the bottom is not decoration: it is what keeps a renamed method or
// a changed return shape from compiling while every use-case test still passes
// against a stale fake.
//
// EVERY METHOD NAME MUST EQUAL ITS PORT METHOD NAME. Not a style rule — a
// measured fence requirement, and the one non-obvious thing in this file.
// scripts/check-titular-gate.ts propagates "this function reaches a
// titular-only effect" along call edges matched BY NAME. The use-cases call
// `repo.insertAcceptGrant(...)`, the PORT's name. While this method was called
// `insertAcceptGrantForToken`, the fence indexed the effect on that name, found
// no caller of it anywhere, and the taint stopped dead at the repository — the
// whole accept chain was invisible to the fence, which nonetheless reported
// itself clean. Renaming the method to match the port restored the edge
// (verified: `acceptCaretakerGrant` appears in the effect index only with the
// matching name). The sibling modules get this right by accident, because they
// have no port indirection to diverge from.
// __tests__/check-titular-gate.test.ts pins it so a future rename cannot
// silently re-open the blind spot.

import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { attachments, db, ownerships, petCaretakerGrants, petEvents, pets, profiles } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { endCaretakerGrantAtomically } from "@/lib/infra/end-pet-ownerships";

import type {
  AcceptGrantArgs,
  CaretakersRepositoryPort,
  EndGrantArgs,
  EndedGrant,
  ExpirableGrant,
  GrantRow,
  InsertGrantArgs,
  PetSummary,
  UpdateGrantStatusArgs,
  UserGrantRow,
} from "../application/ports";
import type { GrantEndOutcome } from "../domain/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

/**
 * The unguessable `/cuidado/{token}` key.
 *
 * Prefix + 32 hex chars from the crypto RNG. Same shape and entropy budget as
 * the transfer token: the page it opens shows a pet's name, photo and the
 * titular's display name to an unauthenticated visitor holding the link.
 */
function newGrantToken(): string {
  return `CG-${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Narrow the Drizzle row down to the port's shape. Nothing else leaks out. */
function toGrantRow(row: typeof petCaretakerGrants.$inferSelect): GrantRow {
  return {
    id: row.id,
    publicToken: row.publicToken,
    petId: row.petId,
    grantedByUserId: row.grantedByUserId,
    caretakerUserId: row.caretakerUserId,
    caretakerEmail: row.caretakerEmail,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    note: row.note,
    ownershipId: row.ownershipId,
    reminderSentAt: row.reminderSentAt,
    publicContactConsentAt: row.publicContactConsentAt,
  };
}

const GRANT_SCAN_LIMIT = 500;

export const CaretakersRepository = {
  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async findGrantByToken(publicToken: string): Promise<GrantRow | null> {
    const [row] = await db
      .select()
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.publicToken, publicToken))
      .limit(1);
    return row ? toGrantRow(row) : null;
  },

  /**
   * Re-read under `SELECT ... FOR UPDATE`. The pre-transaction read every
   * use-case does is stale by construction — a concurrent accept, a titular
   * cancel and the expiry cron all race for the same row. The lock serialises
   * them; the loser sees the flipped status and aborts before writing.
   */
  async findGrantByIdForUpdate(grantId: string, tx: unknown): Promise<GrantRow | null> {
    const client = tx as Tx;
    const [row] = await client
      .select()
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.id, grantId))
      .limit(1)
      .for("update");
    return row ? toGrantRow(row) : null;
  },

  async findOpenGrantsForPet(petId: string): Promise<GrantRow[]> {
    const rows = await db
      .select()
      .from(petCaretakerGrants)
      .where(
        and(
          eq(petCaretakerGrants.petId, petId),
          sql`${petCaretakerGrants.status} IN ('pending','accepted')`,
        ),
      )
      .orderBy(desc(petCaretakerGrants.createdAt));
    return rows.map(toGrantRow);
  },

  /**
   * Every OPEN grant one person is a party to, in either role, joined to the
   * animal and to both display names.
   *
   * THE ADDRESSEE PREDICATE IS HERE AND NOWHERE ELSE (see the port's comment).
   * It is the same id-or-email pair the accept/reject writers apply and
   * `getGrantForViewer` resolves a relation with, expressed once in SQL so the
   * three cannot drift into disagreeing about who is shown what.
   *
   * `pending` and `accepted` only. The four terminal statuses are history and
   * history lives in the spine (`caretaker_designated` / `caretaker_ended`),
   * which the libreta already renders.
   */
  async listGrantsForUser(args: { userId: string; callerEmail: string }): Promise<UserGrantRow[]> {
    const granterProfiles = alias(profiles, "granter_profiles");
    const caretakerProfiles = alias(profiles, "caretaker_profiles");

    const email = args.callerEmail.trim().toLowerCase();
    const addressedToCaller =
      email.length > 0
        ? or(
            eq(petCaretakerGrants.caretakerUserId, args.userId),
            and(
              isNull(petCaretakerGrants.caretakerUserId),
              eq(petCaretakerGrants.caretakerEmail, email),
            ),
          )
        : eq(petCaretakerGrants.caretakerUserId, args.userId);

    const rows = await db
      .select({
        grant: petCaretakerGrants,
        petName: pets.name,
        petToken: pets.publicToken,
        petSpecies: pets.species,
        grantedByDisplayName: granterProfiles.displayName,
        caretakerDisplayName: caretakerProfiles.displayName,
      })
      .from(petCaretakerGrants)
      .innerJoin(pets, eq(pets.id, petCaretakerGrants.petId))
      .leftJoin(granterProfiles, eq(granterProfiles.id, petCaretakerGrants.grantedByUserId))
      .leftJoin(caretakerProfiles, eq(caretakerProfiles.id, petCaretakerGrants.caretakerUserId))
      .where(
        and(
          sql`${petCaretakerGrants.status} IN ('pending','accepted')`,
          or(eq(petCaretakerGrants.grantedByUserId, args.userId), addressedToCaller),
        ),
      )
      .orderBy(desc(petCaretakerGrants.createdAt));

    return rows.map((row) => ({
      grant: toGrantRow(row.grant),
      petName: row.petName,
      petToken: row.petToken,
      petSpecies: row.petSpecies,
      grantedByDisplayName: row.grantedByDisplayName,
      caretakerDisplayName: row.caretakerDisplayName,
    }));
  },

  /**
   * The last arrangement that actually ended on this pet.
   *
   * `status='ended'` only. `rejected`/`cancelled`/`expired` are invitation
   * outcomes: nobody ever had access, so there is nothing for the titular's
   * cockpit to explain the absence of.
   */
  async findLastEndedGrantForPet(petId: string): Promise<EndedGrant | null> {
    const [row] = await db
      .select({
        id: petCaretakerGrants.id,
        publicToken: petCaretakerGrants.publicToken,
        caretakerUserId: petCaretakerGrants.caretakerUserId,
        endsAt: petCaretakerGrants.endsAt,
        endedAt: petCaretakerGrants.endedAt,
        endedReason: petCaretakerGrants.endedReason,
      })
      .from(petCaretakerGrants)
      .where(
        and(
          eq(petCaretakerGrants.petId, petId),
          eq(petCaretakerGrants.status, "ended"),
          isNotNull(petCaretakerGrants.endedAt),
        ),
      )
      .orderBy(desc(petCaretakerGrants.endedAt))
      .limit(1);
    if (!row?.endedAt) return null;
    return {
      id: row.id,
      publicToken: row.publicToken,
      caretakerUserId: row.caretakerUserId,
      endsAt: row.endsAt,
      endedAt: row.endedAt,
      endedReason: (row.endedReason as GrantEndOutcome | null) ?? null,
    };
  },

  async findPetSummaryById(petId: string): Promise<PetSummary | null> {
    const [row] = await db
      .select({
        id: pets.id,
        publicToken: pets.publicToken,
        name: pets.name,
        // LEFT join: a pet with no photo is the common case, and an inner join
        // would make the invitation page 404 for it.
        primaryPhotoStoragePath: attachments.storagePath,
      })
      .from(pets)
      .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
      .where(eq(pets.id, petId))
      .limit(1);
    return row ? { ...row, primaryPhotoStoragePath: row.primaryPhotoStoragePath ?? null } : null;
  },

  /**
   * Is `userId` still a titular of this pet? Read under the caller's
   * transaction, so it is answered under the same lock as the grant re-read.
   *
   * `role <> 'caretaker'` mirrors `requireTitularAccess`: owner, co_owner,
   * foster and shelter_custody all count as holding the pet; a caretaker does
   * not, because a caretaker may not name a sub-caretaker.
   */
  async hasLiveTitularOwnership(petId: string, userId: string, tx: unknown): Promise<boolean> {
    const client = tx as Tx;
    const [row] = await client
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerUserId, userId),
          isNull(ownerships.endedAt),
          sql`${ownerships.role} <> 'caretaker'`,
        ),
      )
      .limit(1);
    return row !== undefined;
  },

  /**
   * Resolve an invitee's account id from their email.
   *
   * `profiles` HAS NO EMAIL COLUMN — emails live in `auth.users`, which Drizzle
   * cannot reach. This is the same admin-API lookup
   * `TransfersRepository.findUserIdByEmail` does, failure-swallowed for the
   * same reason: an unresolvable email is a legitimate outcome (the invitee has
   * no account yet), not an error the titular can act on.
   */
  async findUserIdByEmail(email: string): Promise<string | null> {
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const admin = createAdminClient();
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const match = list?.users.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());
      return match?.id ?? null;
    } catch {
      return null;
    }
  },

  async findDisplayName(userId: string): Promise<string | null> {
    const [row] = await db
      .select({ displayName: profiles.displayName, deletedAt: profiles.deletedAt })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    // An erased profile keeps its row with a redacted display name. Returning
    // it would put a sentinel into a notification title; the caller's fallback
    // copy is the better answer.
    if (!row || row.deletedAt) return null;
    return row.displayName ?? null;
  },

  /** Also an auth.users read — see findUserIdByEmail. */
  async findEmailByUserId(userId: string): Promise<string | null> {
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const admin = createAdminClient();
      const { data } = await admin.auth.admin.getUserById(userId);
      return data?.user?.email ?? null;
    } catch {
      return null;
    }
  },

  // -------------------------------------------------------------------------
  // Cron scans — all bounded, all keyed on the (status, ends_at) index
  // -------------------------------------------------------------------------

  /** `pending` invitations created before `before` (the 7-day window). */
  async findExpirableInvitations(before: Date, limit = GRANT_SCAN_LIMIT): Promise<GrantRow[]> {
    const rows = await db
      .select()
      .from(petCaretakerGrants)
      .where(
        and(eq(petCaretakerGrants.status, "pending"), lte(petCaretakerGrants.createdAt, before)),
      )
      .orderBy(asc(petCaretakerGrants.createdAt))
      .limit(limit);
    return rows.map(toGrantRow);
  },

  /** `accepted` grants whose `ends_at` has passed. */
  async findExpirableGrants(now: Date, limit = GRANT_SCAN_LIMIT): Promise<ExpirableGrant[]> {
    const rows = await db
      .select()
      .from(petCaretakerGrants)
      .where(and(eq(petCaretakerGrants.status, "accepted"), lte(petCaretakerGrants.endsAt, now)))
      .orderBy(asc(petCaretakerGrants.endsAt))
      .limit(limit);
    return rows.map(toGrantRow).filter((r): r is ExpirableGrant => r.ownershipId !== null);
  },

  /**
   * `accepted` grants inside the reminder window that have not been reminded.
   *
   * The `reminder_sent_at IS NULL` predicate is the witness, not a date
   * computation: "fires exactly once" cannot be derived from today's date when
   * the daily dispatcher can legitimately be re-run at 04:05.
   */
  async findGrantsNeedingReminder(
    now: Date,
    windowEnd: Date,
    limit = GRANT_SCAN_LIMIT,
  ): Promise<GrantRow[]> {
    const rows = await db
      .select()
      .from(petCaretakerGrants)
      .where(
        and(
          eq(petCaretakerGrants.status, "accepted"),
          isNull(petCaretakerGrants.reminderSentAt),
          // `gt`, NOT a raw `sql` template with the Date interpolated.
          //
          // This line was `sql\`${petCaretakerGrants.endsAt} > ${now}\`` and it
          // failed EVERY NIGHT from at least 2026-09-02 to 2026-09-09. A raw
          // `sql` template binds an interpolated value as a plain parameter
          // WITHOUT the column's type mapper, so the Date went to Postgres as
          // `String(date)` — "Wed Sep 09 2026 04:28:53 GMT+0000 (Coordinated
          // Universal Time)" — which is not valid `timestamptz` input. The
          // sibling bound on the very next line used the typed operator and so
          // sent a clean ISO string; the two spellings sat next to each other
          // and only one of them worked.
          //
          // The unit suite could not see it: `expire-caretaker-grants.test.ts`
          // drives a fake repository, so no test ever asked Postgres to parse
          // these parameters. What caught it was the cron alert channel.
          gt(petCaretakerGrants.endsAt, now),
          lte(petCaretakerGrants.endsAt, windowEnd),
        ),
      )
      .orderBy(asc(petCaretakerGrants.endsAt))
      .limit(limit);
    return rows.map(toGrantRow);
  },

  /** Stamps the witness. Guarded on it still being NULL so a re-run is a no-op. */
  async markReminderSent(grantId: string, now: Date): Promise<number> {
    const result = await db
      .update(petCaretakerGrants)
      .set({ reminderSentAt: now, updatedAt: now })
      .where(and(eq(petCaretakerGrants.id, grantId), isNull(petCaretakerGrants.reminderSentAt)))
      .returning({ id: petCaretakerGrants.id });
    return result.length;
  },

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async insertGrant(args: InsertGrantArgs): Promise<{ id: string; publicToken: string }> {
    const [row] = await db
      .insert(petCaretakerGrants)
      .values({
        publicToken: newGrantToken(),
        petId: args.petId,
        grantedByUserId: args.grantedByUserId,
        // Recorded at DESIGNATION when the invitee already has an account. The
        // accept CHECK permits it while `ownership_id` is still NULL (0192), and
        // it is what lets a cancellation notify the right person instead of
        // silently reaching nobody.
        caretakerUserId: args.caretakerUserId,
        caretakerEmail: args.caretakerEmail,
        status: "pending",
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        note: args.note,
        createdAt: args.now,
        updatedAt: args.now,
        createdBy: args.grantedByUserId,
        updatedBy: args.grantedByUserId,
      })
      .returning({ id: petCaretakerGrants.id, publicToken: petCaretakerGrants.publicToken });
    return row;
  },

  async updateGrantStatus(args: UpdateGrantStatusArgs, tx?: unknown): Promise<number> {
    const client: DbOrTx = (tx as Tx) ?? db;
    const result = await (client as typeof db)
      .update(petCaretakerGrants)
      .set({
        status: args.status,
        respondedAt: args.respondedAt,
        updatedAt: args.now,
      })
      .where(
        and(
          eq(petCaretakerGrants.id, args.grantId),
          eq(petCaretakerGrants.status, args.expectedStatus),
        ),
      )
      .returning({ id: petCaretakerGrants.id });
    return result.length;
  },

  /**
   * THE ATOMIC ACCEPT. Ownership row → event → grant flip, in this order,
   * inside the caller's transaction.
   *
   * ORDER IS FORCED, not stylistic: the grant's biconditional accept CHECK
   * (`status='accepted'` ⇔ `caretaker_user_id AND ownership_id both set`) means
   * the flip cannot happen before the ownership row exists to point at.
   *
   * THE NAME MUST MATCH THE PORT METHOD — measured, not stylistic. See the
   * "titular gate" note in the file header.
   *
   * WHY IT IS NOT AN INNER WRITER. `caretaker_designated` is a member of
   * TITULAR_ONLY_EVENT_TYPES (a caretaker must never designate a
   * sub-caretaker), so this is the one writer of a titular-only event that is
   * not performed by the titular. It is legitimate because the actor holds NO
   * ownership row on this pet at all — that is what "invitee" means — so the
   * role the deny-list exists to stop cannot be the one acting; the authority
   * is the grant token, which only `requireTitularAccess` could have minted.
   * It would have been easy to spell that as a `...ForToken` suffix and let
   * `isInnerWriter` wave it through. It is NOT spelled that way on purpose: the
   * fence does not currently flag this writer (measured — see the header), so a
   * suffix would pre-exempt an offense that does not exist and silently blind
   * the fence to a future one.
   */
  async insertAcceptGrant(args: AcceptGrantArgs, tx: unknown): Promise<{ ownershipId: string }> {
    const client = tx as Tx;

    const [ownership] = await client
      .insert(ownerships)
      .values({
        petId: args.petId,
        ownerUserId: args.caretakerUserId,
        role: "caretaker",
        startedAt: args.now,
      })
      .returning({ id: ownerships.id });

    const payload = validateEventPayload("caretaker_designated", {
      payload_version: 1,
      grant_id: args.grantId,
      grant_public_token: args.grantPublicToken,
      caretaker_user_id: args.caretakerUserId,
      ends_at: args.endsAt.toISOString(),
      note: args.note,
    });

    await client.insert(petEvents).values({
      petId: args.petId,
      eventType: "caretaker_designated",
      occurredAt: args.now,
      recordedAt: args.now,
      recordedByUserId: args.caretakerUserId,
      authorRole: "owner",
      authorVerified: false,
      payload,
    });

    const flipped = await client
      .update(petCaretakerGrants)
      .set({
        status: "accepted",
        caretakerUserId: args.caretakerUserId,
        ownershipId: ownership.id,
        respondedAt: args.now,
        // KEY 2, captured in the SAME statement as the flip. The CHECK forbids
        // a consent timestamp on a `pending` row, so there is no second UPDATE
        // that could do this afterwards without passing through an illegal
        // intermediate state.
        publicContactConsentAt: args.publicContactConsent ? args.now : null,
        updatedAt: args.now,
        updatedBy: args.caretakerUserId,
      })
      .where(and(eq(petCaretakerGrants.id, args.grantId), eq(petCaretakerGrants.status, "pending")))
      .returning({ id: petCaretakerGrants.id });

    if (flipped.length === 0) {
      // Aborts the whole transaction — the ownership row and the event above
      // go with it. Reachable when a concurrent writer resolved the invitation
      // between the FOR UPDATE read and here.
      throw new Error("La invitación ya fue resuelta por otra acción.");
    }

    return { ownershipId: ownership.id };
  },

  /**
   * THE ATOMIC END. Close the ownership row → emit `caretaker_ended` → flip the
   * grant, inside the caller's transaction.
   *
   * The three steps now live in lib/infra/end-pet-ownerships.ts and this
   * delegates to them. They moved because adoption finalize and decomiso also
   * have to end a live grant, and doing only step one there left a zombie:
   * a grant reading 'accepted' against a closed row, drift the spine cannot
   * explain, and a stranger's contact still published on the new owner's public
   * credential. Importing this module from `adoption` was not an option — the
   * caretakers module is built with ZERO cross-module edges by design — and a
   * second copy of a three-step invariant is the drift this repo keeps paying
   * for. So the primitive sits below both and there is exactly one of it.
   *
   * `caretaker_ended` is deliberately NOT a titular-only event type: the cron
   * writes it with no acting user, and a caretaker withdrawing from their own
   * arrangement is legitimate. Only the DESIGNATION is titular-only.
   */
  async insertEndGrant(args: EndGrantArgs, tx: unknown): Promise<{ ended: boolean }> {
    return endCaretakerGrantAtomically(
      {
        grantId: args.grantId,
        ownershipId: args.ownershipId,
        petId: args.petId,
        outcome: args.outcome,
        endsAt: args.endsAt,
        now: args.now,
        actorUserId: args.actorUserId,
      },
      tx as Tx,
    );
  },
} satisfies CaretakersRepositoryPort;
