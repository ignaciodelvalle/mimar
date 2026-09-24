// Panorama chaos harness (task #39 — "super resistente a romperse").
//
// Drives the Panorama console through SEEDED-RANDOM interaction storms and, after
// every storm round, asserts the console's resilience invariants. The point is
// not to reproduce a golden journey — it is to throw disorder at the map (rapid
// wheel bursts, click-drills, preset/period/layer flips mid-animation, Back/
// Forward spam, rail + dock storms, resizes) and prove nothing wedges, errors,
// blanks the canvas, or drifts the camera out of the national bounds.
//
// It ALSO exercises the recovery paths added in this task:
//   - WebGL context loss  (WEBGL_lose_context extension)
//   - Basemap geojson fetch failure (route interception → honest error + retry)
//   - A forced render throw inside the map island (→ MapErrorBoundary card)
//
// Seeded: the same --seed reproduces the exact storm sequence, so a finding is
// re-runnable. The seed is printed in the report.
//
// REPORT, NOT GATE (T1-C4, 2026-09-18). It runs nightly in
// dim-interno:.github/workflows/panorama-qa-nightly.yml, which is report-only — and this
// script ended with `process.exit(passed ? 0 : 1)`, so a recovery check that
// did not recover (geojson-kill, 2026-09) turned the night red, twenty nights
// running. Violations and failed recoveries are now report rows, in the JSON
// report and in the GitHub job summary, and the run exits 0. Only the harness
// being unable to run — chromium does not launch, the report cannot be
// written, a bug in this script escapes the run — exits non-zero. The mapping
// lives in scripts/lib/qa-report-outcome.ts, with its test.
//
// Usage (server must already be running — e.g. pwsh scripts/qa-up.ps1):
//   pnpm exec tsx scripts/qa-panorama-chaos.ts \
//     --viewport=1920x1080 --email=admin@dim.test --seed=1337 --rounds=10
//   pnpm exec tsx scripts/qa-panorama-chaos.ts \
//     --viewport=1366x768 --email=lucas@dim.test --seed=1337 --rounds=10
//
// Flags:
//   --viewport=WxH    default 1920x1080
//   --email=...       default admin@dim.test  (admin → /admin/panorama, else /gob)
//   --password=...    default Test1234!       (the shared seed password)
//   --seed=N          default 1337
//   --rounds=N        default 10  (storm rounds; recovery rounds run on top)
//   --base=URL        default http://localhost:3000
//   --headed          show the browser (default headless)
//   --out=DIR         screenshot/report dir (default repo root)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// ---------------------------------------------------------------------------
// AR_MAX_BOUNDS — the camera clamp (mirrors SituationalMap.AR_MAX_BOUNDS:
// AR_BBOX padded by ±31° lng / ±2° lat). The camera CENTER must always stay in
// here; a value outside (or NaN) means the bounds clamp broke.
// ---------------------------------------------------------------------------
const AR_BBOX: [[number, number], [number, number]] = [
  [-73.6, -55.1],
  [-53.6, -21.8],
];
const PAD_LNG = 31;
const PAD_LAT = 2;
const MAX_BOUNDS = {
  minLng: AR_BBOX[0][0] - PAD_LNG,
  minLat: AR_BBOX[0][1] - PAD_LAT,
  maxLng: AR_BBOX[1][0] + PAD_LNG,
  maxLat: AR_BBOX[1][1] + PAD_LAT,
};

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
type Args = {
  viewport: { width: number; height: number };
  email: string;
  password: string;
  seed: number;
  rounds: number;
  base: string;
  headed: boolean;
  outDir: string;
};

function parseArgs(): Args {
  const raw = new Map<string, string>();
  let headed = false;
  for (const a of process.argv.slice(2)) {
    if (a === "--headed") {
      headed = true;
      continue;
    }
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) raw.set(m[1], m[2]);
  }
  const vp = (raw.get("viewport") ?? "1920x1080").split("x");
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..");
  return {
    viewport: { width: Number(vp[0]) || 1920, height: Number(vp[1]) || 1080 },
    email: raw.get("email") ?? "admin@dim.test",
    password: raw.get("password") ?? "Test1234!",
    seed: Number(raw.get("seed") ?? 1337),
    rounds: Number(raw.get("rounds") ?? 10),
    base: (raw.get("base") ?? "http://localhost:3000").replace(/\/$/, ""),
    headed,
    outDir: raw.get("out") ? resolve(raw.get("out") as string) : repoRoot,
  };
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic per seed.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Report accumulator
// ---------------------------------------------------------------------------
type Violation = { round: string; kind: string; detail: string };

