import { expect, test } from "@playwright/test";
import {
  ACCOUNTS,
  DEMO_PHOTOS,
  fullScroll,
  loginAs,
  pickLocality,
  showScreen,
  visit,
} from "./_helpers";

// SEGMENT 02 — DUEÑO (owner@dim.test). Real flows end to end:
// new pet → QR credential → vaccine (with photo) → history → booking → denuncias.
test("segmento 02 — dueno", async ({ page }) => {
  test.setTimeout(18 * 60_000);
  page.on("dialog", (d) => d.accept().catch(() => {}));

  await loginAs(page, ACCOUNTS.owner);

  // 1. Home
  await showScreen(page, "/inicio");

  // 2. ALTA DE MASCOTA — 2-step wizard (MinimalNewPetForm, PO decision
  // 2026-07-08, commit f94ad6ff): paso 1 identidad → "Continuar" → paso 2
  // "foto y más" → "Crear mascota". Ends on the QR credential.
  await showScreen(page, "/mis-mascotas");
  await visit(page, "/mis-mascotas/nueva");
  // Paso 1 — identidad (nombre / especie / sexo / provincia → localidad).
  await page.locator('input[name="name"]').fill("Luna");
  await page.getByRole("button", { name: /perro/i }).click();
  await page.locator('label:has(input[name="sex"][value="male"])').click();
  // Location is now a province-first cascade (LocationFields cascade=true,
  // MinimalNewPetForm) — the locality autocomplete stays disabled until a
  // province is picked. Palermo is a CABA barrio.
  await page.locator("#cascade-province").selectOption("AR-C");
  await pickLocality(page, "#localityName-input", "Palermo");
  await fullScroll(page);
  // Advance to paso 2. The step is a client-side toggle (both steps stay
  // mounted), so "Continuar" only swaps the footer button — no navigation.
  await page.getByRole("button", { name: /continuar/i }).click();
  // Paso 2 — "foto y más". The photo is OPTIONAL (skippable fast path), so
  // submit straight through to mint the credential.
  await fullScroll(page);
  // Duplicate-detection guard (a real product feature, not a bug): if this
  // owner already has a same-species/sex/name pet (seed data, or an earlier
  // re-run of this journey), paso 2 surfaces "¿Es la misma mascota?" and the
  // direct "Crear mascota" button is replaced by an explicit choice. Take the
  // "crear igual" branch so the journey is idempotent across re-runs — the
  // dedup panel appearing is itself confirmation the guard works.
  const createAnyway = page.getByRole("button", { name: /no, es otra.*crear igual/i });
  if (
    await createAnyway
      .count()
      .then((c) => c > 0)
      .catch(() => false)
  ) {
    await createAnyway.click();
  } else {
    await page.getByRole("button", { name: /registrar mascota/i }).click();
  }
  await page.waitForURL(/\/credencial/, { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page); // "aha" screen: issued QR credential

  const token = page.url().match(/\/nueva\/([^/]+)\/credencial/)?.[1];
  expect(token, "pet publicToken parsed from credential URL").toBeTruthy();

  // 3. Pet profile — Credencial (Face 1) is the default; Libreta (Face 2) is
  // ONE consolidated timeline now (pet-document-redesign ADR-10) — no lens
  // toggle anymore. `?lente=` still round-trips as a legacy-compat URL param
  // (REQ-6) but no longer selects a filter; every value resolves the same
  // face. The Libreta content itself comes AFTER registering the vaccine
  // below, so the recording shows a populated timeline, not an empty one.
  await showScreen(page, `/mis-mascotas/${token}`);
  await showScreen(page, `/mis-mascotas/${token}?tab=libreta&lente=todo`);

  // 4. VACUNA — event capture end to end, with attachment photo.
  // pet-document-redesign (D1/ADR-5): Anotar is now a ?sheet=anotar sheet on
  // the profile itself, not a page nav to /anotar (that route stays as a
  // thin fallback — see SheetMounter.tsx). CaptureOptionsList is the exact
  // same shared component either way, so "Registrar vacuna" renders
  // identically inside the sheet.
  await showScreen(page, `/mis-mascotas/${token}?sheet=anotar`);
  await page.getByRole("link", { name: "Registrar vacuna" }).click();
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page);
  await page.locator('input[name="vaccineName"]').fill("Antirrábica");
  const nextDue = new Date();
  nextDue.setFullYear(nextDue.getFullYear() + 1);
  await page.locator('input[name="nextDueAt"]').fill(nextDue.toISOString().split("T")[0]);
  await page.locator('input[name="brand"]').fill("Zoetis");
  await page.locator('input[name="batch"]').fill("L-2231");
  await page.locator('input[name="administeredBy"]').fill("Dra. Paz — Clínica Recoleta");
  await page
    .locator('textarea[name="notes"]')
    .fill("Sin reacciones adversas. Refuerzo anual programado.");
  await page.locator('input[name="attachment"]').setInputFiles(DEMO_PHOTOS[1]);
  await page.waitForTimeout(800);
  await fullScroll(page);
  await page.getByRole("button", { name: /registrar vacuna/i }).click();
  // Fail loud: createVaccinationAction redirects to the pet profile on success.
  await page.waitForURL((url) => !url.pathname.endsWith("/vacuna"), { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page);

  // 5. Proof on camera: Libreta face (consolidated timeline) + full history
  // now show the registered vaccine.
  await showScreen(page, `/mis-mascotas/${token}?tab=libreta&lente=todo`);
  await showScreen(page, `/mis-mascotas/${token}/historial`);

  // 5a. FLIP CARD — literal CSS-3D flip between Credencial and Libreta
  // (pet-document-redesign ADR-11). Start back on Credencial (default), then
  // drive the flip via the "Girar" button itself (not a `?tab=` URL nav) so
  // the recording shows the actual flip transition, then flip back.
  await visit(page, `/mis-mascotas/${token}`);
  await fullScroll(page);
  await page.getByRole("button", { name: /girar a libreta/i }).click();
  await page.waitForTimeout(700); // 500ms CSS transition + settle
  await fullScroll(page);
  await page.getByRole("button", { name: /girar a credencial/i }).click();
  await page.waitForTimeout(700);

  // 5b. CHAPITA — physical-tag-interest sheet (pet-document-redesign
  // ADR-17b), the revived 5th action-bar icon on an active pet's profile.
  await showScreen(page, `/mis-mascotas/${token}?sheet=chapita`);

  // 5c. EMERGENCIA — vet/emergency-contact edit sheet (pet-document-redesign
  // ADR-13), reachable from CredentialFace's Emergencia card "Agregar datos
  // de emergencia" / "Editar" affordance.
  await showScreen(page, `/mis-mascotas/${token}?sheet=emergencia`);

  // 6-pre. GUARD HYGIENE — the per-campaign identity guard (QA A3, migration
  // 0181: one CONFIRMED appointment per pet+offering) makes a straight re-run
  // against a persisted DB fail: an earlier run's Luna still holds a live
  // turno on the same first-listed offering, and the booking form's pet
  // <select> matches by label, so it can pick that older Luna. Cancel any
  // live "Luna" turno through the real cancel flow first (filmable product
  // surface in itself) so the booking below always starts clean. Bounded:
  // each earlier run left at most one live turno.
  await visit(page, "/mis-turnos");
  for (let i = 0; i < 6; i++) {
    // Upcoming confirmed cards are the only cancellable ones — they carry the
    // "Ver QR de check-in" affordance; past/cancelled cards do not.
    const lunaTurno = page
      .locator('a[href^="/mis-turnos/"]')
      .filter({ hasText: "Luna" })
      .filter({ hasText: "Ver QR de check-in" })
      .first();
    if ((await lunaTurno.count()) === 0) break;
    await lunaTurno.click();
    await page.getByRole("button", { name: "Cancelar turno" }).click();
    await page.getByRole("button", { name: /sí, cancelar/i }).click();
    // Outcome, not URL (e2e/README): the sheet closes with a full reload and
    // the server-rendered status flips to "Cancelado por vos".
    await expect(page.getByText("Cancelado por vos").first()).toBeVisible({ timeout: 15_000 });
    await visit(page, "/mis-turnos");
  }

  // 6. TURNOS — search → offering → slot → confirm booking (fail loud: needs seeded slots).
  // Drive the real filter form: seed-coverage's castración campaign lives in Palermo.
  await visit(page, "/turnos/buscar");
  await fullScroll(page); // service-kind picker
  await page.getByRole("link", { name: "Castración perro macho" }).click();
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await pickLocality(page, "#locality_picker-input", "Palermo");
  await page.getByRole("button", { name: /^buscar$/i }).click();
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page);
  const offering = page.locator('a[href^="/turnos/buscar/"]:not([href*="service_kind"])').first();
  await expect(offering, "an offering in /turnos/buscar (seed: materialize:slots)").toBeVisible();
  await offering.click();
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page);
  const slot = page.locator('a[href*="/reservar/"]').first();
  await expect(slot, "an open slot on the offering").toBeVisible();
  await slot.click();
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page);
  const petSelect = page.locator('select[name="petId"]');
  await expect(petSelect, "booking form pet selector").toBeVisible();
  await petSelect.selectOption({ label: "Luna" }).catch(() => petSelect.selectOption({ index: 1 }));
  await page.getByRole("button", { name: /confirmar reserva/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/reservar/"), { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page);

  // 7. My bookings
  await showScreen(page, "/mis-turnos");

  // 8. Denuncias (citizen view) — list + first detail if any
  await showScreen(page, "/denuncias/mias");
  const report = page.locator('a[href^="/denuncias/"]:not([href*="nueva"])').first();
  if (await report.count()) {
    await report.click();
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page);
  }

  // 9. Notifications + account
  await showScreen(page, "/notificaciones");
  await showScreen(page, "/cuenta");

  await expect(page.locator("body")).toBeVisible();
});
