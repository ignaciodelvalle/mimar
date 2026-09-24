// RLS soft-delete read surface — "the other half" the suppression epic declared
// and nobody ever probed.
// ============================================================================
//
// WHY THIS FILE EXISTS. Four fences of the suppression epic carry the same
// sentence, verbatim:
//
//     "RLS IS THE OTHER HALF. This is a static check over application queries;
//      it says nothing about what a direct PostgREST client can read."
//
// Every one of those checks reasons about queries the APPLICATION writes. None
// of them touches the PostgREST surface, where RLS — not application code — is
// the only thing standing between a `deleted_at`-marked row and a reader. On
// 2026-08-29 `rg 'deleted_at|deletedAt' __tests__/rls/` returned ZERO across the
// whole directory: twenty commits of suppression work, and the half they all
// named had never been measured once.
//
// This file measures it. It probes the LIVE local Supabase stack through
// supabase-js (which IS subject to RLS) against a pet in exactly the state
// `erase_subject_data` leaves behind, and it records what each role can read.
//
// ----------------------------------------------------------------------------
// WHAT THE MEASUREMENT FOUND (2026-08-29) — READ THIS BEFORE EDITING
// ----------------------------------------------------------------------------
//
// NOT ONE read policy over the six `deleted_at`-bearing tables (profiles, pets,
// pet_caretaker_grants, custody_disputes, pet_identifications, pet_tags)
// mentions `deleted_at`. Introspected from pg_policies; the count of policies
// whose USING clause references the column is ZERO. RLS therefore does not
// implement any part of the suppression epic, and three reads survive:
//
// THE ZERO IS THE CLAIM, AND IT IS THE ONE THIS FILE FENCES — section 5 below
// runs the introspection and fails on the first policy that gains the
// predicate. The population it is zero OUT OF is a measurement, dated, and is
// deliberately not restated as a live count anywhere in this header: re-derive
// it by running that query rather than by trusting this paragraph.
//
//   PRECISION NOTE, 2026-09-09 — "mentions `deleted_at`" means the PROTECTED
//   TABLE'S OWN `deleted_at`. Migration 0215 added `p.deleted_at IS NULL` to
//   the admin branches of `custody_disputes select by parties and authorities`
//   and `pet_identifications read by admin`, where `p` is `profiles` — the
//   ACTOR. That predicate says an erased administrator is not an administrator;
//   it says nothing about whether the dispute or the identification is
//   soft-deleted, and FINDING 2 is exactly as open after 0215 as before it. The
//   section 5 assertion used to match any `deleted_at` in a policy's text and
//   went red on those two; it now discounts references bound to `profiles` and
//   matches only the protected row's column. The zero is still zero.
//
//   Measured 2026-08-29 against the local stack, from the section 5 query
//   (`p.cmd in ('SELECT','ALL')` joined to the columns carrying `deleted_at`):
//   EIGHT read policies, all of them `SELECT` — there is no `ALL` policy on
//   these tables today — spread over all six tables, and ZERO of the eight
//   name the column.
//
//   This paragraph said "the 10 SELECT policies" until 2026-08-29 and that was
//   wrong twice over: ten was every policy on those tables regardless of
//   command, and the two that made up the difference were `Pets updatable by
//   active owner` and `Profiles updatable by self` — both UPDATE, neither one
//   a read. The finding does not change (zero is zero), but a reader checking
//   the claim would have counted ten rows out of a query that returns eight
//   and had no way to tell which of the two was wrong.
//
//   `Profiles updatable by self` NO LONGER EXISTS: migration 0211 dropped it
//   (a row-scoped, column-blind UPDATE policy let a caller PATCH their own
//   `role`/`account_type` through PostgREST — see
//   __tests__/rls/profiles-write-lockdown.test.ts). The paragraph above is
//   kept as the 2026-08-29 record of how the ten was miscounted; the live
//   population is one policy smaller. Section 5 still returns the same EIGHT
//   read policies — dropping an UPDATE policy cannot change a count of reads.
//
//   NOT PINNED, AND SAY SO: section 5 asserts `rows.length > 0` as an
//   anti-vacuous guard, never `=== 8`. So this eight can rot the way the ten
//   did — a seventh read policy would not turn anything red. Pinning it is a
//   one-line change to that assertion and belongs to whoever next owns the
//   body of this file; the lane that corrected this header was scoped to the
//   header alone and did not make it.
//
//   FINDING 1 — `pets`, role `authenticated` as the ACTIVE OWNER.
//     Policy "Pets readable by active owner" is
//       EXISTS (ownerships o WHERE o.pet_id = pets.id
//                              AND o.owner_user_id = auth.uid()
//                              AND o.ended_at IS NULL)
//     `erase_subject_data` (migration 0059) sets `pets.deleted_at` and DOES NOT
//     touch `ownerships.ended_at` — erase-subject-data.ts says so in as many
//     words ("ownerships rows survive the RPC (only pets are soft-deleted)").
//     So the predicate still matches after erasure and the row reads exactly
//     like a live one. MEASURED: 1 row.
//
//   FINDING 2 — `pet_identifications`, role `authenticated` as ADMIN. THE MICROCHIP.
//     Policy "pet_identifications read by admin" is
//       EXISTS (profiles p WHERE p.id = auth.uid()
//                            AND p.role = 'admin' AND p.deactivated_at IS NULL)
//     — no ownership, no jurisdiction, and no `deleted_at`. It serves the
//     identification rows of EVERY soft-deleted pet in the system. This is the
//     same PII class the epic had just ruled a genuine leak on the application
//     side: commit 71053a49a's parent, "en gob y admin no toda lectura de una
//     mascota borrada es fuga, pero la del microchip sí lo era". The app-side
//     guard landed; the RLS side never did. MEASURED: 1 row.
//
//   FINDING 3 — `pet_tags`, role `authenticated` as the ACTIVE OWNER. The one
//     that shows this is a PATTERN and not two oversights. Migration 0170 goes
//     out of its way to NULL `pet_tags.activated_by_user_id` during erasure —
//     an explicit, deliberate severing of the erased user from the tag. But
//     "pet_tags select own" has a SECOND branch:
//       activated_by_user_id = auth.uid()
//       OR pet_id IN (SELECT o.pet_id FROM ownerships o
//                     WHERE o.owner_user_id = auth.uid() AND o.ended_at IS NULL)
//     and the same RPC never ends the ownership, so the second branch still
//     matches. The severing the migration performs is undone by the policy it
//     was never checked against. MEASURED: 1 row.
//
// A FOURTH result that looks like a pass and is NOT one: `anon` reads zero rows
// from both tables. That zero has NOTHING to do with soft-delete — anon reads
// zero from a LIVE pet too, because no `pets` policy names the anon role at all.
// Scoring it as "suppression works for anon" is the exact false green this repo
// keeps rediscovering, so every anon assertion below is PAIRED with its live
// control and the pairing is the assertion.
//
// ----------------------------------------------------------------------------
// WHY THE FINDING TESTS ASSERT THE LEAK INSTEAD OF FAILING
// ----------------------------------------------------------------------------
//
// These are CHARACTERIZATION tests, and the direction is deliberate. Writing a
// policy was explicitly out of scope for the lane that measured this: a badly
// written RLS policy is worse than a missing one, and `pets`' owner-read is load
// bearing for the entire owner app — narrowing it without a migration, a
// re-derivation plan for `ownerships.ended_at`, and a PO decision on whether an
// erasure subject may see their own erased pet is how you take the product down
// to close a leak nobody had triaged yet.
//
// THAT IS NOT AN ABSTRACT WORRY — IT WAS MEASURED WHILE WRITING THIS FILE. The
// obvious fix for FINDING 2, adding
//     AND EXISTS (SELECT 1 FROM pets pt
//                 WHERE pt.id = pet_identifications.pet_id AND pt.deleted_at IS NULL)
// to the admin policy, was applied to a scratch database and it broke admin's
// read of LIVE identifications too — every one of them. The subquery is
// evaluated as the CALLING user, `pets` carries its own RLS, and there is no
// `pets` read policy for admin, so the join yields zero rows for a live pet and
// a deleted one alike. This is the same mechanism matrix-govt-jurisdiction.test.ts
// documents for R1. Any real fix has to reach the pet's state WITHOUT a
// naive RLS-gated subquery — a SECURITY DEFINER helper, or a denormalised
// column. Whoever picks this up: that is the trap, and it is one ALTER POLICY
// away from looking correct.
//
// So the finding is PINNED instead: the assertions below say `1`, which is what
// the database does today. The moment someone adds `deleted_at IS NULL` to
// any of the three policies, THESE TESTS GO RED and name the finding they
// belong to. That is
// the intended trigger, not a regression — update the expectation to 0, move the
// finding to "closed", and keep the positive controls. A green run of this file
// means "the gap is exactly as described above", never "the gap is closed".
//
// ----------------------------------------------------------------------------
// THE POSITIVE CONTROL IS NOT OPTIONAL
// ----------------------------------------------------------------------------
//
// The classic false green for a deny-probe is a fixture that was never written:
// zero rows because the INSERT failed, scored as "RLS denied it". Every denial
// assertion in this file is therefore gated behind two controls that run first —
// service_role (BYPASSRLS) SEES the fixture row, and the row really carries
// `deleted_at IS NOT NULL`. Without both, a zero downstream proves nothing.
//
// Pre-flight: `pnpm seed:test` (owner@dim.test, vet@dim.test, admin@dim.test).

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petIdentifications, petTags, pets } from "@/db";

