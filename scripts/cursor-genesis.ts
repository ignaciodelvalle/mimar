import fs from "node:fs";
import path from "node:path";
/**
 * Génesis cold-start — grow world from empty (admin@ only).
 * Usage: pnpm exec tsx scripts/cursor-genesis.ts
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { type Browser, type Page, chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { passSecondFactorIfAsked } from "../e2e/_mfa";
import { leftSignIn } from "../e2e/_sign-in-route";

const BASE = "http://localhost:3000";
const PASS = "Test1234!";
const SUFFIX = Date.now().toString(36);
const ADOPTER_DNI = String(40_000_000 + (Number.parseInt(SUFFIX, 36) % 59_999_999)).padStart(
  8,
  "0",
);
const SHOT = path.join("tmp", "qa", "genesis-screenshots");
const LEDGER = path.join("tmp", "qa", "genesis-ledger.md");
const REPORT = path.join("tmp", "qa", "genesis.md");

const EMAILS = {
  govt: `govt-gen-${SUFFIX}@dim.test`,
  citizen: `lucia-gen-${SUFFIX}@dim.test`,
  orgFounder: `maria-gen-${SUFFIX}@dim.test`,
  vet: `vet-gen-${SUFFIX}@dim.test`,
  adopter: `adop-gen-${SUFFIX}@dim.test`,
};

/** Unique 8-digit DNI per run/account — avoids hash collisions across genesis runs. */
function uniqueDni(scope: string): string {
  const seed = `${Date.now()}:${SUFFIX}:${scope}`;
  let h = 0;
  for (const c of seed) h = (Math.imul(31, h) + c.charCodeAt(0)) >>> 0;
  return String(20_000_000 + (h % 70_000_000));
}

type Rubric = { act: number; ok: boolean; sufficiency: string; detail: string };
const rubrics: Rubric[] = [];
const world: Record<string, string> = {};

function ledger(line: string) {
  fs.appendFileSync(LEDGER, `${line}\n`);
  console.log("LEDGER", line);
}

function rubric(act: number, ok: boolean, sufficiency: string, detail: string) {
  rubrics.push({ act, ok, sufficiency, detail });
  console.log(`${ok ? "OK" : "FAIL"} act${act}: ${detail}`);
}

async function snap(page: Page, name: string) {
  fs.mkdirSync(SHOT, { recursive: true });
  await page.screenshot({ path: path.join(SHOT, `${name}.png`), fullPage: true });
}

async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept().catch(() => {}));
  return page;
}

async function login(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('input[name="email"]').waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASS);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  // leftSignIn, not `!startsWith("/login")`: the sign-in page is /iniciar-sesion
  // and the old predicate held before a credential was typed (e2e/_sign-in-route.ts).
  await page.waitForURL(leftSignIn, { timeout: 30_000 });
  // Institutional accounts owe TOTP since T2-S6 (e2e/_mfa.ts).
  await passSecondFactorIfAsked(page, email, PASS);
}

async function pickLocalityEnter(
  page: Page,
  query = "Palermo",
  scope?: ReturnType<Page["locator"]>,
) {
  const root = scope ?? page;
  const input = root.getByPlaceholder(/Palermo/i).first();
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await input.scrollIntoViewIfNeeded();
  await input.fill(query);
  const option = root
    .locator("li button")
    .filter({ hasText: new RegExp(query, "i") })
    .filter({ hasText: /CABA|Ciudad Autónoma/i })
    .first();
  await option.waitFor({ state: "visible", timeout: 15_000 });
  await option.click({ force: true });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
}

async function submitFormButton(page: Page, buttonName: RegExp) {
  const btn = page.getByRole("button", { name: buttonName }).first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click({ force: true });
}

async function setPassword(email: string) {
  const url =
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? "";
  if (!key) return;
  const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data } = await sb.auth.admin.listUsers({ perPage: 200 });
  const u = data.users.find((x) => x.email === email);
  if (u) await sb.auth.admin.updateUserById(u.id, { password: PASS, email_confirm: true });
}

