// Storage RLS — the private `revocations` bucket accepts uploads ONLY from an
// institutional admin/govt. (native-readiness RN-4 / B24, migration 0188.)
//
// WHAT THIS DEFENDS
// -----------------
// db/revocations_storage.sql shipped an INSERT policy `TO authenticated WITH
// CHECK (bucket_id = 'revocations')` — the predicate is the bucket name and
// NOTHING else, so it was TRUE for every authenticated account. Uploads are
// browser-direct (lib/ui/use-evidence-upload.ts), so any signed-up citizen
// could write arbitrary bytes, of any content-type and size, under any key —
// bypassing every server-side control. The role check in uploadRevocationEvidence
// gates the attachments ROW, never the storage WRITE.
//
// THE PROBE IS THE ATTACK. `vet@dim.test` is a real, authenticated, NON-admin/govt
// account; it must be refused at the storage layer. `admin@dim.test` is the
// legitimate uploader and must still succeed, or the whole revocation-evidence
// flow is broken.
//
// PRE-FLIGHT: local Supabase stack, seeded users (pnpm seed:test / db:bootstrap),
// migration 0188 applied. Setup failures THROW — never a green skip.

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";

const BUCKET = "revocations";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const NON_AUTHORITY = { email: "vet@dim.test", password: "Test1234!" };
const AUTHORITY = { email: "admin@dim.test", password: "Test1234!" };

// 1x1 PNG — the smallest thing that is really an image.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let anonClient: SupabaseClient;
let nonAuthorityClient: SupabaseClient;
let authorityClient: SupabaseClient;
let serviceClient: SupabaseClient;
let authorityUploadedPath = "";

async function signIn(creds: { email: string; password: string }): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword(creds);
  if (error || !data.user) {
    throw new Error(
      `sign-in failed for ${creds.email}: ${error?.message ?? "no user"}. Run \`pnpm seed:test\`.`,
    );
  }
  return client;
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing — the bucket cannot be probed.",
    );
  }
  anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  nonAuthorityClient = await signIn(NON_AUTHORITY);
  authorityClient = await signIn(AUTHORITY);
});

afterAll(async () => {
  if (authorityUploadedPath && serviceClient) {
    await serviceClient.storage
      .from(BUCKET)
      .remove([authorityUploadedPath])
      .catch(() => {});
  }
});

describe("revocations bucket — upload is admin/govt-only (RN-4/B24, migration 0188)", () => {
  it("is a PRIVATE bucket that exists", async () => {
    const rows = (await db.execute(sql`
      select public from storage.buckets where id = ${BUCKET}
    `)) as unknown as Array<{ public: boolean }>;
    expect(rows.length, "the revocations bucket does not exist — apply migration 0188").toBe(1);
    expect(rows[0].public, "revocations went PUBLIC").toBe(false);
  });

  it("has NO storage INSERT policy whose check is bucket_id ALONE", async () => {
    // cmd IN ('INSERT','ALL') — a FOR ALL policy also grants INSERT and would
    // otherwise slip past a cmd='INSERT'-only filter.
    const rows = (await db.execute(sql`
      select p.policyname, coalesce(p.with_check, '') as with_check
      from pg_policies p
      where p.schemaname = 'storage' and p.tablename = 'objects'
        and p.cmd in ('INSERT', 'ALL')
    `)) as unknown as Array<{ policyname: string; with_check: string }>;

    const offenders = rows.filter((r) => {
      const c = r.with_check;
      // References this bucket but does not further constrain by role/profile.
      return c.includes(BUCKET) && !c.includes("profiles") && !c.includes("role");
    });
    expect(
      offenders,
      `an INSERT policy on '${BUCKET}' checks bucket_id alone — any authenticated account can write arbitrary bytes. Offenders: ${offenders
        .map((o) => o.policyname)
        .join("; ")}`,
    ).toEqual([]);
  });

  it("anon cannot UPLOAD into the bucket", async () => {
    const { error } = await anonClient.storage
      .from(BUCKET)
      .upload(`anon/${Date.now().toString(36)}.png`, PIXEL, { contentType: "image/png" });
    expect(error, "anon uploaded into the revocations bucket").not.toBeNull();
  });

  it("a signed-in NON-admin/govt account cannot UPLOAD (the B24 attack)", async () => {
    const path = `attacker/${Date.now().toString(36)}.png`;
    const { error } = await nonAuthorityClient.storage
      .from(BUCKET)
      .upload(path, PIXEL, { contentType: "image/png" });
    expect(
      error,
      "a non-admin/govt account wrote arbitrary bytes to the revocations bucket",
    ).not.toBeNull();
    // Belt and braces: confirm nothing landed.
    const { data } = await serviceClient.storage.from(BUCKET).list("attacker", { limit: 10 });
    expect((data ?? []).length).toBe(0);
  });

  it("an institutional admin CAN still upload (legitimate path preserved)", async () => {
    authorityUploadedPath = `authority-probe/${Date.now().toString(36)}.png`;
    const { error } = await authorityClient.storage
      .from(BUCKET)
      .upload(authorityUploadedPath, PIXEL, { contentType: "image/png" });
    expect(
      error,
      `admin upload broke — the revocation-evidence flow is dead: ${error?.message}`,
    ).toBeNull();
  });

  it("the service-role client still reads the uploaded object", async () => {
    const { data, error } = await serviceClient.storage
      .from(BUCKET)
      .createSignedUrl(authorityUploadedPath, 60);
    expect(error, `service-role signing broke: ${error?.message}`).toBeNull();
    expect(data?.signedUrl, "service-role produced no signed URL").toBeTruthy();
  });
});
