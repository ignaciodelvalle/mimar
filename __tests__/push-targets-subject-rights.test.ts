// Integration tests — migration 0222: the subject-rights RPCs cover push_targets.
//
// This is §7 item 5 of dim-interno:docs/handoff/push-notifications.md, and its one-line
// justification there is the right one: "This is a legal obligation, not a
// nicety."
//
// Covers (Ley 25.326):
//   art. 16 — `erase_subject_data` DELETES the subject's push targets outright,
//             rather than scrubbing them, and reports the count in the
//             `subject_erasure` audit payload. Outright, because every column
//             is the subject's own device and nothing in the row describes an
//             animal or a third party — the `push_subscriptions` precedent the
//             migration copies.
//   art. 14 — `export_subject_data` returns those same rows so a person can see
//             WHICH devices are registered and since when, WITHOUT the
//             `expo_push_token`. That token is a delivery address with no second
//             factor: anybody holding it can push to the device. The web's
//             endpoint at least needs its key pair; this does not, so the export
//             must not put it in a file the subject may forward by e-mail.
//
// WHY BOTH HALVES ARE IN ONE FILE. They are two readings of the same question —
// "what does the system hold about this person's phones" — and the failure that
// matters is the pair disagreeing: a column the export forgot is a column
// nobody notices the erasure kept.
//
// RPC call pattern copied from subject-rights-pet-tags.test.ts: raw SQL through
// drizzle with `request.jwt.claims` spoofed inside one transaction.

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, pushTargets } from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const SUBJECT_EMAIL = "sr-push-subject@dim-test.local";
const OTHER_EMAIL = "sr-push-bystander@dim-test.local";

let subjectUserId: string;
let otherUserId: string;

async function callRpcAs<T>(
  callerUserId: string | null,
  fnSql: ReturnType<typeof sql>,
): Promise<{ data: T | null; error: { code?: string; message: string } | null }> {
  try {
    const result = await db.transaction(async (tx) => {
      const claims = callerUserId ? JSON.stringify({ sub: callerUserId }) : "";
      await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
      const rows = (await tx.execute(fnSql)) as unknown as Array<Record<string, unknown>>;
      return rows[0] ? (Object.values(rows[0])[0] as T) : null;
    });
    return { data: result, error: null };
  } catch (err) {
    const e = err as { message?: string };
    return {
      data: null,
      error: { code: pgErrorCode(err) ?? undefined, message: e.message ?? "unknown" },
    };
  }
}

async function deleteUserByEmail(email: string): Promise<void> {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  await db.delete(pushTargets).where(eq(pushTargets.userId, found.id));
  await admin.auth.admin.deleteUser(found.id);
}

