// RLS govt jurisdiction boundary — regression harness for the Tier-2 authz
// critique R1 (pet_identifications) and R2 (pet_service_dog).
//
// Drives the LIVE local Supabase stack via PostgREST (supabase-js, which IS
// subject to RLS), signed in as a real seeded govt operator, and proves the two
// govt READ policies do NOT leak PII beyond the operator's jurisdiction.
//
// GROUND TRUTH established while writing migration 0140 (documented so a future
// reader is not surprised):
//   - R2 (pet_service_dog): the pre-fix govt branch referenced ONLY `profiles`
//     (no jurisdiction join), so ANY institutional govt JWT read assistance-dog
//     status NATIONWIDE — a REAL, reachable leak. The fix adds a `govt_assignments`
//     join (province+locality); because `pets` carries its own RLS with NO govt
//     read policy, the govt subquery now yields zero pets → govt reads ZERO
//     service_dog rows through PostgREST. Leak closed.
//   - R1 (pet_identifications): the govt policy already referenced `pets`
//     (RLS-gated), so a govt JWT read ZERO identifications through PostgREST both
//     before AND after the fix — the province-wide leak was not reachable on the
//     PostgREST surface. The tightening is correct defense-in-depth (mirrors the
//     sibling govt policies, adds locality scope) and is asserted here so the
//     surface stays closed for govt.
//
// The app itself reads both tables via Drizzle (BYPASSRLS service role) with the
// fine-grained subsumption logic — RLS here is purely the PostgREST backstop.
//
// Pre-flight: `pnpm seed:test` (govt-local@dim.test, admin@dim.test) + migration
// 0140 applied locally.
//
// **A SETUP FAILURE FAILS THE SUITE.** This header used to end "missing
// seed/env → the suite SKIPS (contract-level)", and the code agreed: a
// `console.warn` marker that asserted `expect(true).toBe(true)`, and four
// `if (setupError || ...) return;` guards. P2.8 (7ec0098c) deleted exactly that
// shape from the sibling __tests__/rls/matrix.test.ts on 2026-07-31 — and it
// survived verbatim here, in the file whose header calls R2 "a REAL, reachable
// leak". A suite that reports green for the nationwide assistance-dog PII leak
// without probing it is worse than no suite. Missing env or missing seed users
// now throw out of `beforeAll` with the cause named.

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petIdentifications, petServiceDog, pets } from "@/db";

import { elevateToAal2 } from "../_helpers/aal2-session";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SHARED_PASSWORD = "Test1234!";

// A jurisdiction NO seeded govt operator is assigned to — so a govt read of the
// fixture rows can only mean the policy leaked (pre-fix R2 behaviour).
const OOJ_PROVINCE = "Córdoba";
const OOJ_LOCALITY = "PANO-GOVTRLS-OOJ";

let govtClient: SupabaseClient | null = null;
let adminClient: SupabaseClient | null = null;
let setupError: string | null = null;

let fixturePetId: string | null = null;
let fixtureIdentificationId: string | null = null;
let fixtureServiceDogId: string | null = null;

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
      "NEXT_PUBLIC_SUPABASE_URL / ANON_KEY missing — the govt RLS boundary suite cannot probe anything.";
    throw new Error(setupFailureMessage(setupError));
  }

  govtClient = await signIn("govt-local@dim.test");
  adminClient = await signIn("admin@dim.test");
  if (setupError) throw new Error(setupFailureMessage(setupError));
  // The admin (and govt) sessions here are the LEGITIMATE institutional path,
  // which since T2-S6 is a password plus a second factor; an aal1 institutional
  // token is what migration 0231 refuses (pinned in erased-admin-authority).
  await elevateToAal2(govtClient as SupabaseClient);
  await elevateToAal2(adminClient as SupabaseClient);

  // Fixture pet in an out-of-jurisdiction locality + a PII identification row and
  // an assistance-dog row. Inserted via Drizzle (service role bypasses RLS).
  const [petRow] = await db
    .insert(pets)
    .values({
      publicToken: `DIM-GOVTRLS-${Date.now().toString(36).toUpperCase()}`,
      name: "Govt RLS Boundary Fixture",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: OOJ_PROVINCE,
      jurisdictionLocality: OOJ_LOCALITY,
    })
    .returning({ id: pets.id });
  fixturePetId = petRow.id;

  const [idRow] = await db
    .insert(petIdentifications)
    .values({
      petId: fixturePetId,
      kind: "collar_tag",
      code: "GOVTRLS-FIXTURE-TAG",
      status: "active",
      recordedAt: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: petIdentifications.id });
  fixtureIdentificationId = idRow.id;

  const [sdRow] = await db
    .insert(petServiceDog)
    .values({
      petId: fixturePetId,
      serviceType: "guia",
      trainingCenter: "Govt RLS Fixture Training Center",
    })
    .returning({ id: petServiceDog.id });
  fixtureServiceDogId = sdRow.id;
});

