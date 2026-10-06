// Administrative-authority fence (jurisdiction-admin Phase 7).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Administrative power used to be ONE yes/no — "is this an active admin?" —
// asked by five local copies of the same predicate. jurisdiction-admin split
// it: the platform admin acts anywhere, a jurisdiction admin only inside the
// province of the TARGET row. One module answers it
// (src/modules/organizations/application/admin-authority/authority.ts), and
// every writer must ask it. A writer that forgets to ask does not fail a test
// nobody wrote; it quietly hands a province admin the whole country.
//
// The fence enumerates the SUBJECT — every exported function that acts on
// behalf of an actor — never a list of known call sites, so a new writer is
// covered the day it is written.
//
// RULES
//   1. writer-guard. In the administration writer folders (WRITER_ROOTS),
//      every exported function that takes an actor (a parameter named after
//      one of ACTOR_NAMES — `actorUserId`, `grantedByUserId`,
//      `revokedByUserId` — destructured or not, or `<param>.<that name>` read
//      in its body) must call an authority guard somewhere in its body:
//      BASE_GUARDS, a WRAPPER (itself verified to call a base guard), or a
//      PLATFORM_PREDICATE (verified, in lib/domain/institutional-scope.ts, to
//      return isPlatformAdmin). `hasAdminAuthority` is NOT a guard on its own:
//      it says "some authority" and names no place. The revocation writers
//      (revocations/) answer to a second, older authority — the govt's own
//      coverage RANK over the target — and each one listed in
//      RANK_GUARDED_WRITERS must call RANK_GUARD (verified to compare places
//      in lib/domain/revocation-scope.ts); a new revocation writer is listed
//      on purpose or asks a base guard.
//   2. no-local-admin-check. No `isActiveAdmin` is defined anywhere in the
//      app, and the writer folders compare no role to "admin" by hand (TS or
//      SQL). Frozen exceptions carry an exact count and a reason.
//   3. gob-audit-reads. Every file under app/gob/ that reads audit_log
//      (`.from(auditLog)` or SQL `from audit_log`) builds its WHERE with
//      buildAuditHistoryWhere and its columns with auditHistoryRowColumns —
//      the place scope and the M1 redaction. Frozen exceptions: exact count +
//      reason.
//   4. action-guard inventory. Which request guard every exported server
//      action of the administration action files calls — the platform
//      admin's (requireAdminOrRedirect) or the administration principal's
//      (requireAdministrationPrincipalOrRedirect). Widening or narrowing one,
//      or adding one, turns this red on purpose: the diff must say which.
//      (Absorbed from the Phase-6 portal test.)
//
// Parsed with the TypeScript compiler API: comments are trivia, never nodes,
// so an explanatory comment that names a guard or "admin" is never counted,
// and never punished.
//
// Run:  pnpm tsx scripts/check-admin-authority.ts   (or: pnpm lint:admin-authority)
// Exits 1 on any violation, on a stale allowlist entry, or below a floor.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const APP = "src/modules/organizations/application";

/** Rule 1 + 2: where the administration writers live. */
export const WRITER_ROOTS = [
  `${APP}/admin-authority/`,
  `${APP}/admin-institutional/`,
  `${APP}/authority-units/`,
  `${APP}/business-rules/`,
  "lib/place/unresolved-queue.ts",
  // The revocation flow (final review INFO-1): it revokes govt localities, vet
  // roles and org verifications — acts on OTHER accounts, so it is scanned
  // like every writer, under the rank rule below.
  `${APP}/revocations/`,
] as const;

/**
 * Parameter names that carry the acting user (final review INFO-1: a writer
 * that names its actor after the column it fills is still a writer).
 */
export const ACTOR_NAMES = ["actorUserId", "grantedByUserId", "revokedByUserId"] as const;

/** The module that DEFINES the guards: its exports take an actor by design. */
export const GUARD_MODULE = `${APP}/admin-authority/authority.ts`;

/** The one loader's guards. Each names where the actor may act. */
export const BASE_GUARDS = ["requirePlatformAdmin", "requireJurisdictionAdminFor"] as const;

/**
 * Module-local helpers that ask a base guard for their writer (verified: each
 * must be defined in the named file and call a base guard or another wrapper).
 */
