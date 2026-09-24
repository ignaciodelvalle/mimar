// Authorization-SCOPING linter — CI guardrail (regression armor).
//
// Sibling to check-authz-guards.ts. That linter answers "is there a guard AT
// ALL?". This one answers the next question: "the guard proves the caller is an
// admin / govt agent / org member — but is the resource the action touches
// actually SCOPED to that caller's jurisdiction / tenant / ownership?".
//
// THE PATTERN THIS CATCHES ("guard-called-but-not-jurisdiction-scoped"):
//   A server action calls an INSTITUTIONAL or CAPABILITY guard — one that
//   establishes authority OVER OTHER TENANTS (admin/govt/org/capability), not
//   merely a logged-in session — and then accepts a caller-supplied resource id
//   (orgId / targetUserId / publicToken / disputeToken / ruleId / firingId …)
//   WITHOUT any visible predicate tying that id to the caller's scope. An admin
//   is global by design, but a govt agent is bounded to their assigned
//   jurisdiction and an org member to their tenant; a role check alone lets a
//   scoped operator act outside their bounds if the downstream query forgets
//   the WHERE clause. See dim-interno:docs/design/handoffs/2026-07-04-authz-inventory-raw.md
//   for the hand audit this automates (its ⚠ rows are the seed baseline).
//
// HEURISTIC (regex approximation, matching the sibling linters):
//   An exported server action is an OFFENDER when its body:
//     (1) calls a TENANT_GUARD (below), AND
//     (2) contains NO SCOPING_MARKER (below) — no jurisdiction/tenant/owner
//         predicate and no inline authority re-check.
//   Inner writers (`*ForUser`/`*ForOrg`/… suffixes) and `@no-auth-required`
//   opt-outs are skipped, exactly as in check-authz-guards.ts. Personal-tier
//   guards (requireUser/requirePetAccess/requireTitularAccess/requireOwnedPet…)
//   are NOT tenant guards, so an action gated only by those is never a
//   candidate here.
//
//   READ THAT EXCLUSION NARROWLY. "Personal-tier" is one bucket holding
//   different things, and calling all of them "self-scoped" is how the
//   2026-07-31 custody-dispute disclosure survived review:
//     - requirePetAccess / requireAlivePetAccess / requireOwnedPet* RESOLVE
//       THE PET AND JOIN ownerships (lib/infra/pet-access.ts) — they bind the
//       pet to the caller, and say NOTHING about which of that caller's roles
//       is acting. Since custodia-temporal a Path-1 holder may be a
//       `caretaker`, so "self-scoped" here means "this pet is one of mine",
//       NOT "I may write anything on it". The role question is a DIFFERENT
//       rule, enforced by scripts/check-titular-gate.ts.
//     - requireUserOrRedirect / requireUser prove a SESSION and say NOTHING
//       about any pet the action goes on to touch. An action that calls only
//       these and then feeds a caller-supplied petToken/petId into a WHERE
//       clause is unscoped in exactly this linter's sense — it is simply out
//       of range because the caller is a citizen rather than a tenant.
//   Both gaps are real and this file covers neither. They are separate rules,
//   not something to paper over by widening TENANT_GUARDS, which would flood
//   the baseline with every legitimate owner action:
//     3rd rule (uncovered) — identity-only guard + caller-chosen pet
//       identifier + no binding predicate.
//     4th rule (covered elsewhere) — pet bound to the caller but the caller's
//       ROLE not allowed to perform the effect. Enforced in three uncorrelated
//       places, none of them here: scripts/check-titular-gate.ts (the CI fence
//       over app writers), public.has_titular_write_access() (migration 0190,
//       the RLS counterpart a bearer token hitting PostgREST meets instead),
//       and the UI, which must not RENDER a control the other two will refuse
//       — see deriveMasSheetItems and components/pet-profile/NotTitularNotice.
//
// REPORT-ONLY / BASELINE MODE (like the app/actions line-budget ratchet):
//   Most current offenders delegate their scoping to an application use-case
//   that this file-local regex cannot see — legitimate strangler-migration
//   debt, not a live breach. So the linter does NOT fail on the existing set:
//   it records a per-file offender count baseline (authz-scoping-baseline.json)
//   and fails when a file's count GROWS, when a NEW action file introduces an
//   offender, or when the live SUM falls below the baseline sum without the
//   baseline being re-recorded (A01-8, below). That makes "a new admin/govt/org action with no visible scoping"
//   a red build, while the audited backlog burns down without blocking CI.
//   Run `pnpm tsx scripts/check-authz-scoping.ts --write-baseline` after a
//   deliberate change to re-record.
//
//   DO NOT COPY THE COUNT INTO THIS COMMENT. The authoritative number is the
//   live SUM of authz-scoping-baseline.json, which every run prints as
//   "baseline: N known". This paragraph used to quote "41 offenders across 16
//   files", verified 2026-07-31 — and by 2026-08-20 the JSON held 44 across 19,
//   so the sentence warning against copied numbers was itself a stale copied
//   number. Earlier revisions cited 43/48 and 49/21, both wrong the same way.
//   Read the count off the run, never off a comment; that is why the script
//   prints it.
//
//   Since 2026-09-18 (A01-8) the ratchet also fails on the SUM: when the live
//   total is below the baseline total, the run is red until the baseline is
//   re-recorded in the same commit. Growth-only let a fixed offender's slot
//   survive in the JSON and be spent by a LATER commit's regression in that
//   file. The per-file list of files below their baseline is printed as the
//   diagnostic, not as the rule.
//
//   WHAT IT GUARANTEES, EXACTLY. It counts; it does not know WHICH exports
//   offend. So: (1) on a green run every baselined file's count equals its
//   baseline exactly (no file above, and an equal sum leaves none below); (2) a
//   burned-down slot cannot carry over to a later commit without the JSON
//   saying so. It does NOT stop one commit that fixes an offender and adds one
//   in the same file (the count is unchanged), and it does NOT stop anyone
//   RAISING the baseline with --write-baseline. "The total only goes down" holds
//   across commits only while every diff to authz-scoping-baseline.json is
//   reviewed; an increase there is a new offender being accepted.
//
//   This ratchet only blocks GROWTH and unrecorded shrinkage — it does NOT prove the existing offenders
//   are correctly scoped (most delegate scoping to an application use-case this
//   file-local regex cannot see; burning the backlog down still needs a manual
//   per-file scoping audit).
//
// Run: pnpm tsx scripts/check-authz-scoping.ts   (or: pnpm lint:authz-scoping)

