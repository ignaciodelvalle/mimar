// _mfa — the institutional second factor inside the e2e suite (T2-S6).
//
// Since T2-S6 admin / govt / national reach no portal without a TOTP code:
// after the password the server sends them to `/mfa` (a factor exists) or
// `/mfa/configurar` (none yet). A suite login that stops there is NOT signed
// in, even though `leftSignIn` says so — the browser is no longer on the
// sign-in page.
//
// The rule: every login helper calls `passSecondFactorIfAsked` right after it
// leaves the sign-in page. For a personal account it changes nothing. For an
// institutional one it makes sure (once, over the API, through the account's
// own session) that a factor with a secret we know exists
// (scripts/lib/seed-mfa.ts), and answers the challenge on the real page with a
// code computed from that secret. The app has no test shortcut: the step is
// walked in the real UI.

import { type Page, test } from "@playwright/test";

import { remoteLoginRefusal } from "./_credentials";
import { SIGN_IN_PATH, leftSignIn } from "./_sign-in-route";

import { ensureSeedTotp, seedMfaEnvFromProcess } from "../scripts/lib/seed-mfa";
import { secondsLeftInStep, totp } from "../scripts/lib/totp";

const MFA_PREFIX = "/mfa";

/** Hosts where the suite owns the database and may enrol seed factors. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Is this one of the two second-factor screens? */
export function isMfaPath(pathname: string): boolean {
  return pathname === MFA_PREFIX || pathname.startsWith(`${MFA_PREFIX}/`);
}

/**
 * Inside a running test: skip it with `reason`. Outside one (a QA script):
 * throw. Never returns.
 */
function skipOrRefuse(reason: string): never {
  // test.info() throws outside a running test; that is the only thing the
  // probe asks. The skip itself stays outside the try so its own control-flow
  // throw propagates untouched.
  let insideTest = true;
  try {
    test.info();
  } catch {
    insideTest = false;
  }
  if (insideTest) test.skip(true, reason);
  throw new Error(reason);
}

/**
 * Call BEFORE typing anything into the login form. On a remote target only the
 * rotated e2e accounts may sign in (e2e/_credentials.ts); any other account
 * (admin@, govt@, … — locked on staging, not rotated) is skipped with the
 * reason instead of receiving E2E_STAGING_PASSWORD. The post-login skip below
 * comes too late for that: by then the password has already been typed.
 */
export function skipUnlessRemoteLoginAllowed(pageUrl: string, email: string): void {
  const refusal = remoteLoginRefusal(pageUrl, email);
  if (refusal) skipOrRefuse(refusal);
}

async function submitCode(page: Page, secret: string): Promise<void> {
  await page.getByLabel(/código de verificación/i).fill(totp(secret));
  await page.getByRole("button", { name: /^verificar$/i }).click();
}

/**
 * If the sign-in owes a second factor, complete it and wait until the page
 * leaves the /mfa screens. `password` is the account's (SHARED_PASSWORD).
 */
export async function passSecondFactorIfAsked(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  // ASK THE SERVER, DO NOT WATCH THE ADDRESS BAR. The login lands on the role
  // home (/admin, /gob) and the guard there redirects to /mfa — but late: the
  // redirect rides the streamed render, AFTER networkidle (measured: the URL
  // read /admin at networkidle and turned into /mfa/configurar a moment later).
  // So instead of guessing when it settles, load /mfa ourselves: its server
  // component answers deterministically — the challenge or the setup page when
  // a factor is owed, a redirect away (to returnTo, or "/" for a personal
  // account) when not. Then put the page back where the login left it.
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  let here = new URL(page.url());
  if (!isMfaPath(here.pathname)) {
    const landing = `${here.pathname}${here.search}`;
    await page.goto(
      new URL(`${MFA_PREFIX}?returnTo=${encodeURIComponent(landing)}`, here).toString(),
    );
    here = new URL(page.url());
    if (!isMfaPath(here.pathname)) {
      await page.goto(new URL(landing, here).toString());
      await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
      return;
    }
  }

  // NEVER ENROL ON A REMOTE TARGET. Against staging the seed accounts are real
  // people's accounts too (the PO signs in as admin@dim.test): enrolling a
  // factor there would replace their authenticator, and a CI runner cannot even
  // clear it the next night without the staging service key. Institutional
  // logins on a remote target need an operator-provided secret, which does not
  // exist yet — so inside a test the step is skipped with that reason, and
  // outside one (a QA script) it stops loudly instead of enrolling.
  if (!LOCAL_HOSTS.has(here.hostname)) {
    skipOrRefuse(
      `institutional login on ${here.host} needs a second factor; e2e never enrols one on a remote target`,
    );
  }

  const { secret, enrolledNow } = await ensureSeedTotp(seedMfaEnvFromProcess(), email, password);

  if (enrolledNow) {
    // Verifying a first factor makes GoTrue end every other aal1 session of the
    // account — this browser's included (measured). Sign in again; the guard
    // now sends the session to the challenge, since the factor exists.
    await page.goto(new URL(`${SIGN_IN_PATH}${here.search}`, here).toString());
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await page.getByLabel(/correo electrónico/i).fill(email);
    await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
    await page.getByRole("button", { name: /iniciar sesión/i }).click();
    await page.waitForURL(leftSignIn, { timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  }
  // The challenge, carrying the returnTo the MFA page was reached with. After a
  // re-login the address bar is somewhere on its way there, so go explicitly.
  // Absolute URLs: some QA scripts drive a page with no Playwright baseURL.
  if (enrolledNow || new URL(page.url()).pathname !== MFA_PREFIX) {
    await page.goto(new URL(`${MFA_PREFIX}${here.search}`, here).toString());
  }
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});

  await submitCode(page, secret);
  const left = (url: URL) => !isMfaPath(url.pathname);
  try {
    await page.waitForURL(left, { timeout: 15_000 });
  } catch {
    // Defensive: local GoTrue v2.188.1 accepted the same code twice inside one
    // 30-second step (measured), but if a version ever refuses a replay, the
    // code the API enrolment just used would fail here. Wait one step, retry.
    await page.waitForTimeout((secondsLeftInStep() + 1) * 1000);
    await submitCode(page, secret);
    await page.waitForURL(left, { timeout: 15_000 });
  }
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
}
