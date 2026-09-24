#!/usr/bin/env tsx
// Node version fence — `pnpm lint:node-version`.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The repo pins ONE Node version in three places that nothing compared:
// `.nvmrc`, `.node-version`, and the `node-version:` of every `setup-node` step
// in `.github/workflows/`. `package.json`'s `engines.node` was a fourth voice
// and it disagreed with all of them: `">=22.13.0"` is an OPEN range, so the
// manifest declared that Node 25, 26 and everything after were supported.
//
// It was wrong at BOTH ends at once, in opposite directions, so the only Node
// that actually worked was the one no file named. CI never noticed because
// `node-version: "22"` floats to the latest 22.x — inside the true range by
// luck rather than by declaration.
//
// FOUR CONSTRAINTS, MEASURED 2026-08-29 ON THIS REPO
// ---------------------------------------------------------------------------
//   version   registerHooks  features.typescript  localStorage  cp1252 0x97
//   22.13.0   undefined      false                undefined     U+0097
//   22.15.0   function       false                undefined     U+0097
//   22.17.1   function       false                undefined     U+0097
//   22.18.0   function       "strip"              undefined     U+0097
//   22.22.0   function       "strip"              undefined     U+0097
//   22.23.0   function       "strip"              undefined     U+2014
//   25.8.1    function       "strip"              DEFINED       U+2014
//
//   · `registerHooks` (>= 22.15.0) — `scripts/register-server-only-stub.mjs`
//     imports it from `node:module`. Below that every script behind the loader
//     (`seed:test`, `seed:panorama`, `cube:refresh`, `rebuild:projections`, …)
//     dies on import with "does not provide an export named 'registerHooks'".
//   · Type stripping (>= 22.18.0) — `@dim/contract` ships raw `.ts` through its
//     `exports` map with no build step, so `expo config --type public` (and
//     therefore `verify:mobile`) can only read it where Node strips types.
//     Measured: 22.17.1 → exit 1 "Unexpected identifier 'DeepLinkAccess'";
//     22.18.0 → exit 0.
//   · WHATWG windows-1252 (>= 22.23.0, i.e. ICU 78) — below it
//     `new TextDecoder("windows-1252")` decodes 0x97 to U+0097 instead of the
//     em dash, and `__tests__/_helpers/pdf-text.ts` reads the fiscalía PDF
//     through that decoder. NOTE: this one is a TEST FRAGILITY, not a product
//     requirement — that helper should carry its own 0x80-0x9F table instead of
//     trusting the platform. Fix it and the floor can drop to 22.18.0.
//   · No built-in Web Storage (< 23) — Node 25's `localStorage` shadows jsdom's
//     and, without a valid `--localstorage-file`, has no `.clear()`. Every
//     suite that resets storage between tests dies: 5 failures become 139.
//
// So the supported range is the intersection: `>=22.23.0 <23`.
//
// FLOOR vs PIN. They are different things and this fence treats them so. The
// floor is the hard minimum above; the pin (`.nvmrc`) is the version everyone
// installs, and it tracks what CI's `node-version: "22"` actually resolves to.
// The rule is `floor <= pin < ceiling`, not `floor == pin`.
//
// A tool that asserts something false about itself is the exact class of defect
// this repo's fences exist to catch, so the range is now closed and this fence
// keeps the four declarations agreeing.
//
// WHAT IT CHECKS
//   1. `.nvmrc` and `.node-version` pin the same exact version.
//   2. `engines.node` is a CLOSED range of the shape `>=<pin> <<major+1>` — the
//      pin is its floor, and its ceiling admits only that major line.
//   3. Every `node-version:` in `.github/workflows/*.yml` is that same major.
//   4. The Node actually running satisfies the range, with the fix in the
//      message rather than left as an exercise.
//
// Check 4 is the one a developer hits, and it is deliberately the LAST one: a
// wrong local Node should not hide a broken manifest.
//
// Run:  pnpm tsx scripts/check-node-version.ts   (or: pnpm lint:node-version)
// Exits 0 when all four agree. Exits 1 naming every disagreement, not just the
// first — a version bump touches all of them and one round-trip per file is a
// bad trade.

import { globSync, readFileSync } from "node:fs";

export const NVMRC = ".nvmrc";
export const NODE_VERSION_FILE = ".node-version";
export const PACKAGE_JSON = "package.json";
export const WORKFLOW_GLOB = ".github/workflows/*.yml";

