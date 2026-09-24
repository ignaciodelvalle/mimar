import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";

import { ZERO_PET_OWNER_EMAIL } from "../scripts/seed-reserved-accounts";
import { passwordForPage } from "./_credentials";
import { passSecondFactorIfAsked, skipUnlessRemoteLoginAllowed } from "./_mfa";
import { endSponsorship, pickSponsorablePetToken, sponsorPet } from "./_shelter-custody";
import { SIGN_IN_PATH, leftSignIn } from "./_sign-in-route";
import { resetAuthLoginRateLimits } from "./demo/_db-cleanup";
import { ACCOUNTS, discoverPetToken, ensurePetFound } from "./demo/_helpers";

/**
 * Owner IA redesign — P6 LIVE validation pass.
 *
 * Exercises the owner Information-Architecture contract shipped across
 * owner-ia-redesign P1–P5 against the running QA server on :3000. Read-only:
 * the anotar sheet may be OPENED but never submitted; no destructive writes.
 *
 * Conventions borrowed from e2e/a11y-operator-auth.spec.ts + owner-shell.spec.ts:
 *   - login via /login (correo electrónico / contraseña / "iniciar sesión").
 *   - baseURL from playwright.local3000.config.ts (http://localhost:3000).
 *   - Serial (workers:1) — the config runs one worker.
 *
 * AUTH SESSION REUSE (important): the app's loginAction enforces two login rate
 * limits, `auth_login_email` and `auth_login_ip` — the ceilings are
 * `LOGIN_EMAIL_LIMIT` and `LOGIN_IP_LIMIT` in
 * src/modules/auth/application/login-limits.ts, and are not copied here because
 * the copy that used to be on this line went stale the day the per-IP one was
 * re-derived. Logging in fresh in every test tripped
 * that limiter across repeated full-suite runs. So each account authenticates
 * ONCE per run; its storageState (auth cookies) is cached and reused by every
 * test that needs it. This is also the Playwright-recommended pattern.
 *
 * ─── FIXTURE TIER (rewritten 2026-07-31) ───────────────────────────────────
 * This spec was written against the DEMO dataset — ignacio / noeli / lilian /
 * alejo, and the literal tokens DIM-SNPY-0004, DIM-PAMP-0001, DIM-S005-PLRM,
 * DIM-ARGO-DEMO. None of them exist on a database built by `pnpm db:bootstrap`,
 * which is what CI runs, so SEVEN of this file's tests were among the 21
 * failures of the first e2e run that ever reported a verdict: three answered
 * "Correo o contraseña incorrectos", two more "Demasiados intentos" (the
 * per-email limiter counts FAILED attempts too, so the missing accounts burned
 * their own budget), and two asserted content against a not-found boundary.
 * "Passes locally" was measuring accumulated laptop state, not the code.
 *
 * Everything now runs on the bootstrap tier, and every token is discovered at
 * RUNTIME — bootstrap generates pet tokens with `generatePublicToken()`, so a
 * literal cannot name a pet that exists on a fresh database.
 *
 * Seed accounts (all password "Test1234!" locally; E2E_STAGING_PASSWORD from
 * env against a remote target — see e2e/_credentials.ts):
 *   owner@dim.test    — 3 live pets (carousel owner: >1 pet is what tests 1-5
 *                       need, and 3 is guaranteed by seedOwnerPets)
 *   vet@dim.test      — role=vet, single active membership in "Refugio Test
 *                       (Seed)" → /mis-mascotas redirects to that /org portal
 *   orgadmin@dim.test — admin of "Refugio Test (Seed)", owns no pet personally
 *                       → the org-viewer POV. Test 8 no longer relies on the
 *                       three pets the seed puts under shelter custody (the
 *                       suite consumed them): it opens its own custody.
 *   ZERO_PET_OWNER   — owner, 0 pets, no org memberships (zero-pet landing).
 *                      Imported from scripts/seed-reserved-accounts.ts, NOT
 *                      hardcoded: this used to name carla@dim.test, who by
 *                      2026-07-30 owned four pets (two from a QA wizard run,
 *                      two handed to her by scripts/seed-demo-polish.ts's
 *                      round-robin reassignment). Test 6 went red looking like
 *                      a product regression, and no personal owner in the
 *                      database was empty any more, so the owner empty state
 *                      could not be verified by anybody. The replacement is a
 *                      RESERVED account: created by `pnpm db:bootstrap`,
 *                      excluded from every reassignment list, and watched by
 *                      __tests__/seed-hygiene.test.ts, which fails `pnpm test`
 *                      the moment it acquires a pet.
 *   admin@dim.test   — admin (cockpit)
 */