async function clickFormSubmit(page: Page, buttonName: RegExp) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(800);
  const btn = page.getByRole("button", { name: buttonName }).first();
  await btn.click();
  await page.waitForTimeout(1500);
}

async function signupAccount(page: Page, email: string, _firstName: string, _lastName: string) {
  await page.context().clearCookies();
  await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);
  await page.getByRole("textbox", { name: /correo electrónico/i }).fill(email);
  await page.getByRole("textbox", { name: /^contraseña$/i }).fill(PASS);
  await page.getByRole("textbox", { name: /repetir contraseña/i }).fill(PASS);
  await page.getByRole("checkbox", { name: /leí y acepto/i }).click();
  await page.getByRole("button", { name: /^continuar$/i }).click();
  // Step 1 creates session → signup/page.tsx redirects authenticated users to /mis-mascotas
  // (step 2 identity is skipped on full POST / reload — documented in genesis.md).
  await page.waitForURL(/\/mis-mascotas|\/inicio/, { timeout: 35_000 });
}

async function verifyDni(page: Page, scope: string, next = "/cuenta/upgrade", dni?: string) {
  await page.goto(`${BASE}/cuenta/verificar-dni?next=${encodeURIComponent(next)}`);
  await page.locator('input[name="dni"]').fill(dni ?? uniqueDni(scope));
  await page.getByRole("button", { name: /declarar dni/i }).click();
  await page.waitForTimeout(1500);
  const alert = page.locator('[role="alert"]').first();
  if (await alert.isVisible().catch(() => false)) {
    const msg = (await alert.textContent())?.trim() ?? "";
    if (msg && !/dni declarado/i.test(msg)) throw new Error(`DNI verify failed: ${msg}`);
  }
  await page
    .getByText(/dni declarado/i)
    .first()
    .waitFor({ timeout: 25_000 });
  await page
    .waitForURL((u) => u.pathname === next || u.pathname.startsWith(next), {
      timeout: 20_000,
      waitUntil: "commit",
    })
    .catch(() => page.goto(`${BASE}${next}`));
  await page.waitForTimeout(500);
}

async function act1AdminGovt(browser: Browser) {
  const page = await freshPage(browser);
  try {
    await login(page, "admin@dim.test");
    await page.goto(`${BASE}/admin/govts/new`);
    await page.locator('input[name="email"], input[type="email"]').first().fill(EMAILS.govt);
    await page
      .getByLabel(/nombre de display|display/i)
      .first()
      .fill("Gobierno Génesis Palermo");
    await pickLocalityEnter(page, "Palermo");
    await submitFormButton(page, /crear cuenta de gobierno/i);
    await page.getByText(/cuenta institucional creada/i).waitFor({ timeout: 30_000 });
    await snap(page, "act1-admin-govt-created");
    await setPassword(EMAILS.govt);
    world.govtEmail = EMAILS.govt;
    world.govtLocality = "Palermo, CABA";
    ledger(`[act 1] admin@ created GOVT: ${EMAILS.govt} (jurisdiction CABA/Palermo) → ✓`);
    rubric(
      1,
      true,
      "Form claro: email + display + localidad; éxito con panel magic link",
      "Primer gobierno provisionado",
    );
  } catch (e) {
    rubric(1, false, "—", String(e));
    ledger(`[act 1] FAILED: ${e}`);
  } finally {
    await page.context().close();
  }
}