/**
 * The only `engines.node` shape this fence accepts: an exact-patch floor and a
 * ceiling at a major. Anything else — an open range, a caret, a disjunction —
 * is reported rather than parsed, because a shape this fence cannot read is a
 * shape it cannot police.
 */
const CLOSED_RANGE = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/;

/** `22.13.0` and nothing else: these files pin, they do not express ranges. */
const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export interface VersionParts {
  major: number;
  minor: number;
  patch: number;
}

export function parseExact(raw: string): VersionParts | null {
  const m = EXACT_VERSION.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 / 0 / 1, comparing major then minor then patch. */
export function compare(a: VersionParts, b: VersionParts): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export interface ClosedRange {
  floor: VersionParts;
  ceilingMajor: number;
}

export function parseClosedRange(raw: string): ClosedRange | null {
  const m = CLOSED_RANGE.exec(raw.trim());
  if (!m) return null;
  return {
    floor: { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) },
    ceilingMajor: Number(m[4]),
  };
}

export function satisfies(version: VersionParts, range: ClosedRange): boolean {
  return compare(version, range.floor) >= 0 && version.major < range.ceilingMajor;
}

/**
 * Every `node-version:` a workflow declares, with its file and line. Comment
 * lines are stripped first, for the same reason `check-ci-lint-parity` strips
 * them: a version named only in prose must not count as a declaration.
 */
