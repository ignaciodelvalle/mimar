// The rules `lib/infra/push-target-store.ts` encodes, against real Postgres.
//
// WHY THIS HITS THE `db` PROJECT AND NOT A MOCK. Every assertion here is about
// something only a database can answer: which row a conflict target lands on,
// that an UPDATE left a row where a DELETE would have removed it, and that an
// RPC defined in a migration reaches a table added in the same file. A mocked
// drizzle would prove that the code calls the functions the test expects it to
// call, which is a restatement of the implementation rather than a check of it.
//
// Covers §7 of the push handoff:
//   2. upsert on device_id — rotated token, and a second person on one phone.
//   3. soft-revoke — the row is revoked, NOT deleted.
//   5. erasure — after erase_subject_data the person's targets are gone.
//
// Plus one rule the handoff does not name and the store's own header argues
// for: revocation is scoped by user_id as well as device_id, so knowing a
// device_id is not enough to silence somebody else's phone.

import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db, pushTargets } from "@/db";
import {
  activePushTargetsForUser,
  clearPendingPushReceipt,
  markPushTargetUsed,
  pendingPushReceipts,
  registerPushTarget,
  revokeAllPushTargetsForUser,
  revokePushTarget,
  revokePushTargetById,
} from "@/lib/infra/push-target-store";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const EMAIL_A = "push-target-store-a@dim-test.local";
const EMAIL_B = "push-target-store-b@dim-test.local";
const PASS = "PushTargetStore_2026!";

/** One device_id both people in this file register, because that IS the test. */
const SHARED_DEVICE = "device-push-target-store-shared";

/** A second install for the same person — "todos los dispositivos" needs two. */
const SECOND_DEVICE = "device-push-target-store-second";

let userA: string;
let userB: string;

async function dropUser(email: string) {
  const { data } = await admin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  if (!found) return;
  await db
    .delete(pushTargets)
    .where(eq(pushTargets.userId, found.id))
    .catch(() => {});
  await admin.auth.admin.deleteUser(found.id).catch(() => {});
}