import { elevateToAal2 } from "../_helpers/aal2-session";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SHARED_PASSWORD = "Test1234!";

/** A locality no seeded govt operator is assigned to — keeps the govt read
 *  policies out of the picture so each result has exactly one explanation. */
const FIXTURE_PROVINCE = "Córdoba";
const FIXTURE_LOCALITY = "RLS-SOFTDELETE-PROBE";

let anonClient: SupabaseClient | null = null;
let ownerClient: SupabaseClient | null = null;
let otherClient: SupabaseClient | null = null;
let adminClient: SupabaseClient | null = null;
let setupError: string | null = null;

/** The pet in the post-erasure state: `deleted_at` set, ownership still active. */
let deletedPetId: string | null = null;
/** The same shape with no `deleted_at` — the control that gives every zero meaning. */
let livePetId: string | null = null;
let deletedIdentificationId: string | null = null;
let liveIdentificationId: string | null = null;
/** A tag on the soft-deleted pet, in the state migration 0170 leaves: the RPC
 *  NULLs `activated_by_user_id`, so only the ownership branch can still match. */
let deletedTagId: string | null = null;

function setupFailureMessage(cause: string): string {
  return `soft-delete RLS surface setup FAILED — refusing to report a read surface nothing probed. Cause: ${cause}`;
}

