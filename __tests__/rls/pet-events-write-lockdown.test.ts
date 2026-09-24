// RLS — `public.pet_events` has NO write surface through PostgREST.
// (Fresh-review lens A02, finding A02-1, migration
// 0212_pet_events_lock_postgrest_writes.sql.)
//
// WHAT THIS DEFENDS
// -----------------
// `pet_events` is the append-only spine (invariant #2). Every row carries its
// own provenance in three columns the rest of the product trusts without
// re-deriving: `author_role`, `author_verified` and `recorded_by_user_id`.
// `computeConfidence` (lib/events/event-confidence.ts:67-74) turns the first two
// into a trust tier — `govt` + verified → `institutional_verified`, `vet` +
// verified → `professional_verified` — which lib/domain/credential-badges.ts
// renders on the PUBLIC credential a stranger scans, and which
// lib/projections/pet-compliance.ts (`:532`) uses to tell an owner-declared dose
// from a verified one when it clears an obligation.
//
// Migration 0190 shipped an INSERT policy whose WITH CHECK pinned the PET
// (an active ownership row) and the titular-only EVENT-TYPE FAMILY, and pinned
// none of those three provenance columns — nor `event_type` against the
// EVENT_TYPES catalog, which is TEXT with no CHECK and no enum. So one request
// signed with the caller's own JWT, on the caller's OWN pet —
//   POST /rest/v1/pet_events {"pet_id":"<own>", "event_type":"vaccination_administered",
//                             "author_role":"govt", "author_verified":true}
// — minted a row claiming a sanitary authority wrote it. And it minted it
// PERMANENTLY: this table has no UPDATE and no DELETE policy, the append-only
// trigger refuses both for everyone, and invariant #2 forbids deletion. The
// forgery can be contradicted, never retracted.
//
// Nothing else covered it: no BEFORE INSERT trigger pairs `author_role` with the
// caller's real account, no CHECK constrains it, `validateEventPayload` and the
// EVENT_TYPES union are TypeScript and never run on the PostgREST path, and
// `applySchemaGrants` (scripts/deploy-provision.ts) re-grants ALL on every
// public table to `authenticated` on every provision, so a column REVOKE undoes
// itself. write-path-matrix.test.ts could not see it either — its heuristic is
// "UNCONDITIONAL clause", and this WITH CHECK was three conjuncts deep. The
// defect was which COLUMNS the clause omitted, not whether a clause existed:
// the same blind spot that hid the `profiles` hole 0211 closed.
//
// WHY DENY-ALL AND NOT A NARROWER POLICY: every legitimate append is
// `db.insert(petEvents)` / `tx.insert(petEvents)` through `EventsRepository`
// over the Drizzle BYPASSRLS connection, which never consults RLS;
// `/api/v1/pets/[publicToken]/events` is a server route over that same
// connection; `apps/mobile` reaches the server only through `/api/v1` (PO
// decision #2, whose stated reason IS this hole — apps/mobile/src/config/
// api.ts:20-26). Zero legitimate writers reach `pet_events` through PostgREST —
// the only PostgREST callers anywhere in the tree are SELECT probes
// (e2e/cross-tenant-isolation.spec.ts:440,498; scripts/rls-smoke.ts:87,117;
// __tests__/rls/matrix.test.ts:865,885). So the attack probes below and the
// legitimate-path probes are not in tension: the first prove PostgREST is shut,
// the last prove the real append path is untouched.
//
// THIS DOES NOT NARROW THE CARETAKER. 0190's header says a caretaker must be
// able to record medical events, and that stays true — they record them through
// the app, which writes over Drizzle after `requirePetAccess` authorized them.
// What narrows is the bearer token, not the role.
//
// PRE-FLIGHT: local Supabase stack. This file provisions its OWN ephemeral owner
// (admin SDK + the handle_new_user trigger) and its OWN pet, so no assertion
// depends on seed drift, and it tears both down in afterAll. A setup failure
// THROWS — it never degrades to a green skip (see matrix.test.ts P2.8 for why
// that rule exists).

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, notifications, ownerships, petEvents, pets, profiles } from "@/db";
import { setAuditMutationGucs, withMutationOverride } from "../_helpers/db-overrides";
import { createFreshTestUser } from "../_helpers/fresh-test-user";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const OWNER_EMAIL = "pet-events-lockdown-owner@dim-test.local";
const OWNER_PASSWORD = "PetEventsLockdown_2026!";
const PET_TOKEN = "DIM-PELD-0001";

let ownerClient: SupabaseClient | null = null;
let ownerUserId = "";
let petId = "";
let seedEventId = "";
let setupError: string | null = null;

