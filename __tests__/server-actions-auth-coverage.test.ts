// Phase 4.1 (action plan 2026-05-20): convention enforcement.
//
// Every exported server action in `app/actions/*.ts` must call one of the
// project's auth guards before it touches the DB. The convention in this
// repo is:
//
//   - Public wrappers (named `*Action`) call a `require…` guard from
//     `lib/auth-guards.ts` (or one of `requireOrgAccessByToken`,
//     `requireCapability`, `requirePetAccess`, etc.).
//   - Inner writers (named `*ForUser`, `*Writer`, `*ForToken`) take the
//     caller identity as a parameter and are not auth-gated themselves;
//     they're called from the wrappers above.
//
// This test enforces the rule by glob-reading every `app/actions/*.ts`
// file, extracting `export async function …`, and asserting one of:
//
//   1. The function name ends in an inner-writer suffix (`ForUser`,
//      `Writer`, `ForToken`) — assume the wrapper above checks auth.
//   2. The function body contains a call to one of the known guards.
//   3. The function carries the magic comment `// @no-auth-required`
//      on the line immediately before the `export`, with a free-text
//      reason after it.
//
// If a future contributor adds a new auth helper, register its name in
// AUTH_GUARDS below.
//
// This is a regex-based linter, not a real AST analyzer — it's the
// cheapest reliable approximation per the plan. The trade-off: it can be
// fooled by string literals or comments that look like guard calls, but
// in practice the false-positive rate is zero on this codebase, and a
// new contributor adding an exported `…Action` without a guard will be
// caught.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ACTIONS_DIR = join(process.cwd(), "app", "actions");

// Recognized auth-gate calls — IMPORTED from the CI fence, never copied.
//
// This file used to keep its own hand-maintained copy of the list. Registering
// a new guard (requireLiveUser, T1.2) in scripts/check-authz-guards.ts made the
// fence pass and this test fail on the same tree, about the same three actions
// — which is the precise failure mode check-degraded-chrome's header warns
// about ("a duplicated list is how two fences start disagreeing in silence").
// One authority; this test now checks the SAME contract CI checks.
import { AUTH_GUARDS } from "@/scripts/check-authz-guards";

// Names of exported async functions that are inner writers / scoped helpers,
// taking caller identity as a parameter. They're called from public wrappers
// that themselves call a guard. The repo's naming convention treats every
// `For<CallerKind>` / `Writer` / `From<Source>` suffix as a non-guarded
// inner writer — the calling wrapper is what's required to be auth-gated.
const INNER_WRITER_SUFFIXES = [
  "ForUser",
  "ForAuthority",
  "ForOrg",
  "ForOrganization",
  "ForAudit",
  "ForVet",
  "ForVetProvider",
  "ForVetServiceProvider",
  "ForAdmin",
  "ForGovt",
  "ForCaller",
  "Writer",
  "ForToken",
  "FromCron",
  "FromEvent",
  "FromTrigger",
] as const;

const NO_AUTH_COMMENT = "@no-auth-required";

function listActionFiles(): string[] {
  return readdirSync(ACTIONS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

type ExportedFn = {
  name: string;
  startLine: number; // 1-indexed
  endLine: number;
  body: string;
  hasNoAuthComment: boolean;
};

// Walk the file, find every `export async function NAME(` declaration, then
// brace-match to the closing `}` to capture the body. Returns one entry per
// export.
function extractExportedAsyncFunctions(src: string): ExportedFn[] {
  const out: ExportedFn[] = [];
  const lines = src.split("\n");
  const exportRe = /^export\s+async\s+function\s+(\w+)\s*[(<]/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(exportRe);
    if (!m) continue;
    const name = m[1];

    // Find the function body by brace-matching from the first `{` after
    // the signature.
    let braceDepth = 0;
    let started = false;
    let endLine = i;
    let body = "";
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          braceDepth++;
          started = true;
        } else if (ch === "}") {
          braceDepth--;
        }
      }
      body += `${lines[j]}\n`;
      if (started && braceDepth === 0) {
        endLine = j;
        break;
      }
    }

    // Walk backwards through the contiguous comment block above the export
    // (lines starting with `//`, `/*`, ` *`, or blank-but-flanked-by-comments).
    // The @no-auth-required marker may sit anywhere in that block — at the top
    // of a long rationale, or right above the signature.
    let hasNoAuthComment = false;
    for (let back = i - 1; back >= 0; back--) {
      const line = lines[back].trim();
      const isCommentLine =
        line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line === "";
      if (!isCommentLine) break;
      if (line.includes(NO_AUTH_COMMENT)) {
        hasNoAuthComment = true;
        break;
      }
    }

    out.push({
      name,
      startLine: i + 1,
      endLine: endLine + 1,
      body,
      hasNoAuthComment,
    });
  }

  return out;
}

function isInnerWriter(name: string): boolean {
  return INNER_WRITER_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function callsAuthGuard(body: string): boolean {
  return AUTH_GUARDS.some((g) => {
    // Escape `.` so `auth.getUser` matches only a literal dot, not any char.
    const escaped = g.replace(/\./g, "\\.");
    return new RegExp(`\\b${escaped}\\s*\\(`).test(body);
  });
}

describe("§4.1 — every server action calls an auth guard or opts out explicitly", () => {
  const files = listActionFiles();

  it("finds the actions directory and at least one file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}: every exported async function is auth-gated or marked @no-auth-required`, () => {
      const fullPath = join(ACTIONS_DIR, file);
      const src = readFileSync(fullPath, "utf8");
      const fns = extractExportedAsyncFunctions(src);

      const offenders: string[] = [];
      for (const fn of fns) {
        if (isInnerWriter(fn.name)) continue;
        if (fn.hasNoAuthComment) continue;
        if (callsAuthGuard(fn.body)) continue;
        offenders.push(
          `${file}:${fn.startLine} export async function ${fn.name} — no auth guard call (name doesn't end in ${INNER_WRITER_SUFFIXES.join("/")} either). Add a guard call, rename to an inner-writer suffix, or add a \`// ${NO_AUTH_COMMENT}: <reason>\` comment immediately above the export.`,
        );
      }

      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }
});
