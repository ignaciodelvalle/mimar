import { expect, test } from "@playwright/test";
import {
  ACCOUNTS,
  DEMO_PHOTOS,
  fullScroll,
  loginAs,
  pickCard,
  pickLocality,
  resolveOrgToken,
  showScreen,
  visit,
  wizardStep,
} from "./_helpers";

// SEGMENT 03 — REFUGIO / shelter org (orgadmin@dim.test → /org/[orgToken]).
// Rail (nav diet 2026-07-24): Panel · Ingresos · Custodia · Postulaciones ·
// Casos · Equipo · Administración (collapsible, collapsed by default). This
// journey navigates by URL, so the collapsed group does not block any beat;
// the numbered segments below keep the original journey order.
//
// NON-DESTRUCTIVE on curated story data: lost/found/deceased, org→org
// transfers of existing pets, adoption finalize, foster-fin, devolver-al-dueno
// and microchip replacement are SHOWN (navigate + full scroll) but NEVER
// submitted. Additive mutations happen only on the animal we intake here.
test("segmento 03 — refugio", async ({ page }) => {
  // 25m (up from 18m): the operator surfaces got heavier this week — the org
  // console pages now render more projections/tiles, so each networkidle beat
  // costs more and the journey COMPLETES right at the old 18m budget (perf
  // audit 2026-07-09). The extra headroom reflects the heavier surface, not a
  // regression. Owner (02) stays at 18m — it drives fewer operator pages.
  test.setTimeout(25 * 60_000);
  page.on("dialog", (d) => d.accept().catch(() => {}));

  await loginAs(page, ACCOUNTS.orgAdmin);
  const orgToken = await resolveOrgToken(page, /refugio/i);
  const root = `/org/${orgToken}`;

  // -------------------------------------------------------------------------
  // 1. OPERACIÓN
  // -------------------------------------------------------------------------

  // Panel — FAIL LOUD: the portal shell (rail nav) must render.
  await visit(page, root);
  await expect(
    page.locator(`a[href="${root}/intake"]:visible`).first(),
    "org portal rail nav (Ingresos link)",
  ).toBeVisible();
  await fullScroll(page);

  // Agenda dashboard + one appointment detail if present (show only — never
  // mark attendance).
  await showScreen(page, `${root}/agenda`);
  const turno = page.locator(`a[href*="/agenda/turnos/"]`).first();
  if (await turno.count()) {
    await turno.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page);
  }

  // INTAKE — FAIL LOUD core beat. Queue tab first, then the 4-step wizard.
  // Note: the current IntakeForm has no photo field (photos are not part of
  // createIntakeAction yet), so the intake submits data-only.
  await showScreen(page, `${root}/intake`);
  await visit(page, `${root}/intake?tab=registrar`);
  await fullScroll(page);
  const step = wizardStep(page);

  // Step 1 — Identificación: no chip on a street rescue.
  await step.getByRole("button", { name: /continuar sin chip/i }).click();
  await page.waitForTimeout(400);

  // Step 2 — Identidad
  await step.getByLabel(/nombre o alias/i).fill("Morena");
  await step.getByLabel(/especie/i).selectOption("dog");
  await page.locator('label:has(input[name="sex"][value="female"])').click();
  await step.getByLabel(/años/i).fill("2");
  await step.getByLabel(/meses/i).fill("6");
  // Exact match — a loose /raza/i regex also matches the "Peso estimado (kg)"
  // field, whose helper text ("razas potencialmente peligrosas") contains
  // "raza" as a substring, causing a strict-mode violation (2 elements).
  // Catalog select since QA A4 (was free text "Mestiza"): the server rejects
  // off-catalog breeds, and "mestiza" resolves to the "Mixto / Cruza" option.
  await step.getByLabel("Raza", { exact: true }).selectOption("Mixto / Cruza");
  await step.getByLabel(/color/i).fill("Negra con pecho blanco");
  await step
    .getByLabel(/señas particulares/i)
    .fill("Mancha blanca en el pecho, oreja izquierda caída, cicatriz corta en la pata trasera.");
  await fullScroll(page);
  await step.getByRole("button", { name: /^continuar$/i }).click();
  await page.waitForTimeout(400);

  // Step 3 — Estado del ingreso (custody role defaults to shelter_custody).
  await pickCard(page, "intakeReason", "rescue");
  await step
    .getByLabel(/condición al ingreso/i)
    .fill("Delgada pero estable. Leve dermatitis en el lomo, sin heridas abiertas.");
  await step.getByLabel(/jurisdicción/i).fill("Recoleta, CABA");
  await fullScroll(page);
  await step.getByRole("button", { name: /^continuar$/i }).click();
  await page.waitForTimeout(400);

  // Step 4 — Confirmar → Crear ingreso. FAIL LOUD on the success screen.
  await fullScroll(page);
  await step.getByRole("button", { name: /crear ingreso/i }).click();
  await expect(
    page.getByText(/mascota ingresada/i),
    "intake success screen (Mascota ingresada)",
  ).toBeVisible({ timeout: 30_000 });
  await fullScroll(page);

  // The success screen links carry the new pet's publicToken — parse it so the
  // Animales section can list THIS pet for adoption (never a curated one).
  const adoptHref = await page
    .getByRole("link", { name: /publicar adopción/i })
    .getAttribute("href");
  const petToken = adoptHref?.match(/\/mascotas\/([^/]+)\/adoptar/)?.[1];
  expect(petToken, "intaked pet publicToken parsed from success screen").toBeTruthy();

  // Rest of Operación
  await showScreen(page, `${root}/censo`);
  await showScreen(page, `${root}/transitos`);
  await showScreen(page, `${root}/voluntarios`);
  await showScreen(page, `${root}/voluntarios/propuestas`);

  // -------------------------------------------------------------------------
  // 2. ANIMALES
  // -------------------------------------------------------------------------
  await showScreen(page, `${root}/mascotas`);
  await showScreen(page, `${root}/mascotas/${petToken}`); // the intaked pet's ficha

  // ADOPTION LISTING of the pet we just intaked — content save + publish.
  await visit(page, `${root}/mascotas/${petToken}/adoptar`);
  await fullScroll(page);
  await page
    .locator("#story")
    .fill(
      "Morena llegó al refugio después de un rescate en la vía pública en Recoleta. " +
        "Es una perra tranquila y muy cariñosa: en pocos días ya saludaba a todo el " +
        "equipo con la cola. Convive bien con otros perros y busca una familia paciente " +
        "que le dé el hogar definitivo que nunca tuvo.",
    )
    .catch(() => {});
  await page
    .locator("#requirements")
    .fill("Mayores de 18 años, entrevista previa y compromiso de castración.")
    .catch(() => {});
  await page
    .locator("#age")
    .selectOption({ index: 1 })
    .catch(() => {});
  await page
    .locator("#size")
    .selectOption({ index: 1 })
    .catch(() => {});
  await page
    .locator("#energy")
    .selectOption({ index: 1 })
    .catch(() => {});
  // Convivencia tri-states — mark every row "Sí" (friendly, plausible profile).
  for (const btn of await page.getByRole("button", { name: "Sí", exact: true }).all()) {
    await btn.click().catch(() => {});
  }
  await page
    .locator("#fee")
    .fill("15000")
    .catch(() => {});
  await fullScroll(page);
  await page
    .getByRole("button", { name: /guardar y continuar/i })
    .click()
    .catch(() => {});
  await page.waitForTimeout(1_500);
  await fullScroll(page);
  await page
    .getByRole("button", { name: /publicar adopción/i })
    .click()
    .catch(() => {});
  await page.waitForTimeout(1_500);
  await fullScroll(page);

  // SHOW-ONLY screens on the intaked pet — navigate + scroll, NEVER submit
  // (adoption finalize, foster, transfers, chip replacement and owner-return
  // are forbidden mutations on story data).
  await showScreen(page, `${root}/mascotas/${petToken}/adoption`);
  await showScreen(page, `${root}/mascotas/${petToken}/foster`);
  await showScreen(page, `${root}/mascotas/${petToken}/foster-fin`);
  await showScreen(page, `${root}/mascotas/${petToken}/transfer`);
  await showScreen(page, `${root}/mascotas/${petToken}/microchip/reemplazar`);
  await showScreen(page, `${root}/mascotas/${petToken}/devolver-al-dueno`);
  await showScreen(page, `${root}/pets/no-aptas`);
  await showScreen(page, `${root}/transferencias`);
  await showScreen(page, `${root}/transferencias/nueva`); // form shown, not submitted
  await showScreen(page, `${root}/transferencias/recibidas`);

  // -------------------------------------------------------------------------
  // 3. ADOPCIONES — queue + one application review page (NEVER approve/reject)
  // -------------------------------------------------------------------------
  await showScreen(page, `${root}/adopciones`);
  const application = page.locator(`a[href^="${root}/adopciones/"]`).first();
  if (await application.count()) {
    await application.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page);
  }
  await showScreen(page, `${root}/checkins`);

  // -------------------------------------------------------------------------
  // 4. CASOS
  // -------------------------------------------------------------------------
  await showScreen(page, `${root}/casos`);
  await showScreen(page, `${root}/maltrato/recibidos`);

  // MALTRATO — the org professional channel creates a NEW case on submit
  // (allowed). Requires ≥100-char description + ≥1 evidence file.
  await visit(page, `${root}/maltrato/nuevo`);
  await fullScroll(page);
  await page
    .locator('select[name="kind"]')
    .selectOption("neglect")
    .catch(() => {});
  await page
    .locator('select[name="severity"]')
    .selectOption("high")
    .catch(() => {});
  await page
    .locator('textarea[name="description"]')
    .fill(
      "Durante una recorrida del equipo de rescate encontramos tres perros encerrados en " +
        "una obra abandonada, sin agua ni comida, con signos de desnutrición avanzada y " +
        "sin ningún tipo de refugio contra el frío. El acceso está cerrado con candado y " +
        "los vecinos indican que nadie los atiende desde hace semanas.",
    )
    .catch(() => {});
  await page
    .locator('textarea[name="subjectDescription"]')
    .fill(
      "Tres perros mestizos adultos, dos marrones y uno negro, muy delgados y con el pelaje deteriorado.",
    )
    .catch(() => {});
  await page
    .locator('textarea[name="observedSymptoms"]')
    .fill("Desnutrición visible, apatía y heridas superficiales en las patas.")
    .catch(() => {});
  await page
    .locator('input[name="locationAddress"]')
    .fill("Obra en Av. Pueyrredón 2400, Recoleta, CABA")
    .catch(() => {});
  await page
    .locator('input[name="occurredAt"]')
    .fill(new Date().toISOString().split("T")[0])
    .catch(() => {});
  await page
    .locator('input[type="file"]')
    .setInputFiles(DEMO_PHOTOS[2])
    .catch(() => {});
  await page.waitForTimeout(800);
  await fullScroll(page);
  await page
    .getByRole("button", { name: /enviar denuncia/i })
    .click()
    .catch(() => {});
  // createOrgWelfareReportAction redirects on success.
  await page
    .waitForURL((url) => !url.pathname.endsWith("/maltrato/nuevo"), { timeout: 30_000 })
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page);

  // MORDEDURA — submission creates a NEW bite case (allowed). It targets the
  // pet we intaked above — never a curated story pet — because the report also
  // starts a 10-day rabies observation on the animal.
  await visit(page, `${root}/mordedura/nuevo`);
  await fullScroll(page);
  const biteStep = wizardStep(page);
  await page
    .getByPlaceholder("DIM-XXXX-XXXX")
    .fill(petToken ?? "")
    .catch(() => {});
  await biteStep
    .getByRole("button", { name: /^continuar$/i })
    .click()
    .catch(() => {});
  await page.waitForTimeout(400);
  // Step 2 — occurredAt defaults to today.
  await biteStep
    .getByRole("button", { name: /^continuar$/i })
    .click()
    .catch(() => {});
  await page.waitForTimeout(400);
  // Step 3 — víctima + contexto + jurisdicción (booking data lives in Recoleta).
  await biteStep
    .getByLabel(/^lugar$/i)
    .fill("Plaza Vicente López, Recoleta")
    .catch(() => {});
  await pickLocality(page, "#bite-locality-input", "Recoleta").catch(() => {});
  await biteStep
    .getByLabel(/^nombre$/i)
    .fill("Marcos Gutiérrez")
    .catch(() => {});
  await biteStep
    .getByLabel(/teléfono/i)
    .fill("+54 11 5555-2233")
    .catch(() => {});
  await biteStep
    .getByLabel(/edad aproximada/i)
    .fill("adulto")
    .catch(() => {});
  await biteStep
    .getByLabel(/severidad/i)
    .selectOption("minor")
    .catch(() => {});
  await biteStep
    .getByLabel(/resumen clínico/i)
    .fill("Rasguño superficial en la mano derecha, sin sangrado activo.")
    .catch(() => {});
  await biteStep
    .getByLabel(/contexto adicional/i)
    .fill("La perra se asustó durante un paseo de socialización en la plaza; estaba con correa.")
    .catch(() => {});
  await fullScroll(page);
  await biteStep
    .getByRole("button", { name: /^continuar$/i })
    .click()
    .catch(() => {});
  await page.waitForTimeout(400);
  // Step 4 — legal acknowledgement + submit.
  await biteStep
    .locator('input[type="checkbox"]')
    .check()
    .catch(() => {});
  await biteStep
    .getByRole("button", { name: /confirmar mordedura/i })
    .click()
    .catch(() => {});
  await page
    .getByText(/incidente registrado/i)
    .waitFor({ timeout: 30_000 })
    .catch(() => {});
  await fullScroll(page);

  // -------------------------------------------------------------------------
  // 5. ADMINISTRACIÓN — show only (no service creation here, no invitations)
  // -------------------------------------------------------------------------
  await showScreen(page, `${root}/servicios`);
  await showScreen(page, `${root}/miembros`);
  await showScreen(page, `${root}/cobertura`);
  await showScreen(page, `${root}/admin/permisos`);
  await showScreen(page, `${root}/configuracion`);
});