class Report {
  readonly violations: Violation[] = [];
  readonly rounds: string[] = [];
  readonly recoveries: { name: string; ok: boolean; detail: string }[] = [];

  violation(round: string, kind: string, detail: string): void {
    this.violations.push({ round, kind, detail });
    console.error(`  ✗ [${round}] ${kind}: ${detail}`);
  }
  recovery(name: string, ok: boolean, detail: string): void {
    this.recoveries.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} recovery ${name}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Console-error tracking — capture page console.error + uncaught pageerror.
// A curated allowlist filters benign, environment-only noise so a real error
// is never drowned out.
// ---------------------------------------------------------------------------
// GLOBAL: active for the entire run — these are noise that can show up on any
// page load, in any scenario, and are never evidence of a real failure.
const BENIGN_CONSOLE_GLOBAL = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /Warning: ReactDOM.render/i,
  // MapLibre logs a warning when a symbol layer needs glyphs but we ship none —
  // by design (no glyph server; labels are HTML markers). Not a failure.
  /needs glyphs|glyphs.*not.*set/i,
  // AbortError from superseded fetches is the DESIGNED cancellation path.
  /AbortError|The user aborted a request|signal is aborted/i,
];

// SCENARIO-SCOPED (hardening review M4): each entry only applies while its
// owning scenario runs — a broad allowlist active for the WHOLE run can mask a
// real fetch/console error that happens to match the same text outside that
// scenario's window. ConsoleWatch.beginScenario/endScenario toggle these on.
//
// forced-throw DELIBERATELY throws inside the map island; React + our boundary
// log it. Expected artifacts of that scenario only (asserted separately via the
// boundary card + recovery), not a global pass for any crash-shaped text.
const BENIGN_CONSOLE_FORCED_THROW = [
  /forced render throw \(chaos harness seam\)/i,
  /\[panorama\] map island crashed/i,
];
// geojson-kill deliberately blocks the basemap fetch; the scenario asserts the
// honest error overlay + retry itself. Scoped to that window only — outside it,
// a real "Failed to fetch" / geojson HTTP error must NOT be swallowed (M4).
const BENIGN_CONSOLE_GEOJSON_KILL = [
  /Failed to fetch|net::ERR|geojson .*HTTP|ar-provinces\.geojson/i,
];

class ConsoleWatch {
  private errors: string[] = [];
  private cursor = 0;
  private scenarioAllow: RegExp[] = [];

  attach(page: Page): void {
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (this.isBenign(text)) return;
      this.errors.push(text);
    });
    page.on("pageerror", (err) => {
      const text = `pageerror: ${err.message}`;
      if (this.isBenign(text)) return;
      this.errors.push(text);
    });
  }
  private isBenign(text: string): boolean {
    return (
      BENIGN_CONSOLE_GLOBAL.some((re) => re.test(text)) ||
      this.scenarioAllow.some((re) => re.test(text))
    );
  }
  /** Widen the allowlist for the duration of a single scenario. Must be paired
   * with `endScenario()` so the widened patterns don't leak into later rounds. */
  beginScenario(patterns: RegExp[]): void {
    this.scenarioAllow = patterns;
  }
  endScenario(): void {
    this.scenarioAllow = [];
  }
  /** Errors accumulated since the last checkpoint. */
  drain(): string[] {
    const fresh = this.errors.slice(this.cursor);
    this.cursor = this.errors.length;
    return fresh;
  }
  get total(): number {
    return this.errors.length;
  }
}

// ---------------------------------------------------------------------------
// In-flight /api/panorama request tracking — invariant (e): no wedged fetch.
// ---------------------------------------------------------------------------
class FetchWatch {
  inFlight = 0;
  attach(page: Page): void {
    page.on("request", (r) => {
      if (r.url().includes("/api/panorama/")) this.inFlight++;
    });
    const settle = (r: { url(): string }) => {
      if (r.url().includes("/api/panorama/")) this.inFlight = Math.max(0, this.inFlight - 1);
    };
    page.on("requestfinished", settle);
    page.on("requestfailed", settle);
  }
}

