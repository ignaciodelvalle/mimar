import { type Page, expect, test } from "@playwright/test";

import { resolveStagingUrl } from "./_base-url";
import { PALERMO_POINT, placePointByAddress, uniqueIp } from "./demo/_helpers";

/**
 * P4 — who receives found animals nearby (design note
 * docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md).
 *
 * Fixtures (scripts/seed-test-users.ts → seedFoundAnimalReceivers, bootstrap
 * tier): a verified shelter that receives found animals and a verified clinic
 * listed in the public directory, both in Palermo, a few km from the seeded
 * lost pet and from the map's default centre. So the lists are ASSERTED, never
 * skipped: if the seed stops publishing them this spec goes red.
 *
 * The /encontre walks write a real finder report on the seeded lost pet (the
 * only one the bootstrap tier guarantees). Each walk uses its own contact, so
 * the action's 5-minute idempotency guard never folds one into the other, and
 * its own `x-real-ip`, so the 1/min per-(IP, token) budget is not shared.
 *
 * LOCAL TARGET ONLY for the walks that WRITE or need the P4 fixtures: against
 * a deployed origin (the nightly staging pass picks up every spec here) the
 * edge overwrites `x-real-ip`, so two walks a minute apart from one egress
 * address trip the per-(IP, token) budget, they would file real finder reports
 * on a real lost pet, and the fixtures exist only where this seed ran. The
 * skip branches on the ENVIRONMENT, never on the data (e2e/README.md). The
 * page's structure and its two entry points are checked everywhere.
 */
const LOCAL_ONLY_REASON =
  "Writes finder reports and needs the P4 seed fixtures — local target only (STAGING_URL is set).";
const ON_STAGING = resolveStagingUrl() !== null;

const RECEIVER = "Refugio Receptor Palermo";
const VET = "Veterinaria Palermo";

async function lostPetToken(page: Page): Promise<string> {
  await page.goto("/perdidas");
  const credLink = page.locator('a[href^="/p/"]').first();
  await expect(credLink, "the bootstrap seed guarantees one lost pet").toBeVisible({
    timeout: 20_000,
  });
  const href = (await credLink.getAttribute("href")) ?? "";
  const token = href.split("/p/")[1]?.split(/[/?#]/)[0] ?? "";
  expect(token, `a credential link on /perdidas (${href})`).toMatch(/^DIM-/);
  return token;
}

async function reportFinderInPossession(
  page: Page,
  opts: { condition: RegExp; phone: string },
): Promise<void> {
  await page.setExtraHTTPHeaders({ "x-real-ip": uniqueIp() });
  const token = await lostPetToken(page);
  await page.goto(`/p/${token}/encontre`);
  await expect(page.locator("#finderPhone")).toBeVisible({ timeout: 20_000 });

  await page.locator("#finderPhone").fill(opts.phone);
  await placePointByAddress(page, PALERMO_POINT);
  await page.getByRole("radio", { name: opts.condition }).check();
  await page.getByLabel(/puedo tenerla indefinidamente/i).check();
  await page.getByRole("button", { name: /avisar al dueño/i }).click();

  await expect(page.getByText(/ya le avisamos a su familia/i)).toBeVisible({ timeout: 30_000 });
}

test.describe("plan B after 'La tengo conmigo'", () => {
  test.skip(ON_STAGING, LOCAL_ONLY_REASON);
  test("the confirmation shows the receiving organizations BELOW 'Ya le avisamos'", async ({
    page,
  }) => {
    await reportFinderInPossession(page, { condition: /^bien$/i, phone: "11 4000-1001" });

    const planB = page.getByTestId("finder-plan-b");
    await expect(planB).toBeVisible();
    await expect(planB.getByText("¿No podés tenerla hasta que la busquen?")).toBeVisible();
    await expect(
      planB.getByText("Estas organizaciones cercanas reciben animales encontrados."),
    ).toBeVisible();
    await expect(planB.getByTestId("finder-plan-b-receivers").getByText(RECEIVER)).toBeVisible();
    await expect(planB.getByText("Recibimos", { exact: true })).toBeVisible();
    // Not urgent: no vets block, and never a primary "llevar al refugio" action.
    await expect(planB.getByTestId("finder-plan-b-vets")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /llevar al refugio/i })).toHaveCount(0);

    // Order on the page: the family confirmation first, then plan B.
    const confirmationBox = await page.getByText(/ya le avisamos a su familia/i).boundingBox();
    const planBBox = await planB.boundingBox();
    expect(confirmationBox && planBBox && confirmationBox.y < planBBox.y).toBe(true);
  });

  test("an urgent condition puts the nearest vets FIRST, then the receivers", async ({ page }) => {
    await reportFinderInPossession(page, {
      condition: /necesita veterinario urgente/i,
      phone: "11 4000-1002",
    });

    const vets = page.getByTestId("finder-plan-b-vets");
    const receivers = page.getByTestId("finder-plan-b-receivers");
    await expect(vets.getByText(VET)).toBeVisible();
    await expect(receivers.getByText(RECEIVER)).toBeVisible();

    const vetsBox = await vets.boundingBox();
    const receiversBox = await receivers.boundingBox();
    expect(vetsBox && receiversBox && vetsBox.y < receiversBox.y).toBe(true);
  });
});