async function signIn(email: string): Promise<SupabaseClient | null> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: SHARED_PASSWORD,
  });
  if (error || !data.user) {
    setupError = `sign-in failed for ${email}: ${error?.message ?? "no user"}. Run \`pnpm seed:test\`.`;
    return null;
  }
  return client;
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    setupError =
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing — the harness cannot reach PostgREST, so no policy can be probed. Load the local env (`npx supabase status -o env`) before believing any result here.";
    throw new Error(setupFailureMessage(setupError));
  }

  anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  ownerClient = await signIn("owner@dim.test");
  otherClient = await signIn("vet@dim.test");
  adminClient = await signIn("admin@dim.test");
  if (setupError) throw new Error(setupFailureMessage(setupError));
  // The admin (and govt) sessions here are the LEGITIMATE institutional path,
  // which since T2-S6 is a password plus a second factor; an aal1 institutional
  // token is what migration 0231 refuses (pinned in erased-admin-authority).
  await elevateToAal2(adminClient as SupabaseClient);

  const { data: ownerAuth } = await (ownerClient as SupabaseClient).auth.getUser();
  const ownerUserId = ownerAuth.user?.id;
  if (!ownerUserId) {
    setupError = "owner@dim.test signed in but has no user id";
    throw new Error(setupFailureMessage(setupError));
  }

  const suffix = Date.now().toString(36).toUpperCase();

  // Both pets are provisioned through Drizzle (service role, BYPASSRLS) so the
  // fixture state is exact. The ONLY difference between them is `deleted_at` —
  // that is what makes the live pet a control rather than a second data point.
  const [livePet] = await db
    .insert(pets)
    .values({
      publicToken: `DIM-SDLIVE-${suffix}`,
      name: "RLS soft-delete probe — LIVE control",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: FIXTURE_PROVINCE,
      jurisdictionLocality: FIXTURE_LOCALITY,
    })
    .returning({ id: pets.id });
  livePetId = livePet.id;

  const [deletedPet] = await db
    .insert(pets)
    .values({
      publicToken: `DIM-SDDEAD-${suffix}`,
      name: "RLS soft-delete probe — SOFT DELETED",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: FIXTURE_PROVINCE,
      jurisdictionLocality: FIXTURE_LOCALITY,
      // The whole point. `erase_subject_data` marks the pet and leaves the
      // ownership row alone; the insert below reproduces that pairing exactly.
      deletedAt: new Date(),
    })
    .returning({ id: pets.id });
  deletedPetId = deletedPet.id;

  // ACTIVE ownership on BOTH — `ended_at` stays NULL, which is precisely what
  // migration 0059 does (it never touches ownerships) and precisely what keeps
  // the owner-read policy matching after erasure.
  for (const petId of [livePetId, deletedPetId]) {
    await db.insert(ownerships).values({ petId, ownerUserId, role: "owner" });
  }

  // collar_tag, not `microchip`: chip_requires_iso_fields would demand ISO
  // metadata this probe has no use for. The POLICY does not branch on `kind` —
  // it serves the whole table — so a collar_tag row exercises the identical
  // read path the microchip travels. (Same choice, same reason, as the fixtures
  // in matrix.test.ts and matrix-govt-jurisdiction.test.ts.)
  const [deletedIdent] = await db
    .insert(petIdentifications)
    .values({
      petId: deletedPetId,
      kind: "collar_tag",
      code: `SD-PROBE-DEAD-${suffix}`,
      status: "active",
      recordedAt: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: petIdentifications.id });
  deletedIdentificationId = deletedIdent.id;

  const [liveIdent] = await db
    .insert(petIdentifications)
    .values({
      petId: livePetId,
      kind: "collar_tag",
      code: `SD-PROBE-LIVE-${suffix}`,
      status: "active",
      recordedAt: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: petIdentifications.id });
  liveIdentificationId = liveIdent.id;

  // `activated_by_user_id: null` is the load-bearing detail, not tidiness. The
  // erase RPC (migration 0170, lines 420-426) deliberately NULLs that column to
  // sever the erased user from the tag. This fixture reproduces the state AFTER
  // that severing, so a read here cannot come from the `activated_by_user_id =
  // auth.uid()` branch — only from the ownership branch, which is the point.
  const [deletedTag] = await db
    .insert(petTags)
    .values({
      serial: `TAG-SDPROBE-${suffix}`,
      activationCodeHash: `rls-soft-delete-probe-${suffix}`,
      status: "active",
      petId: deletedPetId,
      activatedByUserId: null,
      activatedAt: new Date(),
    })
    .returning({ id: petTags.id });
  deletedTagId = deletedTag.id;
});