async function createUser(email: string): Promise<string> {
  const { data, error } = await createFreshTestUser(admin, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${email}): ${error?.message}`);
  return data.user.id;
}

/** Every row for this device, whoever owns it and whether or not it is revoked. */
async function rowsForSharedDevice() {
  return db
    .select({
      id: pushTargets.id,
      userId: pushTargets.userId,
      expoPushToken: pushTargets.expoPushToken,
      platform: pushTargets.platform,
      appVersion: pushTargets.appVersion,
      revokedAt: pushTargets.revokedAt,
      lastUsedAt: pushTargets.lastUsedAt,
    })
    .from(pushTargets)
    .where(eq(pushTargets.deviceId, SHARED_DEVICE));
}

beforeAll(async () => {
  await dropUser(EMAIL_A);
  await dropUser(EMAIL_B);
  userA = await createUser(EMAIL_A);
  userB = await createUser(EMAIL_B);
});

afterAll(async () => {
  await dropUser(EMAIL_A);
  await dropUser(EMAIL_B);
});

beforeEach(async () => {
  await db.delete(pushTargets).where(eq(pushTargets.deviceId, SHARED_DEVICE));
  await db.delete(pushTargets).where(eq(pushTargets.deviceId, SECOND_DEVICE));
});

describe("registerPushTarget — the conflict target is device_id", () => {
  it("keeps ONE row when the same device re-registers with a rotated token", async () => {
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[FIRST]",
      platform: "android",
      appVersion: "1.0.0",
    });
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[ROTATED]",
      platform: "android",
      appVersion: "1.0.1",
    });

    const rows = await rowsForSharedDevice();
    // ONE row, not two. A token used as the conflict target would have inserted
    // a second here and orphaned the first with no install identity to
    // reconcile against — the failure device_id exists to prevent.
    expect(rows).toHaveLength(1);
    expect(rows[0].expoPushToken).toBe("ExponentPushToken[ROTATED]");
    expect(rows[0].appVersion).toBe("1.0.1");
    expect(rows[0].userId).toBe(userA);
  });

  it("flips the owner when a SECOND person signs in on the same phone", async () => {
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[A]",
      platform: "android",
    });
    await registerPushTarget({
      userId: userB,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[B]",
      platform: "android",
    });

    const rows = await rowsForSharedDevice();
    expect(rows).toHaveLength(1);
    // The device's lock screen belongs to whoever is signed in on it. Leaving
    // user_id out of the upsert's SET would keep delivering A's notifications
    // to a phone that is now B's.
    expect(rows[0].userId).toBe(userB);
    expect(rows[0].expoPushToken).toBe("ExponentPushToken[B]");

    // And A must no longer reach it.
    expect(await activePushTargetsForUser(userA)).toHaveLength(0);
    expect(await activePushTargetsForUser(userB)).toHaveLength(1);
  });

  it("clears revoked_at, so a device silenced by a sign-out can speak again", async () => {
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[A]",
      platform: "ios",
    });
    await revokePushTarget(userA, SHARED_DEVICE);
    expect(await activePushTargetsForUser(userA)).toHaveLength(0);

    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[A2]",
      platform: "ios",
    });

    const rows = await rowsForSharedDevice();
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).toBeNull();
    expect(await activePushTargetsForUser(userA)).toHaveLength(1);
  });
});

describe("revokePushTarget — soft, and scoped to the owner", () => {
  it("REVOKES the row rather than deleting it", async () => {
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[A]",
      platform: "android",
    });

    const revoked = await revokePushTarget(userA, SHARED_DEVICE);
    expect(revoked).toBe(1);

    const rows = await rowsForSharedDevice();
    // STILL THERE. The audit trail is the point: the nightly purge removes it
    // after the TTL and erase_subject_data removes it on request, but a
    // sign-out must not destroy the record of the device.
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).not.toBeNull();
    // And the send path stops seeing it.
    expect(await activePushTargetsForUser(userA)).toHaveLength(0);
  });

  it("does NOTHING when the caller is not the row's owner", async () => {
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[A]",
      platform: "android",
    });

    // B knows the device_id and asks for it to be revoked.
    const revoked = await revokePushTarget(userB, SHARED_DEVICE);

    // Nothing matched. Without the user_id in the WHERE, anybody who learned a
    // device_id could silence somebody else's phone through the endpoint.
    expect(revoked).toBe(0);
    const rows = await rowsForSharedDevice();
    expect(rows[0].revokedAt).toBeNull();
    expect(await activePushTargetsForUser(userA)).toHaveLength(1);
  });

  it("answers 0 for a device that was never registered, and that is not an error", async () => {
    expect(await revokePushTarget(userA, "device-that-never-existed")).toBe(0);
  });
});

describe("the send path's reads and writes", () => {
  it("returns only LIVE targets, and bumps last_used_at on a delivery", async () => {
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[A]",
      platform: "android",
    });

    const [target] = await activePushTargetsForUser(userA);
    expect(target.expoPushToken).toBe("ExponentPushToken[A]");

    const before = (await rowsForSharedDevice())[0].lastUsedAt;
    expect(before).toBeNull();

    await markPushTargetUsed(target.id);
    expect((await rowsForSharedDevice())[0].lastUsedAt).not.toBeNull();
  });

  it("soft-revokes by id when Expo says the device is gone", async () => {
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[A]",
      platform: "android",
    });
    const [target] = await activePushTargetsForUser(userA);

    await revokePushTargetById(target.id);

    const rows = await rowsForSharedDevice();
    // Revoked, not deleted — the same contract the owner-scoped revoke has.
    // DeviceNotRegistered is the ordinary end of an install's life, not an
    // incident, so the row keeps its trail exactly as a sign-out would.
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).not.toBeNull();
    expect(await activePushTargetsForUser(userA)).toHaveLength(0);
  });
});

describe("erase_subject_data reaches push_targets (Ley 25.326 art. 16)", () => {
  it("DELETES the person's targets, and counts them in the audit payload", async () => {
    // A throwaway subject: erasure soft-deletes the profile, so it must not be
    // one of the two users the rest of this file reuses.
    const email = "push-target-erase@dim-test.local";
    await dropUser(email);
    const subject = await createUser(email);
    const device = "device-push-target-erase";

    try {
      await registerPushTarget({
        userId: subject,
        deviceId: device,
        expoPushToken: "ExponentPushToken[ERASE]",
        platform: "android",
        appVersion: "1.0.0",
      });
      expect(await activePushTargetsForUser(subject)).toHaveLength(1);

      // set_config(..., true) is transaction-scoped and the pool may hand a
      // different connection to each execute(), so the claim and the RPC go in
      // ONE transaction — otherwise auth.uid() is null inside the function and
      // it raises 'forbidden'.
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: subject })}, true)`,
        );
        await tx.execute(sql`SELECT public.erase_subject_data(${subject}::uuid, 'test'::text)`);
      });

      const left = await db
        .select({ id: pushTargets.id })
        .from(pushTargets)
        .where(eq(pushTargets.userId, subject));
      // GONE, not revoked. Art. 16 asks for the data to be absent, and every
      // column here is the subject's own — an install identifier, a deliverable
      // address for it, and the hardware it runs on.
      expect(left).toHaveLength(0);

      const [audit] = (await db.execute(
        sql`SELECT payload FROM public.audit_log
             WHERE action = 'subject_erasure'
             ORDER BY performed_at DESC
             LIMIT 1`,
      )) as unknown as Array<{ payload: Record<string, unknown> }>;
      // The count rides in the same payload every other step reports through,
      // so an erasure that silently skipped this table would not read as a
      // clean run.
      expect(audit.payload.push_targets_deleted).toBe(1);
    } finally {
      await db
        .delete(pushTargets)
        .where(eq(pushTargets.userId, subject))
        .catch(() => {});
      await admin.auth.admin.deleteUser(subject).catch(() => {});
    }
  });
});

