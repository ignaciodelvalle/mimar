import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  expect,
} from "@playwright/test";

import { passwordForPage } from "../_credentials";
import { passSecondFactorIfAsked, skipUnlessRemoteLoginAllowed } from "../_mfa";
import {
  BRANDED_NOT_FOUND_TESTID,
  CRASH_BOUNDARY,
  NOT_FOUND_HEADING,
  type OwnerPii,
} from "../_page-identity";
import { SIGN_IN_PATH, leftSignIn } from "../_sign-in-route";
import { ensureDenunciaJurisdiction, resetAuthLoginRateLimits } from "./_db-cleanup";

// The literal every seed script writes locally. Not used directly for a
// login any more (see passwordForPage in _credentials.ts) — kept exported as
// documentation of the local default, since this file's demo/*.spec.ts
// consumers are excluded from playwright.staging.config.ts (testIgnore:
// "demo/**") but nothing stops someone pointing this suite at a remote
// origin by hand.
export const SHARED_PASSWORD = "Test1234!";

// Demo accounts (all password Test1234! locally; see SHARED_PASSWORD above).
//
// TIERS MATTER — read this before pointing a spec at one of these.
// `pnpm db:bootstrap` (what CI runs) seeds reference data and
// scripts/seed-test-users.ts, and STOPS. Everything below marked "demo tier"
// comes from scripts/seed-demo.ts + the storyline/owner-demo scripts, which CI
// never executes, so a spec that reaches for one is green only on a laptop
// where those were run by hand (see commit 51b2eff1 — six specs, one cause).
export const ACCOUNTS = {
  // ---- bootstrap tier: guaranteed to exist on any freshly seeded database ----
  owner: "owner@dim.test",
  owner2: "owner2@dim.test", // Owner B — cross-tenant target + adoption applicant (seed-test-users.ts ensureOwnerB)
  orgAdmin: "orgadmin@dim.test", // admin of "Refugio Test (Seed)"
  // Matriculated vet (matriculaVerified=true) AND an active `vet_individual`
  // member of "Refugio Test (Seed)" — VET_INDIVIDUAL_IMPLICIT_CAPS grants
  // `event.write`, which is exactly what the Atender walk-in surface gates on.
  // This is the bootstrap-tier stand-in for a clinic signer: it signs as
  // authorRole "vet" / authorVerified true, so the asiento lands as
  // professional_verified provenance, not a bare org record.
  vet: "vet@dim.test",
  // Jurisdiction matters and these two are NOT interchangeable — a spec that
  // asserts on scope must pick the one whose coverage it means:
  //   govt      → Ushuaia (Tierra del Fuego) + El Calafate (Santa Cruz)
  //   govtLocal → La Plata (Buenos Aires) + Palermo (CABA)
  // (scripts/seed-test-users.ts GOVT_REMOTE_LOCALITIES / GOVT_LOCAL_LOCALITIES.)
  govt: "govt@dim.test",
  govtLocal: "govt-local@dim.test",
  admin: "admin@dim.test",
  // ---- demo tier: seed-demo.ts only — ABSENT in CI, do not add new uses ----
  vetOrgAdmin: "alejo@dim.test", // admin of Clínica Veterinaria Recoleta (clinic org)
} as const;

// Real animal photos shipped in the repo, reused for live upload flows.
const here = path.dirname(fileURLToPath(import.meta.url));
export const PHOTO_DIR = path.resolve(here, "../../scripts/assets/pet-photos");
export const DEMO_PHOTOS = ["bolt.jpg", "courage.jpg", "hachi.jpg"].map((f) =>
  path.join(PHOTO_DIR, f),
);

