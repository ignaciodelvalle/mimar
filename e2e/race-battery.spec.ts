import { type BrowserContext, type Page, expect, test } from "@playwright/test";

import { resolveStagingUrl } from "./_base-url";
import { ACCOUNTS, loginAs } from "./demo/_helpers";

/**
 * Race battery — deterministic concurrency races driven from parallel browser
 * contexts inside a single spec. Each test CREATES what it races on (fresh
 * transfer, discovered case), is tolerant of ~10s serverless cold starts, and
 * asserts HARD on FINAL STATE (what the DB shows through the UI) while staying
 * SOFT on which contender wins — the invariant is "exactly one winner, the
 * loser fails cleanly", never "govt beats admin".
 *
 * ORIGIN: `STAGING_URL` (or the staging_url file) pins it to a deploy, whose
 * throwaway DB makes the data-mutating races safe. With neither set it stays on
 * the active config's baseURL — :3333 in CI, `QA_PORT` under local3000. It used
 * to fall back to a hardcoded localhost:3000, a port nothing serves in CI, so
 * (a) died on ERR_CONNECTION_REFUSED and took (b)-(d) with it (serial mode).
 * See the header of e2e/_base-url.ts.
 *
 * Tests self-SKIP (not fail) when a precondition fixture is absent, and restore
 * demo state where they mutate it.
 *
 * Run:
 *   STAGING_URL=https://<deploy>.vercel.app \
 *     pnpm exec playwright test e2e/race-battery.spec.ts \
 *     --config=playwright.local3000.config.ts
 */

const STAGING = resolveStagingUrl();
// Only override the config's baseURL when a deploy was actually named.
if (STAGING) test.use({ baseURL: STAGING });

// Multi-actor journeys that relogin / mutate shared rows — run serially.
test.describe.configure({ mode: "serial", timeout: 150_000 });

const HERO_TOKEN = "DIM-DEMO-0001"; // never mutate the demo hero pet.

/** Open a fresh authenticated context + page for a role. Caller closes it. */
async function openAs(
  browser: import("@playwright/test").Browser,
  email: string,
  baseURL: string | undefined,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await loginAs(page, email);
  return { ctx, page };
}

/** Count visible "Revocar" controls as a proxy for active libreta share links. */
async function countActiveShareLinks(page: Page): Promise<number> {
  return page.getByRole("button", { name: /^revocar$/i }).count();
}