afterAll(async () => {
  for (const client of [ownerClient, otherClient, adminClient]) {
    await client?.auth.signOut().catch(() => {});
  }
  if (deletedTagId) {
    await db
      .delete(petTags)
      .where(eq(petTags.id, deletedTagId))
      .catch(() => {});
  }
  const identIds = [deletedIdentificationId, liveIdentificationId].filter(
    (id): id is string => id !== null,
  );
  if (identIds.length > 0) {
    await db
      .delete(petIdentifications)
      .where(inArray(petIdentifications.id, identIds))
      .catch(() => {});
  }
  const petIds = [deletedPetId, livePetId].filter((id): id is string => id !== null);
  if (petIds.length > 0) {
    await db
      .delete(ownerships)
      .where(inArray(ownerships.petId, petIds))
      .catch(() => {});
    await db
      .delete(pets)
      .where(inArray(pets.id, petIds))
      .catch(() => {});
  }
});

/**
 * Rows visible to `client` for one row id — but ONLY when PostgREST actually
 * evaluated a policy.
 *
 * A real denial is `200 []`. A rejected credential is `401` with no rows, and
 * both arrive here as zero. Scoring the second as a denial is how the anon row
 * of the sibling matrix passed for months against a placeholder anon key
 * (matrix.test.ts documents the incident). This file leans on anon zeros to
 * describe a security boundary, so it refuses the input rather than trusting it.
 */
