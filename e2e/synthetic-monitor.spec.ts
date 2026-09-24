import { expect, test } from "@playwright/test";

import { resolveStagingUrl } from "./_base-url";
import { type OwnerPii, describePiiLeaks, findPiiLeaks } from "./_page-identity";
import { leftSignIn } from "./_sign-in-route";
import {
  ACCOUNTS,
  DEMO_PHOTOS,
  USHUAIA_JURISDICTION,
  USHUAIA_POINT,
  assertRealPage,
  discoverOwnerPii,
  discoverPetToken,
  fileDenunciaAt,
  loginAs,
  pickCard,
  uniqueIp,
} from "./demo/_helpers";

/**
 * Synthetic monitor — the 4 critical flows, FAST. Designed to run every N
 * minutes overnight via scripts/qa-monitor.ps1 against the DEPLOYED staging
 * origin and go LOUD the instant a critical path breaks.
 *
 * ORIGIN: `STAGING_URL` (or the staging_url file) pins it to a deploy. With
 * neither set it stays on whatever baseURL the active config provides — :3333
 * under playwright.config.ts in CI, `QA_PORT` under local3000 — so it doubles
 * as a regression suite over the CI build. It used to fall back to a
 * hardcoded localhost:3000 instead, which in CI is a port nothing serves: all
 * four flows died on ERR_CONNECTION_REFUSED without asserting a thing. See the
 * header of e2e/_base-url.ts.
 *
 * The four flows (target: < 2 min total on a warm deploy):
 *   (a) owner login + credential surface renders
 *   (b) anon public credential /p/<runtime token> → 200, NO owner PII,
 *       Cache-Control: no-store (the revoke/lost-cache privacy invariant)
 *   (c) govt login → /gob/maltrato has actionable rows → /gob/panorama paints
 *   (d) anon denuncia wizard reaches the reference-code screen (submits a real
 *       minimal denuncia clearly marked "PRUEBA SINTÉTICA" so operators ignore)
 *
 * Run:
 *   STAGING_URL=https://<deploy>.vercel.app \
 *     pnpm exec playwright test e2e/synthetic-monitor.spec.ts \
 *     --config=playwright.local3000.config.ts
 *
 * Each flow is its own test so a single broken path is pinpointed, not masked.
 */

const STAGING = resolveStagingUrl();
// Only override the config's baseURL when a deploy was actually named.
if (STAGING) test.use({ baseURL: STAGING });

// Remote serverless cold starts (~10s) — give each flow headroom but keep the
// whole battery under ~2 min on a warm deploy.
test.describe.configure({ mode: "parallel", timeout: 90_000 });

/**
 * The pet token and the owner's PII are BOTH resolved at runtime from the
 * owner's own account, memoized for the file.
 *
 * P2.4 — WHY THIS IS NOT A LITERAL, AND WHY THE SCOPE IS WHAT IT IS.
 *
 * The token used to be the literal `DIM-DEMO-0001` (seed-demo's hero pet) and
 * the name the literal "Ignacio del Valle". Neither exists on a bootstrapped
 * database: CI's owner@dim.test is "Lucía Tester" with randomly-generated pet
 * tokens. That made flow (b) worse than red — a 404 boundary would have
 * answered 200-with-no-PII, and `not.toContain("Ignacio del Valle")` CANNOT
 * FAIL against a page that never had that name on it. A privacy assertion that
 * cannot fail is not a privacy assertion; it is a decoration on the one class
 * of check that must never be decorative.
 *
 * Scope now covers the owner's display name, their exact account email AND
 * their phone (format-independent — see findPiiLeaks), instead of just a name.
 * DNI and address are deliberately excluded and the reasoning is written down
 * next to the type: e2e/_page-identity.ts → OwnerPii.
 *
 * `discoverPetToken` defaults to activeOnly, so the pet under test is
 * flagged REGISTRADO/REGISTRADA, never lost. That precondition is load-bearing
 * for the phone and
 * email halves: `pets.disclose_phone_when_lost` / `disclose_email_when_lost`
 * make those two a LEGITIMATE disclosure on a lost pet. Flow (b) re-asserts the
 * non-lost state on the rendered page before treating their presence as a leak.
 */