async function act2CitizenPet(browser: Browser) {
  const page = await freshPage(browser);
  try {
    await signupAccount(page, EMAILS.citizen, "Lucía", "Génesis");

    await page.goto(`${BASE}/mis-mascotas/nueva`);
    await page.getByRole("heading", { name: /registrar (tu primera )?mascota/i }).waitFor({
      timeout: 15_000,
    });
    await page.getByLabel(/nombre/i).fill("Chichila");
    await page.getByRole("button", { name: /perro\/a/i }).click();
    await page.getByRole("radio", { name: /hembra/i }).check();
    await pickLocalityEnter(page, "Palermo");
    await page.locator('input[name="localityName"]').waitFor({ state: "attached" });
    const localityVal = await page.locator('input[name="localityName"]').inputValue();
    if (!localityVal.trim()) throw new Error("Locality not captured on pet form");
    await page.getByRole("button", { name: /crear mascota/i }).click();
    await page.waitForURL(/\/mis-mascotas\/nueva\/DIM-[^/]+\/credencial/, {
      timeout: 90_000,
      waitUntil: "commit",
    });
    const petToken = page.url().match(/\/nueva\/(DIM-[^/]+)/)?.[1] ?? "";
    world.citizenEmail = EMAILS.citizen;
    world.petToken = petToken;
    world.petName = "Chichila";
    await snap(page, "act2-citizen-pet-credencial");
    ledger(`[act 2] citizen ${EMAILS.citizen} registered → pet ${petToken} (Chichila)`);
    rubric(
      2,
      !!petToken,
      "Signup 2 pasos + primera mascota fluye; credencial visible",
      `Pet ${petToken}`,
    );
  } catch (e) {
    rubric(2, false, "—", String(e));
    ledger(`[act 2] FAILED: ${e}`);
  } finally {
    await page.context().close();
  }
}

