// Custody hand-offs racing each other, against a real database (audit K).
//
// THE PROPERTY
// ---------------------------------------------------------------------------
// K1: a pet has exactly one holder, and a hand-off acts on the holder that is
// there WHEN IT WRITES — never on the one it read a moment earlier. Every
// custody writer serialises on one key, `pg_advisory_xact_lock(hashtext(petId))`,
// taken as the first statement of its transaction; every check that decides a
// custody write is re-read under it.
//
// WHY TWO CONNECTIONS AND NOT A SOURCE PIN
// ---------------------------------------------------------------------------
// A source pin proves the call is written; it cannot prove the call is FIRST in
// the sense that matters — that no read deciding the write escapes the lock.
// Each race here is real: a second connection takes the pet lock, the use-case
// under test is started and must be seen WAITING on that lock in `pg_locks`,
// the competing hand-off then commits under the held lock, and only then does
// the use-case run. A use-case that read before locking finishes (or blocks on
// a row) before anyone waits on the advisory lock, and the wait assertion
// fails — so the harness cannot pass vacuously.
//
// The holder runs on its OWN small client, not the app pool: the test pool is
// `max: 3`, and a use-case blocked inside its transaction plus the holder plus
// the `pg_locks` poller would exhaust it.

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import {
  db,
  notifications,
  organizations,
  ownerships,
  petCaretakerGrants,
  petEvents,
  petTransfers,
  pets,
  profiles,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { hashDni } from "@/lib/utils/dni-hash";
import { DEFAULT_LOCAL_URL } from "@/scripts/_db-target";
import { reverseAdoption } from "@/src/modules/adoption/application/reverse-adoption";
import {
  ADOPTER_NO_LONGER_HOLDS_ERROR,
  ReversalRefused,
} from "@/src/modules/adoption/domain/reversal-rules";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";
import { acceptCaretakerGrant } from "@/src/modules/caretakers/application/accept-caretaker-grant";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";
import { acceptPetTransfer } from "@/src/modules/transfers/application/accept-pet-transfer";
import { TransfersRepository } from "@/src/modules/transfers/infrastructure/transfers-repository";

import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const holder = postgres(process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL, {
  max: 2,
  connect_timeout: 5,
});

type HolderTx = postgres.TransactionSql;

const transaction = db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;

/** Is some backend WAITING (not holding) the pet's advisory lock right now? */
async function someoneWaitsOnPetLock(petId: string): Promise<boolean> {
  // A bigint advisory key lands in pg_locks split in two: classid = high 32
  // bits, objid = low 32 bits, objsubid = 1. hashtext() is an int4, so the low
  // half alone identifies it.
  const rows = await holder<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM pg_locks
     WHERE locktype = 'advisory'
       AND NOT granted
       AND objsubid = 1
       AND objid = ((hashtext(${petId})::bigint) & 4294967295)::oid
  `;
  return rows[0].n > 0;
}

/**
 * Hold the pet lock on another connection, start `racer`, require it to be
 * seen waiting on that lock, run `handoff` under the held lock, commit, and
 * hand back what the racer returned.
 */
async function raceUnderHeldPetLock<T>(
  petId: string,
  racer: () => Promise<T>,
  handoff: (h: HolderTx) => Promise<void>,
): Promise<T> {
  let racing: Promise<T> | null = null;
  try {
    await holder.begin(async (h) => {
      await h`SELECT pg_advisory_xact_lock(hashtext(${petId}))`;
      racing = racer();
      // Never let a rejection float unobserved while we wait on pg_locks.
      racing.catch(() => undefined);
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (Date.now() < deadline) {
        if (await someoneWaitsOnPetLock(petId)) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!waiting) {
        throw new Error(
          "the use-case never waited on the pet advisory lock — it read (or wrote) before taking it",
        );
      }
      await handoff(h);
    });
  } catch (err) {
    if (racing) await Promise.allSettled([racing]);
    throw err;
  }
  if (!racing) throw new Error("racer was never started");
  return racing;
}

// ---------------------------------------------------------------------------
// Fixtures (every row is test-owned; torn down in afterAll)
// ---------------------------------------------------------------------------

const createdPetIds: string[] = [];
const createdOrgIds: string[] = [];
const createdProfileIds: string[] = [];

function randomDni(): string {
  return `${Math.floor(Math.random() * 90000000 + 10000000)}`;
}

function uniqueToken(prefix: string): string {
  return `DIM-${prefix}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

async function makeProfile(label: string): Promise<string> {
  const id = randomUUID();
  await db.insert(profiles).values({
    id,
    displayName: `CHPL ${label}`,
    dniHash: hashDni(randomDni()),
    dniVerified: true,
    role: "owner",
  });
  createdProfileIds.push(id);
  return id;
}

async function makeOrg(): Promise<string> {
  const token = uniqueToken("CHPLORG");
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: token,
      legalName: `CHPL Refugio ${token}`,
      displayName: `CHPL Refugio ${token}`,
      orgType: "shelter",
      email: `${token.toLowerCase()}@dim-test.local`,
      verified: true,
    })
    .returning({ id: organizations.id });
  createdOrgIds.push(org.id);
  return org.id;
}

