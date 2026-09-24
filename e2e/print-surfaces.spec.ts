import { expect, test } from "@playwright/test";

import { seedFixtureVerdict } from "./_seed-profile";
import { endSponsorship, pickSponsorablePetToken, sponsorPet } from "./_shelter-custody";
import { ACCOUNTS, loginAs } from "./demo/_helpers";

/**
 * Print-surface regression armor (print-surfaces audit, 2026-08-04).
 *
 * WHY THIS FILE EXISTS. Before it, `emulateMedia` appeared ZERO times in the
 * repo: nothing anywhere asserted how this product looks on paper. That is why
 * the poster defect survived — the lost-pet poster printed its headline
 * "PERDIDO" as white text on a colour block, and browsers default to
 * `print-color-adjust: economy` (Chrome's "Background graphics" checkbox is OFF
 * by default), so the background dropped and the single most important word on
 * the page printed white-on-white. Nobody saw it, because nobody sees a print
 * surface on screen.
 *
 * WHAT THESE TESTS CAN AND CANNOT DO. `emulateMedia({ media: "print" })` makes
 * the browser apply `@media print` rules, so we CAN assert which rules won. We
 * CANNOT observe the actual ink dropout: `print-color-adjust` does not change
 * `getComputedStyle().backgroundColor` — it changes what the print pipeline
 * does with it. So these tests assert the MECHANISM (is the opt-out declared on
 * the elements whose meaning depends on colour?) rather than the pixels. That
 * is the right fence anyway: the mechanism is what regressed.
 *
 * Conventions per e2e/README.md — tokens discovered at runtime, never
 * hardcoded; `test.skip` (not fail) when CI's fresh-seed DB lacks a fixture.
 */

/** Elements carrying light text on a solid colour must opt out of ink saving. */
async function printColorAdjustOf(page: import("@playwright/test").Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      // Chromium exposes the unprefixed property; keep the prefixed read as a
      // fallback so this does not silently return "" on other engines.
      return (
        cs.getPropertyValue("print-color-adjust") ||
        cs.getPropertyValue("-webkit-print-color-adjust")
      );
    });
}

test.describe("print surfaces keep the meaning that lives in colour", () => {
  test("the public credential opts out of ink saving under print media", async ({ page }) => {
    // Discover a real token from the public adoption listing (same convention
    // as crisis-public.spec.ts — never a hardcoded DB id).
    await page.goto("/adoptar");
    await page.waitForLoadState("networkidle").catch(() => {});
    const petLink = page.locator('a[href^="/adoptar/DIM"]').first();
    test.skip((await petLink.count()) === 0, "No adoptable pets seeded — no credential to print.");

    const href = await petLink.getAttribute("href");
    const token = (href ?? "").split("/").filter(Boolean).pop();
    test.skip(!token, "Could not derive a public token from the adoption listing.");

    await page.goto(`/p/${token}`);
    await expect(page.locator(".pc-cred")).toBeVisible();

    await page.emulateMedia({ media: "print" });

    // The situation chip is the SINGLE textual carrier of the pet's state since
    // the pet-state standardization (PO 2026-07-16) — the `.ln-sit` status line
    // was deliberately removed. For a lost pet the chip is white-on-red, so
    // without this opt-out a printed credential says nowhere that the pet is
    // lost. Asserted on the credential root, which is where the rule is scoped.
    expect(await printColorAdjustOf(page, ".pc-cred")).toBe("exact");
  });

  test("the sticky action bar does not print over the credential", async ({ page }) => {
    await page.goto("/adoptar");
    await page.waitForLoadState("networkidle").catch(() => {});
    const petLink = page.locator('a[href^="/adoptar/DIM"]').first();
    test.skip((await petLink.count()) === 0, "No adoptable pets seeded — no credential to print.");

    const href = await petLink.getAttribute("href");
    const token = (href ?? "").split("/").filter(Boolean).pop();
    test.skip(!token, "Could not derive a public token from the adoption listing.");

    await page.goto(`/p/${token}`);
    // The bar is mobile-only (`sm:hidden`), so give it a viewport where it
    // renders at all — otherwise this test would pass for the wrong reason.
    await page.setViewportSize({ width: 390, height: 780 });
    const bar = page.locator('[data-section="sticky-action-bar"]');
    test.skip((await bar.count()) === 0, "Action bar not rendered for this pet's state.");

    await page.emulateMedia({ media: "print" });

    // `position: fixed` + `bottom: 0` reprints the bar on top of the credential
    // on every page. credential-print.css hides `.no-print` under print media.
    await expect(bar.first()).toBeHidden();
  });
});