export const WRAPPERS: Readonly<Record<string, string>> = {
  creationRefusal: `${APP}/admin-institutional/create-institutional-account.ts`,
  delegatedDeactivationRefusal: `${APP}/admin-institutional/deactivate-govt.ts`,
  delegatedGrantRefusal: `${APP}/authority-units/grant-unit.ts`,
  ruleWriteRefusal: `${APP}/business-rules/rule-authority.ts`,
  assertRuleWritable: `${APP}/business-rules/rule-authority.ts`,
};

/**
 * Pure capability predicates over a loaded profile, platform-only by
 * definition (verified: each returns isPlatformAdmin(...) in DOMAIN_MODULE).
 * The three writers that use them (admin deactivation, credential and MFA
 * reset) predate the authority module and read the profile outside their
 * transaction; the predicate is the same one requirePlatformAdmin applies.
 */
export const PLATFORM_PREDICATES = [
  "canCreateInstitutional",
  "canResetCredentials",
  "canDeactivateAdmin",
] as const;
export const DOMAIN_MODULE = "lib/domain/institutional-scope.ts";

/**
 * Exported functions that take an actor and are NOT administrative acts.
 * Key: "file#function". Never add an entry to make a writer pass.
 */
export const WRITER_EXEMPT: Readonly<Record<string, string>> = {
  [`${APP}/admin-institutional/helpers.ts#loadActorProfile`]:
    "loads the actor's profile FOR a guard; decides nothing",
  [`${APP}/revocations/helpers.ts#loadActorAuthority`]:
    "loads the actor's role and coverage FOR canRevoke; decides nothing",
  [`${APP}/revocations/helpers.ts#claimAttachmentsForAudit`]:
    "inside the caller's (guarded) transaction, claims only files the actor uploaded themself",
  [`${APP}/revocations/upload-evidence.ts#uploadRevocationEvidence`]:
    "stores the actor's OWN evidence file, unattached; it takes effect only when a guarded revocation claims it",
  [`${APP}/business-rules/rule-authority.ts#missingRuleRefusal`]:
    "chooses the refusal copy for a rule id that matches no row; the writer still asserts the stored rule",
};

/**
 * The revocation flow's authority (rule 1): `canRevoke(profile, target,
 * coverage)` — the platform admin, or a govt whose coverage contains (for a
 * locality, strictly outranks) the TARGET's place. Verified in its module to
 * compare places, so a stub that returns true is caught. Not a jurisdiction-
 * admin power: any govt holds it within its own coverage, by design (Fase 5
 * revocation spec); on govt_assignments the database also refuses to revoke an
 * active appointment's implied grant (0268).
 */
export const RANK_GUARD = "canRevoke";
export const RANK_MODULE = "lib/domain/revocation-scope.ts";
const RANK_PLACE_COMPARATORS = ["jurisdictionScopeContains", "govtCoverageStrictlyContains"];

/** Revocation writers that answer to RANK_GUARD, each with why. */
export const RANK_GUARDED_WRITERS: Readonly<Record<string, string>> = {
  [`${APP}/revocations/revoke-govt-locality.ts#revokeGovtLocalityForAuthority`]:
    "revokes another govt's locality grant when the actor's coverage strictly outranks it",
  [`${APP}/revocations/revoke-vet-role.ts#revokeVetRoleForAuthority`]:
    "revokes a vet role inside the actor's coverage (license province or operational place)",
  [`${APP}/revocations/revoke-org-verification.ts#revokeOrgVerificationForAuthority`]:
    "revokes an organisation's verification inside the actor's coverage",
};

/** Rule 2: hand-written admin-role comparisons allowed in the writer folders. */
export const RAW_ADMIN_CHECK_ALLOWED: Readonly<Record<string, { count: number; reason: string }>> =
  {
    [`${APP}/admin-institutional/deactivate-admin.ts`]: {
      count: 1,
      reason:
        "the last-admin floor locks the set of TARGET admins FOR UPDATE; the actor is gated by canCreateInstitutional",
    },
    [`${APP}/revocations/helpers.ts`]: {
      count: 1,
      reason:
        "loadActorAuthority's entry test (admin or govt may revoke at all); what they may revoke is canRevoke's decision",
    },
    [`${APP}/revocations/revoke-vet-role.ts`]: {
      count: 2,
      reason:
        "an ORGANISATION membership role: the sole-admin cascade over the TARGET vet's clinics, not the actor's authority",
    },
    [`${APP}/revocations/upload-evidence.ts`]: {
      count: 1,
      reason:
        "who may upload their own evidence file (admin or govt); the file does nothing until a revocation that asks canRevoke claims it",
    },
  };

