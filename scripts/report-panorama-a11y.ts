// Panorama a11y REPORT — axe-core + keyboard probes. NOT A GATE.
//
// ─── Read this before quoting its output ──────────────────────────────────
// This script MEASURES; it never enforces. It exits 0 with violations on the
// page, and since T1-C4 (2026-09-18) also when a STEP fails — a login that
// does not land, a dock that never becomes visible: those are report rows
// ("step-failed"), written to the JSON report and to the GitHub job summary.
// The only non-zero exit is the harness itself being unable to run (chromium
// does not launch, the report cannot be written, or a bug in this script
// escapes every step) — see scripts/lib/qa-report-outcome.ts. It runs nightly
// in dim-interno:.github/workflows/panorama-qa-nightly.yml, which is report-only; before
// T1-C4 an uncaught 20 s dock timeout kept that workflow red for 20 nights. It was named `qa-panorama-a11y.ts`, which read like
// one of the `scripts/check-*.ts` gates wired into `pnpm verify`; it was not,
// and its clean output has never meant "Panorama is accessible".
//
// The ENFORCING a11y checks are the Playwright axe scans — `e2e/public-smoke.
// spec.ts`, `e2e/a11y-*.spec.ts` — which run in CI and fail on violations.
// If a finding here matters, it belongs in one of those.
//
// What it is for: a rich, human-read snapshot (per-state violation lists,
// keyboard-path probes, screenshots, a JSON report) while working on the
// Panorama console — the states the task-#43 audit covered, re-measured:
//   A1 dangling aria-controls, A3 nested-interactive (map), A4 orphaned
//   listitem (presets), A2/A5/A6 contrast, M1 focus-restore + M2 announce
//   (scope pill), M3 roving dock tablist.
//
// Usage (server must be running on :3000 with the fresh build):
//   pnpm exec tsx scripts/report-panorama-a11y.ts --email=admin@dim.test
//   pnpm exec tsx scripts/report-panorama-a11y.ts --email=lucas@dim.test

import { writeFileSync } from "node:fs";
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
  "aria-valid-attr-value", // A1
  "nested-interactive", // A3
  "listitem", // A4
  "color-contrast", // A2/A5/A6
  "scrollable-region-focusable", // L-19 (MapDataTable scroll container)
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

type AxeViolation = {
  id: string;
  impact: string | null;
  nodes: Array<{ target: string[]; failureSummary?: string }>;
};

// Every finding of the run — a TARGET-rule violation or a step that failed —
// lands here, and from here in the JSON report and the job summary.
const findings: QaFinding[] = [];

async function runAxe(page: Page, state: string): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  const results = (await page.evaluate(async () => {
    // @ts-expect-error injected global
    return await window.axe.run(document, {
      resultTypes: ["violations"],
    });
  })) as { violations: AxeViolation[] };
  const targeted = results.violations.filter((v) => TARGET_RULES.has(v.id));
  const total = results.violations.length;
  const targetedCount = targeted.reduce((n, v) => n + v.nodes.length, 0);
  console.log(`  [${state}] total axe violations: ${total} | TARGET-rule nodes: ${targetedCount}`);
  for (const v of targeted) {
    console.log(
      `    ✗ ${v.id} (${v.impact}) × ${v.nodes.length} — ${v.nodes[0]?.target.join(" ")}`,
    );
    findings.push({
      where: state,
      kind: `axe:${v.id}`,
      detail: `${v.nodes.length} node(s), first: ${v.nodes[0]?.target.join(" ") ?? "?"}`,
    });
  }
  return results.violations;
}

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
  await page.waitForTimeout(1500);
}

/**
 * Run one step of the report. A throw is a FINDING, not a crash: it is recorded
 * and the run goes on to whatever does not depend on it.
 */
async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    const detail = errorMessage(err);
    console.error(`  ✗ step ${name} failed: ${detail}`);
    findings.push({ where: name, kind: "step-failed", detail });
    return false;
  }
}

