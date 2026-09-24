// Panorama VISUALS/CHROME QA harness (task #49) — screenshots + axe re-check.
//
// Drives the panorama console across the states the #49 visual round touches and
// captures panorama-vis-qa-*.png in the repo root, plus an axe-core pass to
// confirm the chrome-contrast / a11y round kept 0 targeted violations.
//
// REPORT, NOT GATE (T1-C4, 2026-09-18). It runs nightly in
// dim-interno:.github/workflows/panorama-qa-nightly.yml right after report-panorama-a11y,
// with the same 20 s wait on `panorama-dock` that kept that workflow red for
// 20 nights — so fixing only the a11y step would have moved the red one step
// down. A step that fails is now a report row in the GitHub job summary and the
// run exits 0; only the harness being unable to run exits non-zero
// (scripts/lib/qa-report-outcome.ts).
//
// Usage (server must be running on :3000 with the fresh build):
//   pnpm exec tsx scripts/qa-panorama-vis.ts --email=admin@dim.test
//   pnpm exec tsx scripts/qa-panorama-vis.ts --email=lucas@dim.test [--out=DIR]

import { createRequire } from "node:module";
import { join } from "node:path";

import { type Browser, type Page, chromium } from "@playwright/test";

import { passSecondFactorIfAsked } from "../e2e/_mfa";
import { leftSignIn } from "../e2e/_sign-in-route";
import {
  type QaFinding,
  type QaRunOutcome,
  appendJobSummary,
  errorMessage,
  outcomeSummaryMarkdown,
  reportOnlyExitCode,
} from "./lib/qa-report-outcome";

// Review F8 (2026-08-15): resolve through the package graph, not a hardcoded
// .pnpm store path — an axe-core version bump silently broke the old constant.
const AXE_PATH = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const TARGET_RULES = new Set([
  "aria-valid-attr-value",
  "nested-interactive",
  "listitem",
  "color-contrast",
]);

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"] as const;
  }),
);
const EMAIL = args.get("email") ?? "admin@dim.test";
const PASSWORD = args.get("password") ?? "Test1234!";
const BASE = args.get("base") ?? "http://localhost:3000";
const OUT = args.get("out") ?? ".";
const panoramaPath = EMAIL.startsWith("admin@") ? "/admin/panorama" : "/gob/panorama";
const tag = EMAIL.startsWith("admin@") ? "admin" : "lucas";

const VIEWPORTS = [
  { w: 1920, h: 1080 },
  { w: 1366, h: 768 },
];

const findings: QaFinding[] = [];
// Counted separately from `findings` (a login/step failure IS a finding, but
// contributes zero here) so the run can tell "we drove the product and it
// had issues" from "we never actually drove the product" — see
// scripts/lib/qa-report-outcome.ts.
let successfulSteps = 0;

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel(/correo electrónico/i).fill(EMAIL);
  // getByLabel(/contraseña/i) is AMBIGUOUS: the field grew a "Mostrar
  // contraseña" toggle whose aria-label matches the same regex, so Playwright
  // fails on strict mode and these four QA drivers could not log in AT ALL.
  // Found 2026-08-10 by smoke-testing the driver before depending on it —
  // nobody had run them since the toggle landed. getByRole pins the input.
  await page.getByRole("textbox", { name: /contraseña/i }).fill(PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  // leftSignIn, not `!startsWith("/login")`: the sign-in page is /iniciar-sesion
  // and the old predicate held before a credential was typed (e2e/_sign-in-route.ts).
  await page.waitForURL(leftSignIn, { timeout: 25_000 });
  // Institutional accounts owe TOTP since T2-S6 (e2e/_mfa.ts).
  await passSecondFactorIfAsked(page, EMAIL, PASSWORD);
}

async function waitForMap(page: Page): Promise<void> {
  await page.getByTestId("panorama-dock").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(2200);
}