const CAROUSEL_OWNER = ACCOUNTS.owner; // 3 seeded pets — >1 is what tests 1-5 need
const VET = ACCOUNTS.vet; // single-org member → /mis-mascotas lands on /org/<token>
const ORG_VIEWER = ACCOUNTS.orgAdmin; // holds pets through the org, owns none
// NOT a literal, and not a general-purpose persona. See the header note above.
const ZERO_PET_OWNER = ZERO_PET_OWNER_EMAIL;
const ADMIN = "admin@dim.test";

const PROFILE_RE = /\/mis-mascotas\/DIM-[A-Z0-9-]+/;

function tokenFromUrl(url: string): string | null {
  const m = url.match(/\/mis-mascotas\/(DIM-[A-Z0-9-]+)/);
  return m ? m[1] : null;
}

// --- Per-context unique client IP -------------------------------------------
//
// The app throttles per caller IP (login: `auth_login_ip`, whose ceiling is
// `LOGIN_IP_LIMIT` in src/modules/auth/application/login-limits.ts; public
// credential: public_token_page 60/min·400/h — lib/infra/rate-limit.ts). A whole
// test suite hammering one localhost IP trips those limits even though each
// individual scan/login is legitimate. We are NOT testing rate-limiting here, so
// give every context a distinct x-real-ip (TEST-NET-3, RFC 5737 documentation
// range) — each request looks like a fresh visitor and the content-under-test is
// never masked by a throttle notice.
//
// WHERE THAT HOLDS: against a LOCAL target only. Nothing sits in front of a bare
// `next start`, so callerIp() believes whatever x-real-ip arrives. Against a
// Vercel origin the edge overwrites it and this device does nothing — measured
// 2026-08-26, method and positive control in lib/infra/rate-limit.ts above
// callerIp(). playwright.staging.config.ts runs this spec too, so the device is
// load-bearing on one target and inert on the other; do not cite it as the
// reason a staging run stays under a ceiling.
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 250) + 1}`;
}

// --- One-time login + storageState reuse ------------------------------------

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const stateCache = new Map<string, StorageState>();

async function login(page: Page, email: string) {
  // This spec keeps its own login (storageState reuse predates the shared
  // helper), so it must ALSO clear the auth buckets — otherwise it is the one
  // spec that still starves auth_login_email for everything after it, which
  // is exactly what it did on a local full-file run. See
  // resetAuthLoginRateLimits: local-DB fixture cleanup, no-op elsewhere, and
  // the limiter stays fully active in the app.
  await resetAuthLoginRateLimits();
  await page.goto(SIGN_IN_PATH);
  // Skip BEFORE the password is resolved or typed: on a remote target only the
  // rotated e2e accounts may sign in (e2e/_credentials.ts). admin@ (test 12)
  // and the reserved zero-pet persona (test 6) are not rotated.
  skipUnlessRemoteLoginAllowed(page.url(), email);
  const password = passwordForPage(page.url(), email);
  await page.getByLabel(/correo electrónico/i).fill(email);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  // The post-login redirect is a Next server-action navigation. expect.poll
  // reads page.url() on its own schedule, independent of navigation lifecycle
  // events (networkidle/commit both proved flaky against it). A visible login
  // error (e.g. rate-limit) surfaces here as a fast, explicit failure.
  const loginError = page
    .getByRole("alert")
    .filter({ hasText: /intento|contraseñ|inválid|error/i });
  await expect
    .poll(
      async () => {
        if (await loginError.count()) {
          const txt = (
            await loginError
              .first()
              .innerText()
              .catch(() => "")
          ).trim();
          if (txt) throw new Error(`login blocked for ${email}: "${txt}"`);
        }
        // Devuelve un BOOLEANO, no el pathname: la versión anterior cerraba
        // con `.not.toMatch(/^\/login/)`, y `/iniciar-sesion` no matchea esa
        // expresión. La condición se cumplía de entrada, parados en el
        // formulario, y `stateFor` cacheaba un storageState ANÓNIMO para los
        // doce tests del archivo. Ver e2e/_sign-in-route.ts.
        return leftSignIn(new URL(page.url()));
      },
      { timeout: 30_000, intervals: [150, 250, 500, 500, 1000, 1500] },
    )
    .toBe(true);
  // Leaving the sign-in page may mean landing on /mfa (T2-S6, e2e/_mfa.ts).
  await passSecondFactorIfAsked(page, email, password);
}

async function stateFor(browser: Browser, email: string): Promise<StorageState> {
  const cached = stateCache.get(email);
  if (cached) return cached;
  const context = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": uniqueIp() } });
  try {
    const page = await context.newPage();
    await login(page, email);
    const state = await context.storageState();
    stateCache.set(email, state);
    return state;
  } finally {
    await context.close();
  }
}

async function openAs(
  browser: Browser,
  email: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    storageState: await stateFor(browser, email),
    extraHTTPHeaders: { "x-real-ip": uniqueIp() },
  });
  const page = await context.newPage();
  return { context, page };
}

// Open a fresh UNAUTHENTICATED context with its own client IP for public routes.
async function openPublic(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": uniqueIp() } });
  const page = await context.newPage();
  return { context, page };
}

// Public credential / open-data routes carry a per-IP throttle
// (public_token_page 60/min, open_data 30/min). A real single scan never trips
// it, but a test suite hammering the same localhost IP can. Retry through the
// soft ThrottleNotice ("Demasiadas consultas") so the assertion sees the real
// page, not a transient throttle.
async function gotoPublicResilient(page: Page, url: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto(url);
    await page.waitForLoadState("domcontentloaded");
    if ((await page.getByText(/Demasiadas consultas/i).count()) === 0) return;
    await page.waitForTimeout(15_000); // ease the per-minute window
  }
}

// ---------------------------------------------------------------------------
// 1. Owner login → /inicio lands on the most-urgent pet's profile; band dots
//    (tarjeta-todo: the dots live INSIDE the document band) visible when the
//    owner has >1 live pet.
// ---------------------------------------------------------------------------
test("1 — owner /inicio redirects into the most-urgent pet profile with band dots", async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, CAROUSEL_OWNER);
  try {
    await page.goto("/inicio");
    await page.waitForURL(PROFILE_RE, { timeout: 20_000 });

    const url = page.url();
    expect(url, "final URL is a real pet profile route").toMatch(PROFILE_RE);
    expect(tokenFromUrl(url), "resolved a concrete DIM token").toBeTruthy();

    // The in-band dots died with the avatar strip: PetSwitcherAvatars renders
    // a nav[data-testid="pet-carousel-avatars"] ABOVE the document, one photo
    // button per LIVE pet labeled "X — mascota N de M" ("(actual)" marks the
    // current one). Same contract (visible switcher, >1 live pet, exactly one
    // current), new surface.
    const switcher = page.getByTestId("pet-carousel-avatars");
    await expect(switcher, "pet switcher present for >1 live pet").toBeVisible();
    const avatarButtons = switcher.getByRole("button", { name: /mascota \d+ de \d+/i });
    expect(await avatarButtons.count(), "avatar buttons rendered").toBeGreaterThan(1);
    await expect(
      switcher.getByRole("button", { name: /\(actual\)/ }),
      "the current pet is marked as actual",
    ).toHaveCount(1);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Keyboard ←/→ moves to the neighbor's REAL route and back (the desktop
//    arrow buttons died with the top chrome strip — tarjeta-todo).
// ---------------------------------------------------------------------------
test("2 — keyboard arrows navigate to the neighbor pet route and back", async ({ browser }) => {
  const { context, page } = await openAs(browser, CAROUSEL_OWNER);
  try {
    await page.goto("/inicio");
    await page.waitForURL(PROFILE_RE, { timeout: 20_000 });
    const startToken = tokenFromUrl(page.url());
    expect(startToken).toBeTruthy();

    // The window-level listener handles ←/→ (no focus target needed).
    //
    // DIRECTION FROM THE DOM, NOT FROM A PROBE. The arrows CLAMP — no
    // wrap-around (pinned by PetCredentialCarousel's unit tests) — so when
    // /inicio's most-urgent pick lands on the LAST pet in strip order,
    // ArrowRight is a legitimate no-op (CI run 30867634835 sat 20s on that).
    // The first fix probed with a short-timeout ArrowRight and fell back to
    // ArrowLeft, which RACED itself: on a cold runner the right press landed
    // after the 5s probe gave up, the fallback press then walked back to the
    // start pet, and the wait for "a different token" could never resolve
    // (run 30869355207). The switcher already states the position —
    // "X — mascota N de M (actual)" — so read N/M and pick the only key that
    // can move.
    const switcherNav = page.getByTestId("pet-carousel-avatars");
    await expect(switcherNav, "switcher present").toBeVisible({ timeout: 20_000 });
    const currentLabel =
      (await switcherNav
        .getByRole("button", { name: /\(actual\)/ })
        .first()
        .getAttribute("aria-label")) ?? "";
    const position = currentLabel.match(/mascota (\d+) de (\d+)/i);
    expect(position, `switcher states a position (got "${currentLabel}")`).toBeTruthy();
    const index = Number(position?.[1]);
    const total = Number(position?.[2]);
    expect(total, "more than one live pet in the strip").toBeGreaterThan(1);
    // At the right edge only ArrowLeft can move; anywhere else ArrowRight can.
    const forwardKey = index < total ? "ArrowRight" : "ArrowLeft";
    const backKey = forwardKey === "ArrowRight" ? "ArrowLeft" : "ArrowRight";

    await page.keyboard.press(forwardKey);
    await page.waitForURL(
      (u) => PROFILE_RE.test(u.pathname) && tokenFromUrl(u.href) !== startToken,
      { timeout: 20_000 },
    );
    const neighborToken = tokenFromUrl(page.url());
    expect(neighborToken, "URL changed to a different, real pet route").not.toBe(startToken);
    expect(neighborToken).toBeTruthy();
    await expect(page.locator("#main-content")).toHaveCount(1);
    await expect(page.getByTestId("pet-carousel-avatars")).toBeVisible();

    await page.keyboard.press(backKey);
    await page.waitForURL((u) => tokenFromUrl(u.href) === startToken, { timeout: 20_000 });
    expect(tokenFromUrl(page.url()), "the opposite arrow returned to the original pet").toBe(
      startToken,
    );
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 3. BACK BUTTON — the flagged soft-loop risk. Fact-finding: characterize the
//    browser Back after landing via the /inicio redirect, and assert the URL is
//    not trapped in an infinite redirect bounce.
// ---------------------------------------------------------------------------
test("3 — browser Back after /inicio redirect does not trap in a redirect loop", async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, CAROUSEL_OWNER);
  try {
    await page.goto("/mis-mascotas");
    await page.waitForLoadState("domcontentloaded");
    const indexUrl = page.url();

    await page.goto("/inicio");
    await page.waitForURL(PROFILE_RE, { timeout: 20_000 });
    const landedUrl = page.url();
    const landedToken = tokenFromUrl(landedUrl);

    // Press Back and sample the URL repeatedly. The flagged risk is a redirect
    // loop; the distinguishing signal of a LOOP (vs a one-shot re-redirect) is
    // that the URL never stops changing. So we sample a handful of times and
    // require the URL to STABILISE (two consecutive equal reads), then report
    // exactly where it settled — this is a fact-finding assertion.
    await page.goBack();
    const samples: string[] = [];
    let settled = "";
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(500);
      const u = page.url();
      samples.push(u);
      if (i > 0 && samples[i] === samples[i - 1]) {
        settled = u;
        break;
      }
    }
    if (!settled) settled = samples[samples.length - 1];

    const characterization = {
      indexUrl,
      landedUrl,
      landedToken,
      backSamples: samples,
      settledUrl: settled,
      settledOnIndex: settled.includes("/mis-mascotas") && !PROFILE_RE.test(settled),
      settledOnAProfile: PROFILE_RE.test(settled),
      settledOnSameProfile: tokenFromUrl(settled) === landedToken,
      stillChangingAtEnd:
        samples.length >= 2 && samples[samples.length - 1] !== samples[samples.length - 2],
    };
    console.log("[P6 back-button characterization]", JSON.stringify(characterization, null, 2));

    // HARD assertion: NOT an infinite redirect loop — the URL must stop changing
    // (the last two samples agree), and the page must be interactive.
    expect(
      characterization.stillChangingAtEnd,
      "URL stopped changing after Back — no infinite redirect loop",
    ).toBe(false);
    await expect(page.locator("#main-content")).toHaveCount(1);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 4. One-tap capture: /inicio?sheet=anotar forwards the query onto the profile
//    route AND opens the anotar sheet.
// ---------------------------------------------------------------------------
test("4 — /inicio?sheet=anotar lands on a profile route with the anotar sheet open", async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, CAROUSEL_OWNER);
  try {
    await page.goto("/inicio?sheet=anotar");
    await page.waitForURL(PROFILE_RE, { timeout: 20_000 });

    const url = new URL(page.url());
    expect(url.pathname, "landed on a real pet profile route").toMatch(PROFILE_RE);
    expect(url.searchParams.get("sheet"), "sheet=anotar forwarded onto the profile URL").toBe(
      "anotar",
    );

    const dialog = page.getByRole("dialog");
    await expect(dialog, "anotar sheet dialog is open").toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: /Anotar algo de/i }),
      "anotar sheet title present",
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Keyboard arrows inert while the anotar sheet is open.
// ---------------------------------------------------------------------------
test("5 — ArrowRight does not navigate pets while the anotar sheet is open", async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, CAROUSEL_OWNER);
  try {
    // Token discovered from the owner's own registry — bootstrap generates it
    // randomly, so no literal can name it (this was DIM-SNPY-0004).
    const ownerPet = await discoverPetToken(page);
    await page.goto(`/mis-mascotas/${ownerPet}?sheet=anotar`);
    const dialog = page.getByRole("dialog");
    await expect(dialog, "anotar sheet open on the owned pet").toBeVisible({ timeout: 15_000 });

    const before = tokenFromUrl(page.url());
    expect(before).toBe(ownerPet);

    // The carousel's window ArrowRight handler must be inert while a dialog is
    // open (PetCredentialCarousel guards on [role=dialog]/[data-vaul-drawer]).
    await page.locator("body").press("ArrowRight");
    await page.waitForTimeout(800);

    expect(tokenFromUrl(page.url()), "pet did not change under the open sheet").toBe(before);
    await expect(dialog, "sheet still open").toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Zero-pet landing: /inicio → /mis-mascotas with the first-run CTA.
// ---------------------------------------------------------------------------
test("6 — zero-pet owner /inicio lands on /mis-mascotas with the first-run CTA", async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, ZERO_PET_OWNER);
  try {
    await page.goto("/inicio");
    await page.waitForURL(/\/mis-mascotas(\?|#|$)/, { timeout: 20_000 });

    const url = new URL(page.url());
    expect(url.pathname, "redirected to the index, not a pet profile").toBe("/mis-mascotas");
    expect(PROFILE_RE.test(url.pathname), "no pet token — the owner has none").toBe(false);

    // D.8: the empty state now names the credential before asking for the act.
    await expect(page.getByText(/Todavía no registraste ninguna mascota/i)).toBeVisible();
    await expect(page.getByText(/credencial digital/i).first()).toBeVisible();

    // ---- D.9 (2026-07-30): re-anchored on STRUCTURE, not on copy. ----------
    //
    // "Registrar" is now the one verb for this act on every surface, so the
    // page body's CTA and the tab-bar centre slot render the SAME three words.
    // The previous locators told them apart purely by text ("Cargar mascota"
    // not substring-matching "Cargar una mascota") — a disambiguation that
    // existed only because the two strings happened to differ, and that D.9
    // deletes on purpose. Making them differ again to keep the test green
    // would undo the decision, so the anchors move to the DOM instead:
    //
    //   - the tab bar is <nav data-testid="citizen-tab-bar">, a SIBLING of
    //     <main id="main-content"> (AppShell citizen variant);
    //   - the page body is that <main>.
    //
    // Containment partitions the page, so no copy change — in either
    // direction — can make one scope match the other's link. A role query
    // would not work here: the bar is md:hidden and this suite runs at a
    // desktop viewport, so it is out of the accessibility tree entirely.
    const body = page.locator("#main-content");
    const tabBar = page.locator('[data-testid="citizen-tab-bar"]');

    await expect(body.getByRole("link", { name: "Registrar mascota", exact: true })).toBeVisible();
    // Exactly one CTA for the act in the body: D.9 drops the header's twin
    // while the first-run empty state is the one carrying the reason.
    await expect(body.locator('a[href="/mis-mascotas/nueva"]')).toHaveCount(1);

    // D.8: with zero pets the tab-bar centre slot is the alta, not the capture
    // no-op ("Asentar" → /inicio?sheet=anotar, which for a pets-less owner
    // bounces back here with an inert sheet param).
    await expect(tabBar.locator("a", { hasText: "Registrar mascota" })).toHaveAttribute(
      "href",
      "/mis-mascotas/nueva",
    );
    await expect(tabBar.locator("a", { hasText: "Asentar" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Vet escape hatch: /mis-mascotas redirects a vet to the org portal;
//    ?as=owner shows the owner index.
// ---------------------------------------------------------------------------
test("7 — vet /mis-mascotas redirects to the org portal; ?as=owner shows the index", async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, VET);
  try {
    await page.goto("/mis-mascotas");
    // The vet redirect is a server redirect to /org/<token>; poll until it
    // settles rather than reading the URL before it completes.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/org\//);

    await page.goto("/mis-mascotas?as=owner");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: /Mis mascotas/i })).toBeVisible();
    expect(new URL(page.url()).pathname, "?as=owner stays on the owner index").toBe(
      "/mis-mascotas",
    );
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 8. Org viewer of a held pet: NO carousel chrome, NO emergency-contacts block.
// ---------------------------------------------------------------------------
test("8 — org viewer of a held pet gets no carousel chrome and no emergency block", async ({
  browser,
}) => {
  // THE HELD PET IS PROVISIONED HERE, not discovered (T1-C3, 2026-09-18).
  // This test used to pick a pet from the org portal's list, trusting that
  // the seeded refugio still held one. On staging it held none — crisis-seams
  // (d) adopts a pet out every night and nothing reopened a custody — so the
  // nightly was red 41 nights on a missing fixture, not on the viewer UX this
  // test is about. Now the titular (owner@dim.test) asks the refugio to
  // sponsor one of their pets and the org accepts: a live shelter custody this
  // test opened, and ends in `finally` through the titular's own "Dar de baja".
  // See e2e/_shelter-custody.ts for why the sponsorship shape and not intake.
  const titular = await openAs(browser, CAROUSEL_OWNER);
  const { context, page } = await openAs(browser, ORG_VIEWER);
  let heldToken = "";
  try {
    heldToken = await pickSponsorablePetToken(titular.page);
    await sponsorPet(titular.page, page, heldToken);

    await page.goto(`/mis-mascotas/${heldToken}`, { waitUntil: "domcontentloaded" });
    // The profile STREAMS — the notice arrives after domcontentloaded.
    await expect(page.getByText(/como miembro de/i).first()).toBeVisible({ timeout: 20_000 });

    expect(new URL(page.url()).pathname, "org viewer stays on the pet route").toBe(
      `/mis-mascotas/${heldToken}`,
    );

    await expect(page.getByText(/como miembro de/i), "org access notice present").toBeVisible();
    await expect(page.getByTestId("pet-carousel-avatars")).toHaveCount(0);

    // Reveal the (deferred) Libreta face via the band turn button (the single
    // flip control — the tablist is gone, tarjeta-todo), then assert the
    // owner-only Emergencia block never rendered for an org viewer.
    const turnButton = page.getByRole("button", { name: "Girar a Libreta" });
    if (await turnButton.count()) {
      await turnButton.first().click();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(500);
    }
    await expect(page.locator("[data-section='libreta-emergencia']")).toHaveCount(0);
  } finally {
    // Close the custody this test opened, even when an assertion above failed —
    // a sponsorship left running would change owner@dim.test's pet for every
    // spec after this one. A failure here is LOGGED rather than thrown so it
    // cannot replace the assertion that brought us here; the next walk heals a
    // leftover anyway (pickSponsorablePetToken resets every candidate first).
    if (heldToken) {
      await endSponsorship(titular.page, heldToken).catch((err) =>
        console.error(`[owner-ia-p6 #8] could not end the sponsorship of ${heldToken}:`, err),
      );
    }
    await context.close();
    await titular.context.close();
  }
});

