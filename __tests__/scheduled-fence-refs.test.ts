// Guard for the scheduled-fence ref invariant
// (scripts/check-scheduled-fence-refs.ts).
//
//   A scheduled fence must check out the code it is meant to guard, and a
//   workflow that is not on the default branch does not run at all.
//
// Two halves, both proved here against the REAL `.github/workflows` tree rather
// than only against synthetic strings. The synthetic cases pin the parser; the
// real-tree cases are what actually stop the regression, because the failure
// this file exists to prevent is not "the parser broke" — it is somebody adding
// a nightly with a bare `actions/checkout@v4` and nobody noticing for a month.
//
// The cost of not having this, measured 2026-08-27: e2e-nightly 20 runs / 20
// failures on a login bug fixed 17 days earlier in a commit it never checked
// out; db-doctor 12 runs / 12 failures reporting phantom migration drift because
// main's tree stops at 0170 and staging is at 0202; mobile-export-nightly and
// panorama-qa-nightly at ZERO runs because a workflow absent from the default
// branch has no schedule at all.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALERT_ACTION,
  ALERT_EXEMPT,
  DEFAULT_BRANCH,
  DEPLOY_REF,
  type Exemption,
  NOT_ON_DEFAULT_BRANCH,
  REF_EXEMPT,
  STEP_OUTPUT_GUARD,
  WORKFLOW_DIR,
  alertFindings,
  auditedFindings,
  checkoutSteps,
  defaultBranchFindings,
  defaultBranchWorkflowYaml,
  deployRefVerdict,
  exemptionFindings,
  hasSchedule,
  inertRows,
  livenessRows,
  refFindings,
  scheduledWorkflows,
  wiresAlert,
  workflowsOnDefaultBranch,
} from "@/scripts/check-scheduled-fence-refs";

const PINNED_STEP = `
jobs:
  nightly:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: ${DEPLOY_REF}

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
`;

const BARE_STEP = `
jobs:
  nightly:
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
`;

const ALERT_JOB = `
  alert:
    needs: nightly
    if: always()
    steps:
      - name: Open or update the alert issue
        uses: ${ALERT_ACTION}
        with:
          workflow: nightly.yml
          outcome: \${{ needs.nightly.result }}
`;

/** A workflow whose steps hide behind a secret guard — the shape that no-op-skips. */
const GUARDED = `
jobs:
  nightly:
    outputs:
      audited: \${{ steps.guard.outputs.run }}
    steps:
      - name: Gate on a secret
        id: guard
        run: echo "run=false" >> "$GITHUB_OUTPUT"

      - name: Do the audit
        if: steps.guard.outputs.run == 'true'
        run: pnpm db:doctor
${ALERT_JOB}`;

describe("hasSchedule", () => {
  it("sees a schedule trigger", () => {
    expect(hasSchedule('on:\n  schedule:\n    - cron: "0 6 * * *"\n')).toBe(true);
  });

  it("does not see one in a workflow that only runs on push and pull_request", () => {
    expect(hasSchedule("on:\n  push:\n    branches: [main]\n  pull_request:\n")).toBe(false);
  });

  // These workflow files carry pages of prose about crons. A schedule mentioned
  // in a comment is not a schedule — and `ci.yml` really does discuss cron in a
  // comment while having no schedule of its own.
  it("does not mistake a commented-out schedule for a real one", () => {
    expect(hasSchedule("on:\n  push:\n# on:\n#   schedule:\n#     - cron: '0 6 * * *'\n")).toBe(
      false,
    );
  });

  // The vacuity hole, closed on purpose. Matching only the block key would let a
  // flow-style schedule through unseen — a workflow that IS scheduled and that
  // the fence would not even look at. Fence the subject (a timer needs a `cron`
  // key), not one of its spellings.
  it("catches a flow-style schedule, where the block key never appears", () => {
    expect(hasSchedule(`on: {schedule: [{cron: "0 6 * * *"}]}\n`)).toBe(true);
  });

  it("catches `schedule:` written inline with its cron on the same nesting", () => {
    expect(hasSchedule('on:\n  schedule: [{cron: "0 6 * * *"}]\n')).toBe(true);
  });
});

