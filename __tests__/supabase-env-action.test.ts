// Guard for `.github/actions/supabase-env` — the composite action that exports
// the local Supabase stack's credentials into $GITHUB_ENV for the vitest job,
// the e2e job and both panorama-qa jobs.
//
// WHAT THIS FILE EXISTS TO STOP, MEASURED 2026-08-30
// ---------------------------------------------------------------------------
// The action carried a diagnostic for the one failure it was written for:
//
//     ANON=$(echo "$CLEAN" | grep '^ANON_KEY=' | cut -d= -f2-)
//     if [ -z "$ANON" ]; then
//       echo "::error::supabase status -o env produced no ANON_KEY — is the stack up?"
//
// Under `set -euo pipefail`, `grep` exits 1 when it matches nothing, an
// assignment carries its substitution's status, and errexit then aborts — ONE
// LINE ABOVE the guard. The annotation was unreachable and had never been
// emitted once. The step went red with an empty log.
//
// The cost is not just a missing line. Those `::error::` strings are echoed
// verbatim by the runner under `##[group]Run` on EVERY run, green ones
// included, so a reader searching the log finds them and concludes the stack
// failed to start. Across the 45 most recent CI runs the E2E job failed at
// `Run Playwright e2e suite` 42 times, at `Build Next.js app` twice and at
// `Start Supabase local stack` once — the stack was up for 44 of 45.
//
// So the assertions below do not check that the strings are PRESENT in the
// YAML; a grep for the text is exactly what could not tell the difference. They
// EXECUTE the shipped script against a stubbed `pnpm` and read what it printed.
//
// AND THEY EXECUTE IT UNDER THE RUNNER'S OWN SHELL. The sibling fence over
// `supabase-start` ran its script under bare `bash` and so measured a runtime
// the action never ships into; the interpreter here is derived from the
// `shell:` this step declares, by `__tests__/_helpers/github-step-shell.ts`.
// This script sets `-euo pipefail` itself, so the two regimes happen to agree
// today — but "happens to agree" is not a property a harness may assume, and it
// is exactly what the other file assumed.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execStep, readCompositeStep, runnerArgv } from "./_helpers/github-step-shell";

const ACTION = ".github/actions/supabase-env/action.yml";

const step = () => readCompositeStep(ACTION);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Outcome = { status: number; output: string; githubEnv: string; calls: string[] };

/**
 * Run the shipped script with `pnpm` stubbed to print `statusOut` and exit
 * `statusRc`, and $GITHUB_ENV pointed at a scratch file.
 *
 * The stub LOGS ITS ARGV. Its first cut did not, and that is the same hole as a
 * stub that discards a `where` predicate: with the arguments thrown away, every
 * case in this file would be asserting that it does not matter WHAT the script
 * asks the CLI for. It matters — `supabase status` without `-o env` prints a
 * human table, not KEY=VALUE lines, and each of the guards below would then be
 * firing for the wrong reason on a perfectly healthy stack.
 *
 * stderr is folded into stdout because that is how a runner reads a step: the
 * annotation must be visible in the job log wherever the script chose to put
 * it.
 */
function runAction(statusOut: string, statusRc = 0): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "supabase-env-"));
  temps.push(dir);

  const callLog = join(dir, "calls.log");
  const stub = join(dir, "pnpm");
  writeFileSync(
    stub,
    [
      "#!/bin/bash",
      `echo "$*" >> ${JSON.stringify(callLog)}`,
      "cat <<'PNPM_STUB_EOF'",
      statusOut,
      "PNPM_STUB_EOF",
      `exit ${statusRc}`,
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);

  const githubEnvPath = join(dir, "github_env");
  writeFileSync(githubEnvPath, "");

  const { status, output } = execStep(step(), {
    dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, GITHUB_ENV: githubEnvPath },
  });
  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").split("\n").filter(Boolean)
    : [];
  return { status, output, githubEnv: readFileSync(githubEnvPath, "utf8"), calls };
}

/** A well-formed three-part JWT — shape only; the value is never verified. */
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl";

const HEALTHY_STATUS = [
  `API_URL="http://127.0.0.1:54321"`,
  `DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"`,
  `ANON_KEY="${JWT}"`,
  `SERVICE_ROLE_KEY="${JWT}"`,
].join("\n");

const withoutAnonKey = () =>
  HEALTHY_STATUS.split("\n")
    .filter((l) => !l.startsWith("ANON_KEY="))
    .join("\n");

