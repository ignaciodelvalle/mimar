// Scheduled-fence ref parity.
//
// THE INVARIANT
// ---------------------------------------------------------------------------
//   A scheduled fence must check out the code it is meant to guard, must say so
//   out loud when it is red, and a workflow that is not on the default branch
//   does not run at all.
//
// Three parts. The first two are properties of GitHub's `schedule:` trigger and
// both are invisible until somebody goes looking; the third is the alarm, which
// CONTRIBUTING.md asked for from 2026-08-27 and nothing enforced until
// 2026-08-28 (see ALERT_EXEMPT and {@link alertFindings}):
//
//   · A `schedule:` event fires ONLY from the repository's DEFAULT branch, and
//     `actions/checkout` with no `ref:` checks that branch out. This repo ships
//     staging from an integration branch. Measured 2026-08-27, `main` was 3876
//     commits and three weeks behind it — so every nightly was grading code that
//     nobody was running, against an app built from code it had never seen.
//   · A workflow file that is absent from the default branch has no schedule.
//     Not a late schedule — none. It sits in the repo looking exactly like a
//     fence and has never executed once. GitHub is blunt about it if you ask:
//     `gh run list --workflow panorama-qa-nightly.yml` answers `HTTP 404:
//     workflow not found on the default branch` (measured 2026-08-28).
//   · And a scheduled run executes the DEFAULT BRANCH'S COPY of the file. Not
//     just its presence — its CONTENT. A pin, an alert job, or a lint step that
//     exists only on the integration branch does nothing on a timer, however
//     right it looks in the working tree. That includes this fence. See the
//     "Is any of this LIVE?" section near the bottom.
//
// WHAT IT ACTUALLY COST, BEFORE THE FIX
// ---------------------------------------------------------------------------
//   e2e-nightly.yml         20 runs, 20 failures. `65815dcb6` renamed /login to
//                           /iniciar-sesion with a 308; main's `loginAs` waits
//                           for the path to stop starting with "/login", which
//                           is true the instant the redirect lands, so it cached
//                           an anonymous session. Fixed 2026-08-10 in
//                           `63c093065`. The nightly never checked that out.
//   db-doctor-staging.yml   12 runs, 12 failures. Main's tree stops at migration
//                           0170; staging has 0202 applied. Section A reported
//                           every migration in between as "in the ledger, NOT on
//                           disk" — an alarm about nothing. Sections B and C,
//                           which ask the database directly and do not read the
//                           checked-out tree, passed in the same run.
//   mobile-export-nightly   0 runs. Never on the default branch.
//   panorama-qa-nightly     0 runs. Never on the default branch.
//
// WHY A LITERAL BRANCH NAME AND NOT A REPOSITORY VARIABLE
// ---------------------------------------------------------------------------
// A `${{ vars.DEPLOY_BRANCH }}` would put the name in one place, and it is the
// wrong trade. An unset or misspelled variable interpolates to the EMPTY STRING,
// and `actions/checkout` treats an empty `ref:` as "use the default branch" —
// silently reintroducing the exact bug, with the added insult that the workflow
// now looks correct. A literal that stops naming a branch makes checkout fail
// with `couldn't find remote ref`, which is loud.
//
// So the literals stay, and THIS FILE is the one place that knows what they must
// all say. Rename or merge the branch and `pnpm lint:sched-refs` fails naming
// every workflow line to change. One place to edit; N places verified.
// Staging-facing nightlies live in dim-interno:.github/workflows/ (2026-09-24); not scanned here.
// Run:  pnpm tsx scripts/check-scheduled-fence-refs.ts   (or: pnpm lint:sched-refs)

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const WORKFLOW_DIR = ".github/workflows";

/** The repository's default branch — the only branch `schedule:` fires from. */
export const DEFAULT_BRANCH = "main";

/**
 * The branch staging is deployed from: the code every scheduled fence is meant
 * to guard. THIS is the single source of truth for the `ref:` literals in
 * `.github/workflows/*.yml`.
 *
 * `main` since 2026-09-01: the PO repointed Vercel's Production Branch after
 * the pre-test audit measured 13 of 33 /api/v1 routes missing from the frozen
 * integration tree. `integration/all-20260703` was 0 commits ahead at the
 * switch, so nothing was stranded. DEPLOY_REF now equals DEFAULT_BRANCH — the
 * pins are momentarily redundant, and they STAY: the fence keeps every
 * scheduled workflow's checkout tied to this constant, so the next branch
 * divergence is a one-line change here instead of a silent regrade of stale
 * code (which is how this file earned its existence).
 */
