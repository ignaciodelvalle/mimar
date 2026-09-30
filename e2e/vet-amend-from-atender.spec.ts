/**
 * A vet corrects her own vaccine from Atender (portal-vet-p0).
 *
 * The journey the correction path exists for, end to end:
 *   1. the owner registers a fresh animal (the fixture — swept by name);
 *   2. vet@dim.test, a MATRICULATED member of the seed refugio, signs a vaccine
 *      on it from the walk-in surface;
 *   3. she opens "Corregir" on that row of the history, fixes the lote with a
 *      reason (mandatory on this door) and confirms;
 *   4. the owner is TOLD — a `professional_event_amended` notice that names
 *      the organization, never the vet — and the record reads as corrected,
 *      with the original still in the history.
 *
 * Outcomes are asserted, not post-action URLs (e2e/README.md: the client
 * navigation after a server action drops on occasion). The fixture pet is the
 * owner's own new animal, so the spec writes on nobody else's record, and it is
 * swept before and after (local database only, like every cleanup here).
 */

import { type Page, expect, test } from "@playwright/test";

import { speciesLabel } from "../lib/utils/species";
import { SEED_ORG } from "./_shelter-custody";
import { deletePetsByNamePrefix } from "./demo/_db-cleanup";
import { ACCOUNTS, loginAs, resolveOrgToken, submitAndWait } from "./demo/_helpers";

const PET_PREFIX = "E2EAmend-";
const PET_NAME = `${PET_PREFIX}Luna`;
const LOTE_SIGNED = "LOTE-E2E-1";
const LOTE_FIXED = "LOTE-E2E-2";

/** ART-local date — the server refuses future dates in Argentine time (e2e/README.md). */
function todayArt(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(
    new Date(),
  );
}

async function relogin(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await loginAs(page, email);
}

async function openAtender(page: Page, orgToken: string, petToken: string, evento?: string) {
  const qs = evento ? `?evento=${evento}` : "";
  await page.goto(`/org/${orgToken}/atender/${petToken}${qs}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.getByText(/application error/i)).not.toBeVisible();
}

/** The owner registers a new animal and the spec reads its token from the credential screen. */
async function registerOwnerPet(page: Page): Promise<string> {
  await page.goto("/mis-mascotas/nueva");
  await page.getByLabel(/^nombre/i).fill(PET_NAME);
  await page.getByRole("button", { name: speciesLabel("dog"), exact: true }).click();
  await page.getByRole("radio", { name: /hembra/i }).check();
  await page.getByLabel(/provincia/i).selectOption("AR-C");
  const locality = page.getByLabel(/ciudad, pueblo o barrio/i);
  await expect(locality).toBeEnabled();
  await locality.fill("Palermo");
  await expect(page.getByRole("option", { name: /Palermo/i }).first()).toBeVisible({
    timeout: 15_000,
  });
  await locality.press("Enter");
  await expect(page.locator('input[name="localityName"]')).toHaveValue(/.+/);
  await page.getByRole("button", { name: /continuar/i }).click();
  await expect(page.getByText(/tomar o elegir una foto/i)).toBeVisible();
  // Not awaited: the harness's promise never settles on the N3 client push
  // (see create-pet.spec.ts). The navigation below is the assertion.
  void page
    .getByRole("button", { name: /registrar mascota/i })
    .click()
    .catch(() => {});
  await page.waitForURL(/\/mis-mascotas\/nueva\/DIM-[A-Z0-9]{4}-[A-Z0-9]{4}\/credencial/i, {
    timeout: 45_000,
  });
  const token = page.url().match(/DIM-[A-Z0-9]{4}-[A-Z0-9]{4}/i)?.[0] ?? "";
  expect(token, "pet token read from the credential screen").toBeTruthy();
  return token.toUpperCase();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await deletePetsByNamePrefix(PET_PREFIX);
});
test.afterAll(async () => {
  await deletePetsByNamePrefix(PET_PREFIX);
});

test("vet corrects her own vaccine from Atender; the owner is told", async ({ page }) => {
  test.setTimeout(300_000);

  // (1) The fixture: the owner's own new animal.
  await loginAs(page, ACCOUNTS.owner);
  const petToken = await registerOwnerPet(page);

  // (2) The vet signs a vaccine from Atender.
  await relogin(page, ACCOUNTS.vet);
  const orgToken = await resolveOrgToken(page, SEED_ORG);
  await openAtender(page, orgToken, petToken, "vacuna");
  const vaccineInput = page.locator('input[name="vaccineName"]').first();
  await expect(vaccineInput).toBeVisible({ timeout: 20_000 });
  await vaccineInput.fill("Antirrábica");
  await page.locator('input[name="batch"]').first().fill(LOTE_SIGNED);
  await page.locator('input[name="occurredAt"]').first().fill(todayArt());
  await submitAndWait(
    page,
    page.getByRole("button", { name: /registrar vacuna/i }).first(),
    (url) => url.searchParams.get("firmado") === "1",
    45_000,
  ).catch(() => {});

  // (3) "Corregir" on that row — offered because this clinic signed it.
  const row = page.locator("[data-amendable-row]").filter({ hasText: /Antirrábica/ });
  await expect(async () => {
    await openAtender(page, orgToken, petToken);
    await expect(row).toHaveCount(1, { timeout: 5_000 });
  }, "the signed vaccine is offered for correction").toPass({ timeout: 60_000 });

  await row.getByRole("button", { name: "Corregir este registro" }).click();
  const form = page.getByRole("dialog", { name: "Corregir registro" });
  await expect(form).toBeVisible();
  await form.getByLabel("Nuevo valor para Batch").fill(LOTE_FIXED);
  await form.getByPlaceholder(/Describí brevemente/).fill("Lote mal transcripto de la caja");
  await form.getByRole("button", { name: "Confirmar corrección" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirmar corrección" });
  await confirm.getByRole("button", { name: "Confirmar corrección" }).click();

  // The receipt, when the client navigation lands; the outcome below is the
  // assertion that must hold either way.
  const receipt = page.getByText(
    "Corrección registrada. El registro original queda en el historial.",
  );
  await receipt.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});

  // (4) The owner: a notice naming the organization, and the corrected record.
  await relogin(page, ACCOUNTS.owner);
  const title = `Se corrigió un registro de ${PET_NAME}`;
  let recordHref = "";
  await expect(async () => {
    await page.goto("/notificaciones", { waitUntil: "domcontentloaded" });
    const card = page.locator("article, li").filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card).toContainText("Motivo: Lote mal transcripto de la caja");
    const link = card.getByRole("link", { name: /Ver el registro/ }).first();
    recordHref = (await link.getAttribute("href")) ?? "";
    expect(recordHref).toMatch(new RegExp(`/mis-mascotas/${petToken}/eventos/`));
  }, "the owner is told about the correction").toPass({ timeout: 60_000 });

  await page.goto(recordHref, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/Corregido el/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(LOTE_FIXED).first()).toBeVisible();
  await expect(page.getByText(/Fue corregido por un profesional/)).toBeVisible();
  // The owner is not offered a correction she cannot make.
  await expect(page.getByRole("button", { name: "Corregir este registro" })).toHaveCount(0);
});
