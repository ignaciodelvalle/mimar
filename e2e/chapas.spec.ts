import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

import { ACTIVATION_FAILED_MESSAGE } from "@/src/modules/pets/application/tags/types";

import { deleteTagsByLotePrefix } from "./demo/_db-cleanup";
import { ACCOUNTS, assertRealPage, loginAs, uniqueIp } from "./demo/_helpers";

/**
 * Physical tags (chapas) — end-to-end coverage of the whole lifecycle surface.
 *
 * Closes the S3 gap: three shipped routes had no browser-level test at all —
 * the public resolver `/t/[serial]`, the owner panel `/cuenta/chapas` (+ its
 * `activar` form), and the admin issuance console `/admin/chapas`. Every one of
 * them is reachable by a stranger holding a QR or by an admin minting the
 * physical stock, and the resolver in particular is the ONE page a person
 * standing over a lost animal will see.
 *
 * ---------------------------------------------------------------------------
 * FIXTURE PATH — why the admin UI and not a DB insert
 * ---------------------------------------------------------------------------
 *
 * A usable fixture needs a serial AND its PLAINTEXT activation code, and the
 * product goes out of its way to make the second one unobtainable:
 * `issueTagBatchForAdmin` (src/modules/pets/application/tags/issue-tag-batch.ts)
 * generates the code in memory, stores only `hashTagActivationCode(code)` — a
 * peppered HMAC — and returns the plaintext exactly once, to the admin form,
 * which turns it into the issuance CSV in the browser. Nothing persists it,
 * nothing logs it, and no query can recover it.
 *
 * That leaves two honest options:
 *
 *   (1) INSERT INTO pet_tags with a code we chose and hashed ourselves, or
 *   (2) drive the real admin flow and capture the CSV download.
 *
 * This spec takes (2). It costs one extra page, and it buys the coverage of
 * requirement (d) for free — the one-shot CSV contract is asserted on the real
 * artifact rather than described in a comment — while (1) would have had to
 * reimplement the hashing and would go green even if issuance were broken.
 * The tags are cleaned up afterwards by lote id (`deleteTagsByLotePrefix`);
 * there is no "delete a chapa" flow in the product, by design.
 *
 * ---------------------------------------------------------------------------
 * Fixtures and gating
 * ---------------------------------------------------------------------------
 *
 * No `_seed-profile.ts` gate is needed here: nothing is discovered from seeded
 * content. The tags are minted by this spec, and the pet the activation binds
 * comes from `owner@dim.test`, which `pnpm db:bootstrap` seeds with 3 mascotas
 * (scripts/seed-test-users.ts) — bootstrap tier, present in CI. If that owner
 * ever has zero pets the activation form says so instead of rendering, and the
 * test fails loudly, which is the correct outcome: a chapa the seeded owner
 * cannot activate is a broken fixture, not a documented absence.
 *
 * ---------------------------------------------------------------------------
 * Traps observed (e2e/README.md)
 * ---------------------------------------------------------------------------
 *
 *  · 404 is asserted as a SURFACE (the `branded-not-found` testid), never as an
 *    HTTP status — a streamed shell can flush before `notFound()` fires.
 *  · No waiting on a post-action URL. `ActivateTagForm` navigates through
 *    `navigateAfterActionSuccess`, whose client half is known to drop; the
 *    assertions read the OUTCOME off /cuenta/chapas instead.
 *  · Activation is rate-limited per IP (5/min · 20/hour, app/actions/tags.ts),
 *    and `loginAs` only sets a fresh `x-real-ip` on a REAL sign-in — a replayed
 *    cached session inherits none, so every spec would share the "unknown"
 *    bucket. Each test that submits the form claims its own `uniqueIp()`. That
 *    device works against a LOCAL target only ("unknown" is itself the tell:
 *    there is no edge stamping the header). Against staging the edge overwrites
 *    whatever this spec sends and all of it lands in the runner's one real
 *    bucket — measured 2026-08-26, lib/infra/rate-limit.ts above `callerIp()`.
 *  · Serial-keyed budget too (3/min · 10/hour): the wrong-code walk and the
 *    happy path deliberately use DIFFERENT serials from the batch.
 */

