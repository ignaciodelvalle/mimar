// Runtime test — an ACTIVE physical tag survives an owner→owner transfer.
//
// W1 from the physical-tag verify pass (2026-08-05). The design says the tag
// is bound to the PET, not to the person: a custody handoff must leave the
// pet_tags row completely untouched (same serial, same pet_id, still active)
// and /t/[serial] must keep resolving to the same public page. Nothing in
// acceptPetTransfer touches pet_tags today — this test is the fence that keeps
// it that way, because the failure mode (a transfer silently revoking or
// re-pointing a tag) is invisible until someone scans a physical tag in the
// street and gets a 404.
//
// Fixture pattern: bare `profiles` rows (no auth.users FK on profiles.id, same
// shortcut transfers-repository.test.ts uses) + pets + ownerships + pet_tags
// inserted directly, mirroring tag-lifecycle.test.ts.
//
// The /t/[serial] side is asserted through lookupTagBySerial — the exact DB
// read the resolver page performs. The page-level 4-state matrix on top of
// that projection is covered by tag-resolver-page.test.tsx.

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, petTags, petTransfers, pets, profiles } from "@/db";
import { generateTagActivationCode, generateTagSerial } from "@/lib/infra/publicToken";
import { lookupTagBySerial } from "@/lib/infra/tag-lookup";
import { hashDni } from "@/lib/utils/dni-hash";
import { hashTagActivationCode } from "@/lib/utils/tag-code-hash";
import { activateTagForUser } from "@/src/modules/pets/application/tags/activate-tag";
import { revokeTagForUser } from "@/src/modules/pets/application/tags/revoke-tag";
import { acceptPetTransfer } from "@/src/modules/transfers/application/accept-pet-transfer";
import { TransfersRepository } from "@/src/modules/transfers/infrastructure/transfers-repository";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-TAGTRX-P1";
const TEST_LOTE = "TEST-LOTE-TAGTRX";
const TRANSFER_TOKEN = "PTR-tag-continuity-001";
const NEW_OWNER_EMAIL = "tag-transfer-new-owner@dim-test.local";

let petId: string;
let oldOwnerId: string;
let newOwnerId: string;
let tagId: string;
let tagSerial: string;

async function cleanup() {
  // pet_tags.pet_id has no ON DELETE action — clear tag rows before the pets.
  await db.delete(petTags).where(eq(petTags.loteId, TEST_LOTE));
  await db.delete(petTransfers).where(eq(petTransfers.publicToken, TRANSFER_TOKEN));
  await withMutationOverride(async (tx) => {
    const stale = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN));
    for (const { id } of stale) await tx.delete(pets).where(eq(pets.id, id));
  });
}

beforeAll(async () => {
  await cleanup();

  oldOwnerId = randomUUID();
  await db.insert(profiles).values({
    id: oldOwnerId,
    displayName: "Tag Transfer Old Owner",
    dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
    dniVerified: true,
    role: "owner",
    phone: "1112350001",
  });

  newOwnerId = randomUUID();
  await db.insert(profiles).values({
    id: newOwnerId,
    displayName: "Tag Transfer New Owner",
    dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
    dniVerified: true,
    role: "owner",
    phone: "1112350002",
  });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Tag Transfer Pet",
      species: "dog",
      sex: "female",
      status: "active",
    })
    .returning({ id: pets.id });
  petId = pet.id;

  await db.insert(ownerships).values({ petId, ownerUserId: oldOwnerId, role: "owner" });

  // Blank tag, then a real activation through the use-case (not a hand-built
  // "active" row) so the starting state is one production actually produces.
  tagSerial = generateTagSerial();
  const code = generateTagActivationCode();
  const [tagRow] = await db
    .insert(petTags)
    .values({
      serial: tagSerial,
      activationCodeHash: hashTagActivationCode(code),
      loteId: TEST_LOTE,
    })
    .returning({ id: petTags.id });
  tagId = tagRow.id;

  const activation = await activateTagForUser(oldOwnerId, {
    serial: tagSerial,
    activationCode: code,
    petId,
  });
  if ("error" in activation) throw new Error(`fixture activation failed: ${activation.error}`);

  await db.insert(petTransfers).values({
    publicToken: TRANSFER_TOKEN,
    petId,
    fromOwnerId: oldOwnerId,
    toOwnerId: newOwnerId,
    toOwnerEmail: NEW_OWNER_EMAIL,
    status: "pending",
    reason: "gift",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
}, 30_000);

