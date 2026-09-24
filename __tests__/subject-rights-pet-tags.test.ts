// Integration tests — migration 0170: subject-rights RPCs cover pet_tags.
//
// Covers (Ley 25.326):
//   art. 14 — export_subject_data returns the subject's tag history WITHOUT
//             the activation_code_hash column (the export must not become the
//             one read path that SELECTs the hash back).
//   art. 16 — erase_subject_data NULLs activated_by_user_id and
//             revoked_by_user_id where they reference the subject, keeps the
//             rows (serial/status/pet linkage are the pet's operational
//             history), and reports `pet_tags_scrubbed` in the audit payload.
//
// RPC call pattern copied from subject-rights-rpcs.test.ts: raw SQL through
// drizzle with request.jwt.claims spoofed inside one transaction.

import { createClient } from "@supabase/supabase-js";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, ownerships, petTags, pets } from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";
import { generateTagSerial } from "@/lib/infra/publicToken";
import { hashTagActivationCode } from "@/lib/utils/tag-code-hash";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const SUBJECT_EMAIL = "sr-tags-subject@dim-test.local";
const TEST_LOTE = "TEST-LOTE-SRTAGS";

let subjectUserId: string;
let petId: string;
let activeSerial: string;
let revokedSerial: string;

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

async function purge() {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === SUBJECT_EMAIL);
  await db.delete(petTags).where(eq(petTags.loteId, TEST_LOTE));
  if (!found) return;
  const owned = await db
    .select({ petId: ownerships.petId })
    .from(ownerships)
    .where(eq(ownerships.ownerUserId, found.id));
  await withMutationOverride(async (tx) => {
    for (const { petId: id } of owned) await tx.delete(pets).where(eq(pets.id, id));
  });
  await admin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await purge();
  const { data, error } = await createFreshTestUser(admin, {
    email: SUBJECT_EMAIL,
    password: "SubjRightsTags_2026!",
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  subjectUserId = data.user.id;

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `DIM-SRTG-${Date.now().toString(36).toUpperCase().slice(-4)}`,
      name: "Subject Rights Tag Pet",
      species: "cat",
      sex: "female",
      status: "active",
    })
    .returning({ id: pets.id });
  petId = pet.id;
  await db.insert(ownerships).values({ petId, ownerUserId: subjectUserId, role: "owner" });

  const now = new Date();
  activeSerial = generateTagSerial();
  revokedSerial = generateTagSerial();
  await db.insert(petTags).values([
    {
      serial: activeSerial,
      activationCodeHash: hashTagActivationCode("EXPO-RT22"),
      loteId: TEST_LOTE,
      status: "active",
      petId,
      activatedByUserId: subjectUserId,
      activatedAt: now,
    },
    {
      serial: revokedSerial,
      activationCodeHash: hashTagActivationCode("EXPO-RT33"),
      loteId: TEST_LOTE,
      status: "revoked",
      petId,
      activatedByUserId: subjectUserId,
      activatedAt: now,
      revokedByUserId: subjectUserId,
      revokedAt: now,
      revokedReason: "lost",
    },
  ]);
}, 30_000);

afterAll(async () => {
  await purge();
}, 30_000);

describe("export_subject_data — pet_tags section (art. 14)", () => {
  it("returns the subject's tag history WITHOUT activation_code_hash, schema_version 5", async () => {
    const { data, error } = await callRpcAs<Record<string, unknown>>(
      subjectUserId,
      sql`SELECT public.export_subject_data(${subjectUserId}::uuid)`,
    );
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    const exportJson = data as {
      schema_version: number;
      pet_tags: Array<Record<string, unknown>>;
    };
    // 4 -> 5 in migration 0208, which added operator_feed_watermarks,
    // physical_tag_interest and organization_invitations. Nothing about the
    // pet_tags section itself changed — 0208 copies it verbatim — so this file
    // moves the version pin and NOTHING else. The three new sections are
    // asserted where they belong: their key presence in
    // subject-rights-rpcs.test.ts, their contents in the 0208 lane's own tests.
    expect(exportJson.schema_version).toBe(5);

    const serials = exportJson.pet_tags.map((t) => t.serial);
    expect(serials).toContain(activeSerial);
    expect(serials).toContain(revokedSerial);

    for (const row of exportJson.pet_tags) {
      expect(row).not.toHaveProperty("activation_code_hash");
    }
    // Belt-and-suspenders: no hash value anywhere in the whole export blob.
    const blob = JSON.stringify(data);
    expect(blob).not.toContain(hashTagActivationCode("EXPO-RT22"));
    expect(blob).not.toContain(hashTagActivationCode("EXPO-RT33"));
  });
});

describe("erase_subject_data — pet_tags scrub (art. 16)", () => {
  it("NULLs both actor FKs, keeps the rows, and audits pet_tags_scrubbed", async () => {
    const { error } = await callRpcAs<null>(
      subjectUserId,
      sql`SELECT public.erase_subject_data(${subjectUserId}::uuid, ${"test erasure (pet_tags)"})`,
    );
    expect(error).toBeNull();

    const rows = await db.select().from(petTags).where(eq(petTags.loteId, TEST_LOTE));
    expect(rows).toHaveLength(2); // rows survive — pet history, not user PII
    for (const row of rows) {
      expect(row.activatedByUserId).toBeNull();
      expect(row.revokedByUserId).toBeNull();
      // The non-personal lifecycle facts remain.
      expect(row.petId).toBe(petId);
      expect(["active", "revoked"]).toContain(row.status);
    }

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetUserId, subjectUserId))
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    expect(audit.action).toBe("subject_erasure");
    expect((audit.payload as { pet_tags_scrubbed?: number }).pet_tags_scrubbed).toBe(2);
  });

  it("is idempotent: a re-run scrubs zero rows", async () => {
    const { error } = await callRpcAs<null>(
      subjectUserId,
      sql`SELECT public.erase_subject_data(${subjectUserId}::uuid, ${"test erasure re-run"})`,
    );
    expect(error).toBeNull();

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetUserId, subjectUserId))
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    expect((audit.payload as { pet_tags_scrubbed?: number }).pet_tags_scrubbed).toBe(0);
  });
});
