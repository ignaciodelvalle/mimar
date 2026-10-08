// _shelter-custody — every spec that needs a LIVE shelter custody provisions
// its own, and ends it (T1-C3, 2026-09-18).
//
// WHY THIS FILE EXISTS. e2e-nightly.yml was red 41 nights running. Three specs
// (crisis-seams (d), owner-ia-p6 test 8, print-surfaces' adoption contract)
// needed the seeded refugio ("Refugio Test (Seed)") to hold at least one pet
// under a live `shelter_custody`, and on staging it held none: twelve
// custodies over the org's life, every one ended. The suite consumed its own
// precondition — (d) adopts a pet out, which ends the custody — and nothing
// reopened one. Re-seeding from the job cannot fix it (the seed's shelter-pets
// step guards on the microchip codes it writes and correctly SKIPS; see the
// workflow comment). The fix is structural: no spec reads a custody it did not
// open.
//
// TWO WAYS TO OPEN ONE, because the three specs need two different shapes:
//
//   1. `intakeShelterPet` — the refugio registers a NEW animal through its own
//      intake wizard. The org holds the animal; there is no owner. This is the
//      shape adoption needs: crisis-seams (d) publishes it and adopts it out,
//      and the adoption itself is what ends the custody. The pet then lives in
//      the adopter's registry; `deletePetsByNamePrefix` sweeps it on a LOCAL
//      database (a no-op against staging, like every cleanup in demo/_db-cleanup).
//
//   2. The rehome SPONSORSHIP (`pickSponsorablePetToken` → `sponsorPet` →
//      `endSponsorship`) — the pattern rehome-by-titular.spec.ts already used,
//      and the one custody on staging that was opened AND closed by a spec
//      (an `E2EPet-…` row, 2026-09-08, four seconds apart). The titular asks,
//      the org accepts: the org gets a `shelter_custody` row beside the owner's
//      (src/modules/rehome/README.md). The titular's "Dar de baja" closes it
//      through the UI, on ANY target, staging included — nothing accumulates.
//      That makes it the right shape for the two specs that only need to LOOK
//      at a held pet (the org-viewer profile, the contract route), and the
//      wrong one for (d): adopting a sponsored pet out would hand one of
//      owner@dim.test's own pets to owner2 every night.
//
// The sponsorship helpers are rehome-by-titular's, MOVED here verbatim so there
// is one copy; that spec imports them.

import { type Page, expect } from "@playwright/test";

import { speciesLabel } from "../lib/utils/species";
import { resolveOrgToken, wizardStep } from "./demo/_helpers";

/** The org seed-test-users.ts provisions — "Refugio Test", legal "Refugio Test (Seed)". */
export const SEED_ORG = /Refugio Test/i;

// ---------------------------------------------------------------------------
// 1. Intake — a new animal the refugio holds
// ---------------------------------------------------------------------------

/** Name prefix for intake-provisioned pets, swept by `deletePetsByNamePrefix`. */
export const INTAKE_PET_PREFIX = "E2EIntake-";

/**
 * Register a new animal through `/org/{orgToken}/intake?tab=registrar` and
 * return its public token. The caller is signed in as an org member with
 * intake rights (orgadmin@dim.test).
 *
 * The labels are IntakeForm.tsx's, read on 2026-09-18. The first click is
 * retried until the wizard actually advances: a click dispatched before React
 * attaches its handlers is dropped silently (the hydration race this repo
 * documents in e2e/README.md), and the wizard is a client component.
 */
