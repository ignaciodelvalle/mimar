#!/usr/bin/env node
// PostToolUse hook (Edit|Write|MultiEdit): formats the just-touched file with
// Biome. Never lint-fixes or reorders imports — a mid-edit unused import
// survives this hook on purpose. Advisory only — it must NEVER block the
// tool call and NEVER throw, so every branch below funnels into a plain
// `process.exit(0)`.
//
// Claude Code hook contract: the PostToolUse payload arrives as JSON on
// stdin, file path at `tool_input.file_path` (Edit, Write and MultiEdit all
// carry this field) — verified against code.claude.com/docs/en/hooks.md.
//
// Windows invocation note (measured on this machine, Node v22.23.2):
// `pnpm`/`biome` resolve to `.cmd`/`.ps1` shims. `spawnSync("pnpm", …)`
// without `shell: true` fails ENOENT, and `spawnSync("pnpm.cmd", …)` fails
// EINVAL — Node's child_process does not exec Windows batch files directly.
// `shell: true` "fixes" that but then requires hand-quoting every argument
// (Node does not auto-quote array args for the Windows shell), which is its
// own footgun for any future path containing a space. Separately, passing a
// `cwd` to spawnSync broke PATH-based executable lookup entirely on this
// Node build (`spawnSync('node', …, { cwd })` → ENOENT, no `cwd` → works) —
// undocumented and easy to reintroduce by "cleaning up" this script.
//
// The fix that sidesteps all three: invoke Biome's own JS entrypoint
// (`node_modules/@biomejs/biome/bin/biome` — the exact file `pnpm exec biome`
// would run anyway, per that package's own `bin` field) directly via
// `process.execPath` (the Node binary already running this hook — no PATH
// lookup, no shim, no shell) with plain array args (no quoting needed) and
// no `cwd` option. No PATH override is needed for the inner spawn either:
// that entrypoint resolves its platform binary via `require.resolve(...)`
// (read from node_modules/@biomejs/biome/bin/biome directly, 2026-09-04),
// never via PATH, on every platform it supports — a hardcoded fnm path here
// would be dead weight AND a portability wart, so this deliberately doesn't
// carry one.
import { spawnSync } from "node:child_process";
import path from "node:path";

const FORMATTABLE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".css"]);

function isExcluded(projectDir, absPath) {
  const rel = path.relative(projectDir, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true; // outside the repo
  const parts = rel.split(path.sep);
  if (parts.includes("node_modules")) return true;
  if (parts.includes(".next")) return true;
  if (parts[0] === "db" && parts[1] === "migrations") return true;
  if (parts[0] === "apps" && parts[1] === "mobile" && parts[2] === "android") return true;
  if (rel === path.join("docs", "architecture", "facts.json")) return true; // generated
  return false;
}

let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const filePath = JSON.parse(raw).tool_input?.file_path;
    if (!filePath) return process.exit(0);

    const absPath = path.resolve(projectDir, filePath);
    if (!FORMATTABLE_EXT.has(path.extname(absPath))) return process.exit(0);
    if (isExcluded(projectDir, absPath)) return process.exit(0);

    const biomeBin = path.join(projectDir, "node_modules", "@biomejs", "biome", "bin", "biome");

    const result = spawnSync(process.execPath, [biomeBin, "format", "--write", absPath], {
      encoding: "utf8",
      timeout: 15000,
    });

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (/\bFixed [1-9]\d* file/i.test(output)) {
      console.log(`biome-fix: formatted ${path.relative(projectDir, absPath)}`);
    }
  } catch {
    // advisory only — never block or fail the agent on a formatting hiccup
  }
  process.exit(0);
});