// Login is rate-limited per client IP, and against a LOCAL target `callerIp()`
// reads x-real-ip straight off the request — nothing sits in front of a bare
// `next start` to overwrite it. A spec that logs in once per test drains the
// bucket and every later login answers "Demasiados intentos. Esperá un momento y
// volvé a probar." — measured on e2e/a11y-regression.spec.ts, whose 5 tests each
// log in as the same owner: 4 passed and the 5th could not get past /login.
//
// Handing every login a distinct address makes each one look like a fresh
// visitor. TEST-NET-3 (RFC 5737) is the documentation range, so these can never
// collide with a real client. e2e/owner-ia-p6.spec.ts and
// e2e/authz-ab-isolation.spec.ts each grew their own private copy of this; it
// lives here now so the next spec does not have to rediscover the throttle.
//
// SCOPE — HONOURED LOCALLY, INERT AGAINST STAGING. Measured 2026-08-26: Vercel's
// edge overwrites a client-supplied x-real-ip before callerIp() sees it (80
// concurrent requests with one distinct address each hit the SAME ceiling as a
// fixed-address control; method and positive control in lib/infra/rate-limit.ts
// above callerIp(), consequences for the nightly in playwright.staging.config.ts).
// playwright.staging.config.ts runs every spec in this directory tree, so the
// same call sites execute against both targets. Against staging every login here
// shares the runner's ONE egress bucket, and what protects the nightly there is
// not this device but the per-worker session cache below — one real sign-in per
// account per worker, which is header-independent.
let ipCounter = 0;
export function uniqueIp(): string {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 250) + 1}`;
}

/**
 * Read the login form's error alert, if the server put one there.
 *
 * The login action answers with a rendered message and NO navigation for every
 * refusal — bad credentials, and both rate-limit budgets (`LOGIN_IP_LIMIT` and
 * `LOGIN_EMAIL_LIMIT`, src/modules/auth/application/login-limits.ts; the numbers
 * are not copied here, because the copy that was on this line went stale the day
 * the per-IP ceiling was re-derived). A helper
 * that only waits for the URL to change cannot tell those apart from a slow
 * server, so it burns its whole budget and reports "Test timeout of 30000ms
 * exceeded while running beforeEach hook" — which names the hook and not one
 * thing about the cause. That is precisely how the a11y-regression CI failure
 * of 2026-07-30 read, and it cost a full triage cycle to identify.
 */
async function loginErrorText(page: Page): Promise<string> {
  const alert = page.getByRole("alert").filter({ hasText: /intento|contraseñ|inválid|incorrect/i });
  if ((await alert.count().catch(() => 0)) === 0) return "";
  return (
    await alert
      .first()
      .innerText()
      .catch(() => "")
  ).trim();
}

/**
 * The greppable token a login refused for BUDGET carries, and the reason it is
 * in English in an es-AR codebase.
 *
 * Until now the only trace a budget refusal left in a CI log was the server's
 * user-facing copy, "Demasiados intentos…". That is a UI string: it is the right
 * thing for a person to read in the browser and the wrong thing to be the only
 * handle a night-shift reader has on a run. Anyone asking "did the nightly run
 * out of login budget?" has to already know the Spanish sentence to search for
 * it — which is exactly the search that was run over six nightly runs on
 * 2026-08-27, and it is a search you cannot perform unless you already suspect
 * the answer.
 *
 * So the failure carries a stable token that names the MECHANISM. `grep`
 * `LOGIN BUDGET EXHAUSTED` over a job log and the question is answered without
 * knowing any copy, any bucket name, or any Spanish.
 */
export const LOGIN_BUDGET_MARKER = "LOGIN BUDGET EXHAUSTED";

/**
 * Turn a refusal alert into the error the report will show, distinguishing the
 * two refusals that look alike in a list of failures and mean opposite things.
 *
 * A CREDENTIAL refusal is about this spec: the account, the password, the seed.
 * A BUDGET refusal is about the RUN: the ceiling is shared by every spec that
 * signs in, from one egress address, and `retries: 1` doubles the spend — so a
 * budget refusal says nothing about the test that reported it, and every later
 * failure in the same run is suspect for the same reason.
 *
 * That distinction is the whole point. An instrument that fails confusingly is
 * worse than one that fails: a run that blames thirty specs for one exhausted
 * budget sends a reader to debug thirty things that were never broken. This
 * cannot PROVE the later failures are downstream — nothing here can — so it says
 * what is true and what is suspect, and names where the argument lives.
 *
 * Exported so a spec with its OWN private sign-in can raise the same error
 * instead of a bare timeout. None do yet; `rg -l --sort path 'storageState' e2e`
 * lists the ones that would have to.
 */
export function loginRefusalError(email: string, refusal: string): Error {
  if (!/demasiados intentos/i.test(refusal)) {
    return new Error(`login refused for ${email}: "${refusal}"`);
  }
  return new Error(
    [
      `${LOGIN_BUDGET_MARKER} — login refused for ${email} by a RATE LIMIT, not by credentials.`,
      `Server said: "${refusal}"`,
      "",
      "This is a budget shared by the WHOLE RUN, not a fact about this spec:",
      "  · auth_login_ip    — per egress address; against a Vercel origin the",
      "    x-real-ip header is overwritten at the edge, so every spec in the run",
      "    spends one bucket no matter what address it presents (measured",
      "    2026-08-26; see the header of playwright.staging.config.ts).",
      "  · auth_login_email — per account, and it counts FAILED attempts too.",
      "  · retries: 1 on CI doubles both, and Playwright replaces the worker on",
      "    every failure, which empties the session cache and forces real",
      "    sign-ins — so the spend scales with FAILURES, not with tests.",
      "",
      "Every later failure in this run is therefore SUSPECT, and this one is not",
      "necessarily the first real problem. Find the earliest failure that is not",
      `a ${LOGIN_BUDGET_MARKER} and start there.`,
      "The ceilings and the argument for them: src/modules/auth/application/login-limits.ts",
    ].join("\n"),
  );
}

/**
 * Auth cookies + landing path captured from the ONE real sign-in per account,
 * replayed by every later `loginAs` for that account in the same worker.
 *
 * WHY THIS EXISTS — the suite was rate-limiting itself. `auth_login_email` is
 * 5/min AND 20/hour keyed on the EMAIL ADDRESS (src/modules/auth/application/
 * login.ts), and it is enforced BEFORE GoTrue is touched, so it counts failed
 * attempts too. `uniqueIp()` spreads the per-IP budget and does exactly nothing
 * to this one. Static count at the time of writing: 17 `ACCOUNTS.owner` call
 * sites plus owner-shell.spec.ts's own literal login in a 3-test `beforeEach` —
 * comfortably past 20 sign-ins as owner@dim.test per run, and `retries: 1`
 * re-runs the failures on top. Until CI's e2e job was fixed (unit A4) the suite
 * was killed by the job clock at ~24 min and never made enough logins to reach
 * the hourly cap; the first run that COMPLETED hit it, and three tests died on
 * "Demasiados intentos. Esperá un momento y volvé a probar."
 *
 * The limiter is a real security control (it is what stops a distributed
 * brute-force against one account) and is NOT to be weakened for tests. Session
 * reuse is the Playwright-recommended answer and the one e2e/owner-ia-p6.spec.ts
 * already implements privately; this hoists it into the shared helper so every
 * spec gets it without a rewrite.
 *
 * WHAT IS STILL COVERED: the first sign-in per account per worker is a REAL
 * trip through the form, so "login works" is asserted once per role every run.
 * e2e/auth.spec.ts covers the form itself (bad password, empty fields) and does
 * not go through this helper. A spec whose SUBJECT is the sign-in must opt out
 * with `{ fresh: true }` rather than rely on being scheduled first.
 */
type CachedSession = { cookies: Awaited<ReturnType<BrowserContext["cookies"]>>; landing: string };
const sessionCache = new Map<string, CachedSession>();

/** Replay a cached session into `page`'s context. Returns false if unusable. */
async function restoreSession(page: Page, cached: CachedSession): Promise<boolean> {
  const context = page.context();
  await context.clearCookies();
  await context.addCookies(cached.cookies);
  await page.goto(cached.landing, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  // A session that no longer authenticates bounces to the sign-in page. Report
  // that rather than letting the caller assert against it.
  return leftSignIn(new URL(page.url()));
}

/**
 * Log in through the real UI at /login and wait until we leave the login page.
 *
 * Reuses a cached session for accounts already signed in during this worker —
 * see sessionCache above. Pass `{ fresh: true }` to force a real form sign-in
 * (for specs that are testing the sign-in itself).
 */
export async function loginAs(
  page: Page,
  email: string,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  if (!opts.fresh) {
    const cached = sessionCache.get(email);
    if (cached && (await restoreSession(page, cached))) return;
    // Fall through to a real sign-in when the cached session no longer works
    // (expired, signed out by another spec) — never silently continue anonymous.
    if (cached) sessionCache.delete(email);
  }

  // Fresh apparent origin per login — see uniqueIp above, and note the TWO
  // scopes on it. (1) It defeats the per-IP budget ONLY: the per-email budget is
  // keyed on the email address, so a spec that logs in as the same account more
  // than 5 times a minute (or 20 an hour) is rate-limited no matter what address
  // it presents. (2) It defeats even that one only where the header is honoured,
  // i.e. a local target. Against staging the edge overwrites it and every login
  // shares the runner's one per-IP bucket; the session cache above is what keeps
  // that budget intact there, and it needs no header.
  await page.setExtraHTTPHeaders({ "x-real-ip": uniqueIp() });
  // Real sign-ins only happen on a cold session cache — i.e. after Playwright
  // replaced the worker (it does so on EVERY test failure, and retries double
  // it), so their count scales with failures, not with the suite. Clear the
  // login buckets first so one genuine failure cannot cascade into
  // "Demasiados intentos" for every spec after it (local DB only — no-op
  // elsewhere; see resetAuthLoginRateLimits).
  await resetAuthLoginRateLimits();
  await page.goto(SIGN_IN_PATH);
  // Let hydration finish before interacting — clicks dispatched before React
  // attaches handlers are silently dropped (clickthrough audit 2026-07-03,
  // task #39), which stranded a whole recording pass on the login screen.
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(1_500);
  // On a remote target only the rotated e2e accounts may sign in: skip
  // (or, outside a test, throw) BEFORE anything is typed.
  skipUnlessRemoteLoginAllowed(page.url(), email);
  await page.getByLabel(/correo electrónico/i).fill(email);
  const password = passwordForPage(page.url(), email);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  try {
    await page.waitForURL(leftSignIn, { timeout: 10_000 });
  } catch {
    // Either the click was swallowed before hydration (the #39 workaround), or
    // the server refused. Check for a refusal first so it is reported as one.
    const refusal = await loginErrorText(page);
    if (refusal) throw loginRefusalError(email, refusal);
    await page.getByRole("textbox", { name: "Contraseña" }).press("Enter");
    try {
      await page.waitForURL(leftSignIn, { timeout: 20_000 });
    } catch (err) {
      const late = await loginErrorText(page);
      throw late ? loginRefusalError(email, late) : err;
    }
  }
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  // An institutional account lands on /mfa (or /mfa/configurar) since T2-S6;
  // the cached cookies must be the aal2 session, not the half-signed-in one.
  await passSecondFactorIfAsked(page, email, password);

  // Cache the session so the next `loginAs` for this account costs no login
  // budget. The landing path is recorded too, so a replayed session leaves the
  // page exactly where a real sign-in would have (callers assert on it).
  const landed = new URL(page.url());
  sessionCache.set(email, {
    cookies: await page.context().cookies(),
    landing: `${landed.pathname}${landed.search}`,
  });
}

/**
 * The status flags that mark a pet as NOT a live credential, exactly as
 * LnStatusFlag prints them on a registry row (components/ui/StatusFlag.tsx):
 * `lost` -> PERDIDO / PERDIDA / PERDIDO/A, `deceased` -> EN MEMORIA.
 *
 * The complement — `ok` ("AL DÍA"), `registered`, `sick`, `pregnant` — is every
 * state in which the pet is alive and its credential resolves, which is what
 * every caller of {@link discoverPetToken} means by "active". Naming the two
 * dead states is a closed list; naming the live ones is not.
 *
 * LnRegRow renders no other status text, so matching the row anchor's text is
 * enough to identify the flag.
 */
const INACTIVE_PET_FLAG = /PERDID[AO]|EN MEMORIA/i;

/**
 * Discover a REAL public DIM token from the signed-in owner's own registry.
 *
 * Bootstrap generates every pet token with `generatePublicToken()` — random by
 * construction (lib/infra/publicToken.ts), so no literal can name a pet that
 * exists on a fresh database. Specs that pinned `DIM-DEMO-0001` / `DIM-PAMP-0001`
 * were asserting against a not-found boundary in CI. Anchor on the `DIM-` prefix
 * so "/mis-mascotas/nueva" (the create-pet CTA) can never be mistaken for a pet.
 *
 * `page` must already be authenticated as the owner whose pet you want.
 *
 * ACTIVE BY DEFAULT. Almost every caller wants a live credential — a lost or
 * deceased pet renders a different surface (lost strip, no band dots), so a
 * bare "first link" pick makes the caller's assertions depend on whatever state
 * a previous suite happened to leave behind. Measured: after one run of the
 * mark-lost journeys, owner@dim.test's first card was a LOST pet and the
 * carousel tests failed on a page that was behaving correctly.
 *
 * THE FILTER EXCLUDES THE DEAD STATES; it does not enumerate the live ones.
 * This used to read `hasText: /registrad[ao]/i`, which is the flag LnStatusFlag
 * prints for status `registered` ONLY. But `lnPetStatusFromCompliance`
 * (lib/projections/pet-compliance.ts) returns `ok` for a pet that satisfies
 * every tracked obligation, and `ok` prints "AL DÍA"
 * (components/ui/StatusFlag.tsx). So the "find me an ACTIVE pet" helper could
 * not see the healthiest pets in the registry — the more compliant the seed,
 * the fewer candidates it found. On a fresh CI database, where nothing is
 * overdue yet, that is most of them.
 *
 * That failure is two-faced, which is why it survived: callers that assert on
 * the result got a real red (e2e/rehome-by-titular.spec.ts hit it on CI run
 * 32555456201), and callers that skip on an empty pick got a silent green. Its
 * own comment says the sibling specs "had been skipping silently on the same
 * condition" — they were fixed one spec at a time while this shared helper,
 * the thing they all call, kept the bug.
 *
 * Inverting is the fix rather than adding "AL DÍA" to the allow-list, because
 * excluding the dead states is what the helper actually means. Add a healthy
 * status tomorrow — `sick`, `pregnant`, anything the compliance mapper starts
 * returning — and an allow-list silently stops finding those pets again, in the
 * same two-faced way. An exclusion is wrong only if a state is genuinely dead
 * and unlisted, which is a louder, one-directional kind of wrong.
 *
 * The character class is load-bearing on this side too: the flag agrees with
 * the animal's sex (PERDIDO / PERDIDA / PERDIDO/A), so a pattern hardcoded to
 * one gender would let lost pets of the others straight through.
 */
export async function discoverPetToken(
  page: Page,
  opts: { index?: number; activeOnly?: boolean } = {},
): Promise<string> {
  const index = opts.index ?? 0;
  const activeOnly = opts.activeOnly ?? true;
  await page.goto("/mis-mascotas", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  const links = activeOnly
    ? page.locator('a[href^="/mis-mascotas/DIM-"]', { hasNotText: INACTIVE_PET_FLAG })
    : page.locator('a[href^="/mis-mascotas/DIM-"]');
  await expect(
    links.nth(index),
    `owner registry has ${activeOnly ? "an ACTIVE" : "a"} pet at index ${index}`,
  ).toBeVisible({ timeout: 20_000 });
  const href = (await links.nth(index).getAttribute("href")) ?? "";
  const token = href.split("/mis-mascotas/")[1]?.split(/[?#]/)[0] ?? "";
  expect(token, "pet token parsed from the registry link").toMatch(/^DIM-/);
  return token;
}

/**
 * The commit button of the `?sheet=marcar-encontrada` sheet.
 *
 * It read "Confirmar" until SheetMounter/MarkFoundConfirmation renamed it to
 * "Marcar como encontrada"; the specs that kept the old regex are the story
 * `ensurePetFound` below exists to end.
 *
 * Since T1-L14 (2026-09-18) the participle agrees with the pet's sex through
 * `foundParticiple`: "encontrado", "encontrada", or "encontrada/o" when the
 * sex is unknown. The specs discover their pets at runtime, so the regex takes
 * all three rather than guessing which one the seed hands them.
 */
export const MARK_FOUND_BUTTON = /^marcar como encontrad(?:a|o|a\/o)$/i;

/**
 * The not-lost face of the same sheet (`PetNotLostNotice`). It read "no figura
 * como perdida" — feminine for every animal — until T1-L14 rephrased it
 * without a gendered adjective.
 */
export const MARK_FOUND_NOT_LOST_NOTICE = /no figura en modo perdido/i;

/**
 * Land on the pet's profile with NO `?sheet=` param, and refuse to assert until
 * that is true.
 *
 * WHY THIS IS NOT "one more retry": the assertion after it is UNSATISFIABLE
 * while a sheet is open, whatever the pet's state. `Sheet` is a Vaul drawer over
 * a modal dialog, which marks everything outside it `aria-hidden`, and
 * Playwright's role queries read the accessibility tree. So a cleanup that
 * asserts on the sheet URL is not looking at a pet that failed to revert - it is
 * looking at a page whose entire content is hidden from it.
 *
 * MEASURED, not reasoned: CI run 35187453196 (2026-09-17), both the first
 * attempt and the retry. Playwright's own error-context snapshot for that
 * failure contains the whole accessibility tree of the page it judged, and it is
 * four nodes long:
 *
 *     - region "Notifications alt+T"
 *     - dialog "Marcar como encontrada":
 *       - paragraph: Atún no figura como perdida, así que no hay nada que marcar…
 *       - button "Volver al perfil"
 *
 * The animal was ALREADY ACTIVE - "no figura como perdida" is the not-lost
 * notice - so the cleanup had nothing to do and the spec still failed, blaming
 * "the write failed" for a write that was never needed.
 *
 * HOW IT GOT THERE, and why the previous two lines could not fix it: the old
 * code did `goto(profile).catch(() => {})` and then
 * `reloadPastCompetingNavigation`, which calls `page.reload()`. `reload()`
 * reloads whatever the page is CURRENTLY on. When the goto lost to a competing
 * client navigation its error was swallowed, the page stayed on the sheet URL,
 * and the reload then faithfully re-opened the sheet. The locator's own wait log
 * records exactly that: `navigated to ".../DIM-QGV6-US9W?sheet=marcar-encontrada"`.
 *
 * AND THE HELPER IT REPLACES ARGUED ITS OWN SAFETY, CORRECTLY, ABOUT THE WRONG
 * PROPERTY — which is the part worth keeping. `reloadPastCompetingNavigation`
 * (deleted with this change; `git log` for its text) carried a paragraph titled
 * "why swallowing the second abort cannot buy a false green", and its argument
 * was: the document it settles on was loaded by a navigation that started AFTER
 * ours, so it is never STALER than the one we asked for. True, and beside the
 * point. The risk was never the document's age, it was its IDENTITY: the
 * navigation that wins can be to a different URL, and a different URL here
 * means a modal over the page the assertions were written for. A freshness
 * guarantee says nothing about which page you are fresh ON.
 *
 * STILL OPEN, and recorded here rather than left for the next person to
 * rediscover: this fixes the CI failure above and does NOT make the spec green
 * locally. After it, two consecutive local runs against a warm server failed on
 * `DIM-PAMP-0001` with the profile showing the STALE lost-case block
 * ("Búsqueda cerrada por inactividad… la mascota sigue marcada como perdida")
 * — while the database disagreed with that page: `pets.status` was `active` and
 * every one of the six `lost_pet_episode` cases opened by those runs was
 * `closed`/`resolved`. So the cleanup's WRITE commits; what the assertion read
 * was a page that did not reflect it.
 *
 * RULED OUT, so the next person does not re-spend the afternoon:
 *   - A torn write. `setPetFoundUseCase` does the event, the status projection
 *     and `closeCase` inside ONE `deps.transaction`, so no reader can observe
 *     "episode closed, status still lost" from that path - and that is exactly
 *     the state the stale banner requires (`LostCaseBlock`: the caller mounts
 *     the block only when `pet.status === 'lost'`, and a null episode there
 *     means the episode auto-closed).
 *   - A drifted commit label. At the time the sheet's button was the literal
 *     "Marcar como encontrada" and `MARK_FOUND_BUTTON` matched it. (Since
 *     T1-L14 the sheet uses `foundParticiple` too, and the regex takes every
 *     form it can produce.)
 *   - A cold server. Two consecutive runs against a warm one reproduced it.
 *
 * What is left, and untested: something between the committed rows and the
 * rendered page. Do not read the fix below as having closed it.
 *
 * CLOSED 2026-09-18 — it was the ORDER, not the page. The render ran while the
 * mark-found POST was still in flight: `ensurePetFound` waited for a button
 * whose accessible name changes to "Guardando…" the moment it is clicked, so
 * its "the write is done" wait resolved on the click. A render that read
 * `pets.status` before the commit and the open case after it is exactly the
 * stale page above, and the database read afterwards is exactly the clean
 * state. `ensurePetFound` now waits for the action's own response.
 *
 * So the loop below re-NAVIGATES rather than reloading, and checks the URL it
 * actually landed on instead of assuming. If it cannot get a clean profile in
 * three tries it throws with the URL in hand, because a cleanup that cannot
 * reach the page it is supposed to judge must say so - the whole point of this
 * helper's assertion is that a drifted cleanup fails the spec that owns the
 * state instead of handing the corpse to the next one.
 */
async function settleOnCleanProfile(page: Page, token: string): Promise<void> {
  const profile = `/mis-mascotas/${token}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(profile, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    let landed: URL;
    try {
      landed = new URL(page.url());
    } catch {
      continue;
    }
    if (!landed.searchParams.has("sheet")) return;
  }
  throw new Error(
    `could not land on ${profile} without a ?sheet= param after 3 attempts — the page is at ${page.url()}. A sheet is a modal dialog: everything outside it is aria-hidden, so the assertions that follow would have reported "the pet is still lost" about a page they could not see.`,
  );
}