/** Rule 3: audit_log readers under app/gob/ that are not the history page. */
export const GOB_AUDIT_READ_ALLOWED: Readonly<Record<string, { count: number; reason: string }>> = {
  "app/gob/page.tsx": {
    count: 2,
    reason: "the viewer's OWN rows only (actorUserId = the signed-in user): activity + checklist",
  },
};

export const PLATFORM_GUARD = "requireAdminOrRedirect";
export const PRINCIPAL_GUARD = "requireAdministrationPrincipalOrRedirect";

/** Rule 4: the request guard of every exported administration action. */
export const ACTION_GUARD_INVENTORY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "app/actions/admin-institutional.ts": {
    createInstitutionalAccountAction: PRINCIPAL_GUARD,
    deactivateAdminAction: PLATFORM_GUARD,
    deactivateGovtAction: PRINCIPAL_GUARD,
    resetInstitutionalCredentialsAction: PLATFORM_GUARD,
    resetMfaFactorsAction: PLATFORM_GUARD,
    assignGovtLocalityAction: PRINCIPAL_GUARD,
  },
  "app/actions/authority-units.ts": {
    moveLocalityToUnitAction: PRINCIPAL_GUARD,
    removeLocalityFromUnitAction: PRINCIPAL_GUARD,
    closeRemovedLocalityMembershipAction: PLATFORM_GUARD,
    createAuthorityUnitAction: PRINCIPAL_GUARD,
    renameAuthorityUnitAction: PRINCIPAL_GUARD,
    confirmAuthorityUnitAction: PRINCIPAL_GUARD,
    confirmGrantUnitAction: PRINCIPAL_GUARD,
  },
  "app/actions/resolve-place.ts": {
    resolvePlaceFromQueueAction: PLATFORM_GUARD,
  },
  "app/actions/authority-unit-reversals.ts": {
    unconfirmAuthorityUnitAction: PLATFORM_GUARD,
    unconfirmGrantUnitAction: PLATFORM_GUARD,
  },
  "app/actions/govt-reactivation.ts": {
    reactivateGovtAction: PLATFORM_GUARD,
  },
  "app/actions/jurisdiction-admin.ts": {
    appointJurisdictionAdminAction: PLATFORM_GUARD,
    revokeJurisdictionAdminAction: PLATFORM_GUARD,
  },
  "app/actions/business-rules.ts": {
    createBusinessRuleAction: PRINCIPAL_GUARD,
    updateBusinessRuleAction: PRINCIPAL_GUARD,
    deleteBusinessRuleAction: PRINCIPAL_GUARD,
  },
};

/**
 * Non-vacuity floors, measured 2026-09-27. A broken parser reads 0; a floor
 * that trips means the scanner stopped seeing the subject, not that the code
 * got better. Raise a floor when writers are added; never lower it to pass.
 */
export const MIN_ACTOR_WRITERS = 27;
export const MIN_GOB_AUDIT_READERS = 1;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export type SourceFile = { file: string; source: string };

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

type FunctionLike = { name: string; node: ts.FunctionLikeDeclaration; exported: boolean };

/** Every top-level function of a file: declarations and `const x = (…) => …`. */
function topLevelFunctions(sf: ts.SourceFile): FunctionLike[] {
  const out: FunctionLike[] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      out.push({ name: stmt.name.text, node: stmt, exported: isExported(stmt) });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (
          ts.isIdentifier(decl.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          out.push({ name: decl.name.text, node: init, exported: isExported(stmt) });
        }
      }
    }
  }
  return out;
}

function forEachDescendant(node: ts.Node, visit: (n: ts.Node) => void): void {
  const walk = (n: ts.Node) => {
    visit(n);
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node, walk);
}

/** The simple name a call targets: `f(…)`, `await f(…)`, `x.f(…)` → "f". */
function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** Every function name `node` calls, nested closures included. */
export function calledNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  forEachDescendant(node, (n) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name) names.add(name);
    }
  });
  return names;
}

const ACTOR_NAME_SET: ReadonlySet<string> = new Set(ACTOR_NAMES);