export const DEPLOY_REF = "main";

/**
 * The local composite action every scheduled fence must wire, spelled exactly as
 * a `uses:` value. CONTRIBUTING.md tells every contributor to add it to any new
 * scheduled gate; {@link alertFindings} is what makes that instruction true
 * instead of aspirational.
 */
export const ALERT_ACTION = "./.github/actions/red-streak-alert";

export type Exemption = { workflow: string; reason: string };

/**
 * Scheduled workflows that deliberately run the DEFAULT branch's tree.
 *
 * An entry here is a claim that running stale-relative-to-staging code is the
 * CORRECT behaviour for that workflow — not that pinning was inconvenient. It is
 * checked in both directions: the workflow must exist, must be scheduled, and
 * must NOT be pinned. Pin it later without deleting the entry and this fails,
 * so the exemption cannot outlive the argument that justified it.
 */
export const REF_EXEMPT: Exemption[] = [
  {
    workflow: "codeql.yml",
    reason:
      "CodeQL uploads SARIF against the ref that TRIGGERED the run. On a schedule that is " +
      "refs/heads/main; checking out an integration branch there files findings against main " +
      "for code not in main, poisoning the default-branch baseline with alerts no fix can " +
      "close. The weekly scan is a default-branch scan by design. The live tree is covered " +
      "the correct way instead — codeql.yml's push: trigger includes integration/**, where " +
      "github.ref is the integration branch and attribution is right.",
  },
];

/**
 * Scheduled workflows known to be ABSENT from the default branch, and therefore
 * not running at all. Only a merge to `${DEFAULT_BRANCH}` clears one of these —
 * no `ref:` can, because there is no schedule to give a ref to.
 *
 * Checked in both directions where the default branch is visible: an entry for a
 * workflow that HAS reached the default branch is stale and fails. A scheduled
 * workflow absent from the default branch with no entry here also fails, so a
 * newly added nightly cannot quietly join the two below.
 */
// EMPTY since 2026-08-28, and that emptiness is the point.
//
// Both entries — mobile-export-nightly.yml and panorama-qa-nightly.yml — were
// cleared the only way an entry here can be cleared: `main` was moved to the
// integration tip (`a3ec504c5`), so the two files reached the default branch and
// their schedules became real. The fence caught its own staleness within minutes
// of that push, in the reverse direction it was built to check, and named both
// files. That reverse check earned its keep on the first occasion it had.
//
// Adding an entry here is not a way to silence a red. It asserts that a
// scheduled workflow is ABSENT from `${DEFAULT_BRANCH}` — a claim the fence
// verifies against the default branch and fails if untrue.
export const NOT_ON_DEFAULT_BRANCH: Exemption[] = [];

/**
 * Scheduled workflows that deliberately ship WITHOUT `red-streak-alert`.
 *
 * CONTRIBUTING.md tells everyone to wire the alert into any new scheduled gate,
 * and until 2026-08-28 nothing checked it: the test asserted the wiring for the
 * two workflows that already had it, so the instruction was enforced exactly
 * where it was already followed. {@link alertFindings} closes that, and an entry
 * here is the only way out — with the argument written down.
 *
 * Checked in both directions, like {@link REF_EXEMPT}: the workflow must exist,
 * must be scheduled, and must NOT wire the alert. Wire it later without deleting
 * the entry and this fails, so the exemption cannot outlive its reason.
 *
 * Run counts below are reproducible, not remembered:
 *   gh api "repos/<owner>/<repo>/actions/workflows/<file>/runs?per_page=1" --jq .total_count
 *   gh api "repos/<owner>/<repo>/actions/workflows/<file>/runs?per_page=1&status=failure" --jq .total_count
 */
export const ALERT_EXEMPT: Exemption[] = [
  {
    workflow: "staging-health.yml",
    reason:
      "The ONE workflow here for which GitHub's built-in green->red transition mail actually " +
      "fires, because it is the only one with dense green history to transition FROM: measured " +
      "2026-08-28, 588 runs, 3 failures (2026-08-09 and two on 2026-08-16), each an isolated red " +
      "between greens. The streak alert exists to cover fences whose FIRST run was red and that " +
      "therefore never transition; that is not this one. The cost of wiring it anyway is real and " +
      "one-sided: the health poll is a */15 cron, so an alert job would add ~96 checkouts a day to " +
      "re-derive a signal that already arrives. Revisit if this workflow ever goes red twice in a " +
      "row — a streak is precisely what the mail handles badly.",
  },
  {
    workflow: "codeql.yml",
    reason:
      "Runs on `push:` to main, develop AND integration/** as well as the weekly cron, so a broken " +
      "scan turns the very next push red the same day — it cannot sit silently red for twenty " +
      "nights, which is the failure mode the alert exists for. Measured 2026-08-28: 484 runs, 0 " +
      "failures. There is also a mechanical reason: the alert job needs `actions/checkout` to " +
      "resolve the local composite action, and codeql.yml is in REF_EXEMPT, whose bidirectional " +
      "check reads ANY pinned checkout in the file as a broken exemption. Wiring the alert here " +
      "would mean loosening that check to per-job parsing — trading a fence that is exact for one " +
      "that is approximate, to cover a workflow that is already covered by push.",
  },
];

