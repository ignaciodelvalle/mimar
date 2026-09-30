// Guard for `.github/actions/supabase-start` — the retry wrapper around
// `supabase start` used by the vitest job and the e2e job.
//
// THE ONE PROPERTY THAT MATTERS
// ---------------------------------------------------------------------------
// A retry wrapper is a gate that has been given permission to ignore a red.
// Get the last attempt wrong and it becomes `continue-on-error:` wearing a
// loop — the stack never comes up, the step goes green, and every later step
// fails somewhere confusing. So the load-bearing case here is not "it retries";
// it is "after the last attempt it still DIES, with the child's own status".
//
// WHY THE HARNESS IS THE INTERESTING PART OF THIS FILE
// ---------------------------------------------------------------------------
// The first cut of this fence executed the script with
// `execFileSync("bash", [scriptPath])`. Eight tests passed. In CI the action
// retried ZERO times, because GitHub runs a `shell: bash` step as
// `bash --noprofile --norc -e -o pipefail {0}` and the script's bare
// invocation died under that `-e` one line above the `RC=$?` its loop reads.
// Every assertion was correct about a runtime the code never runs in.
//
// So the interpreter argv is not written here. It is derived from the `shell:`
// the step declares, by `__tests__/_helpers/github-step-shell.ts`, which throws
// rather than guess for a shell it has no mapping for. And one case below runs
// the SAME script under bare `bash` and asserts the two agree, because "the
// retry works only when the caller happens to set the right flags" is the
// original defect restated.
//
// The script is executed, not read. Asserting that the YAML contains the string
// `exit "$RC"` would pass just as happily on a script where that line is
// unreachable — which is precisely what happened.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix as posixPath } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execStep, readCompositeStep, runnerArgv } from "./_helpers/github-step-shell";

const ACTION = ".github/actions/supabase-start/action.yml";
const WORKFLOW_DIR = ".github/workflows";

const step = () => readCompositeStep(ACTION);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Outcome = { status: number; output: string; calls: string[] };

/**
 * Run the shipped script with `pnpm` stubbed, under the runner's own flags.
 *
 * `failures` is how many leading `supabase start` invocations exit non-zero;
 * `Infinity` means every one of them does. Each invocation appends its full
 * argv to a log the assertions read, so "how many times was it tried" and
 * "was the teardown run in between" are observed, not inferred.
 *
 * `flags` exists for the one case that deliberately runs under a different
 * regime; everything else lets the harness derive it from the step.
 *
 * The mirror-first options (`token`, `owner`, `actor`, `dockerLoginRc`,
 * `dockerInspectRc`, `nodeRc`, `major`) all default to values that reproduce
 * TODAY's path exactly: `token` is `undefined`, which — unlike an empty
 * string — is explicitly DELETED from the child's env below, so no ambient
 * `SUPABASE_GITHUB_TOKEN` in the process running this suite could leak in
 * and silently change which branch a "default" call exercises.
 */