async function rowCount(client: SupabaseClient, table: string, id: string): Promise<number> {
  const { data, error } = await client.from(table).select("id").eq("id", id).limit(1);
  if (error && (error.code?.startsWith("PGRST30") || /JWT|API key/i.test(error.message))) {
    const detail = `${error.code ?? "no code"}: ${error.message}`;
    throw new Error(
      `Probe of ${table} never reached a policy — PostgREST rejected the CREDENTIAL (${detail}). Zero rows here would be scored as "suppression works" while nothing was evaluated. Fix NEXT_PUBLIC_SUPABASE_ANON_KEY (\`npx supabase status -o env\`).`,
    );
  }
  return data?.length ?? 0;
}

function requireFixture<T>(value: T | null, what: string): T {
  // Backstop, not the primary gate — beforeAll already threw. Never a `return`:
  // a probe that cannot run must not report a pass. `setupError` is mutable
  // module state, so this is what stops a future edit from reintroducing a soft
  // path and turning these assertions back into unconditional greens.
  if (setupError) throw new Error(setupFailureMessage(setupError));
  if (value === null) throw new Error(setupFailureMessage(`${what} was never provisioned`));
  return value;
}

// ---------------------------------------------------------------------------
// 1. Positive controls. Everything below them is meaningless without these.
// ---------------------------------------------------------------------------