/**
 * Name the first ancestor of `selector` that would cut the printed document
 * short, or null when the chain is clean.
 *
 * A box clips iff it hides its overflow AND either (a) it actually has more
 * content than it shows (`scrollHeight > clientHeight`) or (b) it is
 * `position: fixed`, which bounds it to the viewport by construction whatever
 * its content does. Both halves matter: the operator shell's four nested boxes
 * are the (b) case at the top and the (a) case at the scroller.
 *
 * Returns a description rather than a boolean so a failure says WHICH box —
 * the whole point of the finding was that nobody could tell.
 */
async function clippingAncestorOf(
  page: import("@playwright/test").Page,
  selector: string,
): Promise<string | null> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      let node: HTMLElement | null = el.parentElement;
      while (node && node !== document.body) {
        const cs = getComputedStyle(node);
        const hidesOverflow =
          cs.overflow === "hidden" ||
          cs.overflowY === "hidden" ||
          cs.overflowY === "auto" ||
          cs.overflowY === "scroll";
        const bounded = cs.position === "fixed" || node.scrollHeight - node.clientHeight > 2;
        if (hidesOverflow && bounded) {
          const cls = typeof node.className === "string" ? node.className : "";
          return `<${node.tagName.toLowerCase()} class="${cls}"> (position: ${cs.position}, overflow-y: ${cs.overflowY})`;
        }
        node = node.parentElement;
      }
      return null;
    });
}

/**
 * The document must be tall enough to hold the print root. Under the PRN-3 bug
 * the root was `position: absolute` inside a `position: fixed` shell, so the
 * document stayed exactly one viewport tall no matter how long the case file
 * was — page 2 did not exist to print onto.
 */
async function documentContains(page: import("@playwright/test").Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const box = el.getBoundingClientRect();
      return {
        documentHeight: document.documentElement.scrollHeight,
        rootBottom: Math.round(box.bottom + window.scrollY),
      };
    });
}

