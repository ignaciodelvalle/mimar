import { expect, test } from "@playwright/test";
import { ACCOUNTS, fullScroll, loginAs, panoramaMapBeat, showScreen, visit } from "./_helpers";

// SEGMENT 06 — ADMIN (admin@dim.test). READ-ONLY by PO decision: no moderation
// actions, no govt/admin user creation, no rule submissions. Fail-loud beats:
// /admin/panorama (map), /admin/alertas (fired sterilization alert),
// /admin/sistema (recently fixed crash), /admin/sistema/crons (21 crons),
// /admin/libro (event book with the seeded amendment chain).
test("segmento 06 — admin", async ({ page }) => {
  // 25m (up from 18m): the admin operator surfaces got heavier this week — the
  // dashboards now render more projections/tiles per page, so each networkidle
  // beat costs more and the journey COMPLETES right at the old 18m budget (its
  // failure screenshot was the LAST screen; perf audit 2026-07-09). The extra
  // headroom reflects the heavier surface, not a regression. Owner (02) stays
  // at 18m — it drives fewer operator pages.
  test.setTimeout(25 * 60_000);
  page.on("dialog", (d) => d.accept().catch(() => {}));

  await loginAs(page, ACCOUNTS.admin);

  // 1. Dashboard + Panorama (map beat, fail loud)
  await showScreen(page, "/admin");
  await panoramaMapBeat(page, "/admin/panorama");

  // 2. ANALÍTICA
  await showScreen(page, "/admin/programa");
  await showScreen(page, "/admin/censo");
  await showScreen(page, "/admin/adopciones");
  await showScreen(page, "/admin/poblacion");

  // 3. OPERACIONES
  // Alertas — fail loud: the fired sterilization-coverage alert is a core beat.
  await visit(page, "/admin/alertas");
  await expect(
    page.locator("h1", { hasText: "Bandeja de alertas" }),
    "alert inbox at /admin/alertas",
  ).toBeVisible();
  await fullScroll(page);

  await showScreen(page, "/admin/casos");

  // Moderación — list + ONE detail, NO moderation action on camera.
  await showScreen(page, "/admin/moderacion");
  const moderacionDetail = page.locator('a[href^="/admin/moderacion/"]').first();
  if (await moderacionDetail.count()) {
    await moderacionDetail.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page); // detail — action buttons stay untouched
  }

  await showScreen(page, "/admin/observaciones");

  // 4. CONFIABILIDAD
  // Sistema — fail loud: this page recently crashed and was fixed; the demo
  // must break if it regresses.
  await visit(page, "/admin/sistema");
  await expect(
    page.locator("h1", { hasText: "Salud del sistema" }),
    "system health at /admin/sistema",
  ).toBeVisible();
  await fullScroll(page);

  // Crons — fail loud: the 21-cron health list.
  await visit(page, "/admin/sistema/crons");
  await expect(
    page.locator("h1", { hasText: "Salud de crons" }),
    "cron health at /admin/sistema/crons",
  ).toBeVisible();
  await fullScroll(page);

  // Outbox — list + ONE delivery detail.
  await showScreen(page, "/admin/outbox");
  const outboxDetail = page.locator('a[href^="/admin/outbox/"]').first();
  if (await outboxDetail.count()) {
    await outboxDetail.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page);
  }

  await showScreen(page, "/admin/auditoria");

  // 5. IDENTIDAD Y ACCESO — lists only, NO /new creation forms on camera.
  // The nav's Identidad section also includes Usuarios and Organizaciones
  // (portal-follows-viewer copies), shown here beyond the draft's shot list.
  await showScreen(page, "/admin/usuarios");
  await showScreen(page, "/admin/govts");
  await showScreen(page, "/admin/admins");
  await showScreen(page, "/admin/organizaciones");

  // 6. GOBERNANZA
  // The draft's /admin/jurisdicciones was renamed — it now 308s to
  // /admin/reglas, which is the jurisdictions console (per nav-presets).
  await showScreen(page, "/admin/reglas");
  // Drill into one jurisdiction's rules list — NO "nueva regla" submission.
  const jurisdictionLink = page.locator('a[href^="/admin/reglas/AR"]').first();
  if (await jurisdictionLink.count()) {
    await jurisdictionLink.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await fullScroll(page);
  }

  await showScreen(page, "/admin/historial");

  // Libro de eventos — fail loud: the append-only ledger is a core beat.
  await visit(page, "/admin/libro");
  await expect(
    page.locator("h1", { hasText: "Libro de eventos" }),
    "event book at /admin/libro",
  ).toBeVisible();
  await fullScroll(page);
  // Amendment "ajá": if an amended row is on this page, scroll to it and
  // expand the correction chain (read-only fetch — not a mutation).
  const amendedBadge = page.getByText("Corregido por enmienda").first();
  if (
    await amendedBadge
      .count()
      .then((c) => c > 0)
      .catch(() => false)
  ) {
    await amendedBadge.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(800);
    await page
      .getByRole("button", { name: /ver correcci/i })
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(1_500);
  }
  // Filtered view: only the correction events themselves (best-effort).
  await showScreen(page, "/admin/libro?tipo=event_amended");

  // Servicios — in the nav's Gobernanza section (draft lists it too).
  await showScreen(page, "/admin/servicios");

  // 7. Mi Argentina integration explainer.
  await showScreen(page, "/admin/acerca/integracion-miarg");
});