function adminSdk(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function deleteFixture(): Promise<void> {
  // pet_events is append-only by trigger (db/triggers.sql); teardown needs the
  // documented escape hatch with an accountable actor.
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM pet_events WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
    );
  });
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await db.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);

  const admin = adminSdk();
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === OWNER_EMAIL);
  if (!found) return;

  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.delete(auditLog).where(eq(auditLog.actorUserId, found.id));
    await tx.delete(auditLog).where(eq(auditLog.targetUserId, found.id));
  });
  await db.delete(notifications).where(eq(notifications.userId, found.id));
  await db.delete(profiles).where(eq(profiles.id, found.id));
  await admin.auth.admin.deleteUser(found.id);
}

/**
 * A PostgREST credential that never reached a policy returns an empty result
 * too — and an empty result is exactly what the UPDATE/DELETE probes below read
 * as "denied". Scoring a rejected key as a denial is how the anon row of the RLS
 * matrix passed for months without evaluating a policy (matrix.test.ts:704).
 */
function assertCredentialReachedRls(error: { code?: string; message: string } | null): void {
  if (!error) return;
  const credentialRejected =
    error.code?.startsWith("PGRST30") || /JWT|API key/i.test(error.message);
  if (!credentialRejected) return;
  throw new Error(
    `The pet_events probe never reached a policy — PostgREST rejected the CREDENTIAL (${error.code ?? "no code"}: ${error.message}). This is NOT a denial. Check NEXT_PUBLIC_SUPABASE_ANON_KEY against \`supabase status -o env\`.`,
  );
}

function client(): SupabaseClient {
  if (setupError) throw new Error(setupError);
  if (!ownerClient) throw new Error("owner client not provisioned");
  return ownerClient;
}

/** Ground truth: Drizzle bypasses RLS, so this is what actually landed. */
async function countEvents(): Promise<number> {
  const rows = await db
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(eq(petEvents.petId, petId));
  return rows.length;
}

async function readSeedEvent() {
  const [row] = await db
    .select({
      eventType: petEvents.eventType,
      authorRole: petEvents.authorRole,
      authorVerified: petEvents.authorVerified,
      notes: petEvents.notes,
    })
    .from(petEvents)
    .where(eq(petEvents.id, seedEventId));
  if (!row) throw new Error(`seed event ${seedEventId} vanished mid-test`);
  return row;
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    setupError =
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing — no PostgREST to probe.";
    throw new Error(setupError);
  }

  await deleteFixture();

  const created = await createFreshTestUser(adminSdk(), {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    setupError = `createUser(${OWNER_EMAIL}) failed: ${created.error?.message ?? "no user"}`;
    throw new Error(setupError);
  }
  ownerUserId = created.data.user.id;

  const [pet] = await db
    .insert(pets)
    .values({ publicToken: PET_TOKEN, name: "Pampa lockdown", species: "dog" })
    .returning({ id: pets.id });
  petId = pet.id;

  // A plain, active, NON-caretaker ownership — the exact shape 0190's WITH
  // CHECK admitted. If the attack probes below pass against a caller that could
  // not have satisfied the old policy, they prove nothing.
  await db.insert(ownerships).values({ petId, ownerUserId, role: "owner" });

  const [seed] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "note_added",
      occurredAt: new Date(),
      recordedByUserId: ownerUserId,
      payload: { text: "pet-events lockdown fixture" },
      notes: "seed",
    })
    .returning({ id: petEvents.id });
  seedEventId = seed.id;

  ownerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authErr } = await ownerClient.auth.signInWithPassword({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
  });
  if (authErr || !auth.user) {
    setupError = `sign-in failed for ${OWNER_EMAIL}: ${authErr?.message ?? "no user"}`;
    throw new Error(setupError);
  }

  // ANTI-VACUITY GATE. The UPDATE/DELETE probes read "zero rows" as "denied",
  // so the session has to be proven capable of returning a row FIRST — through
  // the SELECT policy, on this exact table, with this exact key. It also proves
  // the ownership fixture really is visible to RLS, which is what made the old
  // INSERT policy's first two conjuncts pass.
  const { data: seen, error: seenErr } = await ownerClient
    .from("pet_events")
    .select("id")
    .eq("pet_id", petId);
  assertCredentialReachedRls(seenErr);
  if ((seen ?? []).length < 1) {
    setupError = `the signed-in owner cannot read its OWN pet's events through PostgREST (rows=${(seen ?? []).length}) — every deny assertion in this file would be vacuous.`;
    throw new Error(setupError);
  }
}, 30_000);

afterAll(async () => {
  await deleteFixture();
});