describe("soft-delete RLS probe — positive controls (the fixture is real)", () => {
  it("setup ran without errors — otherwise every assertion below is meaningless", () => {
    expect(setupError, setupError ? setupFailureMessage(setupError) : undefined).toBeNull();
  });

  it("service_role SEES the soft-deleted pet, and it really is soft-deleted", async () => {
    const petId = requireFixture(deletedPetId, "soft-deleted pet fixture");
    // Two things at once, on purpose. `rows === 1` kills "the INSERT silently
    // failed and the denials below are measuring an absent row"; the
    // `isNotNull(deletedAt)` filter kills the subtler twin — a row that exists
    // but was never marked, which would make every reader below correct to
    // serve it and the whole file a tautology.
    const rows = await db.select({ id: pets.id }).from(pets).where(eq(pets.id, petId)).limit(1);
    expect(rows.length, "the soft-deleted fixture pet does not exist at all").toBe(1);

    const marked = await db
      .select({ id: pets.id })
      .from(pets)
      .where(and(eq(pets.id, petId), isNotNull(pets.deletedAt)))
      .limit(1);
    expect(
      marked.length,
      "the fixture pet exists but deleted_at is NULL — every 'suppressed' verdict below would be measuring a LIVE pet",
    ).toBe(1);
  });

  it("service_role SEES the identification row attached to the soft-deleted pet", async () => {
    const identId = requireFixture(deletedIdentificationId, "soft-deleted identification fixture");
    const rows = await db
      .select({ id: petIdentifications.id })
      .from(petIdentifications)
      .where(eq(petIdentifications.id, identId))
      .limit(1);
    expect(rows.length, "the identification fixture does not exist — no PII to leak").toBe(1);
  });

  it("the soft-deleted pet's ownership is STILL ACTIVE (this is what keeps the policy matching)", async () => {
    const petId = requireFixture(deletedPetId, "soft-deleted pet fixture");
    // Not decoration: FINDING 1 is only interesting because `erase_subject_data`
    // leaves `ended_at` NULL. If a future migration DID end the ownership, the
    // owner read would close on its own and this file's story would change — so
    // the premise is asserted rather than assumed.
    const active = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)))
      .limit(1);
    expect(
      active.length,
      "the fixture no longer reproduces the post-erasure state (erase_subject_data does NOT end ownerships)",
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. FINDING 1 — `pets` is readable by its owner after soft-delete.
// ---------------------------------------------------------------------------

describe("FINDING 1 — a soft-deleted pet still reads through PostgREST for its owner", () => {
  it("owner (authenticated, active ownership) READS the soft-deleted pet — OPEN FINDING, expected 1", async () => {
    const client = requireFixture(ownerClient, "owner client");
    const petId = requireFixture(deletedPetId, "soft-deleted pet fixture");
    expect(
      await rowCount(client, "pets", petId),
      'OPEN FINDING pinned: "Pets readable by active owner" carries no deleted_at predicate, and erase_subject_data leaves ownerships.ended_at NULL. If this now reads 0, someone closed the gap — update this file\'s header and flip the expectation, do not "fix" the test.',
    ).toBe(1);
  });

  it("owner READS the LIVE pet too — the control that proves the probe is wired to the policy", async () => {
    const client = requireFixture(ownerClient, "owner client");
    const petId = requireFixture(livePetId, "live control pet fixture");
    // Without this, a `1` above could be an artifact of a probe that returns
    // rows for anything. With it, the pair says the policy treats the two
    // states IDENTICALLY, which is the actual finding.
    expect(await rowCount(client, "pets", petId)).toBe(1);
  });

  it("other_user is denied the soft-deleted pet — and denied the LIVE one too, so this is NOT suppression", async () => {
    const client = requireFixture(otherClient, "other_user client");
    const deleted = requireFixture(deletedPetId, "soft-deleted pet fixture");
    const live = requireFixture(livePetId, "live control pet fixture");
    expect(await rowCount(client, "pets", deleted)).toBe(0);
    expect(
      await rowCount(client, "pets", live),
      "other_user reads the LIVE pet — then its zero on the deleted pet WOULD have been a soft-delete fence, and this file's reasoning needs redoing",
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. FINDING 2 — the microchip surface. The one the epic already called a leak.
// ---------------------------------------------------------------------------

describe("FINDING 2 — pet_identifications of a soft-deleted pet still reads for admin", () => {
  it("admin READS the soft-deleted pet's identification — OPEN FINDING, expected 1", async () => {
    const client = requireFixture(adminClient, "admin client");
    const identId = requireFixture(deletedIdentificationId, "soft-deleted identification fixture");
    expect(
      await rowCount(client, "pet_identifications", identId),
      'OPEN FINDING pinned: "pet_identifications read by admin" is EXISTS(profiles p WHERE p.role=admin) with no ownership, no jurisdiction and no deleted_at — it serves the identification rows of EVERY soft-deleted pet. The application-side guard for this exact PII landed in "en gob y admin ... la del microchip sí lo era"; the RLS side did not.',
    ).toBe(1);
  });

  it("admin READS the LIVE pet's identification too — control: the admin branch is unconditional, not soft-delete-aware", async () => {
    const client = requireFixture(adminClient, "admin client");
    const identId = requireFixture(liveIdentificationId, "live control identification fixture");
    expect(await rowCount(client, "pet_identifications", identId)).toBe(1);
  });

  it("owner READS the soft-deleted pet's identification — the owner-read branch has no deleted_at either", async () => {
    const client = requireFixture(ownerClient, "owner client");
    const identId = requireFixture(deletedIdentificationId, "soft-deleted identification fixture");
    expect(await rowCount(client, "pet_identifications", identId)).toBe(1);
  });

  it("other_user is denied both identifications — a genuine isolation boundary, unrelated to soft-delete", async () => {
    const client = requireFixture(otherClient, "other_user client");
    const deleted = requireFixture(deletedIdentificationId, "soft-deleted identification fixture");
    const live = requireFixture(liveIdentificationId, "live control identification fixture");
    expect(await rowCount(client, "pet_identifications", deleted)).toBe(0);
    expect(await rowCount(client, "pet_identifications", live)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3b. FINDING 3 — the erase RPC severs the user from the tag; RLS reattaches it.
// ---------------------------------------------------------------------------

describe("FINDING 3 — pet_tags: the RPC nulls activated_by_user_id, the ownership branch undoes it", () => {
  it("the tag fixture really has activated_by_user_id NULL (positive control for the branch claim)", async () => {
    const tagId = requireFixture(deletedTagId, "soft-deleted pet tag fixture");
    // Without this the read below could be coming from the OTHER branch of the
    // policy, and the finding would be a misreading rather than a finding.
    const rows = await db
      .select({ id: petTags.id })
      .from(petTags)
      .where(and(eq(petTags.id, tagId), isNull(petTags.activatedByUserId)))
      .limit(1);
    expect(
      rows.length,
      "the tag fixture does not reproduce the post-erase state (activated_by_user_id must be NULL)",
    ).toBe(1);
  });

  it("owner READS the tag of the soft-deleted pet — OPEN FINDING, expected 1", async () => {
    const client = requireFixture(ownerClient, "owner client");
    const tagId = requireFixture(deletedTagId, "soft-deleted pet tag fixture");
    expect(
      await rowCount(client, "pet_tags", tagId),
      'OPEN FINDING pinned, and the sharpest of the three: migration 0170 goes out of its way to NULL pet_tags.activated_by_user_id so the erased user is no longer attached to the tag — and "pet_tags select own" has a SECOND branch, pet_id IN (SELECT pet_id FROM ownerships WHERE owner_user_id = auth.uid() AND ended_at IS NULL), which still matches because the same RPC never ends the ownership. The deliberate severing is undone by the policy it was not checked against.',
    ).toBe(1);
  });

  it("other_user and anon are denied the tag — the finding is about the OWNERSHIP branch, nothing wider", async () => {
    const other = requireFixture(otherClient, "other_user client");
    const anon = requireFixture(anonClient, "anon client");
    const tagId = requireFixture(deletedTagId, "soft-deleted pet tag fixture");
    expect(await rowCount(other, "pet_tags", tagId)).toBe(0);
    expect(await rowCount(anon, "pet_tags", tagId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The anon zero, and why it is NOT evidence that suppression works.
// ---------------------------------------------------------------------------

describe("anon reads nothing — but the LIVE control proves that is not the soft-delete fence", () => {
  it("anon is denied the soft-deleted pet AND the live pet — identical zeros", async () => {
    const client = requireFixture(anonClient, "anon client");
    const deleted = requireFixture(deletedPetId, "soft-deleted pet fixture");
    const live = requireFixture(livePetId, "live control pet fixture");
    expect(await rowCount(client, "pets", deleted)).toBe(0);
    // THE ASSERTION THAT MATTERS. A reader who sees only the line above will
    // conclude "suppression holds for anon". It does not: no `pets` policy names
    // the anon role at all, so anon reads zero from a perfectly live pet. The
    // zero is an artifact of the table being closed to anon entirely. If this
    // ever returns 1, the anon surface opened and the line above became load
    // bearing for a reason it was never designed to carry.
    expect(
      await rowCount(client, "pets", live),
      "anon can read a LIVE pet — the anon zero on the deleted pet is now a real soft-delete fence rather than a closed table, and the header's reasoning is stale",
    ).toBe(0);
  });

  it("anon is denied both identifications — same reasoning, same pairing", async () => {
    const client = requireFixture(anonClient, "anon client");
    const deleted = requireFixture(deletedIdentificationId, "soft-deleted identification fixture");
    const live = requireFixture(liveIdentificationId, "live control identification fixture");
    expect(await rowCount(client, "pet_identifications", deleted)).toBe(0);
    expect(await rowCount(client, "pet_identifications", live)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The catalog-level statement of the gap, independent of any fixture.
// ---------------------------------------------------------------------------

// `deleted_at` references in a policy's USING text that are about the PROTECTED
// ROW, as opposed to the ACTOR. Two columns share the name: every soft-deletable
// table carries one, and so does `profiles`, where it marks a Ley 25.326 art. 16
// erasure of the caller. Migration 0215 put `p.deleted_at IS NULL` (p = profiles)
// into admin branches, and a matcher that greps for the bare string cannot tell
// "the administrator was erased" from "the pet was erased".
//
// The text is `pg_policies.qual`, i.e. pg_get_expr output, and that deparser is
// what makes a textual resolution sound: `public.` is stripped, every range table
// appears in FROM/JOIN/comma position with its alias, and a column is qualified
// whenever more than one range table is in scope — the only bare `deleted_at`
// pg_get_expr can emit is one where the protected table is the sole table in
// scope, which is a subject reference by construction. MEASURED 2026-09-09:
// `... AND (pet_identifications.deleted_at IS NULL)` appended to the admin
// policy came back from the catalog as `AND (deleted_at IS NULL)`, and tripped
// this through the bare branch; a throwaway `FROM pets p ... p.deleted_at` on
// pet_tags tripped it through the alias branch, `p` being bound to pets.
//
// Resolution: bind every alias to the table it is declared on. A reference is
// discounted only when its qualifier is bound to `profiles` AND to nothing else
// (an alias reused for a second table in a sibling subquery is ambiguous, and
// ambiguity trips the wire rather than silencing it). A bare `profiles.` qualifier
// is the actor unless the policy protects `profiles` itself, in which case it IS
// the protected row (an inner `profiles` in a `profiles` policy is deparsed as
// `profiles_1`, so it lands in the alias branch). Everything else — bare,
// qualified by the protected table, or qualified by any alias bound to a table
// other than `profiles` — survives.
function subjectDeletedAtReferences(tablename: string, qual: string): string[] {
  const bindings = new Map<string, Set<string>>();
  const rangeTable =
    /(?:\bfrom\s+\(?\s*|\bjoin\s+|,\s*)(?:public\.)?([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?(?!(?:on|where|join|left|right|inner|full|cross|natural|using|group|order|limit|union|intersect|except|having|lateral|and|or)\b)([a-z_][a-z0-9_]*))?/gi;
  for (const m of qual.matchAll(rangeTable)) {
    const table = m[1].toLowerCase();
    const alias = (m[2] ?? table).toLowerCase();
    const bound = bindings.get(alias) ?? new Set<string>();
    bound.add(table);
    bindings.set(alias, bound);
  }
  const boundOnlyToProfiles = (qualifier: string) => {
    const bound = bindings.get(qualifier);
    return bound !== undefined && bound.size === 1 && bound.has("profiles");
  };

  const surviving: string[] = [];
  for (const m of qual.matchAll(/(?:\b([a-z_][a-z0-9_]*)\.)?\bdeleted_at\b/gi)) {
    const qualifier = m[1]?.toLowerCase();
    if (qualifier === undefined || qualifier === tablename) {
      surviving.push(m[0]);
      continue;
    }
    if (qualifier === "profiles" && tablename !== "profiles") continue;
    if (qualifier !== "profiles" && boundOnlyToProfiles(qualifier)) continue;
    surviving.push(m[0]);
  }
  return surviving;
}

describe("no RLS policy over a deleted_at-bearing table mentions ITS OWN deleted_at (catalog level)", () => {
  it("records the ZERO that the three findings above are consequences of", async () => {
    // Fixture-free and session-free: pure pg_policies introspection, so it keeps
    // stating the gap even if every probe above were deleted. It is also the
    // cheapest possible tripwire for the fix — the moment ANY policy on these
    // six tables gains a predicate over the protected table's own deleted_at,
    // this goes red and points the reader at the findings to re-measure.
    //
    // PRECISION, 2026-09-09. Until migration 0215 this matched any `deleted_at`
    // in the policy text, and that was exact because no policy on these tables
    // mentioned the column in any role. 0215 introduced the first predicates
    // that do — `p.deleted_at IS NULL` on `profiles p`, the ACTOR: an erased
    // administrator stops being an administrator — and the string match went
    // red on two policies whose subject-level behaviour had not moved at all.
    // The assertion now asks the precise question through
    // subjectDeletedAtReferences(): does this policy reference the deleted_at
    // OF THE TABLE IT PROTECTS. Not an allowlist — the two policies stay under
    // the wire, and a subject-level predicate added to either still trips it.
    const rows = (await db.execute(sql`
      select p.tablename, p.policyname, coalesce(p.qual, '') as qual
      from pg_policies p
      join information_schema.columns c
        on c.table_schema = 'public'
       and c.table_name = p.tablename
       and c.column_name = 'deleted_at'
      where p.schemaname = 'public'
        and p.cmd in ('SELECT', 'ALL')
    `)) as unknown as Array<{ tablename: string; policyname: string; qual: string }>;

    // Guard against a vacuous pass: if the join found nothing, the assertion
    // below would hold trivially and report "gap confirmed" having looked at
    // nothing. Six tables carry deleted_at and they are not all policy-free.
    expect(
      rows.length,
      "no read policies found over deleted_at-bearing tables — the introspection join is broken, not the gap closed",
    ).toBeGreaterThan(0);

    const aware = rows
      .map((r) => ({ ...r, refs: subjectDeletedAtReferences(r.tablename, r.qual) }))
      .filter((r) => r.refs.length > 0)
      .map((r) => `${r.tablename}."${r.policyname}" via ${r.refs.join(", ")}`);
    expect(
      aware,
      `A read policy now references the deleted_at OF THE TABLE IT PROTECTS: ${aware.join("; ")}. That is the FIX arriving — good. Re-measure FINDINGS 1, 2 and 3 above, flip the expectations that closed, and rewrite this file's header from "open" to what is actually left. Closing ONE policy does not close the others: the three findings are independent, and this catalog assertion goes red on the first of them. (A predicate on profiles.deleted_at — the ACTOR, migration 0215's erased-admin check — is deliberately NOT this: it is discounted above and does not close anything here.)`,
    ).toEqual([]);
  });
});
