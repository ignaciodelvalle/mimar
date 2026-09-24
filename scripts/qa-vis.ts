/**
 * Generic visual QA driver for MiMAR — a scriptable browser the agent can "see" through.
 *
 * Unlike the route-level harnesses (qa-routes.ts) which only assert on HTML, this
 * drives a real chromium page, runs an arbitrary step list, and writes PNGs the
 * caller reads back. It replaces an interactive browser tool for headless runs.
 *
 * Two ways to use it:
 *
 *   1. Quick single-route capture
 *      pnpm exec tsx scripts/qa-vis.ts --email=admin@dim.test --route=/admin/panorama \
 *        --wait=panorama-dock --name=entry --text
 *
 *   2. Step script (multi-step interactions: hover, click, drill, replay, …)
 *      pnpm exec tsx scripts/qa-vis.ts --steps=path/to/steps.json
 *
 * Step file shape (all fields optional except `steps`):
 *   {
 *     "email": "admin@dim.test",
 *     "viewport": [1920, 1080],
 *     "steps": [
 *       { "do": "goto",   "url": "/admin/panorama?preset=zoonosis" },
 *       { "do": "wait",   "testid": "panorama-dock" },
 *       { "do": "shot",   "name": "entry" },
 *       { "do": "hover",  "testid": "ranked-row-0" },
 *       { "do": "shot",   "name": "hover-preview", "clip": "viewport" },
 *       { "do": "click",  "text": "Buenos Aires" },
 *       { "do": "sleep",  "ms": 1500 },
 *       { "do": "shot",   "name": "after-drill" },
 *       { "do": "text",   "selector": "main" },
 *       { "do": "eval",   "expr": "document.querySelectorAll('[data-testid]').length" },
 *       { "do": "assert", "expr": "document.querySelectorAll('canvas').length > 0",
 *                         "why": "maplibre initialised" },
 *       { "do": "anon" }
 *     ]
 *   }
 *
 * Console errors and uncaught page errors are always collected and printed at the
 * end — a clean screenshot over a broken console is not a passing state.
 *
 * EXIT CODES — why this driver can be trusted in a pipeline
 * ---------------------------------------------------------------------------
 * It could not, until 2026-07-27. The loop caught every step error, logged
 * STEP FAILED, continued, and then called process.exit(0) unconditionally: run
 * it against six broken surfaces and it still went green. A fence that cannot
 * fail is worse than no fence, because it hands out permission.
 *
 * The catch-and-continue is deliberate and stays — a smoke run that aborts on
 * step 3 tells you about one surface when you asked about six. What changed is
 * that failures are now REMEMBERED and reported at the end:
 *
 *   exit 0  every step ran and every assert held
 *   exit 1  at least one step threw, or at least one assert did not hold
 *
 * `eval` still only prints — it is for looking. `assert` is for judging: it
 * evaluates an expression in the page and compares it to `expected` (default
 * `true`), and a mismatch is what turns the run red.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Browser, type BrowserContext, type Page, chromium } from "@playwright/test";
import { passSecondFactorIfAsked } from "../e2e/_mfa";
import { leftSignIn } from "../e2e/_sign-in-route";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"] as const;
  }),
);

// Repo-relative, and under the already-gitignored scratch directory. It used to
// be an absolute path into one machine's temp folder, committed — which meant
// the checked-in cutover smoke wrote nowhere useful on anyone else's box.
const DEFAULT_OUT = resolve(process.cwd(), "tmp/qa-vis");

type Step =
  | { do: "goto"; url: string }
  | { do: "wait"; testid?: string; selector?: string; text?: string; timeout?: number }
  | { do: "shot"; name: string; clip?: "viewport" | "full" }
  | { do: "click"; testid?: string; selector?: string; text?: string; role?: string }
  | { do: "hover"; testid?: string; selector?: string; text?: string }
  | { do: "fill"; selector: string; value: string }
  | { do: "press"; key: string }
  | { do: "sleep"; ms: number }
  | { do: "text"; selector?: string; limit?: number }
  | { do: "eval"; expr: string }
  // The judging step. `expected` defaults to true; comparison is structural
  // (JSON), so objects and arrays work. `why` is printed on failure — a red
  // assert should explain itself without anyone opening the step file.
  | { do: "assert"; expr: string; expected?: unknown; why?: string }
  // Drop the session: continue in a brand-new context with no cookies and no
  // storage state. The cutover smoke's /login step needs this — with a live
  // session that route redirects to the panel, so the check reads the panel's
  // h1 and proves nothing about what an unauthenticated citizen hits first.
  | { do: "anon" };

type StepFile = {
  email?: string;
  password?: string;
  base?: string;
  viewport?: [number, number];
  out?: string;
  tag?: string;
  steps: Step[];
};

function loadConfig(): Required<Omit<StepFile, "steps">> & { steps: Step[] } {
  const stepsPath = args.get("steps");
  const file: StepFile = stepsPath
    ? (JSON.parse(readFileSync(stepsPath, "utf8")) as StepFile)
    : { steps: [] };

  // Quick mode: --route builds a minimal step list.
  if (!stepsPath) {
    const route = args.get("route");
    if (!route) {
      console.error("Need either --steps=<file.json> or --route=<path>");
      process.exit(1);
    }
    const waitTestId = args.get("wait");
    const name = args.get("name") ?? "shot";
    file.steps = [
      { do: "goto", url: route },
      ...(waitTestId ? ([{ do: "wait", testid: waitTestId }] as Step[]) : []),
      { do: "sleep", ms: Number(args.get("settle") ?? 2000) },
      { do: "shot", name, clip: args.get("full") ? "full" : "viewport" },
      ...(args.get("text") ? ([{ do: "text", selector: "main" }] as Step[]) : []),
    ];
  }

  const viewportArg = args.get("viewport");
  const viewport: [number, number] = viewportArg
    ? (viewportArg.split("x").map(Number) as [number, number])
    : (file.viewport ?? [1440, 900]);

  return {
    email: args.get("email") ?? file.email ?? "admin@dim.test",
    password: args.get("password") ?? file.password ?? "Test1234!",
    base: args.get("base") ?? file.base ?? "http://localhost:3000",
    viewport,
    out: args.get("out") ?? file.out ?? DEFAULT_OUT,
    tag: args.get("tag") ?? file.tag ?? "vis",
    steps: file.steps,
  };
}

const cfg = loadConfig();

// ---------------------------------------------------------------------------
// Auth — storage state is cached per email so long capture runs skip re-login.
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 20 * 60 * 1000;

function statePath(email: string): string {
  return resolve(cfg.out, `.state-${email.replace(/[^a-z0-9]/gi, "_")}.json`);
}

function freshStateFor(email: string): string | undefined {
  if (args.get("fresh")) return undefined;
  const p = statePath(email);
  if (!existsSync(p)) return undefined;
  if (Date.now() - statSync(p).mtimeMs > STATE_TTL_MS) return undefined;
  return p;
}

async function login(page: Page): Promise<void> {
  await page.goto(`${cfg.base}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel(/correo electrónico/i).fill(cfg.email);
  // getByLabel(/contraseña/i) is AMBIGUOUS: the field grew a "Mostrar
  // contraseña" toggle whose aria-label matches the same regex, so Playwright
  // fails on strict mode and these four QA drivers could not log in AT ALL.
  // Found 2026-08-10 by smoke-testing the driver before depending on it —
  // nobody had run them since the toggle landed. getByRole pins the input.
  await page.getByRole("textbox", { name: /contraseña/i }).fill(cfg.password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  // leftSignIn, not `!startsWith("/login")`: the sign-in page is /iniciar-sesion
  // and the old predicate held before a credential was typed (e2e/_sign-in-route.ts).
  await page.waitForURL(leftSignIn, { timeout: 30_000 });
  // Institutional accounts owe TOTP since T2-S6 (e2e/_mfa.ts).
  await passSecondFactorIfAsked(page, cfg.email, cfg.password);
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

/**
 * Git Bash on Windows rewrites any argv entry starting with "/" into a Windows
 * path (MSYS path conversion), so `--route=/admin/panorama` arrives as
 * `C:/Program Files/Git/admin/panorama`. Undo that, and accept routes passed
 * without a leading slash (the mangle-proof way to call this from bash).
 */