import { readFileSync, writeFileSync } from "node:fs";

import {
  type ExportedFn,
  extractExportedAsyncFunctions,
  isInnerWriter,
  listActionFiles,
} from "./check-authz-guards";
import { stripComments } from "./lib/strip-comments.mjs";

// ---------------------------------------------------------------------------
// Tenant/authority guards — establish authority beyond the caller's own
// session (admin-global, govt-jurisdictional, org-tenant, or capability). An
// action gated by one of these MUST scope the resource it touches. Personal
// guards (requireUser*, requirePetAccess*, requireTitularAccess,
// requireOwnedPet*) are intentionally EXCLUDED — but for DIFFERENT reasons, and
// the difference matters (see the header): requirePetAccess* / requireOwnedPet*
// / requireTitularAccess bind the pet to the caller via an ownerships join,
// whereas requireUser* bind nothing at all and are excluded only because a
// citizen action is not the tenant-scoping question this file asks. Do not read
// this list as "requireUserOrRedirect is self-scoped" — and do not read the
// binding ones as "any role may act", which is the titular gate's question, not
// this file's.
// ---------------------------------------------------------------------------
export const TENANT_GUARDS = [
  "requireAdminOrRedirect",
  "requireAdminOrGovtOrRedirect",
  "requireDecomisoPrincipal",
  "requireOrgAccessByToken",
  // `requireActiveOrgOrRedirect` was listed here until 2026-08-22 and is
  // defined nowhere in the tree (lib/infra/auth-guards.ts:102 names it as the
  // guard requireOrgAccessByToken REPLACED). A dead name on a recognised list
  // is a free pass for whoever defines it first; pruned together with the four
  // dead entries of check-authz-guards.ts (see GUARD_HOMES there).
  "requireCapability",
  "requireOrgInterventionAccess",
  // File-local admin guard (alert-firings / alert-subscriptions actions):
  // wraps auth.getUser + a profiles.role === 'admin' re-check.
  "requireAdminUser",
] as const;

