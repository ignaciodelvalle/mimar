/**
 * RLS smoke test for the owner-facing tables.
 *
 * Run with: pnpm rls:smoke
 *
 * What it does: signs in as two test accounts via @supabase/supabase-js (the
 * client path that IS subject to RLS), then asserts that user B cannot read
 * any of user A's data and that the append-only invariant on pet_events holds.
 *
 * Setup (one-time, manual): create two test accounts via the app's /signup
 * flow, give each at least one pet, then set six env vars in .env.local:
 *
 *   TEST_USER_A_EMAIL, TEST_USER_A_PASSWORD
 *   TEST_USER_B_EMAIL, TEST_USER_B_PASSWORD
 *
 * NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY come from the
 * existing .env.local that the app already uses.
 *
 * Exit code: 0 if every assertion passes, 1 otherwise.
 */

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

type Check = { name: string; pass: boolean; detail?: string };

const checks: Check[] = [];

function record(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
  const tag = pass ? "[PASS]" : "[FAIL]";
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`${tag} ${name}${suffix}`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `Missing required env var: ${name}. See the header comment in scripts/rls-smoke.ts.`,
    );
    process.exit(2);
  }
  return v;
}

async function signIn(
  label: string,
  email: string,
  password: string,
): Promise<{
  client: SupabaseClient;
  userId: string;
}> {
  const client = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    console.error(`Failed to sign in as ${label} (${email}): ${error?.message ?? "no user"}`);
    process.exit(2);
  }
  return { client, userId: data.user.id };
}

async function fetchFirstPet(client: SupabaseClient, label: string): Promise<string> {
  const { data, error } = await client.from("pets").select("id").limit(1);
  if (error) {
    console.error(`Setup error: account ${label} pets query failed: ${error.message}`);
    process.exit(2);
  }
  if (!data || data.length === 0) {
    console.error(
      `Setup error: account ${label} has zero pets. Sign in via the app and add at least one pet, then re-run.`,
    );
    process.exit(2);
  }
  return data[0].id as string;
}

async function fetchAnyEventForPet(client: SupabaseClient, petId: string): Promise<string | null> {
  const { data, error } = await client.from("pet_events").select("id").eq("pet_id", petId).limit(1);
  if (error) return null;
  return data && data.length > 0 ? (data[0].id as string) : null;
}

