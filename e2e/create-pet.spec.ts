import { expect, test } from "@playwright/test";

import { speciesLabel } from "../lib/utils/species";
import { deletePetsByNamePrefix } from "./demo/_db-cleanup";
import { loginAs } from "./demo/_helpers";

/**
 * Create-pet happy-path e2e.
 *
 * Logs in as the seeded OWNER, navigates to /mis-mascotas/nueva, drives the
 * 2-step MinimalNewPetForm wizard (commit f94ad6ff), and asserts the new pet
 * appears in /mis-mascotas.
 *
 * This flow regressed before (create-pet broke silently in staging) and again
 * changed shape twice since the original test was written:
 *   - 38fb1f44 introduced the province-first cascade: LocationFields mode="l1"
 *     cascade renders a "Provincia" <select> that GATES a province-scoped
 *     "Localidad o barrio" autocomplete (disabled until a province is picked).
 *   - f94ad6ff split the alta into two steps: paso 1 (identidad) with a
 *     "Continuar" button, then paso 2 (foto y más) with the final "Crear
 *     mascota" submit. Both steps stay mounted so all fields are in the single
 *     final FormData.
 *
 * Fields driven here (app/(app)/mis-mascotas/nueva/MinimalNewPetForm.tsx):
 *   - name     → text input labelled "Nombre"
 *   - species  → chip button rotulado por `speciesLabel` sets hidden input name="species"
 *   - sex      → radio group, value "male"/"female"/"unknown"
 *   - province → <select> labelled "Provincia" (ISO 3166-2:AR value)
 *   - locality → LocalityPickerAcross labelled "Localidad o barrio", scoped to
 *                the chosen province → hidden input name="localityName"
 */

const OWNER_EMAIL = "owner@dim.test";

// Unique name to assert in the list afterwards (also keeps the soft same-owner
// dedupe gate P2 from firing on repeated runs).
const PET_NAME_PREFIX = "E2EPet-";
const PET_NAME = `${PET_NAME_PREFIX}${Date.now()}`;

// Palermo is a CABA barrio; the cascade needs its province picked first.
const PROVINCE_CODE = "AR-C"; // Ciudad Autónoma de Buenos Aires (CABA)

// Registration is append-only and there is no "delete my pet" flow — nor should
// there be — so this spec could not clean up through the app, and left one pet
// behind on EVERY run. The pile was not merely untidy: crisis-owner-lost-flow
// picks an arbitrary active pet of this same owner and marks it lost, so an
// interrupted run stranded a test pet publicly LOST. Live review 2026-07-28
// found ProbeAlta-… and E2EPet-… as the TOP TWO rows of the public /perdidas
// list, above real records, on the demo an official is shown — and the owner
// account's "first pet" had become an E2E leftover.
//
// Cleanup runs BEFORE as well as after: a previous crash must not poison this
// run either. Local database only; a no-op anywhere else.
test.beforeAll(async () => {
  const removed = await deletePetsByNamePrefix(PET_NAME_PREFIX);
  if (removed > 0) console.log(`[create-pet] cleared ${removed} leftover pet(s) from earlier runs`);
});

test.afterAll(async () => {
  await deletePetsByNamePrefix(PET_NAME_PREFIX);
});

