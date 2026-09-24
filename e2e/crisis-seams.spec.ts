/**
 * Crisis-path cross-POV seams — hardened Playwright regression suite (#35).
 *
 * These are the four critical, multi-actor journeys from the crisis-e2e design
 * handoff (dim-interno:docs/design/handoffs/2026-07-04-crisis-e2e-design.md). Cursor's
 * browser MCP could not drive them end-to-end (re-login across roles, anon
 * contexts, server-action redirects); Playwright can. Unlike the recording
 * battery in final-seams.spec.ts — which collects soft pass/fail notes and
 * screenshots — this suite FAILS LOUD with hard assertions so it can gate CI.
 *
 * Seams covered:
 *   (a) Lost → found loop: owner marks lost → stranger public credential +
 *       /perdidas → govt /gob/perdidas → owner marks found → public active.
 *   (b) Vet Atender → owner libreta: clinic signs an Antirrábica vaccine on
 *       the walk-in surface → the immutable event surfaces in the owner libreta.
 *   (c) Denuncia anónima → admin moderación → gob maltrato: a flagged anon
 *       report lands in the admin moderation queue, gets passed to triage, and
 *       becomes visible to govt at /gob/maltrato.
 *   (d) Adopción: refugio publishes → owner2 postula → refugio aprueba +
 *       finaliza → ownership transfers to owner2.
 *
 * Run against the ALREADY-RUNNING QA server (QA_PORT pairs with qa-up.ps1 -Port):
 *   pnpm exec playwright test e2e/crisis-seams.spec.ts --config=playwright.local3000.config.ts
 *
 * FIXTURE TIER — seams (a)-(c) run entirely on what `pnpm db:bootstrap`
 * guarantees (reference data + scripts/seed-test-users.ts) and discover every
 * token at RUNTIME. Nothing here may hardcode a `DIM-…` literal or reach for a
 * seed-demo.ts persona: CI never runs that chain, so such a spec measures
 * accumulated laptop state rather than the code (commit 51b2eff1). Seam (d) is
 * the remaining exception and is documented as such at its own definition.
 *
 * ─── ABSORBED: e2e/final-seams.spec.ts, retired 2026-07-31 (P2.1) ─────────
 * That file was the older SOFT recording battery over these same four seams.
 * Commit 96c8a2d3 gave it a real assertion and it went red on all four; the PO
 * gate was to investigate each red before retiring it, so that a genuine
 * regression could not be deleted along with the noise. Measured back-to-back
 * against one healthy QA server: final-seams 0/4, this suite 3/4 with (d)
 * failing on its own documented fixture exhaustion. Not one of the four had
 * found a product defect —
 *   (a) drove DIM-DEMO-0010 (Pipa) as owner@dim.test. Pipa belongs to
 *       graciela@dim.test, so requireOwnedPetByToken bounced it every run
 *       since the day it was written. It also asserted that govt@dim.test
 *       (scoped to Ushuaia + El Calafate) could see a CABA pet, and reverted
 *       through a "Confirmar" button D.3 had renamed to "Marcar como
 *       encontrada" — so its cleanup was a silent no-op too.
 *   (b) asserted a professional seal from alejo@dim.test, an org admin with no
 *       validated matrícula. The vaccine signs fine; the asiento correctly
 *       lands author_verified=f, which is exactly what the Atender surface
 *       warns the signer before they sign. Seam (b) here uses the matriculated
 *       vet@dim.test for that reason, and asserts the provenance, not a
 *       page-wide /matrícula/ substring that the disclaimer alone satisfies.
 *   (c) waited for the "Moderación de denuncias" heading at /admin/moderacion.
 *       The F1 fusion (2026-07-22) turned that route into a redirect into a hub
 *       that suppresses the stage's own h1 on purpose (ScreenHeader underHub).
 *       Seam (c) here asserts the redirect and the hub's own h1 instead.
 *   (d) never published anything — its publish click was guarded by
 *       `if (isEnabled)` — so it inherited whatever listing an earlier run had
 *       left behind and then hung for its entire 120s budget on the "Ya
 *       postulaste" screen it had no branch for.
 *
 * WHAT STOPPED BEING WATCHED: nothing that was ASSERTED. Its three unique legs
 * — the /gob rabies KPI delta, the CAS- code on the owner profile, and the
 * /gob/perdidas board after mark-found — were note-only or screenshot-only and
 * could not turn a test red. The one real gap is the DNI path of the finalize
 * screen ("¿Adopción por fuera de las postulaciones?"), which loses its only
 * e2e mention; that mention was nominal, since final-seams died three steps
 * earlier on every run, and the rule itself is covered by
 * src/modules/adoption/domain/__tests__/finalize-rules.test.ts.
 */

import { type Locator, type Page, expect, test } from "@playwright/test";

import { provinceByName } from "@/lib/reference/ar-provincias";

import { INTAKE_PET_PREFIX, intakeShelterPet } from "./_shelter-custody";
import { deletePetsByNamePrefix } from "./demo/_db-cleanup";
import {
  ACCOUNTS,
  MARK_FOUND_BUTTON,
  ensurePetFound,
  loginAs,
  resolveOrgToken,
  submitAndWait,
  walkDenunciaWizard,
} from "./demo/_helpers";

/** The org seed-test-users.ts provisions — "Refugio Test", legal "Refugio Test (Seed)". */
const SEEDED_ORG_NAME = /Refugio Test/i;

/** Core vaccine, catalogued for both dog and cat (lib/reference/lookups.ts). */
const ANTIRRABICA = /antirr[aá]bica/i;

/** Clear the session and log in as another role on the shared page. */
async function relogin(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await loginAs(page, email);
}

// MARK_FOUND_BUTTON and the drift story it encodes live in demo/_helpers.ts,
// beside the `ensurePetFound` cleanup that story produced.

