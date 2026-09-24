// The accept transaction, against a real database.
//
// WHY THIS CANNOT BE A UNIT TEST
// ---------------------------------------------------------------------------
// `acceptCaretakerGrant`'s unit tests prove the use-case puts both writes
// inside one `transaction()` call and aborts on failure. They cannot prove the
// only thing that actually matters: that a failure MID-transaction leaves
// NEITHER the `caretaker_designated` event NOR the `ownerships(role=caretaker)`
// row behind. A fake transaction has nothing to roll back.
//
// The two failure modes this rules out are not symmetric, and both are
// unrecoverable by a retry:
//   - event without ownership row → the spine says an arrangement started and
//     the caretaker has no access. The log is right and the world is wrong.
//   - ownership row without event → the caretaker CAN write to a pet and
//     nothing in the append-only log explains why. That is invariant #2
//     violated from the other direction, and no later event can undo it,
//     because corrections are new events, not deletions.
//
// Also proven here, because they are database facts and not code facts: the two
// partial unique indexes, the biconditional accept CHECK, the caretaker
// ownership uniqueness index, and the consent CHECK.
//
// Requires: local Supabase stack + migrations 0189/0190/0191 applied.

import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petCaretakerGrants, petEvents, pets, profiles } from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";

import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-CATX-0001";
const TITULAR_ID = "0cae7a12-2222-4000-8000-000000000001";
const CARETAKER_ID = "0cae7a12-2222-4000-8000-000000000002";
const OTHER_ID = "0cae7a12-2222-4000-8000-000000000003";

let petId: string;

const NOW = new Date("2026-08-21T10:00:00.000Z");
const ENDS_AT = new Date("2026-09-15T00:00:00.000Z");

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM pet_caretaker_grants WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM pet_events WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
    );
  });
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await db.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  await db.execute(
    sql`DELETE FROM profiles WHERE id IN (${TITULAR_ID}::uuid, ${CARETAKER_ID}::uuid, ${OTHER_ID}::uuid)`,
  );
}

async function seedPendingGrant(): Promise<{ id: string; publicToken: string }> {
  return CaretakersRepository.insertGrant({
    petId,
    grantedByUserId: TITULAR_ID,
    caretakerUserId: null,
    caretakerEmail: "ana@example.com",
    startsAt: NOW,
    endsAt: ENDS_AT,
    note: "Me voy de viaje",
    now: NOW,
  });
}

async function countCaretakerRows(): Promise<number> {
  const rows = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(and(eq(ownerships.petId, petId), eq(ownerships.role, "caretaker")));
  return rows.length;
}

async function countDesignatedEvents(): Promise<number> {
  const rows = await db
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "caretaker_designated")));
  return rows.length;
}

beforeAll(async () => {
  await cleanup();
  await db.insert(profiles).values([
    { id: TITULAR_ID, displayName: "Titular Atomic", role: "owner" },
    { id: CARETAKER_ID, displayName: "Cuidadora Atomic", role: "owner" },
    { id: OTHER_ID, displayName: "Otra Persona", role: "owner" },
  ]);
  const [pet] = await db
    .insert(pets)
    .values({ publicToken: PET_TOKEN, name: "Pampa Atomic", species: "dog" })
    .returning({ id: pets.id });
  petId = pet.id;
  await db.insert(ownerships).values({ petId, ownerUserId: TITULAR_ID, role: "owner" });
});

afterEach(async () => {
  await db.execute(sql`DELETE FROM pet_caretaker_grants WHERE pet_id = ${petId}::uuid`);
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}::uuid`);
  });
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id = ${petId}::uuid AND role = 'caretaker'`,
  );
});