async function makePet(label: string): Promise<{ id: string; publicToken: string }> {
  const publicToken = uniqueToken("CHPL");
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken,
      name: `Chpl${label}`,
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      status: "active",
    })
    .returning({ id: pets.id, publicToken: pets.publicToken });
  createdPetIds.push(pet.id);
  return pet;
}

async function liveHolders(petId: string) {
  return db
    .select({
      id: ownerships.id,
      role: ownerships.role,
      ownerUserId: ownerships.ownerUserId,
      ownerOrganizationId: ownerships.ownerOrganizationId,
    })
    .from(ownerships)
    .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
}

async function eventTypes(petId: string): Promise<string[]> {
  const rows = await db
    .select({ eventType: petEvents.eventType })
    .from(petEvents)
    .where(eq(petEvents.petId, petId));
  return rows.map((r) => r.eventType);
}

/** A P2P hand-off committed by someone else: the old owner row closes, a new one opens. */
async function handOffTo(
  h: HolderTx,
  petId: string,
  fromOwnershipId: string,
  toUserId: string,
): Promise<{ endedAt: Date }> {
  const [closed] = await h<{ ended_at: Date }[]>`
    UPDATE ownerships SET ended_at = now()
     WHERE id = ${fromOwnershipId} AND ended_at IS NULL
     RETURNING ended_at
  `;
  await h`
    INSERT INTO ownerships (pet_id, owner_user_id, role, started_at)
    VALUES (${petId}, ${toUserId}, 'owner', now())
  `;
  return { endedAt: closed.ended_at };
}

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const id of createdPetIds) {
      await tx.delete(petCaretakerGrants).where(eq(petCaretakerGrants.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
    for (const id of createdOrgIds) await tx.delete(organizations).where(eq(organizations.id, id));
    for (const id of createdProfileIds) {
      await tx.delete(notifications).where(eq(notifications.userId, id));
      await tx.delete(ownerships).where(eq(ownerships.ownerUserId, id));
      await tx.delete(profiles).where(eq(profiles.id, id));
    }
  });
  await holder.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// W1 — adoption reversal vs a hand-off that commits after its gate
// ---------------------------------------------------------------------------

/** A pet a refugio gave in adoption: the adopter's live owner row + the finalize fact. */
async function adoptedPet(label: string) {
  const orgId = await makeOrg();
  const coordinatorId = await makeProfile(`${label} coordinador`);
  const adopterId = await makeProfile(`${label} adoptante`);
  const pet = await makePet(label);
  const [adopterRow] = await db
    .insert(ownerships)
    .values({ petId: pet.id, ownerUserId: adopterId, role: "owner" })
    .returning({ id: ownerships.id });
  const now = new Date();
  await db.insert(petEvents).values({
    petId: pet.id,
    eventType: "adoption_finalized",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: coordinatorId,
    authorRole: "shelter",
    authorOrganizationId: orgId,
    payload: validateEventPayload("adoption_finalized", {
      previous_owner_organization_id: orgId,
      adopter_user_id: adopterId,
      foster_user_id: null,
      contract_attachment_id: null,
      post_adoption_followup_months: null,
      notes: null,
    }),
  });
  const actor = {
    user: { id: coordinatorId },
    organization: {
      id: orgId,
      publicToken: "unused",
      verified: true,
      displayName: "CHPL Refugio",
    },
  };
  return { orgId, adopterId, pet, adopterOwnershipId: adopterRow.id, actor };
}

describe("W1 — an adoption reversal acts on the holder under the pet lock", () => {
  it("control: with nobody racing, the reversal returns custody to the org", async () => {
    const f = await adoptedPet("RevOk");
    const result = await reverseAdoption(
      { petPublicToken: f.pet.publicToken, reason: null },
      { repo: AdoptionRepository, actor: f.actor, transaction },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const live = await liveHolders(f.pet.id);
    expect(live.map((r) => r.role)).toEqual(["shelter_custody"]);
    expect(live[0].ownerOrganizationId).toBe(f.orgId);
  });

  it("a P2P hand-off committing after the gate wins: the reversal refuses and the new owner keeps the pet", async () => {
    const f = await adoptedPet("RevRace");
    const newOwnerId = await makeProfile("RevRace nuevo dueño");

    let handoffEndedAt: Date | null = null;
    const result = await raceUnderHeldPetLock(
      f.pet.id,
      () =>
        reverseAdoption(
          { petPublicToken: f.pet.publicToken, reason: "Carrera contra una transferencia" },
          { repo: AdoptionRepository, actor: f.actor, transaction },
        ),
      async (h) => {
        ({ endedAt: handoffEndedAt } = await handOffTo(
          h,
          f.pet.id,
          f.adopterOwnershipId,
          newOwnerId,
        ));
      },
    );

    expect(result).toEqual({ ok: false, error: ADOPTER_NO_LONGER_HOLDS_ERROR });
    const live = await liveHolders(f.pet.id);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ role: "owner", ownerUserId: newOwnerId });
    // The closed adopter row keeps the instant the hand-off gave it — history
    // is not rewritten by a reversal that lost.
    const [adopterRow] = await db
      .select({ endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(eq(ownerships.id, f.adopterOwnershipId));
    expect(adopterRow.endedAt?.getTime()).toBe((handoffEndedAt as Date | null)?.getTime());
    expect(await eventTypes(f.pet.id)).not.toContain("adoption_reversed");
  });

  it("the write itself refuses an adopter row that is already closed — ended_at is never rewritten", async () => {
    const f = await adoptedPet("RevGuard");
    const closedAt = new Date(Date.now() - 60_000);
    await db
      .update(ownerships)
      .set({ endedAt: closedAt })
      .where(eq(ownerships.id, f.adopterOwnershipId));
    const finalize = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, f.pet.id), eq(petEvents.eventType, "adoption_finalized")));

    await expect(
      db.transaction(async (tx) => {
        await AdoptionRepository.insertAdoptionReversed(
          {
            petId: f.pet.id,
            userId: f.actor.user.id,
            orgId: f.orgId,
            orgVerified: true,
            adopterOwnershipId: f.adopterOwnershipId,
            finalizeEventId: finalize[0].id,
            reason: null,
            now: new Date(),
          },
          tx,
        );
      }),
    ).rejects.toBeInstanceOf(ReversalRefused);

    const [row] = await db
      .select({ endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(eq(ownerships.id, f.adopterOwnershipId));
    expect(row.endedAt?.getTime()).toBe(closedAt.getTime());
    expect(await liveHolders(f.pet.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// W3 — a caretaker invitation accepted while the pet changes hands
// ---------------------------------------------------------------------------

describe("W3 — accepting a caretaker invitation serialises with the hand-off", () => {
  async function invitedPet(label: string) {
    const titularId = await makeProfile(`${label} titular`);
    const inviteeId = await makeProfile(`${label} invitado`);
    const pet = await makePet(label);
    const [ownerRow] = await db
      .insert(ownerships)
      .values({ petId: pet.id, ownerUserId: titularId, role: "owner" })
      .returning({ id: ownerships.id });
    const grantToken = `CG-chpl-${randomUUID().slice(0, 8)}`;
    await db.insert(petCaretakerGrants).values({
      publicToken: grantToken,
      petId: pet.id,
      grantedByUserId: titularId,
      caretakerUserId: inviteeId,
      caretakerEmail: `chpl-${label.toLowerCase()}@dim-test.local`,
      status: "pending",
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const accept = () =>
      acceptCaretakerGrant(
        {
          grantPublicToken: grantToken,
          callerUserId: inviteeId,
          callerEmail: `chpl-${label.toLowerCase()}@dim-test.local`,
          callerEmailConfirmed: true,
        },
        { repo: CaretakersRepository, now: () => new Date(), transaction },
      );
    return { titularId, inviteeId, pet, ownerRowId: ownerRow.id, accept };
  }

  it("control: with nobody racing, the invitee becomes the caretaker", async () => {
    const f = await invitedPet("CareOk");
    const result = await f.accept();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const roles = (await liveHolders(f.pet.id)).map((r) => r.role).sort();
    expect(roles).toEqual(["caretaker", "owner"]);
  });

  it("a hand-off committing first wins: the invitee is refused and holds nothing on the new owner's pet", async () => {
    const f = await invitedPet("CareRace");
    const newOwnerId = await makeProfile("CareRace nuevo dueño");

    const result = await raceUnderHeldPetLock(f.pet.id, f.accept, async (h) => {
      await handOffTo(h, f.pet.id, f.ownerRowId, newOwnerId);
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ya no es titular/);
    const live = await liveHolders(f.pet.id);
    expect(live).toEqual([expect.objectContaining({ role: "owner", ownerUserId: newOwnerId })]);
    expect(await eventTypes(f.pet.id)).not.toContain("caretaker_designated");
  });
});

// ---------------------------------------------------------------------------
// W4 — a P2P accept reads the pet's guards under the pet lock
// ---------------------------------------------------------------------------

/** A pet its owner has offered to a registered recipient: a pending P2P transfer. */
async function offeredPet(label: string) {
  const senderId = await makeProfile(`${label} emisor`);
  const recipientId = await makeProfile(`${label} receptor`);
  const pet = await makePet(label);
  const [senderRow] = await db
    .insert(ownerships)
    .values({ petId: pet.id, ownerUserId: senderId, role: "owner" })
    .returning({ id: ownerships.id });
  const transferToken = `PTR-chpl-${randomUUID().slice(0, 10)}`;
  const recipientEmail = `chpl-${label.toLowerCase()}-${randomUUID().slice(0, 6)}@dim-test.local`;
  await db.insert(petTransfers).values({
    publicToken: transferToken,
    petId: pet.id,
    fromOwnerId: senderId,
    toOwnerId: recipientId,
    toOwnerEmail: recipientEmail,
    status: "pending",
    reason: "gift",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  const accept = () =>
    acceptPetTransfer(
      { transferToken, callerEmail: recipientEmail, callerEmailConfirmed: true },
      { repo: TransfersRepository, actor: { user: { id: recipientId } }, transaction },
    );
  return { senderId, recipientId, pet, senderRowId: senderRow.id, transferToken, accept };
}

describe("W4 — a P2P accept decides on guards read under the pet lock", () => {
  it("control: with nobody racing, the recipient becomes the owner", async () => {
    const f = await offeredPet("P2pOk");
    const result = await f.accept();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await liveHolders(f.pet.id)).toEqual([
      expect.objectContaining({ role: "owner", ownerUserId: f.recipientId }),
    ]);
  });

  it("a custody dispute opening first wins: the accept refuses and the sender keeps the pet", async () => {
    const f = await offeredPet("P2pRace");

    const result = await raceUnderHeldPetLock(f.pet.id, f.accept, async (h) => {
      await h`UPDATE pets SET in_custody_dispute = true, updated_at = now() WHERE id = ${f.pet.id}`;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/disputa de custodia/);
    expect(await liveHolders(f.pet.id)).toEqual([
      expect.objectContaining({ id: f.senderRowId, role: "owner", ownerUserId: f.senderId }),
    ]);
    const [transferRow] = await db
      .select({ status: petTransfers.status })
      .from(petTransfers)
      .where(eq(petTransfers.publicToken, f.transferToken));
    expect(transferRow.status).toBe("pending");
    expect(await eventTypes(f.pet.id)).not.toContain("custody_transferred");
  });
});

// ---------------------------------------------------------------------------
// W5 — a P2P accept racing the sender's erasure (art. 16)
// ---------------------------------------------------------------------------
//
// `erase_subject_data` (0245) takes no pet lock, so this race is not decided
// by the advisory key: the holder below replays the RPC's own statement ORDER
// on the rows it would touch — the subject's profile first, then the owned
// pets' soft-delete — and the accept is started while that erasure is still
// open. The use-case must be seen blocked on the sender's profile row, and
// once the erasure commits (its pending-transfer cancel matching nothing, as
// it did in the bug) the accept must refuse. Without the share lock the
// accept ran straight through: the recipient got an owner row on a pet the
// erasure had already soft-deleted.
//
// The SQL-side half — the RPC soft-deleting pets before it cancels transfers,
// and taking no pet lock — is a migration, and is left as a follow-up.

/** Is some backend blocked on a row lock while reading `profiles` FOR SHARE? */
async function someoneWaitsOnProfileShare(): Promise<boolean> {
  const rows = await holder<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM pg_stat_activity
     WHERE wait_event_type = 'Lock'
       AND query ILIKE '%from "profiles"%for share%'
  `;
  return rows[0].n > 0;
}

describe("W5 — a P2P accept does not hand over a pet its sender's erasure is deleting", () => {
  it("an erasure under way wins: the accept waits for it, then refuses, and the recipient holds nothing", async () => {
    const f = await offeredPet("P2pErase");

    let racing: ReturnType<typeof f.accept> | null = null;
    await holder.begin(async (h) => {
      // erase_subject_data's first write, then its owned-pets soft-delete.
      await h`UPDATE profiles SET deleted_at = now(), updated_at = now() WHERE id = ${f.senderId}`;
      await h`UPDATE pets SET deleted_at = now(), updated_at = now() WHERE id = ${f.pet.id}`;

      racing = f.accept();
      racing.catch(() => undefined);
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (Date.now() < deadline) {
        if (await someoneWaitsOnProfileShare()) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!waiting) {
        throw new Error(
          "the accept never blocked on the sender's profile — it ran past the erasure",
        );
      }
      // The pending-transfer cancel, last — as the RPC orders it.
      await h`UPDATE pet_transfers SET status = 'cancelled', updated_at = now()
               WHERE public_token = ${f.transferToken} AND status = 'pending'`;
    });
    if (!racing) throw new Error("accept was never started");
    const result = await (racing as ReturnType<typeof f.accept>);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/dada de baja/);
    const recipientRows = (await liveHolders(f.pet.id)).filter(
      (r) => r.ownerUserId === f.recipientId,
    );
    expect(recipientRows).toEqual([]);
    expect(await eventTypes(f.pet.id)).not.toContain("custody_transferred");
  });

  it("a pet already soft-deleted before the accept is refused on the pet guard", async () => {
    const f = await offeredPet("P2pGone");
    await db.update(pets).set({ deletedAt: new Date() }).where(eq(pets.id, f.pet.id));
    const result = await f.accept();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ya no existe/);
  });
});