describe("checkoutSteps", () => {
  it("reads the ref a checkout pins", () => {
    expect(checkoutSteps(PINNED_STEP)).toEqual([{ line: 5, name: "Checkout", ref: DEPLOY_REF }]);
  });

  it("reports null for a checkout with no ref — the default-branch case", () => {
    expect(checkoutSteps(BARE_STEP)[0].ref).toBeNull();
  });

  it('strips quotes so `ref: "x"` and `ref: x` compare equal', () => {
    const quoted = BARE_STEP.replace(
      "uses: actions/checkout@v4",
      `uses: actions/checkout@v4\n        with:\n          ref: "${DEPLOY_REF}"`,
    );
    expect(checkoutSteps(quoted)[0].ref).toBe(DEPLOY_REF);
  });

  // The load-bearing one, and the same hole check-ci-lint-parity closes: a ref
  // that appears only in documentation must not count as a ref that is set.
  it("does NOT count a ref that appears only in a comment", () => {
    const commented = BARE_STEP.replace(
      "uses: actions/checkout@v4",
      `uses: actions/checkout@v4\n        # ref: ${DEPLOY_REF}  <- explains why not`,
    );
    expect(checkoutSteps(commented)[0].ref).toBeNull();
  });

  it("finds every checkout when a workflow has several jobs", () => {
    expect(checkoutSteps(`${PINNED_STEP}${BARE_STEP}`)).toHaveLength(2);
  });

  it("does not confuse a later step's inputs for the checkout's", () => {
    const withNeighbourRef = `${BARE_STEP}
      - name: Something else
        with:
          ref: some-other-thing
`;
    expect(checkoutSteps(withNeighbourRef)[0].ref).toBeNull();
  });
});

describe("refFindings", () => {
  it("passes a pinned scheduled workflow", () => {
    expect(refFindings([{ file: "nightly.yml", yaml: PINNED_STEP }])).toEqual([]);
  });

  it("flags a scheduled workflow whose checkout has no ref", () => {
    const found = refFindings([{ file: "nightly.yml", yaml: BARE_STEP }]);
    expect(found).toHaveLength(1);
    expect(found[0].problem).toContain("carries no `ref:`");
  });

  it("flags a checkout pinned to the wrong branch", () => {
    // "main" used to be the wrong-branch literal here, and on 2026-09-01 it
    // silently became the RIGHT one: DEPLOY_REF moved to `main` when the PO
    // repointed Vercel's Production Branch, the replace became a no-op,
    // refFindings correctly returned [] and this line died on `[0].problem` —
    // the gate's only red, identical on both runs. The wrong branch is now
    // wrong BY CONSTRUCTION, and the guard turns any future vacuity into a
    // named assertion failure instead of a TypeError.
    const WRONG_REF = "a-branch-nobody-deploys-from";
    expect(WRONG_REF).not.toBe(DEPLOY_REF);
    const wrong = PINNED_STEP.replace(DEPLOY_REF, WRONG_REF);
    expect(refFindings([{ file: "nightly.yml", yaml: wrong }])[0].problem).toContain(
      `pins \`${WRONG_REF}\``,
    );
  });

  // The exemption list is checked in BOTH directions on purpose. An exemption
  // that no longer describes the file is a lie the next reader will believe.
  it("flags an exemption that has quietly become stale", () => {
    const exempt = REF_EXEMPT[0].workflow;
    const found = refFindings([{ file: exempt, yaml: PINNED_STEP }]);
    expect(found).toHaveLength(1);
    expect(found[0].problem).toContain("REF_EXEMPT");
  });
});

describe("exemptionFindings", () => {
  it("flags an exemption naming a workflow that is not scheduled at all", () => {
    // Both lists, audited by the same code — a stale ALERT_EXEMPT entry is the
    // same lie as a stale REF_EXEMPT one.
    const found = exemptionFindings([{ file: "nightly.yml", yaml: PINNED_STEP }]);
    expect(found.map((f) => f.workflow).sort()).toEqual(
      [...REF_EXEMPT, ...ALERT_EXEMPT].map((e) => e.workflow).sort(),
    );
    expect(found.map((f) => f.problem).join(" ")).toContain("ALERT_EXEMPT");
  });

  it("is quiet when every exemption still names a real scheduled workflow", () => {
    expect(exemptionFindings(scheduledWorkflows())).toEqual([]);
  });
});

