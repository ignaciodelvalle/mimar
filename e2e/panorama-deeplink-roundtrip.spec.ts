import { type Page, expect, test } from "@playwright/test";

import { ACCOUNTS, loginAs } from "./demo/_helpers";

/**
 * Panorama deep-link fidelity — a shared view URL must reproduce the view.
 *
 * Panorama's product identity is explore → understand → EXPORT (engram
 * `panorama/product-identity`). "Compartir vista" is that export, so a URL that
 * silently reproduces a DIFFERENT board is the one defect that invalidates the
 * instrument. Item A1 of the map plan
 * (dim-interno:docs/design/sdd/2026-07-25-panorama-mapa-todas-las-mejoras.md) called this
 * the mission-central bug; on 2026-07-25 it did not reproduce on HEAD. This
 * spec exists so it cannot regress in silence — the plan item became a lock,
 * not a fix.
 *
 * The reopen is deliberately harsher than a reload: localStorage is cleared
 * first, so the saved board can never stand in for a broken URL restore. That
 * is the real scenario — a colleague opening YOUR link has no board of yours.
 *
 * Runs against the already-running QA server:
 *   pnpm exec playwright test e2e/panorama-deeplink-roundtrip.spec.ts \
 *     --config=playwright.local3000.config.ts
 */

const DOCK = '[data-testid="panorama-dock"]';

/** Board summary line: "Nacional · todas las provincias · últimos 90 días · 2 capas". */
const SUMMARY_RE = /^.*·.*(?:capa|capas)$/m;

/** "Registros" total as rendered in the dock tab strip. */
const REGISTROS_RE = /Registros\s+([\d.]+)/;

type Board = { summary: string; registros: string };

async function readBoard(page: Page): Promise<Board> {
  const dock = page.locator(DOCK).first();
  await expect(dock, "panorama dock").toBeVisible({ timeout: 30_000 });

  // The dock renders BEFORE the layer fetches land, so a single read races the
  // data and reports "Registros 0" on a perfectly healthy board. Wait for the
  // value to SETTLE (two consecutive equal reads) instead of waiting for it to
  // be non-zero — an honest empty board must still be allowed to report 0.
  const read = async (): Promise<Board> => {
    const text = await dock.innerText();
    return {
      summary: text.match(SUMMARY_RE)?.[0].trim() ?? "",
      registros: text.match(REGISTROS_RE)?.[1] ?? "",
    };
  };

  let previous = await read();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const current = await read();
    if (
      current.summary !== "" &&
      current.summary === previous.summary &&
      current.registros === previous.registros
    ) {
      return current;
    }
    previous = current;
  }
  return previous;
}

/** Wipe the saved board so the URL is the ONLY source of the reopened view. */
async function clearSavedBoard(page: Page): Promise<void> {
  await page.evaluate(() => window.localStorage.clear());
}

test.describe("panorama — deep-link fidelity", () => {
  test("a copied view URL reopens as the same board (no saved-board assist)", async ({ page }) => {
    test.setTimeout(180_000);
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await loginAs(page, ACCOUNTS.admin);

    // (1) Land on Panorama and let the console write its own state into the URL
    // — that IS the URL an operator copies.
    await page.goto("/admin/panorama", { waitUntil: "domcontentloaded" });
    const before = await readBoard(page);
    const sharedUrl = page.url();

    // The written URL must actually carry the board's coordinates, or the
    // round-trip below would pass for the wrong reason (a bare URL reopening
    // as the same role default).
    expect(sharedUrl, "copied URL carries the layer set").toContain("layers=");

    // (2) Reopen it the way a colleague would: same session, no board memory.
    await clearSavedBoard(page);
    await page.goto(sharedUrl, { waitUntil: "domcontentloaded" });
    const after = await readBoard(page);

    // Guard against a vacuous pass: readBoard returns "" on timeout, and
    // "" === "" would satisfy the comparison below while asserting nothing
    // (correctness review 2026-07-25). Prove the board was READ before
    // comparing it.
    expect(before.summary, "board summary was actually read").not.toBe("");
    expect(before.registros, "Registros was actually read").not.toBe("");
    expect(after.summary, "scope · period · layer count reproduce").toBe(before.summary);
    expect(after.registros, "Registros total reproduces").toBe(before.registros);
    expect(consoleErrors, "no console errors across the round trip").toEqual([]);
  });

  test("a preset + province deep-link reopens scoped, not national", async ({ page }) => {
    test.setTimeout(180_000);

    await loginAs(page, ACCOUNTS.admin);
    // Province scope travels as an ISO code through `provinceByCode`
    // (lib/reference/ar-provincias.ts) — NOT as a slug.
    //
    // THE LAYER SET IS LEDGER, NOT DECORATION. This deep-link used to ask for
    // `preset=cumplimiento&layers=cobertura,microchip`, and then demanded the
    // summary read "3 años". Both of those layers are `temporal: false`
    // (src/modules/panorama/domain/layers.ts), and `buildViewMeta` deliberately
    // renders "estado actual" instead of a window when EVERY active layer is
    // current-state — a documented rule (commit 6c39a264, F-4 of the panorama
    // semantics critique: never stamp a period over a number that does not move
    // with it). So the assertion was demanding a label the product is designed
    // not to print, and the period restore it meant to protect was never
    // actually observable on that board. `denuncias` is a `temporal: true`
    // layer, so here the window is real and "3 años" is the honest rendering.
    const url =
      "/admin/panorama?preset=cumplimiento&layers=denuncias%2Cmicrochip&period=3y&province=AR-B";

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await clearSavedBoard(page);
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const board = await readBoard(page);
    expect(board.summary, "reopens scoped to Buenos Aires").toContain("Buenos Aires");
    expect(board.summary, "reopens with both requested layers").toContain("2 capas");
    expect(board.summary, "reopens on the requested window").toContain("3 años");
    // The period COORDINATE must survive the round trip too, independently of
    // how the dock chooses to label it.
    expect(page.url(), "period survives the deep-link round trip").toContain("period=3y");
  });
});
