import { type Page, expect, test } from "@playwright/test";

import { ACCOUNTS, loginAs } from "./demo/_helpers";

/**
 * Cuidador temporal — the two browser-level walks the change is judged on.
 *
 *   TE1  designate → accept → the caretaker records a medical event → the
 *        titular ends it → the pet leaves the caretaker's list.
 *   TE2  the deny-list AT THE UI: with an active arrangement, a caretaker can
 *        neither see nor reach transfer, adoption publishing, identity editing
 *        or a jurisdiction change.
 *
 * WHY THE TWO LIVE IN ONE FILE, `serial`
 * ---------------------------------------------------------------------------
 * Both need the same expensive precondition — a real accepted grant between
 * two real accounts — and building it twice would double the sign-ins on
 * `auth_login_email` (5/min · 20/hour, keyed on the EMAIL: a fresh x-real-ip
 * buys nothing). `loginAs` caches sessions per worker, and serial ordering
 * keeps the shared grant in a known state between the two.
 *
 * WHY TE2 IS NOT "the server refuses it"
 * ---------------------------------------------------------------------------
 * The server already refuses: `requireTitularAccess` (C2) and migration 0190's
 * RLS. Both are unit- and db-tested. What CANNOT be tested below the browser is
 * the thing this spec exists for — that the caretaker never SEES the control.
 * A permission wall discovered by pressing a button teaches a person the
 * product is broken, not that the boundary is deliberate.
 *
 * CONVENTIONS HONOURED (e2e/README.md)
 * ---------------------------------------------------------------------------
 *   · No hardcoded tokens. The pet comes from owner@dim.test's own registry;
 *     the grant token comes from the invitee's real notification, which is the
 *     only way a person reaches /cuidado/{token} in production either.
 *   · Never assert a 404 by HTTP status, and never wait on a post-action URL —
 *     both walks assert the OUTCOME a mutation produces.
 *   · Dates are ART-local. A UTC date is already tomorrow from ~21:00 ART, and
 *     the designation form's `min` is today in Argentina.
 *   · Bootstrap tier only: owner@dim.test and owner2@dim.test are both seeded
 *     by scripts/seed-test-users.ts, so this runs on CI's fresh DB.
 *
 * IDEMPOTENCE. Both walks end with the grant ENDED or CANCELLED. The two
 * partial unique indexes on `pet_caretaker_grants` are scoped
 * `where status='pending'` and `where status='accepted'`, so the rows this
 * leaves behind never block a re-run.
 */

const TITULAR = ACCOUNTS.owner;
const CARETAKER = ACCOUNTS.owner2;

