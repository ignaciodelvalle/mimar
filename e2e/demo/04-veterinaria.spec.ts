import { expect, test } from "@playwright/test";
import {
  ACCOUNTS,
  fullScroll,
  loginAs,
  resolveOrgToken,
  showScreen,
  visit,
  wizardStep,
} from "./_helpers";

// SEGMENT 04 — VETERINARIA / clinic org (alejo@dim.test → Clínica Veterinaria
// Recoleta, same /org portal with clinic-capability focus).
//
// Additive mutations on camera: create a NEW service offering + submit a
// weekday schedule rule. Bookings and pets in care are SHOW ONLY (never mark
// an appointment attended, never mutate curated pets).
test("segmento 04 — veterinaria", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  page.on("dialog", (d) => d.accept().catch(() => {}));

  await loginAs(page, ACCOUNTS.vetOrgAdmin);
  const orgToken = await resolveOrgToken(page, /recoleta/i);
  const root = `/org/${orgToken}`;

  // 1. Panel — FAIL LOUD: the portal shell (rail nav) must render.
  await visit(page, root);
  await expect(
    page.locator(`a[href="${root}/servicios"]:visible`).first(),
    "org portal rail nav (Servicios link)",
  ).toBeVisible();
  await fullScroll(page);

  // -------------------------------------------------------------------------
  // 2. SERVICIOS — list → nuevo (SUBMIT a real vet service) → detail → agenda
  // -------------------------------------------------------------------------
  await showScreen(page, `${root}/servicios`);

  // CREATE SERVICE — FAIL LOUD core beat. 3-step wizard (Tipo / Capacidad /
  // Elegibilidad); species eligibility defaults to dogs + cats.
  await visit(page, `${root}/servicios/nuevo`);
  await fullScroll(page);
  const step = wizardStep(page);

  // Step 1 — Tipo
  await page.locator("#serviceKind").selectOption("general_checkup");
  await page.locator("#displayName").fill("Consulta clínica general");
  await page
    .locator("#description")
    .fill(
      "Consulta veterinaria general: revisión clínica completa, control de peso y actualización del plan sanitario.",
    );
  await step.getByRole("button", { name: /^continuar$/i }).click();
  await page.waitForTimeout(400);

  // Step 2 — Capacidad: 20-minute consultations, one patient per slot.
  await page.locator("#durationMinutes").fill("20");
  await page.locator("#slotCapacity").fill("1");
  await page.locator("#priceArs").fill("12000");
  await step.getByRole("button", { name: /^continuar$/i }).click();
  await page.waitForTimeout(400);

  // Step 3 — Elegibilidad + submit. createServiceOfferingAction redirects to
  // the servicios list on success — fail loud if it doesn't.
  await fullScroll(page);
  await step.getByRole("button", { name: /crear servicio/i }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/servicios"), { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page);

  // Open the offering we just created (it lands in pending_approval — the
  // detail page shows the review state on camera). FAIL LOUD: it must be
  // in the list.
  const newOffering = page.getByRole("link", { name: /consulta clínica general/i }).first();
  await expect(newOffering, "newly created offering in the servicios list").toBeVisible();
  const newOfferingHref = (await newOffering.getAttribute("href")) ?? "";
  await newOffering.click();
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page);

  // Its agenda: schedule rules are gated on approval, so a pending offering's
  // /agenda redirects back to the detail page — still worth showing.
  if (newOfferingHref) {
    await showScreen(page, `${newOfferingHref}/agenda`);
  }

  // SCHEDULE RULE — submit a weekday rule (Mon–Fri is the form default) on the
  // first APPROVED offering, since the just-created one is pending authority
  // approval and the app blocks its agenda until then. Adding a rule is
  // additive (it only materializes more open slots).
  await visit(page, `${root}/servicios`);
  const approvedHrefs: string[] = await page
    .locator(`li:has-text("Aprobado") a[href^="${root}/servicios/"]`)
    .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? "").filter(Boolean));
  for (const href of approvedHrefs.slice(0, 5)) {
    await visit(page, `${href}/agenda`);
    if (!(await page.locator("#startTimeLocal").count())) continue; // redirected → not approved
    await fullScroll(page);
    await page.locator("#startTimeLocal").fill("09:30");
    await page.locator("#endTimeLocal").fill("12:30");
    await page.getByRole("button", { name: /agregar regla/i }).click();
    // The page revalidates in place; the new rule shows up in the table.
    await page
      .getByText("09:30 – 12:30")
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    await fullScroll(page);
    break;
  }

  // -------------------------------------------------------------------------
  // 3. AGENDA — bookings dashboard + one appointment (NEVER mark attended)
  // -------------------------------------------------------------------------
  await showScreen(page, `${root}/agenda`);
  const turno = page.locator(`a[href*="/agenda/turnos/"]`).first();
  if (await turno.count()) {
    await turno.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page);
  }

  // -------------------------------------------------------------------------
  // 4. MASCOTAS IN CARE — list + one detail (show only)
  // -------------------------------------------------------------------------
  await showScreen(page, `${root}/mascotas`);
  const patient = page.locator(`a[href^="${root}/mascotas/"]`).first();
  if (await patient.count()) {
    await patient.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page);
  }

  // -------------------------------------------------------------------------
  // 5. CLINIC ADMIN — show only
  // -------------------------------------------------------------------------
  await showScreen(page, `${root}/miembros`);
  await showScreen(page, `${root}/configuracion`);
  await showScreen(page, `${root}/cobertura`);
});