afterAll(async () => {
  await cleanup();
  await db.delete(profiles).where(eq(profiles.id, oldOwnerId));
  await db.delete(profiles).where(eq(profiles.id, newOwnerId));
}, 30_000);

describe("physical tag continuity across an owner→owner transfer", () => {
  it("leaves the pet_tags row untouched and keeps /t/[serial] resolving", async () => {
    const [before] = await db.select().from(petTags).where(eq(petTags.id, tagId));
    expect(before.status).toBe("active");
    expect(before.petId).toBe(petId);
    const lookupBefore = await lookupTagBySerial(tagSerial);
    expect(lookupBefore).toEqual({ status: "active", publicToken: PET_TOKEN });

    const result = await acceptPetTransfer(
      // `callerEmailConfirmed: true` mirrors the seeded auth user, which is
      // created with `email_confirm: true` like every account this suite makes.
      { transferToken: TRANSFER_TOKEN, callerEmail: NEW_OWNER_EMAIL, callerEmailConfirmed: true },
      {
        repo: TransfersRepository,
        actor: { user: { id: newOwnerId } },
        // The use-case declares `transaction` generically over its callback's
        // return type; drizzle's own signature is narrower, so the bridge is
        // cast on both ends (same shape the thin server action uses).
        transaction: <T>(cb: (tx: unknown) => Promise<T>) =>
          db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
      },
    );
    expect(result.ok).toBe(true);

    // Custody actually moved — otherwise the assertions below are vacuous.
    const activeOwners = await db
      .select({ ownerUserId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(eq(ownerships.petId, petId), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
      );
    expect(activeOwners).toHaveLength(1);
    expect(activeOwners[0].ownerUserId).toBe(newOwnerId);

    // The tag row is bit-for-bit what it was: same serial, same pet, still
    // active, still credited to the ORIGINAL activator, never revoked.
    const [after] = await db.select().from(petTags).where(eq(petTags.id, tagId));
    expect(after.serial).toBe(tagSerial);
    expect(after.petId).toBe(petId);
    expect(after.status).toBe("active");
    expect(after.activatedByUserId).toBe(oldOwnerId);
    expect(after.activatedAt?.getTime()).toBe(before.activatedAt?.getTime());
    expect(after.revokedAt).toBeNull();
    expect(after.revokedByUserId).toBeNull();
    expect(after.revokedReason).toBeNull();

    // No tag_revoked was appended as a side effect of the handoff.
    const revocations = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "tag_revoked")));
    expect(revocations).toHaveLength(0);

    // A scan of the physical tag still lands on the same public page.
    expect(await lookupTagBySerial(tagSerial)).toEqual({
      status: "active",
      publicToken: PET_TOKEN,
    });
  }, 30_000);

  it("hands tag control to the new owner (the tag follows the pet, not the person)", async () => {
    // Runs after the transfer above. The previous owner has no active
    // ownership left, so the ownership gate must now refuse them and admit the
    // recipient — otherwise a sold pet's tag would stay hostage to the seller.
    const staleOwnerAttempt = await revokeTagForUser(oldOwnerId, {
      serial: tagSerial,
      revokeReason: "lost",
    });
    expect("error" in staleOwnerAttempt && staleOwnerAttempt.error).toMatch(/ownership/i);

    const newOwnerAttempt = await revokeTagForUser(newOwnerId, {
      serial: tagSerial,
      revokeReason: "lost",
    });
    expect(newOwnerAttempt).toMatchObject({ ok: true });

    const [row] = await db.select().from(petTags).where(eq(petTags.id, tagId));
    expect(row.status).toBe("revoked");
    expect(row.revokedByUserId).toBe(newOwnerId);
    expect(row.petId).toBe(petId); // audit linkage survives revocation
  }, 30_000);
});
