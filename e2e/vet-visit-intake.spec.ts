/**
 * Visit-scoped intake — the vet's atención on the walk-in surface
 * (vet-visit-record, 2026-09-29).
 *
 * One journey, one assertion that matters: what a vet records in ONE sitting
 * reads back as ONE "Atención" block. Walked end to end:
 *   1. the pet's history renders on the Atender page, above the capture grid;
 *   2. "Iniciar atención" a domicilio → "Atención en curso";
 *   3. "Estado al ingreso" (general condition, motivo, a vital, the weight);
 *   4. a vaccine in the same sitting;
 *   5. the history groups BOTH under one "Atención · … · A domicilio" block;
 *   6. "Terminar atención" closes it — so a re-run starts a new one.
 *
 * FIXTURE TIER — bootstrap only. The pet is intaken by the seed refugio in this
 * very run (orgadmin@dim.test, e2e/_shelter-custody.ts) and swept by name
 * before and after, so the spec never writes on an owner's animal and never
 * depends on a leftover visit. The signer is vet@dim.test, a MATRICULATED
 * member of the same refugio: only a validated matrícula records the intake.
 */

import { type Page, expect, test } from "@playwright/test";

import { SEED_ORG, intakeShelterPet } from "./_shelter-custody";
import { deletePetsByNamePrefix } from "./demo/_db-cleanup";
import { ACCOUNTS, loginAs, resolveOrgToken, submitAndWait } from "./demo/_helpers";

/** Swept before and after; distinct from the crisis seams' own intake prefix. */
const VISIT_PET_PREFIX = "E2EVisita-";
const PET_NAME = `${VISIT_PET_PREFIX}Toby`;

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

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await deletePetsByNamePrefix(VISIT_PET_PREFIX);
});
test.afterAll(async () => {
  await deletePetsByNamePrefix(VISIT_PET_PREFIX);
});

test("a vet's atención groups the intake and a vaccine into one visit", async ({ page }) => {
  test.setTimeout(240_000);

  // --- The refugio intakes a fresh animal (the fixture) ---------------------
  await loginAs(page, ACCOUNTS.orgAdmin);
  const orgToken = await resolveOrgToken(page, SEED_ORG);
  const petToken = await intakeShelterPet(page, orgToken, PET_NAME);

  // --- The vet opens the walk-in surface ------------------------------------
  await relogin(page, ACCOUNTS.vet);
  await openAtender(page, orgToken, petToken);

  // (1) History before recording: the card renders, above the capture grid.
  const history = page.getByRole("heading", { name: "Historia clínica" });
  const grid = page.getByRole("heading", { name: "¿Qué querés registrar?" });
  await expect(history).toBeVisible({ timeout: 20_000 });
  await expect(grid).toBeVisible();
  const [historyBox, gridBox] = await Promise.all([history.boundingBox(), grid.boundingBox()]);
  expect(historyBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(gridBox?.y ?? 0);

  // (2) Iniciar atención, a domicilio.
  await page.getByLabel("A domicilio").check();
  await page.getByRole("button", { name: "Iniciar atención" }).click();
  await expect(page.getByRole("heading", { name: "Atención en curso" })).toBeVisible({
    timeout: 20_000,
  });

  // (3) Estado al ingreso.
  await openAtender(page, orgToken, petToken, "ingreso");
  const intakeForm = page.locator("form#condition-at-intake-form");
  await expect(intakeForm).toBeVisible({ timeout: 20_000 });
  await intakeForm.getByLabel("Regular").check();
  await intakeForm.getByLabel("Motivo de consulta").fill("Control por tos leve");
  await intakeForm.getByLabel("Temperatura (°C)").fill("38,6");
  await intakeForm.getByLabel("Peso (kg)").fill("12,4");
  await submitAndWait(
    page,
    page.getByRole("button", { name: "Registrar estado al ingreso" }),
    (url) => url.searchParams.get("firmado") === "1",
    45_000,
  ).catch(() => {});

  // (4) A vaccine in the same sitting.
  await openAtender(page, orgToken, petToken, "vacuna");
  const vaccineInput = page.locator('input[name="vaccineName"]').first();
  await expect(vaccineInput).toBeVisible({ timeout: 20_000 });
  await vaccineInput.fill("Antirrábica");
  await page.locator('input[name="occurredAt"]').first().fill(todayArt());
  await submitAndWait(
    page,
    page.getByRole("button", { name: /registrar vacuna/i }).first(),
    (url) => url.searchParams.get("firmado") === "1",
    45_000,
  ).catch(() => {});

  // (5) One atención block holds both. Asserted on the OUTCOME, not on the
  // post-action URL (the N3 client navigation drops on occasion).
  await expect(async () => {
    await openAtender(page, orgToken, petToken);
    const block = page
      .locator('[data-section="walk-in-history"] section')
      .filter({ hasText: /A domicilio/ });
    await expect(block).toHaveCount(1, { timeout: 5_000 });
    await expect(block).toContainText("Estado general: Regular");
    await expect(block).toContainText("Antirrábica");
    await expect(block).toContainText("38,6 °C");
  }, "the intake and the vaccine read back as ONE atención a domicilio").toPass({
    timeout: 60_000,
  });

  // (6) Terminar atención.
  await page.getByRole("button", { name: "Terminar atención" }).click();
  await expect(page.getByRole("heading", { name: "Iniciar atención" })).toBeVisible({
    timeout: 20_000,
  });
});