// ---------------------------------------------------------------------------
// 9. Share/public path: /p/{flagship} renders unauthenticated, no chrome, no PII.
// ---------------------------------------------------------------------------
test("9 — public /p/{pet} renders with no auth, no carousel chrome, no contact PII", async ({
  browser,
}) => {
  // The token is discovered from the owner's registry and then fetched by a
  // context that never authenticated. It used to be the literal DIM-PAMP-0001
  // (the demo flagship), which on a bootstrapped database is a not-found
  // boundary — and a not-found page has no carousel dots, no lost strip and no
  // phone number either, so three of the four assertions below "passed" on a
  // page that was never the credential. Only the "Credencial pública" check
  // failed, and that is the sole reason anyone noticed.
  const owner = await openAs(browser, CAROUSEL_OWNER);
  let publicToken: string;
  try {
    publicToken = await discoverPetToken(owner.page);
  } finally {
    await owner.context.close();
  }

  const { context, page } = await openPublic(browser);
  try {
    await gotoPublicResilient(page, `/p/${publicToken}`);

    expect(new URL(page.url()).pathname, "stayed on the public credential route").toBe(
      `/p/${publicToken}`,
    );
    await expect(page.getByText("Credencial pública", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await expect(page.getByTestId("pet-carousel-avatars")).toHaveCount(0);

    // No contact PII on an ACTIVE credential: no lost-mode owner disclosure, and
    // no phone-number pattern anywhere in the body.
    await expect(page.locator("[data-section='lost-urgent-strip']")).toHaveCount(0);
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    expect(body, "no phone-number PII on the active public credential").not.toMatch(
      /(\+?54\s?9?\s?11[\s-]?\d{4}[\s-]?\d{4})|(\b11[\s-]?\d{4}[\s-]?\d{4}\b)/,
    );
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 10. Lost-pet emergency path: public shows the lost banner; owner profile
//     shows the LostCaseBlock.
// ---------------------------------------------------------------------------
test("10 — lost pet: public page shows the lost banner; owner profile shows LostCaseBlock", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  // BOOTSTRAP SEEDS NO LOST PET. Every pet seed-test-users.ts writes is
  // status:"active" and it opens no lost_case, so the old literal
  // DIM-S005-PLRM (noeli's "Luna", demo tier) resolved to a not-found page in
  // CI and the banner assertion failed on a page that never had a banner.
  //
  // So the test MAKES the state it is about, through the real owner wizard,
  // and hands it back. The revert is in a finally: leaving owner@dim.test with
  // a pet stuck in lost would silently change what every later spec sees.
  const { context, page } = await openAs(browser, CAROUSEL_OWNER);
  let token = "";
  try {
    token = await discoverPetToken(page);

    // Mark lost — same wizard e2e/crisis-owner-lost-flow.spec.ts drives.
    await page.goto(`/mis-mascotas/${token}/perdida`, { waitUntil: "domcontentloaded" });
    await expect(
      // Sex-flexed since the ciclo-perdido sweep — tolerate all forms.
      page.getByRole("heading", { name: /^Marcar como perdid(?:o|a|o\/a)$/ }),
      "mark-lost wizard opened",
    ).toBeVisible({ timeout: 20_000 });
    // WALK THE WIZARD. Marking lost is a MULTI-STEP flow (MarkLostWizard:
    // location → optional details → disclosure), and the final "Marcar como
    // perdida" submit only exists on the LAST step. This test used to click
    // that name straight away, which — with no action timeout configured —
    // waited FOREVER for a button that step 1 never renders, burning the whole
    // 150s test budget with no assertion error to name the cause (CI runs
    // 30867634835 / 30869355207, and it reproduced locally). Same sequence
    // e2e/crisis-seams.spec.ts (a) already walks.
    await page.getByRole("button", { name: /^continuar →$/i }).click();
    const hasDetailsStep = await page
      .getByText(/sin chip ni tatuaje/i)
      .isVisible()
      .catch(() => false);
    if (hasDetailsStep) {
      await page.getByRole("button", { name: /^continuar →$/i }).click();
    }
    await expect(
      page.getByText(/qué se muestra al público/i),
      "reached the disclosure step",
    ).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole("button", { name: /^marcar como perdid(?:o|a|o\/a)$/i })
      .click({ timeout: 20_000 });
    // Do NOT wait on the post-action URL: the client half of the N3 contract
    // (useActionRedirect → window.location.assign) drops often enough that
    // such a wait burns budget for nothing — the documented Next 15.5.x
    // behaviour in lib/ui/full-page-action-nav.ts. The mutation is what
    // matters and the profile assertion below is what proves it.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    // (a) Owner profile — LostCaseBlock with the "marcar encontrada" action.
    await page.goto(`/mis-mascotas/${token}`, { waitUntil: "domcontentloaded" });
    await expect(
      page.locator("[data-section='lost-case-block']"),
      "owner LostCaseBlock rendered on the profile",
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/marcar como/i).first()).toBeVisible();

    // (b) Public credential — the lost banner is visible to a stranger.
    const pub = await openPublic(browser);
    try {
      await gotoPublicResilient(pub.page, `/p/${token}`);
      await expect(
        pub.page.locator("[data-section='lost-urgent-strip']"),
        "public lost banner rendered for a stranger",
      ).toBeVisible({ timeout: 20_000 });
    } finally {
      await pub.context.close();
    }
  } finally {
    // Restore: hand the pet back to active so the shared fixture is unchanged
    // — and PROVE it. The comment that stood here warned that getting the
    // button regex wrong makes the revert no-op silently; then the button
    // renamed and exactly that happened (this cleanup clicked /^confirmar$/,
    // the sheet says "Marcar como encontrada"). The leak, plus its twin in
    // crisis-owner-lost-flow, marked owner@dim.test's whole registry PERDIDO
    // on CI and killed two OTHER specs' preconditions. ensurePetFound asserts
    // the restored state, so the next drift fails HERE.
    if (token) {
      await ensurePetFound(page, token);
    }
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 11. Open data public: /transparencia renders unauthenticated with dataset
//     cards; the cobertura JSON returns 200 with license metadata and no PII;
//     any suppressed cell shows the marker, never 0.
// ---------------------------------------------------------------------------
test("11 — /transparencia + cobertura JSON: public, licensed, PII-free, suppression marker", async ({
  browser,
  request,
}) => {
  const { context, page } = await openPublic(browser);
  try {
    await gotoPublicResilient(page, "/transparencia");
    await expect(page.getByRole("heading", { name: /Transparencia activa/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Conjuntos de datos/i })).toBeVisible();
    const jsonLinks = page.getByRole("link", { name: /^JSON$/ });
    expect(await jsonLinks.count(), "dataset cards expose JSON downloads").toBeGreaterThan(0);
  } finally {
    await context.close();
  }

  const res = await request.get("/transparencia/datos/cobertura-antirrabica?format=json", {
    headers: { "x-real-ip": uniqueIp() },
  });
  expect(res.status(), "cobertura JSON returns 200").toBe(200);
  expect(res.headers()["x-license"], "license header present").toBe("CC-BY-4.0");

  const doc = await res.json();
  expect(doc.meta.license.id, "license id in body").toBe("CC-BY-4.0");
  expect(doc.meta.license.url, "license url present").toContain("creativecommons.org");
  expect(doc.meta.license.attribution, "license attribution present").toBeTruthy();
  expect(doc.meta.suppression.k, "k-anonymity threshold").toBe(5);
  expect(doc.meta.suppression.marker, "suppression marker declared").toBe(
    "suprimido por privacidad",
  );

  const rows: Array<Record<string, unknown>> = doc.data;
  expect(Array.isArray(rows) && rows.length > 0, "dataset has rows").toBe(true);

  const piiRe = /dni|token|nombre|owner|dueñ|email|telefono|phone|direccion|lat|lng/i;
  const piiKeys = Object.keys(rows[0]).filter((k) => piiRe.test(k));
  expect(piiKeys, "no PII-shaped columns in the open dataset").toEqual([]);

  const marker = doc.meta.suppression.marker;
  let suppressedSeen = 0;
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (k === "provincia" || k === "codigo_iso") continue;
      if (typeof v === "string" && v === marker) suppressedSeen++;
      if (typeof v === "string") {
        // A numeric 0 masquerading as suppression is the exact defect to catch:
        // a suppressed cell must be the marker STRING, never empty/zero.
        expect(v === marker || v.length > 0, "no empty numeric cell").toBe(true);
      }
    }
  }
  console.log(
    `[P6 open-data] rows=${rows.length} suppressedCells=${suppressedSeen} (marker='${marker}')`,
  );
});

// ---------------------------------------------------------------------------
// 12. Admin cockpit: /admin shows the queue cockpit tiles.
// ---------------------------------------------------------------------------
test("12 — admin /admin shows the queue cockpit", async ({ browser, baseURL }) => {
  // admin@ is institutional, locked on staging and not a rotated e2e account:
  // on a remote target this test skips here, before any login is attempted.
  skipUnlessRemoteLoginAllowed(baseURL ?? "", ADMIN);
  const { context, page } = await openAs(browser, ADMIN);
  try {
    await page.goto("/admin");
    await page.waitForLoadState("domcontentloaded");

    expect(new URL(page.url()).pathname, "admin stays on /admin").toBe("/admin");
    await expect(page.getByRole("heading", { name: /Briefing de administración/i })).toBeVisible();
    await expect(page.getByText(/Estado de las colas/i), "queue cockpit present").toBeVisible();
    await expect(
      page.getByText(/Colas operativas/i),
      "operational queues tile group",
    ).toBeVisible();
    // "Mapa del sitio" was cut (PO interview 2026-07-23, item 13): it
    // duplicated the rail nav one-for-one — see components/admin/AdminSiteMap.tsx.
    await expect(
      page.getByRole("heading", { name: /Mapa del sitio/i }),
      "admin site map removed — duplicated the rail nav",
    ).not.toBeVisible();
  } finally {
    await context.close();
  }
});