/** Does this function take an actor? (see rule 1) */
export function takesActor(fn: ts.FunctionLikeDeclaration): boolean {
  const paramNames = new Set<string>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) {
      if (ACTOR_NAME_SET.has(p.name.text)) return true;
      paramNames.add(p.name.text);
    } else if (ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) {
        const prop = el.propertyName ?? el.name;
        if (ts.isIdentifier(prop) && ACTOR_NAME_SET.has(prop.text)) return true;
      }
    }
  }
  let reads = false;
  if (fn.body) {
    forEachDescendant(fn.body, (n) => {
      if (
        ts.isPropertyAccessExpression(n) &&
        ACTOR_NAME_SET.has(n.name.text) &&
        ts.isIdentifier(n.expression) &&
        paramNames.has(n.expression.text)
      ) {
        reads = true;
      }
    });
  }
  return reads;
}

function underAny(file: string, roots: readonly string[]): boolean {
  return roots.some((r) => (r.endsWith("/") ? file.startsWith(r) : file === r));
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type Violation = { rule: string; where: string; message: string };

export type Report = {
  violations: Violation[];
  /** "file#function" of every actor writer the rule saw (exemptions excluded). */
  actorWriters: string[];
  gobAuditReaders: number;
};

/** Wrappers that (transitively) reach a base guard, from their definitions. */
function verifiedWrappers(
  parsed: ReadonlyMap<string, ts.SourceFile>,
  violations: Violation[],
): Set<string> {
  const bodies = new Map<string, Set<string>>();
  for (const [name, file] of Object.entries(WRAPPERS)) {
    const sf = parsed.get(file);
    const fn = sf ? topLevelFunctions(sf).find((f) => f.name === name) : undefined;
    if (!fn) {
      violations.push({
        rule: "writer-guard",
        where: `${file}#${name}`,
        message: "stale WRAPPERS entry: no such function in that file",
      });
      continue;
    }
    bodies.set(name, calledNames(fn.node));
  }
  const ok = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, calls] of bodies) {
      if (ok.has(name)) continue;
      if ([...calls].some((c) => (BASE_GUARDS as readonly string[]).includes(c) || ok.has(c))) {
        ok.add(name);
        grew = true;
      }
    }
  }
  for (const name of bodies.keys()) {
    if (!ok.has(name)) {
      violations.push({
        rule: "writer-guard",
        where: `${WRAPPERS[name]}#${name}`,
        message: `wrapper calls no authority guard (${BASE_GUARDS.join(" / ")})`,
      });
    }
  }
  return ok;
}

/** Platform predicates whose definition returns isPlatformAdmin(...). */
function verifiedPredicates(
  parsed: ReadonlyMap<string, ts.SourceFile>,
  violations: Violation[],
): Set<string> {
  const ok = new Set<string>();
  const sf = parsed.get(DOMAIN_MODULE);
  for (const name of PLATFORM_PREDICATES) {
    const fn = sf ? topLevelFunctions(sf).find((f) => f.name === name) : undefined;
    if (fn && calledNames(fn.node).has("isPlatformAdmin")) {
      ok.add(name);
    } else {
      violations.push({
        rule: "writer-guard",
        where: `${DOMAIN_MODULE}#${name}`,
        message: fn
          ? "platform predicate no longer asks isPlatformAdmin"
          : "stale PLATFORM_PREDICATES entry: no such function",
      });
    }
  }
  return ok;
}

/** RANK_GUARD, if its definition still compares the target's place. */
function verifiedRankGuard(
  parsed: ReadonlyMap<string, ts.SourceFile>,
  violations: Violation[],
): string | null {
  const sf = parsed.get(RANK_MODULE);
  const fn = sf ? topLevelFunctions(sf).find((f) => f.name === RANK_GUARD) : undefined;
  const calls = fn ? calledNames(fn.node) : new Set<string>();
  if (fn && RANK_PLACE_COMPARATORS.every((c) => calls.has(c))) return RANK_GUARD;
  violations.push({
    rule: "writer-guard",
    where: `${RANK_MODULE}#${RANK_GUARD}`,
    message: fn
      ? `rank guard no longer compares places (${RANK_PLACE_COMPARATORS.join(", ")})`
      : "stale RANK_GUARD: no such function",
  });
  return null;
}