describe("pet_events — PostgREST write surface is closed (migration 0212)", () => {
  it("has NO INSERT / UPDATE / DELETE policy reachable by anon or authenticated", async () => {
    const rows = (await db.execute(sql`
      select p.policyname, p.cmd, array_to_string(p.roles, ',') as roles
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = 'pet_events'
        and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    `)) as unknown as Array<{ policyname: string; cmd: string; roles: string }>;

    const reachable = rows.filter((r) =>
      r.roles
        .split(",")
        .map((x) => x.trim())
        .some((x) => x === "anon" || x === "authenticated" || x === "public"),
    );
    expect(
      reachable,
      `pet_events is the append-only spine and carries its own provenance (author_role/author_verified), which credential-badges and pet-compliance read as a trust verdict. A write policy here is a self-issued sanitary credential, and there is no UPDATE or DELETE to take it back. Offenders: ${reachable
        .map((r) => `${r.policyname} (${r.cmd}, ${r.roles})`)
        .join("; ")}`,
    ).toEqual([]);
  });

  it("keeps its correctly-scoped SELECT policy (the lockdown is writes-only)", async () => {
    const rows = (await db.execute(sql`
      select p.policyname, p.qual
      from pg_policies p
      where p.schemaname = 'public' and p.tablename = 'pet_events' and p.cmd = 'SELECT'
        and p.permissive = 'PERMISSIVE'
    `)) as unknown as Array<{ policyname: string; qual: string | null }>;
    // Counted PERMISSIVE only: migration 0231's RESTRICTIVE "institutional
    // sessions require aal2" narrows this one and grants nothing on its own.
    expect(rows.length, "pet_events lost its SELECT policy too — that is over-correction").toBe(1);
    expect(rows[0].qual ?? "").toContain("auth.uid()");
  });

  // -------------------------------------------------------------------------
  // ATTACK — the reachable-today forged provenance
  // -------------------------------------------------------------------------
  //
  // NOTE on the shape of the denials. They differ by command and both shapes
  // are asserted deliberately:
  //   · A denied INSERT IS an error (42501), because with no INSERT policy the
  //     produced row satisfies no WITH CHECK.
  //   · A denied UPDATE/DELETE is NOT an error: RLS removes the row from the
  //     statement's USING scope, so PostgREST reports SUCCESS over ZERO rows.
  //     Row count plus the ground-truth read are what prove those denials.

  it("rejects a forged govt-verified vaccination on the caller's OWN pet", async () => {
    const before = await countEvents();
    const { error } = await client()
      .from("pet_events")
      .insert({
        pet_id: petId,
        event_type: "vaccination_administered",
        occurred_at: new Date().toISOString(),
        recorded_by_user_id: ownerUserId,
        author_role: "govt",
        author_verified: true,
        author_organization_id: null,
        payload: { vaccine: "antirrabica" },
      })
      .select("id");

    assertCredentialReachedRls(error);
    // 42501 = insufficient_privilege, which is what a missing INSERT policy
    // raises on the produced row.
    expect(error?.code, "PostgREST accepted a forged institutional event").toBe("42501");
    expect(
      await countEvents(),
      "a forged govt-verified row landed in the append-only spine — it cannot be deleted",
    ).toBe(before);
  });

  it("rejects a forged vet-verified event (the professional_verified tier)", async () => {
    const before = await countEvents();
    const { error } = await client()
      .from("pet_events")
      .insert({
        pet_id: petId,
        event_type: "vet_visit_logged",
        occurred_at: new Date().toISOString(),
        recorded_by_user_id: ownerUserId,
        author_role: "vet",
        author_verified: true,
        payload: {},
      })
      .select("id");

    assertCredentialReachedRls(error);
    expect(error?.code, "PostgREST accepted a forged professional event").toBe("42501");
    expect(await countEvents()).toBe(before);
  });

  it("rejects an event_type that is not in the catalog at all", async () => {
    // `event_type` is TEXT with no CHECK and no enum (db/schema.ts). The old
    // policy never compared it to EVENT_TYPES — validateEventPayload is
    // TypeScript and never ran on this path. Deny-all is what closes that too.
    const before = await countEvents();
    const { error } = await client()
      .from("pet_events")
      .insert({
        pet_id: petId,
        event_type: "not_a_real_event_type",
        occurred_at: new Date().toISOString(),
        payload: {},
      })
      .select("id");

    assertCredentialReachedRls(error);
    expect(error?.code, "PostgREST accepted an event type outside the catalog").toBe("42501");
    expect(await countEvents()).toBe(before);
  });

  it("rejects even an honestly-shaped owner event — the whole surface is shut", async () => {
    // This one pins the SHAPE of the remedy, not just its effect. The narrower
    // fix that was considered (AND `author_role = 'owner' AND author_verified =
    // false AND recorded_by_user_id = auth.uid()`) would leave this green while
    // the deny-all this file asserts is gone. It also documents the trade: the
    // owner's real "add a note" path writes through Drizzle, and the last test
    // in this file proves it still does.
    const before = await countEvents();
    const { error } = await client()
      .from("pet_events")
      .insert({
        pet_id: petId,
        event_type: "note_added",
        occurred_at: new Date().toISOString(),
        recorded_by_user_id: ownerUserId,
        author_role: "owner",
        author_verified: false,
        payload: { text: "honest but still not this path" },
      })
      .select("id");

    assertCredentialReachedRls(error);
    expect(error?.code, "the PostgREST INSERT surface is still open").toBe("42501");
    expect(await countEvents()).toBe(before);
  });

  it("rejects UPDATEing an existing own event's provenance (append-only, and no policy)", async () => {
    const { data, error } = await client()
      .from("pet_events")
      .update({ author_role: "govt", author_verified: true })
      .eq("id", seedEventId)
      .select("id");

    assertCredentialReachedRls(error);
    // With no UPDATE policy, RLS removes the row from the statement's scope and
    // PostgREST reports SUCCESS over ZERO rows — the append-only trigger never
    // even fires. A 42501 here would mean the GRANT is missing, not the policy:
    // grants are volatile (re-applied on every provision), so that would be a
    // false green for the remedy under test.
    expect(error?.message ?? null, "unexpected PostgREST error shape").toBeNull();
    expect((data ?? []).length, "PostgREST applied a provenance rewrite").toBe(0);
    const after = await readSeedEvent();
    expect(after.authorRole, "an existing event was re-attributed to govt").toBe("owner");
    expect(after.authorVerified, "an existing event was marked verified").toBe(false);
  });

  it("rejects DELETEing an own event (invariant #2)", async () => {
    const before = await countEvents();
    const { data, error } = await client()
      .from("pet_events")
      .delete()
      .eq("id", seedEventId)
      .select("id");

    assertCredentialReachedRls(error);
    expect(error?.message ?? null, "unexpected PostgREST error shape").toBeNull();
    expect((data ?? []).length, "PostgREST deleted a row from the append-only spine").toBe(0);
    expect(await countEvents()).toBe(before);
  });

  // -------------------------------------------------------------------------
  // LEGITIMATE PATHS — a policy that denies everything is not a fix
  // -------------------------------------------------------------------------

  it("still lets the owner READ their own pet's events through PostgREST", async () => {
    const { data, error } = await client()
      .from("pet_events")
      .select("id,event_type")
      .eq("pet_id", petId);
    expect(error).toBeNull();
    expect(
      (data ?? []).length,
      "own-pet event read broke — the SELECT policy was collateral",
    ).toBeGreaterThan(0);
  });

  it("still appends through the SERVER path (Drizzle, the BYPASSRLS connection)", async () => {
    // This is the connection every use case, every server action and
    // /api/v1/.../events writes over — `EventsRepository` on `db` from `@/db`.
    // The use cases' own value-add is validation, which no policy can affect;
    // what a policy change CAN break is the connection, and that is what this
    // asserts. If this ever goes red, the lockdown reached past PostgREST.
    const before = await countEvents();
    const [appended] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "weight_recorded",
        occurredAt: new Date(),
        recordedByUserId: ownerUserId,
        payload: { kg: "12.5" },
      })
      .returning({ id: petEvents.id, authorRole: petEvents.authorRole });

    if (!appended) throw new Error("the server-side append did not land");
    expect(await countEvents()).toBe(before + 1);
    // The column defaults still describe an owner-written row honestly — the
    // forgery the policy admitted was the caller OVERRIDING these.
    expect(appended.authorRole).toBe("owner");
  });

  it("still lets the SERVICE ROLE write through PostgREST (it bypasses RLS)", async () => {
    // The admin SDK is how server-side infrastructure reaches PostgREST when it
    // does. service_role is BYPASSRLS, so dropping a policy must not touch it —
    // and if this went red, the cause would be a GRANT, not a policy.
    const before = await countEvents();
    const { data, error } = await adminSdk()
      .from("pet_events")
      .insert({
        pet_id: petId,
        event_type: "note_added",
        occurred_at: new Date().toISOString(),
        payload: { text: "service-role append" },
      })
      .select("id");

    expect(error?.message ?? null, "the service role lost its write path").toBeNull();
    expect((data ?? []).length).toBe(1);
    expect(await countEvents()).toBe(before + 1);
  });
});