afterAll(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------
// The happy path, so the failure paths below mean something
// ---------------------------------------------------------------------------

describe("insertAcceptGrant — the committed shape", () => {
  it("writes the ownership row, the event and the grant flip together", async () => {
    const grant = await seedPendingGrant();

    const { ownershipId } = await db.transaction((tx) =>
      CaretakersRepository.insertAcceptGrant(
        {
          grantId: grant.id,
          petId,
          caretakerUserId: CARETAKER_ID,
          grantPublicToken: grant.publicToken,
          endsAt: ENDS_AT,
          note: "Me voy de viaje",
          publicContactConsent: false,
          now: NOW,
        },
        tx,
      ),
    );

    const [row] = await db
      .select()
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.id, grant.id));
    expect(row.status).toBe("accepted");
    expect(row.caretakerUserId).toBe(CARETAKER_ID);
    expect(row.ownershipId).toBe(ownershipId);
    expect(row.publicContactConsentAt).toBeNull();

    const [ownership] = await db.select().from(ownerships).where(eq(ownerships.id, ownershipId));
    expect(ownership.role).toBe("caretaker");
    expect(ownership.ownerUserId).toBe(CARETAKER_ID);
    expect(ownership.endedAt).toBeNull();

    const [event] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "caretaker_designated")));
    expect(event.payload).toMatchObject({
      grant_id: grant.id,
      grant_public_token: grant.publicToken,
      caretaker_user_id: CARETAKER_ID,
      ends_at: ENDS_AT.toISOString(),
    });
  });

  it("stamps the consent timestamp in the same statement when the caretaker consented", async () => {
    const grant = await seedPendingGrant();

    await db.transaction((tx) =>
      CaretakersRepository.insertAcceptGrant(
        {
          grantId: grant.id,
          petId,
          caretakerUserId: CARETAKER_ID,
          grantPublicToken: grant.publicToken,
          endsAt: ENDS_AT,
          note: null,
          publicContactConsent: true,
          now: NOW,
        },
        tx,
      ),
    );

    const [row] = await db
      .select()
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.id, grant.id));
    expect(row.publicContactConsentAt).toEqual(NOW);
  });
});

// ---------------------------------------------------------------------------
// THE TEST THIS FILE EXISTS FOR
// ---------------------------------------------------------------------------

