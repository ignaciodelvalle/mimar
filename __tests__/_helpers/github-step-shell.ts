// Run a composite action's `run:` block THE WAY THE RUNNER RUNS IT.
//
// WHY THIS FILE EXISTS, MEASURED 2026-08-30
// ---------------------------------------------------------------------------
// A fence over `.github/actions/supabase-start` executed the shipped script
// with `execFileSync("bash", [scriptPath])` — bare `bash`, no flags. GitHub
// does not. For `shell: bash` the runner executes:
//
//     bash --noprofile --norc -e -o pipefail {0}
//
// so errexit is ON in production and OFF in the harness. Eight tests passed
// over a retry loop that, in CI, died on its first failed attempt and never
// retried at all: `set -e` aborted the step one line above the `RC=$?` the
// loop reads. The assertions were right; the ENVIRONMENT they asserted in was
// not the one the code ships into, and a fence that runs its subject under a
// different runtime fences nothing.
//
// The same shape as the drizzle stub that discarded its `where` predicate
// (`dim-interno:docs/agents/open-work.md`, "Attempted and turned back"): the defect was in
// the scaffolding, so every assertion standing on it inherited it. The cure is
// the same too — make the harness reproduce the real runtime instead of the
// author's belief about it.
//
// So the argv is not a constant a test file may choose. It is DERIVED from the
// `shell:` the step itself declares, and an undeclared or unmapped shell is a
// loud failure rather than a silent fallback to bash's flags.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The runner's argv for each `shell:` keyword this repo uses, minus the script
 * path.
 *
 * Source: GitHub Actions, "Defaults / shell" — the documented default
 * invocation for each keyword on Linux runners. Verified against the `##[group]
 * Run` header of any `shell: bash` step in this repo's job logs, which prints
 * the interpreter line the runner chose.
 *
 * Deliberately NOT a fallback map: a step that declares something absent from
 * here (`python`, a custom `bash {0}` template that drops `-e`, `pwsh`) throws.
 * The whole point is that the harness may not guess.
 */
const RUNNER_ARGV: Readonly<Record<string, readonly string[]>> = {
  // `-e` is the one that matters: the runner turns errexit on for every
  // `shell: bash` step whether or not the script asks for it.
  bash: ["--noprofile", "--norc", "-e", "-o", "pipefail"],
  sh: ["-e"],
};

export type CompositeStep = {
  /** The `run:` block, dedented to a runnable script. */
  script: string;
  /** The `shell:` keyword the step declares. */
  shell: string;
};

/**
 * Extract the single `run:` step of a composite action, with the shell it
 * declares.
 *
 * The script is READ FROM THE SHIPPED YAML rather than duplicated into the
 * test, so a green fence cannot be describing a script the action no longer
 * ships. Both the `shell:` and the `run: |` must be unique in the file: an
 * action that grew a second step would otherwise get its two keys paired by
 * position, which is how a harness starts quietly testing the wrong step.
 */
export function readCompositeStep(actionPath: string): CompositeStep {
  const lines = readFileSync(actionPath, "utf8").split("\n");

  const runIdx: number[] = [];
  const shells: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (/^\s*run: \|\s*$/.test(line)) runIdx.push(i);
    const shell = line.match(/^\s*shell:\s*(\S+)\s*$/);
    if (shell) shells.push(shell[1]);
  }

  if (runIdx.length !== 1) {
    throw new Error(
      `${actionPath}: expected exactly one \`run: |\` block, found ${runIdx.length}. This helper pairs the step's \`shell:\` with its \`run:\` by uniqueness, not by position.`,
    );
  }
  if (shells.length !== 1) {
    throw new Error(`${actionPath}: expected exactly one \`shell:\` key, found ${shells.length}.`);
  }

  const start = runIdx[0];
  // YAML block scalar: the body is everything indented past the `run:` key,
  // ending at the first non-blank line that is not.
  const indent = (lines[start].match(/^\s*/) as RegExpMatchArray)[0].length + 2;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if ((line.match(/^\s*/) as RegExpMatchArray)[0].length < indent) break;
    body.push(line.slice(indent));
  }

  const script = body.join("\n");
  if (script.trim().length === 0) {
    // An extractor that silently returned "" would make every downstream
    // assertion pass against nothing.
    throw new Error(`${actionPath}: extracted an empty \`run:\` block`);
  }
  return { script, shell: shells[0] };
}

/** The interpreter argv the runner uses for `shell`, script path excluded. */
export function runnerArgv(shell: string): readonly string[] {
  const argv = RUNNER_ARGV[shell];
  if (!argv) {
    throw new Error(
      `no runner argv known for \`shell: ${shell}\` — add it to RUNNER_ARGV from GitHub's documented defaults rather than letting the harness guess.`,
    );
  }
  return argv;
}

export type StepOutcome = { status: number; output: string };

/**
 * Execute `script` under `shell`'s runner flags.
 *
 * stdout and stderr are folded together because that is how a human reads a
 * step: an annotation must be visible in the job log wherever the script chose
 * to write it.
 *
 * `flags` overrides the derived argv, and exists for ONE purpose: running the
 * same script under a deliberately different regime (bare `bash`, say) to prove
 * the script does not depend on the caller's flags. Production paths must let
 * it default.
 */
export function execStep(
  step: CompositeStep,
  opts: { dir: string; env: NodeJS.ProcessEnv; flags?: readonly string[] },
): StepOutcome {
  const scriptPath = join(opts.dir, "step.sh");
  writeFileSync(scriptPath, step.script);
  const argv = [...(opts.flags ?? runnerArgv(step.shell)), scriptPath];

  try {
    const output = execFileSync(step.shell, argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env,
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
