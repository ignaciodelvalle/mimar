import { expect, test } from "@playwright/test";

import { askSeedOrg, pickSponsorablePetToken } from "./_shelter-custody";
import { ACCOUNTS, loginAs, resolveOrgToken } from "./demo/_helpers";

/**
 * Acompañamiento de adopción (rehome-by-titular) — the one browser-level walk
 * the change is judged on (WU5, spec REQ-1/2/4/8):
 *
 *   RT1  the titular asks a verified org from their own pet surface → the
 *        org finds the request in its Casos inbox and accepts it from the
 *        case detail → the titular sees the accompaniment and ends it
 *        unilaterally, from the same surface.
 *
 * WHY THIS IS ONE SERIAL TEST. Both sides need the same expensive
 * precondition — a real request between two real accounts — and `loginAs`
 * caches sessions per worker (auth_login_email is 5/min · 20/hour on the
 * EMAIL). Serial ordering keeps the shared case in a known state.
 *
 * CONVENTIONS HONOURED (e2e/README.md)
 *   · No hardcoded tokens: the pet comes from owner@dim.test's registry, the
 *     org token from the org picker, the case code from the titular's own
 *     "Ver la solicitud" link — which is the path a person takes too.
 *   · Never wait on a post-action URL: every step asserts the OUTCOME the
 *     mutation produces, after an explicit goto.
 *   · Bootstrap tier only: owner@dim.test (pets in CABA / Palermo) and
 *     orgadmin@dim.test's "Refugio Test (Seed)" (coverage: Palermo) are both
 *     seeded by scripts/seed-test-users.ts, so the picker is non-empty on CI's
 *     fresh DB. Both preconditions are ASSERTED, never skipped: the seed
 *     GUARANTEES them, so a missing pet or an empty picker is the seed
 *     breaking — the one thing this walk exists to catch. `test.skip` is for
 *     environmental conditions the run genuinely cannot control; a fixture the
 *     repo owns is not one, and a green suite that quietly skipped its only
 *     browser-level proof of REQ-1/2/4/8 is worse than a red one.
 *   · The registry may hold MORE than the seed's pets (a local demo seed adds
 *     Pampa in Belgrano; create-pet.spec adds photo-less strays), and the
 *     list is sorted by urgency, not by seed. So the walk does not take "the
 *     first active pet": it takes the first non-urgent pet the seed refugio
 *     can actually sponsor, and fails loudly only when none of them is.
 *
 * IDEMPOTENCE. The walk starts by resolving whatever the page shows (a
 * pending request or an active accompaniment from an earlier run) and ends
 * with the sponsorship withdrawn. Closed cases and ended rows accumulate
 * harmlessly; `cases_open_per_pet_kind_idx` only constrains OPEN ones.
 */

const TITULAR = ACCOUNTS.owner;
const ORG_ADMIN = ACCOUNTS.orgAdmin;
const SEED_ORG = /Refugio Test/i;

// The walk's helpers (askSeedOrg, pickSponsorablePetToken, resetToNone, …)
// moved to e2e/_shelter-custody.ts on 2026-09-18 (T1-C3): the three specs that
// need a live shelter custody now open one with this same sponsorship, and one
// copy of the walk is what keeps them from drifting apart.