test.describe("/encontre-un-animal", () => {
  test("renders its three blocks in order and fills them for a picked locality", async ({
    page,
  }) => {
    await page.setExtraHTTPHeaders({ "x-real-ip": uniqueIp() });
    await page.goto("/encontre-un-animal");
    await expect(page.getByRole("heading", { level: 1, name: "Encontré un animal" })).toBeVisible();

    const chip = page.getByTestId("found-step-chip");
    const perdidas = page.getByTestId("found-step-perdidas");
    const receivers = page.getByTestId("found-step-receivers");
    await expect(chip.getByRole("heading", { name: /fijate si tiene chip/i })).toBeVisible();
    await expect(chip.getByText(/cualquier veterinaria lo lee gratis/i)).toBeVisible();
    await expect(perdidas.getByRole("link", { name: /ver mascotas perdidas/i })).toBeVisible();
    await expect(receivers.getByRole("heading", { name: /si no podés tenerlo/i })).toBeVisible();

    const [chipBox, perdidasBox, receiversBox] = await Promise.all([
      chip.boundingBox(),
      perdidas.boundingBox(),
      receivers.boundingBox(),
    ]);
    expect(
      chipBox &&
        perdidasBox &&
        receiversBox &&
        chipBox.y < perdidasBox.y &&
        perdidasBox.y < receiversBox.y,
    ).toBe(true);

    if (ON_STAGING) {
      test.info().annotations.push({ type: "skip-part", description: LOCAL_ONLY_REASON });
      return;
    }

    // The place is a catalogue locality, picked — never the device's location.
    const input = page.locator("#lugar-encontrado-input");
    await input.fill("Palermo");
    const option = page.getByRole("option", { name: /Palermo.*CABA/ }).first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    await option.click();

    await expect(chip.getByText(VET)).toBeVisible({ timeout: 20_000 });
    await expect(receivers.getByText(RECEIVER)).toBeVisible();
    await expect(receivers.getByText("Recibimos", { exact: true })).toBeVisible();
    const link = perdidas.getByRole("link", { name: /ver mascotas perdidas en palermo/i });
    await expect(link).toHaveAttribute("href", /\/perdidas\?.*localidad=Palermo/);
    // Nothing about the place rides in this page's own URL.
    expect(new URL(page.url()).search).toBe("");
  });

  test("is reachable from the landing and from /perdidas", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-section="crisis-doors"] [data-t="encontre"]')).toHaveAttribute(
      "href",
      "/encontre-un-animal",
    );

    await page.goto("/perdidas");
    await expect(page.getByRole("link", { name: "Mirá qué hacer" })).toHaveAttribute(
      "href",
      "/encontre-un-animal",
    );
  });
});