/**
 * owner@dim.test's first pet, READ FROM THEIR OWN REGISTRY — never hardcoded.
 *
 * Anchored on the `DIM-` prefix so it cannot pick up the registry's sibling
 * routes (/nueva, /reclamar, /postulaciones); the token shape is invariant #1
 * (lib/domain/dim-token.ts). Same pattern as a11y-regression.spec.ts, and for
 * the same reason: a literal token is a bet that one row survives every
 * re-seed, and the day it doesn't the assertion goes green for the wrong reason.
 */
async function firstOwnerPetToken(page: Page): Promise<string> {
  await page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const link = page.locator('a[href^="/mis-mascotas/DIM-"]').first();
  await expect(link, "owner@dim.test must own at least one pet").toBeVisible();
  const token = ((await link.getAttribute("href")) ?? "").split("/mis-mascotas/")[1] ?? "";
  expect(token, "pet token parsed from the owner registry link").toBeTruthy();
  return token.split(/[?#]/)[0];
}

/**
 * Open the owner's libreta and return the asiento (ledger-row) locator.
 *
 * The libreta is the FlipCard's back face (`#pet-face-libreta`); the legacy
 * /libreta URL 308-redirects to ?tab=libreta. BOTH faces mount, and the
 * inactive credencial face keeps its own "Vacuna antirrábica" copy in the DOM
 * as display:none — so a page-wide getByText resolves to that HIDDEN front-face
 * node and fails despite the visible libreta rows. Everything is scoped to the
 * libreta panel, and to `[data-section="asiento"]` (AsientoCard's root) so a
 * match is one ledger ROW rather than an arbitrary nested element.
 */
async function libretaAsientos(page: Page, token: string): Promise<Locator> {
  const res = await page.goto(`/mis-mascotas/${token}/libreta`, { waitUntil: "domcontentloaded" });
  expect(res?.status(), "owner libreta responds 2xx").toBeLessThan(400);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_500); // Suspense boundary + flip settle
  await expect(page.getByText(/application error/i)).not.toBeVisible();
  return page.locator("#pet-face-libreta").locator('[data-section="asiento"]');
}

test.describe.configure({ mode: "serial" });

// Seam (d) intakes its own pet and adopts it out to owner2 (T1-C3). The
// adoption ends the custody; this removes the pet itself — before as well as
// after, so an interrupted run cannot leave one behind for the next. LOCAL
// DATABASE ONLY: a no-op against staging, like every sweep in _db-cleanup.
test.beforeAll(async () => {
  await deletePetsByNamePrefix(INTAKE_PET_PREFIX);
});
test.afterAll(async () => {
  await deletePetsByNamePrefix(INTAKE_PET_PREFIX);
});

test.describe("crisis seams — cross-POV critical journeys", () => {
  // ------------------------------------------------------------------------
  // (a) Lost → found loop across owner / stranger / govt POVs.
  // ------------------------------------------------------------------------
  test("(a) owner marks lost → stranger + govt see it → owner marks found", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await relogin(page, ACCOUNTS.owner);

    // Discover an ACTIVE (non-lost) pet from the owner's own registry. Either
    // non-urgent flag on /mis-mascotas marks a pet that is not lost/deceased:
    // the row reads REGISTRADO/REGISTRADA until compliance is derived and
    // "AL DÍA" afterwards, and matching only the first shape is what made
    // rehome-by-titular red on CI's fresh DB (run 32555456201). Sex-agnostic on
    // purpose: the flag inflects with the animal.
    await page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    // Same locator shape as crisis-owner-lost-flow: `DIM-` keeps registry
    // chrome links out, and `hasNotText` keeps caretaker rows out — this seam
    // marks the pet LOST, which only its titular may do.
    const petLink = page
      .locator('a[href^="/mis-mascotas/DIM-"]', {
        hasText: /AL DÍA|REGISTRAD[AO]/i,
        hasNotText: /Al cuidado/i,
      })
      .first();
    // An ASSERTION, not a skip: scripts/seed-test-users.ts guarantees
    // owner@dim.test an active pet, so an empty registry is never an
    // environment this seam cannot run in — it is a LOST FIXTURE LEAKED by an
    // earlier spec whose mark-found cleanup did not commit. The skip this
    // replaced was `test.skip(await x.count() === 0, …)`, the shape
    // e2e/README.md forbids by name, and in CI run 33568726968 — the run whose
    // leak produced `ensurePetFound` — it reported that leak as a deliberate,
    // green skip. Auto-retrying, so it also absorbs the registry's streaming
    // render (`Locator.count()` is one-shot and does not wait).
    await expect(
      petLink,
      "owner@dim.test has no active pet — the seed guarantees one (scripts/seed-test-users.ts), so an empty registry means an earlier spec leaked a lost fixture.",
    ).toBeVisible({ timeout: 20_000 });
    const href = (await petLink.getAttribute("href")) ?? "";
    const token = href.split("/mis-mascotas/")[1] ?? "";
    expect(token, "pet token parsed from registry link").toBeTruthy();

    // The name is needed for the operator-board assertion further down, where
    // the credential link is deliberately absent (see there).
    //
    // Read from the h1's FIRST TEXT NODE, not its innerText: the heading is
    // `{name}<span class="ln-badge-reg">…</span>`, so innerText comes back as
    // "E2EPet-1785241342414Inscripto" — name and status badge welded together,
    // which matches nothing on the board.
    await page.goto(`/mis-mascotas/${token}`, { waitUntil: "domcontentloaded" });
    const petName = (
      (await page
        .locator("h1")
        .first()
        .evaluate((el) => el.firstChild?.textContent ?? "")) ?? ""
    ).trim();
    expect(petName, "pet name read from the profile h1").toBeTruthy();

    try {
      // --- Owner marks the pet lost (affirmative-consent disclosure) --------
      await page.goto(`/mis-mascotas/${token}/perdida`, { waitUntil: "domcontentloaded" });
      await expect(
        // Sex-flexed since the ciclo-perdido sweep — tolerate all forms.
        page.getByRole("heading", { name: /^Marcar como perdid(?:o|a|o\/a)$/ }),
      ).toBeVisible();

      // Step 1 — location (optional): skip straight through.
      await page.getByRole("button", { name: /^continuar →$/i }).click();
      // Step 2 — enriched details: ONLY present when the pet has no chip/tattoo.
      const hasDetailsStep = await page
        .getByText(/sin chip ni tatuaje/i)
        .isVisible()
        .catch(() => false);
      if (hasDetailsStep) {
        await page.getByRole("button", { name: /^continuar →$/i }).click();
      }
      // Final step — disclosure: opt IN to phone only.
      await expect(page.getByText(/qué se muestra al público/i)).toBeVisible();
      await page.getByRole("switch", { name: "Tu teléfono" }).click();
      await page.getByRole("button", { name: /^marcar como perdid(?:o|a|o\/a)$/i }).click();
      await expect(page.getByText(/activamos la búsqueda de/i)).toBeVisible({ timeout: 20_000 });

      // --- Stranger POV: public credential flips to lost + /perdidas lists it -
      const stranger = await browser.newContext();
      try {
        const sp = await stranger.newPage();
        const res = await sp.goto(`/p/${token}`, { waitUntil: "domcontentloaded" });
        expect(res?.status(), "public credential responds 2xx/3xx").toBeLessThan(400);
        await expect(sp.locator('[data-section="lost-urgent-strip"]')).toBeVisible({
          timeout: 20_000,
        });
        // Phone was disclosed → the call CTA renders.
        await expect(sp.getByRole("link", { name: /llamar/i })).toBeVisible();
        // Location was NOT disclosed → no last-seen section.
        await expect(sp.getByText(/última vez vista/i)).not.toBeVisible();

        await sp.goto("/perdidas", { waitUntil: "domcontentloaded" });
        // The public board is card-based: the token lives in the card's link
        // href (→ /p/{token}), not as visible text. Assert the card link, not
        // a raw token string.
        await expect(
          sp.locator(`a[href*="${token}"]`).first(),
          "lost pet appears in the public /perdidas board",
        ).toBeVisible({ timeout: 20_000 });
      } finally {
        await stranger.close();
      }

      // --- Operator POV: the lost pet is visible on the operator board -------
      // Use admin (universal scope) so the projection assertion doesn't depend
      // on the arbitrary pet's locality matching a specific govt's jurisdiction
      // (a jurisdiction-scoped govt correctly sees only its own localities).
      //
      // Asserted by NAME, not by a link to the credential. That universal scope
      // is exactly a national/multi-province view, and PO decision 4b makes such
      // a row drop every owner-identifying field — case code, owner name, exact
      // last-seen point AND the `/p/{token}` link (LostPetRow's !showOwnerDetail
      // branch). This spec used to assert that link here, so it was asserting
      // the opposite of a recorded product decision; it failed the first time
      // CI ran it. The name is what a national operator legitimately sees, and
      // it is what "the lost pet appears on the board" actually means.
      await relogin(page, ACCOUNTS.admin);
      await page.goto("/gob/perdidas", { waitUntil: "domcontentloaded" });
      await expect(page.getByText(/mascotas perdidas/i).first()).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText(petName, { exact: false }).first(),
        "lost pet appears on the operator /gob/perdidas board",
      ).toBeVisible({ timeout: 15_000 });

      // --- Owner marks the pet found → public lost UI clears -----------------
      await relogin(page, ACCOUNTS.owner);
      await page.goto(`/mis-mascotas/${token}?sheet=marcar-encontrada`, {
        waitUntil: "domcontentloaded",
      });
      const confirm = page.getByRole("button", { name: MARK_FOUND_BUTTON });
      await expect(confirm).toBeVisible({ timeout: 15_000 });
      await confirm.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      // Re-fetch fresh (the found server action revalidates; avoid a client-cached
      // view of the just-cleared lost state). The goto races the action's own
      // client-side navigation (useActionRedirect fires window.location.assign
      // on its own schedule), and losing that race surfaces as
      // net::ERR_ABORTED — not a page failure. Tolerate it; the reload right
      // after re-establishes a deterministic fresh document either way.
      await page.goto(`/mis-mascotas/${token}`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-section="lost-case-block"]')).toHaveCount(0, {
        timeout: 20_000,
      });

      const stranger2 = await browser.newContext();
      try {
        const sp2 = await stranger2.newPage();
        await sp2.goto(`/p/${token}`, { waitUntil: "domcontentloaded" });
        await expect(sp2.locator('[data-section="lost-urgent-strip"]')).toHaveCount(0);
        await expect(sp2.getByText(/application error/i)).not.toBeVisible();
      } finally {
        await stranger2.close();
      }
    } finally {
      // Never leave the owner's pet in the lost state for other suites / demos.
      // The body switches actors (admin for the /gob board, owner after), so a
      // throw on the admin leg would hand the cleanup an admin session — and
      // ensurePetFound would then fail its own "sheet never mounted" assertion
      // instead of curing the leak. Re-establish the owner unconditionally.
      await relogin(page, ACCOUNTS.owner);
      await ensurePetFound(page, token);
    }
  });

  // ------------------------------------------------------------------------
  // (b) Vet Atender → owner libreta (immutable clinical event propagation).
  // ------------------------------------------------------------------------
  test("(b) clinic signs a vaccine on Atender → it surfaces in the owner libreta", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // ─── FIXTURE TIER ──────────────────────────────────────────────────────
    // Was alejo@dim.test + "Clínica Veterinaria Recoleta" + the literal
    // DIM-DEMO-0001. All three are seed-demo.ts, which CI does not run, so in
    // CI the login failed outright — and the spec's own `test.skip` on "no se
    // encontró" meant that on any half-seeded box it declared itself skipped
    // instead of red. Both legs now sit on the bootstrap tier:
    //   · signer — vet@dim.test, a MATRICULATED `vet_individual` member of
    //     "Refugio Test (Seed)". Atender gates on the `event.write` capability
    //     and a known DIM code, NOT on org type or custody
    //     (atender-access.ts), so the seeded refugio is a valid walk-in
    //     signer; and because the matrícula is verified, the asiento lands as
    //     professional_verified — which is what "a clinic signed this" means.
    //   · pet — owner@dim.test's first, read from their own registry.
    // The skip is gone: with both fixtures guaranteed, an Atender refusal is a
    // real failure and must say so.

    // Owner POV #1 — discover the pet AND take the "before" reading in the SAME
    // session. Done together deliberately: auth_login_email is 5/min·20/hour
    // keyed on the ADDRESS and no header evades it, so an extra owner login
    // here would spend budget the rest of the file needs.
    await relogin(page, ACCOUNTS.owner);
    const petToken = await firstOwnerPetToken(page);
    const before = await (await libretaAsientos(page, petToken))
      .filter({ hasText: ANTIRRABICA })
      .count();

    // --- Clinic POV: sign the vaccine on the walk-in surface ----------------
    await relogin(page, ACCOUNTS.vet);
    const orgToken = await resolveOrgToken(page, SEEDED_ORG_NAME);
    await page.goto(`/org/${orgToken}/atender/${petToken}?evento=vacuna`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    const surface = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    expect(
      /formato del código|no se encontró|no pertenecés|Necesitás el permiso/i.test(surface),
      `Atender refused ${petToken} for ${ACCOUNTS.vet} — both fixtures are bootstrap-tier, so this is a real failure, not a missing seed: ${surface.slice(0, 300)}`,
    ).toBe(false);

    // Fill and sign the vaccine (VaccinationForm reused on the walk-in surface,
    // wrapped by AtenderVaccinationGate — "Antirrábica" is an exact catalog hit
    // for both dog and cat, so the gate autoselects and never blocks).
    const vaccineInput = page.locator('input[name="vaccineName"]').first();
    await expect(vaccineInput).toBeVisible({ timeout: 20_000 });
    await vaccineInput.fill("Antirrábica");
    // ART-local date, NOT toISOString(): the server rejects future dates in
    // ARGENTINA time, and from ~21:00 ART onward the UTC date is already
    // TOMORROW — so every evening run (CI's usual window) submitted a
    // "future" vaccine and got "La fecha no puede ser futura." rendered into
    // an alert nothing read. This single line is why the seam "passed
    // locally" for whoever ran it in the morning.
    const todayArt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
    }).format(new Date());
    await page.locator('input[name="occurredAt"]').first().fill(todayArt);

    const submitBtn = page.getByRole("button", { name: /registrar vacuna/i }).first();
    // Server signs the event and hands back ?firmado=1 for the client to
    // navigate to (N3 contract — the action returns `redirectTo`, it does not
    // redirect itself; see lib/ui/use-action-redirect.ts). That client half
    // DROPS on occasion (the Next 15.5.x post-action navigation drop this
    // repo documents in lib/ui/full-page-action-nav.ts, and the exact reason
    // seam (d) stopped waiting on its finalize URL): the signature commits
    // while the URL never gains ?firmado=1. The URL is a nicety; this seam's
    // verdict is the owner-libreta outcome asserted right below (count rises
    // + professional provenance), which fails loudly if the submit truly
    // never landed — so a timed-out wait here downgrades to a non-event.
    await submitAndWait(
      page,
      submitBtn,
      (url) => url.searchParams.get("firmado") === "1",
      45_000,
    ).catch(() => {});

    // Same-day duplicate prompt (P4 item 4): seed-test-users already records
    // an Antirrábica for this pet DATED THE SEED DAY — which on a fresh CI
    // database is TODAY — so the action answers with the "¿Registrar otra
    // igual?" confirm round-trip instead of inserting, and the run-3/run-4
    // CI failures were this prompt sitting unanswered (locally the dev DB's
    // own same-day rows trip it identically). Confirming is the real user
    // path for a legitimate second dose; answer it and wait again.
    const sameDayConfirm = page.getByRole("button", { name: /registrar otra igual/i });
    if (await sameDayConfirm.count()) {
      await submitAndWait(
        page,
        sameDayConfirm,
        (url) => url.searchParams.get("firmado") === "1",
        45_000,
      ).catch(() => {});
    }

    // --- Owner POV #2: the signed vaccine is now in the pet's libreta -------
    // TWO assertions, because either alone can pass vacuously:
    //   · the row COUNT must rise. seed-test-users.ts already gives Firulais an
    //     owner-recorded "Antirrábica", so "an Antirrábica is visible" is true
    //     before this test does anything at all.
    //   · and the new row must carry PROFESSIONAL provenance. The seeded one is
    //     self-declared (`data-k="self"`); a matriculated vet's signature
    //     resolves to tier professional_verified → `data-k="verified"`
    //     (asiento-fields.ts deriveProvenance). That is the part of the seam
    //     that is actually about a CLINIC signing rather than the owner.
    await relogin(page, ACCOUNTS.owner);
    const asientos = await libretaAsientos(page, petToken);
    const antirrabicas = asientos.filter({ hasText: ANTIRRABICA });
    await expect(
      antirrabicas.locator('.ln-prov[data-k="verified"]').first(),
      "the vet-signed Antirrábica carries professional_verified provenance in the owner libreta",
    ).toBeVisible({ timeout: 20_000 });
    expect(
      await antirrabicas.count(),
      `owner libreta gained the vet-signed Antirrábica (had ${before} before signing)`,
    ).toBeGreaterThan(before);
  });

  // ------------------------------------------------------------------------
  // (c) Denuncia anónima → admin moderación → gob maltrato.
  // ------------------------------------------------------------------------
  test("(c) flagged anon denuncia → admin passes to triage → govt sees it", async ({ page }) => {
    test.setTimeout(120_000);

    // Anonymous: submit a denuncia whose ALL-CAPS wording trips the auto-flag.
    const denCode = await walkDenunciaWizard(page, { triggerModerationFlag: true });
    expect(denCode, "denuncia reference code returned from comprobante").toBeTruthy();

    // --- Admin POV: the flagged report is in the moderation queue -----------
    // ─── ROUTE DRIFT (F1 fusion, 2026-07-22) ───────────────────────────────
    // This seam used to walk /admin/moderacion → /admin/moderacion/[id]. That
    // journey no longer exists. The Denuncias hub ABSORBED Moderación and
    // Maltrato as tabbed STAGES, and /admin/moderacion + /gob/moderacion +
    // /gob/maltrato are now param-preserving redirects into
    // /gob/denuncias?etapa=… (lib/ui/denuncias-hub-redirect.ts). Three
    // consequences the old spec walked straight into:
    //   1. the stage screen renders with `underHub`, and ScreenHeader SUPPRESSES
    //      the screen's own eyebrow + h1 there — "Moderación de denuncias" is
    //      simply not a heading on this page any more; the hub's h1 is.
    //   2. the queue rows link to /gob/moderacion/{referenceCode}, so the old
    //      wait for /admin/moderacion/[id] could never resolve.
    //   3. that detail route mounts GovtModerationActions, whose buttons read
    //      "Aprobar (pasar a triage)" / "Aprobar y pasar a triage" — NOT the
    //      admin twin's "Pasar a triage". Same use case underneath
    //      (approveDenunciaModerationAction reuses passWelfareToTriage), so the
    //      post-condition below is unchanged.
    // The legacy entry point is asserted rather than bypassed: it is a real
    // contract (bookmarks, shared links) and pinning it here is what stops this
    // drift from going quiet a second time.
    await relogin(page, ACCOUNTS.admin);
    await page.goto("/admin/moderacion", { waitUntil: "domcontentloaded" });
    await expect(page, "legacy /admin/moderacion redirects into the Denuncias hub").toHaveURL(
      /\/gob\/denuncias\?.*etapa=moderacion/,
      { timeout: 15_000 },
    );
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(
      page.getByRole("heading", { name: /el recorrido de una denuncia/i }),
      "the Denuncias hub rendered",
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("tab", { name: /moderación/i }),
      "the Moderación stage is the active tab",
    ).toHaveAttribute("aria-selected", "true");

    const row = page.getByText(denCode).first();
    await expect(row, `denuncia ${denCode} present in the admin moderation queue`).toBeVisible({
      timeout: 15_000,
    });
    await row.click();
    await page.waitForURL(/\/gob\/moderacion\/[^/?#]+/, { timeout: 15_000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    // Read the report's own jurisdiction off the detail header — the triage
    // assertion at the end FILTERS the queue by it. The header's mono line is
    // "{referenceCode} · {locality}, {province} · creada … · flagged …".
    const metaLine = await page
      .locator("p")
      .filter({ hasText: denCode })
      .filter({ hasText: /creada/ })
      .first()
      .innerText();
    const [locality, provinceName] = (metaLine.match(/·\s*([^·]+?)\s*·\s*creada/)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim());
    // The queue's `province` param is an ISO 3166-2:AR CODE, not a display name
    // (resolveJurisdictionScope → provinceByCode), and `locality` is the SLUG.
    // Both matter: the scope resolver is lenient (localityByName slugifies what
    // it is given, so a display name still narrows the query) but OpFilterBar's
    // chip is strict (`l.slug === locality`), and a param that narrows without
    // producing a chip is exactly what it labels "Filtro no reconocido —
    // mostrando tu cobertura completa". Send the slug and both agree.
    const provinceCode = provinceByName(provinceName)?.code ?? "";
    const localitySlug = (locality ?? "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/\./g, "")
      .trim()
      .replace(/\s+/g, "-");
    expect(
      Boolean(localitySlug && provinceCode),
      `denuncia jurisdiction parsed from the moderation detail header: ${metaLine}`,
    ).toBe(true);

    // Pass it to triage (legitimate report, not spam). GovtModerationActions
    // swaps the three trigger buttons for the notes form, so the trigger and the
    // commit button are distinct strings — both carrying the verb of the act
    // since D.3 (f50e2064), never a bare "Confirmar". Notes have a 10-char floor.
    await page.getByRole("button", { name: /^aprobar \(pasar a triage\)$/i }).click();
    await page
      .locator("textarea")
      .first()
      .fill("Denuncia verificada en la batería de costuras — contenido coherente con abandono.");
    await page.getByRole("button", { name: /^aprobar y pasar a triage$/i }).click();
    await page.waitForURL(/\/gob\/denuncias\b/, { timeout: 20_000 });

    // --- Operator POV: the triaged report is visible in the triage stage ----
    // Still admin (universal scope) so the assertion doesn't depend on the demo
    // denuncia's locality (Av. Corrientes 1234, CABA) matching a specific
    // govt's jurisdiction — govt@dim.test is scoped to Ushuaia + El Calafate
    // and would CORRECTLY never see a CABA denuncia (same reasoning as seam a).
    // No re-login: this page is already the admin session, and every avoidable
    // login spends the per-address auth budget the rest of the file shares.
    // The maltrato queue hides flagged rows until moderationResolvedAt is set;
    // approving above sets it, so the row now surfaces universally.
    // WelfareDenunciaRow renders referenceCode as mono text — assert on it.
    // UI review M5 (2026-08-06): the queue selector (urgentes/sin asignar/
    // mías/todas/…) stopped being a second row of TABS and became a row of link
    // CHIPS, so there is no longer a `#tabpanel-<queue>` per queue — and no
    // hidden duplicate of the same rows under the inactive ones, which is what
    // the old `#tabpanel-all` scoping existed to step around. The list renders
    // ONCE now, so a plain `.first()` on the code is unambiguous. The queue is
    // still selected by `?queue=` exactly as before.
    // Addressed as the hub's triage stage; /gob/maltrato?queue=all still
    // redirects here, but there is no reason to pay the hop from inside a spec.
    //
    // SCOPED TO THE REPORT'S OWN LOCALITY, and that is load-bearing, not tidying.
    // The triage list is ordered `severityRank DESC, createdAt ASC` — OLDEST
    // FIRST — and paged at 50. An unfiltered queue therefore shows the row only
    // while the database is nearly empty: on a fresh CI seed it is on page 1, on
    // any box with a real backlog (948 open denuncias here) a just-created report
    // sorts to the END of its severity band and the assertion fails for a reason
    // that has nothing to do with the seam. Filtering by the report's own
    // locality (`locality` is a first-class param of this screen) makes "did it
    // enter the operator's triage queue" answerable in ONE page in both
    // environments — the population, not the pagination, is what the seam is about.
    await page.goto(
      `/gob/denuncias?etapa=triage&queue=all&province=${provinceCode}&locality=${encodeURIComponent(localitySlug)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForLoadState("networkidle").catch(() => {});
    // Fail loud if the jurisdiction filter was rejected: OpFilterBar falls back
    // to the operator's FULL coverage in that case, which would silently restore
    // the 50-row pagination problem this filter exists to remove.
    await expect(
      page.getByText(/filtro no reconocido/i),
      "the triage queue accepted the jurisdiction filter",
    ).toHaveCount(0);
    // The chip row proves the queue lens actually resolved to "Todas" (a
    // rejected/garbage ?queue= would fall back to "Sin asignar" and could show
    // a legitimately empty list — a green-looking failure).
    await expect(
      page
        .getByRole("navigation", { name: "Cola de denuncias" })
        .getByRole("link", { name: /^Todas/ }),
      "the triage queue selected the Todas chip",
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByText(denCode).first(),
      `denuncia ${denCode} visible to the operator maltrato queue (${locality}, ${provinceName}) after triage`,
    ).toBeVisible({ timeout: 20_000 });
  });

  // ------------------------------------------------------------------------
  // (d) Adopción: refugio publica → owner2 postula → refugio aprueba +
  //     finaliza → la mascota egresa de la custodia del refugio.
  // ------------------------------------------------------------------------
  //
  // Design notes (why this seam looks the way it does):
  //  - FIXTURE TIER. This used to run as alejo@dim.test against "Refugio
  //    Patitas del Norte", because seed-demo.ts publishes three
  //    adoption-eligible pets there server-side. Neither exists in CI, so once
  //    seams (b)/(c) stopped failing — and stopped masking this one behind
  //    serial-mode skips — the account simply could not log in. It now runs as
  //    orgadmin@dim.test against "Refugio Test (Seed)".
  //  - THE PET IS PROVISIONED HERE (T1-C3, 2026-09-18). This seam used to
  //    adopt out one of the three shelter-custody pets `pnpm db:bootstrap`
  //    seeds — and nothing ever gave the refugio another, so on staging, which
  //    is never re-seeded, the fixture ran out and e2e-nightly.yml was red 41
  //    nights (it also starved owner-ia-p6 #8 and print-surfaces, which read
  //    the same custody). Now the refugio INTAKES a new animal through its own
  //    wizard (e2e/_shelter-custody.ts), and the adoption below is what ends
  //    that custody. The adopted pet lands in owner2's registry; the afterAll
  //    sweeps it by name prefix on a local database.
  //  - An intaken pet is not adoption-eligible, so the seam performs the
  //    publication itself: mark apta on the Elegibilidad tab, then drive the
  //    2-step listing wizard — the title's "refugio publishes".
  //  - The final assertion is the TRUTHFUL post-condition: the pet LEAVES the
  //    refugio's shelter custody (adoption finalized). Finalization resolves the
  //    adopter by DNI and creates a stub profile when no user matches — ownership
  //    does NOT transfer to the applicant user (owner2 has no DNI on file), so
  //    "owner2 owns the pet" is not an achievable outcome with the seed. The
  //    cross-POV thing this seam really proves is: owner2's application reaches
  //    the refugio queue, the refugio approves, and the custody transfer commits.
  //  - Self-contained: each pass intakes, publishes and adopts out its OWN pet,
  //    so a re-run never inherits a half-finished listing from an earlier one.
  test("(d) refugio publishes → owner2 applies → refugio approves + finalizes → pet transfers out", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // --- Refugio (orgadmin): intake a pet of its own and PUBLISH it ----------
    await relogin(page, ACCOUNTS.orgAdmin);
    const orgToken = await resolveOrgToken(page, SEEDED_ORG_NAME);
    const petName = `${INTAKE_PET_PREFIX}${Date.now()}`;
    const petToken = await intakeShelterPet(page, orgToken, petName);

    // An intaken pet is not yet apta. Clear eligibility on its own tab, which is
    // exactly where the listing page's blocking copy tells the operator to go.
    await page.goto(`/org/${orgToken}/mascotas/${petToken}/eligibility`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.getByRole("button", { name: /^apta para adopci[oó]n$/i }).click();
    await page.getByRole("button", { name: /^confirmar elegibilidad$/i }).click();
    // Assert the PERSISTED state, not the transient confirmation: the form
    // commits and then does a full document reload onto the same URL
    // (navigateAfterActionSuccess), which wipes its own "Marcada como apta…"
    // output before it can be observed. "Estado actual" is SSR'd from the DB
    // and survives — and "No apta" cannot satisfy this pattern.
    await expect(
      page.getByText(/estado actual:\s*apta/i).first(),
      `${petToken} is recorded as apta para adopción after the decision`,
    ).toBeVisible({ timeout: 20_000 });

    // The listing wizard: step 1 content → step 2 publish.
    await page.goto(`/org/${orgToken}/mascotas/${petToken}/adoptar`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page
      .locator("#story")
      .fill("Llegó al refugio como callejero y busca una familia tranquila y responsable.");
    await page.getByRole("button", { name: /^guardar y continuar$/i }).click();
    const publishBtn = page.getByRole("button", { name: /^publicar adopci[oó]n$/i });
    await expect(publishBtn, "step 2 of the listing wizard").toBeVisible({ timeout: 20_000 });
    await expect(
      publishBtn,
      `"Publicar adopción" is enabled for ${petToken} once it is apta — a disabled button here means an unresolved blocker a fresh intake should not have`,
    ).toBeEnabled();
    await publishBtn.click();
    await expect(
      page.getByText(/Publicada y visible/i).first(),
      `${petToken} is published and publicly visible`,
    ).toBeVisible({ timeout: 20_000 });

    // --- owner2 postula (5-step application wizard) ------------------------
    await relogin(page, ACCOUNTS.owner2);
    const applyRes = await page.goto(`/adoptar/${petToken}`, { waitUntil: "domcontentloaded" });
    expect(applyRes?.status(), "public adoption page responds 2xx").toBeLessThan(400);
    await page.waitForLoadState("networkidle").catch(() => {});
    // The public listing must offer the CTA — that is what "published" means to
    // a citizen, and it is the one thing only this page can prove.
    await expect(
      page.getByRole("button", { name: /postular/i }).first(),
      `the published listing for ${petName} offers owner2 the "Postular" CTA`,
    ).toBeVisible({ timeout: 15_000 });

    // ...but ENTER the wizard by URL, not by clicking that CTA.
    //
    // This block used to click it, swallow the resulting waitForURL with a
    // `.catch(() => {})`, probe `#motivation`, and run the whole application
    // only `if (formLoaded)`. A click dispatched before React attaches is
    // silently dropped (the #39 hydration race this repo has fought since the
    // 2026-07-03 clickthrough audit) — so on a slow hydrate the wizard never
    // opened, `formLoaded` stayed false, EVERY assertion below was jumped, and
    // the seam reported success having applied for nothing. That is exactly
    // what happened on the first run after seams (b)/(c) stopped masking this
    // test behind serial-mode skips: the refugio queue was empty because no
    // application had ever been submitted. A direct navigation cannot be
    // dropped, and the form is now a hard assertion rather than a condition.
    await page.goto(`/adoptar/${petToken}/postular`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const wizardMounted = await page
      .locator("#motivation")
      .isVisible({ timeout: 20_000 })
      .catch(() => false);

    if (wizardMounted) {
      // Drive all 5 steps scoping every action to the ACTIVE wizard step
      // (inactive steps stay in the DOM as sr-only / aria-hidden).
      const activeStep = () => page.locator('section[aria-hidden="false"]');
      const activeContinuar = () =>
        activeStep()
          .getByRole("button", { name: /continuar/i })
          .first();
      await page
        .locator("#motivation")
        .fill("Busco darle un hogar estable, con patio grande y mucho cariño responsable.");
      await activeContinuar().click();
      await page.waitForTimeout(400);

      // Steps 2 & 3 are radio-card groups whose inputs are sr-only AND whose rows
      // sit under a sticky pet-photo header that intercepts pointer events — a
      // label/text click hangs on the actionability check. Dispatch the click
      // straight to the underlying radio input instead.
      await activeStep().locator('input[name="prior_pets"][value="no"]').dispatchEvent("click");
      await page.waitForTimeout(200);
      await activeContinuar().click();
      await page.waitForTimeout(400);

      await activeStep()
        .locator('input[name="housing"][value="casa_con_patio"]')
        .dispatchEvent("click");
      await page.waitForTimeout(200);
      await activeContinuar().click();
      await page.waitForTimeout(400);

      await activeContinuar().click(); // step 4 (optional) → step 5
      await page.waitForTimeout(400);

      await activeStep().getByRole("checkbox").check(); // consent (required)
      await activeStep()
        .getByRole("button", { name: /enviar postulaci/i })
        .click();
      // Terminal state, either shape. The happy path is ApplicationForm's own
      // in-place success screen ("Tu postulación a {name} fue enviada"), rendered
      // from client state after the action resolves. But the final submit
      // intermittently completes as a FULL DOCUMENT navigation instead (the #39
      // hydration race), and the server then re-renders /postular — which, now
      // that the application exists, is the "Ya postulaste para {name}" screen.
      // Both mean the application committed (verified against
      // `adoption_application_submitted` in pet_events), and accepting only the
      // first made this a coin flip. What the application actually DID is proven
      // unconditionally by the refugio-queue assertion below, not here.
      await expect(
        page.getByRole("heading", { name: /fue enviada|ya postulaste/i }).first(),
        "owner2's application reached a terminal confirmation state",
      ).toBeVisible({ timeout: 20_000 });
    } else {
      // owner2 ALREADY has a live application on this pet — the documented
      // non-idempotency (a previous pass published and applied but did not finish
      // adopting the pet out, so the loop above picks the same pet again). On a
      // freshly bootstrapped database this branch never runs; CI always drives
      // the wizard.
      //
      // /postular does NOT "redirect away, leaving no form" as this spec used to
      // claim — it renders an explicit "Ya postulaste para {name}" screen. That
      // named state is what gets asserted, so "the wizard did not mount" can only
      // be excused by the ONE product state that legitimately excuses it, never
      // by a blank page, an error boundary, or a slow hydrate.
      //
      // This is NOT the old self-skip: nothing downstream is conditional. The
      // refugio-queue assertion, the approval, the finalize and the custody
      // post-condition all still execute and must pass.
      await expect(
        page.getByRole("heading", { name: /ya postulaste/i }),
        "no wizard is only acceptable because owner2 already applied to this pet",
      ).toBeVisible({ timeout: 15_000 });
    }

    // --- Refugio (orgadmin): owner2's application reached the queue → approve
    await relogin(page, ACCOUNTS.orgAdmin);
    await page.goto(`/org/${orgToken}/adopciones`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    // Each queue row is a link to the application detail and shows "→ {petName}".
    const appRow = page
      .locator(`a[href*="/org/${orgToken}/adopciones/"]`, {
        hasText: new RegExp(escapeRe(petName), "i"),
      })
      .first();
    // HARD, not a self-skip. This used to `test.skip` when the row was missing,
    // on the theory that the downstream was "covered by Deep Pass C" — which
    // means the cross-POV half of the seam, the entire reason this test exists,
    // could evaporate silently on any run. The application was submitted a few
    // lines above against a pet THIS test just published; if it does not reach
    // the refugio's own queue, that is the seam breaking and it must say so.
    await expect(
      appRow,
      `owner2's application for ${petName} reached the refugio adoption queue`,
    ).toBeVisible({ timeout: 20_000 });
    await appRow.click();
    await page.waitForURL(/\/org\/[^/]+\/adopciones\/[0-9a-f-]{36}/, { timeout: 15_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    // ReviewButtons: the trigger "Aprobar postulación" REPLACES the three-button
    // row with the confirm step, whose commit button carries the verb of the act
    // — and since D.3 (f50e2064) that verb is the SAME string, "Aprobar
    // postulación", not the old "Confirmar aprobación" this spec waited for.
    // So the same locator is clicked twice: the first click resolves to the
    // trigger, and after the swap the only match left is the commit button.
    // Notes are optional on the approve path.
    const approveBtn = page.getByRole("button", { name: /^aprobar postulaci[oó]n$/i });
    await approveBtn.click();
    await expect(approveBtn, "the approval confirm step replaced the trigger row").toHaveCount(1);
    await approveBtn.click();
    // The decision ends on a receipt in place (L-13), no longer a push back to
    // the queue — so wait for the receipt, not for a URL.
    await expect(
      page.getByRole("heading", { name: /^postulaci[oó]n aprobada$/i }),
      "the approval ended on its receipt",
    ).toBeVisible({ timeout: 20_000 });

    // --- Refugio finalizes the adoption to the APPROVED APPLICANT -----------
    // This used to type a DNI (30123456 / "Adoptante Demo Costuras") because the
    // seam believed finalization could only resolve an adopter by document,
    // creating a stub profile — hence its old note that "ownership does NOT
    // transfer to the applicant user". That is no longer what the screen does:
    // with an approved application on file, FinalizeAdoptionForm preselects the
    // POSTULANTE APROBADO (owner2) and states the outcome plainly — "la mascota
    // queda registrada en la cuenta de la persona que se postuló online". The
    // DNI fields are the off-platform fallback behind "¿Adopción por fuera de
    // las postulaciones?", not this path. Typing a DNI here adopted the pet out
    // to a stranger and then asserted a weaker post-condition than the seam's
    // own title promises.
    await page.goto(`/org/${orgToken}/mascotas/${petToken}/adoption`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(
      page.locator('input[name="__appChoice"]:checked'),
      "the approved applicant is preselected as the adopter",
    ).toHaveCount(1);
    // Submit, then assert the OUTCOME rather than the navigation.
    //
    // finalizeAdoption's contract is `redirectTo: /org/{org}/mascotas?adopcion=
    // {token}`, and this spec used to wait for exactly that URL. It commits — the
    // pet demonstrably leaves custody — but the browser frequently never gets
    // there: the client half of the N3 contract (useActionRedirect →
    // window.location.assign) does not always fire, so the document stays put
    // while the RSC re-render swaps the page to "Animal no disponible". That is
    // the Next 15.5.x post-action navigation drop this repo documents in
    // lib/ui/full-page-action-nav.ts, and it is NOT this seam's subject —
    // reported separately. Waiting on the URL made a passing mutation look like a
    // 30s timeout. The two post-conditions below prove the transfer itself, which
    // is what "the pet transfers out" means.
    await page.getByRole("button", { name: /finalizar adopci/i }).click();
    await page.waitForLoadState("networkidle").catch(() => {});

    // --- Cross-POV post-condition #1: the pet left the refugio's custody ----
    // The /adoption surface only resolves pets still under the org's active
    // shelter custody, so after a successful finalize it reports the pet as
    // unavailable — proving the custody transfer committed. Reload fresh.
    //
    // One retry on the submit itself: a click dispatched before hydration
    // attaches handlers is silently dropped (the recurring task-#39 failure
    // mode, worst on CI cold starts) — when the reload still shows the
    // finalize form, the first click never reached the action; submit once
    // more before judging the transfer.
    // Matches BOTH stories the guard can now tell. The page used to say only
    // "Animal no disponible" — which reads as a failure right after the most
    // important action a refugio performs — so a pet whose custody ENDED now
    // gets success framing instead ("ya no está bajo tu custodia"). Same
    // post-condition either way: the finalize form is gone because the animal
    // left. Keep both alternatives; the neutral wording still renders for a pet
    // this org never had custody of.
    const custodyGone = page
      .getByText(/animal no disponible|no figura bajo custodia|ya no está bajo tu custodia/i)
      .first();
    await page.goto(`/org/${orgToken}/mascotas/${petToken}/adoption`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    const retrySubmit = page.getByRole("button", { name: /finalizar adopci/i });
    if ((await custodyGone.count()) === 0 && (await retrySubmit.count()) > 0) {
      await retrySubmit.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.goto(`/org/${orgToken}/mascotas/${petToken}/adoption`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState("networkidle").catch(() => {});
    }
    await expect(
      custodyGone,
      "pet transferred out of the refugio's custody after the adoption was finalized",
    ).toBeVisible({ timeout: 20_000 });

    // --- Cross-POV post-condition #2: owner2 now OWNS the pet ---------------
    // The other half of the transfer, and the one this test is named for. Custody
    // leaving the refugio and ownership arriving at the adopter are two different
    // facts; asserting only the first would pass just as well if the pet had
    // fallen out of the system entirely.
    await relogin(page, ACCOUNTS.owner2);
    await page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(
      page.locator(`a[href^="/mis-mascotas/${petToken}"]`).first(),
      `${petName} is registered to owner2 after the adoption was finalized`,
    ).toBeVisible({ timeout: 20_000 });
  });
});
