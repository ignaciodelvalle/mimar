/**
 * Cross-tenant isolation e2e — Wave 5 Item 26 (RLS defense-in-depth).
 *
 * WHAT THIS TESTS
 * ---------------
 * Owner A (owner@dim.test) cannot access Owner B's data by any browser path:
 *   1. Page renders — navigating to B's pet URLs renders a 404 / redirect /
 *      empty state (never B's pet content).
 *   2. JSON / API responses — Next.js route handlers and server actions are
 *      invoked only through their legitimate paths (session-scoped server
 *      actions are the primary authz gate). This spec exercises the page-
 *      render paths which SSR the sensitive queries.
 *
 * This tests the full stack as a user would experience it, confirming that
 * the action-edge authz layer (primary gate) holds end-to-end.
 *
 * WHY THESE ACCOUNTS
 * ------------------
 * The test seed (seed-test-users.ts) creates two owner accounts:
 *   owner@dim.test      — Owner A: has 3 pets.
 *   owner2@dim.test     — Owner B: a separate tenant owning "Rocco". This spec
 *                         signs in as B to resolve B's REAL pet/user ids and
 *                         probes them as A. Real-Owner-B tests self-skip if the
 *                         owner2 fixture is absent (fabricated-UUID probes and
 *                         anon probes still run).
 *
 * AUTHZ MODEL NOTE (Item 26 + Item 31)
 * ------------------------------------
 * Server Actions are the PRIMARY authz gate. They run server-side with the
 * BYPASSRLS postgres role and enforce session + ownership checks in TS before
 * executing any SQL. RLS is a DEFENSE-IN-DEPTH backstop that guards the
 * PostgREST surface; it never fires for action-edge queries. Both layers must
 * hold independently. This spec validates the action-edge layer end-to-end;
 * __tests__/rls/matrix.test.ts validates the PostgREST / RLS layer directly.
 *
 * SEEDING REQUIREMENTS
 * --------------------
 * Depends on `pnpm db:bootstrap` → `pnpm seed:test` having run.
 * Owner A (owner@dim.test) must own at least one pet.
 * Owner B (owner2@dim.test) + its pet are created by seed-test-users.ts
 * (ensureOwnerB + seedOwnerBPet). If absent, real-Owner-B tests self-skip.
 *
 * The test uses Playwright's request API (not a browser tab) to probe the
 * JSON response of the /api/ routes and the page HTML of owner-scoped routes,
 * in addition to browser navigation for the full-stack path.
 */

