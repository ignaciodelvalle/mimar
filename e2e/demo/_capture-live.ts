// Live-review capture harness (throwaway instrument, not product code).
//
// Each reviewer agent runs its OWN chromium via this script, so N reviewers can
// work in parallel without fighting over a single shared browser — which is what
// would happen if they all drove the Playwright MCP server.
//
// For every route it writes, under --out:
//   <slug>.desktop.png   full-page screenshot at 1440x900
//   <slug>.mobile.png    full-page screenshot at 390x844
//   <slug>.txt           status, console errors, failed requests, and the
//                        visible text — so a reviewer can QUOTE evidence
//                        without needing to read an image.
//
// Usage:
//   pnpm tsx <this> --role owner --out C:/path/out --routes "/mis-mascotas,/cuenta"
//   pnpm tsx <this> --role none  --out C:/path/out --routes "/,/login"

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type Page, chromium } from "@playwright/test";

import { ACCOUNTS, loginAs } from "./_helpers";

const BASE = "http://localhost:3000";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function slugify(route: string): string {
  return route.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "root";
}

type Capture = {
  route: string;
  status: number | null;
  consoleErrors: string[];
  failedRequests: string[];
  text: string;
};

async function capture(page: Page, route: string, out: string): Promise<Capture> {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const onConsole = (m: { type: () => string; text: () => string }) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  };
  const onFailed = (r: { url: () => string; failure: () => { errorText: string } | null }) => {
    failedRequests.push(`${r.url().replace(BASE, "")} — ${r.failure()?.errorText ?? "?"}`);
  };
  page.on("console", onConsole);
  page.on("requestfailed", onFailed);

  let status: number | null = null;
  try {
    const resp = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 30_000 });
    status = resp?.status() ?? null;
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(1_200);
  } catch (e) {
    consoleErrors.push(`NAVIGATION FAILED: ${(e as Error).message.slice(0, 200)}`);
  }

  const slug = slugify(route);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await page
    .screenshot({ path: path.join(out, `${slug}.desktop.png`), fullPage: true })
    .catch(() => {});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await page
    .screenshot({ path: path.join(out, `${slug}.mobile.png`), fullPage: true })
    .catch(() => {});
  await page.setViewportSize({ width: 1440, height: 900 });

  const text = await page
    .evaluate(() => document.body?.innerText?.slice(0, 12_000) ?? "")
    .catch(() => "");

  page.off("console", onConsole);
  page.off("requestfailed", onFailed);

  const result: Capture = { route, status, consoleErrors, failedRequests, text };
  writeFileSync(
    path.join(out, `${slug}.txt`),
    [
      `ROUTE: ${route}`,
      `STATUS: ${status}`,
      `FINAL URL: ${page.url()}`,
      "",
      `CONSOLE ERRORS (${consoleErrors.length}):`,
      ...consoleErrors.map((e) => `  ${e}`),
      "",
      `FAILED REQUESTS (${failedRequests.length}):`,
      ...failedRequests.map((r) => `  ${r}`),
      "",
      "VISIBLE TEXT:",
      text,
    ].join("\n"),
    "utf8",
  );
  return result;
}

async function main(): Promise<void> {
  const role = arg("role", "none");
  const out = arg("out");
  const routes = arg("routes")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (!out || routes.length === 0) {
    console.error("need --out <dir> and --routes <comma,separated>");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  if (role !== "none") {
    const email = (ACCOUNTS as Record<string, string>)[role];
    if (!email) {
      console.error(`unknown role "${role}" — known: ${Object.keys(ACCOUNTS).join(", ")}`);
      process.exit(2);
    }
    await loginAs(page, email);
    console.log(`logged in as ${email} → ${page.url()}`);
  }

  for (const route of routes) {
    const c = await capture(page, route, out);
    console.log(
      `${c.status ?? "ERR"}  ${route}  console:${c.consoleErrors.length}  netfail:${c.failedRequests.length}`,
    );
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
