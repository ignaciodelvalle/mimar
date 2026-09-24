// Confused-deputy linter — CI guardrail (org-token authorization class).
//
// Sibling to check-authz-guards.ts ("is there a guard AT ALL?") and
// check-authz-scoping.ts ("is the resource scoped to the caller?"). This one
// answers a third question specific to /org/{orgToken}/… server actions:
//   "the action receives the URL org token — but does its capability check
//    authorize against THAT org, or against the session-default membership?"
//
// THE ANTI-PATTERN THIS CATCHES ("org-token confused deputy"):
//   An exported server action whose SIGNATURE takes an org-token-shaped param
//   (orgToken / senderOrgToken / receiverOrgToken) gates with BARE
//   `requireCapability("cap")` — a single-argument call. Bare requireCapability
//   resolves the caller's MOST-RECENTLY-JOINED active membership (see
//   authz-resolver.ts: `memberships[memberships.length - 1]`), NOT the org named
//   in the URL token. A member of several orgs acting from /org/{A}/… is then
//   authorized against whichever org they happened to join last — a classic
//   confused deputy: the action trusts the URL for its intent but a different
//   org for its authority.
//
//   THE FIX is `requireCapabilityForOrgToken("cap", orgToken)`, which resolves
//   the acting org FROM the URL token first, then pins the capability check to
//   that org.id. See src/modules/transfers/actions.ts (propose / accept / reject
//   / cancel / transferCustody) for the canonical form.
//
// NOT flagged (correctly safe):
//   - `requireCapability("cap", someOrgId)` — the two-argument form already pins
//     the check to a specific org.id (e.g. an org resolved from the token first,
//     as app/actions/decomiso.ts does).
//   - Actions that call `requireCapabilityForOrgToken(...)`.
//   - Actions with NO org-token param in their typed signature (they legitimately
//     act on the caller's session-default org).
//
// HEURISTIC (regex approximation, matching the sibling linters):
//   An exported server action is an OFFENDER when ALL hold:
//     (1) its typed signature names an ORG_TOKEN_PARAM, AND
//     (2) its body calls BARE requireCapability (single string-literal arg), AND
//     (3) its body does NOT call requireCapabilityForOrgToken.
//   Inner writers (`*ForOrg`/… suffixes) are skipped, as in the sibling linters.
//
//   CLOSED 2026-08-09 — an org token delivered via FormData used to be invisible
//   to this signature-based check. The header called that "UX-latent... tracked
//   separately" and named the three actions it covered for
//   (createServiceOfferingAction, create/updateScheduleRuleAction). It stopped
//   being latent the day someone clicked through the vet flow: a service
//   published from a clinic's panel was written to a SANITARY AUTHORITY the same
//   admin also belongs to. Not a privilege escalation — the capability was
//   checked against the org it wrote to — but for an org-scoped product,
//   writing one tenant's data into another's catalogue is bad enough. The three
//   are pinned and the check now covers both lanes: signature AND FormData.
//
// DOCUMENTED-SAFE EXCEPTIONS (CONFUSED_DEPUTY_ALLOWLIST): a real offender kept
// out of the current lane, listed with a reason so the exception is visible.
//
// Run: pnpm tsx scripts/check-confused-deputy.ts   (or: pnpm lint:authz-orgtoken)
// Exits 1 listing each offender; exits 0 when the surface is clean.

import { readFileSync } from "node:fs";

import {
  type ExportedFn,
  extractExportedAsyncFunctions,
  isInnerWriter,
  listActionFiles,
} from "./check-authz-guards";
import { stripComments } from "./lib/strip-comments.mjs";

// ---------------------------------------------------------------------------
// Org-token-shaped signature params. A typed param with one of these names
// means the action's intent is bound to a specific /org/{token} URL — its
// capability check must pin to that token, not the session-default membership.
// `publicToken` is deliberately EXCLUDED: in this codebase it is the PET token
// (e.g. transferCustodyAction(orgToken, publicToken)), not an org token.
// ---------------------------------------------------------------------------
export const ORG_TOKEN_PARAMS = ["orgToken", "senderOrgToken", "receiverOrgToken"] as const;