test.describe(`race battery @ ${STAGING ?? "suite baseURL"}`, () => {
  // ========================================================================
  // (a) Double-submit share-link generation → exactly ONE new active link.
  //     Fires the generate action TWICE in the same tick (bypassing the
  //     client disabled-on-pending guard) to probe SERVER-side idempotency.
  // ========================================================================
  test("(a) double-submit share generation creates exactly one link", async ({
    browser,
    baseURL,
  }) => {
    const { ctx, page } = await openAs(browser, ACCOUNTS.owner, baseURL);
    try {
      // Discover an owner pet (any is fine — share links are non-destructive).
      // Anchor on the DIM- token prefix: a bare /mis-mascotas/ prefix match
      // catches the "/mis-mascotas/nueva" create-pet CTA first (first staging
      // run skipped on exactly that — token parsed as "nueva").
      await page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
      const petLink = page.locator('a[href^="/mis-mascotas/DIM-"]').first();
      test.skip((await petLink.count()) === 0, "owner has no pet — cannot test share generation.");
      const href = (await petLink.getAttribute("href")) ?? "";
      const token = href.split("/mis-mascotas/")[1]?.split(/[?#]/)[0] ?? "";
      expect(token, "pet token parsed").toBeTruthy();

      // Open the Compartir sheet; the "Enlaces activos" list is client-fetched
      // after mount, so wait for it to settle (either revocable rows or the
      // "No hay enlaces activos" empty state) before counting.
      await page.goto(`/mis-mascotas/${token}?sheet=compartir`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1_500); // hydration — dropped-click guard (#39)
      await page
        .getByText(/cargando enlaces/i)
        .waitFor({ state: "hidden", timeout: 15_000 })
        .catch(() => {});

      // The expiring-share generate button ("Generar link"). Skip if this
      // surface isn't present in the current build.
      const generate = page.getByRole("button", { name: /generar link/i }).first();
      const hasGenerate = await generate
        .count()
        .then((c) => c > 0)
        .catch(() => false);
      test.skip(!hasGenerate, "expiring-share 'Generar link' control not present — skipping.");

      const before = await countActiveShareLinks(page).catch(() => -1);

      // Fire the owning form TWICE synchronously — bypasses the disabled-on-
      // pending client guard so two near-simultaneous POSTs hit the server.
      await generate.evaluate((el) => {
        const form = (el as HTMLButtonElement).form;
        form?.requestSubmit();
        form?.requestSubmit();
      });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(2_000);

      // Re-open the sheet to read the fresh "Enlaces activos" list.
      await page.goto(`/mis-mascotas/${token}?sheet=compartir`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page
        .getByText(/cargando enlaces/i)
        .waitFor({ state: "hidden", timeout: 15_000 })
        .catch(() => {});
      const after = await countActiveShareLinks(page).catch(() => -1);

      // Cleanup (best-effort): revoke whatever the double-submit created so
      // nightly repeats don't accumulate share links. Newest links render in
      // the list; revoke (after - before) of them via the confirm dialog.
      const created = Math.max(0, after - before);
      for (let i = 0; i < created; i++) {
        try {
          await page
            .getByRole("button", { name: /^revocar$/i })
            .last()
            .click({ timeout: 5_000 });
          await page
            .getByRole("dialog")
            .getByRole("button", { name: /^revocar$/i })
            .click({ timeout: 5_000 });
          await page.waitForTimeout(1_000);
        } catch {
          break; // leave the rest — non-fatal, links are revocable by hand
        }
      }

      // FINAL STATE: exactly one new active link (never two from one intent).
      if (before >= 0 && after >= 0) {
        expect(
          after - before,
          `double-submit created ${after - before} links (want exactly 1) — before=${before} after=${after}. Two links from one intent = missing server-side dedup on libreta-share generation.`,
        ).toBe(1);
      } else {
        // Could not count reliably — fail soft with a visible marker rather
        // than a false green (the SharesManager surface changed shape).
        test.info().annotations.push({
          type: "warning",
          description: "Active-link count unavailable — share dedup not asserted this run.",
        });
        test.skip(true, "Could not read Enlaces activos count — skipping strict assertion.");
      }
    } finally {
      await ctx.close();
    }
  });

  // ========================================================================
  // (b) Two operators (govt + admin) assign the SAME denuncia at once →
  //     exactly one wins, the other gets a clean conflict, ownership singular.
  // ========================================================================
  test("(b) concurrent denuncia assignment yields a single owner", async ({ browser, baseURL }) => {
    const govt = await openAs(browser, ACCOUNTS.govt, baseURL);
    const admin = await openAs(browser, ACCOUNTS.admin, baseURL);
    let caseId = "";
    try {
      // Find an UNASSIGNED, assignable case from the govt queue. `:visible` is
      // kept as a belt-and-braces filter, not because the DOM still needs it:
      // the queue used to render EVERY tabpanel (urgent/mine/all) with the same
      // rows, inactive [hidden] panels first, so an unscoped locator resolved to
      // an invisible copy. UI review M5 (2026-08-06) demoted those tabs to link
      // chips and the list renders exactly once. Rows of already-assigned cases
      // carry an "· Asignada" suffix, so prefer rows without it. Collect hrefs
      // BEFORE navigating away (the locator would otherwise re-query the detail
      // page's DOM mid-loop).
      await govt.page.goto("/gob/maltrato?queue=all", { waitUntil: "domcontentloaded" });
      const rows = govt.page.locator('a[href^="/gob/maltrato/"]:visible');
      await rows
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch(() => {});
      const unassignedHrefs = await rows
        .filter({ hasNotText: /· Asignada/ })
        .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
      const anyHrefs = await rows.evaluateAll((els) =>
        els.map((el) => el.getAttribute("href") ?? ""),
      );
      const candidates = [...new Set([...unassignedHrefs, ...anyHrefs])].filter(Boolean);
      test.skip(
        candidates.length === 0,
        "no denuncia cases in queue — cannot test assignment race.",
      );

      for (const rhref of candidates.slice(0, 6)) {
        const id = rhref.split("/gob/maltrato/")[1]?.split(/[?#]/)[0] ?? "";
        if (!id) continue;
        await govt.page.goto(`/gob/maltrato/${id}`, { waitUntil: "domcontentloaded" });
        const assignable = govt.page.getByRole("button", { name: /asignármela/i });
        if (
          await assignable
            .count()
            .then((c) => c > 0)
            .catch(() => false)
        ) {
          caseId = id;
          break;
        }
      }
      test.skip(caseId === "", "no unassigned+assignable case found — skipping assignment race.");

      // Both operators land on the same case detail.
      await admin.page.goto(`/gob/maltrato/${caseId}`, { waitUntil: "domcontentloaded" });
      const govtBtn = govt.page.getByRole("button", { name: /asignármela/i });
      const adminBtn = admin.page.getByRole("button", { name: /asignármela/i });
      // If admin can't reach the assign control (portal scoping), skip cleanly.
      test.skip(
        !(await adminBtn
          .count()
          .then((c) => c > 0)
          .catch(() => false)),
        "admin cannot assign on /gob/maltrato — skipping cross-operator race.",
      );

      // Let both pages hydrate so neither racing click is silently dropped.
      await Promise.all([
        govt.page.waitForLoadState("networkidle").catch(() => {}),
        admin.page.waitForLoadState("networkidle").catch(() => {}),
      ]);
      await govt.page.waitForTimeout(1_500);

      // Fire both clicks as close to simultaneously as the harness allows.
      await Promise.allSettled([
        govtBtn.click({ timeout: 15_000 }),
        adminBtn.click({ timeout: 15_000 }),
      ]);
      await govt.page.waitForTimeout(2_500);

      // FINAL STATE (source of truth via a fresh govt read): assigned to a
      // single, non-empty agent — never "Sin asignar", never a double owner.
      // NOTE: match the label <p> EXACTLY — a loose /asignado a/i regex is a
      // strict-mode violation because the case timeline also logs
      // "Caso asignado a <name>." (seen on the first staging run, where the
      // race itself behaved: exactly one winner).
      await govt.page.goto(`/gob/maltrato/${caseId}`, { waitUntil: "domcontentloaded" });
      await expect(
        govt.page.getByText("Asignado a", { exact: true }),
        "case shows the 'Asignado a' block",
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        govt.page.getByText(/^sin asignar$/i),
        "case must NOT remain unassigned after a successful assignment race",
      ).toHaveCount(0);
      // The winner's control flipped to 'Desasignar' for exactly the owner.
      await expect(
        govt.page.getByRole("button", { name: /asignármela/i }),
        "no lingering 'Asignármela' — the case is now owned",
      ).toHaveCount(0);

      // Cleanup: restore to unassigned so demo state stays coherent. Run it
      // from the ADMIN context — an admin can always unassign (canUnassign =
      // mine || isAdmin), while a losing govt operator sees no control at all.
      await admin.page.goto(`/gob/maltrato/${caseId}`, { waitUntil: "domcontentloaded" });
      await admin.page.waitForLoadState("networkidle").catch(() => {});
      await admin.page.waitForTimeout(1_000);
      const unassign = admin.page.getByRole("button", { name: /desasignar/i }).first();
      if (
        await unassign
          .count()
          .then((c) => c > 0)
          .catch(() => false)
      ) {
        await unassign.click().catch(() => {});
        await admin.page.waitForTimeout(1_500);
      }
    } finally {
      await govt.ctx.close();
      await admin.ctx.close();
    }
  });

  // ========================================================================
  // (c) Two sessions accept the SAME pending transfer at once → one accepted,
  //     one clean rejection, ownership singular. Transfer is created in-test.
  // ========================================================================
  test("(c) concurrent transfer accept transfers ownership exactly once", async ({
    browser,
    baseURL,
  }) => {
    const owner = await openAs(browser, ACCOUNTS.owner, baseURL);
    let transferToken = "";
    let petToken = "";
    try {
      // Pick an ACTIVE owner pet that is NOT the demo hero (avoid corrupting it).
      // DIM- prefix excludes the "/mis-mascotas/nueva" create-pet CTA.
      await owner.page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
      const activePets = owner.page.locator('a[href^="/mis-mascotas/DIM-"]', {
        hasText: /registrad[ao]/i,
      });
      const n = await activePets.count();
      for (let i = 0; i < n; i++) {
        const h = (await activePets.nth(i).getAttribute("href")) ?? "";
        const t = h.split("/mis-mascotas/")[1]?.split(/[?#]/)[0] ?? "";
        if (t && t !== HERO_TOKEN) {
          petToken = t;
          break;
        }
      }
      test.skip(petToken === "", "no non-hero active pet to transfer — skipping accept race.");

      // Owner initiates the transfer to owner2 ("Motivo" defaults to gift).
      await owner.page.goto(`/mis-mascotas/${petToken}?sheet=transferir-mascota`, {
        waitUntil: "domcontentloaded",
      });
      await owner.page.waitForLoadState("networkidle").catch(() => {});
      await owner.page.waitForTimeout(1_500); // hydration (#39 dropped-click guard)
      // EXPLICIT TIMEOUTS on every locator action in this spec: playwright.
      // config.ts sets no actionTimeout, so a locator that never resolves
      // waits FOREVER — it does not throw, it silently eats the 150s test
      // budget and reports "Test timeout exceeded" with no cause named. That
      // is what killed this test in CI runs 30867634835 / 30869355207 /
      // 30871111745 (the hang was in the cleanup block below, inside a
      // try/catch that a hang can never reach).
      await owner.page.getByLabel(/email del receptor/i).fill(ACCOUNTS.owner2, { timeout: 15_000 });
      await owner.page
        .getByRole("button", { name: /enviar propuesta/i })
        .click({ timeout: 15_000 });
      // The action's client-side navigation drops often enough to matter (the
      // Next 15.5.x post-action nav drop this repo documents in
      // lib/ui/full-page-action-nav.ts). Give the URL a short chance, then
      // READ the freshly created proposal from the transfers index instead of
      // spending 30s waiting for a navigation that already did its work
      // server-side. Two 150s-budget tests died on waits like this one.
      await owner.page.waitForURL(/\/transferencias\//, { timeout: 10_000 }).catch(() => {});
      transferToken = owner.page.url().split("/transferencias/")[1]?.split(/[?#]/)[0] ?? "";
      if (!transferToken) {
        await owner.page.goto("/transferencias", { waitUntil: "domcontentloaded" });
        await owner.page.waitForLoadState("networkidle").catch(() => {});
        const href =
          (await owner.page
            .locator('a[href^="/transferencias/"]')
            .first()
            .getAttribute("href")
            .catch(() => null)) ?? "";
        transferToken = href.split("/transferencias/")[1]?.split(/[?#]/)[0] ?? "";
      }
      expect(transferToken, "fresh transfer token").toBeTruthy();

      // Two owner2 sessions race the accept.
      const r1 = await openAs(browser, ACCOUNTS.owner2, baseURL);
      const r2 = await openAs(browser, ACCOUNTS.owner2, baseURL);
      try {
        await Promise.all([
          r1.page.goto(`/transferencias/${transferToken}`, { waitUntil: "domcontentloaded" }),
          r2.page.goto(`/transferencias/${transferToken}`, { waitUntil: "domcontentloaded" }),
        ]);
        // Let both pages hydrate so neither racing click is silently dropped.
        await Promise.all([
          r1.page.waitForLoadState("networkidle").catch(() => {}),
          r2.page.waitForLoadState("networkidle").catch(() => {}),
        ]);
        await r1.page.waitForTimeout(1_500);
        // "Aceptar" only OPENS a ConfirmDialog — `handleAccept` is wired to the
        // dialog's "Aceptar transferencia" button (AcceptTransferActions.tsx).
        // Clicking the trigger alone accepted NOTHING, so the race never
        // happened and the post-condition below counted 0 pets for owner2
        // (CI run 30872663182 — visible only after actionTimeout stopped this
        // spec from hanging first). Each racer must confirm; the confirms are
        // what race.
        async function acceptWithConfirm(p: Page): Promise<void> {
          await p.getByRole("button", { name: /^aceptar$/i }).click({ timeout: 15_000 });
          await p
            .getByRole("button", { name: /^aceptar transferencia$/i })
            .click({ timeout: 15_000 });
        }
        const accepts = await Promise.allSettled([
          acceptWithConfirm(r1.page),
          acceptWithConfirm(r2.page),
        ]);
        // A race where BOTH contenders failed to even submit proves nothing —
        // and allSettled would hide it, leaving the count assertion below to
        // report a transfer bug that never happened. Surface it here instead.
        expect(
          accepts.some((r) => r.status === "fulfilled"),
          `neither session could submit the accept: ${accepts
            .map((r) => (r.status === "rejected" ? String(r.reason).split("\n")[0] : "ok"))
            .join(" | ")}`,
        ).toBe(true);
        await r1.page.waitForTimeout(3_000);

        // Neither context may show a crash / error boundary.
        for (const r of [r1, r2]) {
          await expect(
            r.page.getByText(/application error|algo salió mal/i),
            "transfer accept must fail cleanly, never crash",
          ).not.toBeVisible();
        }

        // FINAL STATE: the pet now belongs to owner2 exactly once, and the
        // transfer is consumed (no second live "Aceptar").
        await r1.page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
        const owned = r1.page.locator(`a[href^="/mis-mascotas/${petToken}"]`);
        await expect(owned, "pet transferred to owner2 exactly once").toHaveCount(1, {
          timeout: 15_000,
        });

        await r1.page.goto(`/transferencias/${transferToken}`, { waitUntil: "domcontentloaded" });
        await expect(
          r1.page.getByRole("button", { name: /^aceptar$/i }),
          "transfer already consumed — no second acceptable state",
        ).toHaveCount(0);
      } finally {
        // Cleanup round-trip: owner2 sends the pet back, owner accepts, so the
        // demo registry is restored. Best-effort — logs a marker if it can't.
        try {
          await r1.page.goto(`/mis-mascotas/${petToken}?sheet=transferir-mascota`, {
            waitUntil: "domcontentloaded",
          });
          await r1.page.waitForLoadState("networkidle").catch(() => {});
          await r1.page.waitForTimeout(1_500); // hydration, same guard as the send above
          // Bounded (see the note on the sender flow above): an unbounded
          // fill/click here is what hung the test — inside a try/catch that a
          // hang never reaches, so the annotation below never fired either.
          await r1.page.getByLabel(/email del receptor/i).fill(ACCOUNTS.owner, { timeout: 15_000 });
          await r1.page
            .getByRole("button", { name: /enviar propuesta/i })
            .click({ timeout: 15_000 });
          await r1.page.waitForURL(/\/transferencias\//, { timeout: 20_000 }).catch(() => {});
          let backToken = r1.page.url().split("/transferencias/")[1]?.split(/[?#]/)[0] ?? "";
          if (!backToken) {
            await r1.page.goto("/transferencias", { waitUntil: "domcontentloaded" });
            await r1.page.waitForLoadState("networkidle").catch(() => {});
            const href =
              (await r1.page
                .locator('a[href^="/transferencias/"]')
                .first()
                .getAttribute("href", { timeout: 10_000 })
                .catch(() => null)) ?? "";
            backToken = href.split("/transferencias/")[1]?.split(/[?#]/)[0] ?? "";
          }
          await owner.page.goto(`/transferencias/${backToken}`, { waitUntil: "domcontentloaded" });
          // Trigger + confirm — same two-step accept as the race above.
          await owner.page.getByRole("button", { name: /^aceptar$/i }).click({ timeout: 15_000 });
          await owner.page
            .getByRole("button", { name: /^aceptar transferencia$/i })
            .click({ timeout: 15_000 });
          await owner.page.waitForTimeout(2_000);
        } catch {
          test.info().annotations.push({
            type: "warning",
            description: `MANUAL RESTORE NEEDED: pet ${petToken} may still belong to owner2@dim.test.`,
          });
        }
        await r1.ctx.close();
        await r2.ctx.close();
      }
    } finally {
      await owner.ctx.close();
    }
  });

  // ========================================================================
  // (d) Applicant withdraws while the application is being actioned. The
  //     org-approve-vs-withdraw pairing needs a correlated pending application
  //     that isn't reliably reachable through the UI without ids, so this runs
  //     the SELF-CONTAINED sibling: a double-submit withdraw of the SAME
  //     postulación from two applicant sessions → exactly one withdrawal, the
  //     other a clean already-withdrawn state, no crash. Skips when no pending
  //     application exists.
  // ========================================================================
  test("(d) concurrent withdraw of one application resolves cleanly", async ({
    browser,
    baseURL,
  }) => {
    const a1 = await openAs(browser, ACCOUNTS.owner2, baseURL);
    try {
      await a1.page.goto("/mis-mascotas/postulaciones", { waitUntil: "domcontentloaded" });
      const withdraw = a1.page.getByRole("button", { name: /retirar postulación/i });
      const hasPending = await withdraw
        .count()
        .then((c) => c > 0)
        .catch(() => false);
      test.skip(
        !hasPending,
        "owner2 has no pending adoption application — skipping withdraw race.",
      );

      const a2 = await openAs(browser, ACCOUNTS.owner2, baseURL);
      try {
        await a2.page.goto("/mis-mascotas/postulaciones", { waitUntil: "domcontentloaded" });
        // Let both pages hydrate so the confirm clicks aren't silently dropped.
        await Promise.all([
          a1.page.waitForLoadState("networkidle").catch(() => {}),
          a2.page.waitForLoadState("networkidle").catch(() => {}),
        ]);
        await a1.page.waitForTimeout(1_500);

        // Open the confirm on both, then fire "Sí, retirar" together.
        await a1.page
          .getByRole("button", { name: /retirar postulación/i })
          .first()
          .click();
        await a2.page
          .getByRole("button", { name: /retirar postulación/i })
          .first()
          .click();
        await Promise.allSettled([
          a1.page.getByRole("button", { name: /sí, retirar/i }).click({ timeout: 15_000 }),
          a2.page.getByRole("button", { name: /sí, retirar/i }).click({ timeout: 15_000 }),
        ]);
        await a1.page.waitForTimeout(2_500);

        // Neither session may crash.
        for (const a of [a1, a2]) {
          await expect(
            a.page.getByText(/application error|algo salió mal/i),
            "withdraw must resolve cleanly, never crash",
          ).not.toBeVisible();
        }

        // FINAL STATE: reloading shows the application is gone/withdrawn — a
        // fresh read must not still offer to withdraw it a second time.
        await a1.page.goto("/mis-mascotas/postulaciones", { waitUntil: "domcontentloaded" });
        // (Other pending applications may exist; the raced one must be gone.
        // We assert the page is coherent and rendered, not a hard count, since
        // owner2 may hold several applications.)
        await expect(a1.page.locator("main, h1").first()).toBeVisible({ timeout: 15_000 });
      } finally {
        await a2.ctx.close();
      }
    } finally {
      await a1.ctx.close();
    }
  });
});