// ---------------------------------------------------------------------------
// Parsing. Deliberately line-based rather than a YAML AST: the thing being
// checked is a literal a human wrote on a line, and a line-based check is one a
// human can confirm by eye against the same file.
// ---------------------------------------------------------------------------

/**
 * Strip `#` comments. Done FIRST everywhere below: these workflow files document
 * themselves at length, and a `ref:` that appears only inside prose is exactly
 * the false pass this fence exists to prevent.
 */
export function stripComments(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
}

/**
 * True when the workflow is scheduled.
 *
 * TWO detectors, and the second one is the point. Every file in this repo writes
 * the block form (`  schedule:` as a 2-space key under `on:`), so a fence that
 * matched only that would pass today and go silently vacuous the moment somebody
 * wrote `on: {schedule: [{cron: "0 6 * * *"}]}` — a workflow that IS scheduled
 * and that the fence would simply not see. That is this repo's own recorded
 * mistake: a fence that enumerates the SPELLINGS misses one; fence the SUBJECT.
 *
 * The subject is "this workflow runs on a timer", and the thing a timer cannot
 * be written without is a `cron` key. It fails closed: a `workflow_dispatch`
 * input that happened to be named `cron` would be treated as scheduled and
 * demand a pin, which a human then either adds or exempts with a reason. Being
 * asked an unnecessary question is the cheap error here; not being asked the
 * necessary one is what cost 32 red nights.
 */