// Every case here states its own `waiting` list. Reaching into the live
// NOT_ON_DEFAULT_BRANCH for a sample is what broke this block: the merged-entry
// case read `NOT_ON_DEFAULT_BRANCH[0].workflow`, so the day both waiting
// workflows reached main and the list correctly emptied, it died with
// `TypeError: Cannot read properties of undefined (reading 'workflow')` — a
// test that fails because production got BETTER, which is the self-referential
// shape docs/agents/README.md forbids. What is under test is a property of the
// function; it holds whether the real list has two entries or none.
//
// The live list keeps its coverage where it belongs: the real-tree block below
// calls the two-argument form, so the default binding is still exercised
// against production data by the check that is actually about production data.
describe("defaultBranchFindings", () => {
  const scheduled = [
    { file: "on-main.yml", yaml: PINNED_STEP },
    { file: "not-on-main.yml", yaml: PINNED_STEP },
  ];

  const WAITING: Exemption[] = [
    {
      workflow: "not-on-main.yml",
      reason: "Synthetic fixture: a workflow this tree has, that the default branch does not.",
    },
  ];

  it("flags a scheduled workflow that is absent from the default branch and undocumented", () => {
    const found = defaultBranchFindings(scheduled, ["on-main.yml"], []);
    expect(found?.map((f) => f.workflow)).toContain("not-on-main.yml");
    expect(found?.find((f) => f.workflow === "not-on-main.yml")?.problem).toContain(
      "DOES NOT EXIST",
    );
  });

  it("flags a NOT_ON_DEFAULT_BRANCH entry that has since been merged", () => {
    const found = defaultBranchFindings(scheduled, ["on-main.yml", "not-on-main.yml"], WAITING);
    expect(found?.find((f) => f.workflow === "not-on-main.yml")?.problem).toContain(
      `has reached ${DEFAULT_BRANCH}`,
    );
  });

  // The other direction of the same rule, and what stops the assertion above
  // from passing on a flag that fires unconditionally: an entry whose workflow
  // really is still absent is the documented state, and says nothing.
  it("is quiet about an entry whose workflow is still absent from the default branch", () => {
    expect(defaultBranchFindings(scheduled, ["on-main.yml"], WAITING)).toEqual([]);
  });

  // Third direction: the list must name files that exist here at all. This one
  // is checkable with no git and no default branch, hence the null `onDefault`.
  it("flags an entry naming a workflow that is not in this tree, with no git at all", () => {
    const gone: Exemption[] = [{ workflow: "deleted.yml", reason: "Synthetic fixture." }];
    const found = defaultBranchFindings(scheduled, null, gone);
    expect(found?.map((f) => f.workflow)).toEqual(["deleted.yml"]);
    expect(found?.[0].problem).toContain("Remove the stale entry");
  });

  // The real list is asserted ON, not sampled FROM. This is the assertion the
  // broken case was reaching for, and it survives the list being empty.
  it("keeps the live list describing only workflows this tree really schedules", () => {
    const scheduledNames = new Set(scheduledWorkflows().map((w) => w.file));
    for (const { workflow } of NOT_ON_DEFAULT_BRANCH) {
      expect(scheduledNames.has(workflow), workflow).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Does DEPLOY_REF still name a branch? The half that accused a LIVE branch.
// ---------------------------------------------------------------------------

describe("deployRefVerdict", () => {
  // The bug, exactly: the old resolver gated on origin/main being visible and
  // then looked for origin/<DEPLOY_REF> in the LOCAL clone. A CI checkout with
  // no fetch-depth has the first and not the second, so the fence announced
  // "no longer names a branch" about a branch `git ls-remote` answered for.
  // The fix moved the question to the remote; these pin the mapping, which is
  // the part a network call cannot test.
  it("reads exit 0 as: the remote listed the ref", () => {
    expect(deployRefVerdict(0)).toBe(true);
  });

  // The one and only red. `--exit-code` returns 2 when the remote ANSWERED and
  // matched nothing — a real deletion, which is what this fence is for.
  it("reads exit 2 as: the remote answered and has no such branch", () => {
    expect(deployRefVerdict(2)).toBe(false);
  });

  // The regression this file most needs to prevent, because it is the original
  // bug wearing different clothes: any other status means git did not find out.
  // Reporting "cannot answer" as "it is gone" is what put CI red over a branch
  // that was alive, so no failure mode may collapse into `false`.
  it("reads every other status as: git could not answer, so no verdict", () => {
    for (const status of [1, 128, 129, -1]) {
      expect(deployRefVerdict(status), `exit ${status}`).toBeNull();
    }
  });

  it("reads a git that never ran at all as no verdict, not as a deletion", () => {
    // null is what the caller passes for a timeout, a signal, or no git binary.
    expect(deployRefVerdict(null)).toBeNull();
  });

  it("only ever reports a problem on an exact false, so null stays silent", () => {
    // Guards the contract between the two: the CLI pushes a finding when the
    // verdict `=== false`. If null ever started reading as falsy-enough, the
    // SKIPPED path would become a failure again.
    expect(deployRefVerdict(null) === false).toBe(false);
    expect(deployRefVerdict(128) === false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Against the real tree. These are the assertions that would have fired.
// ---------------------------------------------------------------------------

describe("the real .github/workflows tree", () => {
  const scheduled = scheduledWorkflows();

  it("finds scheduled workflows at all — a scan that finds none is a broken scan, not a pass", () => {
    expect(scheduled.length).toBeGreaterThanOrEqual(3);
  });

  it("has every scheduled workflow either pinned to the deploy branch or documented as exempt", () => {
    expect(refFindings(scheduled)).toEqual([]);
  });

  it("gives every exemption a reason someone can argue with", () => {
    for (const entry of [...REF_EXEMPT, ...NOT_ON_DEFAULT_BRANCH]) {
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });

  // ci.yml is the deliberate counter-example and it matters that it stays one:
  // it runs on push and pull_request, where a fixed ref would make it grade the
  // wrong tree on every PR. The rule is about SCHEDULED fences only.
  it("leaves ci.yml unpinned, because a push/PR gate must test the code that was pushed", () => {
    const ci = readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8");
    expect(hasSchedule(ci)).toBe(false);
    for (const step of checkoutSteps(ci)) expect(step.ref).toBeNull();
  });

  it("agrees with the default branch about which workflows are live, when it can see it", () => {
    const onDefault = workflowsOnDefaultBranch();
    if (onDefault === null) {
      // A CI checkout fetches only the triggering ref, so origin/main is often
      // absent there. Skipping is reported, never folded into the pass — the
      // full-clone run in `pnpm verify` is what enforces this half.
      expect(onDefault).toBeNull();
      return;
    }
    expect(defaultBranchFindings(scheduled, onDefault)).toEqual([]);
  });

  it("keeps DEPLOY_REF as the only place the branch name is decided", () => {
    // Every `ref:` on a checkout in a scheduled workflow must be the constant,
    // never a second literal that could drift away from it.
    const refs = scheduled.flatMap(({ yaml }) =>
      checkoutSteps(yaml)
        .map((s) => s.ref)
        .filter((r): r is string => r !== null),
    );
    expect(refs.length).toBeGreaterThan(0);
    expect([...new Set(refs)]).toEqual([DEPLOY_REF]);
  });
});

// ---------------------------------------------------------------------------
// The streak alert. A red fence nobody is told about is the same as no fence.
// ---------------------------------------------------------------------------

describe("red-streak alerting", () => {
  const ACTION = ".github/actions/red-streak-alert/action.yml";

  it("ships the composite action", () => {
    expect(readdirSync(".github/actions")).toContain("red-streak-alert");
  });

  it("keys on the streak length, not on a green→red transition", () => {
    // The reason the 20 consecutive e2e failures were never announced: GitHub's
    // built-in mail needs a transition, and a fence that has never been green
    // never transitions. If this action ever starts comparing against the
    // previous run's conclusion alone, that hole is back.
    const action = readFileSync(ACTION, "utf8");
    expect(action).toMatch(/min-streak/);
    expect(action).toMatch(/STREAK/);
  });

  it("needs no secret beyond the per-run GITHUB_TOKEN", () => {
    // A webhook secret that is absent turns alerting into a silent no-op, which
    // is the disease. Anything matching `secrets.<NAME>` other than GITHUB_TOKEN
    // in a workflow's alert wiring would be exactly that.
    //
    // Derived from the tree rather than listed: a hardcoded pair would stop
    // covering the next workflow the moment one is added, which is the same
    // mistake the alert-wiring assertion below used to make.
    const wired = scheduledWorkflows().filter((w) => wiresAlert(w.yaml));
    expect(wired.length).toBeGreaterThanOrEqual(1);
    for (const { file, yaml } of wired) {
      const alertBlock = yaml.slice(yaml.indexOf("red-streak-alert"));
      const secrets = [...alertBlock.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
      expect([...new Set(secrets)], file).toEqual(["GITHUB_TOKEN"]);
    }
  });

  it("does not carry the staging nightlies, which moved to dim-interno", () => {
    // e2e-nightly (20/20 red) and db-doctor-staging (12/12 red) are why this
    // action exists. On 2026-09-24 they moved to the private companion repo
    // with every job that holds a staging secret, and wire it from there.
    const here = readdirSync(WORKFLOW_DIR);
    for (const file of ["e2e-nightly.yml", "db-doctor-staging.yml", "panorama-qa-nightly.yml"]) {
      expect(here, file).not.toContain(file);
    }
  });

  // The public nightly that had never run at all. Its first run on `main` had
  // no green to transition from, so GitHub's mail would not fire on it — the
  // 20-silent-nights disease, pre-installed on the newest gates. Measured
  // 2026-08-28: `gh run list --workflow mobile-export-nightly.yml` answers
  // `HTTP 404: workflow not found on the default branch`.
  it("is wired into the public nightly that had never run once", () => {
    for (const file of ["mobile-export-nightly.yml"]) {
      const yaml = readFileSync(join(WORKFLOW_DIR, file), "utf8");
      expect(wiresAlert(yaml), file).toBe(true);
      expect(yaml).toMatch(/issues:\s*write/);
    }
  });
});

describe("wiresAlert", () => {
  it("sees a real `uses:` of the composite action", () => {
    expect(wiresAlert(ALERT_JOB)).toBe(true);
  });

  it("does NOT count the action named in a comment", () => {
    // Every one of these workflows explains the alert in prose, and several name
    // the action's path while doing it. A detector that counted prose would
    // report all seven files as wired and check nothing at all.
    expect(wiresAlert(`# wire ${ALERT_ACTION} into any new gate\njobs: {}\n`)).toBe(false);
  });

  it("does not match a different action whose path merely starts the same", () => {
    expect(wiresAlert(`      - uses: ${ALERT_ACTION}-v2\n`)).toBe(false);
  });
});

describe("alertFindings", () => {
  it("flags a scheduled fence with no alert wiring", () => {
    const found = alertFindings([{ file: "nightly.yml", yaml: PINNED_STEP }]);
    expect(found).toHaveLength(1);
    expect(found[0].problem).toContain("no `uses:");
  });

  it("is quiet once the alert is wired", () => {
    expect(alertFindings([{ file: "nightly.yml", yaml: PINNED_STEP + ALERT_JOB }])).toEqual([]);
  });

  it("lets an ALERT_EXEMPT workflow ship without one", () => {
    expect(alertFindings([{ file: ALERT_EXEMPT[0].workflow, yaml: PINNED_STEP }])).toEqual([]);
  });

  // Both directions, like REF_EXEMPT. An exemption that no longer describes the
  // file is a lie the next reader will believe.
  it("flags an exemption for a workflow that now wires the alert anyway", () => {
    const found = alertFindings([
      { file: ALERT_EXEMPT[0].workflow, yaml: PINNED_STEP + ALERT_JOB },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].problem).toContain("ALERT_EXEMPT");
  });

  it("is quiet against the real tree", () => {
    expect(alertFindings(scheduledWorkflows())).toEqual([]);
  });

  it("gives every alert exemption a reason someone can argue with", () => {
    for (const entry of ALERT_EXEMPT) expect(entry.reason.length).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------
// The third state: succeeded != audited.
// ---------------------------------------------------------------------------

describe("auditedFindings", () => {
  it("flags a guard-skipping workflow that wires the alert without `audited:`", () => {
    const found = auditedFindings([{ file: "nightly.yml", yaml: GUARDED }]);
    expect(found).toHaveLength(1);
    expect(found[0].problem).toContain("audited");
  });

  it("is quiet once the guard's output is passed through", () => {
    const fixed = GUARDED.replace(
      "outcome: ${{ needs.nightly.result }}",
      "outcome: ${{ needs.nightly.result }}\n          audited: ${{ needs.nightly.outputs.audited }}",
    );
    expect(auditedFindings([{ file: "nightly.yml", yaml: fixed }])).toEqual([]);
  });

  it("does not demand `audited:` from a workflow that cannot no-op-skip", () => {
    expect(auditedFindings([{ file: "nightly.yml", yaml: PINNED_STEP + ALERT_JOB }])).toEqual([]);
  });

  it("is quiet against the real tree", () => {
    expect(auditedFindings(scheduledWorkflows())).toEqual([]);
  });

  // The detector's first version required `steps.` IMMEDIATELY after `if:`, so
  // the `${{ ... }}` spelling of the same guard walked straight past it — and
  // unlike wiresAlert(), whose narrowness fails loud, this one failed SILENT:
  // the workflow simply escaped the `audited:` requirement. Fence the subject
  // (an `if:` consulting a step output), not the two ways to type it.
  it("catches the guard in the wrapped-expression spelling too", () => {
    const wrapped = GUARDED.replace(
      "if: steps.guard.outputs.run == 'true'",
      "if: ${{ steps.guard.outputs.run == 'true' }}",
    );
    expect(wrapped).toContain("${{ steps.guard");
    const found = auditedFindings([{ file: "nightly.yml", yaml: wrapped }]);
    expect(found).toHaveLength(1);
    expect(found[0].problem).toContain("audited");
  });

  it("recognises both spellings through the one exported regex", () => {
    expect(STEP_OUTPUT_GUARD.test("        if: steps.guard.outputs.run == 'true'")).toBe(true);
    expect(STEP_OUTPUT_GUARD.test("        if: ${{ steps.guard.outputs.run == 'true' }}")).toBe(
      true,
    );
    expect(STEP_OUTPUT_GUARD.test("    if: ${{ !cancelled() && steps.g.outputs.ok == '1' }}")).toBe(
      true,
    );
  });

  // A job-level `if:` on needs.* is a different subject: it cannot consult a
  // secret, so it is not the guard this rule is about. Widening must not have
  // swallowed it.
  it("does not treat a needs-based condition as a step guard", () => {
    expect(STEP_OUTPUT_GUARD.test("    if: ${{ needs.build.outputs.changed == 'true' }}")).toBe(
      false,
    );
    expect(STEP_OUTPUT_GUARD.test("    if: always()")).toBe(false);
  });
});

describe("the alert action's third state", () => {
  const action = readFileSync(".github/actions/red-streak-alert/action.yml", "utf8");

  it("declares an `audited` input that defaults to true", () => {
    // Defaulting to "true" is what keeps the workflows with no guard from
    // having to opt in; the guarded one opts OUT explicitly.
    expect(action).toMatch(/^ {2}audited:/m);
    expect(action).toMatch(/audited:[\s\S]*?default: "true"/);
  });

  it("compares for equality with true, so an EMPTY value cannot close an alert", () => {
    // `needs.<job>.outputs.audited` is "" when the job died before its guard
    // step ran. `!= "true"` treats that as not-audited, which leaves the alert
    // open — the safe direction. `= "false"` would have closed it.
    expect(action).toContain('if [ "${AUDITED}" != "true" ] && [ "${OUTCOME}" != "failure" ]');
  });

  it("still alerts on a real failure whatever `audited` says", () => {
    // The asymmetry is the point: the flag can suppress a CLOSE, never an OPEN.
    // A guard-skipped job cannot fail, so this can only ever protect a red.
    const guardLine = action
      .split("\n")
      .find((l) => l.includes('[ "${AUDITED}" != "true" ]')) as string;
    expect(guardLine).toContain('[ "${OUTCOME}" != "failure" ]');
  });

  it("puts the guard before every write to the issue", () => {
    const guardAt = action.indexOf('[ "${AUDITED}" != "true" ]');
    expect(guardAt).toBeGreaterThan(-1);
    for (const write of [
      "gh issue close",
      "gh issue create",
      "gh issue edit",
      "gh issue comment",
    ]) {
      expect(action.indexOf(write), write).toBeGreaterThan(guardAt);
    }
  });

  it("leaves no public workflow skipping unaudited (the guarded ones are in dim-interno)", () => {
    // db-doctor-staging and authz-audit-staging pass `audited:` from dim-interno
    // since 2026-09-24. Here the fence itself is the check, over the real tree.
    expect(auditedFindings(scheduledWorkflows())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Is any of this LIVE? The half the fence used to get wrong about ITSELF.
// ---------------------------------------------------------------------------

describe("livenessRows / inertRows", () => {
  const here = [{ file: "nightly.yml", yaml: PINNED_STEP + ALERT_JOB }];

  it("calls a pin inert when the default branch's copy does not carry it", () => {
    const copies = new Map([["nightly.yml", BARE_STEP]]);
    const [row] = livenessRows(here, copies);
    expect(row).toMatchObject({ present: true, pinnedHere: true, pinnedThere: false });
    expect(inertRows([row])[0].missing).toContain("the `ref:` pin");
  });

  it("calls an alert job inert when the default branch's copy does not wire it", () => {
    const copies = new Map([["nightly.yml", PINNED_STEP]]);
    expect(inertRows(livenessRows(here, copies))[0].missing).toContain("the red-streak alert job");
  });

  it("reports an absent file as having no schedule at all, not as a missing pin", () => {
    const copies = new Map<string, string | null>([["nightly.yml", null]]);
    expect(inertRows(livenessRows(here, copies))[0].missing).toEqual([
      "the file itself (so: no schedule at all)",
    ]);
  });

  it("is empty when the default branch's copy is identical", () => {
    const copies = new Map([["nightly.yml", PINNED_STEP + ALERT_JOB]]);
    expect(inertRows(livenessRows(here, copies))).toEqual([]);
  });

  // The bug this whole section exists to make impossible: an exempt workflow
  // that is unpinned HERE must not be reported as "missing its pin" THERE.
  it("does not accuse a ref-exempt workflow of a missing pin", () => {
    const exemptFile = REF_EXEMPT[0].workflow;
    const copies = new Map([[exemptFile, BARE_STEP]]);
    expect(inertRows(livenessRows([{ file: exemptFile, yaml: BARE_STEP }], copies))).toEqual([]);
  });
});

describe("the real tree, against the default branch's copy of itself", () => {
  it("does not claim anything is live on the default branch that is not", () => {
    const scheduled = scheduledWorkflows();
    const onDefault = workflowsOnDefaultBranch();
    if (onDefault === null) return; // reported as SKIPPED by the CLI; see above.

    const copies = new Map(
      scheduled.map((w) => [w.file, defaultBranchWorkflowYaml(w.file)] as const),
    );
    const rows = livenessRows(scheduled, copies);

    // Every row's `present` must agree with the independent ls-tree listing —
    // two different git reads of the same fact, which is what makes this a check
    // rather than a restatement.
    const present = new Set(onDefault);
    for (const row of rows) expect(row.present, row.file).toBe(present.has(row.file));

    // And every "here but not there" must appear in the inert list. The failure
    // this forbids is the one the pass line committed for a day: pins written on
    // this branch, reported as done, inert on every scheduled run.
    const inert = new Set(inertRows(rows).map((r) => r.file));
    for (const row of rows) {
      if (!row.present) expect(inert.has(row.file), row.file).toBe(true);
      if (row.pinnedHere && !row.pinnedThere) expect(inert.has(row.file), row.file).toBe(true);
      if (row.alertedHere && !row.alertedThere) expect(inert.has(row.file), row.file).toBe(true);
    }
  });
});

describe("the fence runs where it matters", () => {
  it("is part of `pnpm verify`", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["lint:sched-refs"]).toBeTruthy();
    expect(pkg.scripts.verify).toContain("pnpm lint:sched-refs");
  });

  it("is part of CI", () => {
    // check-ci-lint-parity enforces this too; asserting it here as well means
    // the two fences would have to fail together to let it slip.
    const ci = readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8");
    expect(ci).toContain("pnpm lint:sched-refs");
  });
});
