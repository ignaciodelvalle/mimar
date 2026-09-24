import { expect, test } from "@playwright/test";
import { ACCOUNTS, ensurePetFound, loginAs } from "./demo/_helpers";

/**
 * Crisis path — AUTHENTICATED owner flow.
 *
 * Drives the real "Marcar como perdida" wizard as owner@dim.test, then
 * verifies — from a FRESH browser context with no session (a real stranger)
 * — that the public credential flips to the lost state and only discloses
 * what the owner explicitly opted into.
 *
 * The pet + token are discovered at runtime from /mis-mascotas — never
 * hardcoded. seed-test-users.ts seeds Firulais/Michi/Atún, but that seed
 * only runs its `seedOwnerPets` step when the owner has NO pets yet, so a
 * local dev DB layered with other seed/demo scripts can give owner@dim.test
 * a completely different pet set. We pick the first pet whose registry row
 * shows a non-urgent status flag ("AL DÍA" once compliance is derived,
 * "REGISTRADO/A" before — i.e. not already lost or deceased). The flag
 * agrees with the animal's sex, so the locator must be sex-agnostic —
 * matching only /registrada/i would silently skip every male and every
 * unknown-sex pet, and "skipped" reads as "passed" in CI. The flag is the
 * LnRegRow badge rendered by app/(app)/mis-mascotas/page.tsx.
 *
 * The NAME comes from the row's own heading (LnRegRow's serif span), not
 * from a photo's alt: the seed gives these pets no photo, so the old
 * `:has(img)` locator found nothing on CI's fresh DB and the spec
 * `test.skip`ped every run, green (e2e/README.md, "a skip built on one
 * lies"). Rows badged "Al cuidado" are somebody else's animal this account
 * only caretakes; the mark-lost wizard is the titular's, so they are not
 * candidates.
 *
 * The wizard is driven ADAPTIVELY: the "enriched details" step only exists
 * when the picked pet has neither a microchip nor a tattoo (MarkLostWizard's
 * `showDetailsStep`), so the flow checks for it instead of assuming a fixed
 * step count.
 *
 * Location is left empty on purpose: setPetLostAction
 * (src/modules/events/actions.ts) treats location as optional server-side.
 * Skipping it keeps the run fast and avoids depending on the live Nominatim
 * geocoder that LocationFields mode="l2" calls out to.
 *
 * Cleanup: the pet is reverted to "found" by `ensurePetFound` (demo/_helpers)
 * in a `finally` block regardless of pass/fail, so the local dev DB is left as
 * it started for other suites / manual QA. This header used to spell out the
 * sheet's commit label; that label had already been renamed under it, and a
 * copy of a dead string in a comment is how the drift stayed invisible in
 * three specs at once. The control is named ONCE, in `MARK_FOUND_BUTTON`.
 */

test("owner marks a pet lost — public credential flips to lost state for a stranger", async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);

  await loginAs(page, ACCOUNTS.owner);

  // Discover an active (non-lost, non-deceased) pet the owner OWNS from their
  // registry — any will do, we just need one currently NOT lost. An
  // ASSERTION, not a skip: scripts/seed-test-users.ts seeds owner@dim.test
  // with active pets, so an empty registry is a broken seed. Auto-retrying,
  // so it also absorbs the registry's streaming render (`Locator.count()` is
  // one-shot and does not wait — the README's worst shape for a gate).
  await page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const petLink = page
    .locator('a[href^="/mis-mascotas/DIM-"]', {
      hasText: /AL DÍA|REGISTRAD[AO]/i,
      hasNotText: /Al cuidado/i,
    })
    .first();
  await expect(
    petLink,
    "owner@dim.test has no active owned pet — the mark-lost walk needs one (seeded by scripts/seed-test-users.ts).",
  ).toBeVisible({ timeout: 20_000 });
  const href = await petLink.getAttribute("href");
  const token = (href ?? "").split("/mis-mascotas/")[1];
  expect(token, "publicToken parsed from registry link").toBeTruthy();
  // The row's heading is the pet's name (components/ui/RegRow.tsx LnRegRow:
  // the serif span beside the status flag). Trimmed: the success copy below
  // interpolates it into a regex.
  const petName = (
    (await petLink.locator("span.font-ln-serif").first().textContent()) ?? ""
  ).trim();
  expect(petName, "pet name read from the registry row's heading").toBeTruthy();

  try {
    await page.goto(`/mis-mascotas/${token}/perdida`, { waitUntil: "domcontentloaded" });
    await expect(
      // Sex-flexed since the ciclo-perdido sweep — tolerate all forms.
      page.getByRole("heading", { name: /^Marcar como perdid(?:o|a|o\/a)$/ }),
    ).toBeVisible();

    // Step 1 — ¿Dónde la viste? Location is optional — skip straight through.
    await page.getByRole("button", { name: /^continuar →$/i }).click();

    // Step 2 — Datos para reconocerla — ONLY present when the pet has no
    // microchip and no tattoo (MarkLostWizard's `showDetailsStep`). Detect
    // it instead of assuming a fixed step count.
    const hasDetailsStep = await page
      .getByText(/sin chip ni tatuaje, estos detalles son clave/i)
      .isVisible()
      .catch(() => false);
    if (hasDetailsStep) {
      await page.getByRole("button", { name: /^continuar →$/i }).click();
    }

    // Final step — Qué se muestra al público (affirmative-consent disclosure).
    // Enable ONLY the phone channel; leave name + last-seen location off.
    await expect(page.getByText(/qué se muestra al público/i)).toBeVisible();
    await page.getByRole("switch", { name: "Tu teléfono" }).click();
    await page.getByRole("button", { name: /^marcar como perdid(?:o|a|o\/a)$/i }).click();

    await expect(
      page.getByText(new RegExp(`activamos la búsqueda de ${petName}`, "i")),
    ).toBeVisible({
      timeout: 15_000,
    });

    // ---- Verify as a STRANGER — brand-new context, zero cookies/session. ----
    const strangerContext = await browser.newContext();
    try {
      const strangerPage = await strangerContext.newPage();
      const response = await strangerPage.goto(`/p/${token}`);
      expect(response?.status()).toBeLessThan(400);

      const banner = strangerPage.locator('[data-section="lost-urgent-strip"]');
      await expect(banner).toBeVisible();
      // Headline is sex-dependent (lostBannerHeadline): "ESTÁ PERDIDO" (male),
      // "ESTÁ PERDIDA" (female) or "SE PERDIÓ" (unknown) — match any variant.
      await expect(banner).toContainText(/perdid[oa]|se perdió/i);
      await expect(strangerPage.getByText(new RegExp(`soy ${petName}`, "i"))).toBeVisible();

      // Disclosed channel: the call CTA is present (phone was enabled).
      await expect(strangerPage.getByRole("link", { name: /llamar/i })).toBeVisible();

      // NOT disclosed: no last-seen location section renders (both the
      // location field and its disclosure toggle were left off).
      await expect(strangerPage.getByText(/última vez vista/i)).not.toBeVisible();
    } finally {
      await strangerContext.close();
    }
  } finally {
    // Revert the pet to "found" so re-runs and other suites see it active
    // again — and PROVE it. The inline cleanup this replaced clicked a button
    // named "Confirmar" that had been renamed under it, so its count-guard
    // no-opped silently on every run and this spec (green) left the shared
    // fixture LOST for every later suite. See ensurePetFound's header.
    await ensurePetFound(page, token);
  }
});