export function hasSchedule(yaml: string): boolean {
  const source = stripComments(yaml);
  return /^ {2}schedule:\s*$/m.test(source) || /(?:^|[\s{,[])cron\s*:/m.test(source);
}

/**
 * True when the workflow actually WIRES the red-streak alert — a `uses:` line,
 * not a mention.
 *
 * Comments are stripped first for the reason the whole file strips them: these
 * workflows carry pages of prose about alerting, and every one of them names the
 * action in a paragraph explaining why it exists. A fence that counted prose
 * would pass on all seven files and check nothing.
 */
export function wiresAlert(yaml: string): boolean {
  return new RegExp(
    `^\\s*(?:-\\s+)?uses:\\s*${ALERT_ACTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "m",
  ).test(stripComments(yaml));
}

export type CheckoutStep = {
  /** 1-based line of the step's first line, for the error message. */
  line: number;
  /** The step's `name:`, or a placeholder when it has none. */
  name: string;
  /** The `ref:` value with surrounding quotes removed, or null when absent. */
  ref: string | null;
};

/**
 * Every `actions/checkout` step in the file, with the `ref:` it carries.
 *
 * A step runs from its `- ` bullet until the next line at or left of the
 * bullet's column, which is how YAML block sequences nest — no parser needed and
 * no dependency added.
 */
export function checkoutSteps(yaml: string): CheckoutStep[] {
  const lines = stripComments(yaml).split("\n");
  const steps: CheckoutStep[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:-\s+)?uses:\s*actions\/checkout@/.test(lines[i])) continue;

    let start = i;
    while (start >= 0 && !/^\s*-\s/.test(lines[start])) start--;
    if (start < 0) start = i;
    const bulletColumn = lines[start].search(/\S/);

    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() === "") {
        end++;
        continue;
      }
      if (line.search(/\S/) <= bulletColumn) break;
      end++;
    }

    const block = lines.slice(start, end);
    const nameLine = block.find((l) => /^\s*-?\s*name:\s*\S/.test(l));
    const refLine = block.find((l) => /^\s*ref:\s*\S/.test(l));

    steps.push({
      line: start + 1,
      name: nameLine ? nameLine.replace(/^\s*-?\s*name:\s*/, "").trim() : "(unnamed step)",
      ref: refLine
        ? refLine
            .replace(/^\s*ref:\s*/, "")
            .trim()
            .replace(/^["']|["']$/g, "")
        : null,
    });

    i = end - 1;
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Git. Every git-backed check states whether it RAN or was skipped, and why.
// A skipped check is reported as skipped, never folded into the pass.
// ---------------------------------------------------------------------------

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Workflow file names present on the default branch, or null when it is not visible. */
export function workflowsOnDefaultBranch(): string[] | null {
  for (const ref of [`origin/${DEFAULT_BRANCH}`, DEFAULT_BRANCH]) {
    const out = git(["ls-tree", "--name-only", ref, `${WORKFLOW_DIR}/`]);
    if (out === null) continue;
    return out
      .split("\n")
      .filter(Boolean)
      .map((path) => path.split("/").pop() as string);
  }
  return null;
}

/**
 * The default branch's COPY of a workflow file, or null when the file is not on
 * that branch (or the branch is not visible).
 *
 * Presence is not the question this answers — {@link workflowsOnDefaultBranch}
 * answers that. This one exists because a scheduled run executes the DEFAULT
 * BRANCH'S CONTENT of the workflow file, so a pin, an alert job, or a fence step
 * that lives only on this branch does nothing on a schedule, however correct it
 * looks in the working tree.
 */
export function defaultBranchWorkflowYaml(file: string): string | null {
  for (const ref of [`origin/${DEFAULT_BRANCH}`, DEFAULT_BRANCH]) {
    const out = git(["show", `${ref}:${WORKFLOW_DIR}/${file}`]);
    if (out !== null) return out;
  }
  return null;
}

/**
 * How long to wait for the remote before giving up and reporting SKIPPED.
 *
 * This check runs inside `pnpm verify`, which is the Definition of Done for
 * every commit, so it may never become the reason a developer's gate hangs. A
 * timeout is answered as "cannot answer", never as "the branch is gone".
 */
const LS_REMOTE_TIMEOUT_MS = 10_000;

/**
 * Runs git and reports its EXIT STATUS, not just its output.
 *
 * {@link git} folds every failure into `null`, which is the right shape for the
 * ls-tree/show readers above: there, "no output" and "no such ref" are the same
 * answer. It is the wrong shape for a check whose entire job is to tell "the
 * remote answered, and it has no such branch" apart from "git could not reach
 * the remote at all" — two states that must produce opposite verdicts.
 *
 * Returns null only when git could not be run to completion (not on disk,
 * killed by a signal, or past {@link LS_REMOTE_TIMEOUT_MS}).
 */
function gitExitStatus(args: string[]): number | null {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: LS_REMOTE_TIMEOUT_MS,
    // A remote that wants credentials must fail rather than block on a prompt
    // no one is watching — inside `pnpm verify` there is nobody to type.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status === null) return null;
  return result.status;
}

/**
 * The pure core of {@link deployRefResolves}: `git ls-remote --exit-code`'s exit
 * status, mapped to the fence's three states.
 *
 * Separated out because the mapping is the load-bearing part and it is not
 * testable through the network call. Its exit codes, per git-ls-remote(1):
 *
 *   0        the remote listed the ref — the branch is there.
 *   2        `--exit-code`: the remote ANSWERED and matched no ref. This, and
 *            only this, is the deletion the fence exists to catch.
 *   other    128 and friends: no remote configured, no network, auth refused,
 *            a repository that is not a repository. git did not find out.
 *
 * Collapsing the third row into `false` is exactly the bug fixed here, one
 * layer down. Anything that is not a definite yes or a definite no is null.
 */
export function deployRefVerdict(status: number | null): boolean | null {
  if (status === 0) return true;
  if (status === 2) return false;
  return null;
}

/**
 * True/false when the deploy ref is resolvable/unresolvable; null when git
 * cannot answer.
 *
 * Asks the REMOTE, and that is the fix. The previous version read this clone's
 * local refs (`refs/remotes/origin/<DEPLOY_REF>`, then `refs/heads/<DEPLOY_REF>`)
 * behind a guard on origin/<DEFAULT_BRANCH> being visible — a guard that tests
 * the visibility of a DIFFERENT ref from the one being judged. On a CI run
 * triggered by a push to the default branch, `actions/checkout` with no
 * `fetch-depth` fetches only the triggering ref: origin/main IS visible and
 * origin/<DEPLOY_REF> is NOT. So the guard passed, the local lookup missed, and
 * the fence announced `DEPLOY_REF ... no longer names a branch` about a branch
 * that was alive the whole time. Its own comment stated the correct rule — "I
 * cannot see it" must not be reported as "it is gone" — while the code
 * implemented it against the wrong ref.
 *
 * `ls-remote` puts the question to the server, so the answer stops depending on
 * what the checkout happened to fetch. Three states, kept distinct in
 * {@link deployRefVerdict}; the caller only ever reports on an exact `false`.
 */
export function deployRefResolves(): boolean | null {
  return deployRefVerdict(
    gitExitStatus(["ls-remote", "--exit-code", "origin", `refs/heads/${DEPLOY_REF}`]),
  );
}

// ---------------------------------------------------------------------------

export type Finding = { workflow: string; problem: string };

export function scheduledWorkflows(dir = WORKFLOW_DIR): { file: string; yaml: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((file) => ({ file, yaml: readFileSync(join(dir, file), "utf8") }))
    .filter(({ yaml }) => hasSchedule(yaml));
}

/** The pure core: everything checkable from the workflow files alone. */
export function refFindings(workflows: { file: string; yaml: string }[]): Finding[] {
  const findings: Finding[] = [];
  const exemptNames = new Set(REF_EXEMPT.map((e) => e.workflow));

  for (const { file, yaml } of workflows) {
    const steps = checkoutSteps(yaml);
    if (exemptNames.has(file)) {
      const pinned = steps.filter((s) => s.ref !== null);
      if (pinned.length > 0) {
        findings.push({
          workflow: file,
          problem: `is listed in REF_EXEMPT but now pins a ref (${pinned.map((s) => s.ref).join(", ")}). Delete the exemption in scripts/check-scheduled-fence-refs.ts, or delete the pin — an exemption that no longer describes the file is worse than none.`,
        });
      }
      continue;
    }
    for (const step of steps) {
      if (step.ref === DEPLOY_REF) continue;
      findings.push({
        workflow: file,
        problem: `line ${step.line}, step "${step.name}": checkout ${step.ref === null ? "carries no `ref:`" : `pins \`${step.ref}\``}, expected \`ref: ${DEPLOY_REF}\`. A schedule checks out the DEFAULT branch, so an unpinned scheduled fence grades code nobody is running.`,
      });
    }
  }

  return findings;
}