import { type Page, type Response, expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { passwordForSupabaseUrl, remoteLoginRefusal } from "./_credentials";
import { passSecondFactorIfAsked, skipUnlessRemoteLoginAllowed } from "./_mfa";
import { BRANDED_NOT_FOUND_TESTID, NOT_FOUND_HEADING } from "./_page-identity";
import { SIGN_IN_PATH, leftSignIn } from "./_sign-in-route";
import { assertRealPage } from "./demo/_helpers";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OWNER_A_EMAIL = "owner@dim.test";

// Owner B — a real second tenant seeded by seed-test-users.ts (owns "Rocco").
const OWNER_B_EMAIL = "owner2@dim.test";

// Govt operator — seeded by seed-test-users.ts covering ONLY Ushuaia +
// El Calafate (remote). Used to probe govt jurisdiction scoping: an
// approval-request page outside the operator's assigned jurisdictions must
// notFound() (the /gob/cola/[publicToken] page collapses out-of-scope AND
// not-found into the same 404 so request existence is never leaked).
const GOVT_EMAIL = "govt@dim.test";

// Org admin — admins "Refugio Test (Seed)". Used to probe org-portal scoping:
// opening ANY org token they don't belong to must notFound() (org layout
// decision D4 — non-member and non-existent collapse to the same 404).
const ORG_ADMIN_EMAIL = "orgadmin@dim.test";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// The password for one of the accounts above. Locally it is the literal every
// seed script writes; against a remote Supabase project it is
// E2E_STAGING_PASSWORD (C4b, 2026-09-23), and ONLY for a rotated account — a
// non-rotated one (govt@) throws instead of receiving it. Resolved per
// account, never once for "every account", so no call site can hand the
// rotated password to an account it does not belong to. See
// e2e/_credentials.ts.
function passwordFor(email: string): string {
  return passwordForSupabaseUrl(SUPABASE_URL, email);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * PostgREST client that ACTUALLY carries the user's JWT.
 *
 * The old pattern — `createClient(...)` then `auth.setSession({ access_token,
 * refresh_token: "" })` — fails silently in supabase-js v2 (an empty refresh
 * token is rejected), leaving the client ANONYMOUS. Every probe built on it
 * was reading as anon, and it went unnoticed for as long as `pets` was
 * anon-readable — the exact RLS hole migration 0165 closed. Once anon reads
 * returned [], the positive control (Owner A reads own pet) failed and, worse,
 * the negative probes ("Owner A cannot read B") had been passing VACUOUSLY.
 * Attaching the JWT as the Authorization header is the reliable, session-free
 * way to make PostgREST requests as the user.
 */
function clientAs(accessToken: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Assert a navigation resolved to the NOT-FOUND surface without leaking data
 * — streaming-safe.
 *
 * These scoping tests used to assert `response.status() === 404`. Routes that
 * stream (a Suspense skeleton flushes the shell before the scoped lookup
 * resolves) call notFound() AFTER headers went out, so the denied page now
 * answers 200 with the branded boundary rendered in its place — the status
 * can no longer carry the verdict (same reality public-smoke documents for
 * /libreta/compartir). What proves the denial is the SURFACE: the not-found
 * boundary is visible and no error boundary rendered. Callers with a known
 * target (e.g. Owner B's pet name) additionally assert its absence.
 */
async function expectNotFoundSurface(
  page: Page,
  response: Response | null,
  label: string,
): Promise<void> {
  const status = response?.status() ?? 0;
  expect([200, 404], `${label} — unexpected HTTP status ${status}`).toContain(status);
  await expect(
    page
      .getByTestId(BRANDED_NOT_FOUND_TESTID)
      .or(page.getByRole("heading", { name: NOT_FOUND_HEADING }))
      .first(),
    label,
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/application error/i)).not.toBeVisible();
}

/** Sign in as Owner A and return the Supabase userId. */
async function signInOwnerA(): Promise<{ userId: string; accessToken: string }> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: OWNER_A_EMAIL,
    password: passwordFor(OWNER_A_EMAIL),
  });
  if (error || !data.user || !data.session) {
    throw new Error(`Owner A sign-in failed: ${error?.message ?? "no user"}`);
  }
  return { userId: data.user.id, accessToken: data.session.access_token };
}

/** Resolve the first pet token (public_token) visible to Owner A. */
async function getOwnerAPetToken(accessToken: string): Promise<string | null> {
  const client = clientAs(accessToken);
  // pets.public_token is the URL segment used in /mis-mascotas/[token].
  const { data } = await client.from("pets").select("public_token").limit(1);
  return data && data.length > 0 ? (data[0].public_token as string) : null;
}

/** Sign in as Owner B (the real cross-tenant target). Returns null on failure. */
async function signInOwnerB(): Promise<{ userId: string; accessToken: string } | null> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: OWNER_B_EMAIL,
    password: passwordFor(OWNER_B_EMAIL),
  });
  if (error || !data.user || !data.session) return null;
  return { userId: data.user.id, accessToken: data.session.access_token };
}

/**
 * Resolve Owner B's own pet token + id + NAME, read AS Owner B (positive-control
 * read).
 *
 * The name is what makes the /mis-mascotas leak test an actual leak test — see
 * the comment on that test. It was previously left unresolved, so the spec
 * knew Owner B's identifiers and never once looked for them on a page.
 */
async function getOwnerBPet(
  accessToken: string,
): Promise<{ token: string; id: string; name: string } | null> {
  const client = clientAs(accessToken);
  const { data } = await client.from("pets").select("id, public_token, name").limit(1);
  return data && data.length > 0
    ? {
        token: data[0].public_token as string,
        id: data[0].id as string,
        name: data[0].name as string,
      }
    : null;
}

/** Navigate to a page and log in as Owner A. Returns the authenticated page. */
async function loginAsOwnerA(page: Page): Promise<void> {
  await page.goto(SIGN_IN_PATH);
  await page.getByLabel(/correo electrónico/i).fill(OWNER_A_EMAIL);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(passwordFor(OWNER_A_EMAIL));
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  // Wait for LEAVING the sign-in page, never for /inicio: that pathname is a
  // redirect-only router the address bar NEVER shows (owners land directly on
  // /mis-mascotas/<pet>). The same stale wait killed e2e/owner-shell.spec.ts
  // in every CI run before a11y-operator-auth documented it.
  await page.waitForURL(leftSignIn, { timeout: 15_000 });
}

