import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";

import { passwordForPage } from "./_credentials";
import { passSecondFactorIfAsked, skipUnlessRemoteLoginAllowed } from "./_mfa";
import { SIGN_IN_PATH, leftSignIn } from "./_sign-in-route";
import { uniqueIp } from "./demo/_helpers";

/**
 * Authorization A/B isolation — LIVE validation (launchworthy Domain 3, the last
 * provisional manual check). Proves, against the running :3000 QA server, that:
 *   1. Owner B cannot open Owner A's private pet surface (/mis-mascotas/[token]).
 *   2. A non-member cannot open an org portal they don't belong to (/org/[token]).
 *   3. A personal account cannot reach an institutional API (/api/panorama/*),
 *      and cannot widen scope by crafting params.
 *
 * Read-only. No writes. Same auth-reuse + unique-x-real-ip conventions as
 * e2e/owner-ia-p6.spec.ts (a suite hammering one localhost IP trips the per-IP
 * login limits — we are not testing throttling, so each context gets a distinct
 * RFC-5737 documentation IP and each account logs in once). The header half of
 * that convention is honoured ONLY where no rewriting edge sits in front of the
 * origin: against staging Vercel overwrites x-real-ip before callerIp() sees it
 * (measured 2026-08-26 — lib/infra/rate-limit.ts above callerIp()), and the
 * log-in-once half is what carries the suite there.
 *
 * ─── FIXTURE TIER (why these accounts and not the demo cast) ───────────────
 * This spec used to run on ignacio/noeli/lilian@dim.test and the hardcoded
 * tokens DIM-SNPY-0004 / DIM-8M5Z-5G4C. Those exist ONLY after the demo seed
 * chain (scripts/seed-demo.ts + the storyline modules), which CI does not run:
 * `pnpm db:bootstrap` seeds reference data and scripts/seed-test-users.ts, and
 * nothing else. So the first CI run that actually reported a verdict answered
 * "Correo o contraseña incorrectos." for all three tests — the accounts simply
 * were not there. It looked green locally only because this machine had the
 * demo seed applied by hand months ago.
 *
 * Everything below now uses the tier that `pnpm db:bootstrap` GUARANTEES, and
 * discovers tokens at runtime instead of hardcoding them, so the spec runs in
 * CI and locally alike (same approach as e2e/cross-tenant-isolation.spec.ts,
 * which is why that one has always passed in CI):
 *   owner@dim.test    — Owner A, has pets (token read from /mis-mascotas).
 *   owner2@dim.test   — Owner B: a separate personal tenant, and a member of
 *                       NO organization, so it doubles as the non-member.
 *   orgadmin@dim.test — admin of "Refugio Test (Seed)"; used only to resolve
 *                       that org's token, which is then the FOREIGN org for B.
 */

const OWNER_A = "owner@dim.test";
const OWNER_B = "owner2@dim.test";
// owner2 belongs to no organization, so "Owner B" and "non-member" are the same
// account. Keeping the alias makes each test read as the property it proves.
const NON_MEMBER = OWNER_B;
const ORG_ADMIN = "orgadmin@dim.test";

// uniqueIp is imported, not redeclared. This file used to keep a private copy
// with its own counter starting at 203.0.113.1 — the same first address the
// shared helper hands out — so the two generators collided on every value and
// the per-IP budget they exist to spread was shared after all. One counter per
// worker is the whole point.

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const stateCache = new Map<string, StorageState>();

async function login(page: Page, email: string) {
  await page.goto(SIGN_IN_PATH);
  // Refuse (skip) BEFORE the password is resolved or typed: on a remote target
  // only the rotated e2e accounts may sign in (e2e/_credentials.ts).
  skipUnlessRemoteLoginAllowed(page.url(), email);
  const password = passwordForPage(page.url(), email);
  await page.getByLabel(/correo electrónico/i).fill(email);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  const loginError = page
    .getByRole("alert")
    .filter({ hasText: /intento|contraseñ|inválid|error/i });
  await expect
    .poll(
      async () => {
        if (await loginError.count()) {
          const txt = (
            await loginError
              .first()
              .innerText()
              .catch(() => "")
          ).trim();
          if (txt) throw new Error(`login blocked for ${email}: "${txt}"`);
        }
        // Booleano, no pathname — el gemelo exacto del helper de
        // owner-ia-p6.spec.ts, con el mismo defecto: `/iniciar-sesion` no
        // matchea `/^\/login/`, así que la condición se cumplía parada en el
        // formulario y el storageState cacheado era ANÓNIMO.
        return leftSignIn(new URL(page.url()));
      },
      { timeout: 30_000, intervals: [150, 250, 500, 500, 1000, 1500] },
    )
    .toBe(true);
  // Leaving the sign-in page may mean landing on /mfa (T2-S6, e2e/_mfa.ts).
  await passSecondFactorIfAsked(page, email, password);
}

async function stateFor(browser: Browser, email: string): Promise<StorageState> {
  const cached = stateCache.get(email);
  if (cached) return cached;
  const context = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": uniqueIp() } });
  try {
    const page = await context.newPage();
    await login(page, email);
    const state = await context.storageState();
    stateCache.set(email, state);
    return state;
  } finally {
    await context.close();
  }
}

async function openAs(
  browser: Browser,
  email: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    storageState: await stateFor(browser, email),
    extraHTTPHeaders: { "x-real-ip": uniqueIp() },
  });
  const page = await context.newPage();
  return { context, page };
}

