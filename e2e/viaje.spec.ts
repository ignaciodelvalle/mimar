import { type Page, expect, test } from "@playwright/test";

import {
  TRAVEL_AIRLINE_NOTICE,
  TRAVEL_FORBIDDEN_COPY,
  TRAVEL_SEMAFORO_LABELS,
} from "@/lib/domain/travel-copy";

import { ACCOUNTS, loginAs } from "./demo/_helpers";

/**
 * Viajes (viajes-fase-2, task 8.1) — the owner's travel flow in a browser.
 *
 *   V1  record a trip → read its semáforo → record a CVI → export the PDF.
 *   V2  a caretaker of the same pet sees none of it: no "Viaje y movilidad"
 *       row, the titular notice on /viaje, and the trip's own event page
 *       answers as if the record did not exist (design D8: a trip says when a
 *       household is away).
 *   V3  the owner cancels the trip, and it leaves the screen.
 *
 * WHY ONE `serial` FILE, AND WHY V2 RUNS BEFORE THE CANCEL
 * ---------------------------------------------------------------------------
 * V2 is only worth anything while the trip is LIVE: checking that a caretaker
 * cannot see a cancelled trip proves nothing. So the cancel comes last, and the
 * three walks share one trip, one CVI and the sign-ins `loginAs` caches per
 * worker (`auth_login_email` is keyed on the EMAIL; a fresh x-real-ip buys
 * nothing — e2e/README.md, hard-won rules).
 *
 * RUN-SCOPED FIXTURE IDENTITY
 * ---------------------------------------------------------------------------
 * A CVI number is unique per pet forever (record-cvi refuses a twin, and a CVI
 * cannot be cancelled), and a trip is unique per corridor + date until it is
 * cancelled. A failed run leaves both behind, so the CVI number and the trip's
 * day offset come from one per-run stamp. It is identity, never timing: no
 * assertion compares a clock.
 *
 * CONVENTIONS HONOURED (e2e/README.md)
 *   · No hardcoded tokens: the pet is owner@dim.test's first active owned pet,
 *     the same pick caretaker-temporal.spec.ts makes; the caretaker reaches it
 *     through their real invitation notification.
 *   · Outcomes, not post-action URLs; never a 404 by HTTP status.
 *   · Dates are ART-local, typed the way DateInputAr reads them (dd/mm/aaaa).
 *   · Bootstrap tier: owner@ and owner2@ are seeded by scripts/seed-test-users.ts,
 *     and `travel-exports` by db/exports_storage.sql in `pnpm db:bootstrap`.
 *
 * IDEMPOTENCE. V3 cancels the trip and V2's `finally` ends the caretaker
 * arrangement, so a re-run starts from the state the pet was found in (plus one
 * CVI, which the product has no way to remove).
 */

const TITULAR = ACCOUNTS.owner;
const CARETAKER = ACCOUNTS.owner2;

const RUN_STAMP = Date.now().toString(36).toUpperCase();
const CVI_NUMBER = `E2E-${RUN_STAMP}`;
// 20..199 days ahead: inside the one-year travel window, and a different day
// from whatever trip an earlier failed run left uncancelled.
const TRIP_DAYS_AHEAD = 20 + (Number.parseInt(RUN_STAMP, 36) % 180);

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

/** YYYY-MM-DD → dd/mm/aaaa, what DateInputAr accepts and the page prints. */
function arDisplay(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

const TRIP_DATE = arDatePlus(TRIP_DAYS_AHEAD);
/** travelTripLabel's shape: "Chile, 12/11/2026". */
const TRIP_LABEL = `Chile, ${arDisplay(TRIP_DATE)}`;

/** Shared across the serial walks. */
let petToken = "";
let tripEventId = "";

/** The first ACTIVE pet the titular OWNS — see caretaker-temporal.spec.ts. */
async function pickActivePetToken(page: Page): Promise<string> {
  await page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
  const rows = page.locator('a[href^="/mis-mascotas/DIM-"]', {
    hasText: /AL DÍA|REGISTRAD[AO]/i,
    hasNotText: /Al cuidado/i,
  });
  await expect(
    rows.first(),
    "owner@dim.test has no active owned pet — the travel walk needs one (seeded by scripts/seed-test-users.ts).",
  ).toBeVisible({ timeout: 20_000 });
  const href = (await rows.first().getAttribute("href")) ?? "";
  const token = href.split("/mis-mascotas/")[1] ?? "";
  expect(token, "publicToken parsed from the registry link").toBeTruthy();
  return token;
}

/** Open /viaje and wait for the page itself, not just the shell. */
async function openViaje(page: Page): Promise<void> {
  await page.goto(`/mis-mascotas/${petToken}/viaje`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /^Viaje de / })).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * Show THIS run's trip. With one trip the page reads it directly; a trip an
 * earlier failed run left behind turns the reading into tabs, one per trip.
 */