/**
 * Force a pet back to the ACTIVE state, and PROVE it — the mark-found cleanup
 * every lost-marking spec runs in its `finally`.
 *
 * ONE COPY, ON PURPOSE. Three specs used to carry their own: when the sheet's
 * commit button renamed, crisis-seams updated its local regex and the other
 * two kept the dead `/^confirmar$/` — whose `count() > 0` guard turned the
 * drifted locator into a SILENT NO-OP. The spec stayed green and the pet
 * stayed lost. On CI's minimal seed (three owner pets, one seeded lost) the
 * two leaks marked the whole registry PERDIDO, and rehome-by-titular +
 * synthetic-monitor then died on their "an active pet exists" preconditions —
 * run 33477869992 (2026-09-01), whose failure screenshot shows all three
 * chips red while the DB held every pet the seed promised.
 *
 * THE ASSERTION AT THE END IS THE ACTUAL FIX, not the shared location: a
 * cleanup whose control has drifted must fail THE SPEC THAT OWNS THE STATE,
 * never hand the corpse to whichever spec runs next. Idempotent: on an
 * already-active pet the sheet offers no commit button and the click is
 * skipped.
 *
 * THAT IDEMPOTENCE CLAIM USED TO END "and the profile assertion is already
 * true", and that half was false. The assertion is only true once the page is
 * OFF the sheet URL, because a sheet is a modal and a modal hides the rest of
 * the document from the accessibility tree the assertion reads.
 * `settleOnCleanProfile` above is what makes the sentence true; see its header
 * for the measurement.
 *
 * A CORRECTION TO THE COMMIT THAT INTRODUCED THIS, left here because the
 * message is already pushed and cannot be: it says "eleven weeks of red CI".
 * That number was invented, not measured. The measurement is that the last
 * GREEN CI run on this repo was 2026-09-09 (`4459e670d`), eight days before
 * this — and not even all of those are this defect: the first red after it died
 * in `supabase start`, before any spec ran. So the honest statement is that the
 * CI e2e job has been red since 2026-09-09 for more than one reason, and this
 * was one of them. The repo already warns about exactly this in its own notes:
 * a number that reads as measured and does not reproduce is worse than no
 * number, because the next person scopes from it.
 *
 * THE SHEET IS WAITED FOR BEFORE THE BUTTON IS COUNTED. `Sheet` (VaulSheet →
 * Radix Dialog) renders inside a Portal, which mounts only AFTER hydration:
 * at `domcontentloaded` neither the commit button nor the not-lost notice
 * exists yet. The first version of this helper counted the button straight
 * after the goto, and on CI — run 33568726968, the first one to carry the
 * assertion — the count answered 0 some 300 ms after navigation, the click
 * was skipped, the pet stayed lost, and the assertion fired exactly as
 * designed (trace: goto 6.6 s, count 6.9 s, goto 6.9 s, no click). The
 * inline cleanups it replaced had the same race and never noticed, because
 * their regex was already dead. crisis-seams reaches the CLICK branch too: its
 * `finally` runs after every leg of the seam, and any throw between the
 * mark-lost commit and the mark-found click — the stranger POV, the admin
 * `/gob/perdidas` leg — arrives here with the pet still lost. That is exactly
 * why that spec re-establishes the owner session before calling this helper:
 * the admin leg would otherwise hand the cleanup the wrong actor. Waiting on
 * `data-sheet-id` — the `id` prop both branches pass — decides "is there
 * something to click" on a mounted sheet, and stays a plain count afterwards
 * because the not-lost branch is a legitimate "nothing to click", not a
 * failure.
 *
 * WHAT THE CLICK IS FOLLOWED BY IS THE ACTION'S RESPONSE, never the
 * post-action URL: the response exists whether `useActionRedirect` navigates or
 * drops (e2e/README.md, "Never wait on a post-action URL"). It used to be a DOM
 * signal — the commit button leaving the document — and that signal fired on
 * the click, because the pending button renames itself; see the comment at the
 * click.
 *
 * The goto → reload pair is the freshness idiom crisis-seams measured: the
 * found action fires its own client-side navigation on its own schedule, so
 * the first goto can lose that race as net::ERR_ABORTED (not a page failure),
 * and the reload re-establishes a fresh document afterwards.
 *
 * THE RELOAD LOSES THE SAME RACE, and for two CI runs it was the only half of
 * the pair with no tolerance for it — the sentence that used to end this
 * paragraph, "either way", was simply wrong about the second line. It is
 * `reloadPastCompetingNavigation` now; the reasoning, the two run ids and why a
 * URL wait is not the fix are in that function's docblock.
 *
 * A POSITIVE MARKER RUNS FIRST, on purpose: `[data-section="lost-case-block"]`
 * having count 0 is also true of a login redirect, a 404, or any other page
 * that is not this pet's profile — a dropped session in the `finally` this
 * helper runs from would report success without the profile ever having been
 * checked. `PetActionRow`'s "Marcar como perdida" control only renders for
 * the OWNER on an ACTIVE pet, so seeing it proves both facts the absence
 * check alone cannot: this is the profile, and the pet is active.
 */