// Bare, session-default capability check: `requireCapability("cap")` with a
// single string-literal argument and the closing paren right after it. The
// two-argument form `requireCapability("cap", orgId)` (pinned) does NOT match,
// because a comma sits between the literal and the `)`.
export const BARE_REQUIRE_CAPABILITY_RE = /requireCapability\s*\(\s*(["'])[^"']*\1\s*\)/;

// The confused-deputy-safe guard. Its presence exempts the action.
export const FOR_ORG_TOKEN_RE = /requireCapabilityForOrgToken\s*\(/;

const ORG_TOKEN_PARAM_RE = new RegExp(`\\b(?:${ORG_TOKEN_PARAMS.join("|")})\\b`);

// An org token that arrives through FormData instead of a typed param. The
// signature check above cannot see it, and that blind spot was documented in
// this file's header as "UX-latent... tracked separately" — naming
// createServiceOfferingAction and create/updateScheduleRuleAction explicitly.
//
// It stopped being latent on 2026-08-09. Clicking through the vet flow,
// a service published from the Clínica Veterinaria Recoleta panel was written
// to Mascotas BA Centro — a sanitary authority the same admin also belongs to —
// and the post-submit redirect landed on that other organization's page. The
// three named actions are now pinned, so the exception is closed rather than
// carried: an action that READS an org token from its form must AUTHORIZE
// against it.
const ORG_TOKEN_FORMDATA_RE = new RegExp(
  `formData\\s*\\.\\s*get\\s*\\(\\s*(["'])(?:${ORG_TOKEN_PARAMS.join("|")})\\1\\s*\\)`,
);

// Comments are stripped so a bare `requireCapability("cap")` written in a doc
// comment (e.g. "requireCapability(...) alone resolves the session default — so
// we pin it") is never mistaken for a real call.
//
// CONSOLIDATED 2026-08-05 onto the shared stripper (scripts/lib/strip-comments.mjs),
// which the sibling fences already use. The copy this replaces was a two-regex
// approximation with a `[^:]` hack to avoid truncating `https://…`; that hack
// covers a URL but not a string containing `//` for any other reason, and a
// stripper that deletes real code makes a fence fail OPEN. The shared version
// tracks string and template literals properly and substitutes whitespace 1:1,
// so it is strictly stricter here. It is re-exported under this file's name
// because that is the import path this fence's callers have always used.
export { stripComments };

// Documented-safe offenders: `"<relPath>#<name>"` → reason. Use ONLY when the
// action is a genuine org-token confused-deputy shape but is intentionally out
// of the current remediation lane (or provably safe). Keep the set small and
// justified — the goal is zero.
// EMPTY SINCE 2026-08-22 — and the way its last entry died is the reason to
// keep it empty. `reportBiteFromOrgAction` sat here on the argument that
// orgToken was "reporter-attribution context, not a data-access scope, so the
// worst case is a report attributed to the wrong org". The top-10 review's H1
// showed the worst case was not that: bare requireCapability was the ONLY gate
// on a write that puts a stranger's animal under a public rabies observation
// the owner cannot lift. The exemption reasoned about data READS and the
// dangerous thing was a WRITE. An allowlist entry is a hypothesis about impact,
// and this one was wrong — so treat every future entry as one too.
export const CONFUSED_DEPUTY_ALLOWLIST: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Signature param-list extraction. `fn.body` begins at the
// `export async function NAME(` line; balance parens from the first `(` so
// destructured `{ … }` params and default values are captured whole.
// ---------------------------------------------------------------------------
export function signatureParamList(body: string): string {
  const open = body.indexOf("(");
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return body.slice(open + 1, i);
    }
  }
  return "";
}

export function hasOrgTokenParam(paramList: string): boolean {
  return ORG_TOKEN_PARAM_RE.test(paramList);
}

/** True when the body pulls an org token out of FormData (the second lane). */
export function readsOrgTokenFromFormData(body: string): boolean {
  return ORG_TOKEN_FORMDATA_RE.test(body);
}

export function callsBareRequireCapability(body: string): boolean {
  return BARE_REQUIRE_CAPABILITY_RE.test(body);
}

export function callsRequireCapabilityForOrgToken(body: string): boolean {
  return FOR_ORG_TOKEN_RE.test(body);
}

// The full heuristic: the action names an org token — in its SIGNATURE or in
// its FormData — and still gates with bare requireCapability. Inner writers are
// exempt (guarded upstream).
export function isConfusedDeputyOffender(fn: ExportedFn): boolean {
  if (isInnerWriter(fn.name)) return false;
  const code = stripComments(fn.body);
  const namesOrgToken =
    hasOrgTokenParam(signatureParamList(code)) || readsOrgTokenFromFormData(code);
  if (!namesOrgToken) return false;
  if (callsRequireCapabilityForOrgToken(code)) return false;
  return callsBareRequireCapability(code);
}

/**
 * Offenders in one file as `path:line NAME` lines (allowlisted ones excluded).
 *
 * `allowlist` is a parameter, defaulting to the real one, so the exclusion
 * MECHANISM stays testable now that the real list is empty. It used to read the
 * module constant directly and its test picked `Object.keys(...)[0]` — which
 * means emptying the list (the goal) would have left the mechanism untested
 * while the suite stayed green. A test that can only run while the bug exists
 * is not a test of the fix.
 */
export function findConfusedDeputyOffenders(
  relPath: string,
  src: string,
  allowlist: Record<string, string> = CONFUSED_DEPUTY_ALLOWLIST,
): string[] {
  const out: string[] = [];
  for (const fn of extractExportedAsyncFunctions(src)) {
    if (!isConfusedDeputyOffender(fn)) continue;
    if (allowlist[`${relPath}#${fn.name}`] !== undefined) continue;
    out.push(`${relPath}:${fn.startLine} ${fn.name}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runScan(): void {
  const actionFiles = listActionFiles();
  if (actionFiles.length === 0) {
    console.error("✗ check-confused-deputy: found no server-action files to scan.");
    process.exit(1);
  }

  const offenders: string[] = [];
  let allowlisted = 0;
  for (const file of actionFiles) {
    const relPath = file.replaceAll("\\", "/");
    const src = readFileSync(file, "utf8");
    offenders.push(...findConfusedDeputyOffenders(relPath, src));
    for (const fn of extractExportedAsyncFunctions(src)) {
      if (
        isConfusedDeputyOffender(fn) &&
        CONFUSED_DEPUTY_ALLOWLIST[`${relPath}#${fn.name}`] !== undefined
      ) {
        allowlisted++;
      }
    }
  }

  if (offenders.length > 0) {
    const hint =
      'gated by BARE requireCapability("cap") (resolves the session-default / most-recently-joined ' +
      "membership, NOT the URL org). A multi-org member acting from /org/{orgToken}/… is authorized " +
      'against the wrong org. Pin it: requireCapabilityForOrgToken("cap", orgToken). If genuinely ' +
      "safe/out-of-lane, add it to CONFUSED_DEPUTY_ALLOWLIST with a reason.";
    for (const o of offenders) {
      console.error(`${o} — org-token action ${hint}`);
    }
    console.error(`\n✗ ${offenders.length} org-token confused-deputy offender(s).`);
    process.exit(1);
  }

  console.log(
    `✓ confused-deputy clean — ${actionFiles.length} action files scanned; every org-token ` +
      `action pins its capability check to the URL token${
        allowlisted > 0 ? ` (${allowlisted} documented-safe exception(s))` : ""
      }.`,
  );
}

// Guard: only scan when run directly; importing (tests) exposes the helpers
// without triggering the filesystem scan.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-confused-deputy.ts") ||
    process.argv[1].endsWith("check-confused-deputy.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
