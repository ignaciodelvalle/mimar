// RLS proof tests for the titular-only deny-list (migration 0190).
//
// WHY THESE EXIST, AND WHY THEY CANNOT BE FAKED AT THE APP LAYER
// ---------------------------------------------------------------------------
// The app-layer deny-list (requireTitularAccess + scripts/check-titular-gate.ts)
// is real against the Next.js app: every legitimate write goes through Drizzle,
// which connects as a BYPASSRLS role, so the guard is the only gate and it runs.
//
// Against a client holding a valid Supabase bearer token and talking to
// PostgREST directly, it is worth nothing. Before 0190, every ownership-derived
// policy tested `owner_user_id = auth.uid() AND ended_at IS NULL` with NO role
// predicate — so an active caretaker could
//   PATCH /rest/v1/pets      {"jurisdiction_province": …}
//   POST  /rest/v1/pet_events {"event_type":"custody_transferred", …}
//   POST  /rest/v1/libreta_share_tokens {…}
// and defeat four of the seven deny-list rows without ever touching the app.
// That PostgREST is reachable by an authenticated attacker is not speculation:
// migration 0163 exists because somebody exercised that exact vector.
//
// So the assertions below connect AS THE `authenticated` ROLE with a spoofed
// `request.jwt.claims`, which is what PostgREST does. Anything less would be
// testing the app we already trust instead of the layer we just changed.
//
// WHAT MIGRATION 0212 CHANGED IN THIS FILE (2026-09-02, lens A02 / A02-1)
// ---------------------------------------------------------------------------
// 0190 narrowed the `pet_events` INSERT policy along ONE axis — the event-type
// family — and left provenance (`author_role`, `author_verified`,
// `recorded_by_user_id`) and the EVENT_TYPES catalog entirely caller-supplied.
// A plain titular could therefore POST a `vaccination_administered` claiming
// `author_role: "govt", author_verified: true`, satisfy every conjunct, and mint
// a permanent institutional lie in the append-only spine. Migration 0212 DROPPED
// that policy outright: `pet_events` now has NO caller-facing write policy at
// all, only its SELECT.
//
// So the `pet_events` block below no longer contrasts caretaker with titular —
// BOTH are denied through PostgREST, and that is the point. The legitimate path
// for a caretaker's medical event was never this one: they record it in the app,
// which writes over the Drizzle BYPASSRLS connection after `requirePetAccess`
// has authorized them. What 0212 narrows is the bearer token, not the role.
//
// Migration 0236 did the same to `pets` UPDATE: its titular predicate scoped
// rows, not columns, so the titular could rewrite lifecycle and authority
// columns of their own pet. It is deny-all now. The `libreta_share_tokens`
// INSERT block is UNCHANGED and still carries the titular predicate 0190
// introduced — `has_titular_write_access` remains live for it.
//
// SHAPE OF THE ASSERTIONS — read this before adding one:
//   - A denied UPDATE is NOT an error. RLS filters the USING clause, so the
//     statement succeeds and affects ZERO rows. Asserting `rejects` there would
//     fail even against a correct policy.
//   - A denied INSERT IS an error (42501, "insufficient privilege"), whether
//     because a WITH CHECK rejected the produced row or because no INSERT
//     policy exists to admit it at all.
//   - Where a policy DISCRIMINATES (libreta_share_tokens INSERT),
//     every caretaker denial is paired with the SAME statement run as the
//     TITULAR. Without the pair, a policy that denies everybody would pass.
//   - Where a table is DENY-ALL (pet_events since 0212, pets UPDATE since 0236), that pairing is not
//     available — a titular is denied too. The non-vacuity control there is the
//     server-side write instead: the same INSERT over Drizzle must still land,
//     or the lockdown reached past PostgREST into the app.
//
// Requires: local Supabase stack running + migrations 0189, 0190, 0212 and 0236
// applied.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, pets, profiles } from "@/db";
import { TITULAR_ONLY_EVENT_TYPES } from "@/lib/domain/titular-only";
import { pgErrorCode } from "@/lib/infra/db-errors";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-CRLS-0001";
const TITULAR_ID = "0cae7a11-1111-4000-8000-000000000001";
const CARETAKER_ID = "0cae7a11-1111-4000-8000-000000000002";