/**
 * List hygiene, kept separate from {@link refFindings} so each can be exercised
 * on its own. An exemption naming a workflow that no longer exists (or no longer
 * has a `schedule:`) is a lie the next reader will believe, so it fails.
 */
export function exemptionFindings(workflows: { file: string; yaml: string }[]): Finding[] {
  const scheduledNames = new Set(workflows.map((w) => w.file));
  const stale = (list: Exemption[], name: string) =>
    list
      .filter((e) => !scheduledNames.has(e.workflow))
      .map(({ workflow }) => ({
        workflow,
        problem: `is in ${name} but is not a scheduled workflow (renamed, deleted, or its \`schedule:\` trigger was removed). Remove the stale entry.`,
      }));
  return [...stale(REF_EXEMPT, "REF_EXEMPT"), ...stale(ALERT_EXEMPT, "ALERT_EXEMPT")];
}

/**
 * Every scheduled workflow either wires the red-streak alert or is in
 * {@link ALERT_EXEMPT} with the argument for why it does not.
 *
 * This is the enforcement CONTRIBUTING.md's "Also give it an alarm" paragraph
 * was missing: the doc has asked for the wiring since 2026-08-27, while the only
 * check was a test naming the two workflows that already had it — a rule
 * enforced exactly where it was already followed.
 *
 * Both directions, like {@link refFindings}: an exemption for a workflow that
 * now wires the alert is stale and fails. The other staleness — an exemption
 * naming a workflow that is not scheduled at all — lives in
 * {@link exemptionFindings} with the ref-exemption one, so both lists are
 * audited by the same code.
 */
export function alertFindings(workflows: { file: string; yaml: string }[]): Finding[] {
  const findings: Finding[] = [];
  const exempt = new Set(ALERT_EXEMPT.map((e) => e.workflow));

  for (const { file, yaml } of workflows) {
    const wired = wiresAlert(yaml);
    if (exempt.has(file)) {
      if (wired) {
        findings.push({
          workflow: file,
          problem: `is in ALERT_EXEMPT but now wires ${ALERT_ACTION}. Delete the exemption in scripts/check-scheduled-fence-refs.ts, or delete the wiring — an exemption that no longer describes the file is worse than none.`,
        });
      }
      continue;
    }
    if (!wired) {
      findings.push({
        workflow: file,
        problem: `is a scheduled fence with no \`uses: ${ALERT_ACTION}\`. GitHub's failed-workflow mail fires on the green->red TRANSITION, so a fence whose first run is red never mails anybody — that is how 32 consecutive failures went unannounced. Wire the alert (see mobile-export-nightly.yml) or add it to ALERT_EXEMPT with the reason.`,
      });
    }
  }

  return findings;
}