async function main() {
  const aCreds = {
    email: requireEnv("TEST_USER_A_EMAIL"),
    password: requireEnv("TEST_USER_A_PASSWORD"),
  };
  const bCreds = {
    email: requireEnv("TEST_USER_B_EMAIL"),
    password: requireEnv("TEST_USER_B_PASSWORD"),
  };

  const a = await signIn("A", aCreds.email, aCreds.password);
  const b = await signIn("B", bCreds.email, bCreds.password);

  // Pre-flight: both accounts must own at least one pet.
  const aPetId = await fetchFirstPet(a.client, "A");
  await fetchFirstPet(b.client, "B");

  // 1. B cannot read A's pet row.
  {
    const { data } = await b.client.from("pets").select("id").eq("id", aPetId);
    record("B cannot read A's pet by id", (data ?? []).length === 0);
  }

  // 2. B cannot read pet_events for A's pet.
  {
    const { data } = await b.client.from("pet_events").select("id").eq("pet_id", aPetId);
    record("B cannot read pet_events for A's pet", (data ?? []).length === 0);
  }

  // 3. B cannot read reminders for A's pet.
  {
    const { data } = await b.client.from("reminders").select("id").eq("pet_id", aPetId);
    record("B cannot read reminders for A's pet", (data ?? []).length === 0);
  }

  // 4. B cannot read attachments for A's pet.
  {
    const { data } = await b.client.from("attachments").select("id").eq("pet_id", aPetId);
    record("B cannot read attachments for A's pet", (data ?? []).length === 0);
  }

  // 5. B cannot read ownership rows for A's pet.
  {
    const { data } = await b.client.from("ownerships").select("id").eq("pet_id", aPetId);
    record("B cannot read ownerships for A's pet", (data ?? []).length === 0);
  }

  // 6. B cannot read A's notifications (the welcome notification at minimum).
  {
    const { data } = await b.client.from("notifications").select("id").eq("user_id", a.userId);
    record("B cannot read A's notifications", (data ?? []).length === 0);
  }

  // 7a. B cannot read A's profile row.
  {
    const { data } = await b.client.from("profiles").select("id").eq("id", a.userId);
    record("B cannot read A's profile", (data ?? []).length === 0);
  }

  // 7b. B can read their own profile row (positive control).
  {
    const { data } = await b.client.from("profiles").select("id").eq("id", b.userId);
    record("B can read B's own profile (positive control)", (data ?? []).length === 1);
  }

  // 8. A cannot UPDATE one of A's own pet_events rows (append-only invariant).
  // 9. A cannot DELETE one of A's own pet_events rows (append-only invariant).
  // Fail loud if no events exist — silently passing these would hide the entire
  // point of the append-only check.
  const aEventId = await fetchAnyEventForPet(a.client, aPetId);
  if (!aEventId) {
    console.error(
      "Setup error: account A's pet has zero pet_events. Add any event (e.g. a vaccination or note) via the app and re-run — the append-only checks need a real row to attempt mutating.",
    );
    process.exit(2);
  }

  {
    const { error, data } = await a.client
      .from("pet_events")
      .update({ notes: "rls-smoke attempted edit" })
      .eq("id", aEventId)
      .select("id");
    // RLS denies via "no rows returned" (no policy matched) — error may or may
    // not be set depending on the PostgREST version; the authoritative signal
    // is "zero rows affected".
    const rowsAffected = (data ?? []).length;
    record(
      "A cannot UPDATE A's own pet_events (append-only)",
      rowsAffected === 0,
      error ? `error: ${error.message}` : `rows_affected=${rowsAffected}`,
    );
  }

  {
    const { error, data } = await a.client
      .from("pet_events")
      .delete()
      .eq("id", aEventId)
      .select("id");
    const rowsAffected = (data ?? []).length;
    record(
      "A cannot DELETE A's own pet_events (append-only)",
      rowsAffected === 0,
      error ? `error: ${error.message}` : `rows_affected=${rowsAffected}`,
    );
  }

  // Wave 5 Item 26 — cross-tenant isolation checks for newly-polic'd tables.
  // 11. B cannot read pet_identifications for A's pet (RLS: owner-scoped).
  {
    const { data } = await b.client.from("pet_identifications").select("id").eq("pet_id", aPetId);
    record("B cannot read pet_identifications for A's pet", (data ?? []).length === 0);
  }

  // 12. B cannot read pet_transfers scoped to A (neither as sender nor receiver).
  {
    const { data } = await b.client
      .from("pet_transfers")
      .select("id")
      .or(`from_owner_id.eq.${a.userId},to_owner_id.eq.${a.userId}`)
      .limit(1);
    record("B cannot read pet_transfers belonging to A", (data ?? []).length === 0);
  }

  // 10. B cannot create an ownership row claiming A's pet. Catches the
  // worst-case regression: an over-broad anon/authenticated INSERT policy on
  // ownerships would let any logged-in user seize any pet.
  {
    const { error, data } = await b.client
      .from("ownerships")
      .insert({ pet_id: aPetId, owner_user_id: a.userId, role: "owner" })
      .select("id");
    const rowsAffected = (data ?? []).length;
    record(
      "B cannot create an ownership row for A's pet",
      rowsAffected === 0,
      error ? `error: ${error.message}` : `rows_affected=${rowsAffected}`,
    );
  }

  // -------------------------------------------------------------------------
  // Phase 4.2 widening (action plan 2026-05-20 §4.2):
  // Anonymous client (no signed-in user) must not read or write to any
  // owner-scoped table. The anon role is the public surface — anything that
  // leaks here leaks to the open internet. Each check uses a fresh client
  // with NO auth session.
  // -------------------------------------------------------------------------
  const anonClient = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  type AnonReadTarget = { table: string; filter?: { column: string; value: string } };
  const anonReadTargets: AnonReadTarget[] = [
    { table: "pets" },
    { table: "pet_events", filter: { column: "pet_id", value: aPetId } },
    { table: "reminders", filter: { column: "pet_id", value: aPetId } },
    { table: "attachments", filter: { column: "pet_id", value: aPetId } },
    { table: "ownerships", filter: { column: "pet_id", value: aPetId } },
    { table: "notifications", filter: { column: "user_id", value: a.userId } },
    { table: "profiles", filter: { column: "id", value: a.userId } },
    { table: "libreta_share_tokens" },
    { table: "approval_requests" },
    { table: "audit_log" },
    // Wave 5 Item 26 — new tables with policies from migration 0105.
    { table: "pet_identifications", filter: { column: "pet_id", value: aPetId } },
    { table: "pet_transfers", filter: { column: "from_owner_id", value: a.userId } },
  ];

  for (const t of anonReadTargets) {
    let query = anonClient.from(t.table).select("*").limit(1);
    if (t.filter) {
      query = anonClient.from(t.table).select("*").eq(t.filter.column, t.filter.value).limit(1);
    }
    const { data, error } = await query;
    // Pass criterion: either RLS returns an error (PostgREST 42501-style) OR
    // returns zero rows. A non-empty result is a regression.
    const rowsReturned = (data ?? []).length;
    record(
      `anon cannot read ${t.table}${t.filter ? ` (${t.filter.column}=…)` : ""}`,
      rowsReturned === 0,
      error ? `error: ${error.message}` : `rows_returned=${rowsReturned}`,
    );
  }

  // Anon write attempts. Each one targets a column set that SHOULD be denied
  // by the table's RLS INSERT policy (or by the lack of one). The threat is an
  // over-broad public INSERT policy.
  type AnonWriteAttempt = { table: string; row: Record<string, unknown>; note: string };
  const anonWriteAttempts: AnonWriteAttempt[] = [
    {
      table: "notifications",
      row: {
        user_id: a.userId,
        notification_type: "rls_smoke_anon_write",
        title: "anon-write probe",
        body: "rls-smoke",
        severity: "info",
      },
      note: "no anon role should be able to seed notifications to a real user",
    },
    {
      table: "profiles",
      row: { id: "00000000-0000-0000-0000-000000000000", display_name: "anon-profile-probe" },
      note: "no anon role should be able to create profiles",
    },
    {
      table: "ownerships",
      row: { pet_id: aPetId, owner_user_id: a.userId, role: "owner" },
      note: "no anon role should be able to seize a pet",
    },
  ];

  for (const attempt of anonWriteAttempts) {
    const { error, data } = await anonClient.from(attempt.table).insert(attempt.row).select("id");
    const rowsInserted = (data ?? []).length;
    record(
      `anon cannot write ${attempt.table} (${attempt.note})`,
      rowsInserted === 0,
      error ? `error: ${error.message}` : `rows_inserted=${rowsInserted}`,
    );
  }

  // Report.
  const failed = checks.filter((c) => !c.pass);
  console.log("");
  console.log(
    `Summary: ${checks.length - failed.length}/${checks.length} passed (${failed.length} failed).`,
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Smoke script crashed:", err);
  process.exit(2);
});