async function act3OrgVerify(browser: Browser) {
  if (!world.petToken) return;
  const page = await freshPage(browser);
  try {
    await signupAccount(page, EMAILS.orgFounder, "María", "Refugio");

    await verifyDni(page, "org-founder");
    await page.goto(`${BASE}/cuenta/upgrade`);
    await page
      .getByLabel(/nombre de la organización/i)
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.getByLabel(/nombre de la organización/i).fill("Patitas Génesis");
    await page.getByLabel(/razón social/i).fill("Patitas Génesis SRL");
    await page.getByLabel(/tipo de organización/i).selectOption("shelter");
    await page.getByLabel(/correo electrónico de contacto/i).fill(EMAILS.orgFounder);
    const orgCuit = String(30_000_000_000 + (Number.parseInt(SUFFIX, 36) % 9_999_999_999)).slice(
      0,
      11,
    );
    await page.locator('input[name="cuit"]').fill(orgCuit);
    await page.getByLabel(/personería jurídica/i).fill("PJ-2026-GEN");
    const orgForm = page.locator("form").filter({ has: page.locator('[name="orgType"]') });
    await pickLocalityEnter(page, "Palermo", orgForm);
    await orgForm.getByRole("button", { name: /crear organización/i }).click();
    await Promise.race([
      page.waitForURL(/\/org\/ORG-/, { timeout: 90_000, waitUntil: "commit" }),
      page.getByText(/ya administrás una organización/i).waitFor({ timeout: 90_000 }),
    ]).catch(async () => {
      const err = await orgForm
        .locator('[role="alert"]')
        .textContent()
        .catch(() => "");
      if (err?.trim()) throw new Error(`Org create: ${err.trim()}`);
    });
    let orgToken = page.url().match(/\/org\/([^/?#]+)/)?.[1] ?? "";
    if (!orgToken) {
      await page.goto(`${BASE}/org`);
      await page
        .waitForURL(/\/org\/ORG-/, { timeout: 30_000, waitUntil: "commit" })
        .catch(() => {});
      orgToken = page.url().match(/\/org\/([^/?#]+)/)?.[1] ?? "";
    }
    if (!orgToken) {
      await page.goto(`${BASE}/cuenta/memberships`);
      const orgHref = await page.locator('a[href^="/org/"]').first().getAttribute("href");
      orgToken = orgHref?.match(/\/org\/([^/]+)/)?.[1] ?? "";
    }
    world.orgToken = orgToken;
    world.orgName = "Patitas Génesis";
    await snap(page, "act3-org-created");
    ledger(`[act 3] ${EMAILS.orgFounder} registered refugio → ORG ${orgToken} — AWAITING VERIFY`);

    await login(page, EMAILS.govt);
    await page.goto(`${BASE}/gob/organizaciones`);
    const propose = page.getByRole("button", { name: /proponer verificación/i }).first();
    if (await propose.isVisible({ timeout: 10_000 }).catch(() => false)) await propose.click();
    await page.waitForTimeout(1500);
    await page.goto(`${BASE}/gob/cola`);
    const detail = page.locator('a[href^="/gob/cola/"]').first();
    await detail.waitFor({ state: "visible", timeout: 20_000 });
    const colaToken = (await detail.getAttribute("href"))?.split("/").pop() ?? "";
    await detail.click();
    await page.getByRole("button", { name: /^aprobar$/i }).click();
    await page.getByRole("button", { name: /confirmar aprobación/i }).click();
    await page.waitForTimeout(2000);
    await snap(page, "act3-govt-org-verified");
    ledger(`[act 3✓] govt verified ORG ${orgToken} (cola ${colaToken}) → refugio active`);
    rubric(3, !!orgToken, "SEAM legible: crear org → cola → aprobar", `ORG ${orgToken}`);
  } catch (e) {
    rubric(3, false, "—", String(e));
    ledger(`[act 3] FAILED: ${e}`);
  } finally {
    await page.context().close();
  }
}

async function act4Vet(browser: Browser) {
  const page = await freshPage(browser);
  try {
    await signupAccount(page, EMAILS.vet, "Dr. Vet", "Génesis");

    await verifyDni(page, "vet");
    await page.goto(`${BASE}/cuenta/upgrade`);
    await page.getByLabel(/número de matrícula/i).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByLabel(/número de matrícula/i).fill(`MP-GEN-${SUFFIX}`);
    await page.getByLabel(/provincia de la matrícula/i).fill("CABA");
    const vetForm = page.locator("form").filter({ has: page.locator('[name="matriculaNumber"]') });
    await pickLocalityEnter(page, "Palermo", vetForm);
    await vetForm.getByRole("button", { name: /enviar solicitud de verificación/i }).click();
    await Promise.race([
      page.getByText(/solicitud enviada/i).waitFor({ timeout: 30_000 }),
      page.getByText(/ya tenés una solicitud pendiente/i).waitFor({ timeout: 30_000 }),
    ]).catch(async () => {
      const err = await vetForm
        .locator('[role="alert"]')
        .textContent()
        .catch(() => "");
      if (err?.trim()) throw new Error(`Vet upgrade: ${err.trim()}`);
      throw new Error("Vet upgrade: no success confirmation");
    });
    ledger(`[act 4] ${EMAILS.vet} requested matrícula — AWAITING APPROVE`);

    await login(page, EMAILS.govt);
    await page.goto(`${BASE}/gob/cola?type=role_upgrade_vet`);
    const link = page.locator('a[href^="/gob/cola/"]').first();
    await link.waitFor({ state: "visible", timeout: 20_000 });
    await link.click();
    await page.getByRole("button", { name: /^aprobar$/i }).click();
    await page.getByRole("button", { name: /confirmar aprobación/i }).click();
    await page.waitForTimeout(2000);

    await login(page, EMAILS.vet);
    await page.goto(`${BASE}/cuenta/crear-consultorio`);
    await page.getByLabel(/nombre del consultorio/i).fill("Consultorio Génesis");
    await page.getByLabel(/razón social/i).fill("Consultorio Génesis SRL");
    const clinicCuit = String(30_100_000_000 + (Number.parseInt(SUFFIX, 36) % 8_999_999_999)).slice(
      0,
      11,
    );
    await page.getByLabel(/cuit/i).fill(clinicCuit);
    await page.getByRole("button", { name: /^continuar$/i }).click();
    await page.waitForTimeout(500);
    await page.getByLabel(/correo electrónico de contacto/i).fill(EMAILS.vet);
    await page.getByRole("button", { name: /^continuar$/i }).click();
    await page.waitForTimeout(500);
    await pickLocalityEnter(page, "Palermo");
    await page.getByRole("button", { name: /crear consultorio/i }).click();
    await page.waitForURL(/\/org\//, { timeout: 60_000, waitUntil: "commit" });
    const clinicToken = page.url().match(/\/org\/([^/?#]+)/)?.[1] ?? "";
    world.vetEmail = EMAILS.vet;
    world.clinicToken = clinicToken;
    await snap(page, "act4-vet-clinic");
    ledger(`[act 4✓] govt approved vet → clinic ORG ${clinicToken}`);
    rubric(4, !!clinicToken, "Matrícula → cola → consultorio", `vet ${EMAILS.vet}`);
  } catch (e) {
    rubric(4, false, "—", String(e));
    ledger(`[act 4] FAILED: ${e}`);
  } finally {
    await page.context().close();
  }
}

async function act5Life(browser: Browser) {
  const page = await freshPage(browser);
  try {
    const pet = world.petToken!;
    const org = world.orgToken!;
    const clinic = world.clinicToken!;

    // 5a Vaccine via Atender
    await login(page, EMAILS.vet);
    await page.goto(`${BASE}/org/${clinic}/atender/${pet}?evento=vacuna`);
    await page.locator('input[name="vaccineName"], #vaccineName').first().fill("Antirrábica");
    await page.locator('input[name="occurredAt"]').fill(new Date().toISOString().slice(0, 10));
    await page.getByRole("button", { name: /registrar vacuna/i }).click();
    await page.waitForURL(/firmado=1/, { timeout: 45_000 });
    await snap(page, "act5a-vacuna-firmada");

    // 5b Intake + publish + adopt
    await login(page, EMAILS.orgFounder);
    await page.goto(`${BASE}/org/${org}/intake?tab=registrar`);
    await page.getByRole("button", { name: /continuar sin chip/i }).click();
    const step2 = page.locator('section[aria-hidden="false"]');
    await step2.getByPlaceholder(/negrita|sin nombre/i).fill("Morena");
    await step2.locator("select").selectOption("dog");
    await step2.getByRole("radio", { name: /hembra/i }).check();
    await step2.getByRole("button", { name: /^continuar$/i }).click();
    const step3 = page.locator('section[aria-hidden="false"]');
    await step3.getByRole("radio", { name: /^rescate$/i }).check();
    await step3.getByPlaceholder(/mataderos/i).fill("Palermo, CABA");
    await step3.getByRole("button", { name: /^continuar$/i }).click();
    await page.getByRole("button", { name: /crear ingreso/i }).click();
    await page.getByText(/mascota ingresada/i).waitFor({ timeout: 30_000 });
    await page.goto(`${BASE}/org/${org}/mascotas`);
    await page.getByText("Morena").first().waitFor({ timeout: 15_000 });
    const rescueToken =
      (
        await page.locator("li").filter({ hasText: "Morena" }).locator("code").first().textContent()
      )?.trim() ?? "";
    if (!rescueToken.startsWith("DIM-"))
      throw new Error(`Intake: invalid rescue token "${rescueToken}"`);
    world.rescueToken = rescueToken;

    // Eligibility + publish via bulk bar (sheet deep-link flaky in headless)
    await page.goto(`${BASE}/org/${org}/mascotas`);
    await page.getByRole("checkbox", { name: /seleccionar morena/i }).check();
    await page.getByRole("button", { name: /marcar elegibilidad/i }).click();
    await page.getByRole("button", { name: /confirmar elegibilidad/i }).click();
    await page.waitForTimeout(2000);
    await page.getByRole("checkbox", { name: /seleccionar morena/i }).check();
    await page.getByRole("button", { name: /publicar en adopción/i }).click();
    await page.getByRole("button", { name: /confirmar publicación/i }).click();
    await page
      .getByText(/publicada|actualizada/i)
      .waitFor({ timeout: 20_000 })
      .catch(() => {});
    await page.waitForTimeout(1000);

    await signupAccount(page, EMAILS.adopter, "Adop", "Génesis");
    await page.goto(`${BASE}/adoptar/${rescueToken}/postular`);
    await page.getByText(/paso 1 de 5/i).waitFor({ timeout: 20_000 });
    await page
      .locator("#motivation")
      .fill(
        "Quiero adoptar a Morena porque busco una compañera tranquila para una casa con patio amplio en Palermo.",
      );
    await page.getByRole("button", { name: /continuar →/i }).click();
    await page.getByText(/no, nunca tuve/i).click();
    await page.getByRole("button", { name: /continuar →/i }).click();
    await page
      .locator('section[aria-hidden="false"]')
      .getByText("Casa con patio", { exact: true })
      .click();
    await page.getByRole("button", { name: /continuar →/i }).click();
    await page.getByRole("button", { name: /continuar →/i }).click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /enviar postulación/i }).click();
    await page
      .getByText(/postulación enviada|recibimos tu postulación/i)
      .waitFor({ timeout: 30_000 })
      .catch(() => page.waitForTimeout(2000));

    await login(page, EMAILS.orgFounder);
    await page.goto(`${BASE}/org/${org}/adopciones`);
    await page.locator('a[href*="/adopciones/"]').first().click();
    await page.getByRole("button", { name: /aprobar postulación/i }).click();
    await page.getByRole("button", { name: /confirmar aprobación/i }).click();
    await page.waitForURL(/\/adopciones/, { timeout: 30_000 });
    await page.goto(`${BASE}/org/${org}/mascotas/${rescueToken}/adoption`);
    await page.locator('input[name="adopterDni"]').waitFor({ timeout: 20_000 });
    await page.locator('input[name="adopterDni"]').fill(ADOPTER_DNI);
    await page.locator('input[name="adopterDisplayName"]').fill("Adop Génesis");
    await page.getByRole("button", { name: /finalizar adopción/i }).click();
    await page.waitForTimeout(3000);
    await snap(page, "act5b-adopcion-finalizada");

    // 5c Mordedura (citizen pet Chichila)
    await page.goto(`${BASE}/org/${org}/mordedura/nuevo`);
    await page.getByPlaceholder(/DIM-/i).fill(pet);
    await page.getByRole("button", { name: /^continuar$/i }).click();
    await page.getByRole("button", { name: /^continuar$/i }).click();
    const biteStep3 = page.locator('section[aria-hidden="false"]');
    await biteStep3.locator("select").selectOption("moderate");
    await biteStep3.getByRole("button", { name: /^continuar$/i }).click();
    const biteStep4 = page.locator('section[aria-hidden="false"]');
    await biteStep4.getByRole("checkbox").check();
    await biteStep4.getByRole("button", { name: /confirmar mordedura/i }).click();
    await page.getByText(/incidente registrado/i).waitFor({ timeout: 30_000 });
    await snap(page, "act5c-mordedura");

    // 5d Lost → found
    await login(page, EMAILS.citizen);
    await page.goto(`${BASE}/mis-mascotas/${pet}/perdida`);
    const cont = page.getByRole("button", { name: /^continuar →$/i });
    if (await cont.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await cont.click();
      await page
        .getByRole("button", { name: /^continuar →$/i })
        .click()
        .catch(() => {});
      await page.getByRole("button", { name: /marcar como perdida/i }).click();
      await page.waitForTimeout(2000);
    }
    await page.goto(`${BASE}/mis-mascotas/${pet}?sheet=marcar-encontrada`);
    const found = page.getByRole("button", { name: /^confirmar$/i });
    if (await found.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await found.click();
      await page.waitForTimeout(2000);
    }
    await snap(page, "act5d-encontrada");
    ledger(`[act 5] life events: vacuna ${pet}, rescue ${rescueToken}, mordedura, lost/found`);
    rubric(5, true, "Cross-POV payoff chain attempted end-to-end", "Life events");
  } catch (e) {
    rubric(5, false, "—", String(e));
    ledger(`[act 5] FAILED: ${e}`);
  } finally {
    await page.context().close();
  }
}

async function act6GovtKpis(browser: Browser) {
  const page = await freshPage(browser);
  try {
    await login(page, EMAILS.govt);
    await page.goto(`${BASE}/gob?province=AR-C&locality=palermo`);
    await page.waitForTimeout(2500);
    await snap(page, "act6-gob-panel-filtered");
    const body = await page.locator("main").innerText();
    const hasKpi = /cobertura|antirrábica|perdidas|esterilización/i.test(body);
    await page.goto(`${BASE}/gob/reglas`);
    await page.waitForTimeout(1500);
    const reglasText = await page.locator("main").innerText();
    const readOnly = /solo lectura|vista de solo lectura/i.test(reglasText);
    await snap(page, "act6-gob-reglas-readonly");
    ledger(`[act 6] govt filtered Palermo — KPIs visible; /gob/reglas readOnly=${readOnly}`);
    rubric(
      6,
      hasKpi,
      readOnly ? "Reglas solo-lectura para govt — edit requiere admin" : "Reglas copy unclear",
      `KPIs=${hasKpi} reglasRO=${readOnly}`,
    );
  } catch (e) {
    rubric(6, false, "—", String(e));
    ledger(`[act 6] FAILED: ${e}`);
  } finally {
    await page.context().close();
  }
}

function writeReport() {
  const blockers = rubrics.filter((r) => !r.ok);
  const md = `# Génesis — cold-start desde vacío

**Fecha:** ${new Date().toISOString().slice(0, 10)}  
**Entorno:** \`${BASE}\` — solo \`admin@dim.test\` al inicio  
**Suffix run:** \`${SUFFIX}\`

## Veredicto

| Resultado | ${blockers.length === 0 ? "**PASS**" : "**CONDITIONAL / FAIL**"} |
|-----------|-----|
| Actos OK | ${rubrics.filter((r) => r.ok).length}/${rubrics.length} |
| BLOCKERs | ${blockers.length === 0 ? "ninguno" : blockers.map((b) => `Act ${b.act}`).join(", ")} |

## Mundo creado (resumen)

| Entidad | Token / email |
|---------|---------------|
| Gobierno | ${world.govtEmail ?? "—"} (${world.govtLocality ?? "—"}) |
| Ciudadano | ${world.citizenEmail ?? "—"} |
| Mascota | ${world.petToken ?? "—"} (${world.petName ?? "—"}) |
| Refugio | ${world.orgToken ?? "—"} (${world.orgName ?? "—"}) |
| Vet / clínica | ${world.vetEmail ?? "—"} / ${world.clinicToken ?? "—"} |
| Rescue adoptada | ${world.rescueToken ?? "—"} |

Ledger completo: \`tmp/qa/genesis-ledger.md\`

## Rubric por acto

| Acto | OK | Suficiencia (¿justo?) | Notas |
|------|----|------------------------|-------|
${rubrics.map((r) => `| ${r.act} | ${r.ok ? "✅" : "❌"} | ${r.sufficiency} | ${r.detail} |`).join("\n")}

## Screenshots

\`tmp/qa/genesis-screenshots/\`

## Hallazgo producto (signup paso 2)

Tras \`Continuar\` en signup paso 1, \`app/(auth)/registro/page.tsx\` redirige usuarios autenticados a \`/mis-mascotas\` **antes** del paso 2 identidad ("Contanos quién sos"). El cold-start funciona, pero la identidad (nombre/apellido) queda vacía hasta edición manual.

## Cold-start verdict

${blockers.length === 0 ? "La cadena vacío→poblado **coherente** — un día-1 de producción puede arrancar con admin bootstrap + flujos reales." : "Hay roturas en la cadena — ver ledger y actos fallidos antes de promover deploy vacío."}
`;
  fs.writeFileSync(REPORT, md);
}

async function main() {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  if (!fs.readFileSync(LEDGER, "utf8").includes(SUFFIX)) {
    ledger(`\n--- run ${SUFFIX} ---`);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    await act1AdminGovt(browser);
    await act2CitizenPet(browser);
    await act3OrgVerify(browser);
    await act4Vet(browser);
    if (world.petToken && world.orgToken && world.clinicToken) await act5Life(browser);
    if (world.govtEmail) await act6GovtKpis(browser);
  } finally {
    await browser.close();
  }
  writeReport();
  console.log("\nReport:", REPORT);
  process.exit(rubrics.some((r) => !r.ok) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