function runAction(
  failures: number,
  opts: {
    attempts?: string;
    exclude?: string;
    startRc?: number;
    flags?: readonly string[];
    /** `SUPABASE_GITHUB_TOKEN`. Omitted (not `""`) reproduces today's path. */
    token?: string;
    /** `GITHUB_REPOSITORY_OWNER`, deliberately mixed-case by default to prove lowercasing. */
    owner?: string;
    actor?: string;
    /** Exit code the stub `docker login ...` returns. */
    dockerLoginRc?: number;
    /** Exit code the stub `docker buildx imagetools inspect <marker>` returns — 0 = "found". */
    dockerInspectRc?: number;
    /** Exit code the stub `node -p "require(...).version"` returns. */
    nodeRc?: number;
    /** The fixture `supabase/config.toml`'s `db.major_version`. */
    major?: string;
  } = {},
): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "supabase-start-"));
  temps.push(dir);

  const callLog = join(dir, "calls.log");
  const counter = join(dir, "start-count");
  const startRc = opts.startRc ?? 1;
  const limit = failures === Number.POSITIVE_INFINITY ? 999999 : failures;

  // The stub counts only `start` invocations, so a `stop` between attempts
  // cannot be miscounted as a retry. It records the WHOLE argv, so the
  // `--exclude` assertion reads what was passed rather than trusting it.
  // It ALSO records the registry the caller set for that one invocation —
  // `SUPABASE_INTERNAL_IMAGE_REGISTRY=<x> pnpm exec supabase start ...` sets
  // that var only for this child, so reading it here is the only way to
  // observe, from outside, which registry a given attempt actually used.
  writeFileSync(
    join(dir, "pnpm"),
    [
      "#!/bin/bash",
      `echo "REGISTRY=\${SUPABASE_INTERNAL_IMAGE_REGISTRY:-<unset>} $*" >> ${JSON.stringify(callLog)}`,
      'if [[ "$*" == *" start "* || "$*" == *" start" ]]; then',
      `  n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)`,
      "  n=$((n + 1))",
      `  echo "$n" > ${JSON.stringify(counter)}`,
      `  if [ "$n" -le ${limit} ]; then exit ${startRc}; fi`,
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "pnpm"), 0o755);

  // Stubs for the two binaries the mirror-first probe touches. Built
  // unconditionally: when `token` is unset the probe block never runs, so
  // these are simply never invoked — see "does nothing when github-token is
  // empty" below, which asserts exactly that instead of assuming it.
  writeFileSync(
    join(dir, "docker"),
    [
      "#!/bin/bash",
      `echo "$*" >> ${JSON.stringify(callLog)}`,
      'if [ "$1" = "login" ]; then exit "${DOCKER_LOGIN_RC:-0}"; fi',
      'if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ] && [ "$3" = "inspect" ]; then exit "${DOCKER_INSPECT_RC:-0}"; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "docker"), 0o755);

  writeFileSync(
    join(dir, "node"),
    [
      "#!/bin/bash",
      `echo "$*" >> ${JSON.stringify(callLog)}`,
      'if [ "$1" = "-p" ]; then',
      '  if [ "${NODE_RC:-0}" != "0" ]; then exit "${NODE_RC}"; fi',
      '  echo "${STUB_CLI_VERSION:-9.9.9}"',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "node"), 0o755);

  // The one real (non-stubbed) filesystem read the mirror-first block makes.
  // A fixture here, under a `cwd` scoped to this temp dir, is what keeps
  // these tests from depending on the REAL repo's supabase/config.toml
  // content ever staying what a test expects.
  mkdirSync(join(dir, "supabase"), { recursive: true });
  writeFileSync(join(dir, "supabase", "config.toml"), `major_version = ${opts.major ?? "17"}\n`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    SUPABASE_EXCLUDE: opts.exclude ?? "studio,imgproxy,edge-runtime,realtime",
    SUPABASE_ATTEMPTS: opts.attempts ?? "3",
    // Zero backoff: this suite must not sleep. The doubling is arithmetic,
    // not behaviour, and 0 doubles to 0.
    SUPABASE_BACKOFF: "0",
    GITHUB_REPOSITORY_OWNER: opts.owner ?? "Acme",
    GITHUB_ACTOR: opts.actor ?? "actor",
    DOCKER_LOGIN_RC: String(opts.dockerLoginRc ?? 0),
    DOCKER_INSPECT_RC: String(opts.dockerInspectRc ?? 0),
    NODE_RC: String(opts.nodeRc ?? 0),
  };
  // `undefined`, not a deleted key: Node's child_process omits an env entry
  // whose value is `undefined` (normalizeSpawnArguments), so this has the
  // same effect on the child's environment while staying a plain assignment.
  env.SUPABASE_GITHUB_TOKEN = opts.token;

  const { status, output } = execStep(step(), {
    dir,
    flags: opts.flags,
    cwd: dir,
    env,
  });

  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").split("\n").filter(Boolean)
    : [];
  return { status, output, calls };
}

const starts = (o: Outcome) => o.calls.filter((c) => c.includes(" start"));
const stops = (o: Outcome) => o.calls.filter((c) => c.includes(" stop"));

/** The `SUPABASE_INTERNAL_IMAGE_REGISTRY` a given logged `pnpm` call ran under. */
const registryOf = (call: string): string => {
  const m = call.match(/^REGISTRY=(\S+)/);
  return m ? m[1] : "<unset>";
};

/**
 * Every WHOLE step of `workflow` whose body mentions `needle`.
 *
 * A step runs from its `- ` bullet to the next bullet at the same indent, so
 * the returned text carries every key of that step regardless of the order they
 * were written in — which is the point: `continue-on-error` above a `uses:`
 * belongs to the same step as one below it.
 */
function stepsUsing(workflow: string, needle: string): string[] {
  const lines = readFileSync(workflow, "utf8").split("\n");
  const bullets: number[] = [];
  for (const [i, line] of lines.entries()) {
    if (/^\s*- (name|uses|run|id):/.test(line)) bullets.push(i);
  }
  const blocks: string[] = [];
  for (const [n, from] of bullets.entries()) {
    const to = bullets[n + 1] ?? lines.length;
    const block = lines.slice(from, to).join("\n");
    if (block.includes(needle)) blocks.push(block);
  }
  return blocks;
}

// `posixPath.join`, NOT `join`, and the difference is the whole reason this file
// could not go green on the machine where this repo's Definition of Done is
// actually run.
//
// The two cases at the bottom compare these paths against literals written with
// forward slashes — `".github/workflows/ci.yml"` — because that is how a
// workflow path is spelled everywhere else in this repo and in GitHub's own UI.
// The platform `join` spells it with the platform's separator, so on Windows
// every one of those comparisons received `.github\workflows\ci.yml` and failed
// on the separator while agreeing on the file. Measured 2026-08-31: two failing
// tests, identical across two `test:verified` runs, on a tree whose CI job was
// green — because CI runs Ubuntu and the PO runs Windows.
//
// That asymmetry is the part worth keeping: a green CI does NOT stand in for the
// local gate here, and a path assembled with the platform separator is a fence
// that only fences one platform. Node accepts forward slashes for filesystem
// calls on Windows, so `readFileSync` further down is unaffected — only the
// spelling changes, and it now matches the literals it is checked against.
//
// The `join` import stays for the tmpdir scaffolding above, which builds REAL
// OS paths for an executable and must keep the native separator.
const workflowFiles = () =>
  readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => posixPath.join(WORKFLOW_DIR, f))
    .sort();