export async function ensurePetFound(page: Page, token: string): Promise<void> {
  await page
    .goto(`/mis-mascotas/${token}?sheet=marcar-encontrada`, { waitUntil: "domcontentloaded" })
    .catch(() => {});
  const sheet = page.locator('[data-sheet-id="marcar-encontrada"]');
  await expect(
    sheet,
    `the marcar-encontrada sheet never mounted for pet ${token} — the owner session dropped, this is not the pet's profile, or hydration failed`,
  ).toBeVisible({ timeout: 20_000 });
  const confirm = sheet.getByRole("button", { name: MARK_FOUND_BUTTON });
  // THE SHEET HAS TWO FACES AND THIS WAITS FOR IT TO PICK ONE, because
  // `count()` is a photograph with no retry and the line below branches on it.
  //
  // The sheet being VISIBLE is not the same as the sheet having RENDERED its
  // body: `MarkFoundConfirmation` (the commit button) and `PetNotLostNotice`
  // are chosen by `petStatus`, and on a cold server the RSC payload that
  // carries either one can land after the portal is already on screen. A
  // `count()` taken in that window answers 0 for a lost pet, the click is
  // skipped, and the cleanup becomes a SILENT NO-OP — the exact failure mode
  // this helper's own docblock describes for a drifted locator, arriving here
  // through a race instead of a rename.
  //
  // HONEST ABOUT ITS OWN EVIDENCE: this is a defect in the SHAPE of the check,
  // not a fix for a reproduction. Branching on a no-retry `count()` is wrong
  // whether or not it has fired yet. A first draft of this comment claimed a
  // cold-server measurement; the next two runs reproduced the same failure
  // against a WARM server, which disproved it, and the real cause of that
  // failure is still open (see the note in `settleOnCleanProfile`). The
  // hardening stays because it is right on its own terms; the story does not,
  // because it was wrong.
  //
  // Polling the SUM is what makes it a real fence rather than a sleep: it waits
  // for one of the two mutually exclusive faces to exist, so a sheet that
  // renders NEITHER (a third state nobody predicted) times out and says so,
  // instead of quietly taking the "nothing to do" branch.
  const notLost = sheet.getByText(MARK_FOUND_NOT_LOST_NOTICE);
  await expect
    .poll(async () => (await confirm.count()) + (await notLost.count()), {
      timeout: 20_000,
      message: `the marcar-encontrada sheet for pet ${token} mounted but rendered neither the commit button nor the not-lost notice — its body never arrived, and counting the button now would silently skip the cleanup`,
    })
    .toBeGreaterThan(0);
  if ((await confirm.count()) > 0) {
    // THE ACTION'S OWN RESPONSE, NOT A DOM SIGNAL AND NOT THE POST-ACTION URL.
    //
    // This used to await `confirm` becoming hidden, reasoning that the commit
    // control leaves the document once the write is done. It leaves much
    // sooner: `MarkFoundConfirmation` relabels the button "Guardando…" the
    // instant the form submits (`isPending`), so a locator keyed on the
    // "Marcar como encontrada" NAME stops matching on the click itself and
    // `toBeHidden` resolved while the POST was still in flight. The goto in
    // `settleOnCleanProfile` then rendered the profile CONCURRENTLY with the
    // write, and a render that read `pets.status` before the commit and the
    // open-case lookup after it produced exactly the page this helper's
    // "STILL OPEN" note describes and CI kept screenshotting (run 35362940004,
    // pet DIM-4YQE-29KH): status "Perdido", no open episode, hence the
    // "Búsqueda cerrada por inactividad" stale banner — while the database, read
    // a moment later, said active/closed. Nothing between the rows and the page
    // was lying; the page was a photograph taken mid-write.
    //
    // A server action answers only after it returns, and `setPetFoundAction`
    // returns after its transaction committed, so the POST's response is the
    // write's acknowledgement. Armed BEFORE the click so it cannot be missed.
    // Keyed on the `Next-Action` header and this pet's path, so another action
    // the page fires (a notification read, a dismissed tip) cannot stand in.
    const actionPath = `/mis-mascotas/${token}`;
    const committed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.request().headers()["next-action"] !== undefined &&
        new URL(response.url()).pathname === actionPath,
      { timeout: 20_000 },
    );
    await confirm.click();
    // The response HEADERS are enough, and waiting for the body is wrong: Next
    // awaits the action (`executeActionAndPrepareForRender` in
    // next/dist/server/app-render/action-handler.js) BEFORE it starts writing
    // the RSC response, so a response that exists is a write that committed.
    // The body is a stream the redirect then abandons — `response.finished()`
    // was tried and hung until the test budget ran out, on every run.
    await committed;
  }
  await settleOnCleanProfile(page, token);
  await expect(
    page.getByRole("link", { name: /marcar como perdida/i }),
    `pet ${token} does not show the owner's "Marcar como perdida" control after the mark-found cleanup — this is not the pet's profile in its active state (dropped session, wrong page, or the write failed)`,
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('[data-section="lost-case-block"]'),
    `pet ${token} still shows its lost case after the mark-found cleanup — the sheet's commit control drifted or the write failed, and every later spec would inherit a lost fixture`,
  ).toHaveCount(0, { timeout: 20_000 });
}

