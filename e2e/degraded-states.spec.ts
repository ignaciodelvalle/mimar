import { type Page, expect, test } from "@playwright/test";

import {
  DEGRADED_CARD_MS,
  DEGRADED_COPY,
  DEGRADED_TEXT_MS,
  MUTATION_RETRY_COPY,
  RETRY_DISABLE_MS,
} from "@/lib/ui/degraded-states";

import { speciesLabel } from "../lib/utils/species";
import { deletePetsByNamePrefix, isLocalDatabase } from "./demo/_db-cleanup";
import { ACCOUNTS, loginAs } from "./demo/_helpers";

/**
 * degraded-states (2026-08-06, commits 290d4079..b4a76368) under REAL adverse
 * conditions — the two halves the unit tests cannot reach:
 *
 *   (a) a loading boundary that genuinely STALLS escalates skeleton → waiting
 *       text (8s) → degraded card (20s), and its "Reintentar" is a real
 *       full-document GET;
 *   (b) a mutation whose transport genuinely FAILS (503) keeps the typed input,
 *       offers a same-key retry, and that retry creates exactly ONE event.
 *
 * ─── WHY THIS SPEC IS SLOW, AND WHY THAT IS CORRECT ───────────────────────
 * The escalation is PURE CSS: `.degraded-reveal` + an inline `animation-delay`
 * of DEGRADED_TEXT_MS / DEGRADED_CARD_MS, with `animation-fill-mode: backwards`
 * so the `from` keyframe (`opacity:0; visibility:hidden`) applies THROUGHOUT the
 * delay. That design is load-bearing — the failure it covers is a hydration
 * stall, exactly the state where a JS timer never fires — and it has two
 * consequences for this spec:
 *
 *   1. THE NODES EXIST FROM t=0. Every assertion below must therefore check
 *      VISIBILITY, never DOM presence: Playwright's toBeVisible() resolves
 *      computed styles and honours `visibility:hidden`, so it is the only
 *      probe that can tell "not yet revealed" from "revealed".
 *   2. THE CLOCK CANNOT BE FAST-FORWARDED. page.clock controls Date and the
 *      timer queue; it does not advance CSS animation/transition time in the
 *      compositor, so `page.clock.fastForward(20_000)` leaves the reveal
 *      exactly where it was. Overriding the delay with an injected stylesheet
 *      would defeat the point — the 8s/20s schedule IS the contract under test,
 *      and a spec that rewrites it proves only that CSS applies stylesheets.
 *      So this test waits REAL time (~30s of it). Deliberate, bounded, and
 *      commented at each wait; it is nightly-tier cost for first-wave coverage
 *      of a resilience surface that has no other honest probe.
 *
 * ─── HOW A STALL IS MANUFACTURED (the non-obvious part) ────────────────────
 * A route-level `loading.tsx` is only OBSERVABLE for a client-side (soft)
 * navigation. On a hard navigation the fallback and the resolved segment travel
 * in ONE streamed document response, and Playwright's route interception cannot
 * delay the middle of a stream — `route.fulfill` buffers, so delaying the
 * document delays the fallback too and nothing ever paints.
 *
 * On a soft navigation the two halves are separable — but ONLY for the right
 * KIND of prefetch. All three variants were measured live against the QA build
 * (2026-08-07) before this spec settled on the third:
 *
 *   ✗ COLD link (no prefetch at all). The click does issue a `?_rsc=` request,
 *     and holding it holds the navigation — but the router has no loading
 *     segment to show, so it simply KEEPS THE OLD PAGE. Measured: url stayed
 *     /gob/casos for 9.5s with no boundary in the DOM. Nothing to assert.
 *   ✗ The DESKTOP OPERATOR RAIL. It sets `prefetch={false}` (the 2026-07-10
 *     self-DoS fix) and re-adds an EXPLICIT `router.prefetch(href)` on pointer
 *     intent — and the programmatic router.prefetch() is a FULL prefetch: it
 *     caches the entire payload, so the click resolves from cache and never
 *     touches the network. Measured: 0 requests intercepted, h1 "Aprobaciones"
 *     already painted at +500ms. The hover warm-up DESTROYS the stall, and
 *     `locator.click()` auto-hovers, so the rail cannot be used even cold.
 *   ✓ A DEFAULT `<Link>` (prefetch auto) — the mobile AppShellDrawer. Auto
 *     prefetch caches ONLY up to the first loading.tsx boundary, so the click
 *     renders that boundary instantly AND still issues a separate `?_rsc=`
 *     request for the dynamic payload. Holding that one request is a faithful
 *     model of what this feature exists for: the shell is up, the section is
 *     not coming. Measured: boundary visible at +700ms, waiting text revealed
 *     between +6.0s and +9.5s, card still hidden — the contract, live.
 *
 * The two prefetch requests are told apart by `Next-Router-Prefetch: 1`, which
 * the auto prefetch carries and the navigation payload does not.
 *
 * SURFACE CHOICE. `/gob/cola` is used rather than the anonymous
 * `/p/[publicToken]`: the public credential's DegradedFallback wraps an INLINE
 * <Suspense> (no loading.tsx, so no soft-nav seam) and is gated behind
 * `tier2Active`, an owner opt-in flag no bootstrap seed sets. `/gob/cola` is
 * bootstrap-reachable for ACCOUNTS.govt (requireAdminOrGovtOrRedirect) and has
 * a DegradedFallback loading.tsx from this very commit range.
 */

