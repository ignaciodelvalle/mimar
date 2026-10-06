import { type Page, expect, test } from "@playwright/test";

import { ACCOUNTS, loginAs } from "./demo/_helpers";

/**
 * Cuidador temporal — the two browser-level walks the change is judged on.
 *
 *   TE1  designate → accept → the caretaker records a medical event → the
 *        titular ends it → the pet leaves the caretaker's list.
 *   TE2  the deny-list AT THE UI: with an active arrangement, a caretaker
 *        cannot reach transfer, adoption publishing, identity editing or a
 *        jurisdiction change — the panel shows those rows grey, with the
 *        reason, and none of them is a link (owner-pet-actions, 2026-10-01).
 *        The photo, which IS theirs to take, is a link that opens its sheet.
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
 * the thing this spec exists for — that the caretaker never meets the boundary
 * by pressing a button. Since owner-pet-actions the row is SHOWN, grey and with
 * its reason, instead of hidden (PO: "lo que no aplica en gris con el motivo"):
 * the boundary is read before it is tried, and there is still nothing to press.
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
    // Scoped to this page's own path, as in e2e/demo/_helpers.ts: another
    // action the page fires must not stand in for the finalize/withdraw.
    const actionPath = new URL(page.url()).pathname;
    const resolved = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.request().headers()["next-action"] !== undefined &&
        new URL(r.url()).pathname === actionPath,
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: confirm }).click();
    await resolved;
    // The page reloads itself (navigateAfterActionSuccess), and the caller's
    // next fill must not race that reload. Reload it ourselves until the form
    // only the "no arrangement" state renders is there — a visible button
    // alone could be the pre-reload DOM (the cascade in CI run 36640718326).
    await expect(async () => {
      await page.goto(page.url(), { waitUntil: "domcontentloaded" });
      await expect(page.getByLabel(/correo/i)).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    return;
  }
}

/**
 * Open the invitation the way a real invitee does: from their notification.
 *
 * The card's CTA goes through `/notificaciones/{id}/abrir`, which resolves
 * where the reader may go at click time and redirects there — so the href is
 * the door, and the DESTINATION is what this asserts: after the click, the
 * browser is on `/cuidado/{token}` with the invitation on screen.
 */
async function openInvitation(page: Page): Promise<void> {
  await page.goto("/notificaciones", { waitUntil: "domcontentloaded" });
  const card = page
    .locator("article")
    .filter({ hasText: /te propone cuidar a/ })
    .first();
  await expect(
    card,
    "the invitee's notification is in their inbox — this IS the delivery path",
  ).toBeVisible();
  await card.getByRole("link", { name: "Ver invitación" }).click();
  await page.waitForURL(/\/cuidado\/[^/?#]+$/);
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
        // Wait for the SERVER ACTION's answer (the chapas.spec pattern), never
        // the post-action URL: navigating straight after the click aborts the
        // in-flight action, and the redirect is the hop e2e/README.md says drops.
        // Scoped to THIS page's path so another action the page fires cannot
        // stand in for the one we wait on (the e2e/demo/_helpers.ts rule).
        const weightSaved = caretakerPage.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            r.request().headers()["next-action"] !== undefined &&
            new URL(r.url()).pathname === `/mis-mascotas/${token}`,
          { timeout: 30_000 },
        );
        await caretakerPage.getByRole("button", { name: "Registrar peso" }).click();
        await weightSaved;
        // Assert the OUTCOME (the entry in the libreta), never the redirect. And
        // assert the refusal is ABSENT: a caretaker being told "esta acción es
        // solo del titular" here would mean the deny-list had swallowed the one
        // thing they are for. The action's own full-document redirect may still
        // be in flight and abort this goto (net::ERR_ABORTED in CI run
        // 36640718326), so the navigation is retried until the outcome shows.
        await expect(async () => {
          await caretakerPage.goto(`/mis-mascotas/${token}?tab=libreta`, {
            waitUntil: "domcontentloaded",
          });
          await expect(caretakerPage.getByText(/13[.,]7/).first()).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 30_000 });
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

    test("TE2 — un cuidador no alcanza transferir, publicar en adopción ni cambiar identidad", async ({
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

        // ---- NOT REACHABLE: the deny-list rows are GREY, with the reason ------
        // owner-pet-actions (PO 2026-10-01): the old "⋯ Más" sheet HID these
        // rows; the panel below the credential SHOWS them grey and says why, so
        // the boundary is read before it is tried. What must not exist is a
        // LINK. The old `?sheet=mas` URL is kept as an alias that lands on the
        // panel, and this walk goes through it on purpose.
        await caretakerPage.goto(`/mis-mascotas/${token}?sheet=mas`, {
          waitUntil: "domcontentloaded",
        });
        const panel = caretakerPage.locator('[data-section="pet-action-panel"]');
        // NON-VACUITY FIRST. If the panel failed to render, every absence below
        // would pass over an empty screen.
        await expect(panel.getByRole("link", { name: /Chapa física/ })).toBeVisible();
        for (const [denied, reason] of [
          ["Transferir la titularidad", "Solo el titular"],
          ["Acompañamiento de adopción", "Solo el titular"],
          ["Editar datos", "No disponible para cuidadores"],
          ["Cuidador temporal", "Solo el titular"],
        ] as const) {
          await expect(
            panel.getByRole("link", { name: denied, exact: true }),
            `"${denied}" must not be a door for a caretaker`,
          ).toHaveCount(0);
          const row = panel.locator('[aria-disabled="true"]', { hasText: denied });
          await expect(row, `"${denied}" is shown grey`).toBeVisible();
          await expect(row).toContainText(reason);
        }

        // ---- REACHED: a photo IS a caretaker's to take ------------------------
        // `lib/domain/titular-only.ts` lists photos among what a caretaker MAY
        // do. The app's photo screen admits them; since owner-pet-actions the
        // web's "Foto" is its own sheet too (`?sheet=foto`), not a field of the
        // edit form greyed above — so it is a LINK here, and it opens.
        const photo = panel.getByRole("link", { name: "Foto", exact: true });
        await expect(photo).toHaveAttribute("href", `/mis-mascotas/${token}?sheet=foto`);
        await photo.click();
        await expect(
          caretakerPage.getByRole("dialog").getByRole("button", { name: "Guardar foto" }),
        ).toBeVisible();

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