test("owner creates a pet with location and it appears in /mis-mascotas", async ({ page }) => {
  // Alta is a multi-step flow (login → wizard → dual-write → list); with the
  // 45s submit budget below, the 30s default test timeout is too tight.
  test.setTimeout(90_000);

  // -- Log in -----------------------------------------------------------
  // Through the SHARED helper, not a private copy. Login is rate-limited per
  // client IP, and against a LOCAL target callerIp() reads x-real-ip straight
  // off the request; loginAs hands every login a distinct TEST-NET-3 address so
  // each looks like a fresh visitor. This spec had its own inline login without
  // that, so repeated runs drained the bucket and it failed at the login step —
  // 15s waitForURL timeout — long before it reached anything it was written to
  // test. Against staging that address is INERT (Vercel's edge overwrites the
  // header — measured 2026-08-26, method in lib/infra/rate-limit.ts above
  // callerIp()); there what keeps the login budget intact is loginAs's
  // per-worker session cache, not the header.
  await loginAs(page, OWNER_EMAIL);

  // -- Navigate to new-pet form -----------------------------------------
  await page.goto("/mis-mascotas/nueva");
  await expect(
    page.getByRole("heading", { name: /registrar (tu primera )?mascota/i }),
  ).toBeVisible();

  // ── Paso 1 — Identidad ───────────────────────────────────────────────
  // -- Name -------------------------------------------------------------
  await page.getByLabel(/^nombre/i).fill(PET_NAME);

  // -- Species: click the dog chip ---------------------------------------
  // La etiqueta sale de `speciesLabel`, la ÚNICA fuente (lib/utils/species.ts).
  // Estaba escrita a mano como /perro\/a/i y el 2026-08-09 el PO decidió "Perro"
  // a secas —el desdoblamiento en un selector de ESPECIE es un error de
  // categoría—. La constante se unificó y estos dos specs no; quedaron colgados
  // 15s esperando un botón que ya no se llama así. Leerla de la fuente hace que
  // el próximo cambio de ortografía no pueda romperlos en silencio.
  await page.getByRole("button", { name: speciesLabel("dog"), exact: true }).click();

  // -- Sex: pick "Macho" radio ------------------------------------------
  await page.getByRole("radio", { name: /macho/i }).check();

  // -- Location (cascade): pick the province, THEN the scoped locality ---
  // The locality autocomplete is disabled until a province is chosen, so the
  // province <select> must come first.
  await page.getByLabel(/provincia/i).selectOption(PROVINCE_CODE);

  const localityInput = page.getByLabel(/localidad o barrio/i);
  await expect(localityInput).toBeEnabled();
  await localityInput.fill("Palermo");

  // Wait for the debounced (200ms) province-scoped search to render its
  // options, then select the first Palermo match. Selection fires on
  // mousedown / Enter; the component's key handler preventDefaults Enter so
  // it never submits the form.
  //
  // Matched by ROLE, not by markup. This used to be `li button`, which stopped
  // matching when LnCombobox put role="option" on the <li> itself — there is no
  // button in the list any more. The picker was fine; the selector had drifted,
  // and nothing noticed because the e2e suite had not run in CI since
  // 2026-06-12. The role is the contract a screen reader sees, so it does not
  // rot the next time the markup moves.
  const firstOption = page.getByRole("option", { name: /Palermo/i }).first();
  await expect(firstOption).toBeVisible({ timeout: 15_000 });
  await localityInput.press("Enter");

  // Confirm the picker captured a locality before advancing (paso 1 has a
  // required-locality guard); fails here with a clear message if selection
  // didn't take, instead of a confusing bounce-back later.
  await expect(page.locator('input[name="localityName"]')).toHaveValue(/.+/);

  // -- Advance to paso 2 ------------------------------------------------
  await page.getByRole("button", { name: /continuar/i }).click();

  // Paso 2 revealed: prominent photo field + the final submit button.
  await expect(page.getByText(/tomar o elegir una foto/i)).toBeVisible();

  // ADVANCING IS NOT CREATING. This assertion is the one that matters, and its
  // absence is why "Continuar creates the pet and skips the photo step" shipped
  // (PO 2026-08-11) with this spec green over it.
  //
  // The visibility check above CANNOT catch that bug: on the broken build the
  // click both advanced the wizard AND submitted the form, so paso 2 genuinely
  // rendered for the ~300ms the server action took, satisfied the assertion,
  // and only then did the client push to /credencial. Everything downstream
  // then passed too — waitForURL's predicate was already true on the credential
  // screen, and the pet showed up in the list because the bug had created it.
  // Every assertion in this spec was satisfied BY the defect.
  //
  // The URL is the honest contract: paso 1 → paso 2 is client-side step state,
  // so the location must not have moved. Checked twice on purpose — once now,
  // and once after a beat, because the navigation that this guards against is
  // asynchronous and would otherwise land just after a single instant check.
  await expect(page).toHaveURL(/\/mis-mascotas\/nueva$/);
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/mis-mascotas\/nueva$/);

  // ── Paso 2 — submit (foto is optional; skip it) ──────────────────────
  //
  // The click is fired but NOT awaited. Its promise never resolves here, and
  // the app is not why.
  //
  // createPetAction returns `redirectTo` and MinimalNewPetForm pushes it
  // client-side — the N3 contract, adopted because Next 15.5 drops a
  // redirect() issued from a server action in production. Playwright's
  // post-click wait sits on that App Router transition and never sees it
  // settle, so click() hangs until the test budget dies. Measured at 90s and
  // again at 300s: not a slow test, a wait that cannot finish. `noWaitAfter`
  // is a no-op on click in Playwright 1.60, so it is not the lever either.
  //
  // What the same instrumented run measured about the ALTA itself:
  //   reached /credencial          300 ms
  //   requests still open at +15s  0
  //   credential h1                "<name> ya tiene su credencial"
  // The flow is fast, complete and correct. Only the harness's promise is
  // stuck, so the navigation below is the assertion that matters — and it is
  // the real contract regardless.
  void page
    .getByRole("button", { name: /registrar mascota/i })
    .click()
    .catch(() => {
      // Swallowed on purpose: this promise is expected never to settle, and a
      // late rejection at teardown must not fail an otherwise-green test.
    });

  // Creation must LEAVE the wizard. On success the action redirects to the
  // credential screen (/mis-mascotas/nueva/{token}/credencial) — that path
  // starts with /mis-mascotas and does not end with "/nueva", so the predicate
  // passes while a failed create that stays on the form (…/nueva) does not.
  // Alta can take a while on a cold build (event-first dual-write + RSC
  // revalidate), so allow ≥45s before declaring the create hung.
  await page.waitForURL(
    (url) => url.pathname.startsWith("/mis-mascotas") && !url.pathname.endsWith("/nueva"),
    { timeout: 45_000 },
  );

  // -- Assert pet is visible in the list --------------------------------
  // Navigate to the list explicitly (we landed on the credential screen).
  // Reload once if the freshly-created pet isn't immediately listed, to defeat
  // any RSC/router-cache staleness right after the write.
  await page.goto("/mis-mascotas");
  const petCell = page.getByText(PET_NAME);
  if (!(await petCell.isVisible().catch(() => false))) {
    await page.reload();
  }
  await expect(petCell).toBeVisible({ timeout: 15_000 });
});