let fixture: Promise<{ token: string; pii: OwnerPii }> | null = null;
function ownerFixture(browser: import("@playwright/test").Browser): Promise<{
  token: string;
  pii: OwnerPii;
}> {
  fixture ??= (async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await loginAs(page, ACCOUNTS.owner);
      // ACTIVE pet (activeOnly is the default) — see the docblock above.
      const token = await discoverPetToken(page);
      const pii = await discoverOwnerPii(page, ACCOUNTS.owner);
      return { token, pii };
    } finally {
      await context.close();
    }
  })();
  return fixture;
}

test.describe(`synthetic monitor @ ${STAGING ?? "suite baseURL"}`, () => {
  // ------------------------------------------------------------------------
  // (a) Owner login + credential renders.
  // ------------------------------------------------------------------------
  test("(a) owner login + credential surface renders", async ({ page }) => {
    // fresh: this flow's SUBJECT is the sign-in, so it must not be handed a
    // replayed session by the shared helper's cache.
    await loginAs(page, ACCOUNTS.owner, { fresh: true });
    // Landed inside the app (not stranded on the sign-in page).
    //
    // `not.toContain("/login")` era VACUO desde que la ruta se mudó a
    // `/iniciar-sesion`: la cadena vieja no aparece ni cuando el ingreso falla,
    // así que esta línea pasaba estuviera el usuario adentro o afuera.
    expect(
      leftSignIn(new URL(page.url())),
      `owner should have left the sign-in page, but is on ${page.url()}`,
    ).toBe(true);

    await page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
    // At least one pet credential card must render for the owner. Anchor on
    // the DIM- token prefix so the "/mis-mascotas/nueva" create-pet CTA can
    // never satisfy this assertion on an empty registry.
    await expect(
      page.locator('a[href^="/mis-mascotas/DIM-"]').first(),
      "owner registry shows at least one pet credential",
    ).toBeVisible({ timeout: 20_000 });

    // No error boundary.
    await expect(page.getByText(/algo salió mal|application error/i)).not.toBeVisible();
  });

  // ------------------------------------------------------------------------
  // (b) Anon public credential — 200, no PII, no-store.
  // ------------------------------------------------------------------------
  test("(b) anon /p credential: 200 + no PII + no-store", async ({ browser, page }) => {
    const { token, pii } = await ownerFixture(browser);
    // Header + status via a raw request on a context that never authenticated —
    // a true anon fetch. Only the token DISCOVERY above was authenticated.
    const res = await page.request.get(`/p/${token}`);
    expect(res.status(), `/p/${token} responded ${res.status()}`).toBe(200);

    const cacheControl = res.headers()["cache-control"] ?? "";
    expect(
      cacheControl,
      `/p/${token} Cache-Control must forbid shared caching (no-store) — got "${cacheControl}". A stale CDN copy would keep serving a found pet as SE BUSCA + phone, or a revoked share. This is the privacy-class fix in middleware.ts + lib/infra/public-cache-policy.ts.`,
    ).toMatch(/no-store/i);

    const body = await res.text();

    // ---- Preconditions, asserted BEFORE the leak check reads anything -------
    // A 200 alone does not prove this is the credential, and the credential's
    // PII contract is STATE-DEPENDENT: on a LOST pet, phone and email are a
    // legitimate disclosure behind pets.disclose_{phone,email}_when_lost, so
    // asserting their absence there would be asserting the wrong thing.
    // `<title>` settles both at once — app/(public)/p/[publicToken]/page.tsx
    // emits "<name> | Credencial miMAR" for a live pet and "SE BUSCA: <name> |
    // miMAR" for a lost one.
    expect(
      body,
      `/p/${token} is not the credential page (or the pet is LOST, where phone/email are a disclosed-by-consent field, not a leak). Expected the live-credential <title>.`,
    ).toContain("Credencial miMAR");
    expect(body, `/p/${token} rendered the SE BUSCA (lost) surface`).not.toContain("SE BUSCA");

    // ---- The actual privacy assertion --------------------------------------
    // Against the PII of the account under test, resolved at runtime. The
    // literal it replaced ("Ignacio del Valle", a persona CI never seeds) could
    // not fail no matter what the page leaked.
    const leaks = findPiiLeaks(body, pii);
    expect(
      leaks,
      `public credential /p/${token} leaks owner PII — ${describePiiLeaks(leaks)}`,
    ).toEqual([]);
    // Domain-wide net: catches ANY seeded account's address, not just this
    // owner's, so a leak of a different profile still trips the monitor.
    expect(body, "public credential leaks an @dim.test email").not.toMatch(/@dim\.test/i);

    // Render sanity: the page is the credential, not an error/404 boundary.
    // Shared guard — the bespoke check here matched only "no encontramos esta
    // página", which is NOT the copy the (public) group's boundary renders.
    await page.goto(`/p/${token}`, { waitUntil: "domcontentloaded" });
    await assertRealPage(
      page,
      `/p/${token}`,
      page.getByText("Credencial pública", { exact: true }).first(),
    );
  });

  // ------------------------------------------------------------------------
  // (c) Govt login → maltrato actionable → panorama paints.
  // ------------------------------------------------------------------------
  test("(c) govt maltrato rows + panorama canvas paints", async ({ browser, page }) => {
    await loginAs(page, ACCOUNTS.govt);

    // Legacy /gob/maltrato entry still lands on the unified Denuncias hub —
    // the heading is "Denuncias (N en total)"; "Denuncias de maltrato" is gone.
    await page.goto("/gob/maltrato?queue=all", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /denuncias \(\d+ en total\)/i }),
      "maltrato console heading",
    ).toBeVisible({ timeout: 20_000 });

    // `pnpm db:bootstrap` creates no denuncias at all, so on a fresh CI
    // database the hub is legitimately empty. File one the way a citizen does —
    // inside THIS operator's coverage (ACCOUNTS.govt is seeded on Ushuaia +
    // El Calafate), because a govt queue matches jurisdiction on an exact
    // province/locality pair.
    //
    // ─── WHICH STAGE THE ROW LANDS IN IS NOT A CONSTANT ────────────────────
    // This probed the TRIAGE tab to decide whether to file, then asserted on
    // the MODERACIÓN tab. Both halves were written from a single observed CI
    // run (30865512613: Triage empty, Moderación carrying the filed cases) and
    // read as a rule what is really an emergent, ORDER-DEPENDENT outcome.
    //
    // The truth: create-welfare-report auto-flags an anonymous denuncia into
    // Moderación only when a heuristic fires (lib/infra/welfare-moderation.ts).
    // walkDenunciaWizard's text is long, mixed-case, "moderado" and carries a
    // photo, so the ONLY rule it can trip is `duplicate_within_24h` — i.e.
    // whether an EARLIER SPEC already filed that same description in this run.
    // Flagged → Moderación; unflagged → Triage (buildMaltratoListConditions
    // keeps exactly the unflagged rows). Until 8adeb437 admin-case-detail-shell
    // always filed the first copy, so the govt-side one was a duplicate and
    // Moderación held it; that commit seeded two real `cases` into bootstrap,
    // the admin spec's "is the queue empty?" gate stopped firing, and the
    // govt-side denuncia became the FIRST of its text — unflagged, in Triage.
    // This test then found a Triage row, skipped filing, and asserted an empty
    // Moderación tab. Nothing about the product was broken.
    //
    // So: probe BOTH stages, and assert on whichever one actually holds it. A
    // synthetic monitor must not depend on another spec's side effects.
    // Match only VISIBLE rows. Triage's own queue tabs became link chips (UI
    // review M5, 2026-08-06) so that stage now renders its list once, but the
    // hub's STAGE tabs and Moderación's status tabs are still UrlTabs — their
    // inactive tabpanels stay in the DOM with [hidden], so the `:visible`
    // filter still earns its keep here.
    const HUB_ROW = 'a[href^="/gob/maltrato/"]:visible, a[href^="/gob/moderacion/"]:visible';
    const STAGES = ["triage", "moderacion"] as const;

    /** Land on the first hub stage that has an actionable row; null if none. */
    async function stageWithActionableRow(): Promise<string | null> {
      for (const etapa of STAGES) {
        await page.goto(`/gob/denuncias?etapa=${etapa}&queue=all`, {
          waitUntil: "domcontentloaded",
        });
        await page.waitForLoadState("networkidle").catch(() => {});
        if ((await page.locator(HUB_ROW).count()) > 0) return etapa;
      }
      return null;
    }

    let stage = await stageWithActionableRow();
    if (!stage) {
      await fileDenunciaAt(browser, USHUAIA_POINT, USHUAIA_JURISDICTION);
      stage = await stageWithActionableRow();
    }
    expect(
      stage,
      "neither hub stage (Triage nor Moderación) shows an actionable row for this operator after filing a denuncia inside its coverage — check welfare_reports.jurisdiction_province for the just-filed DEN- code (see fileDenunciaAt's Nominatim caveat)",
    ).not.toBeNull();
    // `page` is already on the stage that has the row.
    await expect(
      page.locator(HUB_ROW).first(),
      `hub stage "${stage}" has at least one actionable (visible) case row for this operator`,
    ).toBeVisible({ timeout: 20_000 });

    // Panorama map paints a canvas within 60s.
    await page.goto("/gob/panorama", { waitUntil: "domcontentloaded" });
    // PO screenshot fix (2026-07-08): the h1 "Panorama" was removed
    // (redundant with the breadcrumb + nav-rail); the eyebrow line is the
    // stable console-loaded signal now.
    // jurisdiction-compliance (2026-07-03): the heading is now scoped to the
    // operator's jurisdiction — "Centro de Situación · CABA · …" for a
    // CABA-scoped account, "Centro de Situación Nacional" for a national one.
    // Match the stable "Centro de Situación" prefix so either scope passes.
    await expect(
      page.getByText(/Centro de Situación/i).first(),
      "panorama console heading",
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("canvas").first(), "panorama MapLibre canvas painted").toBeVisible({
      timeout: 60_000,
    });
  });

  // ------------------------------------------------------------------------
  // (d) Anon denuncia wizard reaches the reference-code screen.
  // ------------------------------------------------------------------------
  test("(d) anon denuncia wizard → reference code", async ({ page }) => {
    test.setTimeout(90_000);
    // Distinct apparent origin: the anon submit is IP rate-limited at
    // 1/min + 3/hour (welfare_anon) and (c) just filed a denuncia from this
    // same suite — without this header the submit here is the "2nd in a
    // minute" and is refused. Same TEST-NET-3 pattern as fileDenunciaAt.
    //
    // Honoured against a LOCAL target only. This monitor's usual origin is the
    // DEPLOYED staging deploy, where the edge overwrites x-real-ip before
    // callerIp() sees it (measured 2026-08-26 — lib/infra/rate-limit.ts above
    // callerIp()): there (c) and (d) DO share one welfare_anon bucket, and if
    // this flow ever starts failing on a refusal at 1/min, that is the reason.
    // The cure is spacing the two submits, not another header.
    await page.setExtraHTTPHeaders({ "x-real-ip": uniqueIp() });
    // Clearly-marked synthetic report so operators can ignore it.
    const description =
      "PRUEBA SINTÉTICA - monitoreo automatico QA, ignorar. No hay animal real involucrado.";

    /**
     * Click "Continuar" and assert the NEXT step actually rendered; when the
     * click is silently dropped (hydration race — the recurring task-#39
     * failure mode: handlers not yet attached, especially on serverless cold
     * starts), retry once. Without this, step 1 never advances and the
     * severityCard assertion fails while the app itself works fine.
     */
    async function advanceTo(nextStepMarker: ReturnType<typeof page.locator>): Promise<void> {
      const btn = page.getByRole("button", { name: /continuar/i }).first();
      await expect(btn, "wizard Continuar button").toBeVisible();
      await btn.click();
      try {
        await expect(nextStepMarker).toBeVisible({ timeout: 8_000 });
      } catch {
        await btn.click(); // dropped click — one retry
        await expect(nextStepMarker, "wizard advanced after Continuar retry").toBeVisible({
          timeout: 10_000,
        });
      }
    }

    await page.goto("/denuncias/nueva", { waitUntil: "domcontentloaded" });
    // Let hydration finish before the first interaction — clicks dispatched
    // before React attaches handlers are silently dropped (same wait the
    // shared loginAs helper uses).
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2_000);

    // Step 1 — Qué pasó
    await pickCard(page, "kindCard", "neglect");
    await advanceTo(page.getByRole("heading", { name: /qué tan grave/i }));

    // Step 2 — Gravedad
    await pickCard(page, "severityCard", "moderado");
    await advanceTo(page.locator("textarea#description"));

    // Step 3 — Dónde y cuándo (free-text carries the PRUEBA SINTÉTICA marker)
    await page.locator("textarea#description").fill(description);
    await pickCard(page, "occurredAtOption", "today_yesterday");
    // jurisdiction-compliance (2026-07-03): the denuncia now needs a precise
    // map point so it routes to the authority for that zone ("necesita un
    // punto preciso para llegar a la autoridad de esa zona"). Grant a
    // deterministic geolocation (CABA centre) and use the in-form control to
    // drop the pin; without it, Continuar stays gated on step 3.
    await page.context().grantPermissions(["geolocation"]);
    await page.context().setGeolocation({ latitude: -34.6037, longitude: -58.3816 });
    await page.getByRole("button", { name: /usar mi ubicación actual/i }).click();
    // Let the picker place the pin and reverse-geocode before advancing.
    await page.waitForTimeout(1_500);
    await advanceTo(page.locator('label:has(input[name="subjectKindCard"])').first());

    // Step 4 — Quién (optional): skip fast if a skip control exists, else fill.
    const skip = page.getByRole("button", { name: /saltear este paso/i });
    if (
      await skip
        .count()
        .then((c) => c > 0)
        .catch(() => false)
    ) {
      await skip.click();
      await expect(page.getByRole("button", { name: /enviar an[oó]nima/i })).toBeVisible({
        timeout: 10_000,
      });
    } else {
      await pickCard(page, "subjectKindCard", "unowned_animal");
      await advanceTo(page.getByRole("button", { name: /enviar an[oó]nima/i }));
    }

    // Step 5 — Cerrar: anonymous + evidence photo + submit
    await page.getByRole("button", { name: /enviar an[oó]nima/i }).click();
    await page.locator("#evidenceFiles").setInputFiles(DEMO_PHOTOS[0]);
    const submit = page.getByRole("button", { name: /enviar denuncia/i });
    await expect(submit, "denuncia submit button enabled").toBeEnabled();
    await submit.click();

    // Success: redirect to the comprobante + the reference-code screen.
    await page.waitForURL(/\/denuncias\/codigo\//, { timeout: 40_000 });
    await expect(
      // The comprobante's actual copy is "Tu denuncia fue registrada." —
      // the old /denuncia registrada/ pattern missed the "fue" and reported
      // a rendered success screen as a failure.
      page.getByText(/tu código de seguimiento|denuncia fue registrada/i),
      "reference-code screen rendered",
    ).toBeVisible({ timeout: 20_000 });
  });
});