async function selectThisTrip(page: Page): Promise<void> {
  const semaforo = page.getByRole("region", { name: "Semáforo de viaje" });
  await expect(semaforo).toBeVisible();
  const tab = page.getByRole("tab", { name: TRIP_LABEL });
  if ((await page.getByRole("tablist", { name: "Viajes registrados" }).count()) > 0) {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  await expect(semaforo).toContainText(TRIP_LABEL);
}

/** Open a closed `<details>` by its summary; a no-op when already open. */
async function openDetails(page: Page, summary: string): Promise<void> {
  const details = page.locator("details", { has: page.getByText(summary, { exact: true }) });
  await expect(details).toBeVisible();
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await details.getByText(summary, { exact: true }).click();
  }
}

// ---------------------------------------------------------------------------
// Caretaker arrangement — the same real walk caretaker-temporal.spec.ts drives
// ---------------------------------------------------------------------------

/** Resolve whatever arrangement the page is showing, so a re-run starts clean. */
async function clearExistingGrant(page: Page): Promise<void> {
  await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
  for (const [trigger, confirm] of [
    ["Finalizar el cuidado ahora", "Confirmar la finalización"],
    ["Retirar la invitación", "Confirmar el retiro"],
  ] as const) {
    const button = page.getByRole("button", { name: trigger });
    if ((await button.count()) === 0) continue;
    await button.click();
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
    await expect(async () => {
      await page.goto(page.url(), { waitUntil: "domcontentloaded" });
      await expect(page.getByLabel(/correo/i)).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    return;
  }
}

async function designateCaretaker(page: Page): Promise<void> {
  await page.goto(`/mis-mascotas/${petToken}/cuidado`, { waitUntil: "domcontentloaded" });
  await clearExistingGrant(page);
  await page.getByLabel(/correo/i).fill(CARETAKER);
  await page.getByLabel(/^Desde/i).fill(todayInAr());
  await page.getByLabel(/^Hasta/i).fill(arDatePlus(7));
  await page.getByRole("button", { name: "Invitar como cuidador/a" }).click();
  await expect(page.getByText("Invitación enviada")).toBeVisible();
}

async function acceptInvitation(page: Page): Promise<void> {
  await page.goto("/notificaciones", { waitUntil: "domcontentloaded" });
  const invite = page.locator('a[href^="/cuidado/"]').first();
  await expect(invite, "the invitee's notification carries the /cuidado link").toBeVisible();
  await invite.click();
  await expect(page.getByRole("heading", { name: /Te invitaron a cuidar a/ })).toBeVisible();
  await page.getByRole("button", { name: "Aceptar el cuidado" }).click();
  await page.getByRole("button", { name: "Confirmar el cuidado" }).click();
  await expect(page.getByText(/Estás cuidando a/)).toBeVisible({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------

test.describe
  .serial("viaje del titular", () => {
    test("V1 — registrar un viaje, leer el semáforo, cargar un CVI y exportar el PDF", async ({
      page,
    }) => {
      test.setTimeout(120_000);

      await loginAs(page, TITULAR);
      petToken = await pickActivePetToken(page);
      await openViaje(page);

      // ---- record the trip ---------------------------------------------------
      await openDetails(page, "Destino, fecha y aerolínea");
      await page.getByLabel(/^Destino/).selectOption("chile");
      await page.getByLabel(/^Fecha de salida/).fill(arDisplay(TRIP_DATE));
      await page.getByLabel(/^Aerolínea/).selectOption("latam");
      await page.getByLabel(/^Dónde viaja la mascota/).selectOption("cabin");
      await page.getByRole("button", { name: "Registrar viaje" }).click();

      // ---- its semáforo ------------------------------------------------------
      // The OUTCOME, never the URL: the page reloads itself onto the new trip
      // (useActionRedirect), so the reading names it. This is the assertion
      // that caught the form hanging on "Registrando…" with the write already
      // landed — the Next 15.5 transition that never commits after a
      // same-route revalidatePath (lib/ui/full-page-action-nav.ts).
      const semaforo = page.getByRole("region", { name: "Semáforo de viaje" });
      await expect(semaforo).toContainText(TRIP_LABEL, { timeout: 30_000 });
      // The trip line names the airline and where the animal travels.
      await expect(semaforo).toContainText(`${TRIP_LABEL} · LATAM, en cabina`);
      // The reading is one of the four fixed labels, whichever this pet's
      // libreta earns — the label set is the contract, not this seed's state.
      const reading = (await semaforo.locator("output").innerText()).trim();
      expect(Object.values(TRAVEL_SEMAFORO_LABELS)).toContain(reading);
      // An airline is selected, so its section heads with the "Verificá"
      // notice: the airline's policy is never presented as certain.
      await expect(page.getByText(`${TRAVEL_AIRLINE_NOTICE}: LATAM`)).toBeVisible();
      // The never-certain rule, over the whole screen.
      await expect(page.locator("main")).not.toContainText(TRAVEL_FORBIDDEN_COPY);

      // ---- tick one required document ("Lo tengo", PO 2026-10-01) -----------
      // Chile's corridor lists required_documents: a WARNING (never a blocker
      // on its own) until the titular ticks "Lo tengo" for each one. Ticking is
      // a correction (confirm_trip_document) that reloads the page like every
      // other write here — fixed 2026-10-01 after this exact submit hung
      // forever on staging: TripDocumentsChecklist's sibling rows all bound the
      // IDENTICAL server action, which broke useActionState's own redirect; it
      // now calls the action directly and navigates with useActionNavigate,
      // like DenunciaWizard/ResetCodeStep (lib/ui/use-action-redirect.ts).
      const documentsList = page.getByRole("list", { name: "Documentos del viaje" });
      await expect(documentsList).toBeVisible();
      await expect(page.getByText("Confirmá que tenés cada documento")).toBeVisible();
      await documentsList.getByRole("button", { name: "Lo tengo" }).first().click();
      // The OUTCOME, not the URL: the ticked row flips to "Desmarcar" once the
      // reload lands. No untick needed afterwards — V3 cancels this run's own
      // trip regardless, taking every tick on it along.
      await expect(documentsList.getByRole("button", { name: "Desmarcar" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(documentsList.getByText("Lo tenés, según indicaste")).toBeVisible();

      // The trip's event id, for V2 (the caretaker opening it by URL) — the
      // cancel form carries it, and "Volver" leaves the trip untouched. Scoped
      // to the cancel form: since the sign-offs above, each ticked document's
      // own form ALSO carries a hidden tripEventId (TripDocumentsChecklist),
      // so the bare selector resolves to 4 inputs and trips strict mode.
      await page.getByRole("button", { name: "Cancelar este viaje" }).click();
      const cancelForm = page.locator("form", {
        has: page.getByRole("button", { name: "Confirmar cancelación" }),
      });
      tripEventId = await cancelForm.locator('input[name="tripEventId"]').inputValue();
      expect(tripEventId, "trip event id read from the cancel form").toMatch(/^[0-9a-f-]{36}$/i);
      await page.getByRole("button", { name: "Volver" }).click();
      await expect(page.getByRole("button", { name: "Cancelar este viaje" })).toBeVisible();

      // ---- record a CVI ------------------------------------------------------
      await openDetails(page, "Registrar un CVI");
      await page.getByLabel(/^Número de CVI/).fill(CVI_NUMBER);
      await page.getByLabel(/^Fecha de emisión/).fill(arDisplay(todayInAr()));
      await page.getByLabel(/^Válido hasta/).fill(arDisplay(arDatePlus(60)));
      await page.getByRole("button", { name: "Registrar CVI" }).click();
      // The page reloads with the CVI in its list.
      await expect(page.getByText(CVI_NUMBER)).toBeVisible({ timeout: 30_000 });

      // ---- export the PDF ----------------------------------------------------
      await selectThisTrip(page);
      await page.getByRole("button", { name: "Descargar documentación de viaje (PDF)" }).click();
      const pdfLink = page.getByRole("link", { name: "Abrir el PDF generado" });
      await expect(pdfLink, "the export answered with a signed URL, not an error line").toBeVisible(
        { timeout: 30_000 },
      );
      const pdfUrl = (await pdfLink.getAttribute("href")) ?? "";
      const pdf = await page.request.get(pdfUrl);
      expect(pdf.ok(), `the signed URL serves the file (${pdf.status()})`).toBe(true);
      expect((await pdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    });

    test("V2 — un cuidador no ve el viaje ni el CVI", async ({ page, browser }) => {
      test.setTimeout(120_000);
      expect(petToken && tripEventId, "V1 left a live trip to look for").toBeTruthy();

      await loginAs(page, TITULAR);
      await designateCaretaker(page);

      const caretakerContext = await browser.newContext();
      const caretakerPage = await caretakerContext.newPage();
      try {
        await loginAs(caretakerPage, CARETAKER);
        await acceptInvitation(caretakerPage);

        // ---- NOT REACHABLE: the travel row is grey, with the reason -----------
        // owner-pet-actions (2026-10-01): the panel below the credential shows
        // the row grey instead of hiding it; what must not exist is a link.
        await caretakerPage.goto(`/mis-mascotas/${petToken}`, {
          waitUntil: "domcontentloaded",
        });
        const panel = caretakerPage.locator('[data-section="pet-action-panel"]');
        // NON-VACUITY FIRST: the panel rendered, so the absence below is real.
        await expect(panel.getByRole("link", { name: /Chapa física/ })).toBeVisible({
          timeout: 20_000,
        });
        await expect(
          panel.getByRole("link", { name: "Viaje y movilidad", exact: true }),
        ).toHaveCount(0);
        await expect(
          panel.locator('[aria-disabled="true"]', { hasText: "Viaje y movilidad" }),
        ).toContainText("No disponible para cuidadores");

        // ---- NOT SHOWN: /viaje is the titular's, and says so ------------------
        await caretakerPage.goto(`/mis-mascotas/${petToken}/viaje`, {
          waitUntil: "domcontentloaded",
        });
        await expect(
          caretakerPage.getByText(/Registrar un viaje: solo la puede hacer el titular/),
        ).toBeVisible({ timeout: 20_000 });
        await expect(caretakerPage.getByText(TRIP_LABEL)).toHaveCount(0);
        await expect(caretakerPage.getByText(CVI_NUMBER)).toHaveCount(0);

        // ---- NOT REACHED: the trip's own record answers as a missing one -----
        await caretakerPage.goto(`/mis-mascotas/${petToken}/eventos/${tripEventId}`, {
          waitUntil: "domcontentloaded",
        });
        await expect(caretakerPage.getByTestId("branded-not-found")).toBeVisible({
          timeout: 20_000,
        });
        await expect(caretakerPage.getByText(TRIP_LABEL)).toHaveCount(0);

        // Control: the titular DOES reach the same record, so the refusal above
        // is the caretaker boundary, not a bad id.
        await page.goto(`/mis-mascotas/${petToken}/eventos/${tripEventId}`, {
          waitUntil: "domcontentloaded",
        });
        await expect(page.getByText("Movilidad registrada").first()).toBeVisible({
          timeout: 20_000,
        });
        await expect(page.getByTestId("branded-not-found")).toHaveCount(0);
      } finally {
        await caretakerContext.close();
        await page.goto(`/mis-mascotas/${petToken}/cuidado`, { waitUntil: "domcontentloaded" });
        await clearExistingGrant(page);
      }
    });

    test("V3 — cancelar el viaje lo saca de la pantalla", async ({ page }) => {
      test.setTimeout(90_000);
      expect(petToken, "V1 picked the pet").toBeTruthy();

      await loginAs(page, TITULAR);
      await openViaje(page);
      await selectThisTrip(page);

      await page.getByRole("button", { name: "Cancelar este viaje" }).click();
      // The question names the trip it is about to cancel.
      await expect(page.getByText(`¿Cancelar el viaje a ${TRIP_LABEL}?`)).toBeVisible();
      // Wait for the action's own answer (scoped to this page's path), so the
      // reads below cannot run before the correction is committed — a DOM in
      // mid-reload would show "no trip" for the wrong reason.
      const cancelled = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.request().headers()["next-action"] !== undefined &&
          new URL(r.url()).pathname === `/mis-mascotas/${petToken}/viaje`,
        { timeout: 30_000 },
      );
      await page.getByRole("button", { name: "Confirmar cancelación" }).click();
      await cancelled;

      // The OUTCOME: the trip is gone from the reading and from the tabs. The
      // CVI stays — it is a document the owner holds, not part of the trip.
      // Navigating ourselves may race the page's own reload, hence the retry.
      await expect(async () => {
        await openViaje(page);
        await expect(page.getByText(CVI_NUMBER)).toBeVisible({ timeout: 5_000 });
        await expect(page.getByText(TRIP_LABEL)).toHaveCount(0);
      }).toPass({ timeout: 30_000 });
    });
  });