// THIS SUITE'S COST IS PROCESS SPAWNS, AND ITS BUDGET IS DECLARED, NOT INHERITED
// ---------------------------------------------------------------------------
// Every case below executes the real script under a real `bash`, and the
// script invokes the `pnpm` stub — itself a bash process — once per attempt and
// once per teardown. A single `runAction(2)` is ~12 spawns; the bare-bash case
// runs it twice. On Windows, spawning bash is the operation that degrades most
// under load, so this file's wall time is a function of what else the machine
// is doing, not of what the tests assert.
//
// Measured 2026-09-01 on the PO's machine, the bare-bash case alone: 0.58 s in
// isolation, ~1.6 s inside the full suite across three green runs, and 5.04 s
// — the default 5 s ceiling, timed out — in a fourth run where every
// neighbouring file was 1.3–1.6× slower and its own sibling case 2.9× slower.
// It was in every measurement exactly twice its sibling. The default budget
// therefore left a 3× margin against an observed variance of more than 3×,
// and a suite that answers differently twice over one tree fails the
// Definition of Done whatever the second answer is. The 30 s budget matches
// the one the repo's DB-backed cases already declare and is ~6× the worst
// observed run; it is set on the suite so no case here inherits a ceiling it
// never chose.
const SPAWN_BUDGET = { timeout: 30_000 };