function skipped(names: string[], because: string): void {
  for (const name of names) findings.push({ where: name, kind: "skipped", detail: because });
}

async function main(): Promise<QaRunOutcome> {
  const report: Record<string, unknown> = { email: EMAIL, base: BASE, states: {}, findings };
  const states = report.states as Record<string, AxeViolation[]>;
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    return { kind: "harness-crash", message: `chromium did not launch: ${errorMessage(err)}` };
  }
  const kb: Record<string, unknown> = {};

  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    if (!(await step("login", () => login(page)))) {
      skipped(["national", "dock", "rail", "drilled", "scope-commit"], "the login did not land");
    } else {
      const nationalOk = await step("national", async () => {
        await page.goto(`${BASE}${panoramaPath}`, { waitUntil: "domcontentloaded" });
        await waitForMap(page);
        states.national = await runAxe(page, "national");
        await page.screenshot({ path: join(OUT, `panorama-a11y-qa-${tag}-national.png`) });
      });
      if (!nationalOk) {
        skipped(["dock", "rail"], "the national view never became ready");
      } else {
        await step("dock", () => probeDock(page, states, kb));
        await step("rail", () => scanRail(page, states));
      }
      await step("drilled", async () => {
        // Admin: force province=AR-C; lucas is already CABA-scoped.
        const drillUrl = EMAIL.startsWith("admin@")
          ? `${BASE}${panoramaPath}?province=AR-C`
          : `${BASE}${panoramaPath}`;
        await page.goto(drillUrl, { waitUntil: "domcontentloaded" });
        await waitForMap(page);
        states.drilled = await runAxe(page, "drilled");
        await page.screenshot({ path: join(OUT, `panorama-a11y-qa-${tag}-drilled.png`) });
      });
      if (EMAIL.startsWith("admin@")) {
        await step("scope-commit", () => probeScopeCommit(page, kb));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  report.keyboard = kb;
  const outFile = join(OUT, `panorama-a11y-qa-${tag}.json`);
  try {
    writeFileSync(outFile, JSON.stringify(report, null, 2));
  } catch (err) {
    return { kind: "harness-crash", message: `could not write ${outFile}: ${errorMessage(err)}` };
  }
  console.log(`\n  wrote ${outFile}`);
  console.log(`  keyboard checks: ${JSON.stringify(kb, null, 2)}`);
  // Say it where the output is read, not only in the header: a reader who
  // scrolls to the end must not mistake a quiet run for a passing gate.
  console.log(
    "\n  NOTE: this is a REPORT, not a gate — it exits 0 with violations and failed steps.\n" +
      "  The enforcing a11y checks are the Playwright axe scans (e2e/public-smoke.spec.ts,\n" +
      "  e2e/a11y-*.spec.ts), which run in CI and fail on violations.",
  );
  return { kind: "completed", findings };
}

// --- A1 / M3 / L-19: the dock, probed from the national view ---
async function probeDock(
  page: Page,
  states: Record<string, AxeViolation[]>,
  kb: Record<string, unknown>,
): Promise<void> {
  // A1: dock aria-controls presence by state (collapsed vs expanded).
  const collapsedControls = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="tab"]')).map((t) =>
      t.getAttribute("aria-controls"),
    ),
  );
  await page.getByRole("tab", { name: /Estadísticas/ }).click();
  await page.waitForTimeout(400);
  const expandedControls = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="tab"]')).map((t) =>
      t.getAttribute("aria-controls"),
    ),
  );
  const panelExists = await page.evaluate(() => !!document.getElementById("pano-dock-panel"));
  kb.dockAriaControls = {
    collapsed: collapsedControls,
    expanded: expandedControls,
    panelExistsWhenExpanded: panelExists,
  };
  states.dockExpanded = await runAxe(page, "dock-expanded(stats)");
  await page.screenshot({ path: join(OUT, `panorama-a11y-qa-${tag}-dock.png`) });

  // M3: dock roving tabindex + ArrowRight.
  await page.getByRole("tab", { name: /Registros/ }).focus();
  const tabIdxBefore = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="tab"]')).map((t) => t.getAttribute("tabindex")),
  );
  await page.keyboard.press("ArrowRight");
  const afterArrow = await page.evaluate(() => ({
    active: document.activeElement?.getAttribute("id"),
    tabindex: Array.from(document.querySelectorAll('[role="tab"]')).map((t) =>
      t.getAttribute("tabindex"),
    ),
  }));
  kb.dockRoving = { tabIdxBefore, afterArrow };

  // Registros pane (L-19): actually OPEN the tab so MapDataTable's DOM exists
  // before the axe pass — the roving-tabindex probe above only focuses the
  // tab, so this surface was never scanned before.
  await page.getByRole("tab", { name: /Registros/ }).click();
  await page.waitForTimeout(400);
  states.dockRegistros = await runAxe(page, "dock-registros(records-table)");

  // Collapse the dock again for the panel scans.
  await page.getByRole("button", { name: /Colapsar/ }).click();
  await page.waitForTimeout(300);
}