// Held-request budget. Must comfortably outlast the whole escalation walk
// (0 → 20s reveal + assertion slack) so the boundary never resolves underneath
// an assertion and turn a timing failure into a confusing "content appeared".
const RSC_HOLD_MS = 60_000;

// Pets created here are cleaned up by prefix (registration is append-only —
// there is no "delete my pet" flow, by design). Same contract as
// e2e/create-pet.spec.ts: unique per run so a crashed run cannot collide, and
// swept both BEFORE and AFTER so a previous crash cannot poison this one.
const PET_NAME_PREFIX = "E2EDeg-";
const RUN_ID = Date.now();
const PET_NAME = `${PET_NAME_PREFIX}${RUN_ID}`;
// Free text on purpose: it must NOT match the species catalog, so
// `findVaccineByName` misses, `suggestedNextDue` stays empty, and no
// "próxima dosis" reminder is created that would echo the name a second time
// on the libreta and make the exactly-one-event count ambiguous.
const VACCINE_NAME = `E2EVac-${RUN_ID}`;
const BATCH_VALUE = `LOTE-${RUN_ID}`;

const PROVINCE_CODE = "AR-C"; // CABA — the cascade needs a province before a locality.

test.beforeAll(async () => {
  const removed = await deletePetsByNamePrefix(PET_NAME_PREFIX);
  if (removed > 0) {
    console.log(`[degraded-states] cleared ${removed} leftover pet(s) from earlier runs`);
  }
});

test.afterAll(async () => {
  await deletePetsByNamePrefix(PET_NAME_PREFIX);
});

// ---------------------------------------------------------------------------
// (1) + (2) — slow-load escalation, and Reintentar as a full-document GET
// ---------------------------------------------------------------------------