async function createUser(email: string): Promise<string> {
  const { data, error } = await createFreshTestUser(admin, {
    email,
    password: "SrPushTest_2026!",
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
  return data.user.id;
}

/** Two devices for the subject, one for somebody else. */
async function seedTargets(): Promise<void> {
  await db.insert(pushTargets).values([
    {
      userId: subjectUserId,
      deviceId: `sr-push-phone-${subjectUserId}`,
      expoPushToken: "ExponentPushToken[subject-phone-aaaaaaaaaa]",
      platform: "android",
      appVersion: "1.4.2",
    },
    {
      userId: subjectUserId,
      deviceId: `sr-push-tablet-${subjectUserId}`,
      expoPushToken: "ExponentPushToken[subject-tablet-bbbbbbbb]",
      platform: "ios",
      appVersion: null,
    },
    {
      userId: otherUserId,
      deviceId: `sr-push-phone-${otherUserId}`,
      expoPushToken: "ExponentPushToken[bystander-phone-cccccccc]",
      platform: "android",
      appVersion: "1.4.2",
    },
  ]);
}

beforeAll(async () => {
  await deleteUserByEmail(SUBJECT_EMAIL);
  await deleteUserByEmail(OTHER_EMAIL);
  subjectUserId = await createUser(SUBJECT_EMAIL);
  otherUserId = await createUser(OTHER_EMAIL);
  await seedTargets();
});

afterAll(async () => {
  await deleteUserByEmail(SUBJECT_EMAIL);
  await deleteUserByEmail(OTHER_EMAIL);
});

describe("export_subject_data — art. 14, push_targets", () => {
  it("returns the subject's devices WITHOUT the delivery token", async () => {
    const { data, error } = await callRpcAs<Record<string, unknown>>(
      subjectUserId,
      sql`SELECT public.export_subject_data(${subjectUserId}::uuid)`,
    );
    expect(error).toBeNull();

    const targets = data?.push_targets as Array<Record<string, unknown>> | undefined;
    expect(targets, "export_subject_data carried no push_targets key at all").toBeDefined();
    expect(targets).toHaveLength(2);

    for (const row of targets ?? []) {
      // THE ASSERTION THIS FILE EXISTS FOR. `- 'expo_push_token'` in the
      // migration is one operator; losing it puts a live delivery credential
      // into a file the subject is invited to download and forward.
      expect(Object.keys(row)).not.toContain("expo_push_token");
      // And the fields art. 14 actually needs: which device, since when.
      expect(row).toHaveProperty("device_id");
      expect(row).toHaveProperty("platform");
      expect(row).toHaveProperty("created_at");
    }

    // Presence, not just absence: the export must carry the real device ids,
    // or a test that only checked for a missing key would pass on an empty array.
    const deviceIds = (targets ?? []).map((row) => row.device_id);
    expect(deviceIds).toContain(`sr-push-phone-${subjectUserId}`);
    expect(deviceIds).toContain(`sr-push-tablet-${subjectUserId}`);
  });

  it("does not carry anybody else's device", async () => {
    const { data } = await callRpcAs<Record<string, unknown>>(
      subjectUserId,
      sql`SELECT public.export_subject_data(${subjectUserId}::uuid)`,
    );
    const deviceIds = ((data?.push_targets as Array<Record<string, unknown>>) ?? []).map(
      (row) => row.device_id,
    );
    expect(deviceIds).not.toContain(`sr-push-phone-${otherUserId}`);
  });
});

describe("erase_subject_data — art. 16, push_targets", () => {
  it("deletes every one of the subject's rows, leaves the bystander's alone, and counts them", async () => {
    const before = await db
      .select({ id: pushTargets.id })
      .from(pushTargets)
      .where(eq(pushTargets.userId, subjectUserId));
    expect(before, "the fixture did not seed the subject's devices").toHaveLength(2);

    const { error } = await callRpcAs<null>(
      subjectUserId,
      sql`SELECT public.erase_subject_data(${subjectUserId}::uuid, ${"art16 push targets test"})`,
    );
    expect(error).toBeNull();

    const after = await db
      .select({ id: pushTargets.id })
      .from(pushTargets)
      .where(eq(pushTargets.userId, subjectUserId));
    // DELETED, not revoked. A revoked row still holds the device id and the
    // token of somebody who exercised their right to be forgotten.
    expect(after).toHaveLength(0);

    // The erasure is scoped. A `DELETE FROM push_targets` with a wrong or
    // missing WHERE would pass every assertion above and silently unsubscribe
    // everybody in the country.
    const bystander = await db
      .select({ id: pushTargets.id })
      .from(pushTargets)
      .where(eq(pushTargets.userId, otherUserId));
    expect(bystander).toHaveLength(1);

    const [entry] = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      // SCOPED TO THIS SUBJECT, not "the newest subject_erasure". The suite runs
      // files in parallel against one database, and every other erasure test
      // writes this same action — ordering by time alone would read somebody
      // else's row and pass or fail for reasons that have nothing to do with
      // this code.
      .where(and(eq(auditLog.action, "subject_erasure"), eq(auditLog.targetUserId, subjectUserId)))
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    // The count is how an operator answers "did the erasure reach the phones"
    // months later, when the rows themselves are gone by design.
    expect(entry?.payload).toMatchObject({ push_targets_deleted: 2 });
  });
});