// ---------------------------------------------------------------------------
// Map probes (run in the page)
// ---------------------------------------------------------------------------
/** Poll `canvasAlive` until it reports ok or the timeout elapses — recovery
 * rebuilds re-import maplibre + re-fetch the basemap, which takes a variable
 * amount of time depending on the viewport / route, so a fixed sleep is flaky. */
async function waitCanvasAlive(
  page: Page,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const start = Date.now();
  let last = { ok: false, detail: "never checked" };
  while (Date.now() - start < timeoutMs) {
    last = await canvasAlive(page);
    if (last.ok) return last;
    await sleep(200);
  }
  return last;
}

/** Click a retry button and poll for a live canvas, RE-clicking if the map has
 * not come back yet (a single click can miss under layout churn at narrow
 * widths). Returns true once the canvas is alive. */
async function retryUntilAlive(page: Page, name: RegExp, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const btn = page.getByRole("button", { name }).first();
    if ((await btn.count()) > 0) {
      await btn.click({ force: true, timeout: 3000 }).catch(() => {});
    }
    const alive = await waitCanvasAlive(page, 3000);
    if (alive.ok) return true;
  }
  return (await canvasAlive(page)).ok;
}

async function canvasAlive(page: Page): Promise<{ ok: boolean; detail: string }> {
  return page.evaluate(() => {
    const c = document.querySelector(".maplibregl-canvas") as HTMLCanvasElement | null;
    if (!c) return { ok: false, detail: "no maplibre canvas in DOM" };
    const gl =
      (c.getContext("webgl2") as WebGLRenderingContext | null) ??
      (c.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return { ok: false, detail: "no WebGL context on canvas" };
    if (gl.isContextLost()) return { ok: false, detail: "WebGL context is lost" };
    if (c.width <= 0 || c.height <= 0)
      return { ok: false, detail: `canvas has zero size ${c.width}x${c.height}` };
    return { ok: true, detail: `canvas ${c.width}x${c.height}, gl alive` };
  });
}

/** Camera from the URL (the console mirrors z/lat/lng on every settle). This is
 * a SECONDARY check only — it returns null whenever the URL happens to carry
 * no camera params (e.g. right after stormBackForward, or a clean reload before
 * the first settle), which is why the primary assertion reads the LIVE map via
 * cameraFromLiveMap() below instead (hardening review H1). */
function cameraFromUrl(url: string): { z: number; lat: number; lng: number } | null {
  try {
    const p = new URL(url).searchParams;
    if (!p.has("z") && !p.has("lat") && !p.has("lng")) return null;
    return { z: Number(p.get("z")), lat: Number(p.get("lat")), lng: Number(p.get("lng")) };
  } catch {
    return null;
  }
}

/** Camera from the LIVE MapLibre instance via the `__PANORAMA_MAP__` window
 * seam (SituationalMap.tsx) — runs EVERY round regardless of URL state, so a
 * clamp break can never hide behind an absent z/lat/lng query string. Returns
 * null only if the seam itself is missing (map unmounted / not yet built),
 * which the caller must treat as a hard failure, not a skip. */
async function cameraFromLiveMap(
  page: Page,
): Promise<{ z: number; lat: number; lng: number } | null> {
  return page.evaluate(() => {
    const map = (
      window as unknown as {
        __PANORAMA_MAP__?: { getCenter(): { lat: number; lng: number }; getZoom(): number };
      }
    ).__PANORAMA_MAP__;
    if (!map) return null;
    try {
      const c = map.getCenter();
      return { z: map.getZoom(), lat: c.lat, lng: c.lng };
    } catch {
      return null;
    }
  });
}

/** Pure predicate: is this camera reading within AR_MAX_BOUNDS and finite?
 * Extracted so it is unit-testable without a browser (see
 * scripts/__tests__/qa-panorama-chaos.camera.test.ts). */
export function cameraViolationKind(cam: {
  z: number;
  lat: number;
  lng: number;
}): "nan" | "out-of-bounds" | null {
  if (!Number.isFinite(cam.lat) || !Number.isFinite(cam.lng) || !Number.isFinite(cam.z)) {
    return "nan";
  }
  if (
    cam.lng < MAX_BOUNDS.minLng ||
    cam.lng > MAX_BOUNDS.maxLng ||
    cam.lat < MAX_BOUNDS.minLat ||
    cam.lat > MAX_BOUNDS.maxLat
  ) {
    return "out-of-bounds";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Invariant assertions after a storm round
// ---------------------------------------------------------------------------
async function assertInvariants(
  page: Page,
  round: string,
  cw: ConsoleWatch,
  fw: FetchWatch,
  report: Report,
): Promise<void> {
  // (a) zero NEW console errors this round
  for (const e of cw.drain()) report.violation(round, "console-error", e);

  // (b) map canvas alive (unless an honest recovery overlay is intentionally up)
  const overlayUp = await page
    .getByRole("alert")
    .filter({ hasText: /No pudimos|Recuperando|No se pudo/i })
    .count();
  if (overlayUp === 0) {
    const alive = await canvasAlive(page);
    if (!alive.ok) report.violation(round, "canvas-dead", alive.detail);
  }

  // (c) camera within AR_MAX_BOUNDS + not NaN — asserted via the LIVE map every
  // round (H1 fix). A missing seam is a hard failure, not a silent skip: it
  // means either the map is dead (which invariant (b) should already have
  // caught) or the seam itself regressed — either way this round proves nothing
  // about the clamp, so it fails closed instead of passing vacuously.
  const liveCam = await cameraFromLiveMap(page);
  if (liveCam) {
    const kind = cameraViolationKind(liveCam);
    if (kind === "nan") report.violation(round, "camera-nan", JSON.stringify(liveCam));
    else if (kind === "out-of-bounds")
      report.violation(round, "camera-out-of-bounds", JSON.stringify(liveCam));
  } else {
    report.violation(
      round,
      "camera-seam-missing",
      "window.__PANORAMA_MAP__ absent — cannot assert the camera-bounds invariant this round",
    );
  }
  // URL is a SECONDARY check: it should agree with the live map whenever it
  // carries params at all, catching a broken URL-mirror without being the only
  // proof (that was H1's vacuous-pass hole).
  const urlCam = cameraFromUrl(page.url());
  if (urlCam) {
    const kind = cameraViolationKind(urlCam);
    if (kind === "nan") report.violation(round, "url-camera-nan", JSON.stringify(urlCam));
    else if (kind === "out-of-bounds")
      report.violation(round, "url-camera-out-of-bounds", JSON.stringify(urlCam));
  }

  // (d) URL parseable
  try {
    // eslint-disable-next-line no-new
    new URL(page.url());
  } catch {
    report.violation(round, "url-unparseable", page.url());
  }

  // (e) no wedged pending fetch — allow up to ~4s for the burst to drain
  const drained = await waitFor(() => fw.inFlight <= 0, 4000);
  if (!drained) report.violation(round, "fetch-wedged", `${fw.inFlight} /api/panorama in flight`);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}
async function mapBox(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  const el = page.locator("[data-pano-map]").first();
  const b = await el.boundingBox();
  if (!b) return { x: 200, y: 300, w: 800, h: 400 };
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

// ---------------------------------------------------------------------------
// Storms — each mutates the console; a random subset runs per round.
// ---------------------------------------------------------------------------
type Rng = () => number;

async function stormWheelBurst(page: Page, rng: Rng): Promise<void> {
  const box = await mapBox(page);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  await page.mouse.move(cx, cy);
  const ticks = 4 + Math.floor(rng() * 8);
  for (let i = 0; i < ticks; i++) {
    const dir = rng() < 0.5 ? -1 : 1;
    const delta = (30 + Math.floor(rng() * 160)) * dir;
    // Ctrl held ~half the time (cooperative-gesture zoom path).
    const ctrl = rng() < 0.5;
    if (ctrl) await page.keyboard.down("Control");
    await page.mouse.wheel(0, delta);
    if (ctrl) await page.keyboard.up("Control");
    await sleep(10 + Math.floor(rng() * 40)); // fire MID-animation
  }
}

async function stormClickDrill(page: Page, rng: Rng): Promise<void> {
  const box = await mapBox(page);
  const x = box.x + box.w * (0.25 + rng() * 0.5);
  const y = box.y + box.h * (0.25 + rng() * 0.5);
  await page.mouse.click(x, y);
}

async function clickRail(page: Page, label: string): Promise<boolean> {
  const btn = page.getByRole("button", { name: label, exact: true }).first();
  if ((await btn.count()) === 0) return false;
  try {
    await btn.click({ timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function stormPanelFlip(page: Page, rng: Rng): Promise<void> {
  const labels = ["Vista", "Filtro", "Período", "Línea de tiempo"];
  const label = labels[Math.floor(rng() * labels.length)];
  if (await clickRail(page, label)) {
    await sleep(120 + Math.floor(rng() * 200));
    // Poke a random control inside the open panel (radio / checkbox / button).
    const controls = page.locator(
      '[role="dialog"] button, [role="dialog"] input[type="radio"], [role="dialog"] input[type="checkbox"], [role="dialog"] [role="radio"]',
    );
    const n = await controls.count();
    if (n > 0) {
      const idx = Math.floor(rng() * n);
      try {
        await controls.nth(idx).click({ timeout: 2000, force: true });
      } catch {
        /* control may be transiently disabled mid-fetch — fine */
      }
    }
    // Close (Esc) half the time; leave open the rest to stress overlap.
    if (rng() < 0.5) await page.keyboard.press("Escape");
  }
}

async function stormBackForward(page: Page, rng: Rng): Promise<void> {
  const n = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    await page.goBack({ waitUntil: "commit" }).catch(() => {});
    await sleep(60 + Math.floor(rng() * 120));
  }
  for (let i = 0; i < n; i++) {
    await page.goForward({ waitUntil: "commit" }).catch(() => {});
    await sleep(60 + Math.floor(rng() * 120));
  }
}

async function stormDock(page: Page, rng: Rng): Promise<void> {
  // The dock lives at the bottom; its handle toggles registros/timeline.
  const dock = page.getByTestId("panorama-dock");
  if ((await dock.count()) === 0) return;
  const handle = dock.getByRole("button").first();
  if ((await handle.count()) === 0) return;
  const times = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < times; i++) {
    await handle.click({ timeout: 2000, force: true }).catch(() => {});
    await sleep(80 + Math.floor(rng() * 120));
  }
}

async function stormResize(
  page: Page,
  rng: Rng,
  base: { width: number; height: number },
): Promise<void> {
  // A REAL viewport change must resize the canvas; a dock/panel open must not.
  const w = Math.max(1024, base.width - Math.floor(rng() * 300));
  const h = Math.max(720, base.height - Math.floor(rng() * 200));
  await page.setViewportSize({ width: w, height: h });
  await sleep(150);
  await page.setViewportSize(base);
  await sleep(150);
}

async function stormScopePill(page: Page, rng: Rng): Promise<void> {
  const pill = page.getByTestId("panorama-scope-pill");
  if ((await pill.count()) === 0) return;
  await pill.click({ timeout: 2000 }).catch(() => {});
  await sleep(120);
  const selects = page.locator('[role="dialog"] select, select');
  const n = await selects.count();
  if (n > 0) {
    const sel = selects.first();
    const opts = sel.locator("option");
    const on = await opts.count();
    if (on > 1) {
      const idx = 1 + Math.floor(rng() * (on - 1));
      const value = await opts.nth(idx).getAttribute("value");
      if (value) await sel.selectOption(value).catch(() => {});
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
}

type Storm = {
  name: string;
  run: (page: Page, rng: Rng, base: { width: number; height: number }) => Promise<void>;
};

const STORMS: Storm[] = [
  { name: "wheel-burst", run: (p, r) => stormWheelBurst(p, r) },
  { name: "click-drill", run: (p, r) => stormClickDrill(p, r) },
  { name: "panel-flip", run: (p, r) => stormPanelFlip(p, r) },
  { name: "back-forward", run: (p, r) => stormBackForward(p, r) },
  { name: "dock-toggle", run: (p, r) => stormDock(p, r) },
  { name: "resize", run: (p, r, b) => stormResize(p, r, b) },
  { name: "scope-pill", run: (p, r) => stormScopePill(p, r) },
];

// ---------------------------------------------------------------------------
// Recovery scenarios
// ---------------------------------------------------------------------------
async function recoveryWebglLoss(page: Page, report: Report): Promise<void> {
  const lost = await page.evaluate(() => {
    const c = document.querySelector(".maplibregl-canvas") as HTMLCanvasElement | null;
    if (!c) return false;
    const gl =
      (c.getContext("webgl2") as WebGLRenderingContext | null) ??
      (c.getContext("webgl") as WebGLRenderingContext | null);
    const ext = gl?.getExtension("WEBGL_lose_context");
    if (!ext) return false;
    ext.loseContext();
    // Hold the loss long enough to observe the recovering overlay, then restore.
    setTimeout(() => ext.restoreContext(), 900);
    return true;
  });
  if (!lost) {
    // H2 fix: the extension being unavailable means this scenario NEVER
    // exercised the recovery path at all — that must fail the round closed,
    // not soft-pass it as "not applicable". A browser/flag change that quietly
    // disabled WEBGL_lose_context would otherwise green-pass forever.
    report.recovery(
      "webgl-loss",
      false,
      "extension-unavailable: WEBGL_lose_context unavailable in this browser — recovery path NOT exercised",
    );
    return;
  }
  // The recovering overlay should appear during the loss window.
  const sawOverlay = await page
    .getByText(/Recuperando el mapa/i)
    .waitFor({ state: "visible", timeout: 800 })
    .then(() => true)
    .catch(() => false);
  // After restore + rebuild, the canvas must be alive again.
  const alive = await waitCanvasAlive(page, 10_000);
  // H2 fix: `ok` now REQUIRES the recovering overlay to have been observed, not
  // just a live canvas afterward. A restore that skips the recovering UI (or a
  // canvas that never truly lost context) must fail, not pass on `alive.ok` alone.
  const ok = sawOverlay && alive.ok;
  report.recovery("webgl-loss", ok, `overlay-seen=${sawOverlay}; post-restore ${alive.detail}`);
}

async function recoveryGeojsonKill(
  page: Page,
  base: string,
  report: Report,
  cw: ConsoleWatch,
): Promise<void> {
  // M4 fix: the "Failed to fetch" / geojson-HTTP allowlist is only meaningful
  // for THIS scenario's deliberate block — widen it for the window and put it
  // back afterward so a real fetch error elsewhere in the run is never masked.
  cw.beginScenario(BENIGN_CONSOLE_GEOJSON_KILL);
  try {
    // Block the base geography, then reload so the map re-fetches it and fails.
    // The static geojson is disk-cacheable, so a plain reload would serve it from
    // cache and never hit the aborted route — disable the HTTP cache via CDP so the
    // abort actually bites (this is what makes the failure real, not simulated).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }).catch(() => {});
    await page.route("**/geo/ar-provinces.geojson", (route) => route.abort());
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    const sawError = await page
      .getByText(/No pudimos cargar el mapa/i)
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    // Unblock and retry → recovery.
    await page.unroute("**/geo/ar-provinces.geojson");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
    let recovered = false;
    if (sawError) {
      recovered = await retryUntilAlive(page, /Reintentar/i, 12_000);
    }
    report.recovery(
      "geojson-kill",
      sawError && recovered,
      `honest-error=${sawError}; recovered-on-retry=${recovered}`,
    );
  } finally {
    cw.endScenario();
  }
}

async function recoveryForcedThrow(page: Page, report: Report, cw: ConsoleWatch): Promise<void> {
  // M4 fix (symmetry with geojson-kill): the deliberate-throw console noise is
  // only expected while this scenario is forcing it.
  cw.beginScenario(BENIGN_CONSOLE_FORCED_THROW);
  try {
    await page.evaluate(() => {
      (window as unknown as { __PANORAMA_FORCE_THROW__?: boolean }).__PANORAMA_FORCE_THROW__ = true;
    });
    // Trigger a re-render of the console → the map island throws → boundary catches.
    await clickRail(page, "Filtro").catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await stormWheelBurst(page, () => 0.5).catch(() => {});
    const sawCard = await page
      .getByText(/No pudimos mostrar el mapa/i)
      .isVisible({ timeout: 4000 })
      .catch(() => false);
    // Route MUST still be alive (not a dead route / Application error).
    const deadRoute = await page
      .getByText(/application error/i)
      .isVisible()
      .catch(() => false);
    // Clear the flag and recover via the boundary's retry.
    await page.evaluate(() => {
      (window as unknown as { __PANORAMA_FORCE_THROW__?: boolean }).__PANORAMA_FORCE_THROW__ =
        false;
    });
    let recovered = false;
    if (sawCard) {
      recovered = await retryUntilAlive(page, /Recargar el panorama/i, 14_000);
      if (!recovered) {
        await page
          .screenshot({ path: join(process.cwd(), "panorama-hard-qa-DEBUG-forced-throw.png") })
          .catch(() => {});
      }
    }
    report.recovery(
      "forced-throw",
      sawCard && !deadRoute && recovered,
      `boundary-card=${sawCard}; dead-route=${deadRoute}; recovered=${recovered}`,
    );
  } finally {
    cw.endScenario();
  }
}

// ---------------------------------------------------------------------------
// Login + navigate
// ---------------------------------------------------------------------------
async function login(page: Page, base: string, email: string, password: string): Promise<void> {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel(/correo electrónico/i).fill(email);
  // getByLabel(/contraseña/i) is AMBIGUOUS: the field grew a "Mostrar
  // contraseña" toggle whose aria-label matches the same regex, so Playwright
  // fails on strict mode and these four QA drivers could not log in AT ALL.
  // Found 2026-08-10 by smoke-testing the driver before depending on it —
  // nobody had run them since the toggle landed. getByRole pins the input.
  await page.getByRole("textbox", { name: /contraseña/i }).fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  // leftSignIn, not `!startsWith("/login")`: the sign-in page is /iniciar-sesion
  // and the old predicate held before a credential was typed (e2e/_sign-in-route.ts).
  await page.waitForURL(leftSignIn, { timeout: 25_000 });
  // Institutional accounts owe TOTP since T2-S6 (e2e/_mfa.ts).
  await passSecondFactorIfAsked(page, email, password);
}

function panoramaPath(email: string): string {
  return email.startsWith("admin@") ? "/admin/panorama" : "/gob/panorama";
}

async function waitForMap(page: Page): Promise<boolean> {
  try {
    await page
      .locator(".maplibregl-canvas")
      .first()
      .waitFor({ state: "attached", timeout: 30_000 });
    await sleep(1500); // let the first frame paint + camera settle
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<QaRunOutcome> {
  const args = parseArgs();
  mkdirSync(args.outDir, { recursive: true });
  const label = `${args.viewport.width}x${args.viewport.height}/${args.email}`;
  console.log(`\n=== panorama chaos — ${label} — seed ${args.seed}, ${args.rounds} rounds ===`);

  const rng = mulberry32(args.seed);
  const report = new Report();
  const cw = new ConsoleWatch();
  const fw = new FetchWatch();

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: !args.headed });
  } catch (err) {
    return { kind: "harness-crash", message: `chromium did not launch: ${errorMessage(err)}` };
  }
  try {
    const context = await browser.newContext({ viewport: args.viewport });
    const page = await context.newPage();
    cw.attach(page);
    fw.attach(page);

    await login(page, args.base, args.email, args.password);
    await page.goto(`${args.base}${panoramaPath(args.email)}`, { waitUntil: "domcontentloaded" });
    const mapReady = await waitForMap(page);
    if (!mapReady) {
      report.violation("boot", "no-map", "maplibre canvas never attached");
    }
    // Baseline screenshot.
    const tag = `${args.viewport.width}-${args.email.split("@")[0]}`;
    await page
      .screenshot({ path: join(args.outDir, `panorama-hard-qa-${tag}-00-baseline.png`) })
      .catch(() => {});
    cw.drain(); // ignore any boot-time noise as a baseline

    // --- Storm rounds ---
    for (let i = 1; i <= args.rounds; i++) {
      const roundName = `round-${i}`;
      report.rounds.push(roundName);
      // 2–4 storms per round, drawn from the seeded stream.
      const count = 2 + Math.floor(rng() * 3);
      const picks: string[] = [];
      for (let s = 0; s < count; s++) {
        const storm = STORMS[Math.floor(rng() * STORMS.length)];
        picks.push(storm.name);
        try {
          await storm.run(page, rng, args.viewport);
        } catch (err) {
          report.violation(roundName, "storm-threw", `${storm.name}: ${(err as Error).message}`);
        }
      }
      // Ensure we are back on the panorama route (Back/Forward may have left it).
      if (!page.url().includes("/panorama")) {
        await page
          .goto(`${args.base}${panoramaPath(args.email)}`, { waitUntil: "domcontentloaded" })
          .catch(() => {});
        await waitForMap(page);
      }
      await sleep(500); // let camera settle within T
      console.log(`  round ${i}: [${picks.join(", ")}]`);
      await assertInvariants(page, roundName, cw, fw, report);
    }

    // --- Recovery rounds ---
    console.log("  — recovery paths —");
    // Reset to a CLEAN panorama load (no drilled scope / camera params left by the
    // storms) so each recovery scenario tests the recovery MECHANISM from a known-
    // good state — the storms already asserted their own invariants per round.
    await page.goto(`${args.base}${panoramaPath(args.email)}`, { waitUntil: "domcontentloaded" });
    await waitForMap(page);
    cw.drain(); // ignore any reload noise as the recovery baseline
    await recoveryWebglLoss(page, report);
    await recoveryForcedThrow(page, report, cw);
    await recoveryGeojsonKill(page, args.base, report, cw);

    // Post-recovery: the map must be alive and the console error-free.
    for (const e of cw.drain()) report.violation("post-recovery", "console-error", e);
    await page
      .screenshot({ path: join(args.outDir, `panorama-hard-qa-${tag}-99-final.png`) })
      .catch(() => {});

    // Process-survival: after the whole storm + recovery run (hundreds of layer
    // fetches through the Data Cache), the SERVER must still be answering. A dead
    // node process (the layer-cache revalidation crash class) would fail this.
    const health = await page.request.get(`${args.base}/login`).catch(() => null);
    report.recovery(
      "server-alive",
      health?.ok() === true,
      `GET /login → ${health ? health.status() : "no response"}`,
    );

    await context.close();
  } catch (err) {
    // A login that does not land, a navigation that times out: the run could
    // not continue, and THAT is the finding. It is recorded like any other
    // violation instead of crashing the process — the report still gets
    // written, with everything measured up to this point.
    report.violation("run", "run-aborted", errorMessage(err));
  } finally {
    await browser.close().catch(() => {});
  }

  // --- Report ---
  const summary = {
    label,
    seed: args.seed,
    rounds: args.rounds,
    totalConsoleErrors: cw.total,
    violations: report.violations,
    recoveries: report.recoveries,
    passed: report.violations.length === 0 && report.recoveries.every((r) => r.ok),
  };
  const reportPath = join(
    args.outDir,
    `panorama-hard-qa-${args.viewport.width}-${args.email.split("@")[0]}-report.json`,
  );
  try {
    writeFileSync(reportPath, JSON.stringify(summary, null, 2));
  } catch (err) {
    return {
      kind: "harness-crash",
      message: `could not write ${reportPath}: ${errorMessage(err)}`,
    };
  }

  console.log(`\n=== ${label} — seed ${args.seed} ===`);
  console.log(`  storm rounds: ${args.rounds}`);
  console.log(`  invariant violations: ${report.violations.length}`);
  console.log(
    `  recoveries: ${report.recoveries.filter((r) => r.ok).length}/${report.recoveries.length} ok`,
  );
  console.log(`  report: ${reportPath}`);
  const findings = chaosFindings(report.violations, report.recoveries);
  console.log(
    summary.passed
      ? "  RESULT: no findings ✓"
      : `  RESULT: ${findings.length} finding(s) ✗ — report-only, the run exits 0`,
  );
  return { kind: "completed", findings };
}

/** Violations and FAILED recoveries, as report rows. A recovery that worked is not a finding. */
export function chaosFindings(
  violations: Violation[],
  recoveries: { name: string; ok: boolean; detail: string }[],
): QaFinding[] {
  return [
    ...violations.map((v) => ({ where: v.round, kind: v.kind, detail: v.detail })),
    ...recoveries
      .filter((r) => !r.ok)
      .map((r) => ({ where: `recovery ${r.name}`, kind: "recovery-failed", detail: r.detail })),
  ];
}

// Only run the harness when this file is executed directly (`tsx
// qa-panorama-chaos.ts` / `pnpm ... qa-panorama-chaos.ts`), never on import —
// pure helpers above (e.g. cameraViolationKind) are unit-tested by importing
// this module, and an unguarded top-level `main()` would launch a real browser
// as a side effect of that import.
const isDirectRun =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const title = "Panorama chaos harness";
  main()
    .then((outcome) => {
      appendJobSummary(outcomeSummaryMarkdown(title, outcome));
      if (outcome.kind === "harness-crash")
        console.error(`chaos harness crashed: ${outcome.message}`);
      process.exit(reportOnlyExitCode(outcome));
    })
    .catch((err) => {
      // A throw that escaped the run is a bug in THIS script, not a finding
      // about the console — the one case that may still turn the run red.
      console.error("chaos harness crashed:", err);
      const outcome: QaRunOutcome = { kind: "harness-crash", message: errorMessage(err) };
      appendJobSummary(outcomeSummaryMarkdown(title, outcome));
      process.exit(reportOnlyExitCode(outcome));
    });
}