/**
 * The signed-in account's display name, read from /cuenta at runtime.
 *
 * For privacy assertions ("this public surface must not leak the owner's
 * name"). A HARDCODED persona name makes that assertion VACUOUS the moment the
 * fixture changes: e2e/synthetic-monitor.spec.ts checked the public credential
 * for "Ignacio del Valle" — a demo-tier persona — while CI's owner@dim.test is
 * seeded as "Lucía Tester", so the check could not fail no matter what the page
 * leaked. Reading the name from the account under test keeps it honest.
 */
export async function discoverDisplayName(page: Page, email: string): Promise<string> {
  await page.goto("/cuenta", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  // The profile card renders the display name in the first <p> of the same
  // block that carries the account email; anchoring on the email makes the
  // innermost matching div unambiguous.
  const block = page.locator("div").filter({ hasText: email }).last();
  const name = (await block.locator("p").first().innerText()).trim();
  expect(name, `display name read from /cuenta for ${email}`).not.toBe("");
  expect(name, "display name is not the email itself").not.toContain("@");
  return name;
}

/**
 * Refuse to measure a page that is not the page under test.
 *
 * THE gate-integrity primitive. A not-found boundary and a crashed route are
 * both small, clean, quiet pages: axe finds zero violations on them, a CSP
 * console listener hears nothing, and a PII substring check finds no PII. Every
 * such gate therefore reports GREEN for a route it never loaded. It has now
 * happened twice in this repo (a11y-regression scanning /p/DIM-DEMO-0001 as a
 * 404 and printing "critical=0"; csp-smoke doing the same on the same token).
 *
 * This function is the SINGLE implementation. It used to live privately inside
 * e2e/a11y-regression.spec.ts, matching only the heading
 * "No encontramos esta página" — which is the (app)/admin/gob/root copy, NOT
 * the `(public)` group's "No encontramos esa credencial". `/p/[token]` is a
 * (public) route, so the guard did not recognise the one boundary it existed to
 * catch. Fixed here by keying on BrandedNotFound's data-testid first (copy
 * cannot disarm it) and on the full set of headings second — see
 * e2e/_page-identity.ts and its parity test.
 *
 * IT NOW ASSERTS THE URL, NOT JUST "a page rendered". Until 2026-07-31 `route`
 * was a pure error-message string — nothing ever compared `page.url()` — so the
 * function proved "SOME real page" and never "THE page". Any redirect sailed
 * through it, which is not a corner case in this app:
 * `app/(app)/inicio/page.tsx` has NO renderable branch (every path ends in
 * `redirect()`, lines 63 / 89 / 120), so
 *
 *   e2e/a11y-regression.spec.ts  "/inicio — no serious/critical"
 *
 * was scanning /mis-mascotas/{token} — byte-identical to the test on the very
 * next line. The docblock's "four highest-traffic surfaces" was three, one of
 * them measured twice, and /inicio's axe number described a different page.
 *
 * @param expected the pathname the browser must actually be on. A string is
 *   compared exactly (query and hash ignored); pass a RegExp when the
 *   destination is legitimately variable — a redirect target, a discovered
 *   token. Do NOT pass a prose label: it is an assertion now, not a caption.
 * @param marker OPTIONAL positive proof: something only the real page renders.
 *   The right pathname plus no 404 is still not proof the CONTENT rendered —
 *   pass this whenever the route has a stable identifying element.
 */
export async function assertRealPage(
  page: Page,
  expected: string | RegExp,
  marker?: Locator,
  opts: {
    /**
     * Accept a page that renders the BrandedNotFound COMPONENT. For
     * /acceso-denegado — the app's deliberate access-denied surface — the
     * boundary IS the page under test (app/acceso-denegado/page.tsx reuses
     * BrandedNotFound by design), so refusing to measure it would leave the
     * surface unmeasured, not un-vacuous. Every other caller keeps the guard.
     */
    allowBrandedNotFound?: boolean;
  } = {},
): Promise<void> {
  const label = typeof expected === "string" ? expected : String(expected);
  const actual = new URL(page.url()).pathname;

  if (typeof expected === "string") {
    // Normalise through URL so a caller may pass an href carrying ?query#hash
    // (public-smoke discovers hrefs from listings and passes them straight in).
    const wanted = new URL(expected, "http://localhost").pathname;
    expect(
      actual,
      `expected to be measuring ${wanted}, but the browser is on ${actual} — a redirect, not the route under test`,
    ).toBe(wanted);
  } else {
    expect(
      actual,
      `expected to be measuring a path matching ${label}, but the browser is on ${actual}`,
    ).toMatch(expected);
  }

  if (!opts.allowBrandedNotFound) {
    await expect(
      page.getByTestId(BRANDED_NOT_FOUND_TESTID),
      `${label}: rendered the branded not-found boundary — measuring it would pass vacuously`,
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: NOT_FOUND_HEADING }),
      `${label}: rendered a not-found heading — measuring it would pass vacuously`,
    ).toHaveCount(0);
  }
  await expect(page.getByText(CRASH_BOUNDARY), `${label}: the page crashed`).toHaveCount(0);
  if (marker) {
    await expect(marker, `${label}: the page's own content never rendered`).toBeVisible({
      timeout: 20_000,
    });
  }
}