let petId: string;

/**
 * Run one statement the way PostgREST would: as the `authenticated` role, with
 * `request.jwt.claims.sub` set to the caller. SET LOCAL + transaction-scoped
 * set_config means both revert when the transaction ends.
 */
async function asAuthenticated<T = Record<string, unknown>>(
  userId: string,
  statement: ReturnType<typeof sql>,
): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`,
    );
    await tx.execute(sql`SET LOCAL ROLE authenticated`);
    return (await tx.execute(statement)) as unknown as T[];
  });
}

async function expectRlsDenied(promise: Promise<unknown>): Promise<void> {
  let code: string | null = null;
  let rejected = false;
  try {
    await promise;
  } catch (err) {
    rejected = true;
    code = pgErrorCode(err) ?? null;
  }
  expect(rejected, "expected the write to be refused by RLS, but it succeeded").toBe(true);
  // 42501 = insufficient_privilege, which is what a WITH CHECK violation raises.
  expect(code).toBe("42501");
}

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM libreta_share_tokens WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
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
  await db.execute(
    sql`DELETE FROM profiles WHERE id IN (${TITULAR_ID}::uuid, ${CARETAKER_ID}::uuid)`,
  );
}

beforeAll(async () => {
  await cleanup();
  await db.insert(profiles).values([
    { id: TITULAR_ID, displayName: "Titular RLS", role: "owner" },
    { id: CARETAKER_ID, displayName: "Cuidadora RLS", role: "owner" },
  ]);
  const [pet] = await db
    .insert(pets)
    .values({ publicToken: PET_TOKEN, name: "Pampa RLS", species: "dog" })
    .returning({ id: pets.id });
  petId = pet.id;
  await db.insert(ownerships).values([
    { petId, ownerUserId: TITULAR_ID, role: "owner" },
    { petId, ownerUserId: CARETAKER_ID, role: "caretaker" },
  ]);
});

afterAll(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------
// The caretaker keeps every read. That is the whole point of the role.
// ---------------------------------------------------------------------------

describe("caretaker — reads are untouched", () => {
  it("can SELECT the pet row", async () => {
    const rows = await asAuthenticated(
      CARETAKER_ID,
      sql`SELECT id FROM public.pets WHERE id = ${petId}::uuid`,
    );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// pets UPDATE — deny-all since migration 0236.
//
// 0190 made this policy titular-shaped (has_titular_write_access), and the
// caretaker denials below held. But the policy scoped ROWS and no COLUMNS, so
// the TITULAR could PATCH status, deceased_at, rabies_observation_status,
// in_custody_dispute, public_token, deleted_at, jurisdiction_locality or
// adoption_eligible on their own pet — found by the RLS matrix's write probes
// (T3-F1). Nothing legitimate updates pets through PostgREST, so 0236 dropped
// the policy and revoked UPDATE from anon/authenticated.
//
// Like the pet_events block, the denials are now evidence that the SURFACE is
// shut, and the last test is the control that keeps them from being vacuous.
// A denial is either 42501 (the 0236 REVOKE holds) or zero rows (an environment
// re-provisioned after 0236, where applySchemaGrants re-granted UPDATE but no
// policy admits a row). Both are closed; anything that UPDATEs a row is not.
// ---------------------------------------------------------------------------

async function expectUpdateDenied(promise: Promise<unknown[]>): Promise<void> {
  try {
    const rows = await promise;
    expect(rows, "a PostgREST-role UPDATE on pets reached a row").toHaveLength(0);
  } catch (err) {
    expect(pgErrorCode(err) ?? null).toBe("42501");
  }
}

describe("pets UPDATE — no caller-facing write surface at all (migration 0236)", () => {
  it("refuses a caretaker's jurisdiction change", async () => {
    await expectUpdateDenied(
      asAuthenticated(
        CARETAKER_ID,
        sql`UPDATE public.pets SET jurisdiction_province = 'Córdoba' WHERE id = ${petId}::uuid RETURNING id`,
      ),
    );
  });

  it("refuses the TITULAR's jurisdiction change too — the lockdown is the surface, not the role (0236)", async () => {
    // This asserted the OPPOSITE until 0236. The titular still moves their pet;
    // they do it in the app, which writes over Drizzle after requireTitularAccess.
    await expectUpdateDenied(
      asAuthenticated(
        TITULAR_ID,
        sql`UPDATE public.pets SET jurisdiction_province = 'Córdoba' WHERE id = ${petId}::uuid RETURNING id`,
      ),
    );
  });

  it("refuses a caretaker's Tier-2 public toggle", async () => {
    await expectUpdateDenied(
      asAuthenticated(
        CARETAKER_ID,
        sql`UPDATE public.pets SET tier2_public_permanent = true WHERE id = ${petId}::uuid RETURNING id`,
      ),
    );
  });

  it("refuses a caretaker publishing THEIR OWN contact on the credential", async () => {
    // KEY 1 of the two-key model (`disclose_caretaker_contact_when_lost`,
    // migration 0193) is the TITULAR's, and the titular sets it in the app.
    await expectUpdateDenied(
      asAuthenticated(
        CARETAKER_ID,
        sql`UPDATE public.pets SET disclose_caretaker_contact_when_lost = true WHERE id = ${petId}::uuid RETURNING id`,
      ),
    );
  });

  it("refuses the TITULAR clearing a rabies observation on their own pet (the 0236 hole)", async () => {
    await expectUpdateDenied(
      asAuthenticated(
        TITULAR_ID,
        sql`UPDATE public.pets SET rabies_observation_status = rabies_observation_status WHERE id = ${petId}::uuid RETURNING id`,
      ),
    );
  });

  it("refuses a caretaker's rename (identity field)", async () => {
    await expectUpdateDenied(
      asAuthenticated(
        CARETAKER_ID,
        sql`UPDATE public.pets SET name = 'Renombrada' WHERE id = ${petId}::uuid RETURNING id`,
      ),
    );
  });

  it("still updates the SAME row over Drizzle (BYPASSRLS) — the legitimate path is untouched", async () => {
    // NON-VACUITY CONTROL for the denials above: without it, a missing fixture
    // pet would make every denial pass, and a lockdown that reached past
    // PostgREST into the app would look identical to a correct one.
    const rows = (await db.execute(
      sql`UPDATE public.pets SET disclose_caretaker_contact_when_lost = true WHERE id = ${petId}::uuid RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    await db.execute(
      sql`UPDATE public.pets SET disclose_caretaker_contact_when_lost = false WHERE id = ${petId}::uuid`,
    );
  });
});

