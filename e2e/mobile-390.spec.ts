import { type Page, expect, test } from "@playwright/test";

import { ACCOUNTS, loginAs } from "./demo/_helpers";

// Mobile layout at 390px — the coverage hole manual QA could not reach.
//
// WHY A SPEC AND NOT A MANUAL PASS: Chrome on Windows refuses to size a window
// below ~657px, so the 2026-08-07 QA session bottomed out at a 642px viewport
// and said so honestly. 642 is ABOVE Tailwind's `sm` breakpoint (640), so every
// "no horizontal scroll" result from that session describes the TABLET layout.
// The base mobile layout — the one a citizen scanning a QR on the street
// actually gets — had never been looked at. Zooming `documentElement` does not
// substitute: it scales the render but `clientWidth` still reports 642, so the
// media queries never change branch.
//
// Playwright sets the viewport per browser CONTEXT, not per OS window, so it is
// not bound by that floor. 390×844 is the iPhone 12/13/14 logical viewport and
// the narrowest mainstream phone worth defending.
test.use({ viewport: { width: 390, height: 844 } });

/**
 * Horizontal overflow check.
 *
 * `scrollWidth > clientWidth` on the documentElement means the PAGE scrolls
 * sideways — the failure the house style forbids outright. Wide content
 * (tables, charts, code) is allowed to scroll, but only inside its own
 * `overflow-x` container, which does not move the document.
 *
 * The 1px tolerance absorbs sub-pixel rounding on fractional layouts; anything
 * a person could notice is far above it.
 */