// Run-unique lote so a crashed earlier run cannot collide, and so the cleanup
// prefix below can sweep leftovers from any run without touching real stock.
const LOTE_PREFIX = "E2E-CHAPAS-";
const LOTE_ID = `${LOTE_PREFIX}${Date.now().toString(36).toUpperCase()}`;
const BATCH_SIZE = 3;

/** Serial + plaintext code, read from the issuance CSV in the first test. */
type IssuedTag = { serial: string; activationCode: string; url: string };
let issued: IssuedTag[] = [];

/** The tag this spec activates and then revokes. */
const activatedTag = () => issued[0];
/** The tag the wrong-code walk attacks — never activated, so it stays blank. */
const attackedTag = () => issued[1];

// Cleanup runs BEFORE as well as after: a crashed earlier run must not leave
// dead chapas on the owner's panel or poison this one. Local database only.
test.beforeAll(async () => {
  const removed = await deleteTagsByLotePrefix(LOTE_PREFIX);
  if (removed > 0) console.log(`[chapas] cleared ${removed} leftover chapa(s) from earlier runs`);
});

test.afterAll(async () => {
  await deleteTagsByLotePrefix(LOTE_PREFIX);
});

// Serial by necessity, not by convenience: test 1 mints the fixtures every
// later test spends, and the lifecycle itself is ordered (blank → active →
// revoked) on a tag that cannot be reset.
test.describe.configure({ mode: "serial" });