export async function intakeShelterPet(
  page: Page,
  orgToken: string,
  name: string,
): Promise<string> {
  await page.goto(`/org/${orgToken}/intake?tab=registrar`, { waitUntil: "domcontentloaded" });
  const step = wizardStep(page);

  // Step 1 — Identificación: a street rescue, no chip.
  await expect(async () => {
    await page.getByRole("button", { name: /continuar sin chip/i }).click({ timeout: 3_000 });
    await expect(step.getByLabel(/nombre o alias temporal/i)).toBeVisible({ timeout: 3_000 });
  }, "the intake wizard advanced past Identificación").toPass({ timeout: 30_000 });

  // Step 2 — Identidad.
  await step.getByLabel(/nombre o alias temporal/i).fill(name);
  await step.getByLabel(/^especie/i).selectOption("dog");
  await step.locator('label:has(input[name="sex"][value="female"])').click();
  await step.getByRole("button", { name: /^continuar$/i }).click();

  // Step 3 — Estado: the custody role defaults to "Custodia temporal"
  // (shelter_custody), which is the whole point.
  await step.locator('label:has(input[name="intakeReason"][value="rescue"])').click();
  await step.getByRole("button", { name: /^continuar$/i }).click();

  // Step 4 — Confirmar.
  await step.getByRole("button", { name: /crear ingreso/i }).click();
  await expect(
    page.getByText(/mascota ingresada/i).first(),
    `the intake of ${name} reached its success screen`,
  ).toBeVisible({ timeout: 30_000 });

  // The success screen's links carry the new pet's token.
  const adoptHref = await page
    .getByRole("link", { name: /publicar adopci[oó]n/i })
    .first()
    .getAttribute("href");
  const petToken = adoptHref?.match(/\/mascotas\/([^/?#]+)\/adoptar/)?.[1] ?? "";
  expect(petToken, `public token of the intaken ${name}, from the success screen`).toMatch(/^DIM-/);
  return petToken;
}

// ---------------------------------------------------------------------------
// 2. Rehome sponsorship — a custody the titular can always end
// ---------------------------------------------------------------------------

/**
 * Name prefix for pets the titular registers to have one sponsored, swept by
 * `deletePetsByNamePrefix` (local database only, like every cleanup here).
 */
export const SPONSOR_PET_PREFIX = "E2ESponsor-";

/**
 * The titular registers a NEW pet in Palermo — a zone the seed refugio covers
 * (scripts/seed-test-users.ts) — and gets back its public token, read from the
 * registry row that carries exactly `name`.
 *
 * WHY NOT `pickSponsorablePetToken`. That walk takes the first rows of the
 * titular's registry, and the registry lists EVERY active ownership row of the
 * account, whatever its role (app/(app)/mis-mascotas/page.tsx — "any active
 * ownership row, no role filter"). On CI's bootstrap DB those are all
 * owner@'s own pets, so it works. On a long-lived DB they are not: the QA
 * situations seed (`pnpm seed:situaciones`, scripts/seed-situaciones-plan.ts)
 * gives owner@ "QA En tránsito" as a FOSTER and "QA Cuidador" as an accepted
 * CARETAKER, and both carry a non-urgent flag. The rehome page serves the
 * foster its own "Buscar nuevo hogar para …" screen and 404s the caretaker,
 * so `waitForRehomePage` never sees "Acompañamiento de adopción para …" and
 * times out — while the failure screenshot shows the test's OTHER page, the
 * org admin parked on the org panel where its login landed. A pet this run
 * registered is owner@'s as titular by construction and named nowhere else.
 *
 * The outcome is read from the index, not from the post-action URL
 * (e2e/README.md "Never wait on a post-action URL"): the registry row that
 * carries exactly `name` IS the outcome.
 */
export async function registerSponsorablePet(page: Page, name: string): Promise<string> {
  await page.goto("/mis-mascotas/nueva", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /registrar (tu primera )?mascota/i })).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  await page.getByLabel(/^nombre/i).fill(name);
  await page.getByRole("button", { name: speciesLabel("dog"), exact: true }).click();
  await page.getByRole("radio", { name: /hembra/i }).check();
  await page.getByLabel(/provincia/i).selectOption("AR-C");
  const locality = page.getByLabel(/ciudad, pueblo o barrio/i);
  await expect(locality).toBeEnabled();
  await locality.fill("Palermo");
  await expect(page.getByRole("option", { name: /Palermo/i }).first()).toBeVisible({
    timeout: 15_000,
  });
  await locality.press("Enter");
  await expect(page.locator('input[name="localityName"]')).toHaveValue(/.+/);
  await page.getByRole("button", { name: /continuar/i }).click();
  await expect(page.getByText(/tomar o elegir una foto/i)).toBeVisible();

  // The click is not awaited: its promise sits on the N3 client navigation and
  // may never settle (create-pet.spec.ts measured it). And the registry is
  // polled from a SECOND tab of the same session, never by navigating this
  // one: a goto here could abort the alta's POST in flight, and the action's
  // POST cannot be told apart from the locality search's by URL (both post to
  // this page), so waiting on "a server-action response" proves nothing.
  void page
    .getByRole("button", { name: /registrar mascota/i })
    .click()
    .catch(() => {});

  const registry = await page.context().newPage();
  try {
    const row = registry
      .locator('a[href^="/mis-mascotas/DIM-"]')
      .filter({ has: registry.getByText(name, { exact: true }) });
    await expect(async () => {
      await registry.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
      await expect(row).toHaveCount(1, { timeout: 5_000 });
    }, `${name} is in the titular's registry`).toPass({ timeout: 60_000 });
    const href = (await row.getAttribute("href")) ?? "";
    const token = href.split("/mis-mascotas/")[1] ?? "";
    expect(token, `public token of ${name}, from its registry row`).toMatch(/^DIM-/);
    return token;
  } finally {
    await registry.close();
  }
}

/** The seed refugio's row in the titular's org picker, on the rehome page. */
export function askSeedOrg(page: Page) {
  return page.getByRole("button", { name: /Pedir acompañamiento a .*Refugio Test/i }).first();
}

/**
 * The non-urgent pets in the titular's registry, in page order.
 *
 * NOT the sibling specs' locator, on purpose. They require `:has(img)` and a
 * "REGISTRADA/O" flag because the lost-pet walk reads the name from the
 * photo's alt. This walk only needs the token, and the seed guarantees
 * neither a photo nor a vaccine record: a seeded pet renders the initials
 * placeholder (no <img>) and, once compliance is derived, may read "AL DÍA"
 * instead of "REGISTRADA". With the sibling locator this spec failed on CI's
 * fresh DB (run 32555456201) for exactly that reason — and the siblings had
 * been skipping silently on the same condition. So: the row's href carries
 * the token, and either non-urgent flag marks a pet the rehome page accepts.
 */
export async function listCandidatePetTokens(page: Page): Promise<string[]> {
  await page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const rows = page.locator('a[href^="/mis-mascotas/DIM-"]', {
    hasText: /AL DÍA|REGISTRAD[AO]/i,
  });
  // An ASSERTION, not a skip: scripts/seed-test-users.ts seeds owner@dim.test
  // with active pets, so an empty registry is a broken seed. Auto-retrying, so
  // it also absorbs the registry's streaming render.
  await expect(
    rows.first(),
    "owner@dim.test has no active pet — the rehome walk needs one (seeded by scripts/seed-test-users.ts).",
  ).toBeVisible({ timeout: 20_000 });
  const hrefs = await rows.evaluateAll((anchors) =>
    anchors.map((a) => a.getAttribute("href") ?? ""),
  );
  const tokens = hrefs.map((h) => h.split("/mis-mascotas/")[1] ?? "").filter(Boolean);
  expect(tokens.length, "publicTokens parsed from the registry links").toBeGreaterThan(0);
  return tokens.slice(0, 6);
}

/**
 * The first candidate the seed refugio can sponsor, left on its rehome page
 * in the "none" state. A pet outside the refugio's coverage (locally: Pampa
 * in Belgrano) renders an empty picker and is skipped; the seed's own pets
 * live in Palermo, which the refugio covers, so at least one must qualify.
 */
export async function pickSponsorablePetToken(page: Page): Promise<string> {
  const candidates = await listCandidatePetTokens(page);
  for (const token of candidates) {
    await resetToNone(page, token);
    // count() is one-shot, but resetToNone already waited for the page's
    // heading (the gate this file documents above), so the picker is settled.
    if ((await askSeedOrg(page).count()) > 0) return token;
  }
  throw new Error(
    `none of ${candidates.length} non-urgent pet(s) of owner@dim.test is in a zone "Refugio Test (Seed)" covers — scripts/seed-test-users.ts seeds Palermo pets and Palermo coverage, so the seed or the coverage rule broke.`,
  );
}

/**
 * The one thing every state of the page renders. Gate every `count()` read
 * behind it: `Locator.count()` is a one-shot read that does not auto-retry,
 * and this route streams under the segment's Suspense boundary, so a count
 * taken straight after `goto` can see an empty DOM and turn a real assertion
 * into a silent `test.skip` with a false reason (the repo's own helpers —
 * e2e/demo/_helpers.ts discoverPetToken / resolveOrgToken — wait first).
 */
export async function waitForRehomePage(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: /Acompañamiento de adopción para/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForLoadState("networkidle").catch(() => {});
}

/** Resolve whatever the page is showing, so a re-run starts from "none". */
export async function resetToNone(page: Page, token: string): Promise<void> {
  await page.goto(`/mis-mascotas/${token}/buscar-hogar`, { waitUntil: "domcontentloaded" });
  await waitForRehomePage(page);
  for (const [trigger, confirm] of [
    ["Dar de baja el acompañamiento", "Confirmar la baja"],
    ["Cancelar el pedido", "Confirmar la cancelación"],
  ] as const) {
    const button = page.getByRole("button", { name: trigger });
    if ((await button.count()) === 0) continue;
    await button.click();
    await page.getByRole("button", { name: confirm }).click();
    // The page reloads itself (navigateAfterActionSuccess) — wait for the
    // picker that only the "none" state renders.
    await expect(
      page.getByRole("button", { name: /Pedir acompañamiento a/ }).first(),
    ).toBeVisible();
    return;
  }
}

/**
 * Open a live `shelter_custody` of the seed refugio on the titular's pet
 * `token`: the titular asks, the org accepts. Returns the org token.
 *
 * `titular` is signed in as owner@dim.test and already on the pet's rehome
 * page in the "none" state (`pickSponsorablePetToken` leaves it there, and so
 * does `resetToNone` after `registerSponsorablePet`);
 * `org` is signed in as orgadmin@dim.test. The caller ends the custody with
 * `endSponsorship` in a `finally` — it is safe to call even when this function
 * threw halfway, because `resetToNone` also cancels a still-pending request.
 *
 * The timings are rehome-by-titular's, measured on staging: the ask takes
 * ~17,5 s end to end on a cold serverless instance, so its outcome gets 30 s.
 */
export async function sponsorPet(titular: Page, org: Page, token: string): Promise<string> {
  await expect(
    askSeedOrg(titular),
    "the seed refugio does not cover this pet's zone — the org picker is empty for it (seeded by scripts/seed-test-users.ts).",
  ).toBeVisible({ timeout: 20_000 });
  await askSeedOrg(titular).click();
  await expect(titular.getByText(/Pedido enviado a .*Refugio Test/i)).toBeVisible({
    timeout: 30_000,
  });
  const caseHref = await titular
    .getByRole("link", { name: /Ver la solicitud/ })
    .getAttribute("href");
  expect(caseHref, "the request's case code, from the titular's own link").toMatch(
    /^\/casos\/CAS-/,
  );

  const orgToken = await resolveOrgToken(org, SEED_ORG);
  await org.goto(caseHref as string, { waitUntil: "domcontentloaded" });
  await org.getByRole("button", { name: "Aceptar el acompañamiento" }).click();
  await org.getByRole("button", { name: "Confirmar el acompañamiento" }).click();
  // The OUTCOME, on the page the action itself navigates to — never a hand-made
  // goto that can load the pre-commit document (rehome-by-titular, 2026-08-22).
  await expect(
    org.getByText("Solicitud aceptada por la organización"),
    `the seed refugio accepted the sponsorship of ${token} — its shelter custody is live`,
  ).toBeVisible({ timeout: 30_000 });
  return orgToken;
}

/** End the sponsorship (or cancel a still-pending request) — the custody closes. */
export async function endSponsorship(titular: Page, token: string): Promise<void> {
  await resetToNone(titular, token);
}