test.describe("print surfaces are not clipped by the operator shell", () => {
  // PRN-3, CONFIRMED by the PO on 2026-08-04: printing /gob/maltrato/<id> from a
  // full page tab produced a PDF cut off at roughly one page. The mechanism:
  // expediente-print.css escaped the shell with `position: absolute`, but its
  // nearest POSITIONED ancestor is AppShell's `fixed inset-0 … overflow-hidden`
  // root, so the print root never left that viewport-height clipping box —
  // `visibility: hidden` on siblings does not remove an ancestor's overflow.
  //
  // Fixed 2026-08-05 by components/layout/operator-print-escape.css, which puts
  // the shell's four boxes back in normal flow under print media. These two
  // tests are the fence: they fail on the exact shape of the defect, on both
  // surfaces that wore the broken recipe.

  // A short viewport on purpose: every real expediente and every real informe is
  // taller than this, so "the document grew past one viewport" is a live
  // assertion here rather than a tautology on a sparse seed.
  test.use({ viewport: { width: 1280, height: 600 } });

  test("the maltrato expediente prints past page one", async ({ page }) => {
    await loginAs(page, ACCOUNTS.admin);
    await page.goto("/gob/denuncias?etapa=triage");
    await page.waitForLoadState("networkidle").catch(() => {});

    const row = page.locator('a[href^="/gob/maltrato/"]').first();
    const verdict = seedFixtureVerdict(
      await row.count(),
      "welfare report on /gob/denuncias",
      "the expediente's print layout (PRN-3, the Ley 14.346 case file that printed as one clipped page)",
    );
    test.skip(verdict.verdict === "skip", verdict.verdict === "skip" ? verdict.reason : "");
    expect(verdict.verdict, verdict.verdict === "fail" ? verdict.reason : "").not.toBe("fail");

    await page.goto((await row.getAttribute("href")) ?? "");
    await expect(page.locator("[data-print-root]")).toBeVisible();

    await page.emulateMedia({ media: "print" });

    const clipper = await clippingAncestorOf(page, "[data-print-root]");
    expect(clipper, `an ancestor still clips the expediente: ${clipper}`).toBeNull();

    const { documentHeight, rootBottom } = await documentContains(page, "[data-print-root]");
    expect(
      documentHeight,
      "the document is shorter than the expediente — everything past page 1 is unreachable",
    ).toBeGreaterThanOrEqual(rootBottom - 2);

    // The print-only footer is the LAST node of the case file and carries the
    // generation stamp + attribution. The audit's own repro instruction was
    // "count the pages, look for the footer": its absence WAS the defect.
    const footer = page.locator("[data-print-footer]");
    await expect(footer).toBeVisible();
    expect(await footer.boundingBox(), "the expediente footer has no layout box").not.toBeNull();
  });

  test("the panorama informe prints its method notes and k-anon disclosure", async ({ page }) => {
    // deferPrint() fires window.print() on a setTimeout; stub it so a headed run
    // does not park on a native dialog. The assertions are about the @media print
    // CASCADE, which emulateMedia gives us without printing anything.
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await loginAs(page, ACCOUNTS.govt);
    await page.goto("/gob/panorama");

    // The informe is mounted only once the operator generates it (PanoramaConsole
    // keeps it unmounted to avoid duplicating every KPI label in the a11y tree).
    // It lives behind the rail's "Exportar" panel.
    await page.getByRole("button", { name: "Exportar", exact: true }).first().click();
    await page
      .getByRole("button", { name: /Informe de situación/ })
      .first()
      .click();

    const informe = page.locator("[data-panorama-informe]");
    await expect(informe).toBeAttached();

    await page.emulateMedia({ media: "print" });
    await expect(informe).toBeVisible();

    const clipper = await clippingAncestorOf(page, "[data-panorama-informe]");
    expect(clipper, `an ancestor still clips the informe: ${clipper}`).toBeNull();

    const { documentHeight, rootBottom } = await documentContains(page, "[data-panorama-informe]");
    expect(
      documentHeight,
      "the document is shorter than the informe — the tail of the briefing cannot print",
    ).toBeGreaterThanOrEqual(rootBottom - 2);

    // The component's own docblock promises the method notes and the k-anon
    // disclosure are "always present here — never dropped". They sit in the
    // FOOTER, i.e. exactly the part a one-page truncation ate.
    await expect(informe.getByText("Acerca de las métricas")).toBeVisible();
    await expect(informe.getByText(/Fuente: miMAR/)).toBeVisible();
  });
});