describe("the table refuses what the schema says it refuses", () => {
  it("rejects a platform Expo does not broker to", async () => {
    await expect(
      db.insert(pushTargets).values({
        userId: userA,
        deviceId: "device-bad-platform",
        expoPushToken: "ExponentPushToken[X]",
        // A third store would be a typo, not a feature — which is why the CHECK
        // is in the migration and not in a comment.
        platform: "web",
      }),
    ).rejects.toThrow();
  });

  it("refuses two rows for one device, whoever owns them", async () => {
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[A]",
      platform: "android",
    });
    await expect(
      db.insert(pushTargets).values({
        userId: userB,
        deviceId: SHARED_DEVICE,
        expoPushToken: "ExponentPushToken[B]",
        platform: "android",
      }),
    ).rejects.toThrow();
  });
});

describe("activePushTargetsForUser — scoping", () => {
  it("never returns another person's device", async () => {
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[A]",
      platform: "android",
    });
    const forB = await db
      .select({ id: pushTargets.id })
      .from(pushTargets)
      .where(and(eq(pushTargets.userId, userB), eq(pushTargets.deviceId, SHARED_DEVICE)));
    expect(forB).toHaveLength(0);
    expect(await activePushTargetsForUser(userB)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// revokeAllPushTargetsForUser — "cerrar sesión en todos los dispositivos"
//
// The per-device revoke above can only ever reach the phone in the caller's
// hand, because the app is what holds the install id. The act this one serves is
// the opposite one: somebody whose phone is GONE asks, from another device, for
// everything to stop. Without it the sessions died and the stolen phone kept its
// live row — and kept lighting up.
// ---------------------------------------------------------------------------

describe("revokeAllPushTargetsForUser — every device, not just this one", () => {
  async function registerBoth() {
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[lost-phone]",
      platform: "android",
    });
    await registerPushTarget({
      userId: userA,
      deviceId: SECOND_DEVICE,
      expoPushToken: "ExponentPushToken[tablet]",
      platform: "ios",
    });
  }

  it("silences every live device the person has", async () => {
    await registerBoth();
    expect(await activePushTargetsForUser(userA)).toHaveLength(2);

    const revoked = await revokeAllPushTargetsForUser(userA);

    expect(revoked).toBe(2);
    expect(await activePushTargetsForUser(userA)).toHaveLength(0);
  });

  it("revokes, never deletes — the trail survives for the purge and for art. 14", async () => {
    await registerBoth();

    await revokeAllPushTargetsForUser(userA);

    const rows = await db
      .select({ revokedAt: pushTargets.revokedAt })
      .from(pushTargets)
      .where(eq(pushTargets.userId, userA));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.revokedAt).not.toBeNull();
  });

  it("does NOT touch anybody else's devices", async () => {
    await registerBoth();
    await registerPushTarget({
      userId: userB,
      deviceId: "device-push-target-store-other-person",
      expoPushToken: "ExponentPushToken[somebody-else]",
      platform: "android",
    });

    await revokeAllPushTargetsForUser(userA);

    expect(await activePushTargetsForUser(userB)).toHaveLength(1);
    await db
      .delete(pushTargets)
      .where(eq(pushTargets.deviceId, "device-push-target-store-other-person"));
  });

  it("answers 0 the second time, because there was nothing live left", async () => {
    await registerBoth();
    await revokeAllPushTargetsForUser(userA);

    // The count is "how many live devices did this silence", not "how many rows
    // exist" — a caller logging it should see an honest zero, and an
    // already-revoked row must not have its timestamp moved.
    expect(await revokeAllPushTargetsForUser(userA)).toBe(0);
  });

  it("brings a device back when the person signs in on it again", async () => {
    await registerBoth();
    await revokeAllPushTargetsForUser(userA);

    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[found-under-the-seat]",
      platform: "android",
    });

    // Soft revocation is what makes this possible: somebody who finds the phone
    // signs in and push works again, with no reinstall.
    const active = await activePushTargetsForUser(userA);
    expect(active).toHaveLength(1);
    expect(active[0].expoPushToken).toBe("ExponentPushToken[found-under-the-seat]");
  });
});