const ADMIN_LITERAL = new Set(["admin"]);
const SQL_ADMIN_ROLE = /\brole\s*(?:=|<>|!=)\s*'admin'|'admin'\s*(?:=|<>|!=)\s*\S*\brole\b/i;
const EQUALITY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The text of a string literal or of one static piece of a template, else null. */
function literalText(n: ts.Node): string | null {
  return ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isTemplateHead(n) ||
    ts.isTemplateMiddle(n) ||
    ts.isTemplateTail(n)
    ? n.text
    : null;
}

function isAdminLiteral(n: ts.Node): boolean {
  return (
    (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && ADMIN_LITERAL.has(n.text)
  );
}

function endsInRole(n: ts.Node, sf: ts.SourceFile): boolean {
  return /(?:^|\.)role$/i.test(n.getText(sf).replace(/\?\./g, "."));
}

/** `x.role === "admin"` (either side, any equality) or `eq(x.role, "admin")`. */
function isRawAdminComparison(n: ts.Node, sf: ts.SourceFile): boolean {
  let pair: readonly [ts.Node, ts.Node] | null = null;
  if (ts.isBinaryExpression(n) && EQUALITY_OPERATORS.has(n.operatorToken.kind)) {
    pair = [n.left, n.right];
  } else if (ts.isCallExpression(n) && n.arguments.length === 2) {
    const name = calleeName(n);
    if (name === "eq" || name === "ne") pair = [n.arguments[0], n.arguments[1]];
  }
  if (!pair) return false;
  const [a, b] = pair;
  return (isAdminLiteral(a) && endsInRole(b, sf)) || (isAdminLiteral(b) && endsInRole(a, sf));
}

/** Hand-written admin-role comparisons in a parsed file (TS and SQL literals). */
export function countRawAdminChecks(sf: ts.SourceFile): number {
  let count = 0;
  forEachDescendant(sf, (n) => {
    const text = literalText(n);
    if (text !== null ? SQL_ADMIN_ROLE.test(text) : isRawAdminComparison(n, sf)) count++;
  });
  return count;
}

const SQL_FROM_AUDIT = /\bfrom\s+(?:public\.)?audit_log\b/i;

function isFromAuditLog(n: ts.Node): boolean {
  if (!ts.isCallExpression(n) || n.arguments.length !== 1) return false;
  const [arg] = n.arguments;
  return (
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === "from" &&
    ts.isIdentifier(arg) &&
    arg.text === "auditLog"
  );
}

/** audit_log reads in a parsed file: `.from(auditLog)` calls + SQL `from audit_log`. */
export function countAuditReads(sf: ts.SourceFile): number {
  let count = 0;
  forEachDescendant(sf, (n) => {
    const text = literalText(n);
    if (text !== null ? SQL_FROM_AUDIT.test(text) : isFromAuditLog(n)) count++;
  });
  return count;
}

/** The request guard each exported action of a parsed file calls, or "NONE". */
export function actionGuards(sf: ts.SourceFile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const fn of topLevelFunctions(sf)) {
    if (!fn.exported) continue;
    const calls = calledNames(fn.node);
    const found = [PRINCIPAL_GUARD, PLATFORM_GUARD].filter((g) => calls.has(g));
    out[fn.name] = found.length === 2 ? "BOTH" : (found[0] ?? "NONE");
  }
  return out;
}

type Parsed = ReadonlyMap<string, ts.SourceFile>;

/** Allowlist entries (keys) the scan never met are errors. */
function staleEntries(
  rule: string,
  keys: readonly string[],
  seen: ReadonlySet<string>,
  message: string,
): Violation[] {
  return keys.filter((k) => !seen.has(k)).map((where) => ({ rule, where, message }));
}