test("a stalled loading boundary escalates at 8s and 20s, and Reintentar is a full-document GET", async ({
  page,
}) => {
  // ~30s of real waiting (see the header) + login + two page loads.
  test.setTimeout(180_000);

  // MOBILE viewport on purpose — see the header. The desktop operator rail
  // cannot produce this stall (explicit full router.prefetch on hover, and
  // locator.click() auto-hovers); the mobile AppShellDrawer renders the SAME
  // nav sections through a default <Link>, whose auto prefetch caches only the
  // loading boundary. This is also a real operator path, not a contrivance.
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, ACCOUNTS.govt);

  // Start on a DIFFERENT gob route so the drawer link to /gob/cola is a real
  // navigation. /gob/casos is the surface e2e/gob-case-detail-shell.spec.ts
  // already proves is reachable for this account.
  await page.goto("/gob/casos", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // ── Warm the loading boundary ────────────────────────────────────────────
  // Armed BEFORE the drawer opens: the auto prefetch fires as soon as the link
  // is rendered INSIDE THE VIEWPORT (see the scroll below), and losing that race would leave the boundary
  // uncached (the router would then keep the OLD page and there would be
  // nothing to measure). `Next-Router-Prefetch: 1` is what separates it from
  // the navigation payload that follows.
  const prefetched = page
    .waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/gob/cola" &&
          response.request().headers()["next-router-prefetch"] === "1"
        );
      },
      { timeout: 25_000 },
    )
    .catch(() => null);

  await page.getByRole("button", { name: /abrir men/i }).click();
  // The rail and the drawer both label their <nav> "Navegación principal", so
  // filter to the one actually on screen. The accessible name folds a
  // pending-count badge in ("Aprobaciones — 3 pendientes"), hence the anchor.
  const approvals = page
    .getByRole("link", { name: /^Aprobaciones/ })
    .filter({ visible: true })
    .first();
  await expect(
    approvals,
    'the drawer must expose the "Aprobaciones" (/gob/cola) link — without a real soft navigation there is no separable loading boundary to stall',
  ).toBeVisible({ timeout: 20_000 });

  // ── Bring the link into the VIEWPORT, which is what triggers the prefetch ─
  // `toBeVisible` above is not "on screen": Playwright's visibility is a
  // non-empty box with no `visibility:hidden`, and a link scrolled out of the
  // drawer's `overflow-y-auto` list passes it. Next's auto prefetch fires from
  // an IntersectionObserver, i.e. only once the <Link> actually intersects the
  // viewport. "Aprobaciones" used to sit inside the first screen of the
  // 390x844 drawer by luck of the nav's length. The last green CI run is
  // 4459e670d; the first red one, 2540d9924, is the range that added the
  // "Cola ENO" entry above it (a20a3c1f6) — the only nav change in that range —
  // and from then on the prefetch never fired and the assertion below reported
  // exactly that on every run. Reproduced locally before this scroll existed. An
  // operator scrolls the drawer to the item before tapping it; so does this
  // test, and then PROVES the link is on screen so the precondition cannot
  // silently drift again.
  await approvals.scrollIntoViewIfNeeded();
  await expect(
    approvals,
    'the "Aprobaciones" link must be inside the viewport — Next only auto-prefetches a <Link> that intersects it',
  ).toBeInViewport();

  expect(
    await prefetched,
    "Next's AUTO prefetch (Next-Router-Prefetch: 1) must land before the click — it is what caches the loading.tsx boundary. Without it the router keeps the old page on a held navigation and this test measures nothing",
  ).not.toBeNull();

  // ── Hold the navigation payload ──────────────────────────────────────────
  // The matcher is hoisted to a const because page.unroute() identifies a
  // registered route by REFERENCE — an equivalent inline arrow would silently
  // remove nothing and leave the interceptor installed for the rest of the test.
  const colaUrls = (url: URL) => url.pathname === "/gob/cola";
  let holdRsc = true;
  await page.route(colaUrls, async (route) => {
    const request = route.request();
    const headers = request.headers();
    const isRsc = headers.rsc === "1" || new URL(request.url()).searchParams.has("_rsc");
    const isPrefetch = headers["next-router-prefetch"] === "1";
    // Let the DOCUMENT request through untouched — part (2) below depends on
    // Reintentar's full-document GET completing normally. Let prefetches
    // through too: only the navigation payload is the subject here.
    if (!holdRsc || !isRsc || isPrefetch) {
      await route.continue().catch(() => {});
      return;
    }
    const deadline = Date.now() + RSC_HOLD_MS;
    while (holdRsc && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // The browser cancels this request when Reintentar navigates the
    // document away — a rejection here is the expected end of the hold.
    await route.continue().catch(() => {});
  });

  // t0 is taken BEFORE the click on purpose. The CSS animation starts when
  // React inserts the fallback, i.e. AT OR AFTER this instant, so every
  // "still hidden by now" assertion below is measured conservatively early and
  // every "revealed by now" assertion is given slack.
  const t0 = Date.now();
  await approvals.click();

  const skeleton = page.locator('output[aria-busy="true"]').first();
  const slowText = page.getByText(DEGRADED_COPY.slowText);
  // The card WRAPPER carries the 20s delay; `visibility` is inherited, so
  // probing the wrapper and probing its title are equivalent — the wrapper is
  // used for the negative assertions because it exists independently of copy.
  const degradedCard = page.locator("[data-degraded-cycle]").first();
  const cardTitle = page.getByText(DEGRADED_COPY.cardTitle);
  const retryLink = page.getByRole("link", { name: DEGRADED_COPY.retry, exact: true });
  const keepWaiting = page.getByRole("button", { name: DEGRADED_COPY.keepWaiting, exact: true });

  await expect(
    skeleton,
    "the prefetched loading.tsx boundary must render immediately on the soft navigation — if this fails the router cache did not carry the loading segment, so nothing about the escalation was measured",
  ).toBeVisible({ timeout: 15_000 });

  // ── Stage 0 (t < 8s): the plain skeleton, and nothing else ───────────────
  await expect(
    slowText,
    "the waiting text must NOT be revealed while the load is still within its normal budget",
  ).toBeHidden();
  await expect(degradedCard, "the degraded card must NOT be revealed at t=0").toBeHidden();

  // Held just short of the 8s threshold: still the quiet skeleton.
  await waitUntil(page, t0, DEGRADED_TEXT_MS - 1_500);
  await expect(
    slowText,
    `the waiting text revealed EARLY — it must not appear before DEGRADED_TEXT_MS (${DEGRADED_TEXT_MS}ms)`,
  ).toBeHidden({ timeout: 1_000 });

  // ── Stage 1 (t ≥ 8s): waiting text, skeleton retained ────────────────────
  await expect(
    slowText,
    `the waiting text must be visible once DEGRADED_TEXT_MS (${DEGRADED_TEXT_MS}ms) has elapsed`,
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    skeleton,
    "the base skeleton stays alongside the waiting text — the escalation adds, it does not replace",
  ).toBeVisible();
  await expect(
    degradedCard,
    "the degraded card must still be hidden at the 8s stage — the two delays are independent, both measured from the same mount",
  ).toBeHidden({ timeout: 1_000 });

  // Held just short of the 20s threshold: still no card.
  await waitUntil(page, t0, DEGRADED_CARD_MS - 2_000);
  await expect(
    degradedCard,
    `the degraded card revealed EARLY — it must not appear before DEGRADED_CARD_MS (${DEGRADED_CARD_MS}ms)`,
  ).toBeHidden({ timeout: 1_000 });

  // ── Stage 2 (t ≥ 20s): the degraded card and both affordances ────────────
  await expect(
    cardTitle,
    `the degraded card must be visible once DEGRADED_CARD_MS (${DEGRADED_CARD_MS}ms) has elapsed`,
  ).toBeVisible({ timeout: 12_000 });
  await expect(
    page.getByText(DEGRADED_COPY.cardDescription),
    "the card states the honest cause",
  ).toBeVisible();
  await expect(retryLink, "the card offers Reintentar").toBeVisible();
  await expect(
    keepWaiting,
    '"Seguir esperando" is hydration-gated progressive enhancement — it renders here because the page IS hydrated (only the section stalled)',
  ).toBeVisible();

  // ── (2) Reintentar is a REAL full-document GET, not a soft navigation ────
  // A marker on `window` is the crisp discriminator: a soft navigation keeps
  // the JS context (marker survives), a full-document GET destroys it.
  await page.evaluate(() => {
    (window as unknown as { __degradedProbe?: string }).__degradedProbe = "alive";
  });

  const documentRequested = page.waitForRequest(
    (request) =>
      request.resourceType() === "document" && new URL(request.url()).pathname === "/gob/cola",
    { timeout: 20_000 },
  );
  // Fired, not awaited — a click that navigates the document away can leave
  // Playwright's post-click wait unsettled (the same hazard e2e/create-pet and
  // walkDenunciaWizard document). The request below is the real assertion.
  void retryLink.click().catch(() => {});
  const documentRequest = await documentRequested;
  expect(
    documentRequest.method(),
    'Reintentar is an <a href=""> — a full-document GET of the current URL, resolvable with zero JS (that is the whole point: router.refresh() is fenced and window.location needs the hydration whose stall this covers)',
  ).toBe("GET");

  // With the hold released and the document reloaded, the section must load
  // normally — no escalation, no skeleton left behind.
  holdRsc = false;
  await page.unroute(colaUrls);
  await page.waitForLoadState("domcontentloaded");

  const probe = await page
    .evaluate(() => (window as unknown as { __degradedProbe?: string }).__degradedProbe ?? null)
    .catch(() => null);
  expect(
    probe,
    "the pre-click window marker survived — Reintentar performed a SOFT navigation, which cannot recover a stalled hydration",
  ).toBeNull();

  await expect(
    page.getByRole("heading", { name: "Aprobaciones", exact: true }),
    "/gob/cola renders its real content once the interception is lifted",
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(DEGRADED_COPY.slowText),
    "a healthy load never reveals the waiting text",
  ).toBeHidden();
  await expect(
    page.locator("[data-degraded-cycle]"),
    "a healthy load never reveals the degraded card",
  ).toBeHidden();
});