/** Today's ARGENTINE calendar day as YYYY-MM-DD — never `toISOString()`. */
function todayInAr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** `days` after the Argentine today, same calendar arithmetic. */
function arDatePlus(days: number): string {
  const [y, m, d] = todayInAr().split("-").map(Number);
  const base = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * The first ACTIVE pet the titular OWNS, from their registry.
 *
 * Same locator as rehome-by-titular.spec.ts, for the same reason: the row's
 * href carries the token, and either non-urgent flag ("AL DÍA" once
 * compliance is derived, "REGISTRADA/O" before) marks a pet this walk can
 * designate a caretaker for. The old `:has(img)` + /registrad[ao]/ locator
 * required a PHOTO, and scripts/seed-test-users.ts seeds owner@dim.test's
 * pets without one — so on CI's fresh DB this spec found nothing and
 * `test.skip`ped every run, green (e2e/README.md, "a skip built on one
 * lies"). Rows badged "Al cuidado" are somebody else's animal the account
 * only caretakes; the designation form refuses those, so they are skipped
 * as candidates, not picked.
 *
 * An ASSERTION, not a skip: the seed guarantees the pet, so an empty registry
 * is the seed breaking — the one thing this walk exists to catch.
 */
async function pickActivePetToken(page: Page): Promise<string> {
  await page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const rows = page.locator('a[href^="/mis-mascotas/DIM-"]', {
    hasText: /AL DÍA|REGISTRAD[AO]/i,
    hasNotText: /Al cuidado/i,
  });
  await expect(
    rows.first(),
    "owner@dim.test has no active owned pet — the caretaker walk needs one (seeded by scripts/seed-test-users.ts).",
  ).toBeVisible({ timeout: 20_000 });
  const href = (await rows.first().getAttribute("href")) ?? "";
  const token = href.split("/mis-mascotas/")[1] ?? "";
  expect(token, "publicToken parsed from the registry link").toBeTruthy();
  return token;
}

/**
 * Designate the caretaker and return the pet token.
 *
 * Leaves any earlier arrangement resolved first: a pending or accepted grant
 * makes the form refuse ("Ya hay una invitación…"), and a previous failed run
 * is exactly when that matters.
 */
async function designate(page: Page, token: string): Promise<void> {
  await page.goto(`/mis-mascotas/${token}/cuidado`, { waitUntil: "domcontentloaded" });
  await clearExistingGrant(page);

  await page.getByLabel(/correo/i).fill(CARETAKER);
  await page.getByLabel(/^Desde/i).fill(todayInAr());
  await page.getByLabel(/^Hasta/i).fill(arDatePlus(7));
  await page.getByRole("button", { name: "Invitar como cuidador/a" }).click();

  // The OUTCOME, not the URL: the form ends on a SuccessScreen naming the
  // invitee. Trámite-style flows never end on a silent redirect, and the N3
  // client hop is exactly the thing e2e must not wait on.
  await expect(page.getByText("Invitación enviada")).toBeVisible();
  await expect(page.getByText(new RegExp(CARETAKER, "i"))).toBeVisible();
}

/** Resolve whatever arrangement the page is showing, so a re-run starts clean. */
async function clearExistingGrant(page: Page): Promise<void> {
  for (const [trigger, confirm] of [
    ["Finalizar el cuidado ahora", "Confirmar la finalización"],
    ["Retirar la invitación", "Confirmar el retiro"],
  ] as const) {
    const button = page.getByRole("button", { name: trigger });
    if ((await button.count()) === 0) continue;
    await button.click();
    await page.getByRole("button", { name: confirm }).click();
    // The page reloads itself (navigateAfterActionSuccess) — wait for the form
    // that only the "no arrangement" state renders.
    await expect(page.getByRole("button", { name: "Invitar como cuidador/a" })).toBeVisible();
    return;
  }
}

/** Open the invitation the way a real invitee does: from their notification. */
async function openInvitation(page: Page): Promise<void> {
  await page.goto("/notificaciones", { waitUntil: "domcontentloaded" });
  const invite = page.locator('a[href^="/cuidado/"]').first();
  await expect(
    invite,
    "the invitee's notification carries the /cuidado link — this IS the delivery path",
  ).toBeVisible();
  await invite.click();
  await expect(page.getByRole("heading", { name: /Te invitaron a cuidar a/ })).toBeVisible();
}

// ---------------------------------------------------------------------------
// TE1 — the full arrangement, end to end
// ---------------------------------------------------------------------------

test.describe
  .serial("cuidador temporal", () => {
    test("TE1 — designar, aceptar, cargar un evento médico y finalizar", async ({
      page,
      browser,
    }) => {
      test.setTimeout(120_000);

      await loginAs(page, TITULAR);
      const token = await pickActivePetToken(page);
      await designate(page, token);

      // ---- the invitee accepts, in their own context -------------------------
      const caretakerContext = await browser.newContext();
      const caretakerPage = await caretakerContext.newPage();
      try {
        await loginAs(caretakerPage, CARETAKER);
        await openInvitation(caretakerPage);

        // The spec's scenario: the scope is on screen BEFORE there is anything to
        // accept, and it is both halves — permissions alone would be recruiting
        // a caretaker on a half-truth.
        await expect(caretakerPage.getByText(/Podés cargar eventos médicos/)).toBeVisible();
        await expect(caretakerPage.getByText(/No podés transferir/)).toBeVisible();

        await caretakerPage.getByRole("button", { name: "Aceptar el cuidado" }).click();
        // KEY 2 of the two-key public-contact model is deliberately left
        // untouched: off is the default, and the walk must not quietly consent on
        // the caretaker's behalf.
        await expect(caretakerPage.getByRole("checkbox", { name: /contacto/i })).not.toBeChecked();
        await caretakerPage.getByRole("button", { name: "Confirmar el cuidado" }).click();
        // The SERVER's accepted state, which is the only one that exists.
        //
        // This used to assert /Cuidás a/ — the title of a client-side
        // LnSuccessScreen that could never paint. acceptCaretakerGrantAction
        // calls revalidatePath on THIS route, so the RSC tree comes back with
        // the grant 'accepted', `canRespond` (= invitee AND 'pending') false,
        // and the island unmounted before its success flag could render.
        // Deterministic, not flaky — the screen has been deleted rather than
        // waited for. This is the callout the page renders in its place.
        await expect(caretakerPage.getByText(/Estás cuidando a/)).toBeVisible({
          timeout: 20_000,
        });

        // ---- the pet is now in the caretaker's list, and SAYS it is not theirs
        await caretakerPage.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
        await expect(caretakerPage.getByText("Al cuidado").first()).toBeVisible();
        // The count splits — an undifferentiated total would call somebody else's
        // animal one of yours.
        await expect(caretakerPage.getByText(/al cuidado/).first()).toBeVisible();

        // ---- a medical event: the whole point of the arrangement -------------
        await caretakerPage.goto(`/mis-mascotas/${token}?sheet=peso`, {
          waitUntil: "domcontentloaded",
        });
        await caretakerPage.getByLabel(/^Peso/i).fill("13.7");
        await caretakerPage.getByLabel(/^Fecha/i).fill(todayInAr());
        await caretakerPage.getByRole("button", { name: "Registrar peso" }).click();
        // Assert the OUTCOME (the entry in the libreta), never the redirect. And
        // assert the refusal is ABSENT: a caretaker being told "esta acción es
        // solo del titular" here would mean the deny-list had swallowed the one
        // thing they are for.
        await caretakerPage.goto(`/mis-mascotas/${token}?tab=libreta`, {
          waitUntil: "domcontentloaded",
        });
        await expect(caretakerPage.getByText(/13[.,]7/).first()).toBeVisible();
        await expect(caretakerPage.getByText(/solo del titular/i)).toHaveCount(0);

        // ---- the titular ends it, unilaterally and immediately ---------------
        await page.goto(`/mis-mascotas/${token}/cuidado`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Finalizar el cuidado ahora" }).click();
        // The confirmation must say that ACCESS ends and possession does not
        // follow. This sentence is the reason the whole termination design exists.
        await expect(page.getByText(/coordinar la devolución/)).toBeVisible();
        await page.getByRole("button", { name: "Confirmar la finalización" }).click();
        await expect(page.getByRole("button", { name: "Invitar como cuidador/a" })).toBeVisible();

        // ---- and the pet leaves the caretaker's list -------------------------
        await caretakerPage.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
        await expect(caretakerPage.locator(`a[href="/mis-mascotas/${token}"]`)).toHaveCount(0);
      } finally {
        await caretakerContext.close();
      }
    });

    // -------------------------------------------------------------------------
    // TE2 — the deny-list, at the UI layer
    // -------------------------------------------------------------------------

    test("TE2 — un cuidador no ve ni alcanza transferir, publicar en adopción ni cambiar identidad", async ({
      page,
      browser,
    }) => {
      test.setTimeout(120_000);

      await loginAs(page, TITULAR);
      const token = await pickActivePetToken(page);
      await designate(page, token);

      const caretakerContext = await browser.newContext();
      const caretakerPage = await caretakerContext.newPage();
      try {
        await loginAs(caretakerPage, CARETAKER);
        await openInvitation(caretakerPage);
        await caretakerPage.getByRole("button", { name: "Aceptar el cuidado" }).click();
        await caretakerPage.getByRole("button", { name: "Confirmar el cuidado" }).click();
        // Same correction as the walk above — the server's accepted state, not
        // the deleted client success screen.
        await expect(caretakerPage.getByText(/Estás cuidando a/)).toBeVisible({
          timeout: 20_000,
        });

        // ---- NOT SEEN: the overflow sheet offers none of the deny-list rows ---
        await caretakerPage.goto(`/mis-mascotas/${token}?sheet=mas`, {
          waitUntil: "domcontentloaded",
        });
        // NON-VACUITY FIRST. If the sheet failed to open, every absence below
        // would pass over an empty screen.
        await expect(caretakerPage.getByRole("link", { name: /Chapa física/ })).toBeVisible();
        for (const denied of [
          "Transferir mascota",
          "Buscar hogar",
          "Editar datos y ficha",
          "Cuidador temporal",
        ]) {
          await expect(
            caretakerPage.getByRole("link", { name: denied }),
            `"${denied}" must not be offered to a caretaker`,
          ).toHaveCount(0);
        }

        // ---- NOT REACHED: and the refusal is a sentence, not a 404 -----------
        // Asserting the SURFACE, never response.status(): a streaming route can
        // flush the shell before notFound() fires and answer 200 anyway
        // (e2e/README.md, hard-won rules).
        for (const [path, what] of [
          [`/mis-mascotas/${token}/editar`, /Editar los datos de la mascota/],
          [`/mis-mascotas/${token}/mudanza`, /Registrar una mudanza/],
          [`/mis-mascotas/${token}/corregir-especie`, /Corregir la especie/],
        ] as const) {
          await caretakerPage.goto(path, { waitUntil: "domcontentloaded" });
          await expect(caretakerPage.getByText(what)).toBeVisible();
          await expect(caretakerPage.getByText(/solo la puede hacer el titular/i)).toBeVisible();
          // A refusal that dead-ends is its own failure: the caretaker must be
          // told what they CAN still do, and be given a way back.
          await expect(caretakerPage.getByText(/eventos médicos/)).toBeVisible();
          await expect(
            caretakerPage.getByRole("link", { name: /Volver a la libreta/ }),
          ).toBeVisible();
        }

        // Sub-designation — deny-list row `caretaker-sub-designation`. A caretaker
        // naming another caretaker would launder the whole boundary.
        await caretakerPage.goto(`/mis-mascotas/${token}/cuidado`, {
          waitUntil: "domcontentloaded",
        });
        await expect(
          caretakerPage.getByText(/Solo el titular puede designar un cuidador/i),
        ).toBeVisible();
        await expect(
          caretakerPage.getByRole("button", { name: "Invitar como cuidador/a" }),
        ).toHaveCount(0);
      } finally {
        // Leave the DB as we found it: end the arrangement created for this walk.
        await caretakerContext.close();
        await page.goto(`/mis-mascotas/${token}/cuidado`, { waitUntil: "domcontentloaded" });
        await clearExistingGrant(page);
      }
    });
  });