function ruleWriterGuard(parsed: Parsed, violations: Violation[]): string[] {
  const wrappers = verifiedWrappers(parsed, violations);
  const predicates = verifiedPredicates(parsed, violations);
  const rankGuard = verifiedRankGuard(parsed, violations);
  const accepted = new Set<string>([...BASE_GUARDS, ...wrappers, ...predicates]);
  const exemptSeen = new Set<string>();
  const rankSeen = new Set<string>();
  const actorWriters: string[] = [];
  for (const [file, sf] of parsed) {
    if (!underAny(file, WRITER_ROOTS) || file === GUARD_MODULE) continue;
    for (const fn of topLevelFunctions(sf)) {
      if (!fn.exported || !takesActor(fn.node)) continue;
      const key = `${file}#${fn.name}`;
      if (key in WRITER_EXEMPT) {
        exemptSeen.add(key);
        continue;
      }
      actorWriters.push(key);
      const calls = calledNames(fn.node);
      if (key in RANK_GUARDED_WRITERS) {
        rankSeen.add(key);
        if (rankGuard && calls.has(rankGuard)) continue;
        violations.push({
          rule: "writer-guard",
          where: key,
          message: `a revocation writer that does not ask ${RANK_GUARD} (the target's place against the actor's coverage)`,
        });
        continue;
      }
      if (![...calls].some((c) => accepted.has(c))) {
        violations.push({
          rule: "writer-guard",
          where: key,
          message: `takes an actor but asks no authority guard (accepted: ${[...accepted].sort().join(", ")})`,
        });
      }
    }
  }
  violations.push(
    ...staleEntries(
      "writer-guard",
      Object.keys(RANK_GUARDED_WRITERS),
      rankSeen,
      "stale RANK_GUARDED_WRITERS entry: no exported function taking an actor by that name",
    ),
  );
  violations.push(
    ...staleEntries(
      "writer-guard",
      Object.keys(WRITER_EXEMPT),
      exemptSeen,
      "stale WRITER_EXEMPT entry: no exported function taking an actor by that name",
    ),
  );
  return actorWriters;
}

function ruleNoLocalAdminCheck(parsed: Parsed, violations: Violation[]): void {
  const rawSeen = new Set<string>();
  for (const [file, sf] of parsed) {
    if (topLevelFunctions(sf).some((fn) => fn.name === "isActiveAdmin")) {
      violations.push({
        rule: "no-local-admin-check",
        where: `${file}#isActiveAdmin`,
        message: "a local admin predicate; ask admin-authority/authority.ts instead",
      });
    }
    if (!underAny(file, WRITER_ROOTS)) continue;
    const count = countRawAdminChecks(sf);
    const allowed = RAW_ADMIN_CHECK_ALLOWED[file];
    if (allowed) rawSeen.add(file);
    if (count === (allowed?.count ?? 0)) continue;
    violations.push({
      rule: "no-local-admin-check",
      where: file,
      message: allowed
        ? `${count} hand-written admin-role comparison(s), frozen at ${allowed.count} — lower the entry if one was removed`
        : `${count} hand-written admin-role comparison(s); use requirePlatformAdmin / requireJurisdictionAdminFor`,
    });
  }
  violations.push(
    ...staleEntries(
      "no-local-admin-check",
      Object.keys(RAW_ADMIN_CHECK_ALLOWED),
      rawSeen,
      "stale RAW_ADMIN_CHECK_ALLOWED entry: file not found",
    ),
  );
}

const SCOPED_AUDIT_READ = ["buildAuditHistoryWhere", "auditHistoryRowColumns"] as const;

function ruleGobAuditReads(parsed: Parsed, violations: Violation[]): number {
  const gobSeen = new Set<string>();
  let readers = 0;
  for (const [file, sf] of parsed) {
    if (!file.startsWith("app/gob/")) continue;
    const count = countAuditReads(sf);
    const allowed = GOB_AUDIT_READ_ALLOWED[file];
    if (allowed) gobSeen.add(file);
    if (allowed && count !== allowed.count) {
      violations.push({
        rule: "gob-audit-reads",
        where: file,
        message: `${count} audit_log read(s), frozen at ${allowed.count} — a new read goes through ${SCOPED_AUDIT_READ.join(" + ")}`,
      });
    }
    if (allowed || count === 0) continue;
    readers++;
    const calls = calledNames(sf);
    const missing = SCOPED_AUDIT_READ.filter((g) => !calls.has(g));
    if (missing.length > 0) {
      violations.push({
        rule: "gob-audit-reads",
        where: file,
        message: `reads audit_log without ${missing.join(" and ")} (place scope + redaction)`,
      });
    }
  }
  violations.push(
    ...staleEntries(
      "gob-audit-reads",
      Object.keys(GOB_AUDIT_READ_ALLOWED),
      gobSeen,
      "stale GOB_AUDIT_READ_ALLOWED entry: file not found",
    ),
  );
  return readers;
}

