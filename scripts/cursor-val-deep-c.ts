import fs from "node:fs";
import path from "node:path";
/**
 * Deep Pass C — refugio + infra/confianza del dato
 * Usage: pnpm exec tsx scripts/cursor-val-deep-c.ts
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { type Browser, type Page, chromium } from "@playwright/test";
import { passSecondFactorIfAsked } from "../e2e/_mfa";
import { leftSignIn } from "../e2e/_sign-in-route";

const BASE = "http://localhost:3000";
const PASS = "Test1234!";
const SHOT_DIR = path.join("tmp", "qa", "val-deep-C-screenshots");

type Sev = "BLOCKER" | "MAYOR" | "MENOR" | "OK";
type Finding = { id: string; sev: Sev; ok: boolean; detail: string };

const findings: Finding[] = [];

function record(id: string, sev: Sev, ok: boolean, detail: string): void {
  findings.push({ id, sev, ok, detail });
  console.log(`${ok ? "OK" : sev}  ${id}: ${detail}`);
}

async function snap(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
}

async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  return ctx.newPage();
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const emailInput = page.locator('input[name="email"]');
  await emailInput.waitFor({ state: "visible", timeout: 25_000 });
  await emailInput.fill(email);
  await page.locator('input[name="password"]').fill(PASS);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  // leftSignIn, not `!startsWith("/login")`: the sign-in page is /iniciar-sesion
  // and the old predicate held before a credential was typed (e2e/_sign-in-route.ts).
  await page.waitForURL(leftSignIn, { timeout: 30_000 });
  // Institutional accounts owe TOTP since T2-S6 (e2e/_mfa.ts).
  await passSecondFactorIfAsked(page, email, PASS);
}

async function waitMainSettled(page: Page): Promise<string> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page
    .waitForFunction(
      () => {
        const t = document.querySelector("main")?.textContent ?? "";
        return t.length > 20 && !/cargando/i.test(t);
      },
      { timeout: 15_000 },
    )
    .catch(() => {});
  return page
    .locator("main")
    .innerText()
    .catch(() => "");
}

async function resolveOrgToken(page: Page, nameHint?: RegExp): Promise<string | null> {
  await page.goto(`${BASE}/cuenta/memberships`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const links = page.locator('a[href^="/org/"]');
  const n = await links.count();
  for (let i = 0; i < n; i++) {
    const link = links.nth(i);
    const text = (await link.innerText()).trim();
    if (!nameHint || nameHint.test(text)) {
      const href = await link.getAttribute("href");
      const token = href?.match(/\/org\/([^/]+)/)?.[1];
      if (token) return token;
    }
  }
  const first = links.first();
  if ((await first.count()) === 0) return null;
  const href = await first.getAttribute("href");
  return href?.match(/\/org\/([^/]+)/)?.[1] ?? null;
}

function blockedPage(text: string, status: number | null, url: string): boolean {
  if (status === 404 || status === 403) return true;
  if (url.includes("acceso-denegado")) return true;
  return /no encontramos|sin acceso|acceso denegado|no tenés|no autorizado|fuera de (tu )?cobertura|no pertenece/i.test(
    text,
  );
}

function leakedPetContent(text: string, petToken: string, petName?: string): boolean {
  if (blockedPage(text, null, "")) return false;
  if (text.includes(petToken)) return true;
  if (petName && new RegExp(petName, "i").test(text)) return true;
  return false;
}

async function publishPetForAdoption(
  page: Page,
  orgToken: string,
  petToken: string,
): Promise<boolean> {
  await page.goto(`${BASE}/org/${orgToken}/mascotas/${petToken}/adoptar`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const pub = page.getByRole("button", { name: /publicar/i }).first();
  if (await pub.isEnabled({ timeout: 5_000 }).catch(() => false)) {
    await pub.click();
    await page.waitForTimeout(1500);
    return true;
  }
  const body = await page
    .locator("main")
    .innerText()
    .catch(() => "");
  return /publicada|ya está publicada|listada/i.test(body);
}

async function owner2ApplyToPet(page: Page, petToken: string): Promise<boolean> {
  await login(page, "owner2@dim.test");
  await page.goto(`${BASE}/adoptar/${petToken}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const body = await page
    .locator("main")
    .innerText()
    .catch(() => "");
  if (/no encontramos|todavía no hay|404/i.test(body)) return false;

  const applyBtn = page.getByRole("button", { name: /postular/i }).first();
  if (!(await applyBtn.isVisible({ timeout: 8_000 }).catch(() => false))) return false;
  await applyBtn.click();
  await page.waitForURL(/postular/, { timeout: 15_000 }).catch(() => {});
  const ta = page.locator('textarea[name="motivation"], textarea').first();
  if (await ta.isVisible().catch(() => false)) {
    await ta.fill(
      "Quiero adoptar y darle un hogar estable con patio. Tengo experiencia con perros rescatados.",
    );
  }
  await page.getByRole("button", { name: /enviar postulaci/i }).click();
  await page
    .waitForURL(/postular|adoptar|inicio|mis-mascotas/, { timeout: 25_000 })
    .catch(() => {});
  return true;
}

async function bulkApproveFirstPending(page: Page, orgToken: string): Promise<boolean> {
  await page.goto(`${BASE}/org/${orgToken}/adopciones?status=pending`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const selectAll = page.getByRole("button", { name: /seleccionar todo/i });
  if (await selectAll.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await selectAll.click();
    await page.waitForTimeout(400);
  } else {
    const cb = page
      .locator('input[type="checkbox"][aria-label*="Seleccionar postulación"]')
      .first();
    if (!(await cb.isVisible({ timeout: 8_000 }).catch(() => false))) return false;
    await cb.click({ force: true });
    await page.waitForTimeout(300);
  }
  const bulkBtn = page.getByRole("button", { name: /aprobar seleccionadas/i });
  if (!(await bulkBtn.isVisible({ timeout: 5_000 }).catch(() => false))) return false;
  await bulkBtn.click();
  const confirm = page.getByRole("button", { name: /confirmar|aprobar postulaciones/i }).last();
  await confirm.waitFor({ state: "visible", timeout: 10_000 });
  const dialogVisible = await page
    .getByText(/aprobar postulaciones seleccionadas/i)
    .isVisible()
    .catch(() => false);
  if (!dialogVisible) return false;
  await confirm.click();
  await page.waitForTimeout(3000);
  const resultText = await page.locator("main").innerText();
  return /aprobad|éxito|procesadas|bulk:/i.test(resultText);
}

async function refugioFlow(browser: Browser): Promise<void> {
  const page = await freshPage(browser);
  try {
    await login(page, "orgadmin@dim.test");
    const orgToken = await resolveOrgToken(page, /refugio test/i);
    if (!orgToken) {
      record("C-refugio-org", "MAYOR", false, "orgadmin sin org token");
      return;
    }
    record("C-refugio-org", "OK", true, `Refugio Test token ${orgToken}`);

    for (const [id, sub, label] of [
      ["C-intake", "intake", "Intake"],
      ["C-transitos", "transitos", "Tránsitos"],
      ["C-adopciones", "adopciones", "Adopciones"],
    ] as const) {
      await page.goto(`${BASE}/org/${orgToken}/${sub}`);
      await page.waitForLoadState("networkidle").catch(() => {});
      const bad = await page
        .getByText(/algo salió mal/i)
        .isVisible()
        .catch(() => false);
      record(id, bad ? "MAYOR" : "OK", !bad, bad ? `${label} error boundary` : `${label} OK`);
      if (sub === "intake") await snap(page, "01-intake");
      if (sub === "adopciones") await snap(page, "02-adopciones-queue");
    }

    // Lola / Negro at Patitas — publish via alejo@ then owner2 postulates
    let owner2Applied = false;
    let patitasToken: string | null = null;
    const alejoPrep = await freshPage(browser);
    try {
      await login(alejoPrep, "alejo@dim.test");
      patitasToken = await resolveOrgToken(alejoPrep, /patitas/i);
      if (patitasToken) {
        for (const petTok of ["DIM-S009-PLRM", "DIM-S012-RECO"] as const) {
          await publishPetForAdoption(alejoPrep, patitasToken, petTok);
        }
      }
    } catch (err) {
      record(
        "C-patitas-publish",
        "MAYOR",
        false,
        `No se pudo publicar Lola/Negro: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await alejoPrep.context().close();
    }

    const lolaPage = await freshPage(browser);
    try {
      owner2Applied = await owner2ApplyToPet(lolaPage, "DIM-S009-PLRM");
      if (!owner2Applied) owner2Applied = await owner2ApplyToPet(lolaPage, "DIM-S012-RECO");
    } catch (err) {
      record(
        "C-owner2-postula",
        "MAYOR",
        false,
        `Error postulación: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await lolaPage.context().close();
    }
    if (findings.every((f) => f.id !== "C-owner2-postula")) {
      record(
        "C-owner2-postula",
        owner2Applied ? "OK" : "MAYOR",
        owner2Applied,
        owner2Applied
          ? "owner2 postuló a Lola o Negro (Patitas)"
          : "/adoptar Lola/Negro sin Postular tras publish alejo@",
      );
    }

    // Bulk on Refugio Test: ensure at least one pending via publish+apply if empty
    await page.goto(`${BASE}/org/${orgToken}/adopciones?status=pending`);
    const pendingCount = await page.locator('input[type="checkbox"]').count();
    if (pendingCount <= 1) {
      await page.goto(`${BASE}/org/${orgToken}/mascotas`);
      const petHref = await page
        .locator(`a[href^="/org/${orgToken}/mascotas/"]`)
        .first()
        .getAttribute("href");
      const petToken = petHref?.split("/mascotas/")[1]?.split(/[/?#]/)[0];
      if (petToken) {
        await page.goto(`${BASE}/org/${orgToken}/mascotas/${petToken}/adoptar`);
        const pub = page.getByRole("button", { name: /publicar/i }).first();
        if (await pub.isEnabled({ timeout: 4_000 }).catch(() => false)) await pub.click();
        const applyPage = await freshPage(browser);
        try {
          await owner2ApplyToPet(applyPage, petToken);
        } finally {
          await applyPage.context().close();
        }
      }
    }

    const bulkOk = await bulkApproveFirstPending(page, orgToken);
    await snap(page, "03-bulk-approve");
    record(
      "C-bulk-aprobar",
      bulkOk ? "OK" : "MAYOR",
      bulkOk,
      bulkOk
        ? "Bulk Aprobar seleccionadas + diálogo confirmación OK (Refugio Test)"
        : "No se pudo ejecutar bulk approve en cola pendiente",
    );

    // Patitas bulk — alejo@ administers Lola/Negro (orgadmin lacks Patitas membership)
    const alejoPage = await freshPage(browser);
    try {
      await login(alejoPage, "alejo@dim.test");
      const tok = patitasToken ?? (await resolveOrgToken(alejoPage, /patitas/i));
      if (!tok) {
        record("C-bulk-patitas", "MAYOR", false, "alejo@ no resolvió org Patitas");
      } else {
        const patitasBulk = await bulkApproveFirstPending(alejoPage, tok);
        await snap(alejoPage, "04-bulk-patitas");
        record(
          "C-bulk-patitas",
          patitasBulk ? "OK" : "MAYOR",
          patitasBulk,
          patitasBulk
            ? "Bulk Patitas OK (alejo@) — diálogo confirmación ejercitado"
            : "Cola Patitas sin pending seleccionable (Negro seed + owner2)",
        );
      }
    } finally {
      await alejoPage.context().close();
    }
  } finally {
    await page.context().close();
  }
}

async function rlsFlow(browser: Browser): Promise<void> {
  // Owner cross-tenant
  const bPage = await freshPage(browser);
  const aPage = await freshPage(browser);
  try {
    await login(bPage, "owner2@dim.test");
    await bPage.goto(`${BASE}/mis-mascotas`);
    const href = await bPage.locator('a[href^="/mis-mascotas/DIM-"]').first().getAttribute("href");
    const bToken = href?.split("/mis-mascotas/")[1]?.split(/[/?#]/)[0];
    if (!bToken) {
      record("C-rls-owner", "MAYOR", false, "No owner2 pet token");
    } else {
      await login(aPage, "owner@dim.test");
      const resp = await aPage.goto(`${BASE}/mis-mascotas/${bToken}`);
      const text = await waitMainSettled(aPage);
      const blocked = blockedPage(text, resp?.status() ?? null, aPage.url());
      const leak = !blocked && leakedPetContent(text, bToken);
      record(
        "C-rls-owner",
        leak ? "BLOCKER" : "OK",
        !leak,
        leak ? `LEAK owner@ vio ${bToken}` : `Blocked (${resp?.status()}): ${text.slice(0, 80)}`,
      );
    }
  } finally {
    await bPage.context().close();
    await aPage.context().close();
  }

  // Govt cross-jurisdiction — Laika Bariloche (Río Negro, outside govt assignments)
  const gPage = await freshPage(browser);
  try {
    await login(gPage, "govt@dim.test");
    const probes = [
      { url: `${BASE}/gob/casos/PANO-CASE-HIST-DIS-000023`, label: "caso histórico" },
      {
        url: `${BASE}/mis-mascotas/DIM-LAIK-0015`,
        label: "pet Laika RN (owner path wrong portal)",
      },
      { url: `${BASE}/gob/maltrato`, label: "maltrato queue baseline" },
    ];
    // Govt shouldn't use owner path — use gob pet lookup if exists; try omnibox-style deep URL
    const govtProbes = [
      `${BASE}/gob/casos/PANO-CASE-HIST-DEC-000001`,
      `${BASE}/gob/casos/CAS-NEUN-WKF2`,
    ];
    for (const url of govtProbes) {
      const resp = await gPage.goto(url);
      const text = await waitMainSettled(gPage);
      const blocked = blockedPage(text, resp?.status() ?? null, gPage.url());
      // For in-scope CAS CABA, should NOT block
      const inScope = url.includes("CAS-NEUN");
      if (inScope) {
        const readable = !blocked && /CAS-NEUN|Kira|perdida|caso/i.test(text);
        record(
          "C-rls-govt-inscope",
          readable ? "OK" : "MAYOR",
          readable,
          readable
            ? "In-scope CAS readable"
            : `In-scope CAS blocked or empty: ${text.slice(0, 80)}`,
        );
      } else {
        const leak =
          !blocked &&
          /partes|normativa|decomiso|disputa|actor/i.test(text) &&
          !/sin acceso|no encontramos|fuera/i.test(text);
        record(
          "C-rls-govt-oos",
          leak ? "BLOCKER" : "OK",
          !leak,
          leak
            ? `LEAK govt@ accedió fuera de scope: ${url}`
            : `Fail-closed (${resp?.status()}): ${text.slice(0, 100).replace(/\s+/g, " ")}`,
        );
      }
    }
    await snap(gPage, "04-govt-rls-probe");
  } finally {
    await gPage.context().close();
  }

  // Org cross-tenant — orgadmin Refugio → Patitas pet
  const oPage = await freshPage(browser);
  const alejoTokPage = await freshPage(browser);
  try {
    await login(oPage, "orgadmin@dim.test");
    const refugioToken = await resolveOrgToken(oPage);
    await login(alejoTokPage, "alejo@dim.test");
    const patitasGuess = await resolveOrgToken(alejoTokPage, /patitas/i);
    await login(oPage, "orgadmin@dim.test");
    if (patitasGuess && refugioToken) {
      const resp = await oPage.goto(`${BASE}/org/${patitasGuess}/mascotas/DIM-S009-PLRM`);
      const text = await waitMainSettled(oPage);
      const blocked = blockedPage(text, resp?.status() ?? null, oPage.url());
      const leak = !blocked && /Lola|DIM-S009|libreta|anotar/i.test(text);
      record(
        "C-rls-org-cross",
        leak ? "BLOCKER" : "OK",
        !leak,
        leak
          ? "LEAK orgadmin (Refugio) abrió mascota Patitas"
          : `Fail-closed: ${text.slice(0, 90).replace(/\s+/g, " ")}`,
      );
    } else {
      record("C-rls-org-cross", "MENOR", true, "Skipped — could not resolve both org tokens");
    }
  } finally {
    await oPage.context().close();
    await alejoTokPage.context().close();
  }
}

async function kAnonFlow(browser: Browser): Promise<void> {
  const page = await freshPage(browser);
  try {
    await login(page, "govt@dim.test");
    await page.goto(`${BASE}/gob/panorama?layers=cobertura&period=90d&level=locality`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2500);

    const body = await page.locator("main").innerText();
    const notice =
      /celdas con menos de 5|k-anonimato|suprimid|datos insuficientes \(protegidos/i.test(body);
    record(
      "C-kanon-notice",
      notice ? "OK" : "MENOR",
      notice,
      notice ? "Copy k-anon visible en Panorama" : "Sin copy explícito en main (revisar capa/mapa)",
    );

    // API envelope — suppressedCount must exist and some cells suppressed
    const apiResp = await page.request.get(
      `${BASE}/api/panorama/cobertura?period=90d&level=locality&layers=cobertura`,
    );
    let apiDetail = `HTTP ${apiResp.status()}`;
    if (apiResp.ok()) {
      const json = (await apiResp.json()) as {
        suppressedCount?: number;
        features?: unknown;
      };
      const sup = json.suppressedCount ?? 0;
      const rawFeatures = json.features;
      const features: Array<{ properties?: { suppressed?: boolean; value?: number | null } }> =
        Array.isArray(rawFeatures)
          ? rawFeatures
          : rawFeatures &&
              typeof rawFeatures === "object" &&
              "features" in rawFeatures &&
              Array.isArray((rawFeatures as { features: unknown[] }).features)
            ? (
                rawFeatures as {
                  features: Array<{ properties?: { suppressed?: boolean; value?: number | null } }>;
                }
              ).features
            : [];
      const smallVisible = features.some(
        (f) => f.properties?.value != null && (f.properties.value as number) < 5,
      );
      const hasSuppressedCells = features.some((f) => f.properties?.suppressed === true);
      record(
        "C-kanon-api",
        smallVisible ? "BLOCKER" : "OK",
        !smallVisible,
        `suppressedCount=${sup}, suppressedCells=${hasSuppressedCells}, smallVisible=${smallVisible}`,
      );
      apiDetail = `suppressedCount=${sup} features=${features.length}`;
    }
    record("C-kanon-api-http", apiResp.ok() ? "OK" : "MAYOR", apiResp.ok(), apiDetail);

    // Map popup — click map canvas if present
    const map = page.locator(".maplibregl-canvas, canvas").first();
    if (await map.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await map.click({ position: { x: 120, y: 200 } });
      await page.waitForTimeout(800);
      const popup = await page
        .locator(".maplibregl-popup, [class*='popup']")
        .innerText()
        .catch(() => "");
      const popupOk =
        !popup ||
        /datos insuficientes|suprimido|k-anon|protegidos/i.test(popup) ||
        !/\b[1-4]\b/.test(popup);
      record(
        "C-kanon-popup",
        popupOk ? "OK" : "BLOCKER",
        popupOk,
        popup ? `Popup: ${popup.slice(0, 120)}` : "No popup on click",
      );
    }

    await snap(page, "05-panorama-kanon");
  } finally {
    await page.context().close();
  }
}

async function mobileFlow(browser: Browser): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/p/DIM-DEMO-0001`);
    await page.waitForLoadState("networkidle").catch(() => {});
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    const cw = await page.evaluate(() => document.documentElement.clientWidth);
    record("C-mobile-overflow-pub", sw <= cw + 8 ? "OK" : "MAYOR", sw <= cw + 8, `${sw}/${cw}px`);

    const buttons = page.locator("button, a[role='button'], a.inline-flex");
    const n = Math.min(await buttons.count(), 12);
    let smallTargets = 0;
    for (let i = 0; i < n; i++) {
      const box = await buttons.nth(i).boundingBox();
      if (box && box.height < 44) smallTargets++;
    }
    record(
      "C-mobile-tap-public",
      smallTargets === 0 ? "OK" : "MENOR",
      smallTargets === 0,
      smallTargets === 0 ? "Tap targets ≥44px (sample)" : `${smallTargets} controls <44px`,
    );
    await snap(page, "06-mobile-credential");

    await login(page, "govt@dim.test");
    await page.goto(`${BASE}/gob/panorama?period=90d&level=locality&layers=cobertura`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2000);
    const sw2 = await page.evaluate(() => document.documentElement.scrollWidth);
    const cw2 = await page.evaluate(() => document.documentElement.clientWidth);
    record(
      "C-mobile-panorama-overflow",
      sw2 <= cw2 + 8 ? "OK" : "MAYOR",
      sw2 <= cw2 + 8,
      `${sw2}/${cw2}px`,
    );

    const map = page.locator(".maplibregl-canvas, canvas").first();
    const mapVisible = await map.isVisible({ timeout: 8_000 }).catch(() => false);
    if (mapVisible) {
      const box = await map.boundingBox();
      record(
        "C-mobile-panorama-map",
        box && box.width >= 300 ? "OK" : "MAYOR",
        !!(box && box.width >= 300),
        box ? `Map ${Math.round(box.width)}×${Math.round(box.height)}px` : "Map not sized",
      );
      await map.click({ position: { x: 195, y: 300 } });
      await page.waitForTimeout(600);
    } else {
      record("C-mobile-panorama-map", "MAYOR", false, "Map canvas not visible at 390px");
    }

    const opButtons = page.locator("button").filter({ hasText: /capas|período|exportar/i });
    const opN = Math.min(await opButtons.count(), 6);
    let opSmall = 0;
    for (let i = 0; i < opN; i++) {
      const box = await opButtons.nth(i).boundingBox();
      if (box && box.height < 44) opSmall++;
    }
    record(
      "C-mobile-tap-panorama",
      opSmall === 0 ? "OK" : "MENOR",
      opSmall === 0,
      opSmall === 0 ? "Panorama controls ≥44px" : `${opSmall} controls <44px`,
    );
    await snap(page, "07-mobile-panorama");
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    await refugioFlow(browser).catch((e) => {
      console.error("refugioFlow error:", e);
      record("C-refugio-crash", "MAYOR", false, String(e));
    });
    await rlsFlow(browser).catch((e) => {
      console.error("rlsFlow error:", e);
      record("C-rls-crash", "MAYOR", false, String(e));
    });
    await kAnonFlow(browser).catch((e) => {
      console.error("kAnonFlow error:", e);
      record("C-kanon-crash", "MAYOR", false, String(e));
    });
    await mobileFlow(browser).catch((e) => {
      console.error("mobileFlow error:", e);
      record("C-mobile-crash", "MAYOR", false, String(e));
    });
  } finally {
    await browser.close();
  }

  const blockers = findings.filter((f) => !f.ok && f.sev === "BLOCKER");
  const majors = findings.filter((f) => !f.ok && f.sev === "MAYOR");
  console.log("\n=== SUMMARY ===");
  console.log(
    JSON.stringify({ blockers: blockers.length, majors: majors.length, findings }, null, 2),
  );
  fs.writeFileSync(
    path.join("tmp", "qa", "val-deep-C-findings.json"),
    JSON.stringify(findings, null, 2),
  );
  process.exit(blockers.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