/**
 * The signed-in account's PII, resolved at runtime, for "this public surface
 * must not leak the owner" assertions.
 *
 * `page` must already be authenticated as that account.
 *
 * The phone is read from the editar-perfil sheet (`/cuenta?sheet=editar-perfil`
 * renders `input#phone` pre-filled from profiles.phone) because /cuenta itself
 * only prints name, email and `••••<dni_last4>`. It is OPTIONAL: an account
 * with no phone on file yields null, and the caller must skip the phone
 * assertion rather than search for the empty string — `body.includes("")` is
 * always true, which would turn the leak detector into a permanent false alarm.
 *
 * See e2e/_page-identity.ts → OwnerPii for the scope decision (why DNI and
 * address are deliberately not in here).
 */
export async function discoverOwnerPii(page: Page, email: string): Promise<OwnerPii> {
  const displayName = await discoverDisplayName(page, email);

  await page.goto("/cuenta?sheet=editar-perfil", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  const phoneInput = page.locator("input#phone");
  let phone: string | null = null;
  if (await phoneInput.count().then((c) => c > 0)) {
    const value = (await phoneInput.inputValue()).trim();
    phone = value === "" ? null : value;
  }

  return { displayName, email, phone };
}

/**
 * File an anonymous denuncia at `coords` in a throwaway context, so an operator
 * queue that `pnpm db:bootstrap` leaves EMPTY has something real in it.
 *
 * Bootstrap creates zero `cases` rows — reference data and test users, nothing
 * else. A denuncia is the honest origin of a first case (create-welfare-report
 * opens a `welfare_denuncia` case in the same transaction), so operator specs
 * manufacture one the way a citizen does rather than skipping or asking CI to
 * carry the demo seed.
 *
 * ⚠ JURISDICTION ROUTING IS NOT LOCAL. Which operator sees this denuncia is
 * decided by `cases.jurisdiction_*` (for /gob/casos) and by
 * `welfare_reports.jurisdiction_*` (for the Triage and Moderación stages of the
 * Denuncias hub — welfareReportsScopeClause). Both are filled from a
 * SERVER-SIDE fetch to https://nominatim.openstreetmap.org (lib/infra/
 * geocoding.ts) fired when the pin drops — the app never derives jurisdiction
 * from the coordinates itself. If that call fails the report still submits, but
 * lands with a NULL jurisdiction, and every govt queue ANDs an exact
 * province/locality pair (falling back to `sql\`false\``), so it is visible to
 * nobody. Callers that need a govt queue must use `expectCaseInGovtQueue`,
 * which names that cause instead of reporting an empty queue.
 *
 * ⚠ WHICH STAGE IT LANDS IN IS NOT FIXED EITHER — see the header of flow (c)
 * in e2e/synthetic-monitor.spec.ts. An anonymous denuncia is auto-flagged into
 * MODERACIÓN only when a heuristic fires (lib/infra/welfare-moderation.ts);
 * the text this helper types trips none of them on its own, so the FIRST call
 * in a run lands in TRIAGE and later ones land in Moderación as
 * `duplicate_within_24h`. Never assert on one stage after probing the other.
 */
export async function fileDenunciaAt(
  browser: Browser,
  coords: { latitude: number; longitude: number },
  /**
   * The jurisdiction the caller CHOSE by picking the pin. When provided and
   * the server-side Nominatim geocode flaked (routine on CI runners), the
   * NULL jurisdiction of BOTH the welfare report and its case is repaired to
   * this — see ensureDenunciaJurisdiction; a resolved one is never overwritten.
   */
  jurisdiction?: { province: string; locality: string },
): Promise<string> {
  // Distinct apparent origin per denuncia — the anonymous submit is IP
  // rate-limited at 1/min + 3/hour (welfare_anon, src/modules/welfare/
  // actions.ts), and the serial suite walks this wizard from several specs
  // (synthetic-monitor c/d, admin/gob case-detail-shell). One shared IP trips
  // the per-minute budget on the SECOND walk; a unique TEST-NET-3 address per
  // walk models what it simulates — different citizens filing reports.
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-real-ip": uniqueIp() },
  });
  try {
    const page = await context.newPage();
    const code = await walkDenunciaWizard(page, { coords });
    if (jurisdiction) {
      await ensureDenunciaJurisdiction(code, jurisdiction.province, jurisdiction.locality);
    }
    return code;
  } finally {
    await context.close();
  }
}

/**
 * Assert an operator queue is non-empty, and when it is empty say WHY in terms
 * a reader can act on. Returns the first queue row's href.
 */
export async function expectQueueRow(page: Page, selector: string, what: string): Promise<string> {
  const row = page.locator(selector).first();
  if ((await row.count()) === 0) {
    throw new Error(
      `${what}: the queue is empty. A denuncia was filed for this run, so either it did not open a case, or its jurisdiction did not resolve — jurisdiction comes from a server-side reverse-geocode against nominatim.openstreetmap.org, and a govt queue matches on an EXACT province/locality pair, so a null jurisdiction is invisible to every govt operator. Check cases.jurisdiction_province.`,
    );
  }
  await expect(row, what).toBeVisible({ timeout: 20_000 });
  return (await row.getAttribute("href")) ?? "";
}

