import { expect, test } from "@playwright/test";
import {
  ACCOUNTS,
  fullScroll,
  loginAs,
  panoramaMapBeat,
  showScreen,
  submitAndWait,
  visit,
} from "./_helpers";

// SEGMENT 05 — GOBIERNO (govt@dim.test). READ-MOSTLY by PO decision: these
// consoles act on real citizen data, so the recording NAVIGATES queues and
// opens detail pages but NEVER clicks approve/reject, triage, decomiso or
// rule-edit actions. The ONLY submission is the new outbreak investigation
// (additive by design — a fresh case is good on camera and harms nothing).
test("segmento 05 — gobierno", async ({ page }) => {
  test.setTimeout(18 * 60_000);
  page.on("dialog", (d) => d.accept().catch(() => {}));

  await loginAs(page, ACCOUNTS.govt);

  // 1. Panel + Panorama (map beat, fail loud) + Programa
  await showScreen(page, "/gob");
  await panoramaMapBeat(page, "/gob/panorama");
  await showScreen(page, "/gob/programa");

  // 2. VIGILANCIA SANITARIA — hub + surveillance sub-consoles.
  await showScreen(page, "/gob/vigilancia");
  await showScreen(page, "/gob/vigilancia/brotes");
  await showScreen(page, "/gob/vigilancia/zoonosis");
  await showScreen(page, "/gob/vigilancia/investigaciones");

  // 2a. NUEVA INVESTIGACIÓN — the one allowed submission (fail loud).
  // OpenInvestigationForm redirects to the case detail page on success,
  // which doubles as the /investigaciones/[caseCode] shot.
  await visit(page, "/gob/vigilancia/investigaciones/nuevo");
  await fullScroll(page);
  await page
    .locator("textarea#reason")
    .fill(
      "Aumento sostenido de notificaciones con nexo epidemiológico en la zona sur durante las últimas dos semanas. Se abre investigación para confirmar el vínculo.",
    );
  // Idempotent across re-records: one open investigation per disease per
  // jurisdiction is allowed, so walk the disease list until one submits
  // ("Ya existe una investigación abierta…" → try the next one). The
  // duplicate notice renders near-instantly (no navigation) — detect it
  // directly instead of paying submitAndWait's full click-retry budget
  // (10s wait + resubmit + 12s wait ≈ 22s) on every already-open disease.
  // With only 5 ENO diseases per jurisdiction and investigations additive
  // across recording runs, that tax alone can eat minutes once several are
  // already open (perf audit 2026-07-09: measured contributor to the 05
  // near-timeout — see e2e/demo/_helpers.ts submitAndWait for the #39
  // dropped-click workaround this still falls back to).
  const investigationUrl = (url: URL) =>
    url.pathname.startsWith("/gob/vigilancia/investigaciones/") && !url.pathname.endsWith("/nuevo");
  const dupNotice = page.locator("output", { hasText: /ya existe/i });
  const diseaseCount = await page.locator("select#diseaseCode option").count();
  const optionsTried = diseaseCount - 1; // index 0 is the "Seleccionar…" placeholder
  let opened = false;
  let duplicates = 0;
  for (let i = 1; i < diseaseCount && !opened; i++) {
    await page.locator("select#diseaseCode").selectOption({ index: i });
    await page.waitForTimeout(400);
    const openBtn = page.getByRole("button", { name: /abrir investigaci/i });
    await expect(openBtn, "submit button").toBeEnabled();
    await openBtn.click();
    // Race the two fast, expected outcomes before falling back to
    // submitAndWait's slower dropped-click resubmit workaround.
    const outcome = await Promise.race([
      page.waitForURL(investigationUrl, { timeout: 4_000 }).then(() => "opened" as const),
      dupNotice.waitFor({ state: "visible", timeout: 4_000 }).then(() => "duplicate" as const),
    ]).catch(() => "neither" as const);
    if (outcome === "opened") {
      opened = true;
    } else if (outcome === "duplicate") {
      duplicates++; // expected — this disease already has an open investigation.
    } else {
      // Neither signal showed up — possible dropped click (#39 workaround).
      try {
        await submitAndWait(page, openBtn, investigationUrl, 12_000);
        opened = true;
      } catch {
        const dup = await dupNotice.count().catch(() => 0);
        if (!dup)
          throw new Error(
            `investigation submit failed on disease index ${i} without a duplicate notice`,
          );
        duplicates++; // resolved to a duplicate after the resubmit fallback.
      }
    }
  }
  // PASS-with-note: the ENO catalog is locked at a handful of diseases (spec
  // ENO-D1) and manual investigations accumulate across recording runs, so the
  // govt jurisdiction's pool can be fully exhausted before a reseed resets it
  // (scripts/seed-panorama.ts). Passing requires EITHER a fresh investigation
  // opened OR every disease option showing the "ya existe" duplicate notice —
  // exhaustion is a data state, not a product failure (the open-flow was
  // exercised end to end either way).
  expect(
    opened || duplicates === optionsTried,
    "an investigation opened, OR every ENO disease already had one open (pool exhausted)",
  ).toBe(true);
  if (opened) {
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page); // investigation detail page
  } else {
    test.info().annotations.push({
      type: "note",
      description:
        "ENO pool exhausted — all diseases already under investigation this jurisdiction; open-flow proven via duplicate notices.",
    });
  }

  // 2b. Rest of the surveillance block (all read-only dashboards).
  // /gob/campanas is a performance dashboard — no create form exists, so it
  // is show-only (deviation from the draft script's "campanas ✎").
  await showScreen(page, "/gob/mortalidad");
  // F9 (2026-08-01): Analítica is the Programa hub's second vista.
  await showScreen(page, "/gob/programa?vista=analitica");
  await showScreen(page, "/gob/campanas");
  await showScreen(page, "/gob/outreach");
  await showScreen(page, "/gob/poblacion");

  // 3. CASOS Y CUMPLIMIENTO — lists + ONE maltrato detail, no actions.
  await showScreen(page, "/gob/casos");
  await showScreen(page, "/gob/maltrato");
  const maltratoDetail = page.locator('a[href^="/gob/maltrato/"]').first();
  if (await maltratoDetail.count()) {
    await maltratoDetail.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page); // triage detail — LOOK, do not touch the action buttons
  }
  await showScreen(page, "/gob/decomisos"); // list only — no /nuevo on camera
  await showScreen(page, "/gob/disputas");
  await showScreen(page, "/gob/perdidas");

  // 4. REGISTRO Y APROBACIONES — queue + ONE detail, NO approve/reject.
  await showScreen(page, "/gob/censo");
  await showScreen(page, "/gob/adopciones");
  await showScreen(page, "/gob/cola");
  const colaDetail = page.locator('a[href^="/gob/cola/"]').first();
  if (await colaDetail.count()) {
    await colaDetail.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page); // registration detail — decision buttons stay untouched
  }
  await showScreen(page, "/gob/organizaciones");
  await showScreen(page, "/gob/usuarios");
  await showScreen(page, "/gob/reglas"); // show only — no rule edits

  // 5. CONFIABILIDAD — /gob/sistema folded into /gob/programa for govt
  // (2026-07-09 audit); it now redirects there, so it's dropped from this
  // beat to avoid re-showing the same Programa screen twice.
  await showScreen(page, "/gob/outbox");

  // 6. REFERENCIA
  await showScreen(page, "/gob/servicios");
  await showScreen(page, "/gob/historial");
});