/**
 * Owner A's first pet token, read from their own registry.
 *
 * Hardcoding a token is what broke this spec: a literal is a bet that one row
 * survives every re-seed, and it silently turns into a 404 the day it does not
 * — at which point "B cannot see A's pet" passes for the wrong reason, because
 * NOBODY can see it. Reading the token from A's own /mis-mascotas makes the
 * fixture true by construction and keeps the negative test meaningful.
 */
async function ownerAPetToken(browser: Browser): Promise<string> {
  const a = await openAs(browser, OWNER_A);
  try {
    await a.page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
    await a.page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    // `/mis-mascotas/` alone also matches the sibling routes the registry links
    // to — /nueva, /reclamar, /postulaciones. Anchoring on the `DIM-` prefix
    // keeps this to real credentials: the token shape is invariant #1 and lives
    // in lib/domain/dim-token.ts. (Without it this resolved to "nueva", and the
    // isolation test then proved only that both owners can open the add-a-pet
    // form — a green that asserts nothing.)
    const link = a.page.locator('a[href^="/mis-mascotas/DIM-"]').first();
    await expect(link, "Owner A must own at least one pet").toBeVisible();
    const token = ((await link.getAttribute("href")) ?? "").split("/mis-mascotas/")[1] ?? "";
    expect(token, "pet token parsed from Owner A's registry link").toBeTruthy();
    return token.split(/[?#]/)[0];
  } finally {
    await a.context.close();
  }
}

/** The token of "Refugio Test (Seed)", resolved from its own admin's portal. */
async function foreignOrgToken(browser: Browser): Promise<string> {
  const o = await openAs(browser, ORG_ADMIN);
  try {
    await o.page.goto("/org", { waitUntil: "domcontentloaded" });
    await o.page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    let match = o.page.url().match(/\/org\/([^/?#]+)/);
    if (!match) {
      const card = o.page.locator('a[href^="/org/"]').first();
      await expect(card, "org picker card for the seeded refugio").toBeVisible();
      await card.click();
      await o.page.waitForURL(/\/org\/[^/?#]+/, { timeout: 15_000 });
      match = o.page.url().match(/\/org\/([^/?#]+)/);
    }
    const token = match?.[1] ?? "";
    expect(token, "org token resolved from the org-admin's portal").toBeTruthy();
    return token;
  } finally {
    await o.context.close();
  }
}

test.describe("Authorization A/B isolation (live)", () => {
  test("Owner B cannot open Owner A's private pet surface", async ({ browser }) => {
    const OWNER_A_PET = await ownerAPetToken(browser);

    // Sanity: Owner A can open their own pet.
    const a = await openAs(browser, OWNER_A);
    try {
      const res = await a.page.goto(`/mis-mascotas/${OWNER_A_PET}`);
      expect(res?.status(), "Owner A opening own pet should be 200").toBe(200);
      await expect(a.page).toHaveURL(new RegExp(`/mis-mascotas/${OWNER_A_PET}`));
    } finally {
      await a.context.close();
    }

    // Owner B requests A's pet by its exact token. requirePetAccess is !ok →
    // notFound(). The SECURITY property is that B sees the not-found surface and
    // NONE of A's owner data — not the exact HTTP code (Next 15 renders a
    // page-level notFound() with a 200 document status here, a framework
    // semantics quirk, not an authz failure; asserted separately/softly below).
    const b = await openAs(browser, OWNER_B);
    try {
      await b.page.goto(`/mis-mascotas/${OWNER_A_PET}`);
      // The not-found boundary fired (the guard denied access).
      await expect(
        b.page.getByRole("heading", { name: /no encontramos esta página/i }),
      ).toBeVisible();
      // And A's owner-only surface never leaked to B.
      await expect(b.page.locator("[data-section=libreta-emergencia]")).toHaveCount(0);
      await expect(b.page.getByRole("button", { name: /anotar algo/i })).toHaveCount(0);
    } finally {
      await b.context.close();
    }
  });

  test("Non-member cannot open a foreign org portal", async ({ browser }) => {
    // Resolved from the org's OWN admin, which also proves the portal exists —
    // so a 404 for the non-member is a denial, not a missing row.
    const FOREIGN_ORG = await foreignOrgToken(browser);

    const m = await openAs(browser, NON_MEMBER);
    try {
      // owner2 belongs to no organization; this refugio must answer notFound
      // (no existence leak — decision D4), never its dashboard.
      const res = await m.page.goto(`/org/${FOREIGN_ORG}`);
      expect(res?.status(), "non-member opening foreign org must be 404").toBe(404);
    } finally {
      await m.context.close();
    }
  });

  test("Personal account cannot reach the institutional panorama API", async ({ browser }) => {
    const b = await openAs(browser, OWNER_B);
    try {
      // A personal (non-institutional) session hitting the govt/admin API must
      // be rejected by the _guard (401/403), even with crafted scope params
      // that try to widen to another province.
      const res = await b.page.request.get(
        "/api/panorama/cobertura?level=locality&province=AR-B&asOf=2026-07-01",
        { headers: { "x-real-ip": uniqueIp() } },
      );
      expect(
        [401, 403].includes(res.status()),
        `personal account on /api/panorama must be 401/403, got ${res.status()}`,
      ).toBe(true);
      const body = await res.text();
      // The rejection body must not carry panorama feature data.
      expect(body).not.toContain("features");
    } finally {
      await b.context.close();
    }
  });
});