/**
 * A guard-skipped job reports SUCCESS, and the alert action reads a success as
 * recovery. So a workflow that both (a) skips steps behind a step-level guard
 * and (b) wires the alert MUST tell the action whether it actually audited
 * anything, or a night that ran nothing closes the open alert with "Green
 * again". That is what db-doctor-staging.yml (now in dim-interno) did until 2026-08-28.
 *
 * The guard can ONLY be a step-level `if:` reading a step output: `secrets` is
 * not in the context available to a job-level `if:` (GitHub's context table
 * gives `jobs.<id>.if` only `github`, `needs`, `vars`, `inputs`), so a job that
 * decides on a secret has to test the secret in a step and publish the verdict.
 *
 * The subject is therefore "an `if:` that consults a step's output", and the
 * detector matches THAT, not one spelling of it. Both of these are the same
 * guard and both must be caught:
 *
 *     if: steps.guard.outputs.run == 'true'
 *     if: ${{ steps.guard.outputs.run == 'true' }}
 *
 * The first version of this detector required `steps.` immediately after `if:`
 * and so was blind to the second — a silent pass, unlike wiresAlert() whose
 * narrowness fails loud. Found in review 2026-08-28, before it could bite.
 */
/**
 * An `if:` whose expression consults a step's output, in either YAML spelling.
 * Exported so the test can assert both forms against the one regex rather than
 * re-typing it.
 */
