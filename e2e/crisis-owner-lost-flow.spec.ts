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
 * THE PET IS A NAMED FIXTURE, NOT "THE FIRST ACTIVE ROW" (2026-10-06).
 * scripts/seed-test-users.ts gives owner@dim.test Firulais, Michi and Atún
 * and marks the FIRST of them (Firulais) lost as the bootstrap's lost-pet
 * fixture, so Michi is the seed's active cat with no chip. The token is still
 * read at runtime — the seed generates it — but from the row whose heading
 * (LnRegRow's serif span) is exactly "Michi". Picking `.first()` of whatever
 * looked active let any extra pet a local DB carries (demo seeds, a QA run)
 * decide which animal this spec walked, and with it the step count and the
 * outcome. Rows badged "Al cuidado" are somebody else's animal this account
 * only caretakes and are excluded. A Michi left lost by an earlier aborted
 * run is put back first with `ensurePetFound`, so the walk starts from the
 * same state every time.
 *
 * Michi has neither microchip nor tattoo, so the "enriched details" step is
 * present; the flow still detects it rather than assuming a fixed step count,
 * because a local Michi can have been given a chip by hand.
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

/** The seeded active, chipless cat of owner@dim.test (scripts/seed-test-users.ts). */
const PET_NAME = "Michi";

test("owner marks a pet lost — public credential flips to lost state for a stranger", async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);

  await loginAs(page, ACCOUNTS.owner);

  // The seeded fixture, by name — see the header. An ASSERTION, not a skip:
  // the seed guarantees Michi, so a missing row is a broken seed. Exactly ONE
  // row: two Michis would make the pick ambiguous again, and that should be
  // red, not resolved by DOM order. Auto-retrying, so it also absorbs the
  // registry's streaming render (`Locator.count()` is one-shot).
  await page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const petLink = page.locator('a[href^="/mis-mascotas/DIM-"]', {
    has: page.locator("span.font-ln-serif", { hasText: new RegExp(`^${PET_NAME}$`) }),
    hasNotText: /Al cuidado/i,
  });
  await expect(
    petLink,
    `owner@dim.test must own exactly one pet named ${PET_NAME} (scripts/seed-test-users.ts seedOwnerPets).`,
  ).toHaveCount(1, { timeout: 20_000 });
  const href = await petLink.getAttribute("href");
  const token = (href ?? "").split("/mis-mascotas/")[1];
  expect(token, "publicToken parsed from registry link").toBeTruthy();
  const petName = PET_NAME;

  // A Michi an earlier aborted run left lost is put back before the walk; on
  // an active Michi this is a no-op (the sheet shows its not-lost notice).
  await ensurePetFound(page, token);

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

    // The confirmation is its own ROUTE (perdida/activada), rendered from the
    // open episode in the database — not wizard state, which the action's
    // revalidation used to unmount before it ever showed. So this waits for
    // the URL AND that route's heading: the heading alone could not tell the
    // route from a resurrected in-place view, and the URL alone could be a
    // redirect back out of it (the route sends a pet with no open episode to
    // its profile). The navigation is fired imperatively from the submit
    // handler, not from an effect on a component the refresh can unmount.
    await expect(page).toHaveURL(new RegExp(`/mis-mascotas/${token}/perdida/activada$`), {
      timeout: 20_000,
    });
    await expect(
      page.getByRole("heading", { level: 1, name: `Activamos la búsqueda de ${petName}` }),
    ).toBeVisible();

    // ---- Verify as a STRANGER — brand-new context, zero cookies/session. ----
    const strangerContext = await browser.newContext();
    try {
      const strangerPage = await strangerContext.newPage();
      const response = await strangerPage.goto(`/p/${token}`);
      expect(response?.status()).toBeLessThan(400);

      // The credential IS the lost one: the card carries the situation, and
      // the lost body (PublicLostSections) is on the paper.
      await expect(strangerPage.locator(".pc-cred").first()).toHaveAttribute(
        "data-situation",
        "perdida",
      );
      await expect(strangerPage.locator('[data-section="lost-urgent-strip"]')).toBeAttached();

      // What tells a finder the pet is lost is the situation chip in the
      // identity row (the red urgent strip and its headline left the paper in
      // the 2026-10 redesign). Its words are PET_SITUATIONS.perdida.label
      // ("Perdida", lib/ui/pet-situation.ts) gendered by situationLabelForSex
      // (lib/utils/format.ts): "Perdido" for a male pet, "Perdida" otherwise —
      // followed by the recency ("· recién", "· hace …"). It is an alert.
      const lostChip = strangerPage.locator('[data-section="masthead-situation-chip"]');
      await expect(lostChip).toBeVisible();
      await expect(lostChip).toHaveText(/^(Perdido|Perdida)\b/);
      await expect(lostChip).toHaveAttribute("role", "alert");
      await expect(strangerPage.getByRole("heading", { level: 1, name: petName })).toBeVisible();

      // Disclosed channel: the call CTA is present (phone was enabled). Scoped
      // to the finder verbs under the card — the sticky bar repeats "Llamar".
      await expect(
        strangerPage
          .locator('[data-section="lost-cta-row"]')
          .getByRole("link", { name: /^llamar$/i }),
      ).toBeVisible();

      // NOT disclosed: no last-seen location section renders (both the
      // location field and its disclosure toggle were left off). The heading
      // is gendered (lastSeenHeadingLabel): visto / vista / visto/a.
      await expect(strangerPage.getByText(/última vez vist[oa]/i)).not.toBeVisible();
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