test.describe
  .serial("acompañamiento de adopción", () => {
    test("RT1 — el titular pide, la organización acepta desde su bandeja, el titular da de baja", async ({
      page,
      browser,
    }) => {
      test.setTimeout(150_000);

      await loginAs(page, TITULAR);
      const token = await pickSponsorablePetToken(page);

      // ---- the ask, from the titular's own surface ---------------------------
      // An ASSERTION, not a skip: "Refugio Test (Seed)" is verified, a shelter
      // and covers CABA/Palermo — the same three things the picker filters on
      // — so an empty picker for a seeded pet means the seed or the coverage
      // rule broke. One auto-retrying expect: it waits out the segment's
      // Suspense stream instead of a one-shot count() that cannot.
      const ask = askSeedOrg(page);
      await expect(
        ask,
        "the seed refugio does not cover this pet's zone — the org picker is empty for it (seeded by scripts/seed-test-users.ts).",
      ).toBeVisible({ timeout: 20_000 });
      await ask.click();
      // The OUTCOME: the same surface, in its pending state, under the same name.
      //
      // 30 s, not the file's usual 20 s, and not the config's 15 s default.
      // Measured on staging: this server action takes ~17,5 s end to end on a
      // cold serverless instance — the DB write tail is 392 ms, so the time is
      // spent waking the function, not writing. playwright.staging.config.ts
      // sets expect.timeout = 15_000, so the assertion expired while the action
      // SUCCEEDED: the case row was there afterwards. A red test over a green
      // mutation is the worst kind, because the obvious reading is "the feature
      // is broken".
      //
      // 20 s would be marginal against a measured 17,5 s — it leaves 2,5 s for
      // the navigation and re-render that follow, which is not a budget, it is
      // a coin flip. 30 s is the same class of race the comment at the org's
      // accept step below already documents; that comment named the hazard and
      // never applied the lesson here.
      await expect(page.getByText(/Pedido enviado a .*Refugio Test/i)).toBeVisible({
        timeout: 30_000,
      });
      const caseHref = await page
        .getByRole("link", { name: /Ver la solicitud/ })
        .getAttribute("href");
      expect(caseHref, "the request's case code, from the titular's own link").toMatch(
        /^\/casos\/CAS-/,
      );

      // ---- the org finds it in its inbox and answers from the detail ----------
      const orgContext = await browser.newContext();
      const orgPage = await orgContext.newPage();
      try {
        await loginAs(orgPage, ORG_ADMIN);
        const orgToken = await resolveOrgToken(orgPage, SEED_ORG);

        await orgPage.goto(`/org/${orgToken}/casos?kind=rehome_request&status=open`, {
          waitUntil: "domcontentloaded",
        });
        await expect(
          orgPage.locator(`a[href="${caseHref}"]`).first(),
          "the request is in the org's Casos inbox (REQ-2)",
        ).toBeVisible();

        await orgPage.goto(caseHref as string, { waitUntil: "domcontentloaded" });
        await orgPage.getByRole("button", { name: "Aceptar el acompañamiento" }).click();
        // The consequence, BEFORE the click: the animal is not in the org's possession.
        await expect(orgPage.getByText(/no lo tiene en su poder/)).toBeVisible();
        await orgPage.getByRole("button", { name: "Confirmar el acompañamiento" }).click();
        // The OUTCOME first, on the page the action itself navigates to
        // (navigateAfterActionSuccess → a full document load of this case).
        // A hand-made goto before the action settles races it: the mutation
        // still commits server-side, but the hand-loaded document can be the
        // pre-commit one, and expect() polls that DOM without ever reloading
        // it (seen locally 2026-08-22: spine written at :50, page read at :49).
        await expect(orgPage.getByText("Solicitud aceptada por la organización")).toBeVisible({
          timeout: 20_000,
        });
        // Then an independent re-read of the same case.
        await orgPage.goto(caseHref as string, { waitUntil: "domcontentloaded" });
        await expect(orgPage.getByText("Solicitud aceptada por la organización")).toBeVisible();
        await expect(
          orgPage.getByRole("button", { name: "Aceptar el acompañamiento" }),
        ).toHaveCount(0);
      } finally {
        await orgContext.close();
      }

      // ---- the titular sees the accompaniment and ends it, unilaterally -------
      await page.goto(`/mis-mascotas/${token}/buscar-hogar`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText(/acompaña la adopción de/)).toBeVisible();
      await page.getByRole("button", { name: "Dar de baja el acompañamiento" }).click();
      await expect(page.getByText(/se retira de la búsqueda de hogar/)).toBeVisible();
      await page.getByRole("button", { name: "Confirmar la baja" }).click();
      // Same discipline as the org's accept above: the outcome first, on the
      // page the action navigates to by itself (the "none" state's picker),
      // then an independent re-read.
      await expect(
        page.getByRole("button", { name: /Pedir acompañamiento a/ }).first(),
      ).toBeVisible({ timeout: 20_000 });

      await page.goto(`/mis-mascotas/${token}/buscar-hogar`, { waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("button", { name: /Pedir acompañamiento a/ }).first(),
      ).toBeVisible();
      await expect(page.getByText(/acompaña la adopción de/)).toHaveCount(0);
    });
  });