afterAll(async () => {
  await govtClient?.auth.signOut().catch(() => {});
  await adminClient?.auth.signOut().catch(() => {});
  if (fixtureServiceDogId) {
    await db
      .delete(petServiceDog)
      .where(eq(petServiceDog.id, fixtureServiceDogId))
      .catch(() => {});
  }
  if (fixtureIdentificationId) {
    await db
      .delete(petIdentifications)
      .where(eq(petIdentifications.id, fixtureIdentificationId))
      .catch(() => {});
  }
  if (fixturePetId) {
    await db
      .delete(pets)
      .where(eq(pets.id, fixturePetId))
      .catch(() => {});
  }
});

/**
 * Zero rows, but ONLY when PostgREST actually evaluated a policy.
 *
 * A denial is `200 []`. A rejected credential is `401` with no rows — and both
 * used to return 0 from here, which means a broken anon key read as "the leak
 * is closed". Mirrors assertCredentialReachedRls() in matrix.test.ts; kept
 * local rather than shared because the two harnesses have different probe
 * shapes and a shared helper would need both.
 */
async function rowCount(client: SupabaseClient, table: string, id: string): Promise<number> {
  const { data, error } = await client.from(table).select("id").eq("id", id).limit(1);
  if (error && (error.code?.startsWith("PGRST30") || /JWT|API key/i.test(error.message))) {
    const detail = `${error.code ?? "no code"}: ${error.message}`;
    throw new Error(
      `Probe of ${table} never reached a policy — PostgREST rejected the CREDENTIAL (${detail}). Zero rows here would be scored as 'leak closed' while nothing was checked. Fix NEXT_PUBLIC_SUPABASE_ANON_KEY.`,
    );
  }
  return data?.length ?? 0;
}

/** One loud, named failure instead of four silent passes. */
function setupFailureMessage(cause: string): string {
  return `govt RLS boundary setup FAILED — refusing to report the R1/R2 leaks closed when nothing probed them. Cause: ${cause}`;
}

describe("RLS govt jurisdiction boundary (Tier-2 R1 / R2)", () => {
  it("setup ran without errors — otherwise every assertion below is meaningless", () => {
    // Unreachable while beforeAll throws (this test never runs in that case).
    // Kept as an ASSERTION, not a console.warn next to expect(true).toBe(true):
    // that pairing is what made the green believable here for months.
    expect(setupError, setupError ? setupFailureMessage(setupError) : undefined).toBeNull();
  });

  // Backstop, not the primary gate — beforeAll already threw. Never a `return`:
  // a probe that cannot run must not report a pass. `setupError` is mutable
  // module state, so this is what stops a future edit from reintroducing a soft
  // path and quietly turning these four back into unconditional greens.
  function requireFixture<T>(value: T | null, what: string): T {
    if (setupError) throw new Error(setupFailureMessage(setupError));
    if (value === null) throw new Error(setupFailureMessage(`${what} was never provisioned`));
    return value;
  }

  // R2 — the regression that matters most: pre-fix a govt JWT read this row
  // nationwide; post-fix (govt_assignments join) it must be DENIED.
  it("govt is DENIED reading an out-of-jurisdiction pet_service_dog row (R2 nationwide leak closed)", async () => {
    const client = requireFixture(govtClient, "govt client");
    const id = requireFixture(fixtureServiceDogId, "pet_service_dog fixture");
    expect(await rowCount(client, "pet_service_dog", id)).toBe(0);
  });

  it("admin still reads the pet_service_dog row nationwide (positive control — admin branch intact)", async () => {
    const client = requireFixture(adminClient, "admin client");
    const id = requireFixture(fixtureServiceDogId, "pet_service_dog fixture");
    expect(await rowCount(client, "pet_service_dog", id)).toBe(1);
  });

  // R1 — the PostgREST surface stays closed for govt (pets RLS gates the govt
  // subquery); the tightened, locality-scoped policy is asserted at the catalog
  // level in coverage.test.ts.
  it("govt is DENIED reading an out-of-jurisdiction pet_identifications row (R1)", async () => {
    const client = requireFixture(govtClient, "govt client");
    const id = requireFixture(fixtureIdentificationId, "pet_identifications fixture");
    expect(await rowCount(client, "pet_identifications", id)).toBe(0);
  });

  it("admin still reads the pet_identifications row (positive control — admin branch intact)", async () => {
    const client = requireFixture(adminClient, "admin client");
    const id = requireFixture(fixtureIdentificationId, "pet_identifications fixture");
    expect(await rowCount(client, "pet_identifications", id)).toBe(1);
  });
});
