/**
 * Org-portal forms settle after a save, in a PRODUCTION build.
 *
 * The defect class (2026-09-30 → 10-01): a form whose server action revalidates
 * the page it sits on can stay disabled forever in `next build && next start`
 * — the write lands, the re-render never commits, the button keeps saying
 * "Enviando…". jsdom cannot see it (there is no RSC refresh in a unit test),
 * so every assertion below is on what the page SHOWS after the click, never on
 * the action's return value or a post-action URL (e2e/README.md).
 *
 * Measured on 2026-10-01 against a production build, per form:
 *   - Configuración (EditOrgForm), Agenda (AgendaRuleForm) and the permission
 *     decision (DecideForm) settle — their revalidated re-render commits.
 *   - The permission REQUEST (RequestCapabilityForm, on the org dashboard) did
 *     not: 4 runs out of 4 frozen on "Enviando…" with the grant written. It now
 *     reloads the dashboard as a full document (contract N3), and test (c)
 *     is the guard for it.
 * (a) and (b) are guards too: they hold the line for the next change to those
 * pages, which is exactly how the request form's hang got in unnoticed.
 *
 * FIXTURE TIER — bootstrap, plus one row this spec manufactures. The accounts
 * are orgadmin@dim.test (admin of the seed refugio) and vet@dim.test (a
 * vet_individual member of it). (b) needs an APPROVED service offering, which
 * only an authority approval produces; e2e/_agenda-fixture.ts writes one
 * straight into a LOCAL Postgres, so (b) skips on any other target.
 *
 * RE-RUNNABLE. (a) puts the phone back; (b) deletes its offering and every rule
 * with it; (c) denies its own request, which leaves the vet's row requestable
 * again ("Denegado"), and first clears any request an interrupted run left
 * pending, so the request step always runs.
 */

import { type Page, expect, test } from "@playwright/test";

import {
  AGENDA_OFFERING_TOKEN,
  ensureAgendaOffering,
  removeAgendaOffering,
} from "./_agenda-fixture";
import { SEED_ORG } from "./_shelter-custody";
import { isLocalDatabase } from "./demo/_db-cleanup";
import { ACCOUNTS, loginAs, resolveOrgToken } from "./demo/_helpers";

/** Two phones the spec alternates between, so it never "saves" the value already there. */
const PROBE_PHONES = ["+54 9 221 555-0177", "+54 9 221 555-0188"] as const;

/** A capability a vet_individual member may ask for in a shelter. */
const CAPABILITY = "custody.transfer";
/** Typed as the request's reason; it is how the admin's queue row is found. */
const REQUEST_MARK = "e2e org-forms-settle";

test.describe.configure({ mode: "serial" });

async function relogin(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await loginAs(page, email);
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  // Hydration first: a click dispatched before React attaches is dropped.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await expect(page.getByText(/application error/i)).not.toBeVisible();
}

test("(a) configuración: saving frees the button and the change persists", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ACCOUNTS.orgAdmin);
  const orgToken = await resolveOrgToken(page, SEED_ORG);
  const path = `/org/${orgToken}/configuracion`;

  await open(page, path);
  const phone = page.getByLabel("Teléfono");
  await expect(phone).toBeVisible({ timeout: 20_000 });
  const original = await phone.inputValue();
  const probe = original === PROBE_PHONES[0] ? PROBE_PHONES[1] : PROBE_PHONES[0];

  async function save(value: string): Promise<void> {
    await page.getByLabel("Teléfono").fill(value);
    const button = page.getByRole("button", { name: /^(Guardar cambios|Guardando\.\.\.)$/ });
    await button.click();
    await expect(
      page.getByText("Cambios guardados correctamente."),
      "the save confirmed on the page it was made from",
    ).toBeVisible({ timeout: 20_000 });
    await expect(button, "the button came back after the save").toHaveText("Guardar cambios");
    await expect(button).toBeEnabled();
  }

  try {
    await save(probe);
    await open(page, path);
    await expect(
      page.getByLabel("Teléfono"),
      "the saved phone is what the page reads back",
    ).toHaveValue(probe);
  } finally {
    await open(page, path);
    await save(original);
  }
});

