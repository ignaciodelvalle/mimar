// Storage RLS — the private `welfare-evidence` bucket is closed to anon and
// authenticated. (RA-8 finding R2, migration 0164.)
//
// WHAT THIS DEFENDS
// -----------------
// db/welfare_storage.sql shipped a SELECT policy `TO anon, authenticated` whose
// USING clause was, in full:
//
//   bucket_id = 'welfare-evidence'
//   and exists (select 1 from public.welfare_reports wr
//               where split_part(name, '/', 1) = wr.id::text)
//
// There is no caller in that expression. The header justified it as an
// "unguessable path" model — but Supabase's list endpoint is filtered by this
// same policy, so an ANONYMOUS list at the bucket root returned every object
// and a GET on each returned path passed the identical check. That is the
// complete national corpus of cruelty-complaint evidence, downloadable with no
// account. A sibling INSERT policy gave anon unrestricted upload.
//
// THE PROBE IS THE ATTACK, NOT A PROXY FOR IT. The fixture object is deliberately
// stored under a REAL welfare_reports id, so its path satisfies the old policy's
// `exists(...)` exactly. If anyone reintroduces that policy, these tests fail.
//
// The paired legitimate-path tests matter as much: signing runs as service
// role now, and the whole product (anonymous receipt lookup, reporter view,
// govt triage, admin moderation, MPF export) depends on it still working.
//
// PRE-FLIGHT: local Supabase stack, seeded welfare_reports (pnpm seed:test /
// db:bootstrap). Setup failures THROW — never a green skip.

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";

const BUCKET = "welfare-evidence";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ATTACKER = { email: "vet@dim.test", password: "Test1234!" };

// 1x1 PNG — the smallest thing that is really an image.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let anonClient: SupabaseClient;
let authedClient: SupabaseClient;
let serviceClient: SupabaseClient;
let reportId = "";
let fixturePath = "";

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

  authedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authErr } = await authedClient.auth.signInWithPassword(ATTACKER);
  if (authErr || !auth.user) {
    throw new Error(
      `sign-in failed for ${ATTACKER.email}: ${authErr?.message ?? "no user"}. Run \`pnpm seed:test\`.`,
    );
  }

  // A REAL welfare_reports id, so the fixture path satisfies the removed
  // policy's `split_part(name,'/',1) = wr.id::text` predicate verbatim.
  const rows = (await db.execute(sql`
    select id::text as id from public.welfare_reports order by created_at desc limit 1
  `)) as unknown as Array<{ id: string }>;
  if (!rows[0]?.id) {
    throw new Error(
      "no welfare_reports row exists — the probe would not reproduce the original policy's predicate. Seed the local stack first.",
    );
  }
  reportId = rows[0].id;
  fixturePath = `${reportId}/ra8-r2-probe-${Date.now().toString(36)}.png`;

  const { error: uploadErr } = await serviceClient.storage
    .from(BUCKET)
    .upload(fixturePath, PIXEL, { contentType: "image/png", upsert: true });
  if (uploadErr) {
    throw new Error(`service-role fixture upload failed: ${uploadErr.message}`);
  }
});

afterAll(async () => {
  if (fixturePath && serviceClient) {
    await serviceClient.storage
      .from(BUCKET)
      .remove([fixturePath])
      .catch(() => {});
  }
});