async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(
    overflow.scrollWidth - overflow.clientWidth,
    `${label} scrolls horizontally at 390px (scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(1);
}

/**
 * Returns controls under `floor` px tall, as `tag[name] HxW` strings.
 *
 * TWO FLOORS, ON PURPOSE — matching the rule the design system actually holds
 * (see the density note in components/ui/dashboard/OpField.tsx):
 *
 *  - **Fields** (input/select/textarea) answer to **44px**. That is the rule
 *    components/ui/Field.tsx has enforced since Wave 2 and that OpField now
 *    mirrors.
 *  - **Buttons and links** answer to **24px**, the WCAG 2.5.8 AA target-size
 *    minimum. Neither LnButton nor OpButton carries a 44px floor, deliberately.
 *
 * The first version of this helper asserted 44px on everything and failed on
 * four topbar controls (40×40 icon buttons, a 25px jurisdiction chip, a 32×32
 * submit) — all of which clear AA. It was the TEST encoding a stricter rule
 * than the one we shipped, not a product defect. Keep the two floors separate.
 *
 * Only VISIBLE controls count: an offscreen `sr-only` input (OpFileInput's
 * native control is one) is not a touch target, and flagging it would train
 * people to ignore this test.
 */
async function undersizedControls(
  page: Page,
  scope: string,
  kind: "fields" | "buttons",
  floor: number,
): Promise<string[]> {
  return page.evaluate(
    ({ scope, kind, floor }) => {
      const SELECTOR =
        kind === "fields"
          ? `${scope} input, ${scope} select, ${scope} textarea`
          : `${scope} button, ${scope} a[href]`;

      /** Everything this sweep deliberately does not measure. */
      const exempt = (el: Element, style: CSSStyleDeclaration, box: DOMRect): boolean => {
        if (style.display === "none" || style.visibility === "hidden") return true;
        // sr-only controls are driven by a visible proxy (a <label>), which this
        // sweep measures on its own.
        if (style.position === "absolute" && el.clientWidth <= 1) return true;
        if (box.width === 0 || box.height === 0) return true;
        // Inline text links inherit the line box and are exempt from 2.5.5 by the
        // "inline" exception — only measure controls that carry their own box.
        return el.tagName === "A" && style.display.startsWith("inline");
      };

      const describe = (el: Element, box: DOMRect): string => {
        const name = el.getAttribute("name") ?? el.getAttribute("type") ?? "";
        return `${el.tagName.toLowerCase()}${name ? `[${name}]` : ""} ${Math.round(box.height)}x${Math.round(box.width)}`;
      };

      return Array.from(document.querySelectorAll(SELECTOR))
        .map((el) => ({ el, style: getComputedStyle(el), box: el.getBoundingClientRect() }))
        .filter(({ el, style, box }) => !exempt(el, style, box) && box.height < floor)
        .map(({ el, box }) => describe(el, box));
    },
    { scope, kind, floor },
  );
}

// ---------------------------------------------------------------------------
// Public surfaces — no auth, so no login rate limit is involved (README §rate
// limits). These are the routes a citizen reaches from a QR code or a search.
// ---------------------------------------------------------------------------

const PUBLIC_ROUTES: ReadonlyArray<{ path: string; label: string }> = [
  { path: "/", label: "landing" },
  { path: "/adoptar", label: "adopción" },
  { path: "/perdidas", label: "perdidas" },
  { path: "/denuncias/nueva", label: "denuncia nueva" },
  { path: "/iniciar-sesion", label: "iniciar sesión" },
];

for (const route of PUBLIC_ROUTES) {
  test(`${route.label} no scrollea horizontal a 390px`, async ({ page }) => {
    const response = await page.goto(route.path);

    // THE PAGE HAS TO EXIST FIRST. This spec originally listed
    // `/iniciar-sesion` — a route that did not exist at the time — and PASSED,
    // because a 404 page has no horizontal scroll either. It asserted layout on
    // a page that was never rendered (found by QA 2026-08-08, S1-F06; the route
    // now exists, and the guard stays so the next dead path fails loudly).
    //
    // Status alone is not enough on this app: streaming routes flush the shell
    // before a scoped lookup resolves, so a not-found can answer 200 with the
    // branded boundary (e2e/README.md). Assert BOTH — a non-error status and
    // the absence of the not-found surface.
    expect(response?.status(), `${route.path} no respondió OK`).toBeLessThan(400);
    await expect(
      page.getByText(/no encontramos esta página/i),
      `${route.path} cayó en el 404`,
    ).toHaveCount(0);

    await expectNoHorizontalScroll(page, route.label);
  });
}

test("la credencial pública no scrollea horizontal a 390px", async ({ page }) => {
  // Discover a real token from a real page — never hardcode one (README).
  await page.goto("/adoptar");
  const href = await page
    .locator('a[href^="/adoptar/DIM"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  test.skip(
    href === null,
    "seed has no adoption listing — no public token to resolve a credential from",
  );
  const token = href?.split("/").pop();
  await page.goto(`/p/${token}`);
  await expectNoHorizontalScroll(page, "credencial pública");
});

// ---------------------------------------------------------------------------
// Operator forms — the two surfaces whose control heights this change moved.
// They are desktop-first by intent, but "desktop-first" is not "unusable on a
// phone": an inspector filing a decomiso is standing in the street.
// ---------------------------------------------------------------------------

test("el formulario de decomiso respeta el piso táctil de 44px", async ({ page }) => {
  await loginAs(page, ACCOUNTS.govt);
  await page.goto("/gob/decomisos/nuevo");
  await expect(page.getByRole("heading", { name: /sujeto del decomiso/i })).toBeVisible();

  await expectNoHorizontalScroll(page, "decomiso nuevo");

  // Scoped to the form's own sections, not all of `main` — the operator topbar
  // renders inside main, and its icon buttons are chrome, not form controls.
  const FORM = "main section";

  const fields = await undersizedControls(page, FORM, "fields", 44);
  expect(fields, `campos bajo el piso tactil de 44px: ${fields.join(", ")}`).toEqual([]);

  const buttons = await undersizedControls(page, "main", "buttons", 24);
  expect(buttons, `controles bajo el minimo WCAG 2.5.8 AA de 24px: ${buttons.join(", ")}`).toEqual(
    [],
  );
});

test("el wizard de import CSV muestra el disparador de archivo en es-AR", async ({ page }) => {
  await loginAs(page, ACCOUNTS.orgAdmin);
  // The org token is discovered, not hardcoded — and note org tokens are
  // `DIM-`-prefixed too, so capture the segment after /org/ specifically.
  await page.goto("/org");
  const orgHref = await page
    .locator('a[href^="/org/DIM"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  test.skip(orgHref === null, "no org reachable for this account");
  const orgToken = orgHref?.split("/")[2];

  await page.goto(`/org/${orgToken}/intake/importar`);

  // The regression this locks: the native control renders its trigger in the
  // BROWSER's language ("Choose File"), which an es-AR product must not ship.
  await expect(page.getByText("Elegir archivo", { exact: true })).toBeVisible();
  await expect(page.getByText(/choose file/i)).toHaveCount(0);
  await expectNoHorizontalScroll(page, "import CSV");
});
