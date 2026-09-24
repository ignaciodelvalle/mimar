import { expect, test } from "@playwright/test";
import { SIGN_IN_PATH } from "../_sign-in-route";
import { fullScroll, showScreen, visit, walkDenunciaWizard } from "./_helpers";

// SEGMENT 01 — PÚBLICO (unauthenticated). Real clicks + real form input.
test("segmento 01 — publico", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  // The denuncia wizard registers a beforeunload guard once it has dirty data;
  // accept it so post-submit navigations aren't cancelled by auto-dismiss.
  page.on("dialog", (d) => d.accept().catch(() => {}));

  // 1. Landing
  await showScreen(page, "/");

  // 2. Adoptar: use the filter form (visible typing), then click a real pet card
  await visit(page, "/adoptar");
  await page
    .locator('input[name="q"]')
    .fill("a")
    .catch(() => {});
  await page
    .locator('select[name="species"]')
    .selectOption({ index: 1 })
    .catch(() => {});
  await page.waitForTimeout(500);
  await page
    .getByRole("button", { name: /aplicar filtros/i })
    .click()
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page);
  const petCard = page.locator('a[href^="/adoptar/DIM"]').first();
  if (await petCard.count()) {
    await petCard.click();
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page); // ficha: historia, salud, refugio, CTA "iniciá sesión para postular"
  }

  // 3. Lost-pets board
  await showScreen(page, "/perdidas");

  // 4. Shelters directory → click a real shelter card → public profile
  await visit(page, "/refugios");
  await fullScroll(page);
  const orgCard = page.locator('a[href^="/refugios/DIM"], a[href^="/refugios/"]').first();
  if (await orgCard.count()) {
    await orgCard.click();
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page);
  }

  // 5. DENUNCIA — full multi-step wizard, end to end, to the comprobante.
  // Shared fail-loud driver: a frozen wizard must break the recording.
  await showScreen(page, "/denuncias");
  const denCode = await walkDenunciaWizard(page);

  // 6. Buscar denuncia por código (the code returned by the wizard driver)
  await visit(page, "/denuncias/buscar");
  if (denCode) {
    const codeInput = page.locator('input[type="text"], input[type="search"]').first();
    await codeInput.fill(denCode).catch(() => {});
    await page.waitForTimeout(400);
    await page
      .getByRole("button", { name: /buscar|consultar|ver/i })
      .first()
      .click()
      .catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page);
  }

  // 7. Static / legal / feedback
  for (const p of [
    "/acerca",
    "/ayuda",
    "/accesibilidad",
    "/privacidad",
    "/terminos",
    "/cookies",
    "/sugerencias",
  ]) {
    await showScreen(page, p);
  }

  // 8. Auth screens (no submit)
  await visit(page, SIGN_IN_PATH);
  await visit(page, "/registro");
  await visit(page, "/recuperar");

  await expect(page.locator("body")).toBeVisible();
});