test.describe("chapas — physical tag lifecycle", () => {
  // ---------------------------------------------------------------------
  // (d) Admin issuance — and the fixtures every later test uses
  // ---------------------------------------------------------------------
  test("admin issues a lote and the CSV with the activation codes is offered exactly once", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await loginAs(page, ACCOUNTS.admin);

    await page.goto("/admin/chapas");
    await assertRealPage(
      page,
      "/admin/chapas",
      page.getByRole("heading", { name: "Chapas físicas" }),
    );

    await page.getByLabel(/cantidad de chapas/i).fill(String(BATCH_SIZE));
    await page.getByLabel(/identificador de lote/i).fill(LOTE_ID);

    // The CSV is built client-side from the action response and downloaded via
    // an object URL that is revoked immediately after the click, so the listener
    // has to be armed BEFORE the submit.
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: /emitir y descargar csv/i }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe(`chapas-${LOTE_ID}.csv`);

    const csvPath = await download.path();
    expect(csvPath, "downloaded CSV is readable on disk").toBeTruthy();
    const csv = readFileSync(csvPath as string, "utf8");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("serial,activation_code,url");
    expect(lines).toHaveLength(BATCH_SIZE + 1);

    issued = lines.slice(1).map((line) => {
      const [serial, activationCode, url] = line.split(",");
      return { serial, activationCode, url };
    });
    for (const row of issued) {
      expect(row.serial, "issued serial shape").toMatch(/^TAG-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(row.activationCode, "issued activation code shape").toMatch(
        /^[A-Z2-9]{4}-[A-Z2-9]{4}$/,
      );
      // The CSV is what the engraving provider receives: the URL it carries is
      // the one the QR gets stamped with, so it must be the public resolver.
      expect(row.url).toContain(`/t/${row.serial}`);
    }
    expect(new Set(issued.map((r) => r.serial)).size, "serials are unique").toBe(BATCH_SIZE);

    // The summary states the one-shot contract in the UI, not just in a docblock.
    await expect(page.getByText(/no se pueden volver a consultar/i)).toBeVisible();

    // …and the contract HOLDS: after a reload the console can no longer show a
    // single serial or code from the batch. (A "download once" promise that a
    // refresh silently re-offers is not a promise.)
    await page.reload();
    await expect(page.getByRole("heading", { name: "Chapas físicas" })).toBeVisible();
    const body = (await page.locator("body").innerText()).toUpperCase();
    for (const row of issued) {
      expect(body, "issued serial re-shown after reload").not.toContain(row.serial);
      expect(body, "issued activation code re-shown after reload").not.toContain(
        row.activationCode,
      );
    }
  });

  // ---------------------------------------------------------------------
  // (a) Resolver states
  // ---------------------------------------------------------------------
  test("resolver: an unknown serial answers the not-found surface", async ({ page }) => {
    await page.goto("/t/TAG-ZZZZ-ZZZZ");
    // Asserted as a SURFACE, never as response.status() — see the header.
    await expect(page.getByTestId("branded-not-found")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /no encontramos esa credencial/i }),
    ).toBeVisible();
  });

  test("resolver: a real UNACTIVATED chapa gets a neutral page, zero pet info, activation CTA", async ({
    page,
  }) => {
    const { serial } = attackedTag();
    await page.goto(`/t/${serial}`);

    await expect(page.getByText(/esta chapa todav[ií]a no fue activada/i)).toBeVisible();

    const cta = page.getByRole("link", { name: /activar esta chapa/i });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", `/cuenta/chapas/activar?serial=${serial}`);

    // ZERO pet info: no credential token, no owner-panel vocabulary. The
    // projection behind this page (lookupTagBySerial) is {status, publicToken}
    // by construction, so this is a regression net on the PAGE, not the query.
    const body = await page.locator("body").innerText();
    expect(body, "a public resolver page must never carry a DIM credential token").not.toMatch(
      /DIM-/,
    );
  });

  // ---------------------------------------------------------------------
  // (c) Wrong code — uniform failure, no state leak
  // ---------------------------------------------------------------------
  test("activation: a wrong code fails with the SAME message as an unknown serial, and leaks no state", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { serial, activationCode } = attackedTag();

    await loginAs(page, ACCOUNTS.owner);
    // Own IP: the per-IP activation budget is 5/min and a replayed session
    // carries no x-real-ip, so without this every spec shares one bucket —
    // locally. Against staging the edge overwrites it and they share one bucket
    // anyway; see the file header.
    await page.setExtraHTTPHeaders({ "x-real-ip": uniqueIp() });

    // Attempt 1 — real serial, wrong code.
    await page.goto(`/cuenta/chapas/activar?serial=${serial}`);
    await page.getByLabel(/c[oó]digo de activaci[oó]n/i).fill("AAAA-AAAA");
    await selectFirstPet(page);
    await page.getByRole("button", { name: /activar chapa/i }).click();
    const wrongCodeMessage = await readFormError(page);

    // Attempt 2 — serial that does not exist, code that does.
    await page.goto("/cuenta/chapas/activar?serial=TAG-ZZZZ-ZZZZ");
    await page.getByLabel(/c[oó]digo de activaci[oó]n/i).fill(activationCode);
    await selectFirstPet(page);
    await page.getByRole("button", { name: /activar chapa/i }).click();
    const unknownSerialMessage = await readFormError(page);

    // The evidence gate must not be an oracle: the two are indistinguishable.
    expect(wrongCodeMessage).toBe(unknownSerialMessage);
    expect(wrongCodeMessage).toBe(ACTIVATION_FAILED_MESSAGE);
    // …and it never echoes the attempted secret back.
    expect(wrongCodeMessage).not.toContain(activationCode);

    // No state moved: the chapa the wrong code attacked is still blank.
    await page.goto(`/t/${serial}`);
    await expect(page.getByText(/esta chapa todav[ií]a no fue activada/i)).toBeVisible();
  });

  // ---------------------------------------------------------------------
  // (b) Activation happy path
  // ---------------------------------------------------------------------
  test("activation: the owner activates a blank chapa and its QR then resolves to the credential", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const { serial, activationCode } = activatedTag();

    await loginAs(page, ACCOUNTS.owner);
    await page.setExtraHTTPHeaders({ "x-real-ip": uniqueIp() });

    // The CTA on the resolver page prefills the serial — arrive the way an
    // owner who just scanned their own unwrapped chapa would.
    await page.goto(`/t/${serial}`);
    await page.getByRole("link", { name: /activar esta chapa/i }).click();
    await expect(page.getByRole("heading", { name: "Activar chapa" })).toBeVisible();
    await expect(page.getByLabel(/n[uú]mero de serie/i)).toHaveValue(serial);

    await page.getByLabel(/c[oó]digo de activaci[oó]n/i).fill(activationCode);
    const petName = await selectFirstPet(page);

    // Wait for the SERVER ACTION's own response, not for the post-action URL.
    //
    // Both halves matter. Navigating straight after the click aborts the
    // in-flight action — that is what made this test report an empty "Todavía
    // no tenés chapas" panel the first time it ran, with nothing wrong in the
    // product. And waiting on the URL instead is the trap e2e/README.md names:
    // `navigateAfterActionSuccess` is the client half of the N3 contract and it
    // drops often enough to matter. The POST always answers.
    const actionAnswered = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().includes("/cuenta/chapas/activar"),
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: /activar chapa/i }).click();
    await actionAnswered;

    // Let whichever outcome the answer produced land — a full-document
    // navigation on success, or a rendered refusal — so a refused activation
    // reports its own reason below instead of an empty panel. Both waits are
    // bounded and swallowed: this is diagnostics, the assertions come after.
    const refusal = page.locator("form").getByRole("alert").filter({ hasText: /\S/ });
    await Promise.race([
      page.waitForURL((u) => !u.pathname.endsWith("/activar"), { timeout: 15_000 }).catch(() => {}),
      refusal.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {}),
    ]);
    if ((await refusal.count()) > 0) {
      throw new Error(`activation refused: "${(await refusal.first().innerText()).trim()}"`);
    }

    await page.goto("/cuenta/chapas");
    const row = tagRow(page, serial);
    await expect(row, "the activated chapa is listed on /cuenta/chapas").toBeVisible({
      timeout: 20_000,
    });
    await expect(row.getByText("Activa", { exact: true })).toBeVisible();

    // It is bound to the pet the form selected, and the panel links to it.
    const petLink = row.getByRole("link", { name: petName });
    await expect(petLink).toBeVisible();
    const href = (await petLink.getAttribute("href")) ?? "";
    const publicToken = href.split("/mis-mascotas/")[1] ?? "";
    expect(publicToken, "pet token parsed from the chapas panel link").toMatch(/^DIM-/);

    // The point of the whole feature: a STRANGER scanning the QR lands on the
    // public credential. Fresh context — no session, no cookies.
    const anon = await browser.newContext();
    try {
      const scanner = await anon.newPage();
      await scanner.goto(`/t/${serial}`);
      await expect(scanner).toHaveURL(new RegExp(`/p/${publicToken}$`));
      await assertRealPage(scanner, `/p/${publicToken}`);
    } finally {
      await anon.close();
    }
  });

  // ---------------------------------------------------------------------
  // (a) Revoked state
  // ---------------------------------------------------------------------
  test("revocation: a revoked chapa gets an honest page with no pet info and no reason", async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const { serial } = activatedTag();

    await loginAs(page, ACCOUNTS.owner);
    await page.setExtraHTTPHeaders({ "x-real-ip": uniqueIp() });

    await page.goto("/cuenta/chapas");
    const row = tagRow(page, serial);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole("button", { name: "Dar de baja" }).click();

    // ConfirmDialog renders a native <dialog> per row; name it by its title so
    // the confirm click can never land on the row trigger of the same name, nor
    // on another row's dialog.
    const dialog = page.getByRole("dialog", { name: `Dar de baja la chapa ${serial}` });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/motivo/i).selectOption("damaged");
    await dialog.getByRole("button", { name: "Dar de baja" }).click();

    // The dialog reloads the panel itself; assert the outcome, not the nav.
    await expect(tagRow(page, serial).getByText("Dada de baja").first()).toBeVisible({
      timeout: 20_000,
    });

    const anon = await browser.newContext();
    try {
      const scanner = await anon.newPage();
      await scanner.goto(`/t/${serial}`);
      await expect(scanner.getByText(/esta chapa fue dada de baja/i)).toBeVisible();

      const body = await scanner.locator("body").innerText();
      // Zero pet info even though the lookup projection still carries the token
      // for revoked rows (audit linkage is kept on purpose — revoke-tag.ts D4).
      expect(body, "a revoked resolver page must not carry a DIM token").not.toMatch(/DIM-/);
      // The reason lives in the owner's event log and nowhere near the public
      // page — a stranger must not learn WHY the chapa went out of service.
      //
      // The vocabulary checked here is the "damaged" branch this test actually
      // chose plus its neighbours, NOT the whole enum: /t/[serial] renders
      // inside the citizen AppShell, whose nav carries "Mascotas perdidas", so
      // a blanket scan for "perdi"/"lost" would fail on chrome that has nothing
      // to do with the tag. The full enum IS asserted, on a shell-free render,
      // by __tests__/tag-resolver-page.test.tsx.
      for (const reason of ["damaged", "dañada", "ilegible", "fraud", "fraude"]) {
        expect(body.toLowerCase(), `revoke reason vocabulary leaked: ${reason}`).not.toContain(
          reason,
        );
      }
      // Never a redirect into the credential either.
      expect(new URL(scanner.url()).pathname).toBe(`/t/${serial}`);
    } finally {
      await anon.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * The /cuenta/chapas row for one serial (the panel lists every managed tag).
 *
 * Anchored on STRUCTURE, not on Tailwind classes: the row is the element whose
 * grandchild `<p>` holds the serial `<span>` (page.tsx renders
 * `row > div > p > span`), so it contains both the status badge and the row's
 * revoke trigger. `filter({ hasText })` on a bare `div` cannot be used here —
 * it matches every ancestor, and `.last()` would return the innermost text
 * block, which excludes the action button sitting beside it.
 */
function tagRow(page: import("@playwright/test").Page, serial: string) {
  return page.locator(`div:has(> div > p > span:text-is("${serial}"))`);
}

/**
 * Pick the first real option of the owned-pet selector and return its label.
 * Index 0 is the "Elegí una mascota…" placeholder.
 */
async function selectFirstPet(page: import("@playwright/test").Page): Promise<string> {
  const select = page.getByLabel(/^mascota/i);
  await expect(
    select,
    "owned-pet selector — owner@dim.test must have at least one pet",
  ).toBeVisible();
  const options = select.locator("option");
  const name = (await options.nth(1).innerText()).trim();
  expect(name, "first selectable pet in the activation form").not.toBe("");
  await select.selectOption({ label: name });
  return name;
}

/**
 * The form's single error banner, waited for rather than polled.
 *
 * ActivateTagForm renders ONE `role="alert"` for every refusal and does not
 * navigate, so a helper that watched the URL could not tell a refusal from a
 * slow server — the exact failure shape `loginAs` documents for /login.
 *
 * SCOPED TO THE FORM, and non-empty by construction. A bare
 * `getByRole("alert").first()` matched an EMPTY live region the AppShell mounts
 * for announcements, so both walks below "agreed" on `""` — an oracle test that
 * proved the two refusals are identical by reading neither of them. Requiring
 * `\S` is what makes the comparison mean something.
 */
async function readFormError(page: import("@playwright/test").Page): Promise<string> {
  const alert = page.locator("form").getByRole("alert").filter({ hasText: /\S/ }).first();
  await expect(alert, "the activation form's error banner").toBeVisible({ timeout: 20_000 });
  const text = (await alert.innerText()).trim();
  expect(text, "the refusal message must not be empty").not.toBe("");
  return text;
}
