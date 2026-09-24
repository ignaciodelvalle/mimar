import { type Page, expect, test } from "@playwright/test";

import { ACCOUNTS, loginAs, walkDenunciaWizard } from "./demo/_helpers";

// Admin half of the task #47 shell-loss class (sibling of
// e2e/gob-case-detail-shell.spec.ts). Only the govt half was fixed then: admin
// kept linking cases at the public /casos/[code], so a national operator
// opening a case still dropped out of the operator shell into the citizen
// chrome.
//
// QA ronda 5 (2026-07-16) caught it from the outside: the tester opened a
// denuncia from /admin/casos, got "Adoptar · Mascotas perdidas · Refugios ·
// Denuncias · ← Volver a mi app", found zero operator actions, and reported
// being unable to do the job at all.
//
// Admin has universal scope, so any case serves. It is READ FROM THE QUEUE
// rather than hardcoded: this spec used to pin "CAS-99DF-75CC", a code from an
// old seed that no longer exists — measured, 5595 cases in the database and not
// that one — so every assertion below was being made against a 404 page whose
// heading is "No encontramos esta página". Nobody saw it because the e2e suite
// had not run in CI since 2026-06-12.
//
// Taking the first row of the operator's own queue also makes the case in-scope
// by construction, which is stronger than trusting a literal to stay in scope.
//
// ─── WHY THIS SPEC NOW CREATES ITS OWN CASE ────────────────────────────────
// Reading from the queue fixed the stale-literal problem and introduced a
// quieter one: it assumes the queue is not empty. On this machine it never is
// (thousands of accumulated cases), and on a freshly bootstrapped CI database
// it always is — `pnpm db:bootstrap` seeds reference data and test users, and
// no case anywhere. So the first CI run that reported a verdict failed here
// with "at least one case in the admin queue", and the fixture the spec needs
// had simply never existed outside a developer's laptop.
//
// A denuncia is the real origin of a case: create-welfare-report.ts opens a
// `welfare_denuncia` case in the same transaction as the report. So the spec
// walks the public citizen wizard when the queue is empty — the same path a
// real first case takes — rather than skipping, or asking CI to carry the
// demo seed.
const ADMIN_CASE_LINK = 'a[href^="/admin/casos/"]';

/** Guarantee at least one case exists, creating one the way citizens do. */
async function ensureAtLeastOneCase(page: Page): Promise<void> {
  await page.goto("/admin/casos");
  await page.waitForLoadState("networkidle").catch(() => {});
  if ((await page.locator(ADMIN_CASE_LINK).count()) > 0) return;

  // Anonymous denuncia → welfare_denuncia case. Not flagged: a flagged report
  // is held for moderation, and this spec is about the case shell, not triage.
  const context = await page.context().browser()?.newContext();
  if (!context) throw new Error("no browser context available to file a denuncia");
  try {
    const anon = await context.newPage();
    const code = await walkDenunciaWizard(anon);
    expect(code, "denuncia filed to seed the admin case queue").toBeTruthy();
  } finally {
    await context.close();
  }

  await page.goto("/admin/casos");
  await page.waitForLoadState("networkidle").catch(() => {});
}

test("admin case detail keeps the operator shell", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ACCOUNTS.admin);
  await ensureAtLeastOneCase(page);

  const queueLink = page.locator(ADMIN_CASE_LINK).first();
  await expect(queueLink, "at least one case in the admin queue").toBeVisible();
  const CASE_CODE = ((await queueLink.getAttribute("href")) ?? "").split("/").pop() ?? "";
  expect(CASE_CODE, "case code read from the queue").not.toBe("");

  // 1. Direct navigation to the admin-scoped case detail must NOT redirect away
  //    (out-of-shell to /casos, or bounced by an auth gate).
  await page.goto(`/admin/casos/${CASE_CODE}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  expect(new URL(page.url()).pathname).toBe(`/admin/casos/${CASE_CODE}`);

  // 2. Operator rail is present (an /admin nav link only the operator shell
  //    renders — the admin analogue of the gob spec's /gob/panorama probe).
  // Prefix match, not exact: nav-presets renders the rail link with a preset
  // query (/admin/panorama?preset=bienestar&period=90d) — the gob spec's probe
  // already matched by prefix for the same reason.
  await expect(page.locator('a[href^="/admin/panorama"]').first()).toBeVisible();

  // 3. The public citizen browse nav is ABSENT — the exact chrome the bug
  //    exposed to the QA tester.
  await expect(page.locator('a[href="/adoptar"]')).toHaveCount(0);
  await expect(page.locator('a[href="/refugios"]')).toHaveCount(0);
  await expect(page.getByText("Volver a mi app")).toHaveCount(0);

  // 4. The case CONTENT is preserved (the shared CaseDetailView renders the
  //    case code + the timeline heading).
  await expect(page.getByText(CASE_CODE).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Línea de tiempo" })).toBeVisible();

  // 5. Clicking through from the list lands on the in-shell detail route — the
  //    queue row's detailHref, which is what actually regressed.
  await page.goto("/admin/casos");
  await page.waitForLoadState("networkidle").catch(() => {});
  const firstDetail = page.locator('a[href^="/admin/casos/"]').first();
  if (await firstDetail.count()) {
    const href = await firstDetail.getAttribute("href");
    expect(href).toMatch(/^\/admin\/casos\//);
  }
  // No queue row may point at the public citizen route.
  await expect(page.locator('a[href^="/casos/"]')).toHaveCount(0);
});