function normalizeUrl(raw: string): string {
  if (raw.startsWith("http")) return raw;
  const demangled = raw.replace(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/]/, "/").replace(/\\/g, "/");
  return demangled.startsWith("/") ? demangled : `/${demangled}`;
}

function locate(page: Page, s: { testid?: string; selector?: string; text?: string }) {
  if (s.testid) return page.getByTestId(s.testid);
  if (s.selector) return page.locator(s.selector);
  if (s.text) return page.getByText(s.text, { exact: false }).first();
  throw new Error("step needs one of: testid | selector | text");
}

/**
 * A step can replace the page under it (`anon`), so the loop holds the browser
 * state in one mutable object rather than a `page` binding it cannot reassign.
 */
type Session = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

/** Everything a run needs to report at the end, and to decide its exit code. */
type Report = {
  shots: string[];
  /** One line per step that threw or assert that did not hold. */
  failures: string[];
  consoleErrors: string[];
};

/** Attach the console/pageerror collectors to a page. Re-run after `anon`. */
function watchConsole(page: Page, consoleErrors: string[]): void {
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR: ${String(e).slice(0, 300)}`));
}

async function runStep(session: Session, step: Step, report: Report): Promise<void> {
  const page = session.page;
  switch (step.do) {
    case "goto": {
      const path = normalizeUrl(step.url);
      const url = path.startsWith("http") ? path : `${cfg.base}${path}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      console.log(`  goto ${path}`);
      break;
    }
    case "wait": {
      await locate(page, step)
        .first()
        .waitFor({ state: "visible", timeout: step.timeout ?? 20_000 });
      console.log(`  wait ok (${step.testid ?? step.selector ?? step.text})`);
      break;
    }
    case "shot": {
      const path = resolve(cfg.out, `${cfg.tag}-${step.name}.png`);
      await page.screenshot({ path, fullPage: step.clip === "full" });
      report.shots.push(path);
      console.log(`  shot -> ${path}`);
      break;
    }
    case "click": {
      const target = step.role
        ? page.getByRole(step.role as "button", { name: new RegExp(step.text ?? "", "i") })
        : locate(page, step);
      await target.first().click({ timeout: 15_000 });
      console.log(`  click (${step.testid ?? step.selector ?? step.text})`);
      break;
    }
    case "hover": {
      await locate(page, step).first().hover({ timeout: 15_000 });
      console.log(`  hover (${step.testid ?? step.selector ?? step.text})`);
      break;
    }
    case "fill": {
      await page.locator(step.selector).first().fill(step.value);
      console.log(`  fill ${step.selector}`);
      break;
    }
    case "press": {
      await page.keyboard.press(step.key);
      console.log(`  press ${step.key}`);
      break;
    }
    case "sleep": {
      await page.waitForTimeout(step.ms);
      break;
    }
    case "text": {
      const sel = step.selector ?? "body";
      const txt = await page.locator(sel).first().innerText();
      const limit = step.limit ?? 4000;
      console.log(`\n----- TEXT ${sel} -----\n${txt.slice(0, limit)}\n----- /TEXT -----\n`);
      break;
    }
    case "eval": {
      const value = await pageEval(page, step.expr);
      console.log(`  eval ${step.expr} => ${JSON.stringify(value)}`);
      break;
    }
    case "assert": {
      const expected = "expected" in step ? step.expected : true;
      const actual = await pageEval(page, step.expr);
      // Structural comparison, so an assert can pin an object or an array and
      // not just a scalar. Both sides go through JSON so `undefined` and a
      // missing key compare equal — which is what a page check wants.
      const held = JSON.stringify(actual) === JSON.stringify(expected);
      if (held) {
        console.log(`  assert OK  ${step.expr} => ${JSON.stringify(actual)}`);
        break;
      }
      const why = step.why ? `\n    why it matters: ${step.why}` : "";
      const line = `assert FAILED: ${step.expr}\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${why}`;
      report.failures.push(line);
      console.log(`  ${line}`);
      break;
    }
    case "anon": {
      // A fresh context, not just a fresh page: cookies and localStorage are
      // what carry the session, and both live on the context.
      await session.context.close().catch(() => {});
      session.context = await session.browser.newContext({
        viewport: { width: cfg.viewport[0], height: cfg.viewport[1] },
        deviceScaleFactor: 1,
        reducedMotion: args.get("reduced") ? "reduce" : "no-preference",
      });
      session.page = await session.context.newPage();
      watchConsole(session.page, report.consoleErrors);
      console.log("  anon (signed out — new context, no cookies, no storage state)");
      break;
    }
  }
}

