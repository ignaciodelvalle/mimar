// C.4 — the drill-down affordance on /gob/panorama must be visible AND testable.
//
// The review reported "no visible way to drill from province to locality", then
// retracted it: the controls are real, labelled <select>s. What stayed open was
// the second half of the requirement — a test that reaches them.
//
// A previous attempt concluded "a tsx script sees the selects but a spec cannot"
// and tried anchored getByLabel, lax getByLabel, getByRole combobox, a forced
// 1440x900 viewport, and clicking the scope chip first. All failed, and the spec
// was deleted rather than committed red.
//
// The selects were never the problem. Measured 2026-07-29 against both a healthy
// server and the stale one the e2e config points at:
//
//   healthy  :3001 → 2 selects, 139x44, labelled Provincia / Localidad, visible
//   stale    :3000 → 2 selects present in the HTML, 120x19, ALSO Playwright-visible
//                    BUT: window.next undefined, stylesheets never applied
//
// The stale server serves HTML whose chunk hashes 400 (MIME text/html), so the
// page never hydrates. loginAs() then cannot finish: this app's login uses the
// N3 contract where a server action returns redirectTo and the CLIENT pushes it.
// With no hydration nothing pushes, waitForURL burns both its timeouts, and the
// spec dies on the login screen — never reaching /gob/panorama at all. "Cannot
// find the selects" was a downstream symptom of a dead server, not a selector
// problem, which is why every selector variant failed identically.
//
// Rebuild and restart before running this (docs/ops/local-dev-runbook.md).

import { expect, test } from "@playwright/test";

import { ACCOUNTS, loginAs } from "./demo/_helpers";

test.describe("panorama drill affordance (C.4)", () => {
  test("a govt operator can narrow scope from province to locality", async ({ page }) => {
    // govt-local@, NOT govt@ — and the account is part of the test, not a detail.
    //
    // This test narrows scope FROM province TO locality, which needs an operator
    // with more than one province to narrow from. `allowedProvinces` is derived
    // in app/gob/panorama/page.tsx from the distinct provinces of the operator's
    // assignments, and JurisdictionSwitcher emits <option value="">Todas</option>
    // only when `allowedProvinces.length > 1`. A single-province operator gets
    // exactly one option — the province's own name — which is CORRECT: there is
    // nothing to widen to. The component was never wrong here.
    //
    // govt@dim.test has one province, so the assertion below received 1, and the
    // "todas" assertion after it would have failed next. That is the defect from
    // commit 02330788b all over again — a spec asserting a surface with an
    // account structurally unable to reach it, measuring the FIXTURE instead of
    // the product. govt-local@ covers Buenos Aires (La Plata) and CABA
    // (Palermo), so the select renders "Todas" + two provinces and the drill is
    // actually exercised.
    //
    // SEED DRIFT, deliberately not repaired here: scripts/seed-test-users.ts
    // promises govt@ gets Ushuaia (Tierra del Fuego) + El Calafate (Santa Cruz)
    // via GOVT_REMOTE_LOCALITIES, and staging has neither — govt@ resolves to
    // CABA. Re-seeding does NOT fix it: provisionGovt wraps its whole assignment
    // loop in `if (currentRole !== "govt")`, so an already-provisioned profile
    // logs a skip and the assignment set is never reconciled. That needs its own
    // follow-up. Do not "helpfully" point this spec back at govt@ when it lands.
    await loginAs(page, ACCOUNTS.govtLocal);
    await page.goto("/gob/panorama");

    const province = page.getByLabel("Provincia", { exact: true });
    const locality = page.getByLabel("Localidad", { exact: true });

    // The selects are in the DOM from first paint but live inside a native
    // <details> disclosure that starts CLOSED, so Playwright correctly reports
    // them hidden. This is the state the earlier attempt kept hitting: the
    // locator always resolved and the element was always hidden, which reads as
    // "cannot find it" if you only read the error line instead of opening the
    // screenshot Playwright had already saved next to it.
    await expect(province).toBeAttached();

    // The operator's only entry point to the drill: a <summary> labelled
    // "Alcance". getByRole("button") does NOT match it — <summary> is a
    // disclosure, not a button, which is why every role-based attempt failed.
    const scopeDisclosure = page.locator("details:has(summary)", { hasText: "Alcance" }).first();
    const summary = scopeDisclosure.locator("summary").first();
    await expect(summary).toBeVisible();

    if (!(await province.isVisible())) {
      await summary.click();
    }

    await expect(province).toBeVisible();
    await expect(locality).toBeVisible();

    // Province offers the operator's own jurisdictions plus the "all" default.
    const provinceOptions = await province.locator("option").allTextContents();
    expect(provinceOptions.length).toBeGreaterThan(1);
    expect(provinceOptions[0]).toMatch(/todas/i);

    // Locality is DISABLED until a province is chosen — the drill is ordered, and
    // an operator cannot ask for a locality without saying where it is.
    await expect(locality).toBeDisabled();

    // Choosing a province enables the next level down. That is the drill.
    const firstReal = provinceOptions[1];
    await province.selectOption({ label: firstReal });
    await expect(locality).toBeEnabled();

    // And the choice reaches the URL, so the view is shareable and restorable.
    await expect
      .poll(() => new URL(page.url()).searchParams.toString(), { timeout: 10_000 })
      .toMatch(/prov/i);
  });
});
