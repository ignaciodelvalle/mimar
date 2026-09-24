// CI ↔ `pnpm verify` parity fence.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// `pnpm verify` is the Definition of Done and runs on the PO's machine. CI is
// what guards a merge. When a lint joins one and not the other, the two stop
// meaning the same thing — silently, because nothing compares them.
//
// It drifted, badly. Measured 2026-07-27, the first time anyone looked: `verify`
// ran 43 lints and .github/workflows/ci.yml ran 13. Twenty-nine fences — the
// jurisdiction scope guards, the metric-contract checks, the copy conventions,
// the seed-id ratchet — had never executed in CI even once. Nobody had noticed
// because CI itself had not run since 2026-06-12.
//
// A one-time cleanup would have rotted the same way by the next wave. This is
// the ratchet that keeps it closed: add a lint to `verify` without adding it to
// the workflow and this fails, naming the ones you left behind.
//
// WHAT COUNTS AS "IN CI"
// A literal `pnpm lint:<name>` anywhere in the workflow file. That is
// deliberately syntactic — it cannot be fooled by a step that merely mentions a
// lint in a comment (comments are stripped first), and it does not care which
// job runs it: `check` for the offline fences, `test` for the ones that need a
// database.
//
// WHY `verify:*` JOINED THE RULE (2026-08-25)
// ---------------------------------------------------------------------------
// The fence only ever knew about `lint:*`, and on 2026-08-25 that turned out to
// be a hole of exactly the shape it exists to close. A clean `git merge` broke
// `apps/mobile` — the Expo client — and NOTHING went red: the mobile program is
// checked by `pnpm --filter mimar typecheck` and its Jest suite, and neither was
// in `pnpm verify` nor in this workflow. The breakage was found by hand, days
// later than it should have been.
//
// The fix wires those two into `verify` behind a `verify:mobile` script, and
// that script is not a `lint:` — so under the old rule it could have been added
// to `verify` and left out of CI, silently, forever. The derivation is therefore
// widened to every `lint:*` AND `verify:*` link of the chain. "Gate" is what
// they have in common: a named script `verify` runs that CI must run too.
//
// Run:  pnpm tsx scripts/check-ci-lint-parity.ts   (or: pnpm lint:ci-parity)
// Exits 0 when every gate in `verify` appears in the workflow.
// Exits 1 listing the ones that do not.

import { readFileSync } from "node:fs";

export const PACKAGE_JSON = "package.json";
export const WORKFLOW = ".github/workflows/ci.yml";

/**
 * The named gates `pnpm verify` runs, in order. `verify` is a chain of
 * `pnpm <script> && …`; the `lint:*` and `verify:*` links are our business
 * (bare `typecheck` and `build` are separate CI steps with their own names, and
 * bare `lint` is Biome, which every job already runs).
 */
export function gatesInVerify(verifyScript: string): string[] {
  return verifyScript
    .split("&&")
    .map((part) => part.trim().replace(/^pnpm\s+/, ""))
    .filter((name) => name.startsWith("lint:") || name.startsWith("verify:"));
}

/**
 * Every gate the workflow actually invokes. Comment lines are stripped FIRST:
 * this file documents its fences heavily, and a gate named only in prose is
 * exactly the false pass this check exists to prevent.
 */
export function gatesInWorkflow(workflowYaml: string): Set<string> {
  const withoutComments = workflowYaml
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  const found = [...withoutComments.matchAll(/pnpm\s+((?:lint|verify):[a-z0-9-]+)/g)].map(
    (m) => m[1],
  );
  return new Set(found);
}

export function missingFromWorkflow(verifyScript: string, workflowYaml: string): string[] {
  const inCi = gatesInWorkflow(workflowYaml);
  return gatesInVerify(verifyScript).filter((name) => !inCi.has(name));
}

async function runCheck(): Promise<void> {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const verify = pkg.scripts?.verify;
  if (!verify) {
    console.error(
      "✗ check-ci-lint-parity: package.json has no `verify` script.\n" +
        "  This fence derives what CI must run FROM that script. Without it the\n" +
        "  derivation is empty, and an empty derivation is not a pass.",
    );
    process.exit(1);
  }

  const workflow = readFileSync(WORKFLOW, "utf8");
  const verifyGates = gatesInVerify(verify);

  if (verifyGates.length === 0) {
    console.error(
      "✗ check-ci-lint-parity: parsed ZERO gate scripts out of `verify`.\n" +
        "  That is not a pass — it means the parse broke (the script's shape changed)\n" +
        "  and this fence would wave everything through.",
    );
    process.exit(1);
  }

  const missing = missingFromWorkflow(verify, workflow);

  if (missing.length > 0) {
    console.error(
      [
        "",
        `✗ CI ↔ verify parity FAILED — ${missing.length} of ${verifyGates.length} gate(s) in \`pnpm verify\` never run in CI:`,
        ...missing.map((name) => `    ${name}`),
        "",
        `  Add each to ${WORKFLOW}:`,
        "    · offline fences → the `check` job (no database there);",
        "    · fences that query the database → the `test` job, which has the",
        "      Supabase stack up, after `pnpm db:bootstrap`.",
        "",
        "  A gate that only the PO's machine runs is a gate that cannot block a merge.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `✓ CI ↔ verify parity — all ${verifyGates.length} gate(s) in \`verify\` are invoked by ${WORKFLOW}.`,
  );
}

// Only run when invoked as a CLI; importing from tests must not exit.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-ci-lint-parity.ts") ||
    process.argv[1].endsWith("check-ci-lint-parity.js"));

if (isMain) {
  runCheck().catch((err) => {
    console.error("✗ check-ci-lint-parity: unexpected error:", err);
    process.exit(1);
  });
}