/** Evaluate an expression string inside the page and return its value. */
function pageEval(page: Page, expr: string): Promise<unknown> {
  return page.evaluate((e) => {
    // biome-ignore lint/security/noGlobalEval: QA-only driver, expression comes from the local step file
    return eval(e);
  }, expr);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(cfg.out, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const storageState = freshStateFor(cfg.email);
  const context: BrowserContext = await browser.newContext({
    viewport: { width: cfg.viewport[0], height: cfg.viewport[1] },
    deviceScaleFactor: 1,
    storageState,
    // --reduced emulates `prefers-reduced-motion: reduce`. Beyond auditing the
    // accessibility floor, it is the clean DISCRIMINATOR for animation work:
    // capture the same interaction with and without it, and only a real
    // transition changes its mid-frame between the two runs.
    reducedMotion: args.get("reduced") ? "reduce" : "no-preference",
  });
  const page = await context.newPage();

  const report: Report = { shots: [], failures: [], consoleErrors: [] };
  watchConsole(page, report.consoleErrors);

  console.log(
    `[qa-vis] ${cfg.email} @ ${cfg.viewport[0]}x${cfg.viewport[1]} -> ${cfg.base} (session: ${storageState ? "cached" : "fresh login"})`,
  );

  if (!storageState) {
    await login(page);
    await context.storageState({ path: statePath(cfg.email) });
  }

  const session: Session = { browser, context, page };

  for (const [i, step] of cfg.steps.entries()) {
    try {
      await runStep(session, step, report);
    } catch (e) {
      // Catch-and-continue is on purpose: a smoke run that aborts on step 3
      // reports one surface when you asked about six. The failure is recorded,
      // not swallowed — it decides the exit code below.
      const first = String(e).split("\n")[0];
      report.failures.push(`step ${i + 1} (${step.do}) threw: ${first}`);
      console.log(`  STEP FAILED (${step.do}): ${first}`);
      const failShot = resolve(cfg.out, `${cfg.tag}-FAIL-${i + 1}-${step.do}.png`);
      await session.page.screenshot({ path: failShot }).catch(() => {});
      console.log(`  fail shot -> ${failShot}`);
    }
  }

  const uniqueConsoleErrors = [...new Set(report.consoleErrors)];

  console.log(`\n=== CONSOLE ERRORS (${uniqueConsoleErrors.length}) ===`);
  for (const e of uniqueConsoleErrors.slice(0, 25)) console.log(`  ${e}`);

  console.log(`\n=== SHOTS (${report.shots.length}) ===`);
  for (const s of report.shots) console.log(`  ${s}`);

  const passed = report.failures.length === 0;

  console.log("\n=== RESULT ===");
  if (passed) {
    console.log(`  PASS — ${cfg.steps.length} step(s), 0 failures.`);
  } else {
    console.log(`  FAIL — ${report.failures.length} of ${cfg.steps.length} step(s):`);
    for (const f of report.failures) console.log(`  · ${f}`);
  }

  // Machine-readable index so a caller can pick the files up without parsing logs.
  writeFileSync(
    resolve(cfg.out, `${cfg.tag}-index.json`),
    JSON.stringify(
      {
        passed,
        failures: report.failures,
        shots: report.shots,
        consoleErrors: uniqueConsoleErrors,
      },
      null,
      2,
    ),
  );

  await browser.close();
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error("[qa-vis] fatal:", e);
  process.exit(1);
});