describe("insertAcceptGrant — a mid-transaction failure leaves NOTHING", () => {
  it("rolls back the ownership row AND the event when the caller aborts after them", async () => {
    const grant = await seedPendingGrant();

    // The failure is injected AFTER insertAcceptGrant has written all three
    // rows and BEFORE the transaction commits — the exact window in which a
    // non-atomic implementation would already have leaked the ownership row.
    await expect(
      db.transaction(async (tx) => {
        await CaretakersRepository.insertAcceptGrant(
          {
            grantId: grant.id,
            petId,
            caretakerUserId: CARETAKER_ID,
            grantPublicToken: grant.publicToken,
            endsAt: ENDS_AT,
            note: null,
            publicContactConsent: true,
            now: NOW,
          },
          tx,
        );
        throw new Error("forced mid-transaction failure");
      }),
    ).rejects.toThrow("forced mid-transaction failure");

    expect(await countCaretakerRows()).toBe(0);
    expect(await countDesignatedEvents()).toBe(0);

    const [row] = await db
      .select()
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.id, grant.id));
    expect(row.status).toBe("pending");
    expect(row.caretakerUserId).toBeNull();
    expect(row.ownershipId).toBeNull();
    expect(row.publicContactConsentAt).toBeNull();
  });

  it("rolls back the ownership row when the EVENT write is what fails", async () => {
    // A payload the caretaker_designated schema refuses (`ends_at` empty). The
    // ownership row has already been inserted at that point, so if the two were
    // not in one transaction this would leave a caretaker with write access and
    // no event explaining it — the worse of the two asymmetric failures.
    const grant = await seedPendingGrant();

    await expect(
      db.transaction((tx) =>
        CaretakersRepository.insertAcceptGrant(
          {
            grantId: grant.id,
            petId,
            caretakerUserId: CARETAKER_ID,
            grantPublicToken: "",
            endsAt: ENDS_AT,
            note: null,
            publicContactConsent: false,
            now: NOW,
          },
          tx,
        ),
      ),
    ).rejects.toThrow();

    expect(await countCaretakerRows()).toBe(0);
    expect(await countDesignatedEvents()).toBe(0);
  });

  it("rolls back everything when the grant is no longer pending under the lock", async () => {
    const grant = await seedPendingGrant();
    // Somebody cancelled between the use-case's read and the transaction.
    await db
      .update(petCaretakerGrants)
      .set({ status: "cancelled" })
      .where(eq(petCaretakerGrants.id, grant.id));

    await expect(
      db.transaction((tx) =>
        CaretakersRepository.insertAcceptGrant(
          {
            grantId: grant.id,
            petId,
            caretakerUserId: CARETAKER_ID,
            grantPublicToken: grant.publicToken,
            endsAt: ENDS_AT,
            note: null,
            publicContactConsent: false,
            now: NOW,
          },
          tx,
        ),
      ),
    ).rejects.toThrow(/ya fue resuelta/);

    expect(await countCaretakerRows()).toBe(0);
    expect(await countDesignatedEvents()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// insertEndGrant — the mirror image
// ---------------------------------------------------------------------------

describe("insertEndGrant — ending is atomic too", () => {
  async function acceptOne() {
    const grant = await seedPendingGrant();
    const { ownershipId } = await db.transaction((tx) =>
      CaretakersRepository.insertAcceptGrant(
        {
          grantId: grant.id,
          petId,
          caretakerUserId: CARETAKER_ID,
          grantPublicToken: grant.publicToken,
          endsAt: ENDS_AT,
          note: null,
          publicContactConsent: false,
          now: NOW,
        },
        tx,
      ),
    );
    return { grant, ownershipId };
  }

  it("closes the ownership row, emits caretaker_ended and flips the grant", async () => {
    const { grant, ownershipId } = await acceptOne();
    const endedAt = new Date("2026-09-16T04:00:00.000Z");

    await db.transaction((tx) =>
      CaretakersRepository.insertEndGrant(
        {
          grantId: grant.id,
          petId,
          ownershipId,
          outcome: "expired",
          endsAt: ENDS_AT,
          actorUserId: null,
          now: endedAt,
        },
        tx,
      ),
    );

    const [ownership] = await db.select().from(ownerships).where(eq(ownerships.id, ownershipId));
    expect(ownership.endedAt).toEqual(endedAt);

    const [row] = await db
      .select()
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.id, grant.id));
    expect(row.status).toBe("ended");
    expect(row.endedReason).toBe("expired");
    // The pointer SURVIVES the ending on purpose: it is what lets the drift
    // harness compare the grant against the row it produced.
    expect(row.ownershipId).toBe(ownershipId);

    const [event] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "caretaker_ended")));
    expect(event.payload).toMatchObject({ grant_id: grant.id, outcome: "expired" });
  });

  it("leaves the ownership row OPEN when the transaction aborts", async () => {
    const { grant, ownershipId } = await acceptOne();

    await expect(
      db.transaction(async (tx) => {
        await CaretakersRepository.insertEndGrant(
          {
            grantId: grant.id,
            petId,
            ownershipId,
            outcome: "revoked_by_owner",
            endsAt: ENDS_AT,
            actorUserId: TITULAR_ID,
            now: NOW,
          },
          tx,
        );
        throw new Error("forced mid-transaction failure");
      }),
    ).rejects.toThrow("forced mid-transaction failure");

    const [ownership] = await db.select().from(ownerships).where(eq(ownerships.id, ownershipId));
    expect(ownership.endedAt).toBeNull();

    const endedEvents = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "caretaker_ended")));
    expect(endedEvents).toHaveLength(0);
  });

  it("frees the pet for a new caretaker once the previous grant ended", async () => {
    const { grant, ownershipId } = await acceptOne();
    await db.transaction((tx) =>
      CaretakersRepository.insertEndGrant(
        {
          grantId: grant.id,
          petId,
          ownershipId,
          outcome: "revoked_by_owner",
          endsAt: ENDS_AT,
          actorUserId: TITULAR_ID,
          now: NOW,
        },
        tx,
      ),
    );

    // Both partial uniques (`accepted` grant, active caretaker ownership) must
    // now admit a second arrangement. If either kept the old row in scope, this
    // throws — which is the invariant, not an incidental check.
    const second = await seedPendingGrant();
    await expect(
      db.transaction((tx) =>
        CaretakersRepository.insertAcceptGrant(
          {
            grantId: second.id,
            petId,
            caretakerUserId: OTHER_ID,
            grantPublicToken: second.publicToken,
            endsAt: ENDS_AT,
            note: null,
            publicContactConsent: false,
            now: NOW,
          },
          tx,
        ),
      ),
    ).resolves.toBeDefined();

    const active = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.role, "caretaker"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(active).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The database's own invariants, exercised through the repository
// ---------------------------------------------------------------------------

describe("concurrency invariants at the data layer", () => {
  it("refuses a second PENDING invitation for the same pet", async () => {
    await seedPendingGrant();
    await expect(seedPendingGrant()).rejects.toSatisfy(
      (err: unknown) => pgErrorCode(err) === "23505",
    );
  });

  it("refuses a second ACTIVE caretaker ownership row for the same pet", async () => {
    const grant = await seedPendingGrant();
    await db.transaction((tx) =>
      CaretakersRepository.insertAcceptGrant(
        {
          grantId: grant.id,
          petId,
          caretakerUserId: CARETAKER_ID,
          grantPublicToken: grant.publicToken,
          endsAt: ENDS_AT,
          note: null,
          publicContactConsent: false,
          now: NOW,
        },
        tx,
      ),
    );

    await expect(
      db.insert(ownerships).values({ petId, ownerUserId: OTHER_ID, role: "caretaker" }),
    ).rejects.toSatisfy((err: unknown) => pgErrorCode(err) === "23505");
  });

  it("lets an ACCEPTED grant reach `ended` while keeping both pointers (0192)", async () => {
    // THE REGRESSION. 0189's accept CHECK was biconditional over `accepted`
    // alone, so flipping to `ended` — with caretaker_user_id and ownership_id
    // both still set, as they must be — violated it every time. The entire
    // ending path (revoke, withdraw, cron expiry) was unreachable, and no
    // schema test noticed, because a row is legal until you try to MOVE it.
    // 0192 widened the set to `accepted OR ended`. Asserted at the raw-SQL
    // level so the guarantee does not depend on the repository's own ordering.
    const grant = await seedPendingGrant();
    const { ownershipId } = await db.transaction((tx) =>
      CaretakersRepository.insertAcceptGrant(
        {
          grantId: grant.id,
          petId,
          caretakerUserId: CARETAKER_ID,
          grantPublicToken: grant.publicToken,
          endsAt: ENDS_AT,
          note: null,
          publicContactConsent: false,
          now: NOW,
        },
        tx,
      ),
    );

    await expect(
      db
        .update(petCaretakerGrants)
        .set({ status: "ended", endedAt: NOW, endedReason: "expired" })
        .where(eq(petCaretakerGrants.id, grant.id)),
    ).resolves.toBeDefined();

    const [row] = await db
      .select()
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.id, grant.id));
    expect(row.caretakerUserId).toBe(CARETAKER_ID);
    expect(row.ownershipId).toBe(ownershipId);
  });

  it("still refuses a CANCELLED grant that keeps a phantom ownership pointer", async () => {
    // The half of the 0189 constraint that WAS right, and that 0192 preserves:
    // an invitation that never became an arrangement must not point at an
    // ownership row, or the drift harness compares against a lie.
    const grant = await seedPendingGrant();

    await expect(
      db
        .update(petCaretakerGrants)
        .set({
          status: "cancelled",
          caretakerUserId: CARETAKER_ID,
          ownershipId: "00000000-0000-4000-8000-000000000000",
        })
        .where(eq(petCaretakerGrants.id, grant.id)),
    ).rejects.toSatisfy((err: unknown) => pgErrorCode(err) === "23514");
  });

  it("lets a PENDING invitation name an invitee who already has an account", async () => {
    // Permitted by the CHECK (both pointers must not be set TOGETHER outside
    // accepted/ended) and used by the designation flow, so cancelling can
    // notify the right person rather than nobody.
    const grant = await CaretakersRepository.insertGrant({
      petId,
      grantedByUserId: TITULAR_ID,
      caretakerUserId: CARETAKER_ID,
      caretakerEmail: "ana@example.com",
      startsAt: NOW,
      endsAt: ENDS_AT,
      note: null,
      now: NOW,
    });

    const [row] = await db
      .select()
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.id, grant.id));
    expect(row.status).toBe("pending");
    expect(row.caretakerUserId).toBe(CARETAKER_ID);
    expect(row.ownershipId).toBeNull();
  });

  it("refuses a consent timestamp on a PENDING row", async () => {
    // The weak CHECK, from the side it is meant to hold: consent is captured at
    // accept and nowhere else. It is deliberately `status <> 'pending'` rather
    // than `status = 'accepted'` so the record SURVIVES the grant ending — a
    // stricter form would force the cron to erase a historical fact.
    const grant = await seedPendingGrant();

    await expect(
      db
        .update(petCaretakerGrants)
        .set({ publicContactConsentAt: NOW })
        .where(eq(petCaretakerGrants.id, grant.id)),
    ).rejects.toSatisfy((err: unknown) => pgErrorCode(err) === "23514");
  });

  it("keeps the consent record after the grant ends", async () => {
    const grant = await seedPendingGrant();
    const { ownershipId } = await db.transaction((tx) =>
      CaretakersRepository.insertAcceptGrant(
        {
          grantId: grant.id,
          petId,
          caretakerUserId: CARETAKER_ID,
          grantPublicToken: grant.publicToken,
          endsAt: ENDS_AT,
          note: null,
          publicContactConsent: true,
          now: NOW,
        },
        tx,
      ),
    );

    await db.transaction((tx) =>
      CaretakersRepository.insertEndGrant(
        {
          grantId: grant.id,
          petId,
          ownershipId,
          outcome: "expired",
          endsAt: ENDS_AT,
          actorUserId: null,
          now: NOW,
        },
        tx,
      ),
    );

    const [row] = await db
      .select()
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.id, grant.id));
    expect(row.status).toBe("ended");
    expect(row.publicContactConsentAt).toEqual(NOW);
  });
});
