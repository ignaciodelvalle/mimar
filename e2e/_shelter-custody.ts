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
 * page in the "none" state (`pickSponsorablePetToken` leaves it there);
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