describe("the supabase-start action, executed under the runner's own shell", SPAWN_BUDGET, () => {
  it("uses the interpreter GitHub uses, derived from the step's own `shell:`", () => {
    // Not decoration. If this step ever declares a shell whose flags differ,
    // every case below silently starts measuring a different runtime — which is
    // the exact defect this file was rewritten for. The helper throws for an
    // unmapped shell; this pins what the mapping resolved to today.
    expect(step().shell).toBe("bash");
    expect(runnerArgv(step().shell)).toEqual(["--noprofile", "--norc", "-e", "-o", "pipefail"]);
  });

  it("starts the stack once and stops when it comes up first try", () => {
    const out = runAction(0);
    expect(out.status).toBe(0);
    expect(starts(out)).toHaveLength(1);
    expect(stops(out), "nothing to tear down on a clean start").toHaveLength(0);
  });

  it("RETRIES after a transient failure and succeeds — under `-e`, where it did not", () => {
    const out = runAction(2);
    expect(out.status).toBe(0);
    expect(
      starts(out),
      "the retry loop never ran: errexit killed the step on the first failed attempt",
    ).toHaveLength(3);
    // The teardown is why retrying works at all: the measured failure was a
    // container still holding 54322.
    expect(stops(out), "the half-started stack must be torn down between tries").toHaveLength(2);
    expect(out.output).toContain("::warning::");
  });

  it("behaves identically under bare `bash` — the retry may not depend on the caller's flags", () => {
    // The defect in one assertion. The shipped script died under `-e` and
    // retried under bare bash, and the old harness only ever ran the second.
    // A script that declares its own regime cannot tell the two apart.
    const asRunner = runAction(2);
    const asBareBash = runAction(2, { flags: [] });
    expect(starts(asBareBash)).toHaveLength(starts(asRunner).length);
    expect(stops(asBareBash)).toHaveLength(stops(asRunner).length);
    expect(asBareBash.status).toBe(asRunner.status);
  });

  // ---- THE load-bearing case ------------------------------------------------
  it("still FAILS after the last attempt — a retry may not turn a red green", () => {
    const out = runAction(Number.POSITIVE_INFINITY);
    expect(out.status, "the step went green on a stack that never came up").not.toBe(0);
    expect(starts(out), "wrong number of attempts").toHaveLength(3);
    expect(out.output).toContain("::error::");
    expect(out.output).toContain("failed on all 3 attempt(s)");
  });

  it("propagates the child's own exit status, not a flattened 1", () => {
    // A wrapper that normalises every failure to 1 loses the distinction
    // between "docker refused" and "the CLI is missing".
    expect(runAction(Number.POSITIVE_INFINITY, { startRc: 7 }).status).toBe(7);
  });

  it("honours attempts=1 — the no-retry configuration still reports", () => {
    const out = runAction(Number.POSITIVE_INFINITY, { attempts: "1" });
    expect(out.status).not.toBe(0);
    expect(starts(out)).toHaveLength(1);
    expect(stops(out), "no teardown when there is no retry to prepare for").toHaveLength(0);
    expect(out.output).toContain("failed on all 1 attempt(s)");
  });

  it("passes the exclude list through verbatim on every attempt", () => {
    // A retry that quietly brought up a different set of services would change
    // what the job is testing between attempt 1 and attempt 2.
    const exclude = "studio,realtime";
    const out = runAction(1, { exclude });
    expect(starts(out)).toHaveLength(2);
    for (const call of starts(out)) expect(call).toContain(`--exclude ${exclude}`);
  });
});

