import { type Page, expect, test } from "@playwright/test";

import {
  TRAVEL_AIRLINE_NOTICE,
  TRAVEL_FORBIDDEN_COPY,
  TRAVEL_SEMAFORO_LABELS,
} from "@/lib/domain/travel-copy";

import { ACCOUNTS, loginAs } from "./demo/_helpers";

/**
 * Viajes (viajes-fase-2, task 8.1; v14 "Viaje en pasos") — the owner's travel
 * flow in a browser.
 *
 *   V1  plan a trip through the chained form (destination → mode → airline →
 *       modality → date, with the destination's deadlines beside it) → read its
 *       pase and semáforo → tick a paper in "Para llevar" → record the paper in
 *       "Papeles" → export the PDF.
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
/** travelTripLabel's shape: "Chile, 12/11/2026" (the switcher and the cancel question). */
const TRIP_LABEL = `Chile, ${arDisplay(TRIP_DATE)}`;
/** The pase's second line ends with the day, the airline and where it flies. */
const TRIP_META = `${arDisplay(TRIP_DATE)} · LATAM, en cabina`;

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

/** Open /viaje (with an optional query) and wait for the page itself, not just the shell. */
async function openViaje(page: Page, query = ""): Promise<void> {
  await page.goto(`/mis-mascotas/${petToken}/viaje${query}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /^Viaje de / })).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * Show THIS run's trip. The page reads the next trip by default; a trip an
 * earlier failed run left behind would be read instead, so ask for ours.
 */
async function selectThisTrip(page: Page, query = ""): Promise<void> {
  await openViaje(page, `?viaje=${encodeURIComponent(tripEventId)}${query}`);
  await expect(page.getByRole("region", { name: "Semáforo de viaje" })).toContainText(TRIP_META);
}

/** Open a module (a native `<details>`) by its id; a no-op when already open. */
async function openModule(page: Page, id: string): Promise<void> {
  const details = page.locator(`details#${id}`);
  await expect(details).toBeAttached();
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await details.locator("summary").first().click();
  }
  await expect(details).toHaveAttribute("open", "");
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
  // The success route, not text: "Invitación enviada" alone also matches the
  // pending callout /cuidado shows (see caretaker-temporal.spec.ts).
  await expect(page).toHaveURL(/\/cuidado\/invitacion-enviada$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Invitación enviada" })).toBeVisible();
}

async function acceptInvitation(page: Page): Promise<void> {
  // The card's CTA goes through `/notificaciones/{id}/abrir`, which redirects
  // to wherever the reader may go at click time: assert where it LANDS.
  await page.goto("/notificaciones", { waitUntil: "domcontentloaded" });
  const card = page
    .locator("article")
    .filter({ hasText: /te propone cuidar a/ })
    .first();
  await expect(card, "the invitee's notification is in their inbox").toBeVisible();
  await card.getByRole("link", { name: "Ver invitación" }).click();
  await page.waitForURL(/\/cuidado\/[^/?#]+$/);
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

      // ---- plan the trip: the chained form ------------------------------------
      // With no trip on, the form is open ("Planear un viaje"); with one an
      // earlier run left, it is folded at the end ("Planear otro viaje").
      await openModule(page, "nuevo-viaje");
      const form = page.locator("details#nuevo-viaje");
      await form.getByLabel(/^Destino/).selectOption("chile");
      // The destination decides the ways of going: Chile is by air or by land,
      // never by sea.
      const mode = form.getByLabel(/^Cómo viajan/);
      await expect(mode.locator("option")).toHaveText([
        "Todavía no sé",
        "En avión",
        "En auto o en micro",
      ]);
      await mode.selectOption("air");
      // Chile's airlines come first; every other one stays reachable.
      const airline = form.getByLabel(/^Aerolínea/);
      await expect(airline.locator('optgroup[label="Vuelan a Chile"] option')).toHaveCount(4);
      await airline.selectOption("latam");
      // The airline decides cabin, hold or cargo, with the weight it publishes.
      const modality = form.getByLabel(/^Dónde viaja la mascota/);
      await expect(modality.locator("option")).toHaveCount(3);
      await modality.selectOption("cabin");
      await form.getByLabel(/^Fecha de salida/).fill(arDisplay(TRIP_DATE));
      // The destination's deadlines, worded by the server, beside the date.
      await expect(
        form.getByText("La antirrábica tiene que tener al menos 21 días el día del viaje."),
      ).toBeVisible();
      await form.getByRole("button", { name: "Crear viaje" }).click();

      // ---- its pase and semáforo ---------------------------------------------
      // The OUTCOME, never the URL: the page reloads itself onto the new trip
      // (useActionRedirect). This is the assertion that caught the form
      // hanging on "Registrando…" with the write already landed — the Next 15.5
      // transition that never commits after a same-route revalidatePath
      // (lib/ui/full-page-action-nav.ts).
      const semaforo = page.getByRole("region", { name: "Semáforo de viaje" });
      await expect(semaforo).toContainText(TRIP_META, { timeout: 30_000 });
      await expect(semaforo).toContainText("Chile");
      await expect(semaforo).toContainText(/faltan \d+ días/);
      // The reading is one of the four fixed labels, whichever this pet's
      // libreta earns — the label set is the contract, not this seed's state.
      const reading = (await semaforo.locator("output").innerText()).trim();
      expect(Object.values(TRAVEL_SEMAFORO_LABELS)).toContain(reading);
      // The trip names an airline, so the "Verificá" notice rides with it:
      // the airline's policy is never presented as certain.
      await expect(page.getByText(`${TRAVEL_AIRLINE_NOTICE}: LATAM`)).toBeVisible();
      // The never-certain rule, over the whole screen.
      await expect(page.locator("main")).not.toContainText(TRAVEL_FORBIDDEN_COPY);
      // The three quick actions are on the first screen.
      const quick = page.getByRole("complementary", { name: "Acciones del viaje" });
      await expect(quick.getByRole("button", { name: "Exportar PDF" })).toBeVisible();
      await expect(quick.getByRole("link", { name: "Cargar el CZI" })).toBeVisible();
      await expect(quick.getByRole("button", { name: "Mandar a mi veterinaria" })).toBeVisible();

      // The trip's event id, for V2 (the caretaker opening it by URL) — the
      // cancel form carries it, and "Volver" leaves the trip untouched.
      await page.getByRole("button", { name: "Cancelar este viaje" }).click();
      const cancelForm = page.locator("form", {
        has: page.getByRole("button", { name: "Confirmar cancelación" }),
      });
      tripEventId = await cancelForm.locator('input[name="tripEventId"]').inputValue();
      expect(tripEventId, "trip event id read from the cancel form").toMatch(/^[0-9a-f-]{36}$/i);
      await page.getByRole("button", { name: "Volver" }).click();
      await expect(page.getByRole("button", { name: "Cancelar este viaje" })).toBeVisible();

      // ---- tick a paper in "Para llevar" (PO 2026-10-01) ---------------------
      // Chile's papers are a WARNING until the titular says they have each one.
      // A checkbox now (v14), the same confirm_trip_document command; the page
      // reloads like every other write here. Only PAPERS are listed: the
      // microchip and the antiparasitario are the libreta's to answer.
      await openModule(page, "para-llevar");
      const documentsList = page.getByRole("list", { name: "Documentos del viaje" });
      const firstPaper = documentsList.getByRole("checkbox").first();
      await expect(firstPaper).not.toBeChecked();
      await expect(documentsList).not.toContainText(/microchip|antiparasitario/i);
      await firstPaper.check();
      // The OUTCOME, not the URL: once the reload lands the box reads ticked
      // and says whose word it is. No untick needed afterwards — V3 cancels
      // this run's own trip regardless, taking every tick on it along.
      // The module's own tally is the server's word: it moves only once the
      // reload lands (the box itself flips at once, optimistically).
      await expect(page.locator("details#para-llevar > summary")).toContainText(/1 de \d+/, {
        timeout: 30_000,
      });
      await openModule(page, "para-llevar");
      await expect(documentsList.getByRole("checkbox").first()).toBeChecked();
      await expect(documentsList.getByText("Lo tenés, según indicaste")).toBeVisible();

      // ---- record the paper in "Papeles" -------------------------------------
      await selectThisTrip(page, "&abrir=papeles");
      const papers = page.locator("details#papeles");
      await expect(papers).toContainText(
        "Chile pide: Certificado Zoosanitario de Importación (CZI)",
      );
      await papers.getByLabel(/^Número de CVI/).fill(CVI_NUMBER);
      await papers.getByLabel(/^Fecha de emisión/).fill(arDisplay(todayInAr()));
      await papers.getByLabel(/^Válido hasta/).fill(arDisplay(arDatePlus(60)));
      await papers.getByRole("button", { name: "Registrar CVI" }).click();
      // The page reloads with the certificate in its list.
      await expect(async () => {
        await selectThisTrip(page, "&abrir=papeles");
        await expect(
          page.getByRole("list", { name: "Certificados registrados" }).getByText(CVI_NUMBER),
        ).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 30_000 });

      // ---- export the PDF ----------------------------------------------------
      await page.getByRole("button", { name: "Exportar PDF" }).click();
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
        await expect(caretakerPage.getByText(TRIP_META)).toHaveCount(0);
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
      await selectThisTrip(page);

      // v14: cancelling is the last thing on the screen, as a link-styled
      // control, with the same two-step confirmation.
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

      // The OUTCOME: the trip is gone from the reading and from the trip list.
      // The CVI stays — it is a document the owner holds, not part of the trip.
      // Navigating ourselves may race the page's own reload, hence the retry.
      await expect(async () => {
        await openViaje(page, "?abrir=papeles");
        await expect(
          page.getByRole("list", { name: "Certificados registrados" }).getByText(CVI_NUMBER),
        ).toBeVisible({ timeout: 5_000 });
        await expect(page.getByText(TRIP_LABEL)).toHaveCount(0);
        await expect(page.getByText(TRIP_META)).toHaveCount(0);
      }).toPass({ timeout: 30_000 });
    });
  });