describe("welfare-evidence bucket — closed to anon and authenticated (RA-8 R2)", () => {
  it("is a PRIVATE bucket", async () => {
    const rows = (await db.execute(sql`
      select public from storage.buckets where id = ${BUCKET}
    `)) as unknown as Array<{ public: boolean }>;
    expect(rows.length, "the welfare-evidence bucket does not exist").toBe(1);
    expect(rows[0].public, "welfare-evidence went PUBLIC — evidence served without any gate").toBe(
      false,
    );
  });

  it("has NO storage.objects policy that can grant anon or authenticated access to it", async () => {
    const rows = (await db.execute(sql`
      select p.policyname, p.cmd, array_to_string(p.roles, ',') as roles,
             coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') as clause
      from pg_policies p
      where p.schemaname = 'storage' and p.tablename = 'objects'
    `)) as unknown as Array<{ policyname: string; cmd: string; roles: string; clause: string }>;

    const offenders = rows.filter(
      (r) =>
        r.clause.includes(BUCKET) &&
        r.roles
          .split(",")
          .map((x) => x.trim())
          .some((x) => x === "anon" || x === "authenticated" || x === "public"),
    );
    expect(
      offenders,
      `a policy referencing '${BUCKET}' is reachable by a low-trust role. Storage LIST is filtered by the SAME policy as GET, so any such policy is an enumeration surface over cruelty-complaint evidence. Offenders: ${offenders
        .map((o) => `${o.policyname} (${o.cmd}, ${o.roles})`)
        .join("; ")}`,
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ATTACK — anonymous enumeration + download
  // -------------------------------------------------------------------------

  it("anon cannot LIST the bucket root (the enumeration vector)", async () => {
    const { data, error } = await anonClient.storage.from(BUCKET).list("", { limit: 100 });
    expect(
      (data ?? []).length,
      `anon enumerated ${(data ?? []).length} object(s) in ${BUCKET}${error ? "" : " with no error"}`,
    ).toBe(0);
  });

  it("anon cannot LIST inside a known report folder", async () => {
    const { data } = await anonClient.storage.from(BUCKET).list(reportId, { limit: 100 });
    expect((data ?? []).length, "anon enumerated a known report's evidence folder").toBe(0);
  });

  it("anon cannot sign a KNOWN evidence path", async () => {
    const { data, error } = await anonClient.storage.from(BUCKET).createSignedUrl(fixturePath, 60);
    expect(data?.signedUrl ?? null, "anon minted a signed URL for real evidence").toBeNull();
    expect(error, "anon signing was not rejected").not.toBeNull();
  });

  it("anon cannot UPLOAD into the bucket", async () => {
    const { error } = await anonClient.storage
      .from(BUCKET)
      .upload(`${reportId}/anon-injected-${Date.now().toString(36)}.png`, PIXEL, {
        contentType: "image/png",
      });
    expect(error, "anon uploaded into the evidence bucket").not.toBeNull();
  });

  it("a signed-in user with no relationship to the report gets the same answers", async () => {
    const { data: listed } = await authedClient.storage.from(BUCKET).list("", { limit: 100 });
    expect((listed ?? []).length, "an authenticated stranger enumerated the bucket").toBe(0);

    const { data: signed, error: signErr } = await authedClient.storage
      .from(BUCKET)
      .createSignedUrl(fixturePath, 60);
    expect(signed?.signedUrl ?? null).toBeNull();
    expect(signErr).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // LEGITIMATE PATH — the app's actual read/write route
  // -------------------------------------------------------------------------

  it("the service-role client (welfareAttachmentSignedUrl's handle) still signs evidence", async () => {
    const { data, error } = await serviceClient.storage
      .from(BUCKET)
      .createSignedUrl(fixturePath, 60);
    expect(
      error,
      `service-role signing broke — every evidence viewer is now blind: ${error?.message}`,
    ).toBeNull();
    expect(data?.signedUrl, "service-role produced no signed URL").toBeTruthy();
  });

  it("the signed URL actually resolves to the object", async () => {
    const { data } = await serviceClient.storage.from(BUCKET).createSignedUrl(fixturePath, 60);
    const res = await fetch(data?.signedUrl as string);
    expect(res.status, "the signed URL did not serve the object").toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(PIXEL.byteLength);
  });

  it("the service-role client (uploadWelfareEvidence's handle) still uploads and removes", async () => {
    const path = `${reportId}/ra8-r2-writeprobe-${Date.now().toString(36)}.png`;
    const { error: upErr } = await serviceClient.storage
      .from(BUCKET)
      .upload(path, PIXEL, { contentType: "image/png" });
    expect(
      upErr,
      `anonymous denuncia evidence can no longer be stored: ${upErr?.message}`,
    ).toBeNull();

    // Rollback now works too — the bucket never had a DELETE policy, so every
    // pre-0164 `.remove()` in the failure paths was silently denied.
    const { error: rmErr } = await serviceClient.storage.from(BUCKET).remove([path]);
    expect(rmErr, `evidence cleanup is still broken: ${rmErr?.message}`).toBeNull();
  });
});
