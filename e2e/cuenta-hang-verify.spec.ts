import { expect, test } from "@playwright/test";

import { ACCOUNTS, loginAs } from "./demo/_helpers";

// Task #50 verification: /cuenta must render its content (not stay on the
// "Cargando…" loading skeleton), and "Cerrar sesión" must be reachable from the
// global chrome (avatar menu) — independent of /cuenta rendering.

test("owner /cuenta renders content, not the Cargando… skeleton", async ({ page }) => {
  await loginAs(page, ACCOUNTS.owner);
  await page.goto("/cuenta");

  // The page heading proves the RSC resolved (loading.tsx renders no <h1>).
  await expect(page.getByRole("heading", { level: 1, name: "Mi cuenta" })).toBeVisible({
    timeout: 6_000,
  });
  await expect(page.getByText("Datos de la cuenta")).toBeVisible();

  // The loading skeleton's sr-only "Cargando…" text must be gone.
  await expect(page.locator('output[aria-label="Cargando…"]')).toHaveCount(0);
});

// Was pinned to ACCOUNTS.vetOrgAdmin (alejo@dim.test). That account exists only
// after the demo seed chain, which CI never runs — `pnpm db:bootstrap` stops at
// scripts/seed-test-users.ts — so in CI the login simply never succeeded and the
// test died on the 30s hook timeout with no hint as to why. What this test
// actually needs is "an account whose /org entry point resolves through the
// org surface", and orgadmin@dim.test (admin of "Refugio Test (Seed)") is that,
// on the fixture tier bootstrap guarantees.
test("org-admin /cuenta renders after the org-selector path", async ({ page }) => {
  await loginAs(page, ACCOUNTS.orgAdmin);
  // Reproduce the reported recovery path: enter via /org then land on /cuenta.
  await page.goto("/org").catch(() => {});
  await page.goto("/cuenta");
  await expect(page.getByRole("heading", { level: 1, name: "Mi cuenta" })).toBeVisible({
    timeout: 6_000,
  });
});

test("Cerrar sesión is reachable from the masthead avatar menu", async ({ page }) => {
  await loginAs(page, ACCOUNTS.owner);
  await page.goto("/inicio");

  // Open the avatar menu in the global chrome (not /cuenta).
  await page.getByRole("button", { name: "Menú de cuenta" }).click();
  // RA-9 BR-4 removed role="menu"/"menuitem" from this popover: it is a list of
  // links and a logout form, and role="menu" contracts arrow-key roving and
  // typeahead that were never implemented. Logout has always been a <form>'s
  // submit button, so its real role is `button`.
  const logout = page.getByRole("button", { name: "Cerrar sesión" });
  await expect(logout).toBeVisible();

  // Actually sign out and confirm we leave the authenticated area.
  await logout.click();
  await page.waitForURL((url) => !url.pathname.startsWith("/inicio"), { timeout: 15_000 });
});