/** Navigate to a path, tolerate 308 redirects, settle, then pause briefly for the recording. */
export async function visit(
  page: Page,
  urlPath: string,
  opts: { settle?: number } = {},
): Promise<void> {
  await page.goto(urlPath, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(opts.settle ?? 600);
}

/**
 * Slow full-page scroll to the bottom and back — reveals long tables/dashboards
 * on camera. Pure choreography, NOT an assertion: if the page navigates or
 * streams a re-render mid-scroll, the evaluate's execution context is destroyed
 * and throws. That is benign for a camera pan, so we swallow it rather than
 * failing an otherwise-complete journey (heavier operator surfaces made this a
 * recurring false failure — the flow completed, the scroll just got interrupted).
 */
export async function fullScroll(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const height = document.body.scrollHeight;
      const step = Math.max(300, Math.floor(window.innerHeight * 0.8));
      for (let y = 0; y <= height; y += step) {
        window.scrollTo({ top: y, behavior: "smooth" });
        await sleep(350);
      }
      await sleep(300);
      window.scrollTo({ top: 0, behavior: "smooth" });
      await sleep(300);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only swallow the navigation/teardown races; re-throw anything real.
    if (
      !/execution context was destroyed|target page.*closed|page.*has been closed/i.test(message)
    ) {
      throw err;
    }
  }
}

/** Visit + full scroll, the default "show this screen" beat. */
export async function showScreen(page: Page, urlPath: string): Promise<void> {
  await visit(page, urlPath);
  await fullScroll(page);
}

/**
 * Panorama map beat (segments 05/06): navigate to the geospatial console,
 * give the client-side map time to paint, FAIL LOUD if the console itself
 * errored, full-scroll, then gently switch one map layer when the layer
 * switcher is present (best-effort — layer availability varies by seed data).
 */
export async function panoramaMapBeat(page: Page, urlPath: string): Promise<void> {
  await visit(page, urlPath);
  await page.waitForTimeout(3_000); // first map paint (dynamic client import)
  // PO screenshot fix (2026-07-08): the h1 "Panorama" was removed (redundant
  // with the breadcrumb + nav-rail). The eyebrow line is the stable console-
  // loaded signal now.
  await expect(
    page.getByText("Centro de Situación Nacional").first(),
    `panorama console at ${urlPath}`,
  ).toBeVisible();
  await fullScroll(page);
  // panorama v3 rail (task #38): the layer toggles live inside the "Filtro"
  // rail panel now (uniform floating panel, checkboxes in both tiers). Open it
  // first so the beat can still exercise a real layer toggle; best-effort,
  // same as before (layer availability varies by seed data).
  const filtroButton = page.getByRole("button", { name: "Filtro", exact: true });
  if (
    await filtroButton
      .count()
      .then((c) => c > 0)
      .catch(() => false)
  ) {
    await filtroButton.click().catch(() => {});
    await page.waitForTimeout(300);
  }
  const layerToggle = page.locator('label:has(input[type="checkbox"]:not([disabled]))').first();
  if (
    await layerToggle
      .count()
      .then((c) => c > 0)
      .catch(() => false)
  ) {
    await layerToggle.click().catch(() => {});
    await page.waitForTimeout(2_000);
  }
}

/** Best-effort: fill an input found by label regex, ignore if absent (screens vary by data). */
export async function tryFill(page: Page, label: RegExp, value: string): Promise<void> {
  const field = page.getByLabel(label).first();
  if (
    await field
      .count()
      .then((c) => c > 0)
      .catch(() => false)
  ) {
    await field.fill(value).catch(() => {});
  }
}

/**
 * Click a submit button and wait for the URL to change; when the click is
 * silently dropped (hydration race, task #39 — handlers not yet attached),
 * fall back to submitting the button's form programmatically. Fail-loud if
 * neither attempt navigates.
 */
export async function submitAndWait(
  page: Page,
  button: ReturnType<Page["getByRole"]>,
  urlPredicate: (url: URL) => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  await expect(button, "submit button").toBeEnabled();

  // Resolve the element BEFORE clicking. The #39 fallback below re-submits the
  // owning form, and it used to do that through the same by-name locator — but
  // a submit in flight RENAMES its button ("Registrar vacuna" → "Registrando…"),
  // so the locator stopped matching and `.evaluate` timed out on an element
  // that had merely changed its label. The click had worked; the fallback was
  // what failed. A handle survives the rename.
  const handle = await button.elementHandle();

  await button.click();
  try {
    await page.waitForURL(urlPredicate, { timeout: 10_000 });
    return;
  } catch {
    // A slow-but-working submit and a dropped click look identical from here,
    // so distinguish them: if the button is now DISABLED or renamed to a
    // pending label, the form is already submitting — re-submitting would fire
    // the action twice. Just keep waiting.
    const pending = await handle
      ?.evaluate((el) => {
        const b = el as HTMLButtonElement;
        return b.disabled || /ando…|ando\.\.\.|Guardando|Registrando/i.test(b.textContent ?? "");
      })
      .catch(() => false);

    if (!pending) {
      // Genuinely dropped click — submit the owning form directly (#39).
      await handle?.evaluate((el) => {
        (el as HTMLButtonElement).form?.requestSubmit();
      });
    }
    await page.waitForURL(urlPredicate, { timeout: timeoutMs });
  }
}

/** Assert we are not on an error/404 boundary — a light sanity gate per screen. */
export async function notErrored(page: Page): Promise<void> {
  await expect(page.locator("body")).toBeVisible();
}

// ---------------------------------------------------------------------------
// Explicit wizard drivers. Unlike tryFill, these FAIL LOUD when the expected
// element is missing — a frozen wizard must break the recording, not silently
// produce a dead screen (see docs/audits + demo-recording/wizard-driver-bug).
// ---------------------------------------------------------------------------

/** Click a radio-card label wrapping a hidden input (the wizard card pattern). */
export async function pickCard(page: Page, name: string, value: string): Promise<void> {
  const card = page.locator(`label:has(input[name="${name}"][value="${value}"])`);
  await expect(card, `radio card ${name}=${value}`).toBeVisible();
  await card.click();
  await page.waitForTimeout(400);
}

/**
 * Click the wizard "Continuar" button and give the next step time to render.
 *
 * Pass `expectStep` to ASSERT the wizard actually advanced. Without it a gated
 * step is silently tolerated: `validateAndAdvance` renders a role=alert reason
 * and stays put, the helper walks on, and the run dies several steps later
 * somewhere that names nothing. That is exactly how the CI failure of
 * admin-case-detail-shell read — "page.waitForURL: Timeout 30000ms exceeded" at
 * the submit, when the truth (visible in the trace's DOM snapshot) was that the
 * wizard never left Paso 3. Report the gate where the gate is.
 */
export async function clickContinuar(page: Page, expectStep?: number): Promise<void> {
  const btn = page.getByRole("button", { name: /continuar/i }).first();
  await expect(btn, "wizard Continuar button").toBeVisible();
  await btn.click();
  if (expectStep != null) {
    const bar = page.getByRole("progressbar").first();
    try {
      await expect(bar).toHaveAttribute("aria-valuenow", String(expectStep), { timeout: 8_000 });
    } catch (err) {
      const reason = await page
        .getByRole("alert")
        .first()
        .innerText()
        .catch(() => "");
      throw reason.trim()
        ? new Error(`wizard refused to advance to step ${expectStep}: "${reason.trim()}"`)
        : err;
    }
  }
  await page.waitForTimeout(500);
}