// ---------------------------------------------------------------------------
// MIRROR-FIRST: probing the GHCR image mirror before touching
// `public.ecr.aws`, added 2026-09-30 after a fresh review blocked the first
// cut of this feature for shipping with no coverage at all. Every case here
// exercises the REAL script through the SAME runner-argv harness as above —
// stubbing `docker`, `node`, and (via the existing `pnpm` stub) `supabase`,
// never reading or writing anything outside its own temp `dir`.
// ---------------------------------------------------------------------------
describe("mirror-first: probing the GHCR mirror before public.ecr.aws", SPAWN_BUDGET, () => {
  it("does nothing when github-token is empty — today's path, byte for byte", () => {
    // `token` omitted, not `""` — see runAction's own doc comment for why
    // that distinction matters here.
    const out = runAction(0);
    expect(out.status).toBe(0);
    expect(starts(out)).toHaveLength(1);
    expect(registryOf(starts(out)[0])).toBe("public.ecr.aws");
    // The strongest form of "no-op": `docker` and `node` were never even
    // invoked, not just "invoked and ignored" — the only logged call is the
    // one successful `pnpm ... start`.
    expect(out.calls).toHaveLength(1);
    expect(out.output).not.toContain("GHCR");
  });

  it("logs in, finds the readiness marker, and starts against the GHCR mirror", () => {
    const out = runAction(0, {
      token: "gh-token",
      owner: "Acme", // mixed case on purpose — GHCR paths must be lowercase
      dockerLoginRc: 0,
      dockerInspectRc: 0, // marker found
    });
    expect(out.status).toBe(0);
    expect(starts(out)).toHaveLength(1);
    expect(registryOf(starts(out)[0]), "owner must be lowercased for the GHCR path").toBe(
      "ghcr.io/acme",
    );
    expect(out.output).toContain("pulling from GHCR instead of public.ecr.aws");
  });

  it("falls back to public.ecr.aws with a warning when the marker is absent", () => {
    const out = runAction(0, {
      token: "gh-token",
      dockerLoginRc: 0,
      dockerInspectRc: 1, // marker not found
    });
    expect(out.status).toBe(0);
    expect(registryOf(starts(out)[0])).toBe("public.ecr.aws");
    expect(out.output).toContain("::warning::");
    expect(out.output).toContain("not found");
  });

  it("falls back to public.ecr.aws when `docker login` itself fails", () => {
    const out = runAction(0, {
      token: "gh-token",
      dockerLoginRc: 1,
    });
    expect(out.status).toBe(0);
    expect(registryOf(starts(out)[0])).toBe("public.ecr.aws");
    expect(out.output).toContain("::warning::");
    expect(out.output).toContain("docker login ghcr.io");
    // A failed login must not even attempt the marker probe.
    expect(out.calls.some((c) => c.includes("imagetools"))).toBe(false);
  });

  it("falls back to public.ecr.aws when the CLI version or major_version can't be resolved", () => {
    const out = runAction(0, {
      token: "gh-token",
      nodeRc: 1, // `node -p` fails, as it would with no node_modules/supabase yet
    });
    expect(out.status).toBe(0);
    expect(registryOf(starts(out)[0])).toBe("public.ecr.aws");
    expect(out.output).toContain("::warning::");
    expect(out.output).toContain("could not resolve");
    expect(out.calls.some((c) => c.includes("imagetools"))).toBe(false);
  });

  it("a first-attempt GHCR failure falls back to ECR WITHOUT spending a retry", () => {
    // `failures=1`: the very first `start` call fails, every later one
    // succeeds. With the marker present, that first call runs against GHCR;
    // the free fallback then retries against public.ecr.aws immediately —
    // still attempt 1 of the caller's budget.
    const out = runAction(1, {
      token: "gh-token",
      dockerInspectRc: 0,
      attempts: "3",
    });
    expect(out.status).toBe(0);
    expect(starts(out)).toHaveLength(2);
    expect(registryOf(starts(out)[0]), "the failed attempt was against GHCR").toBe("ghcr.io/acme");
    expect(registryOf(starts(out)[1]), "the recovering attempt was against ECR").toBe(
      "public.ecr.aws",
    );
    expect(stops(out), "the fallback tears the half-started GHCR attempt down").toHaveLength(1);
    expect(out.output).toContain("at no cost to the retry budget");
  });

  it("remaining ECR attempts keep the caller's full budget after that free fallback", () => {
    // Every attempt fails now, GHCR and ECR alike. The free GHCR attempt must
    // not shrink the 3 ECR attempts the caller asked for, and the final
    // error must still say "3", not "4".
    const out = runAction(Number.POSITIVE_INFINITY, {
      token: "gh-token",
      dockerInspectRc: 0,
      attempts: "3",
    });
    expect(out.status).not.toBe(0);
    expect(starts(out), "1 free GHCR attempt + the full 3-attempt ECR budget").toHaveLength(4);
    expect(
      starts(out)
        .slice(1)
        .every((c) => registryOf(c) === "public.ecr.aws"),
    ).toBe(true);
    expect(
      stops(out),
      "one fallback stop + two between-retry stops, none after the last",
    ).toHaveLength(3);
    expect(out.output).toContain("failed on all 3 attempt(s)");
  });
});