// --- Rail panels (A4 presets, A5 filtro) ---
async function scanRail(page: Page, states: Record<string, AxeViolation[]>): Promise<void> {
  for (const label of ["Vista", "Capas del mapa", "Período", "Exportar", "Acerca"]) {
    const btn = page.getByRole("button", { name: label, exact: true }).first();
    if ((await btn.count()) === 0) continue;
    await btn.click();
    await page.waitForTimeout(400);
    states[`rail-${label}`] = await runAxe(page, `rail-${label}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
}

// --- M1 + M2: scope pill commit → focus restore + announce (admin only) ---
async function probeScopeCommit(page: Page, kb: Record<string, unknown>): Promise<void> {
  await page.goto(`${BASE}${panoramaPath}`, { waitUntil: "domcontentloaded" });
  await waitForMap(page);
  const pill = page.getByTestId("panorama-scope-pill");
  await pill.click(); // open the disclosure
  await page.waitForTimeout(300);
  const select = page.locator("select").first();
  if ((await select.count()) > 0) {
    // Commit a province via the native select (the keyboard path).
    const optionValue = await page.evaluate(() => {
      const s = document.querySelector("select");
      if (!s) return null;
      const opt = Array.from(s.options).find(
        (o) => /Córdoba|Buenos Aires|Catamarca/i.test(o.textContent ?? "") && o.value,
      );
      return opt?.value ?? null;
    });
    if (optionValue) {
      await select.selectOption(optionValue);
      await page.waitForTimeout(600);
    }
  }
  kb.scopeCommit = await page.evaluate(() => ({
    activeIsSummary: document.activeElement?.getAttribute("data-testid") === "panorama-scope-pill",
    activeTag: document.activeElement?.tagName,
    liveRegionText:
      document.querySelector('[data-testid="panorama-scope-live"]')?.textContent ?? null,
  }));
}

const SUMMARY_TITLE = `Panorama a11y report — ${EMAIL}`;

main()
  .then((outcome) => {
    appendJobSummary(outcomeSummaryMarkdown(SUMMARY_TITLE, outcome));
    if (outcome.kind === "harness-crash") console.error(`\n  HARNESS CRASH: ${outcome.message}`);
    process.exit(reportOnlyExitCode(outcome));
  })
  .catch((err) => {
    // A throw that escaped every step is a bug in THIS script, not a finding
    // about the page — the one case that may still turn the run red.
    const outcome: QaRunOutcome = { kind: "harness-crash", message: errorMessage(err) };
    console.error(err);
    appendJobSummary(outcomeSummaryMarkdown(SUMMARY_TITLE, outcome));
    process.exit(reportOnlyExitCode(outcome));
  });