// ---------------------------------------------------------------------------
// The pending receipt — migration 0223
//
// Expo answers a send twice, and only the second answer knows whether a phone
// got it. `DeviceNotRegistered` arrives in the RECEIPT, fetched later by an id
// the ticket handed back on the request path; these three functions are how that
// id survives the gap.
// ---------------------------------------------------------------------------

describe("the pending receipt id", () => {
  async function registerShared(): Promise<string> {
    await registerPushTarget({
      userId: userA,
      deviceId: SHARED_DEVICE,
      expoPushToken: "ExponentPushToken[receipts]",
      platform: "android",
    });
    const [row] = await rowsForSharedDevice();
    return row.id;
  }

  it("is written by the same UPDATE that bumps last_used_at", async () => {
    const id = await registerShared();

    await markPushTargetUsed(id, "receipt-abc");

    const pending = await pendingPushReceipts(10);
    expect(pending).toEqual([expect.objectContaining({ targetId: id, receiptId: "receipt-abc" })]);
    const [row] = await rowsForSharedDevice();
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("is left alone by a bump that carries no id", async () => {
    const id = await registerShared();
    await markPushTargetUsed(id, "receipt-abc");

    await markPushTargetUsed(id);

    // A bump is not an answer. Clearing here would drop an id nobody asked
    // about, and the receipt it unlocks with it.
    const pending = await pendingPushReceipts(10);
    expect(pending.map((p) => p.receiptId)).toEqual(["receipt-abc"]);
  });

  it("keeps only the newest id for one device", async () => {
    const id = await registerShared();

    await markPushTargetUsed(id, "receipt-one");
    await markPushTargetUsed(id, "receipt-two");

    // Deliberate, and argued in migration 0223: DeviceNotRegistered is a
    // PERSISTENT condition, not an event, so the newest receipt answers the same
    // question the older one would have — about the most recent attempt.
    const pending = await pendingPushReceipts(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].receiptId).toBe("receipt-two");
  });

  it("clears only when the id still matches", async () => {
    const id = await registerShared();
    await markPushTargetUsed(id, "receipt-old");

    // A send that lands WHILE the nightly job is running writes a newer id onto
    // the same row. Clearing by row alone would erase an id nobody has asked
    // about — possibly carrying the DeviceNotRegistered this path exists for.
    await markPushTargetUsed(id, "receipt-new");
    await clearPendingPushReceipt(id, "receipt-old");

    const pending = await pendingPushReceipts(10);
    expect(pending.map((p) => p.receiptId)).toEqual(["receipt-new"]);
  });

  it("clears both columns together, so the queue is one fact", async () => {
    const id = await registerShared();
    await markPushTargetUsed(id, "receipt-abc");

    await clearPendingPushReceipt(id, "receipt-abc");

    expect(await pendingPushReceipts(10)).toHaveLength(0);
    const rows = await db
      .select({
        pendingReceiptId: pushTargets.pendingReceiptId,
        pendingReceiptAt: pushTargets.pendingReceiptAt,
      })
      .from(pushTargets)
      .where(eq(pushTargets.id, id));
    expect(rows[0].pendingReceiptId).toBeNull();
    expect(rows[0].pendingReceiptAt).toBeNull();
  });

  it("returns a REVOKED device's pending receipt too", async () => {
    // Not an oversight. A row is revoked on the way out of a sign-out, and its
    // last receipt may still be the one that says the token itself is dead.
    // Filtering the queue by `revoked_at IS NULL` would discard exactly the
    // answers worth having, and the revocation is idempotent anyway.
    const id = await registerShared();
    await markPushTargetUsed(id, "receipt-abc");
    await revokePushTarget(userA, SHARED_DEVICE);

    expect((await pendingPushReceipts(10)).map((p) => p.targetId)).toContain(id);
  });

  it("respects the batch limit", async () => {
    const id = await registerShared();
    await markPushTargetUsed(id, "receipt-abc");

    expect(await pendingPushReceipts(0)).toHaveLength(0);
    expect(await pendingPushReceipts(1)).toHaveLength(1);
  });
});