describe("the `exclude` default, which is now the only place the set is written", () => {
  // Both inline `--exclude` lists were deleted from ci.yml when the two jobs
  // moved onto this action, so this default is the single source of truth for
  // which services the CI stack skips — and nothing fenced it.

  /** The CLI's own accepted `--exclude` names. */
  //
  // Not invented: this is the list `supabase start` printed in run 33260290131
  // (2026-08-29) when it rejected a name, quoted verbatim.
  //
  //   Valid containers to exclude are: edge-runtime, gotrue, imgproxy, kong,
  //   logflare, mailpit, postgres-meta, postgrest, realtime, storage-api,
  //   studio, supavisor, vector
  //
  // An unrecognised name is a WARNING, not an error — the CLI shrugs and starts
  // the service. So a typo here is invisible in a green job, which is how
  // `inbucket` (renamed `mailpit` upstream) survived in the list long enough to
  // be copied into two workflows.
  const CLI_EXCLUDABLE = [
    "edge-runtime",
    "gotrue",
    "imgproxy",
    "kong",
    "logflare",
    "mailpit",
    "postgres-meta",
    "postgrest",
    "realtime",
    "storage-api",
    "studio",
    "supavisor",
    "vector",
  ];

  /** The literal `default:` of the named input, read from the shipped YAML. */
  function inputDefault(name: string): string {
    const lines = readFileSync(ACTION, "utf8").split("\n");
    const at = lines.findIndex((l) => new RegExp(`^\\s{2}${name}:\\s*$`).test(l));
    expect(at, `${ACTION} declares no \`${name}:\` input`).toBeGreaterThan(-1);
    for (const line of lines.slice(at + 1)) {
      if (/^\s{2}\S/.test(line)) break; // next input at the same indent
      const hit = line.match(/^\s+default:\s*(.+?)\s*$/);
      if (hit) return hit[1].replace(/^["']|["']$/g, "");
    }
    throw new Error(`${ACTION}: input \`${name}\` has no \`default:\``);
  }

  it("excludes exactly the four services CI means to skip", () => {
    // Pinned as a literal because there is nowhere left to derive it from. A
    // change here changes what two jobs bring up, so it should cost a red.
    expect(inputDefault("exclude")).toBe("studio,imgproxy,edge-runtime,realtime");
  });

  it("names only services the CLI actually accepts — a typo is only a warning", () => {
    const names = inputDefault("exclude").split(",");
    expect(names, "empty or whitespace-padded entry").toEqual(names.map((n) => n.trim()));
    const rejected = names.filter((n) => !CLI_EXCLUDABLE.includes(n));
    expect(
      rejected,
      "`supabase start` warns and starts the service anyway, so this never goes red in CI",
    ).toEqual([]);
  });

  it("carries the other two inputs' defaults, which the retry's arithmetic depends on", () => {
    expect(inputDefault("attempts")).toBe("3");
    expect(inputDefault("backoff-seconds")).toBe("15");
  });
});

describe("who calls the action — the property the whole change is justified by", () => {
  // "Two copies of a start step is how the two jobs drift" is the argument for
  // this action existing, and nothing measured it. These two cases do.

  it("is used by exactly the two ci.yml jobs, and by nothing else", () => {
    const sites = workflowFiles().flatMap((f) =>
      stepsUsing(f, "./.github/actions/supabase-start").map(() => f),
    );
    expect(sites, "the action's call sites moved").toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/ci.yml",
    ]);
  });

  it("leaves no hand-rolled `supabase start` step in this repository", () => {
    // The two that were pinned here lived in panorama-qa-nightly.yml, which
    // moved to the private companion repository on 2026-09-24
    // (dim-interno:.github/workflows/panorama-qa-nightly.yml). It still starts
    // the stack inline there with its own copy of the exclude list — the drift
    // this action prevents is live between ci.yml and that nightly. Here the
    // count is zero, and a new inline copy in this repository goes red.
    const raw = workflowFiles().flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/^\s*run:.*supabase start/gm)].map(() => f),
    );
    expect(raw).toEqual([]);
  });
});

describe("the retry wrapper's shape", () => {
  it("never ends the pipeline in `|| true`, which would swallow the verdict", () => {
    // `|| true` is legitimate on the TEARDOWN (there may be nothing to stop)
    // and nowhere else. Anything tolerating a failed `start` is the disease.
    for (const line of step().script.split("\n")) {
      if (!line.includes("|| true")) continue;
      expect(line, "`|| true` outside the teardown").toContain("stop");
    }
  });

  it("is not wired with `continue-on-error` at any call site", () => {
    // The loop can be perfect and still be neutralised one level up.
    //
    // The WHOLE step is inspected, not the text after `uses:`. The first cut of
    // this assertion read 400 characters FORWARD from the `uses:` line, and a
    // `continue-on-error: true` written one line ABOVE it walked straight past
    // — YAML mapping keys are unordered, so "after the uses" is not a place a
    // step's keys have to be. That mutation was applied and the test stayed
    // green, which is the only reason this comment exists.
    const sites = workflowFiles().flatMap((f) => stepsUsing(f, "./.github/actions/supabase-start"));
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site, "a call site can silence the retry's verdict").not.toContain(
        "continue-on-error",
      );
    }
  });
});

// 2026-09-30, CI run 36666342759: an input's `description:` quoted the
// github-token expression in prose, and GitHub EVALUATES expressions in an
// action's metadata — the action failed to load ("Unrecognized named-value:
// 'github'") and took down every job that starts the local stack. Local YAML
// parsing cannot see it; only the runner does. So the metadata is fenced here:
// an expression may appear only where the runner is meant to evaluate it.
describe("action metadata", () => {
  it("carries no ${{ }} expression inside any input description", () => {
    const yaml = readFileSync(ACTION, "utf8");
    const inputsBlock = yaml.slice(yaml.indexOf("\ninputs:"), yaml.indexOf("\nruns:"));
    expect(inputsBlock.length, "the inputs block was found").toBeGreaterThan(100);
    expect(inputsBlock).not.toContain("${{");
  });
});