// ---------------------------------------------------------------------------
// Scoping markers — the presence of ANY of these in the action body is taken
// as evidence the resource is bounded to the caller's jurisdiction / tenant /
// ownership (a WHERE predicate, an injected tenant id, or an inline authority
// re-check). Deliberately generous: in baseline mode a false "scoped" only
// means an action is NOT flagged, and the goal is to catch the ZERO-scoping
// actions, not to grade scoping quality.
//
// GENEROUS IS NOT THE SAME AS FICTIONAL (2026-08-05). These patterns are matched
// against the action's body with COMMENTS STRIPPED, and they are structural.
// Before that they ran over raw source and the list led with a bare
// `/jurisdiction/i` — an unbounded, case-insensitive substring. The word
// "jurisdiction" written in ANY comment inside a function therefore satisfied
// the scoping check, and this file's own doctrine is written in exactly such
// comments. That is the worst failure mode a fence has: it did not merely miss
// violations, it rewarded documenting the rule with an exemption from it.
// ---------------------------------------------------------------------------
export const SCOPING_MARKERS: readonly RegExp[] = [
  // Tenant / ownership predicate columns.
  /organizationId/,
  /organization\.id/,
  /ownerUserId/,
  /actorUserId/,
  /openedByOrganizationId/,
  // Jurisdiction predicates (govt agents are bounded to assigned localities).
  /session\.jurisdictions/,
  /jurisdictions\.some/,
  /\.province\b/,
  // Structural jurisdiction signals, replacing the bare `/jurisdiction/i`:
  //   - a jurisdiction COLUMN/PROPERTY: jurisdictionProvince, jurisdictionLocality,
  //     pet.jurisdictionCountry;
  //   - a jurisdictions PROPERTY ACCESS: session.jurisdictions, row.jurisdictions;
  //   - a `jurisdictions` BINDING threaded into a scoped query — destructured from
  //     the guard result or passed as an argument (`, jurisdictions)`, `jurisdictions }`);
  //   - a CALL SITE whose name carries the concept: normalizeJurisdiction(),
  //     resolveJurisdiction(), narrowGovtScope(), authorityScopeFromSession().
  /\bjurisdiction[A-Z]\w*/,
  /\.jurisdictions\b/,
  /\bjurisdictions\b\s*[,)\]}]/,
  /\b\w*[Jj]urisdiction\w*\s*\(/,
  /\bnarrowGovtScope\s*\(/,
  /\bauthorityScopeFromSession\s*\(/,
  /\blocality\b/i,
  /localidad/i,
  // Capability/authority resolution pinned to a specific org id, plus the
  // defense-in-depth inline re-check pattern the audit calls a "Good example":
  // `organization.publicToken !== input.receiverOrgToken`, `!== govtOrg.id`.
  /!==\s*[\w.]*[Tt]oken/,
  /[Tt]oken\s*!==/,
  /!==\s*govtOrg/,
  /!==\s*[\w.]*\.id/,
  // Owner-scoping via an ownerships join in the action itself.
  /ownerships\./,
] as const;

export function callsTenantGuard(body: string): boolean {
  return TENANT_GUARDS.some((g) => new RegExp(`\\b${g}\\s*\\(`).test(body));
}

/**
 * Both questions this file asks — "is there a tenant guard?" and "is there a
 * scoping predicate?" — are questions about CODE. Callers pass raw source, so
 * comments are stripped here, once, rather than at each call site.
 */
export function hasScopingMarker(body: string): boolean {
  const code = stripComments(body);
  return SCOPING_MARKERS.some((re) => re.test(code));
}

export function isScopingOffender(fn: ExportedFn): boolean {
  if (isInnerWriter(fn.name)) return false;
  if (fn.hasNoAuthComment) return false;
  // A guard named in a comment is not a guard either — same reason.
  if (!callsTenantGuard(stripComments(fn.body))) return false;
  return !hasScopingMarker(fn.body);
}

/** Offenders in one file, as `path:line export async function NAME` lines. */
export function findScopingOffenders(relPath: string, src: string): string[] {
  const out: string[] = [];
  for (const fn of extractExportedAsyncFunctions(src)) {
    if (isScopingOffender(fn)) {
      out.push(`${relPath}:${fn.startLine} ${fn.name}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Baseline ratchet
// ---------------------------------------------------------------------------

export type Baseline = Record<string, number>;

const BASELINE_PATH = "scripts/authz-scoping-baseline.json";

/** offenders-per-file for the whole action surface. */
export function scanOffendersByFile(): Record<string, string[]> {
  const byFile: Record<string, string[]> = {};
  for (const file of listActionFiles()) {
    const relPath = file.replaceAll("\\", "/");
    const offenders = findScopingOffenders(relPath, readFileSync(file, "utf8"));
    if (offenders.length > 0) byFile[relPath] = offenders;
  }
  return byFile;
}

export type Ratchet = {
  grew: Array<{ file: string; baseline: number; actual: number; offenders: string[] }>;
  newFiles: Array<{ file: string; offenders: string[] }>;
  /**
   * Baselined files whose live count is now BELOW the baseline (a file that is
   * clean, or gone, counts as 0). The diagnostic for a SUM violation: it names
   * which files freed the slots `actualTotal < baselineTotal` reports.
   */
  slack: Array<{ file: string; baseline: number; actual: number }>;
  baselineTotal: number;
  actualTotal: number;
};

/**
 * Compare the live scan against the baseline. Per file, growth fails; on the
 * SUM, a live total that differs from the baseline total fails (runScan).
 *
 * WHY SHRINKAGE FAILS (A01-8, 2026-09-18). Growth-only made this a report
 * nobody was obliged to reduce: fixing an offender left its slot in the JSON,
 * and the next regression in that same file spent the slot silently — the
 * count stayed "unchanged" while a real scoping hole came back. Requiring the
 * baseline to be lowered in the commit that burns an offender down means a
 * freed slot does not survive into a later commit. Counts, not identities: a
 * fix and a new offender in the same file in ONE commit still net to zero, and
 * a raised baseline is caught only by reviewing the JSON diff (header).
 */
export function ratchet(baseline: Baseline, byFile: Record<string, string[]>): Ratchet {
  const grew: Ratchet["grew"] = [];
  const newFiles: Ratchet["newFiles"] = [];
  const slack: Ratchet["slack"] = [];
  for (const [file, offenders] of Object.entries(byFile)) {
    const base = baseline[file];
    if (base === undefined) {
      newFiles.push({ file, offenders });
    } else if (offenders.length > base) {
      grew.push({ file, baseline: base, actual: offenders.length, offenders });
    }
  }
  for (const [file, base] of Object.entries(baseline)) {
    const actual = byFile[file]?.length ?? 0;
    if (actual < base) slack.push({ file, baseline: base, actual });
  }
  const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
  const actualTotal = Object.values(byFile).reduce((a, arr) => a + arr.length, 0);
  return { grew, newFiles, slack, baselineTotal, actualTotal };
}

/**
 * The run's verdict. `growth` = a file grew or a new file has offenders (a new
 * scoping hole). `slack` = no growth, but the live SUM is below the baseline
 * SUM: debt was burned down and not recorded (A01-8). Only `clean` passes.
 */
export function ratchetVerdict(r: Ratchet): "clean" | "growth" | "slack" {
  if (r.grew.length > 0 || r.newFiles.length > 0) return "growth";
  if (r.actualTotal < r.baselineTotal) return "slack";
  return "clean";
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function writeBaseline(byFile: Record<string, string[]>): void {
  const baseline: Baseline = {};
  for (const [file, offenders] of Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b))) {
    baseline[file] = offenders.length;
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  const total = Object.values(baseline).reduce((a, b) => a + b, 0);
  console.log(
    `✓ wrote ${BASELINE_PATH} — ${Object.keys(baseline).length} file(s), ${total} baselined offender(s).`,
  );
}

function runScan(): void {
  const byFile = scanOffendersByFile();

  if (process.argv.includes("--write-baseline")) {
    writeBaseline(byFile);
    return;
  }

  let baseline: Baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch {
    console.error(
      `✗ check-authz-scoping: cannot read baseline at ${BASELINE_PATH}. Generate it with --write-baseline.`,
    );
    process.exit(1);
  }

  const result = ratchet(baseline, byFile);
  const { grew, newFiles, slack, baselineTotal, actualTotal } = result;
  const verdict = ratchetVerdict(result);

  if (verdict === "clean") {
    console.log(
      `✓ authz-scoping clean — no NEW tenant-guarded-but-unscoped actions (baseline: ${actualTotal} known, delegated-scope offender(s) unchanged; every file matches its baseline exactly — raising the baseline JSON is the only way this number goes up, so review its diff).`,
    );
    return;
  }

  if (verdict === "slack") {
    for (const s of slack) {
      console.error(
        `${s.file}: ${s.actual} offender(s), baseline still says ${s.baseline}. The debt went down; record it.`,
      );
    }
    console.error(
      `\n✗ authz-scoping baseline SUM has SLACK (baseline sum ${baselineTotal}, live ${actualTotal}). Lower it in this same commit with \`pnpm tsx scripts/check-authz-scoping.ts --write-baseline\` — an unrecorded fix leaves a free slot a later regression in that file would spend silently.`,
    );
    process.exit(1);
  }

  for (const g of grew) {
    console.error(
      `${g.file}: ${g.actual} tenant-guarded actions with no visible scoping (baseline ${g.baseline}). New offender(s):`,
    );
    for (const o of g.offenders) console.error(`    ${o}`);
  }
  for (const n of newFiles) {
    console.error(`${n.file}: NEW action file with tenant-guarded but unscoped action(s):`);
    for (const o of n.offenders) console.error(`    ${o}`);
  }
  console.error(
    "\n✗ NEW guard-called-but-not-jurisdiction-scoped offender(s). Add a jurisdiction/tenant/owner" +
      " predicate (WHERE clause pinning the resource to the caller's scope), or if the scoping is" +
      " genuinely delegated to a use-case, re-baseline with --write-baseline and note why in the PR.",
  );
  process.exit(1);
}

// Guard: only scan when run directly; importing (tests) exposes the helpers.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-authz-scoping.ts") ||
    process.argv[1].endsWith("check-authz-scoping.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