/**
 * Log in as any seeded account and wait until the post-login redirect leaves
 * the sign-in page (owners land on /inicio, govt on /gob, org admins on /cuenta
 * or their org portal — this helper is role-agnostic).
 */
async function loginAs(page: Page, email: string): Promise<void> {
  await page.goto(SIGN_IN_PATH);
  // Refuse BEFORE typing: on a remote target only the rotated accounts may
  // receive E2E_STAGING_PASSWORD. isSeeded() checks the same thing, but a
  // caller that skipped isSeeded() would otherwise type it into the form.
  skipUnlessRemoteLoginAllowed(page.url(), email);
  const password = passwordFor(email);
  await page.getByLabel(/correo electrónico/i).fill(email);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL(leftSignIn, { timeout: 15_000 });
  await passSecondFactorIfAsked(page, email, password);
}

/**
 * Verify an account can sign in (via supabase-js). Returns true when seeded.
 * On a remote project a non-rotated account is reported NOT seeded without
 * any sign-in attempt: E2E_STAGING_PASSWORD is not its password, and trying it
 * there would type the rotated password into an account it does not belong to.
 */
async function accountSeeded(email: string): Promise<boolean> {
  if (remoteLoginRefusal(SUPABASE_URL, email)) return false;
  const password = passwordFor(email);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  return !error && !!data.user;
}

// ---------------------------------------------------------------------------
// Fixtures (resolved once per suite in beforeAll via globalSetup-equivalent)
// ---------------------------------------------------------------------------

let ownerAPetToken: string | null = null;
let ownerAUserId: string | null = null;
// Owner B's REAL identifiers (resolved by reading as Owner B). null when the
// owner2 fixture isn't seeded — real-Owner-B tests self-skip in that case.
let ownerBUserId: string | null = null;
let ownerBPetToken: string | null = null;
let ownerBPetId: string | null = null;
let ownerBPetName: string | null = null;
// Govt + org fixtures — true when the account is seeded (seed-test-users.ts).
// The govt/org scope tests skip VISIBLY (test.skip) when their account is
// absent. Never a bare `return`: a skipped test reports as skipped, a returned
// one reports as passed.
let govtSeeded = false;
let orgAdminSeeded = false;

/**
 * A MISSING FIXTURE FAILS THE SUITE. It used to set `setupSkip`, which a marker
 * test console.warn'd next to `expect(true).toBe(true)` while thirteen
 * authorization tests opened with `if (setupSkip) return;`. The comment on the
 * marker said "same pattern as matrix.test.ts" — and it was, right up until
 * P2.8 deleted that pattern from matrix.test.ts on 2026-07-31 for printing
 * green while asserting nothing. This is the sibling it did not reach.
 *
 * Thirteen cross-tenant assertions that all evaporate together on one unset env
 * var is not a graceful degradation; it is the entire authorization suite
 * agreeing to say yes. The required fixtures (anon key, Owner A + a pet) are
 * created by `pnpm db:bootstrap` — if they are missing the run is broken, and a
 * broken run must look broken.
 */