async function shot(page: Page, name: string): Promise<void> {
  const path = join(OUT, `panorama-vis-qa-${name}.png`);
  await page.screenshot({ path });
  console.log(`  shot -> ${path}`);
}

type AxeViolation = { id: string; impact: string; nodes: unknown[] };

async function axe(page: Page, state: string): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  const results = (await page.evaluate(async () => {
    // @ts-expect-error injected global
    return await window.axe.run(document, { resultTypes: ["violations"] });
  })) as { violations: AxeViolation[] };
  const targeted = results.violations.filter((v) => TARGET_RULES.has(v.id));
  const nodeCount = targeted.reduce((n, v) => n + v.nodes.length, 0);
  console.log(`  [${state}] axe total=${results.violations.length} targeted=${nodeCount}`);
  for (const v of targeted) {
    console.log(`    x ${v.id} (${v.impact}) x ${v.nodes.length}`);
    findings.push({ where: state, kind: `axe:${v.id}`, detail: `${v.nodes.length} node(s)` });
  }
  return targeted;
}

/** A throw inside a step is a finding, recorded; the run goes on. */
async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    successfulSteps++;
    return true;
  } catch (err) {
    const detail = errorMessage(err);
    console.error(`  ✗ step ${name} failed: ${detail}`);
    findings.push({ where: name, kind: "step-failed", detail });
    return false;
  }
}

async function main(): Promise<QaRunOutcome> {
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    return { kind: "harness-crash", message: `chromium did not launch: ${errorMessage(err)}` };
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    if (!(await step("login", () => login(page)))) {
      findings.push({
        where: "run",
        kind: "skipped",
        detail: "every view: the login did not land",
      });
      return { kind: "completed", findings, successfulSteps };
    }

    for (const vp of VIEWPORTS) {
      const wtag = `${vp.w}`;
      await page.setViewportSize({ width: vp.w, height: vp.h });

      // National view: floating chrome over the map, control cluster, home icon.
      await step(`national-${wtag}`, async () => {
        await page.goto(`${BASE}${panoramaPath}`, { waitUntil: "domcontentloaded" });
        await waitForMap(page);
        await shot(page, `${tag}-national-${wtag}`);
        if (vp.w === 1920) await axe(page, `${tag}-national`);
        // Legend pill expanded in place (item 9).
        await page
          .getByTestId("panorama-scope-pill")
          .waitFor({ timeout: 3000 })
          .catch(() => {});
      });

      // Drill into CABA (province=AR-C): NO double CABA inset (item 6).
      await step(`caba-drill-${wtag}`, async () => {
        await page.goto(`${BASE}${panoramaPath}?province=AR-C`, { waitUntil: "domcontentloaded" });
        await waitForMap(page);
        await shot(page, `${tag}-caba-drill-${wtag}`);
      });

      // Drill into PBA (province=AR-B): CABA inset KEPT (item 6 control).
      await step(`pba-drill-${wtag}`, async () => {
        await page.goto(`${BASE}${panoramaPath}?province=AR-B`, { waitUntil: "domcontentloaded" });
        await waitForMap(page);
        await shot(page, `${tag}-pba-drill-${wtag}`);
      });
    }
    return { kind: "completed", findings, successfulSteps };
  } finally {
    await browser.close().catch(() => {});
  }
}

const SUMMARY_TITLE = `Panorama visual report — ${EMAIL}`;

main()
  .then((outcome) => {
    appendJobSummary(outcomeSummaryMarkdown(SUMMARY_TITLE, outcome));
    if (outcome.kind === "harness-crash") console.error(`HARNESS CRASH: ${outcome.message}`);
    process.exit(reportOnlyExitCode(outcome));
  })
  .catch((err) => {
    // A throw that escaped every step is a bug in THIS script, not a finding.
    console.error(err);
    const outcome: QaRunOutcome = { kind: "harness-crash", message: errorMessage(err) };
    appendJobSummary(outcomeSummaryMarkdown(SUMMARY_TITLE, outcome));
    process.exit(reportOnlyExitCode(outcome));
  });