export const STEP_OUTPUT_GUARD = /^\s*if:[^#\n]*\bsteps\.[A-Za-z0-9_-]+\.outputs\b/m;

export function auditedFindings(workflows: { file: string; yaml: string }[]): Finding[] {
  const findings: Finding[] = [];
  for (const { file, yaml } of workflows) {
    if (!wiresAlert(yaml)) continue;
    const source = stripComments(yaml);
    if (!STEP_OUTPUT_GUARD.test(source)) continue;
    const wiring = source.slice(source.indexOf(ALERT_ACTION));
    if (!/^\s*audited:\s*\S/m.test(wiring)) {
      findings.push({
        workflow: file,
        problem: `skips steps behind an \`if: steps.<id>...\` guard and wires ${ALERT_ACTION}, but passes no \`audited:\`. A guard-skipped job reports SUCCESS, and the action reads a success as recovery — so a night that audited NOTHING would close the open alert with "Green again". Pass \`audited: \${{ needs.<job>.outputs.audited }}\` from the guard's output.`,
      });
    }
  }
  return findings;
}

/**
 * The default-branch half of the invariant. Returns null when it could not be
 * checked.
 *
 * `waiting` defaults to the live {@link NOT_ON_DEFAULT_BRANCH}, which is what
 * every production caller uses. It is a parameter so a test can state its own
 * fixture: the behaviour here ("an entry that has since been merged is
 * flagged") is a property of the function, not of whatever the real list
 * happens to hold today, and a test that reached into the live list for a
 * sample died with a TypeError on the day that list correctly emptied.
 */
export function defaultBranchFindings(
  workflows: { file: string; yaml: string }[],
  onDefault: string[] | null,
  waiting: Exemption[] = NOT_ON_DEFAULT_BRANCH,
): Finding[] | null {
  const listed = new Set(waiting.map((e) => e.workflow));
  const scheduledNames = new Set(workflows.map((w) => w.file));
  const findings: Finding[] = [];

  // Checkable with or without git: the list must describe real files.
  for (const { workflow } of waiting) {
    if (!scheduledNames.has(workflow)) {
      findings.push({
        workflow,
        problem:
          "is in NOT_ON_DEFAULT_BRANCH but is not a scheduled workflow in this tree. " +
          "Remove the stale entry.",
      });
    }
  }

  if (onDefault === null) return findings.length > 0 ? findings : null;

  const present = new Set(onDefault);
  for (const { file } of workflows) {
    if (present.has(file)) {
      if (listed.has(file)) {
        findings.push({
          workflow: file,
          problem: `has reached ${DEFAULT_BRANCH} — its schedule is live now. Remove it from NOT_ON_DEFAULT_BRANCH in scripts/check-scheduled-fence-refs.ts and from the workflow header that says it never runs.`,
        });
      }
      continue;
    }
    if (!listed.has(file)) {
      findings.push({
        workflow: file,
        problem: `is absent from ${DEFAULT_BRANCH}, so its \`schedule:\` trigger DOES NOT EXIST — it has never run and never will until it is merged. Merge it, or add it to NOT_ON_DEFAULT_BRANCH with the reason it is still waiting.`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Is any of this LIVE?
//
// The half this fence got wrong about itself. Until 2026-08-28 the pass line
// read "N pinned ... 2 workflow(s) still waiting to be merged there", which a
// reader takes to mean the pins are done and only two absent files are waiting.
//
// They are not. A `schedule:` event runs the DEFAULT BRANCH'S COPY of the
// workflow file. Measured 2026-08-28 with:
//     git show origin/main:.github/workflows/e2e-nightly.yml
// main's copies of e2e-nightly, db-doctor-staging, staging-health and codeql
// contain ZERO occurrences of `ref:`, zero of `red-streak`, and main's ci.yml
// zero of `sched-refs`. So on a schedule, none of it exists: not the pins, not
// the alert jobs, and not this fence. Only a merge changes that.
//
// WHY THIS WARNS INSTEAD OF FAILING
// ---------------------------------------------------------------------------
// `lint:sched-refs` runs inside `pnpm verify`, which is this repo's Definition
// of Done for EVERY commit. Failing on "not yet merged to main" would make every
// commit on the integration branch red for a condition no edit in that branch
// can clear — three weeks of guaranteed red, which is how a fence teaches people
// to pass `--no-verify` and stop reading it. That is the same disease one level
// up. So it warns; but it warns in the PASS output, with counts and names, and
// the summary line above it no longer says anything that implies otherwise.
// ---------------------------------------------------------------------------

export type LivenessRow = {
  file: string;
  /** Present on the default branch at all — if false it has no schedule to speak of. */
  present: boolean;
  /** This tree pins the checkout to DEPLOY_REF. */
  pinnedHere: boolean;
  /** The default branch's copy pins it too — i.e. the pin is live on a schedule. */
  pinnedThere: boolean;
  /** This tree wires the red-streak alert. */
  alertedHere: boolean;
  /** The default branch's copy wires it too. */
  alertedThere: boolean;
};

/**
 * Compares each scheduled workflow against the default branch's copy of itself.
 *
 * Pure: `copies` maps file name to the default branch's YAML (null = absent), so
 * the whole thing is exercisable without a git repository.
 */
export function livenessRows(
  workflows: { file: string; yaml: string }[],
  copies: Map<string, string | null>,
): LivenessRow[] {
  const pinned = (yaml: string) => checkoutSteps(yaml).some((s) => s.ref === DEPLOY_REF);
  return workflows.map(({ file, yaml }) => {
    const there = copies.get(file) ?? null;
    return {
      file,
      present: there !== null,
      pinnedHere: pinned(yaml),
      pinnedThere: there !== null && pinned(there),
      alertedHere: wiresAlert(yaml),
      alertedThere: there !== null && wiresAlert(there),
    };
  });
}

/**
 * The rows where this branch carries something a scheduled run would not get,
 * with what is missing. An empty result means everything in this tree is live.
 */
export function inertRows(rows: LivenessRow[]): { file: string; missing: string[] }[] {
  return rows
    .map((r) => {
      const missing: string[] = [];
      if (!r.present) missing.push("the file itself (so: no schedule at all)");
      else {
        if (r.pinnedHere && !r.pinnedThere) missing.push("the `ref:` pin");
        if (r.alertedHere && !r.alertedThere) missing.push("the red-streak alert job");
      }
      return { file: r.file, missing };
    })
    .filter((r) => r.missing.length > 0);
}

function runCheck(): void {
  const workflows = scheduledWorkflows();

  if (workflows.length === 0) {
    console.error(
      `✗ check-scheduled-fence-refs: found ZERO scheduled workflows.\n  That is not a pass — it means the scan of ${WORKFLOW_DIR} broke, and a broken\n  scan waves every stale-checkout fence through.`,
    );
    process.exit(1);
  }

  const findings = [
    ...refFindings(workflows),
    ...exemptionFindings(workflows),
    ...alertFindings(workflows),
    ...auditedFindings(workflows),
  ];

  const onDefault = workflowsOnDefaultBranch();
  const branchFindings = defaultBranchFindings(workflows, onDefault);
  if (branchFindings) findings.push(...branchFindings);

  const refResolves = deployRefResolves();
  if (refResolves === false) {
    findings.push({
      workflow: "(all pinned workflows)",
      problem: `DEPLOY_REF \`${DEPLOY_REF}\` no longer names a branch. Every \`ref:\` in the workflows below points at nothing, and actions/checkout will fail on the next scheduled run. Update DEPLOY_REF here and the literal in each file listed above.`,
    });
  }

  if (findings.length > 0) {
    console.error("");
    console.error(
      `✗ Scheduled-fence refs FAILED — ${findings.length} problem(s) across ${workflows.length} scheduled workflow(s):`,
    );
    console.error("");
    for (const f of findings) console.error(`    ${f.workflow}: ${f.problem}`);
    console.error("");
    console.error(
      `  The rule: a scheduled fence must check out the code it is meant to guard, and a\n  workflow that is not on the default branch does not run at all.\n  Single source of truth: DEPLOY_REF in ${"scripts/check-scheduled-fence-refs.ts"}.`,
    );
    console.error("");
    process.exit(1);
  }

  const pinned = workflows.filter((w) => !REF_EXEMPT.some((e) => e.workflow === w.file)).length;
  const alerted = workflows.filter((w) => wiresAlert(w.yaml)).length;
  // "IN THIS TREE" is load-bearing. The old line said "N pinned" full stop, and
  // a pin in this tree is not a pin a scheduled run will ever execute.
  console.log(
    `✓ Scheduled-fence refs — ${workflows.length} scheduled workflow(s) IN THIS TREE: ${pinned} pinned to ` +
      `${DEPLOY_REF} (${REF_EXEMPT.length} ref exemption(s)), ${alerted} wiring the red-streak alert ` +
      `(${ALERT_EXEMPT.length} alert exemption(s)).`,
  );
  console.log(
    onDefault === null
      ? `  · default-branch presence: SKIPPED (origin/${DEFAULT_BRANCH} is not in this clone — a CI checkout fetches only the triggering ref). Runs on a full clone, e.g. \`pnpm verify\`.`
      : `  · default-branch presence: checked against origin/${DEFAULT_BRANCH} — ` +
          `${NOT_ON_DEFAULT_BRANCH.length} of ${workflows.length} absent there, so those have no \`schedule:\` at all.`,
  );
  console.log(
    refResolves === null
      ? `  · ${DEPLOY_REF} resolvable: SKIPPED (git could not reach \`origin\` to ask — no remote, no network, or it did not answer in ${LS_REMOTE_TIMEOUT_MS / 1000}s).`
      : `  · ${DEPLOY_REF} resolvable: yes, per \`git ls-remote origin\`.`,
  );

  // ---- What a scheduled run would ACTUALLY execute. -----------------------
  if (onDefault === null) {
    console.log(
      `  · live on origin/${DEFAULT_BRANCH}: SKIPPED (same reason). Until this runs on a full clone,\n    NOTHING here has been shown to take effect on a schedule.`,
    );
    return;
  }

  const copies = new Map(workflows.map((w) => [w.file, defaultBranchWorkflowYaml(w.file)]));
  const inert = inertRows(livenessRows(workflows, copies));

  if (inert.length === 0) {
    console.log(
      `  · live on origin/${DEFAULT_BRANCH}: yes — every pin and every alert job in this tree is also in the copy a scheduled run executes.`,
    );
    return;
  }

  const lines = [
    `  ! NOT LIVE on origin/${DEFAULT_BRANCH} — ${inert.length} of ${workflows.length} scheduled workflow(s).`,
    `    A schedule runs origin/${DEFAULT_BRANCH}'s COPY of the file, so what is listed below exists`,
    "    only in this branch and does nothing on a timer until the branch is merged.",
    "    This is a WARNING and not a failure on purpose: no edit in this branch can clear it,",
    "    and a fence that is red for three weeks for reasons nobody can fix is a fence people",
    "    learn to skip. It is not, however, a pass — read the list.",
    ...inert.map((r) => `        ${r.file}: missing ${r.missing.join(", ")}`),
  ];
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(
      `::warning::${inert.length} scheduled workflow(s) carry pins or alert jobs that are not on ` +
        `origin/${DEFAULT_BRANCH} and therefore do not run on a schedule: ${inert.map((r) => r.file).join(", ")}`,
    );
  }
}

// Only run when invoked as a CLI; importing from tests must not exit.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-scheduled-fence-refs.ts") ||
    process.argv[1].endsWith("check-scheduled-fence-refs.js"));

if (isMain) {
  try {
    runCheck();
  } catch (err) {
    console.error("✗ check-scheduled-fence-refs: unexpected error:", err);
    process.exit(1);
  }
}
