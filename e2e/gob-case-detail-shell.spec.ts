import { expect, test } from "@playwright/test";

import {
  ACCOUNTS,
  USHUAIA_JURISDICTION,
  USHUAIA_POINT,
  expectQueueRow,
  fileDenunciaAt,
  loginAs,
} from "./demo/_helpers";

// Task #47 regression: a government operator opening a case from /gob must
// STAY inside the operator shell (rail + topbar), not be dropped into the
// public citizen chrome. The case row used to link at /casos/[code] (citizen
// layout); it now links at /gob/casos/[code] (operator layout).
//
// The in-scope case is READ FROM THE OPERATOR'S OWN QUEUE, not hardcoded. This
// spec used to pin "CAS-99DF-75CC", a code from an old seed that no longer
// exists (measured: 5595 cases in the database, not that one), so its
// assertions were being made against a 404 whose heading is "No encontramos
// esta página". Its admin sibling had the same literal and the same silence.
//
// A row from govt@dim.test's own queue is in-scope by construction, which is a
// stronger guarantee than a literal that has to stay in scope forever.
// ─── WHY THIS SPEC NOW CREATES ITS OWN CASE ────────────────────────────────
// Reading from the queue fixed the stale-literal problem and left a quieter
// one: it assumes the queue is not empty. On the PO's machine it never is
// (thousands accumulated); on a freshly bootstrapped CI database it always is —
// `pnpm db:bootstrap` seeds reference data and test users and NOT ONE case. So
// the first CI run that reported a verdict failed on "at least one case in the
// govt queue", and the fixture had simply never existed outside a laptop.
// Its admin sibling (admin-case-detail-shell) already files a denuncia for the
// same reason; this is that, plus the jurisdiction the admin half can ignore.
//
// ⚠ A govt queue is jurisdiction-fenced (listCasesForGovt ANDs an exact
// province/locality pair), so the denuncia must be filed INSIDE this
// operator's coverage — ACCOUNTS.govt is seeded on Ushuaia + El Calafate,
// hence USHUAIA_POINT. See fileDenunciaAt for the Nominatim caveat.
test("govt case detail keeps the operator shell", async ({ browser, page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ACCOUNTS.govt);

  await page.goto("/gob/casos");
  await page.waitForLoadState("networkidle").catch(() => {});
  if ((await page.locator('a[href^="/gob/casos/"]').count()) === 0) {
    await fileDenunciaAt(browser, USHUAIA_POINT, USHUAIA_JURISDICTION);
    await page.goto("/gob/casos");
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  const href = await expectQueueRow(
    page,
    'a[href^="/gob/casos/"]',
    "at least one case in the govt queue",
  );
  const IN_SCOPE_CASE = href.split("/").pop() ?? "";
  expect(IN_SCOPE_CASE, "case code read from the queue").not.toBe("");

  // 1. Direct navigation to the gob-scoped case detail must NOT redirect away
  //    (out-of-shell to /casos, or bounced to / by an auth gate).
  await page.goto(`/gob/casos/${IN_SCOPE_CASE}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  expect(new URL(page.url()).pathname).toBe(`/gob/casos/${IN_SCOPE_CASE}`);

  // 2. Operator rail is present (a /gob nav link only the operator shell renders).
  // T1.5: the Panorama nav href now pins ?preset&period — match by prefix.
  await expect(page.locator('a[href^="/gob/panorama"]').first()).toBeVisible();

  // 3. The public citizen browse nav is ABSENT — this is the exact chrome the
  //    bug exposed ("Adoptar / Mascotas perdidas / Refugios / Denuncias" plus
  //    the "← Volver a mi app" escape link).
  await expect(page.locator('a[href="/adoptar"]')).toHaveCount(0);
  await expect(page.locator('a[href="/refugios"]')).toHaveCount(0);
  await expect(page.getByText("Volver a mi app")).toHaveCount(0);

  // 4. The case CONTENT is preserved (the shared CaseDetailView renders the
  //    case code + the timeline heading).
  await expect(page.getByText(IN_SCOPE_CASE).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Línea de tiempo" })).toBeVisible();

  // 5. Clicking through from the list lands on the in-shell detail route.
  await page.goto("/gob/casos");
  await page.waitForLoadState("networkidle").catch(() => {});
  const firstDetail = page.locator('a[href^="/gob/casos/"]').first();
  if (await firstDetail.count()) {
    const href = await firstDetail.getAttribute("href");
    expect(href).toMatch(/^\/gob\/casos\//);
  }
});