test.beforeAll(async () => {
  if (!SUPABASE_ANON_KEY) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY not set — the cross-tenant isolation suite cannot probe anything. Run db:bootstrap + seed:test, and check the CI job exports the real key (.github/actions/supabase-env).",
    );
  }

  const { userId, accessToken } = await signInOwnerA();
  ownerAUserId = userId;
  ownerAPetToken = await getOwnerAPetToken(accessToken);
  if (!ownerAPetToken) {
    throw new Error(
      "Owner A has no pets visible via PostgREST — every cross-tenant probe below would compare against nothing. Re-run pnpm seed:test.",
    );
  }

  // Owner B is genuinely optional: if the owner2 fixture is absent, the
  // real-Owner-B tests skip VISIBLY while the fabricated-UUID probes still run.
  const ownerB = await signInOwnerB();
  if (ownerB) {
    ownerBUserId = ownerB.userId;
    const bPet = await getOwnerBPet(ownerB.accessToken);
    if (bPet) {
      ownerBPetToken = bPet.token;
      ownerBPetId = bPet.id;
      ownerBPetName = bPet.name;
    }
  }

  // Govt + org accounts are optional fixtures (seed-test-users.ts).
  govtSeeded = await accountSeeded(GOVT_EMAIL);
  orgAdminSeeded = await accountSeeded(ORG_ADMIN_EMAIL);
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe("cross-tenant isolation — Owner A cannot access Owner B data", () => {
  // The fixtures are asserted in beforeAll, which THROWS. No marker test here:
  // a marker that always passes is not a gate, it is a decoration, and this one
  // sat above thirteen tests that trusted it.

  // -------------------------------------------------------------------------
  // 1. Pet profile page — /mis-mascotas/[token] scoped to Owner A
  // -------------------------------------------------------------------------
  test("Owner A on /mis-mascotas sees only own pets (not leaked names/tokens)", async ({
    page,
  }) => {
    await loginAsOwnerA(page);

    await page.goto("/mis-mascotas");
    await page.waitForLoadState("networkidle");
    await assertRealPage(page, "/mis-mascotas");

    // POSITIVE CONTROL — the registry actually rendered Owner A's own pet.
    // Without it, a page that lists NOTHING satisfies every negative assertion
    // below and the leak test passes on an empty screen. The selector is the
    // one discoverPetToken() already relies on: every card links to
    // /mis-mascotas/DIM-…, so a rendered pet is always a matching href.
    await expect(
      // .first(): the index legitimately renders more than one anchor to the
      // same pet (card + strip), which trips strict mode.
      page
        .locator(`a[href="/mis-mascotas/${ownerAPetToken}"]`)
        .first(),
      "Owner A's own pet never rendered on /mis-mascotas — the negative assertions below would pass vacuously",
    ).toBeVisible({ timeout: 20_000 });

    // THE ACTUAL LEAK ASSERTION. This test previously ended at "no application
    // error" + "main is visible" — it never mentioned Owner B, whose token, id
    // and pet were resolved in this very file and left unused. A mutation that
    // rendered EVERY pet in the database left it green.
    test.skip(
      !ownerBPetToken || !ownerBPetName,
      "owner2 fixture absent — cannot assert the absence of a specific foreign pet.",
    );

    const body = (await page.locator("body").innerText()).toLowerCase();
    const html = await page.content();

    expect(
      html.includes(ownerBPetToken as string),
      `cross-tenant leak: Owner B's pet token ${ownerBPetToken} appeared in Owner A's registry`,
    ).toBe(false);
    expect(
      body.includes((ownerBPetName as string).toLowerCase()),
      `cross-tenant leak: Owner B's pet name "${ownerBPetName}" appeared in Owner A's registry`,
    ).toBe(false);
    expect(
      html.includes(ownerBUserId as string),
      "cross-tenant leak: Owner B's user id appeared in Owner A's registry",
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. Direct URL manipulation — accessing /mis-mascotas/[owner-a-token] while
  //    logged in as Owner A should work (positive control).
  // -------------------------------------------------------------------------
  test("Owner A can access own pet profile page (positive control)", async ({ page }) => {
    await loginAsOwnerA(page);

    const response = await page.goto(`/mis-mascotas/${ownerAPetToken}`);

    // Must be a 2xx response (not 403 / 404).
    expect(response?.status()).toBeLessThan(400);
    await expect(page.getByText(/application error/i)).not.toBeVisible();

    // At least one content landmark rendered.
    await expect(page.locator("main, [role=main]").first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 3. Fabricated token — Owner A trying a garbage pet token gets a safe error,
  //    not a 500 or leaked data.
  // -------------------------------------------------------------------------
  test("fabricated pet token returns 404 / not-found (no 500, no leak)", async ({ page }) => {
    await loginAsOwnerA(page);

    const response = await page.goto("/mis-mascotas/not-a-real-pet-token-00000000");

    // Not-found surface, never a 500 or another user's data (streaming-safe —
    // see expectNotFoundSurface).
    await expectNotFoundSurface(
      page,
      response,
      "fabricated pet token must resolve to the not-found surface",
    );
  });

  // -------------------------------------------------------------------------
  // 3-REAL. The strongest full-stack cross-tenant assertion: Owner A opening
  // Owner B's REAL pet URL (owner2's "Rocco") must 404 — the action edge scopes
  // the pet query to the session owner. Self-skips if owner2 isn't seeded.
  // -------------------------------------------------------------------------
  test("Owner A gets 404 on Owner B's REAL pet URL (action-edge scoping)", async ({ page }) => {
    test.skip(!ownerBPetToken, "owner2 fixture absent — no real Owner B pet to probe.");
    await loginAsOwnerA(page);

    const response = await page.goto(`/mis-mascotas/${ownerBPetToken}`);

    // B's real token exists, but A must see the not-found surface, and none
    // of B's data (streaming-safe — see expectNotFoundSurface).
    await expectNotFoundSurface(
      page,
      response,
      "cross-tenant leak: Owner A opened Owner B's real pet page",
    );
    if (ownerBPetName) {
      await expect(
        page.getByText(ownerBPetName),
        "cross-tenant leak: Owner B's pet name rendered for Owner A",
      ).toHaveCount(0);
    }
  });

  // -------------------------------------------------------------------------
  // 4-REAL. PostgREST/RLS with a REAL target: Owner A cannot read Owner B's
  // real ownerships row (by B's real user id) nor B's real pet_events.
  // -------------------------------------------------------------------------
  test("PostgREST: Owner A cannot read Owner B's REAL ownerships / pet_events", async () => {
    test.skip(!ownerBUserId, "owner2 fixture absent — no real Owner B identity to probe.");

    const { accessToken } = await signInOwnerA();
    const client = clientAs(accessToken);

    const { data: ownershipRows } = await client
      .from("ownerships")
      .select("id")
      .eq("owner_user_id", ownerBUserId)
      .limit(1);
    expect((ownershipRows ?? []).length, "RLS leak: Owner A read Owner B's real ownerships").toBe(
      0,
    );

    if (ownerBPetId) {
      const { data: eventRows } = await client
        .from("pet_events")
        .select("id")
        .eq("pet_id", ownerBPetId)
        .limit(1);
      expect((eventRows ?? []).length, "RLS leak: Owner A read Owner B's real pet_events").toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // 4. PostgREST isolation — Owner A via supabase-js cannot read Owner A's own
  //    ownerships with a fabricated user id filter (cross-owner probe via RLS).
  //    This exercises the RLS layer directly (not the action edge).
  // -------------------------------------------------------------------------
  test("PostgREST: Owner A cannot read ownerships filtered to a different user id", async () => {
    const { accessToken } = await signInOwnerA();
    const client = clientAs(accessToken);

    // Attempt to read ownerships scoped to a fabricated (different) user id.
    const FABRICATED_ID = "00000000-dead-beef-0000-000000000000";
    const { data, error } = await client
      .from("ownerships")
      .select("*")
      .eq("owner_user_id", FABRICATED_ID)
      .limit(1);

    // RLS must prevent this — zero rows (or a PostgREST error).
    const rows = (data ?? []).length;
    expect(rows, `RLS leak: Owner A saw ownerships for fabricated userId (rows=${rows})`).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. PostgREST isolation — Owner A via supabase-js cannot read profiles rows
  //    for other users.
  // -------------------------------------------------------------------------
  test("PostgREST: Owner A cannot read profiles for a fabricated user id", async () => {
    const { accessToken } = await signInOwnerA();
    const client = clientAs(accessToken);

    const FABRICATED_ID = "00000000-dead-beef-0000-000000000001";
    const { data } = await client
      .from("profiles")
      .select("id, display_name")
      .eq("id", FABRICATED_ID)
      .limit(1);

    expect((data ?? []).length, "RLS leak: profiles row visible for fabricated user id").toBe(0);
  });

  // -------------------------------------------------------------------------
  // 6. PostgREST isolation — Owner A cannot read pet_events for a pet they do
  //    not own (using a well-formed but unowned UUID).
  // -------------------------------------------------------------------------
  test("PostgREST: Owner A cannot read pet_events for a fabricated pet id", async () => {
    const { accessToken } = await signInOwnerA();
    const client = clientAs(accessToken);

    const FABRICATED_PET_ID = "00000000-dead-beef-0000-000000000002";
    const { data } = await client
      .from("pet_events")
      .select("id")
      .eq("pet_id", FABRICATED_PET_ID)
      .limit(1);

    expect((data ?? []).length, "RLS leak: pet_events visible for unowned pet id").toBe(0);
  });

  // -------------------------------------------------------------------------
  // 7. PostgREST isolation — pet_identifications: Owner A cannot read
  //    identifications for a pet they do not own.
  //    Migration 0105 added owner-scoped SELECT; this verifies the
  //    non-owned case returns zero rows.
  // -------------------------------------------------------------------------
  test("PostgREST: Owner A cannot read pet_identifications for unowned pet", async () => {
    const { accessToken } = await signInOwnerA();
    const client = clientAs(accessToken);

    const FABRICATED_PET_ID = "00000000-dead-beef-0000-000000000003";
    const { data } = await client
      .from("pet_identifications")
      .select("id")
      .eq("pet_id", FABRICATED_PET_ID)
      .limit(1);

    expect(
      (data ?? []).length,
      "RLS leak: pet_identifications visible for unowned/fabricated pet",
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 8. PostgREST isolation — pet_transfers: Owner A cannot read transfers
  //    scoped to a fabricated user id (neither sender nor receiver).
  //    Migration 0105 added sender/receiver SELECT policies.
  // -------------------------------------------------------------------------
  test("PostgREST: Owner A cannot read pet_transfers for fabricated owner ids", async () => {
    const { accessToken } = await signInOwnerA();
    const client = clientAs(accessToken);

    const FABRICATED_OWNER_ID = "00000000-dead-beef-0000-000000000004";
    const { data } = await client
      .from("pet_transfers")
      .select("id")
      .or(`from_owner_id.eq.${FABRICATED_OWNER_ID},to_owner_id.eq.${FABRICATED_OWNER_ID}`)
      .limit(1);

    expect((data ?? []).length, "RLS leak: pet_transfers visible for fabricated owner id").toBe(0);
  });

  // -------------------------------------------------------------------------
  // 9. Anon cannot read any owner-scoped tables.
  //    Defense-in-depth smoke: the anon supabase-js client (no auth session)
  //    must see zero rows on the core owner tables.
  // -------------------------------------------------------------------------
  test("PostgREST: anon cannot read profiles, pets, ownerships, pet_events", async () => {
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const tables = ["profiles", "pets", "ownerships", "pet_events", "pet_identifications"] as const;

    for (const table of tables) {
      const { data, error } = await anonClient.from(table).select("id").limit(1);
      const rows = (data ?? []).length;
      expect(
        rows,
        `RLS leak: anon saw ${rows} row(s) in ${table}. error=${error?.message ?? "none"}`,
      ).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // 10. Govt jurisdiction scoping — a govt operator opening an approval-request
  //     page they cannot see (out-of-scope OR non-existent) must 404. The
  //     /gob/cola/[publicToken] page deliberately collapses "out of your
  //     jurisdiction" and "no such request" into the same notFound() so request
  //     existence is never leaked across jurisdictions (Deep Pass C: govt
  //     out-of-scope → notFound). Self-skips when govt@ isn't seeded.
  // -------------------------------------------------------------------------
  test("govt operator gets 404 on an approval request outside their jurisdiction", async ({
    page,
  }) => {
    test.skip(
      !govtSeeded,
      "govt@dim.test not seeded (or not a rotated e2e account on this remote target) — jurisdiction scope probe cannot run.",
    );
    await loginAs(page, GOVT_EMAIL);

    // A well-formed but foreign request token. govt@ covers only Ushuaia +
    // El Calafate; any request it cannot decide (out-of-scope or missing)
    // resolves to the same 404 — the page never leaks that a request exists.
    const response = await page.goto("/gob/cola/00000000-dead-beef-0000-0000000000aa");

    await expectNotFoundSurface(
      page,
      response,
      "govt scope leak: operator reached an out-of-scope/foreign approval request",
    );
  });

  // -------------------------------------------------------------------------
  // 11. Org portal scoping — an org admin opening a portal for an org they do
  //     NOT belong to must 404. The org layout (decision D4) collapses
  //     "not a member" and "no such org" into one notFound() so org existence
  //     never leaks (Deep Pass C: org → other-org → 404). Self-skips when
  //     orgadmin@ isn't seeded.
  // -------------------------------------------------------------------------
  test("org admin gets 404 on another org's portal (non-member = non-existent)", async ({
    page,
  }) => {
    test.skip(!orgAdminSeeded, "orgadmin@dim.test not seeded — org scope probe cannot run.");
    await loginAs(page, ORG_ADMIN_EMAIL);

    // A foreign org token the admin has no membership in. The org layout must
    // notFound() without leaking whether the org exists.
    const response = await page.goto("/org/DIM-ORG-NOT-A-REAL-TOKEN/mascotas");

    await expectNotFoundSurface(
      page,
      response,
      "cross-org leak: org admin reached a portal for an org they don't belong to",
    );
  });
});