export function workflowNodeVersions(
  files: { path: string; yaml: string }[],
): { path: string; line: number; value: string }[] {
  const found: { path: string; line: number; value: string }[] = [];
  for (const { path, yaml } of files) {
    yaml.split("\n").forEach((rawLine, index) => {
      const line = rawLine.replace(/#.*$/, "");
      const m = /node-version:\s*["']?([^"'\s]+)["']?/.exec(line);
      if (m) found.push({ path, line: index + 1, value: m[1] });
    });
  }
  return found;
}

/** ── 1. The two pin files must name the same exact version. ───────────────── */
function checkPinFiles(nvmrcRaw: string, nodeVersionRaw: string, pin: VersionParts | null) {
  const problems: string[] = [];
  if (!pin) {
    problems.push(
      [
        `${NVMRC} reads "${nvmrcRaw}", which is not an exact MAJOR.MINOR.PATCH version.`,
        "    This file pins; it does not express a range.",
      ].join("\n"),
    );
  }
  if (nodeVersionRaw !== nvmrcRaw) {
    problems.push(
      [
        `${NVMRC} pins ${nvmrcRaw} but ${NODE_VERSION_FILE} pins ${nodeVersionRaw}.`,
        "    Different tools read different files; they must name the same version.",
      ].join("\n"),
    );
  }
  return problems;
}

/** ── 2. engines.node must be a closed range CONTAINING the pin. ──────────── */
function checkEngines(enginesRaw: string | undefined, pin: VersionParts | null, nvmrcRaw: string) {
  const problems: string[] = [];
  if (!enginesRaw) {
    problems.push(
      [
        `${PACKAGE_JSON} declares no engines.node.`,
        "    Without it the manifest says nothing about which Node works, and",
        "    `pnpm install` cannot warn anybody.",
      ].join("\n"),
    );
    return { problems, range: null };
  }

  const range = parseClosedRange(enginesRaw);
  if (!range) {
    problems.push(
      [
        `${PACKAGE_JSON} engines.node is "${enginesRaw}", not a closed \`>=X.Y.Z <M\` range.`,
        "    An open range claims support for every future major. That claim was",
        "    false for Node 25 and cost a whole gate's worth of misread red.",
      ].join("\n"),
    );
    return { problems, range: null };
  }

  // The floor may sit BELOW the pin — they answer different questions ("the
  // oldest Node that works" vs "the Node everyone installs"). What is never
  // allowed is a pin the manifest itself would reject.
  if (pin && compare(range.floor, pin) > 0) {
    const floor = `${range.floor.major}.${range.floor.minor}.${range.floor.patch}`;
    problems.push(
      [
        `${PACKAGE_JSON} engines.node floors at ${floor}, above the ${nvmrcRaw} that ${NVMRC} pins.`,
        "    The pin must satisfy the range it ships with — otherwise the repo tells",
        "    you to install a version its own manifest rejects.",
      ].join("\n"),
    );
  }
  if (pin && range.ceilingMajor !== pin.major + 1) {
    problems.push(
      [
        `${PACKAGE_JSON} engines.node ceilings at <${range.ceilingMajor}, but ${NVMRC} pins major ${pin.major}.`,
        `    The supported line is ${pin.major}.x, so the ceiling is <${pin.major + 1}.`,
      ].join("\n"),
    );
  }
  return { problems, range };
}

/** ── 3. Every workflow's setup-node must name the pinned major. ───────────── */
function checkWorkflows(pin: VersionParts | null) {
  const problems: string[] = [];
  const workflowPaths = globSync(WORKFLOW_GLOB).sort();
  if (workflowPaths.length === 0) {
    problems.push(
      [
        `No workflow matched ${WORKFLOW_GLOB}.`,
        "    Zero files scanned is not a pass — it means the glob broke.",
      ].join("\n"),
    );
  }

  const declarations = workflowNodeVersions(
    workflowPaths.map((path) => ({ path, yaml: readFileSync(path, "utf8") })),
  );
  if (workflowPaths.length > 0 && declarations.length === 0) {
    problems.push(
      [
        `${workflowPaths.length} workflow file(s) scanned and not one declares a node-version.`,
        "    Either every job runs whatever Node the runner ships, or the parse broke.",
        "    Both are worth looking at; neither is a pass.",
      ].join("\n"),
    );
  }

  for (const d of declarations) {
    if (pin && d.value !== String(pin.major)) {
      problems.push(
        [
          `${d.path}:${d.line} sets node-version: "${d.value}", but the repo pins ${pin.major}.x.`,
          "    CI would gate on a Node nobody develops against.",
        ].join("\n"),
      );
    }
  }
  return { problems, declarations };
}

/** ── 4. The Node actually running, and how to fix it. ─────────────────────── */
function checkRunningNode(range: ClosedRange | null, enginesRaw: string | undefined, pin: string) {
  const running = parseExact(process.versions.node);
  if (!range || !running || satisfies(running, range)) return [];
  return [
    [
      `This process is Node ${process.versions.node}, outside engines.node "${enginesRaw}".`,
      "    Switch to the pinned version before you trust any gate:",
      `        fnm use            (or: nvm use, or: volta install node@${pin})`,
      `    Both ${NVMRC} and ${NODE_VERSION_FILE} name it, so those commands need no argument.`,
      "    ABOVE the range (23+): the built-in Web Storage shadows jsdom's and has",
      "    no .clear(), so ~125 suites fail for reasons that are not yours.",
      "    BELOW it, three separate things break as you go down: ICU < 78 decodes",
      "    windows-1252 wrong (the fiscalía PDF tests), < 22.18.0 cannot strip",
      "    types (verify:mobile cannot read @dim/contract), and < 22.15.0 has no",
      "    node:module registerHooks (every seed:* dies on import).",
      "    Red measured on the wrong Node is not evidence of anything.",
    ].join("\n"),
  ];
}

function runCheck(): void {
  const nvmrcRaw = readFileSync(NVMRC, "utf8").trim();
  const nodeVersionRaw = readFileSync(NODE_VERSION_FILE, "utf8").trim();
  const pin = parseExact(nvmrcRaw);

  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { engines?: { node?: string } };
  const enginesRaw = pkg.engines?.node;

  const engines = checkEngines(enginesRaw, pin, nvmrcRaw);
  const workflows = checkWorkflows(pin);

  const problems = [
    ...checkPinFiles(nvmrcRaw, nodeVersionRaw, pin),
    ...engines.problems,
    ...workflows.problems,
    ...checkRunningNode(engines.range, enginesRaw, nvmrcRaw),
  ];
  if (problems.length > 0) {
    console.error(
      [
        "",
        `✗ Node version fence FAILED — ${problems.length} disagreement(s):`,
        "",
        ...problems.map((p) => `  · ${p}\n`),
        "  One version, four declarations: .nvmrc, .node-version, engines.node,",
        "  and every workflow's setup-node. They move together or not at all.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    [
      `✓ Node version — ${nvmrcRaw} pinned by ${NVMRC}/${NODE_VERSION_FILE},`,
      `matched by engines.node "${enginesRaw}",`,
      `${workflows.declarations.length} workflow declaration(s),`,
      `and this process (${process.versions.node}).`,
    ].join(" "),
  );
}

// Only run when invoked as a CLI; importing from tests must not exit.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-node-version.ts") ||
    process.argv[1].endsWith("check-node-version.js"));

if (isMain) {
  try {
    runCheck();
  } catch (err) {
    console.error("✗ check-node-version: unexpected error:", err);
    process.exit(1);
  }
}