/**
 * The adoption contract — the one print surface these tests can only reach
 * from the outside.
 *
 * WHY THERE IS NO `emulateMedia` ASSERTION HERE, unlike every other test in
 * this file. The contract is not a page you can navigate to. It is a POST-only
 * route handler (`/org/[orgToken]/mascotas/[publicToken]/adoption/contrato`)
 * that renders standalone HTML, and it is POST-only ON PURPOSE: the adopter's
 * DNI travels in the request BODY so it can never land in a URL, in browser
 * history, or in an access log. `page.goto` cannot open it, and no assertion
 * here may put a DNI in a URL to work around that.
 *
 * Driving the real trigger instead (the sibling <form> in FinalizeAdoptionForm)
 * needs a REGISTERED adopter whose `profiles.dni_hash` matches a DNI the spec
 * knows — the route re-resolves the adopter server-side and refuses anything
 * else. `pnpm db:bootstrap` never writes a dni_hash (`scripts/seed-test-users.ts`
 * leaves dni_number NULL on purpose); only `scripts/seed-demo-spine.ts` does.
 * So on CI's seed profile the rendered contract is unreachable at ANY price,
 * and hardcoding the demo spine's DNI would both break the "no hardcoded
 * fixtures" convention and pin PII into this file.
 *
 * The ink-level fence therefore lives where it can actually run:
 * `__tests__/adoption-contract-route.test.ts` asserts the rendered HTML
 * (draft marker verbatim, org/adopter/pet blocks, `window.print()`) against a
 * live DB with a seeded dni_hash. What that test CANNOT see is the HTTP wiring
 * — it imports and calls `POST()` directly. That is exactly the gap below: the
 * built app really does answer this method at this path, and the refusal path
 * really does render nothing.
 */
test.describe("the adoption contract print surface", () => {
  test("answers a real browser POST and renders no contract for an unresolvable adopter", async ({
    page,
    browser,
  }) => {
    // THE PET UNDER CUSTODY IS PROVISIONED HERE (T1-C3, 2026-09-18). This used
    // to take the first pet the seeded refugio listed, and on staging the
    // refugio held none — the suite had adopted them all out and nothing
    // reopened a custody — so the nightly was red on a missing fixture for 41
    // nights. The titular asks the refugio to sponsor one of their pets, the
    // org accepts (a live shelter custody this test owns), and the `finally`
    // below ends it through the titular's own "Dar de baja".
    test.setTimeout(120_000);
    await loginAs(page, ACCOUNTS.orgAdmin);
    const titularContext = await browser.newContext();
    const titular = await titularContext.newPage();
    let petToken = "";
    try {
      await loginAs(titular, ACCOUNTS.owner);
      petToken = await pickSponsorablePetToken(titular);
      const orgToken = await sponsorPet(titular, page, petToken);

      const contractUrl = `/org/${orgToken}/mascotas/${petToken}/adoption/contrato`;

      // `page.request` shares the browser context's cookies, so this POST carries
      // the orgadmin session the route's capability guard needs.
      const refused = await page.request.post(contractUrl, {
        // A syntactically valid DNI that resolves to no registered account: the
        // route must refuse BEFORE rendering anything.
        form: { adopterDni: "11111111", followupMonths: "", notes: "" },
      });
      const refusedBody = await refused.text();
      // Status only as a coarse signal — the surface is the assertion (e2e/README:
      // never pin a refusal on the exact status code).
      expect(refused.status(), "an unresolvable adopter must not get a contract").not.toBe(200);
      expect(refusedBody).not.toContain("Contrato de adopción");
      expect(refusedBody).not.toContain("window.print()");
      // 405 would mean the handler was never reached (wrong method wiring); the
      // route answers POST and refuses on its own terms.
      expect(refused.status(), "the route handler accepts POST").not.toBe(405);

      // GET is not an entry point: the DNI must never be expressible in a URL.
      const viaGet = await page.request.get(contractUrl);
      expect(viaGet.status(), "the contract must not be GET-addressable").not.toBe(200);
      expect(await viaGet.text()).not.toContain("window.print()");
    } finally {
      // Logged, not thrown: a cleanup failure must not replace the assertion
      // that brought us here, and the next sponsorship walk resets every
      // candidate pet first anyway.
      if (petToken) {
        await endSponsorship(titular, petToken).catch((err) =>
          console.error(`[print-surfaces] could not end the sponsorship of ${petToken}:`, err),
        );
      }
      await titularContext.close();
    }
  });
});