function actionGuardMessage(want: string | undefined, got: string | undefined): string {
  if (want === undefined) {
    return `new exported action guarded by ${got}: pin it in ACTION_GUARD_INVENTORY on purpose`;
  }
  if (got === undefined) return "stale ACTION_GUARD_INVENTORY entry: no such exported action";
  return `guard is ${got}, pinned ${want}`;
}

function ruleActionGuards(parsed: Parsed, violations: Violation[]): void {
  for (const [file, expected] of Object.entries(ACTION_GUARD_INVENTORY)) {
    const sf = parsed.get(file);
    if (!sf) {
      violations.push({
        rule: "action-guards",
        where: file,
        message: "stale ACTION_GUARD_INVENTORY entry: file not found",
      });
      continue;
    }
    const found = actionGuards(sf);
    for (const name of new Set([...Object.keys(expected), ...Object.keys(found)])) {
      if (expected[name] === found[name]) continue;
      violations.push({
        rule: "action-guards",
        where: `${file}#${name}`,
        message: actionGuardMessage(expected[name], found[name]),
      });
    }
  }
}

/** Parse only what a rule reads (see evaluate). */
function inScope(file: string, source: string): boolean {
  return (
    underAny(file, WRITER_ROOTS) ||
    file === DOMAIN_MODULE ||
    file === RANK_MODULE ||
    file.startsWith("app/gob/") ||
    file in ACTION_GUARD_INVENTORY ||
    source.includes("isActiveAdmin")
  );
}

export function evaluate(files: readonly SourceFile[]): Report {
  // A file outside every rule's scope can break only rule 2's isActiveAdmin
  // ban, and cannot without spelling the name — so only those are parsed.
  const parsed = new Map<string, ts.SourceFile>();
  for (const { file, source } of files) {
    if (inScope(file, source)) parsed.set(file, parse(file, source));
  }
  const violations: Violation[] = [];
  const actorWriters = ruleWriterGuard(parsed, violations);
  ruleNoLocalAdminCheck(parsed, violations);
  const gobAuditReaders = ruleGobAuditReads(parsed, violations);
  ruleActionGuards(parsed, violations);
  return { violations, actorWriters, gobAuditReaders };
}

// ---------------------------------------------------------------------------
// Repository scan
// ---------------------------------------------------------------------------

const ROOTS = ["app", "components", "lib", "src"];
const SKIP_DIRS = new Set(["node_modules", "__tests__", ".next"]);
const EXTENSIONS = /\.(ts|tsx)$/;
const TEST_FILE = /\.(test|spec)\.[a-z]+$/;

export function readSources(root = "."): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (EXTENSIONS.test(entry) && !TEST_FILE.test(entry) && !entry.endsWith(".d.ts")) {
        out.push({
          file: relative(root, path).split(sep).join("/"),
          source: readFileSync(path, "utf8"),
        });
      }
    }
  };
  for (const r of ROOTS) walk(join(root, r));
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function main(): void {
  const files = readSources();
  if (process.argv.includes("--list")) {
    for (const key of evaluate(files).actorWriters) console.log(key);
    return;
  }
  const { violations, actorWriters, gobAuditReaders } = evaluate(files);

  if (actorWriters.length < MIN_ACTOR_WRITERS || gobAuditReaders < MIN_GOB_AUDIT_READERS) {
    console.error(
      `\n✗ admin-authority fence saw ${actorWriters.length} actor writer(s) (floor ${MIN_ACTOR_WRITERS}) and ${gobAuditReaders} scoped /gob audit reader(s) (floor ${MIN_GOB_AUDIT_READERS}) across ${files.length} files. The scanner is broken, not the code.`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error("\n✗ administrative authority asked outside the one authority module:");
    for (const v of violations) console.error(`  [${v.rule}] ${v.where}: ${v.message}`);
    console.error(
      "\n  Writers ask src/modules/organizations/application/admin-authority/authority.ts (requirePlatformAdmin / requireJurisdictionAdminFor) inside their transaction, with the province of the TARGET row. See the header of this script for each rule.",
    );
    process.exit(1);
  }
  console.log(
    `✓ admin-authority fence clean — ${actorWriters.length} actor writer(s) guarded, ${gobAuditReaders} scoped /gob audit reader(s), ${Object.values(ACTION_GUARD_INVENTORY).reduce((n, m) => n + Object.keys(m).length, 0)} pinned action guard(s).`,
  );
}

if (process.argv[1]?.includes("check-admin-authority")) {
  main();
}