// ---------------------------------------------------------------------------
// pet_events INSERT — deny-all since migration 0212.
//
// This block used to be the subtle one: 0190 made the policy event-type-shaped
// so a caretaker could still append a medical event through PostgREST while the
// titular-only types were refused. 0212 removed the policy entirely, because
// the axis 0190 did NOT constrain turned out to be the dangerous one —
// `author_role`, `author_verified` and `recorded_by_user_id` were caller-
// supplied, and `event_type` was never checked against EVENT_TYPES at all
// (the column is TEXT with no CHECK and no enum). A plain titular could post a
// `vaccination_administered` as `author_role: 'govt', author_verified: true`
// and mint an institutional credential the public page renders and the
// compliance projection honours — permanently, because there is no UPDATE and
// no DELETE policy and invariant #2 forbids deletion.
//
// So the denials below are no longer evidence about ROLES. They are evidence
// that the SURFACE is shut: caretaker and titular alike are refused, and the
// last test in this block is the control that keeps that from being vacuous.
// ---------------------------------------------------------------------------

describe("pet_events INSERT — no caller-facing write policy at all (migration 0212)", () => {
  it("refuses a caretaker-forged custody_transferred", async () => {
    // The worst case in the whole audit: pet_events has no UPDATE and no DELETE
    // policy and the invariant forbids deletion, so a forged transfer would be
    // a PERMANENT lie in an append-only ledger. The transfers module would not
    // honour it (ownerships has been write-locked since 0163), which makes it a
    // lie rather than a theft — but invariant #2 exists to prevent exactly that.
    // Refused by 0190's titular predicate until 0212; refused now because there
    // is no INSERT policy to admit the row.
    await expectRlsDenied(
      asAuthenticated(
        CARETAKER_ID,
        sql`INSERT INTO public.pet_events (pet_id, event_type, occurred_at, recorded_by_user_id, payload)
            VALUES (${petId}::uuid, 'custody_transferred', now(), ${CARETAKER_ID}::uuid, '{}'::jsonb)`,
      ),
    );
  });

  it("refuses a caretaker-forged adoption_eligibility_set", async () => {
    await expectRlsDenied(
      asAuthenticated(
        CARETAKER_ID,
        sql`INSERT INTO public.pet_events (pet_id, event_type, occurred_at, recorded_by_user_id, payload)
            VALUES (${petId}::uuid, 'adoption_eligibility_set', now(), ${CARETAKER_ID}::uuid, '{}'::jsonb)`,
      ),
    );
  });

  it("refuses a caretaker's medical event through PostgREST — the server-side use case is the only writer (0212)", async () => {
    // This test asserted the OPPOSITE until 0212, and the arrangement it was
    // protecting is untouched: a caretaker still records vaccinations. They
    // record them in the app, which writes over Drizzle after requirePetAccess
    // authorized them. What is gone is the parallel bearer-token path that ran
    // alongside the app and answered to no guard.
    await expectRlsDenied(
      asAuthenticated(
        CARETAKER_ID,
        sql`INSERT INTO public.pet_events (pet_id, event_type, occurred_at, recorded_by_user_id, payload)
            VALUES (${petId}::uuid, 'vaccination_administered', now(), ${CARETAKER_ID}::uuid, '{}'::jsonb)`,
      ),
    );
  });

  it("refuses the TITULAR too — the lockdown is the surface, not the role (0212)", async () => {
    // The pairing that makes every OTHER denial in this file meaningful is not
    // available here, and saying so is the honest form: a policy that denied
    // everybody would pass this test. That is precisely what 0212 installed, so
    // the control moved to the next test instead of this one.
    await expectRlsDenied(
      asAuthenticated(
        TITULAR_ID,
        sql`INSERT INTO public.pet_events (pet_id, event_type, occurred_at, recorded_by_user_id, payload)
            VALUES (${petId}::uuid, 'custody_transfer_proposed', now(), ${TITULAR_ID}::uuid, '{}'::jsonb)`,
      ),
    );
  });

  it("still appends the SAME rows over Drizzle (BYPASSRLS) — the legitimate path is untouched", async () => {
    // NON-VACUITY CONTROL for the four denials above. Without it, a broken
    // fixture (no pet, no ownership, a caretaker that does not exist) would
    // produce four green denials that prove nothing, and a lockdown that had
    // reached past PostgREST into the app would look identical to a correct one.
    // `db` is the connection every use case and /api/v1 writes over.
    const rows = (await db.execute(
      sql`INSERT INTO public.pet_events (pet_id, event_type, occurred_at, recorded_by_user_id, payload)
          VALUES
            (${petId}::uuid, 'vaccination_administered', now(), ${CARETAKER_ID}::uuid, '{}'::jsonb),
            (${petId}::uuid, 'custody_transfer_proposed', now(), ${TITULAR_ID}::uuid, '{}'::jsonb)
          RETURNING id, author_role::text as author_role, author_verified`,
    )) as unknown as Array<{ author_role: string; author_verified: boolean }>;

    expect(rows).toHaveLength(2);
    // And the column defaults still describe the row honestly — the forgery
    // 0190's policy admitted was the CALLER overriding these two.
    for (const r of rows) {
      expect(r.author_role).toBe("owner");
      expect(r.author_verified).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// libreta_share_tokens INSERT — deny-list row libreta-share-minting
// ---------------------------------------------------------------------------

describe("libreta_share_tokens INSERT — titular only", () => {
  it("refuses a caretaker minting a public medical share link", async () => {
    await expectRlsDenied(
      asAuthenticated(
        CARETAKER_ID,
        sql`INSERT INTO public.libreta_share_tokens (share_token, pet_id, created_by_user_id)
            VALUES ('CRLS-CARETAKER', ${petId}::uuid, ${CARETAKER_ID}::uuid)`,
      ),
    );
  });

  it("still lets the TITULAR mint one", async () => {
    const rows = await asAuthenticated(
      TITULAR_ID,
      sql`INSERT INTO public.libreta_share_tokens (share_token, pet_id, created_by_user_id)
          VALUES ('CRLS-TITULAR', ${petId}::uuid, ${TITULAR_ID}::uuid) RETURNING id`,
    );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// pet_caretaker_grants — the table ships write-locked (the 0163 posture)
// ---------------------------------------------------------------------------

describe("pet_caretaker_grants — no write policy at all", () => {
  it("refuses a caretaker inserting their own grant", async () => {
    // If this ever passes, a caretaker can mint or extend their own access.
    await expectRlsDenied(
      asAuthenticated(
        CARETAKER_ID,
        sql`INSERT INTO public.pet_caretaker_grants (public_token, pet_id, granted_by_user_id, caretaker_email, ends_at)
            VALUES ('CRLS-SELF', ${petId}::uuid, ${TITULAR_ID}::uuid, 'x@dim-test.local', now() + interval '30 days')`,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// The duplication fence — SQL list vs TS list
// ---------------------------------------------------------------------------

// The function survived 0212 on purpose. Dropping the `pet_events` INSERT
// policy left it with no RLS consumer, but it is not dead weight: the equality
// assertion below is what keeps lib/domain/titular-only.ts honest, and a
// function a future policy may want back is cheaper kept than re-derived. This
// pair of tests is therefore about the SQL/TS duplication, not about any policy.
describe("titular_only_event_types() — the second copy is fenced", () => {
  it("matches lib/domain/titular-only.ts exactly", async () => {
    // Defense in depth costs a second copy of the list. Duplication is only
    // acceptable when it is checked: this assertion goes red the moment either
    // side moves alone, which is the whole reason the copy is allowed to exist.
    const rows = (await db.execute(
      sql`SELECT public.titular_only_event_types() AS types`,
    )) as unknown as Array<{ types: string[] }>;
    expect([...rows[0].types].sort()).toEqual([...TITULAR_ONLY_EVENT_TYPES].sort());
  });

  it("is non-empty — an empty list would silently make the equality above vacuous", async () => {
    // This said "would make the pet_events policy a no-op" until 0212 dropped
    // that policy. The floor still earns its place: two empty arrays compare
    // equal, so without it a truncated SQL literal and a truncated TS constant
    // would agree with each other and with nothing real. TITULAR_ONLY_EVENT_TYPES
    // is also still enforced in the app by requireTitularAccess, which is the
    // consumer this list actually serves now.
    const rows = (await db.execute(
      sql`SELECT cardinality(public.titular_only_event_types()) AS n`,
    )) as unknown as Array<{ n: number }>;
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });
});

describe("has_titular_write_access()", () => {
  it("is true for the titular and false for the caretaker", async () => {
    const rows = (await db.execute(
      sql`SELECT
            public.has_titular_write_access(${petId}::uuid, ${TITULAR_ID}::uuid) AS titular,
            public.has_titular_write_access(${petId}::uuid, ${CARETAKER_ID}::uuid) AS caretaker`,
    )) as unknown as Array<{ titular: boolean; caretaker: boolean }>;
    expect(rows[0].titular).toBe(true);
    expect(rows[0].caretaker).toBe(false);
  });

  it("is false for a stranger and for null arguments", async () => {
    const rows = (await db.execute(
      sql`SELECT
            public.has_titular_write_access(${petId}::uuid, gen_random_uuid()) AS stranger,
            public.has_titular_write_access(NULL, ${TITULAR_ID}::uuid) AS nullPet`,
    )) as unknown as Array<{ stranger: boolean; nullpet: boolean }>;
    expect(rows[0].stranger).toBe(false);
    expect(rows[0].nullpet).toBe(false);
  });
});