// ---------------------------------------------------------------------------
// (3) — a 503 on the vaccination submit is recoverable, and the retry is
//       idempotent: exactly ONE event, never two.
// ---------------------------------------------------------------------------

test("a 503 on the vaccination submit preserves the form and the same-key retry creates exactly one event", async ({
  page,
}) => {
  // Login + a full alta walk + two mutation round trips.
  test.setTimeout(240_000);

  // ENVIRONMENT-KEYED, not data-keyed: this test CREATES a pet, and pets can
  // only be removed by the direct-to-Postgres helper, which is a no-op off a
  // local database. Running it against staging would leak an undeletable
  // E2EDeg- pet into the owner's registry — and crisis-owner-lost-flow picks an
  // arbitrary active pet of this same owner to mark LOST.
  test.skip(
    !isLocalDatabase(),
    "NO COVERAGE (non-local database): this test registers a pet, and cleanup (deletePetsByNamePrefix) only runs against a local Postgres. Skipped rather than leaking an undeletable test pet into a shared registry.",
  );

  await loginAs(page, ACCOUNTS.owner);

  // A DEDICATED pet, not a seeded one. createVaccinationAction carries a
  // SAME-DAY duplicate guard (`findSameDayEventOfType`) that returns a
  // `sameDayPrompt` INSTEAD of inserting — so a second run on the same day, or
  // CI's `retries: 1` after a failure, would hit the prompt on a shared pet and
  // the retry would prove nothing. A fresh pet per run makes the guard
  // structurally unreachable.
  const petToken = await registerPet(page, PET_NAME);

  await page.goto(`/mis-mascotas/${petToken}/eventos/nuevo/vacuna`, {
    waitUntil: "domcontentloaded",
  });
  const vaccineInput = page.locator('input[name="vaccineName"]');
  await expect(vaccineInput, "the vaccination form rendered").toBeVisible({ timeout: 20_000 });

  await vaccineInput.fill(VACCINE_NAME);
  // Filling the next field blurs the combobox, whose listbox would otherwise
  // overlay the footer CTA (LnCombobox blurCloseDelayMs=120).
  await page.locator('input[name="batch"]').fill(BATCH_VALUE);
  await expect(
    page.locator('input[name="nextDueAt"]'),
    "a free-text vaccine name matches no catalog entry, so no next-dose suggestion (and therefore no reminder echoing the name on the libreta)",
  ).toHaveValue("");

  const idempotencyKey = await page
    .locator('input[name="clientIdempotencyKey"]')
    .inputValue()
    .catch(() => "");
  expect(
    idempotencyKey,
    "the form must carry a clientIdempotencyKey — useRetryableAction refuses to wire retry without one, because retry-with-key is only safe where the server dedupes",
  ).not.toBe("");
  const occurredAt = await page.locator('input[name="occurredAt"]').inputValue();

  // ── Intercept the server-action POST exactly ONCE ────────────────────────
  // Server actions POST to the page's own URL carrying a `next-action` header.
  // A 503 with a non-RSC body is what the platform actually returns under a
  // capacity spike, and it makes Next's action fetch REJECT client-side —
  // the precise condition useRetryableAction was built to catch.
  let failuresServed = 0;
  const actionPath = `/mis-mascotas/${petToken}/eventos/nuevo/vacuna`;
  await page.route(
    (url) => url.pathname === actionPath,
    async (route) => {
      // A server action POSTs to the page's OWN url (carrying a `Next-Action`
      // header); nothing else on this route posts, so the method alone is a
      // safe discriminator and does not depend on header casing/exposure.
      const isAction = route.request().method() === "POST";
      if (!isAction || failuresServed >= 1) {
        await route.continue().catch(() => {});
        return;
      }
      failuresServed += 1;
      await route.fulfill({
        status: 503,
        contentType: "text/plain; charset=utf-8",
        body: "Service Unavailable (e2e degraded-states intercept)",
      });
    },
  );

  await page.getByRole("button", { name: /registrar vacuna/i }).click();

  // ── The failure is RECOVERABLE, not an unmount ───────────────────────────
  const errorCard = page.getByText(MUTATION_RETRY_COPY.title);
  await expect(
    errorCard,
    "a rejected dispatch must render MutationErrorCard, not blow the form away through the nearest error boundary",
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(MUTATION_RETRY_COPY.cause),
    "the card owns the cause line (the plain error <p> is gated off so it is not said twice)",
  ).toBeVisible();
  expect(failuresServed, "the 503 was actually served").toBe(1);

  // THE point of the whole mechanism: what the owner typed is still there.
  await expect(vaccineInput, "the typed vaccine name survived the failure").toHaveValue(
    VACCINE_NAME,
  );
  await expect(page.locator('input[name="batch"]'), "the typed batch survived").toHaveValue(
    BATCH_VALUE,
  );
  await expect(page.locator('input[name="occurredAt"]'), "the date survived").toHaveValue(
    occurredAt,
  );
  await expect(
    page.locator('input[name="clientIdempotencyKey"]'),
    "the idempotency key is UNCHANGED — this is what makes the retry a confirmation rather than a duplicate",
  ).toHaveValue(idempotencyKey);

  // ── Retry, with the interception already spent ───────────────────────────
  const retrySubmit = page.getByRole("button", { name: MUTATION_RETRY_COPY.retry, exact: true });
  // Retry Backoff: the button disables for RETRY_DISABLE_MS after each press.
  // The FIRST press is never in cooldown, but wait on the real state rather
  // than assume it — a disabled-button click would burn the action timeout.
  await expect(retrySubmit, "the retry button is offered and not in cooldown").toBeEnabled({
    timeout: RETRY_DISABLE_MS + 5_000,
  });
  await retrySubmit.click();

  // Do NOT wait on the post-action URL (e2e/README — the client half of the N3
  // redirect contract drops often enough to matter). The card CLEARING is the
  // state change that proves the retry resolved; assert the outcome after.
  await expect(
    errorCard,
    "the same-key retry must resolve — either the write succeeded or the server recognised the key and answered with the confirmation",
  ).toBeHidden({ timeout: 60_000 });

  // ── EXACTLY ONE event ────────────────────────────────────────────────────
  // Read through the product's own libreta, not the database. The row is an
  // <article data-section="asiento"> whose `.ln-asiento-title` is the RAW
  // vaccine name under a "VACUNA" eyebrow (components/pet-profile/AsientoCard
  // + asiento-fields.ts) — NOT the `Vacuna: {name}` string lib/events/events.ts
  // builds for other surfaces, which is what the first live run got wrong. The
  // pet is brand new, so the count is unambiguous: two rows here would mean the
  // idempotency key failed to dedupe, and under invariant #2 (append-only) that
  // duplicate could never be removed.
  await page.goto(`/mis-mascotas/${petToken}?tab=libreta`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await expect(
    page.locator('[data-section="asiento"]').filter({ hasText: VACCINE_NAME }),
    "the retry must produce EXACTLY ONE vaccination event — 0 means the retry never persisted, 2 means the same idempotency key was written twice",
  ).toHaveCount(1, { timeout: 30_000 });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sleep until `ms` after `t0`, and not a moment longer.
 *
 * The suite's standing rule is "no arbitrary sleep" — and this is not one. The
 * SUBJECT of this spec is a wall-clock schedule that cannot be simulated (see
 * the file header), so the wait is the measurement. Anchored on t0 rather than
 * chained so assertion time never accumulates into the next threshold.
 */
async function waitUntil(page: Page, t0: number, ms: number): Promise<void> {
  const remaining = t0 + ms - Date.now();
  if (remaining > 0) await page.waitForTimeout(remaining);
}

/**
 * Register a pet through the real 2-step alta wizard and return its public
 * token, read from the URL the create redirects to.
 *
 * Mirrors e2e/create-pet.spec.ts step for step (province-first cascade, the
 * paso-1/paso-2 split, and the fire-and-forget submit whose click promise never
 * settles on the N3 client-side navigation). Duplicated rather than hoisted:
 * that spec's SUBJECT is the alta, and a shared helper would let a change to
 * this file quietly redefine what create-pet asserts.
 */
async function registerPet(page: Page, name: string): Promise<string> {
  await page.goto("/mis-mascotas/nueva", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: /registrar (tu primera )?mascota/i }),
    "the alta wizard rendered",
  ).toBeVisible({ timeout: 20_000 });

  await page.getByLabel(/^nombre/i).fill(name);
  // Etiqueta desde `speciesLabel`, la única fuente — ver la nota en
  // e2e/create-pet.spec.ts: el literal /perro\/a/i quedó obsoleto el 2026-08-09.
  await page.getByRole("button", { name: speciesLabel("dog"), exact: true }).click();
  await page.getByRole("radio", { name: /macho/i }).check();

  await page.getByLabel(/provincia/i).selectOption(PROVINCE_CODE);
  const locality = page.getByLabel(/localidad o barrio/i);
  await expect(locality, "the locality field unlocks once a province is picked").toBeEnabled();
  await locality.fill("Palermo");
  await expect(
    page.getByRole("option", { name: /Palermo/i }).first(),
    "the province-scoped locality search returned a match",
  ).toBeVisible({ timeout: 20_000 });
  await locality.press("Enter");
  await expect(
    page.locator('input[name="localityName"]'),
    "the picker captured a locality (paso 1 has a required-locality guard)",
  ).toHaveValue(/.+/);

  await page.getByRole("button", { name: /continuar/i }).click();
  await expect(page.getByText(/tomar o elegir una foto/i), "paso 2 revealed").toBeVisible();

  // Fired, not awaited — createPetAction returns `redirectTo` and the form
  // navigates client-side (N3), a transition Playwright's post-click wait never
  // sees settle. The waitForURL below is the real assertion.
  void page
    .getByRole("button", { name: /registrar mascota/i })
    .click()
    .catch(() => {});

  await page.waitForURL(
    (url) => url.pathname.startsWith("/mis-mascotas") && !url.pathname.endsWith("/nueva"),
    { timeout: 60_000 },
  );

  // Lands on /mis-mascotas/nueva/{token}/credencial. Anchor on the DIM- prefix
  // rather than a positional segment (tokens are random by construction —
  // lib/infra/publicToken.ts — so nothing here may be hardcoded).
  const token = new URL(page.url()).pathname.split("/").find((s) => s.startsWith("DIM-")) ?? "";
  expect(token, "public token parsed from the post-alta URL").toMatch(/^DIM-/);
  return token;
}