test.describe("(b) agenda", () => {
  test.afterAll(async () => {
    await removeAgendaOffering();
  });

  test("adding a rule frees the button and lists the rule in place", async ({ page }) => {
    test.setTimeout(120_000);
    // ENVIRONMENT-keyed: the approved offering is manufactured in a local
    // Postgres. Elsewhere there is nothing to open the agenda of.
    test.skip(
      !isLocalDatabase(),
      "NO COVERAGE (non-local database): the agenda needs an APPROVED service offering, which only an authority approval produces; e2e/_agenda-fixture.ts writes one into a local Postgres and cannot on a shared one.",
    );

    await loginAs(page, ACCOUNTS.orgAdmin);
    const orgToken = await resolveOrgToken(page, SEED_ORG);
    expect(await ensureAgendaOffering(orgToken), "the approved offering fixture").toBe(
      AGENDA_OFFERING_TOKEN,
    );

    await open(page, `/org/${orgToken}/servicios/${AGENDA_OFFERING_TOKEN}/agenda`);
    await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible({
      timeout: 20_000,
    });
    await page.locator("#startTimeLocal").fill("21:00");
    await page.locator("#endTimeLocal").fill("22:00");
    const add = page.getByRole("button", { name: /^(Agregar regla|Guardando…)$/ });
    await add.click();

    await expect(
      page.getByRole("cell", { name: "21:00:00 – 22:00:00" }),
      "the new rule lists on the page it was added from",
    ).toBeVisible({ timeout: 20_000 });
    await expect(add, "the button came back after the save").toHaveText("Agregar regla");
    await expect(add).toBeEnabled();
  });
});

test("(c) permisos: a member's request lands as pending and the admin's decision settles", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await loginAs(page, ACCOUNTS.orgAdmin);
  const orgToken = await resolveOrgToken(page, SEED_ORG);
  const queuePath = `/org/${orgToken}/admin/permisos`;
  const queueRows = () =>
    page.locator("li").filter({ hasText: REQUEST_MARK }).filter({ hasText: CAPABILITY });

  async function denyEveryMarkedRequest(): Promise<void> {
    await open(page, queuePath);
    await expect(page.getByRole("heading", { name: /^Pendientes/ }).first()).toBeVisible({
      timeout: 20_000,
    });
    for (let left = await queueRows().count(); left > 0; left = await queueRows().count()) {
      const row = queueRows().first();
      const deny = row.getByRole("button", { name: "Denegar", exact: true });
      // The trigger opens the reason form, whose commit button carries the same
      // verb (D.3) — so the same locator is clicked twice.
      await deny.click();
      await expect(deny, "the decision form replaced the trigger").toHaveCount(1);
      await deny.click();
      await expect(
        queueRows(),
        "the decided request left the pending queue on the page it was decided from",
      ).toHaveCount(left - 1, { timeout: 20_000 });
    }
  }

  // A request an interrupted run left pending would hide the vet's "Solicitar".
  await denyEveryMarkedRequest();

  // --- The member asks --------------------------------------------------------
  await relogin(page, ACCOUNTS.vet);
  await open(page, `/org/${orgToken}`);
  const row = page.locator("li").filter({ has: page.getByText(CAPABILITY, { exact: true }) });
  await expect(row, `the ${CAPABILITY} row on the member's dashboard`).toBeVisible({
    timeout: 20_000,
  });
  await row.getByRole("button", { name: "Solicitar", exact: true }).click();
  await row.locator('textarea[name="reason"]').fill(REQUEST_MARK);
  await row.getByRole("button", { name: "Enviar pedido", exact: true }).click();
  await expect(
    row.getByText("Pendiente", { exact: true }),
    "the request settled: the dashboard reads it back as pending (it used to freeze on Enviando…)",
  ).toBeVisible({ timeout: 20_000 });
  await expect(row.getByRole("button", { name: /Enviar pedido|Enviando/ })).toHaveCount(0);

  // --- The admin decides ------------------------------------------------------
  await relogin(page, ACCOUNTS.orgAdmin);
  await open(page, queuePath);
  await expect(queueRows(), "the member's request reached the admin's queue").toHaveCount(1, {
    timeout: 20_000,
  });
  await denyEveryMarkedRequest();
  await open(page, queuePath);
  await expect(queueRows(), "the denial persisted").toHaveCount(0);
});