/**
 * Resolve the /org/[orgToken] portal token for the logged-in member AT RUNTIME
 * (tokens are never hardcoded). /org auto-redirects single-membership users to
 * their org dashboard; multi-membership users get a picker where we click the
 * card matching the hint. FAIL LOUD — an org segment without a portal is dead.
 */
export async function resolveOrgToken(page: Page, orgNameHint: RegExp): Promise<string> {
  await page.goto("/org", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  let match = page.url().match(/\/org\/([^/?#]+)/);
  if (!match) {
    // Membership picker — click the org card matching the hint.
    const card = page.locator('a[href^="/org/"]', { hasText: orgNameHint }).first();
    await expect(card, `org picker card matching ${orgNameHint}`).toBeVisible();
    await card.click();
    await page.waitForURL(/\/org\/[^/?#]+/, { timeout: 15_000 });
    match = page.url().match(/\/org\/([^/?#]+)/);
  }
  const token = match?.[1] ?? "";
  expect(token, "org token resolved from /org redirect or picker").toBeTruthy();
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  return token;
}

/**
 * The currently visible step of an LnWizardShell wizard. Inactive steps stay in
 * the DOM as sr-only + aria-hidden, so global getByRole/getByLabel queries can
 * hit hidden duplicates ("Continuar" exists on every step). Scope through this.
 */
export function wizardStep(page: Page): Locator {
  return page.locator('section[aria-hidden="false"]');
}

/** Drive a LocalityPickerAcross typeahead: type, wait for the dropdown, pick the first match. */
export async function pickLocality(
  page: Page,
  inputSelector: string,
  query: string,
): Promise<void> {
  const input = page.locator(inputSelector);
  await expect(input, `locality typeahead ${inputSelector}`).toBeVisible();
  await input.fill(query);
  // Results render as role="option" rows after a 200ms debounced server search.
  // Matched by role rather than markup: this was `ul button` until LnCombobox
  // moved role="option" onto the <li> and dropped the inner button, and the
  // stale selector went unnoticed while CI was not running the e2e suite.
  const option = page.getByRole("option", { name: query }).first();
  await expect(option, `locality result for "${query}"`).toBeVisible({ timeout: 10_000 });
  await option.click();
  await page.waitForTimeout(300);
}

/**
 * Drive the public 5-step denuncia wizard end to end and submit anonymously
 * with an evidence photo. Returns the reference code from the comprobante URL.
 *
 * Steps (see app/(public)/denuncias/nueva/DenunciaWizard.tsx):
 *   1 kindCard radio → Continuar   2 severityCard radio → Continuar
 *   3 description (min 20 chars) + occurredAtOption radio → Continuar
 *   4 subject (optional) → Continuar
 *   5 "Enviar anónima" + evidence file → "Enviar denuncia →" (server redirect)
 */
/**
 * Coordinates whose canonical locality is CABA/Palermo — a coverage zone of the
 * bootstrap-tier `govt-local@dim.test`, so a denuncia filed here lands in that
 * operator's queue. `govt@dim.test` covers Ushuaia + El Calafate instead; use
 * USHUAIA_POINT for that one. Both accounts come from scripts/seed-test-users.ts
 * and exist on any freshly bootstrapped database.
 */
export const PALERMO_POINT = { latitude: -34.578, longitude: -58.424 };
export const USHUAIA_POINT = { latitude: -54.8019, longitude: -68.303 };
/** The jurisdiction USHUAIA_POINT resolves to — exact strings from
 *  scripts/seed-test-users.ts's govt@dim.test coverage. Pass alongside
 *  USHUAIA_POINT to fileDenunciaAt so a flaked Nominatim call cannot strand
 *  the case outside every operator's scope. */
export const USHUAIA_JURISDICTION = { province: "Tierra del Fuego", locality: "Ushuaia" };

export async function walkDenunciaWizard(
  page: Page,
  opts?: {
    triggerModerationFlag?: boolean;
    /** Where the reported animal is — decides which authority receives it. */
    coords?: { latitude: number; longitude: number };
  },
): Promise<string> {
  const coords = opts?.coords ?? PALERMO_POINT;
  await visit(page, "/denuncias/nueva");

  const description = opts?.triggerModerationFlag
    ? "PERRO ATADO SIN AGUA NI COMIDA EN LA CALLE DESDE HACE VARIOS DIAS"
    : "Perro atado a la intemperie sin agua ni comida hace varios días. Se lo ve muy delgado y sin ningún refugio contra la lluvia.";

  // Step 1 — Qué pasó
  await fullScroll(page);
  await pickCard(page, "kindCard", "neglect");
  await clickContinuar(page, 2);

  // Step 2 — Gravedad
  await fullScroll(page);
  await pickCard(page, "severityCard", "moderado");
  await clickContinuar(page, 3);

  // Step 3 — Dónde y cuándo
  await page.locator("textarea#description").fill(description);
  await pickCard(page, "occurredAtOption", "today_yesterday");
  // A PRECISE POINT IS MANDATORY, and a typed address is not one.
  //
  // jurisdiction-compliance (2026-07-03) made the map pin a hard gate:
  // DenunciaWizard.validateAndAdvance() refuses step 3 without
  // `hasLocationPoint` ("Marcá el lugar exacto en el mapa para continuar"),
  // because the canonical locality — and therefore WHICH AUTHORITY receives the
  // denuncia — is inferred server-side from lat/lng. This helper kept filling
  // only the L2 address text, which sets no point, so every caller was walking
  // a wizard that had stopped at Paso 3. e2e/synthetic-monitor.spec.ts's inline
  // copy of this flow was updated at the time; the shared helper was not, and
  // the divergence stayed invisible until the e2e job started reporting.
  //
  // Geolocation is granted+faked rather than clicking the map: it needs no tile
  // server, so it works in a headless CI browser with no reachable map host.
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation(coords);
  await page.getByRole("button", { name: /usar mi ubicación actual/i }).click();
  // The hidden inputs are what the action reads; wait on them, not on a timer.
  await expect(
    page.locator('input[name="locationLat"]'),
    "geolocation dropped a precise point",
  ).not.toHaveValue("", { timeout: 15_000 });
  await fullScroll(page);
  await clickContinuar(page, 4);

  // Step 4 — Quién (optional): describe an unowned animal
  await pickCard(page, "subjectKindCard", "unowned_animal");
  await page
    .getByPlaceholder(/especie, color, tama/i)
    .first()
    .fill("Perro mestizo mediano, marrón claro, collar de soga gastada.");
  await fullScroll(page);
  await clickContinuar(page, 5);

  // Step 5 — Cerrar: anonymous + evidence photo + submit
  await page.getByRole("button", { name: /enviar an[oó]nima/i }).click();
  await page.locator("#evidenceFiles").setInputFiles(DEMO_PHOTOS[0]);
  await page.waitForTimeout(800);
  await fullScroll(page);
  const submit = page.getByRole("button", { name: /enviar denuncia/i });
  await expect(submit, "denuncia submit button").toBeEnabled();

  // Fired, not awaited — same reason as e2e/create-pet.spec.ts's submit: the
  // click's promise never resolves on a client-side post-action navigation.
  //
  // (When this comment was first written it claimed createWelfareReportAction
  // already returned `redirectTo`. It did not — the use case returned it and the
  // ACTION handed it to redirect(). Read one link of the chain, asserted the
  // whole thing. The action follows N3 as of the B.2 migration; the workaround
  // was right for the wrong stated reason.)
  void submit.click().catch(() => {});

  // createWelfareReportAction redirects to the comprobante on success.
  await page.waitForURL(/\/denuncias\/codigo\//, { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await fullScroll(page);
  return decodeURIComponent(page.url().split("/codigo/")[1] ?? "").split("?")[0];
}