describe("the supabase-env action, executed under the runner's own shell", () => {
  it("declares `shell: bash`, which is what the harness's flags encode", () => {
    expect(step().shell).toBe("bash");
    expect(runnerArgv(step().shell)).toEqual(["--noprofile", "--norc", "-e", "-o", "pipefail"]);
  });

  it("asks the CLI for `status -o env`, exactly once", () => {
    // `-o env` is what makes the output KEY=VALUE at all; without it the CLI
    // prints a human table and every guard below fires on a healthy stack for
    // the wrong reason. Observed from the stub's own argv log rather than read
    // off the YAML, so a script that grew a second CLI call is also named.
    expect(runAction(HEALTHY_STATUS).calls).toEqual(["exec supabase status -o env"]);
  });

  it("exports the anon key with the CLI's quotes stripped", () => {
    // The quote-stripping the action's own header calls load-bearing: a key
    // exported as `"eyJ..."` made GoTrue answer 200 and PostgREST answer 401
    // PGRST301, which reads as "RLS denied it" rather than as a broken key.
    const { status, githubEnv } = runAction(HEALTHY_STATUS);
    expect(status).toBe(0);
    expect(githubEnv).toContain(`ANON_KEY=${JWT}`);
    expect(githubEnv).toContain(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${JWT}`);
    expect(githubEnv, "a quoted value reached $GITHUB_ENV").not.toContain(`"${JWT}"`);
  });

  // ---- The three silent deaths. Each asserts the ANNOTATION, not the exit ----
  // Exit status alone is what the broken script already got right; the whole
  // defect was that it exited without saying anything. So every case here
  // pins the text a human has to read in the job log.

  it("SAYS the stack is down when `supabase status` itself fails", () => {
    const { status, output } = runAction("failed to connect to docker daemon", 1);
    expect(status).not.toBe(0);
    expect(output).toContain("::error::");
    expect(output).toContain("the local Supabase stack is not running");
    expect(output).toContain("exited 1");
  });

  it("SAYS so when status returns output with no KEY=VALUE line at all", () => {
    // The half-started stack: the CLI answers, but with prose instead of env.
    const { status, output } = runAction("Stopped services: [supabase_db_DIM]");
    expect(status).not.toBe(0);
    expect(output).toContain("::error::");
    expect(output).toContain("no KEY=VALUE lines");
  });

  it("SAYS so when the env has other keys but no ANON_KEY — the dead guard", () => {
    // The exact regression this file was written for. Before the fix the script
    // exited 1 here with EMPTY output, one line above its own message.
    const { status, output } = runAction(withoutAnonKey());
    expect(status).not.toBe(0);
    expect(output).toContain("::error::");
    expect(output).toContain("produced no ANON_KEY");
    expect(output).toContain("is the stack up?");
  });

  it("SAYS so when ANON_KEY is present but is not a three-part JWT", () => {
    // This guard was always reachable — it is asserted so the fix to its
    // neighbours cannot quietly cost it its reachability.
    const { status, output } = runAction(HEALTHY_STATUS.replace(JWT, "not-a-jwt"));
    expect(status).not.toBe(0);
    expect(output).toContain("::error::");
    expect(output).toContain("not a well-formed JWT");
  });

  it("does not export a partial environment when it refuses", () => {
    // A step that fails after writing half the credentials would leave later
    // steps authenticating with a mixture. The ANON_KEY alias must not appear.
    expect(runAction(withoutAnonKey()).githubEnv).not.toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY=");
  });
});

describe("the grep guards that make those annotations reachable", () => {
  // A structural companion to the executed cases above. They prove the current
  // script talks; this proves the SHAPE that lets it talk is still there, so a
  // future edit that reintroduces a bare `grep` in an assignment is named
  // rather than merely turning one of the cases above red.
  it("never assigns a bare grep pipeline under `set -e`", () => {
    const offenders = step()
      .script.split("\n")
      .filter(
        (l) => /^[A-Z_]+=\$\(/.test(l.trim()) && l.includes("grep") && !l.includes("|| true"),
      );
    expect(offenders, "a bare `grep` in an assignment aborts before its own guard").toEqual([]);
  });

  it("keeps `|| true` scoped to grep, so sed and cut failures stay fatal", () => {
    // `$(cmd | grep x || true)` would swallow a sed/cut failure too. The brace
    // group is what confines the tolerance to the one command whose "no match"
    // is data rather than a bug.
    const script = step().script;
    for (const line of script.split("\n")) {
      if (!line.includes("|| true")) continue;
      expect(line, "`|| true` must be inside a `{ ...; }` group").toMatch(/\{[^}]*\|\| true;\s*\}/);
    }
    expect(script).toContain("set -euo pipefail");
  });
});
