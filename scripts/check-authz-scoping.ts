// Authorization-SCOPING linter — CI guardrail (regression armor).
//
// Sibling to check-authz-guards.ts. That linter answers "is there a guard AT
// ALL?". This one answers the next question: "the guard proves the caller is an
// admin / govt agent / org member — but does the action then derive the
// authority it acts with FROM that guard (or the session), or does it go on to
// act on caller-supplied input alone?".
//
// THE PATTERN THIS CATCHES ("guard-called-but-not-scoped"):
//   A server action calls an INSTITUTIONAL or CAPABILITY guard — one that
//   establishes authority OVER OTHER TENANTS (admin/govt/org/capability), not
//   merely a logged-in session — and then does its work with a caller-supplied
//   resource id (orgId / targetUserId / publicToken / disputeToken / ruleId /
//   firingId …) while the guard's result never reaches that work. A govt agent
//   is bounded to their jurisdiction and an org member to their tenant; a role
//   check whose result is thrown away lets a scoped operator act outside their
//   bounds the moment the downstream query forgets the WHERE clause, because
//   nothing downstream knows WHO is acting. See
//   dim-interno:docs/design/handoffs/2026-07-04-authz-inventory-raw.md for the
//   hand audit this automates.
//
// HOW IT DECIDES — STRUCTURE, NOT WORDS (A5d, 2026-10-07).
//   Until A5d this file decided "scoped" by searching the action body for words
//   (/localidad/i, /locality/i, /actorUserId/, …). resolvePlaceFromQueueAction
//   passed for months ONLY because a revalidatePath("/admin/localidades/…")
//   string literal matched /localidad/i; removing the revalidate turned the
//   fence red and exposed an action that threaded no actor at all (fixed in
//   01dfe9e33 by binding actorUserId from the session). Equally, an action that
//   bound `user.id` from the guard and handed it to its writer was flagged,
//   because `user.id` is not one of the words. The verdict tracked naming, not
//   authority. Now the action is parsed with the TypeScript compiler API and:
//
//   SUBJECT — an exported async function (not an inner writer, not opted out
//     with @no-auth-required) whose body CALLS one of TENANT_GUARDS. A guard
//     named in a comment or a string is not a call and does not count.
//
//   SCOPED — some value bound from a SESSION SOURCE reaches the work:
//     (1) a session source is a call to any recognised guard (the tenant ones
//         below, every personal/pet/org guard on check-authz-guards.ts's
//         AUTH_GUARDS and INSTITUTIONAL_GUARDS) or to `getUser()`/`getSession()`;
//     (2) a DECLARATION is TAINTED when its initializer contains such a call
//         (`const { user } = await requireAdminOrRedirect()`), or references an
//         already tainted one (`const actorUserId = user.id`,
//         `const capOk = cap as RequireCapabilitySuccess`). References are
//         resolved through block, loop, catch and parameter scopes, so an
//         inner `user` that shadows the guard's is a different variable;
//     (3) the action is scoped when a tainted reference is
//           - an ARGUMENT (directly, or nested in an object/array/spread/
//             template) of a call that is not incidental — a writer, a
//             use-case, a predicate builder like eq(), a binding guard such as
//             requireJurisdictionAdminFor(tx, actorUserId, province);
//           - an operand of an equality comparison whose other side is not a
//             constant (the inline re-check
//             `organization.publicToken !== input.receiverOrgToken`; NOT
//             `role === "admin"` / `=== ROLES.admin` / `=== ADMIN_ROLE`);
//           - the receiver of a membership predicate whose argument reads a
//             non-session value (`session.jurisdictions.some((j) => j.province
//             === pet.province)`; NOT `user.roles.some((r) => r === "admin")`);
//           - interpolated into a `sql` tagged template.
//     INCIDENTAL calls do not count: revalidate*(), redirect(), notFound(),
//     String()/Number()/Boolean(), console/JSON/Sentry/logger/Math methods,
//     methods on an UPPER_CASE constant (`ADMIN_ROLES.includes(role)`), and
//     another session source (handing the session to a second admission guard
//     re-asks who the caller is and binds nothing). A tainted value that only
//     reaches a cache tag, a log line or a redirect URL authorises nothing.
//     Strings and comments are not code; an identifier that merely SPELLS an
//     authority word (`input.actorUserId`, a parameter named `localityId`) is
//     not tainted, because taint comes from where the value was bound, not
//     from what it is called.
//
//   (a) Or the guard is PINNED TO THE ROW: a tenant guard called with a value
//     read from the database by a query NOT keyed by the session
//     (`requireCapability("appointment.manage", appt.organizationId)` after
//     `const [appt] = await db.select()…where(eq(…publicToken, token))`), AND
//     that row then reaches the work (`markNoShow(appt.id)`). The resource
//     flows into the guard instead of the guard into the work.
//
//   NOT SCOPE (security review, 2026-10-07): admission helpers on the
//   caller's own membership (getGrantedCapabilities, isManagerRole); error
//   construction and fail(); `if (user.id === targetId) throw` (refuses on a
//   MATCH — self-protection, not binding); a flag derived by a constant
//   comparison (`const isAdmin = role === "admin"`); a destructured `error`
//   from a guard (the refusal channel).
//
//   Both `export async function f` and `export const f = async () => {}` are
//   read.
//
//   A guard whose result is discarded (`await requireAdminOrRedirect();`
//   followed by work on input only) therefore proves ADMISSION, not scope, and
//   is an offender. For a platform-admin-only action that is a weak offence —
//   the admin is global by design — but it still means the work runs with no
//   actor the writer could audit or re-check, which is exactly the shape
//   01dfe9e33 had to fix.
//
//   WHAT "SCOPED" DOES NOT PROVE. Delegation is trusted: when the actor reaches
//   a writer, this file cannot see whether the writer re-checks jurisdiction
//   with it (that is lint:admin-authority's and the writers' own tests' job).
//   The claim is narrower and structural: the authority the work runs with is
//   derived from the guard/session, never from client input alone. Its known
//   limit: ANY non-incidental call the session reaches counts, so an action
//   that threads the actor only into an audit row or a read of the caller's own
//   profile, and mutates by input id alone, still reads as scoped. Tightening
//   that needs to know which call is "the" write, which this file does not.
//
//   Personal-tier guards (requireUser*/requirePetAccess*/requireTitularAccess/
//   requireOwnedPet*) are NOT tenant guards, so an action gated only by those
//   is never a SUBJECT here — they do count as session SOURCES, so their result
//   flowing into the work of a tenant-guarded action counts as scoping.
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
//       about any pet the action goes on to touch.
//   Both gaps are real and this file covers neither:
//     3rd rule (uncovered) — identity-only guard + caller-chosen pet
//       identifier + no binding predicate.
//     4th rule (covered elsewhere) — pet bound to the caller but the caller's
//       ROLE not allowed to perform the effect: scripts/check-titular-gate.ts,
//       public.has_titular_write_access() (migration 0190) and the UI
//       (deriveMasSheetItems, components/pet-profile/NotTitularNotice).
//
// BASELINE — BY IDENTITY, WITH A REASON (A5d).
//   scripts/authz-scoping-baseline.json maps `path#exportName` to a one-line
//   reason the export is tolerated. The run fails when an offender is NOT in
//   the baseline (a new hole), when a baseline entry no longer offends (a fixed
//   or removed action whose entry would otherwise be a free pass for the next
//   regression under that name — the A01-8 rule, now per export instead of per
//   file count), and when an entry's reason is empty or still UNREVIEWED.
//   Counting per file (before A5d) let one commit fix an offender and add
//   another in the same file with no diff to the JSON; keying by export closes
//   that. Nothing but review stops someone ADDING an entry, so every diff to the
//   JSON that adds a key is a new offender being accepted.
//
//   DO NOT COPY THE COUNT INTO THIS COMMENT. Every run prints it.
//
// NON-VACUITY. A parser change, a renamed guard or a glob that stops matching
// would turn "no offenders" into "no subjects", which reads exactly like a
// clean run. The run fails unless it found at least MIN_SUBJECTS tenant-guarded
// actions and at least MIN_SCOPED of them scoped, and unless every TENANT_GUARDS
// name has a home in check-authz-guards.ts's GUARD_HOMES (a dead name is a free
// pass for whoever defines it first).
//
// Run: pnpm tsx scripts/check-authz-scoping.ts   (or: pnpm lint:authz-scoping)
//      --write-baseline re-records: keeps existing reasons, drops entries that
//      no longer offend, adds new offenders as UNREVIEWED (which still fails
//      until someone writes the reason).

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";

import {
  AUTH_GUARDS,
  GUARD_HOMES,
  INSTITUTIONAL_GUARDS,
  NO_AUTH_COMMENT,
  isInnerWriter,
  listActionFiles,
} from "./check-authz-guards";

// ---------------------------------------------------------------------------
// Tenant/authority guards — establish authority beyond the caller's own
// session (admin-global, govt-jurisdictional, org-tenant, or capability). An
// action gated by one of these is a SUBJECT: it must thread the authority the
// guard established into its work.
// ---------------------------------------------------------------------------
export const TENANT_GUARDS = [
  "requireAdminOrRedirect",
  // jurisdiction-admin (Phases 4 and 6): admits the platform admin OR a govt
  // with a live appointment for ONE province — authority over other accounts,
  // bounded to a place. Its writers scope inside their transaction
  // (requireJurisdictionAdminFor); lint:admin-authority is the fence for that.
  "requireAdministrationPrincipalOrRedirect",
  "requireAdminOrGovtOrRedirect",
  "requireDecomisoPrincipal",
  // Same role set and jurisdictions query as requireAdminOrGovtOrRedirect,
  // named for denuncia moderation. Missing from this list until A5d, so an
  // action gated by it was never a subject.
  "requireDenunciaModerationPrincipal",
  "requireOrgAccessByToken",
  "requireCapability",
  // Confused-deputy-safe capability guard: resolves the org from the URL token
  // and pins requireCapability to it. A capability guard like its sibling;
  // missing from this list until A5d.
  "requireCapabilityForOrgToken",
  "requireOrgInterventionAccess",
  // File-local admin guard (alert-firings / alert-subscriptions actions):
  // wraps requireLiveUser + a profiles.role === 'admin' re-check.
  "requireAdminUser",
  // Walk-in (atender) org admission: resolves the acting org from the URL token
  // and requires an active membership with event.write. Its sibling
  // resolveAtenderPet(orgToken, petToken) is deliberately NOT here: it resolves
  // the PET through that org's authority in the same call, so the binding is
  // the call itself — the same reason requireOwnedPetByToken is not a subject.
  "resolveAtenderContext",
] as const;

/**
 * Every call that resolves the caller's session or authority. A value bound
 * from one of these is where scope comes from. Includes the tenant guards, the
 * personal/pet/org guards and the bare session readers.
 */
export const SESSION_SOURCES: ReadonlySet<string> = new Set<string>([
  ...TENANT_GUARDS,
  ...AUTH_GUARDS,
  ...INSTITUTIONAL_GUARDS,
  "getUser",
  "getSession",
]);

/**
 * Calls whose arguments are not "the work": a value reaching only these
 * authorises nothing. Besides plumbing (cache, navigation, coercion, logging)
 * this holds:
 *   - ADMISSION helpers that read the caller's own membership:
 *     getGrantedCapabilities(membership) and isManagerRole(membership.role)
 *     answer "may this caller do X at all", never "is THIS resource theirs".
 *     An action that checks them and then writes `where(eq(pets.id,
 *     input.petId))` binds nothing (security review, 2026-10-07).
 *   - REFUSALS: `new Error(…)`, `new FooError(…)`, `fail(…)`. A session value
 *     interpolated into an error message is the action saying no.
 */
const INCIDENTAL_CALLEES =
  /^(?:revalidate\w*|redirect|permanentRedirect|notFound|forbidden|unauthorized|String|Number|Boolean|encodeURIComponent|captureException|getGrantedCapabilities|isManagerRole|fail|\w*Error)$/;
const INCIDENTAL_RECEIVERS = new Set(["console", "JSON", "Sentry", "logger", "Math"]);
/**
 * A guard result's refusal channel. `cap.error` copied into a failure list is
 * the guard saying no, not authority reaching the work.
 */
const REFUSAL_PROPERTIES = new Set(["error"]);
/** Roots of a database read: a local bound from `db.…`/`tx.…` holds a row, not input. */
const DB_ROOTS = new Set(["db", "tx"]);
/** Methods that, called on a tainted receiver, are an authority check in themselves. */
const MEMBERSHIP_METHODS = new Set(["some", "every", "includes", "has"]);
const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * Non-vacuity floors. Measured 2026-10-07 (A5d): 152 tenant-guarded actions, 140
 * of them scoped. Set below so actions can come and go, far above zero because
 * a fence that finds no subjects reports no offenders.
 */
export const MIN_SUBJECTS = 120;
export const MIN_SCOPED = 110;

// ---------------------------------------------------------------------------
// AST analysis
// ---------------------------------------------------------------------------

export type ActionVerdict = {
  name: string;
  /** 1-indexed line of the `export async function` declaration. */
  line: number;
  /** Calls a TENANT_GUARD (and is not an inner writer / opted out). */
  subject: boolean;
  /** How the guard's authority reaches the work, e.g. `user → _approveRequest()`; null when it does not. */
  scopedBy: string | null;
  /** Set when the export's body could not be found (see exportedActions); the runner fails on it. */
  unresolved?: string;
};

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

/**
 * `foo()` → "foo", `a.b.foo()` → "foo", anything else → null.
 *
 * A bare identifier is reported under the name it was IMPORTED as:
 * `import { requireOrgAccessByToken as guard } from "…"; await guard(t)` is a
 * call to requireOrgAccessByToken. Before this, renaming a guard on import took
 * the action out of scope (not a subject) and renaming a session source took
 * its taint away — the verdict tracked the local spelling, not the binding. A
 * local declaration that shadows the import is still the local.
 */
function calleeName(call: ts.CallExpression | ts.NewExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) {
    if (resolveDeclaration(e) !== null) return e.text;
    return importAliases(e.getSourceFile()).get(e.text) ?? e.text;
  }
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

const aliasCache = new WeakMap<ts.SourceFile, ReadonlyMap<string, string>>();

/** Local name → imported name, for every renamed named import of the file. */
function importAliases(sf: ts.SourceFile): ReadonlyMap<string, string> {
  const cached = aliasCache.get(sf);
  if (cached !== undefined) return cached;
  const out = new Map<string, string>();
  for (const s of sf.statements) {
    const named = ts.isImportDeclaration(s) ? s.importClause?.namedBindings : undefined;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (el.propertyName !== undefined) out.set(el.name.text, el.propertyName.text);
    }
  }
  aliasCache.set(sf, out);
  return out;
}

function rootIdentifier(expr: ts.Expression): string | null {
  let e: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : null;
}

function isIncidentalCall(call: ts.CallExpression | ts.NewExpression): boolean {
  const name = calleeName(call);
  if (name !== null && INCIDENTAL_CALLEES.test(name)) return true;
  if (ts.isPropertyAccessExpression(call.expression)) {
    const root = rootIdentifier(call.expression.expression);
    if (root !== null && INCIDENTAL_RECEIVERS.has(root)) return true;
  }
  // Handing a session value to ANOTHER admission guard
  // (`requireCapability("x", me.organizationId)`) re-asks who the caller is;
  // it binds nothing the work then touches. Binding guards that take the
  // target, like requireJurisdictionAdminFor(tx, actor, province), are not
  // session sources and still count.
  if (name !== null && SESSION_SOURCES.has(name)) return true;
  if (ts.isPropertyAccessExpression(call.expression)) {
    const root = rootIdentifier(call.expression.expression);
    // A method on an UPPER_CASE constant (`ADMIN_ROLES.includes(profile.role)`)
    // is a role/state lookup, not work on a resource.
    if (root !== null && /^[A-Z][A-Z0-9_]*$/.test(root)) return true;
  }
  return false;
}

function isFunctionLike(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** Visit every node under `root`, optionally not descending into nested functions. */
function walk(root: ts.Node, visit: (n: ts.Node) => void, intoFunctions = true): void {
  const go = (n: ts.Node): void => {
    visit(n);
    if (!intoFunctions && n !== root && isFunctionLike(n)) return;
    ts.forEachChild(n, go);
  };
  ts.forEachChild(root, go);
}

function callsAny(root: ts.Node, names: ReadonlySet<string>, intoFunctions = true): boolean {
  let found = false;
  walk(
    root,
    (n) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        if (name !== null && names.has(name)) found = true;
      }
    },
    intoFunctions,
  );
  return found;
}

/** True for an identifier in a VALUE position (not a property name or a declaration name). */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isVariableDeclaration(p) && p.name === id) return false;
  if (ts.isParameter(p) && p.name === id) return false;
  if (
    (ts.isFunctionLike(p) || ts.isMethodDeclaration(p)) &&
    (p as ts.NamedDeclaration).name === id
  ) {
    return false;
  }
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) || ts.isTypeQueryNode(p)) return false;
  return true;
}

function bindingIdentifiers(name: ts.BindingName, out: ts.Identifier[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) bindingIdentifiers(el.name, out);
  }
}

function declarationListIdentifiers(list: ts.VariableDeclarationList, out: ts.Identifier[]): void {
  for (const d of list.declarations) bindingIdentifiers(d.name, out);
}

/** The binding identifier `scope` itself declares for `name`, if any (no hoisting). */
function declaresIn(scope: ts.Node, name: string): ts.Identifier | null {
  const found: ts.Identifier[] = [];
  if (isFunctionLike(scope)) {
    for (const p of scope.parameters) bindingIdentifiers(p.name, found);
  } else if (
    ts.isBlock(scope) ||
    ts.isSourceFile(scope) ||
    ts.isCaseClause(scope) ||
    ts.isDefaultClause(scope)
  ) {
    for (const s of scope.statements) {
      if (ts.isVariableStatement(s)) declarationListIdentifiers(s.declarationList, found);
    }
  } else if (
    (ts.isForOfStatement(scope) || ts.isForInStatement(scope) || ts.isForStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    declarationListIdentifiers(scope.initializer, found);
  } else if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined) {
    bindingIdentifiers(scope.variableDeclaration.name, found);
  }
  return found.find((i) => i.text === name) ?? null;
}

/**
 * The declaration a reference resolves to, walking out through every scope.
 * Taint is tracked per DECLARATION, not per name, so an inner `for (const user
 * of rows)`, `catch (user)` or callback parameter that shadows a guard-bound
 * `user` is a different variable and carries no taint.
 */
function resolveDeclaration(id: ts.Identifier): ts.Identifier | null {
  for (let n: ts.Node | undefined = id.parent; n !== undefined; n = n.parent) {
    const d = declaresIn(n, id.text);
    if (d !== null) return d;
  }
  return null;
}

type Taint = ReadonlySet<ts.Identifier>;

function isTaintedRef(n: ts.Node, tainted: Taint): n is ts.Identifier {
  if (!ts.isIdentifier(n) || !isValueReference(n)) return false;
  const decl = resolveDeclaration(n);
  return decl !== null && tainted.has(decl);
}

function referencesTainted(expr: ts.Node, tainted: Taint): boolean {
  if (tainted.size === 0) return false;
  let hit = false;
  const check = (n: ts.Node): void => {
    if (hit) return;
    if (isTaintedRef(n, tainted)) {
      hit = true;
      return;
    }
    ts.forEachChild(n, check);
  };
  check(expr);
  return hit;
}

/**
 * Declarations bound, directly or transitively, from an initializer `seeds`
 * accepts. Document order is enough: a local is declared before it is used.
 */
function localsBoundFrom(
  body: ts.Block,
  seeds: (init: ts.Expression) => boolean,
  blocks: (init: ts.Expression) => boolean = () => false,
): Set<ts.Identifier> {
  const bound = new Set<ts.Identifier>();
  walk(body, (n) => {
    if (!ts.isVariableDeclaration(n) || n.initializer === undefined) return;
    const init = n.initializer;
    // `const isAdmin = profile.role === "admin"` derives a STATE flag from the
    // session, not an identity: it does not inherit taint.
    if (isConstantComparison(init) || blocks(init)) return;
    if (seeds(init) || referencesTainted(init, bound)) {
      const ids: ts.Identifier[] = [];
      bindingIdentifiers(n.name, ids);
      for (const id of ids) if (!isRefusalBinding(id)) bound.add(id);
    }
  });
  return bound;
}

/**
 * `const { error } = await requireCapabilityForOrgToken(…)`: the destructured
 * refusal channel, same as `cap.error`. Throwing or returning it is the guard
 * saying no.
 */
function isRefusalBinding(id: ts.Identifier): boolean {
  const el = id.parent;
  if (!ts.isBindingElement(el) || !ts.isObjectBindingPattern(el.parent)) return false;
  const key = el.propertyName ?? el.name;
  return ts.isIdentifier(key) && REFUSAL_PROPERTIES.has(key.text);
}

function isConstantComparison(init: ts.Expression): boolean {
  let e: ts.Expression = init;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isPrefixUnaryExpression(e)) e = e.operand;
    else break;
  }
  return (
    ts.isBinaryExpression(e) &&
    EQUALITY_OPERATORS.has(e.operatorToken.kind) &&
    (isConstantLike(e.left) || isConstantLike(e.right))
  );
}

/** Declarations bound, directly or transitively, from a session source. */
export function taintedLocals(body: ts.Block): Set<ts.Identifier> {
  return localsBoundFrom(body, (init) => callsAny(init, SESSION_SOURCES, false));
}

/** True when the expression reads the database itself (`db.select…`, `tx.query…`). */
function readsDatabase(init: ts.Expression): boolean {
  let found = false;
  walk(
    init,
    (n) => {
      if (found || !ts.isCallExpression(n)) return;
      const root = rootOfChain(n.expression);
      if (root !== null && DB_ROOTS.has(root)) found = true;
    },
    false,
  );
  return found;
}

/** Root identifier of a call/property chain: `db.select().from(x).where(y)` → "db". */
function rootOfChain(expr: ts.Expression): string | null {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    else break;
  }
  return ts.isIdentifier(e) ? e.text : null;
}

/**
 * Rule (a), the guard-side binding: a guard called WITH a value read from the
 * row the action acts on (`requireCapability("appointment.manage",
 * appt.organizationId)` after `const [appt] = await db.select()…`) checks the
 * caller's authority against the resource's OWN tenant. The resource flows into
 * the guard instead of the guard's result flowing into the work; either
 * direction ties the two together.
 */
function guardPinnedToRow(body: ts.Block, sf: ts.SourceFile, session: Taint): string | null {
  // A row keyed by the SESSION (`where(eq(profiles.id, user.id))`) is the
  // caller's own row: pinning a guard to it is the caller's own tenant, not
  // the resource's. Only a read keyed by something else counts.
  // A guard's RESULT is not the row, even when the row was its argument
  // (`const cap = await requireCapability("x", appt.organizationId)`).
  const rows = localsBoundFrom(
    body,
    (init) => readsDatabase(init) && !referencesTainted(init, session),
    (init) => callsAny(init, SESSION_SOURCES, false),
  );
  if (rows.size === 0) return null;
  // The pinned row must also be what the action WORKS on: checking a
  // capability against one row and then writing another by input id binds
  // nothing (security review, 2026-10-07).
  if (firstSink(body, rows) === null) return null;
  const tenantGuards: ReadonlySet<string> = new Set<string>(TENANT_GUARDS);
  let result: string | null = null;
  walk(body, (n) => {
    if (result !== null || !ts.isCallExpression(n)) return;
    const name = calleeName(n);
    if (name === null || !tenantGuards.has(name)) return;
    for (const arg of n.arguments) {
      if (referencesTainted(arg, rows)) {
        result = `${name}(${arg.getText(sf)}) — guard pinned to the row's own tenant`;
        return;
      }
    }
  });
  return result;
}

/** The first reference to a `taint` declaration that reaches a sink, described; else null. */
function firstSink(body: ts.Block, taint: Taint): { ref: ts.Identifier; sink: ts.Node } | null {
  let result: { ref: ts.Identifier; sink: ts.Node } | null = null;
  walk(body, (n) => {
    if (result !== null || !isTaintedRef(n, taint)) return;
    const sink = flowSink(n, body, taint);
    if (sink !== null) result = { ref: n, sink };
  });
  return result;
}

function describeSink(node: ts.Node, sf: ts.SourceFile): string {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    return `${calleeName(node) ?? node.expression.getText(sf)}()`;
  }
  if (ts.isBinaryExpression(node)) return `${node.operatorToken.getText(sf)} comparison`;
  if (ts.isTaggedTemplateExpression(node)) return `${node.tag.getText(sf)}\`…\``;
  return ts.SyntaxKind[node.kind];
}

/**
 * Walk up from a tainted reference to the nearest statement. The first
 * non-incidental call taking it as an argument, equality comparison, membership
 * predicate on it or sql template around it is where authority reaches work.
 */
function flowSink(ref: ts.Identifier, body: ts.Block, tainted: Taint): ts.Node | null {
  const accessed = ref.parent;
  if (
    ts.isPropertyAccessExpression(accessed) &&
    accessed.expression === ref &&
    REFUSAL_PROPERTIES.has(accessed.name.text)
  ) {
    return null;
  }
  let child: ts.Node = ref;
  for (let node: ts.Node = ref.parent; node !== body; child = node, node = node.parent) {
    const step = classifyStep(node, child, tainted);
    if (step === "sink") return node;
    if (step === "stop") return null;
  }
  return null;
}

/** What one step up the tree means for a tainted value arriving from `child`. */
function classifyStep(node: ts.Node, child: ts.Node, tainted: Taint): "sink" | "stop" | "continue" {
  // A statement boundary ends the expression; a function boundary means the
  // value is a callback's RESULT (e.g. a failure row built inside `.map`),
  // which is data handed back, not authority handed in.
  if (
    ts.isBlock(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isSourceFile(node) ||
    isFunctionLike(node)
  ) {
    return "stop";
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    if ((node.arguments ?? []).some((a) => a === child)) {
      return isIncidentalCall(node) ? "continue" : "sink";
    }
    const membership =
      ts.isCallExpression(node) &&
      child === node.expression &&
      ts.isPropertyAccessExpression(node.expression) &&
      MEMBERSHIP_METHODS.has(node.expression.name.text) &&
      node.arguments.some((a) => mentionsOutsideValue(a, node, tainted));
    return membership ? "sink" : "continue";
  }
  if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
    // An identity re-check compares two identities. Comparing against a
    // constant (`role === "admin"`, `role === ROLES.admin`, `=== ADMIN_ROLE`)
    // is a state check.
    const other = node.left === child ? node.right : node.left;
    if (isConstantLike(other)) return "stop";
    // `if (user.id === targetUserId) throw …` refuses on a MATCH: it stops the
    // caller acting on THEMSELVES and binds the target to nothing. Only a
    // comparison that refuses on a mismatch, or gates the work on a match,
    // ties the resource to the caller.
    return refusesOnMatch(node) ? "stop" : "sink";
  }
  if (ts.isTaggedTemplateExpression(node) && /(^|\.)sql$/.test(node.tag.getText())) return "sink";
  return "continue";
}

const MATCH_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
]);
const REFUSAL_CALLS = /^(?:notFound|redirect|permanentRedirect|forbidden|unauthorized|fail)$/;

/** `if (a === b) <refusal>`: the equality is the whole condition and its branch only refuses. */
function refusesOnMatch(cmp: ts.BinaryExpression): boolean {
  if (!MATCH_OPERATORS.has(cmp.operatorToken.kind)) return false;
  let cond: ts.Node = cmp;
  while (ts.isParenthesizedExpression(cond.parent)) cond = cond.parent;
  const stmt = cond.parent;
  return ts.isIfStatement(stmt) && stmt.expression === cond && isRefusal(stmt.thenStatement);
}

/** A branch that only says no: throw, a bare/data-only return, or notFound()/redirect()/fail(). */
function isRefusal(s: ts.Statement): boolean {
  if (ts.isBlock(s)) return s.statements.length > 0 && s.statements.every(isRefusal);
  if (ts.isThrowStatement(s)) return true;
  if (ts.isReturnStatement(s)) {
    const e = s.expression;
    return (
      e === undefined ||
      ts.isObjectLiteralExpression(e) ||
      ts.isArrayLiteralExpression(e) ||
      isLiteral(e) ||
      (ts.isCallExpression(e) && REFUSAL_CALLS.test(calleeName(e) ?? ""))
    );
  }
  if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)) {
    return REFUSAL_CALLS.test(calleeName(s.expression) ?? "");
  }
  return false;
}

function isLiteral(e: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(e) ||
    ts.isNumericLiteral(e) ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(e) && e.text === "undefined")
  );
}

const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

/** A literal, an UPPER_CASE constant, or a member of a PascalCase/UPPER_CASE namespace (an enum). */
function isConstantLike(e: ts.Expression): boolean {
  if (isLiteral(e)) return true;
  if (ts.isIdentifier(e)) return CONSTANT_NAME.test(e.text);
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const root = rootIdentifier(e);
    return root !== null && /^[A-Z]/.test(root);
  }
  return false;
}

/**
 * True when `arg` reads a value declared OUTSIDE `call` that is neither tainted
 * nor a constant: `session.jurisdictions.some((j) => j.province === pet.province)`
 * compares the session against the resource; `user.roles.some((r) => r === "admin")`
 * only inspects the session itself.
 */
function mentionsOutsideValue(arg: ts.Node, call: ts.Node, tainted: Taint): boolean {
  let hit = false;
  const check = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isIdentifier(n) && isValueReference(n) && !CONSTANT_NAME.test(n.text)) {
      const decl = resolveDeclaration(n);
      const inside = decl !== null && decl.pos >= call.pos && decl.end <= call.end;
      if (decl !== null && !inside && !tainted.has(decl)) {
        hit = true;
        return;
      }
    }
    ts.forEachChild(n, check);
  };
  check(arg);
  return hit;
}

function scopedBy(body: ts.Block, sf: ts.SourceFile): string | null {
  const tainted = taintedLocals(body);
  const pinned = guardPinnedToRow(body, sf, tainted);
  if (pinned !== null) return pinned;
  if (tainted.size === 0) return null;
  const hit = firstSink(body, tainted);
  return hit === null ? null : `${hit.ref.text} → ${describeSink(hit.sink, sf)}`;
}

function hasNoAuthMarker(fn: ts.Statement, sf: ts.SourceFile): boolean {
  const ranges = ts.getLeadingCommentRanges(sf.text, fn.getFullStart()) ?? [];
  return ranges.some((r) => sf.text.slice(r.pos, r.end).includes(NO_AUTH_COMMENT));
}

/**
 * One verdict per exported server action in the file, whatever export shape
 * names it (see {@link exportedActions}). A re-export whose body cannot be
 * found comes back with `unresolved` set: the fence cannot say whether it is a
 * subject, and the runner fails closed on it.
 */
export function analyzeActions(
  relPath: string,
  src: string,
  resolve: ModuleResolver = resolveFromDisk,
): ActionVerdict[] {
  const sf = parse(relPath, src);
  const tenantGuards: ReadonlySet<string> = new Set<string>(TENANT_GUARDS);
  const out: ActionVerdict[] = [];
  for (const found of exportedActions(sf, relPath, resolve)) {
    const line = sf.getLineAndCharacterOfPosition(found.at.getStart(sf)).line + 1;
    if (found.kind === "unresolved") {
      out.push({ name: found.name, line, subject: false, scopedBy: null, unresolved: found.why });
      continue;
    }
    const { name, decl, body } = found;
    const subject =
      !isInnerWriter(name) &&
      !hasNoAuthMarker(decl, decl.getSourceFile()) &&
      callsAny(body, tenantGuards);
    out.push({
      name,
      line,
      subject,
      scopedBy: subject ? scopedBy(body, body.getSourceFile()) : null,
    });
  }
  return out;
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

// ---------------------------------------------------------------------------
// Export shapes (A13, 2026-10-07)
// ---------------------------------------------------------------------------
//
// A client reaches a server action by its EXPORTED name, and TypeScript has
// more ways to export a name than the `export` modifier. Until A13 this file
// read only `export async function f` and `export const f = async () => {}`,
// so each of these took an action out of the fence silently — not an
// offender, not a subject, just absent:
//
//   export { a };  export { a as b };      a local `async function a` above
//   export const b = a;                    an alias of a local or an import
//   import { a } from "…"; export { a };   body in another module
//   export { a } from "…";  export * from "…";
//
// Each is now followed to the declaration that carries the body, through as
// many modules as it takes (MAX_EXPORT_HOPS), and analysed THERE — the module
// may be outside the action globs entirely (a plain lib/ file with no "use
// server"), which is exactly how a body escaped the scan. The verdict is keyed
// by the exported name in the scanned file, because that is the name a client
// calls. A name that cannot be followed (a package import, a missing file, a
// name the target does not declare, a chain too deep) is `unresolved`, and
// the runner FAILS on it rather than guessing: an action the fence cannot read
// is not an action the fence has cleared.

/** Resolve an import specifier from a repo-relative file to a repo-relative source. */
export type ModuleResolver = (
  fromRelPath: string,
  specifier: string,
) => { relPath: string; src: string } | null;

const MAX_EXPORT_HOPS = 8;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/** `@/x` (tsconfig `"@/*": ["./*"]`) and relative specifiers; packages are not followed. */
export function resolveFromDisk(
  fromRelPath: string,
  specifier: string,
): { relPath: string; src: string } | null {
  let base: string;
  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith(".")) base = posix.join(posix.dirname(fromRelPath), specifier);
  else return null;
  for (const candidate of [base, ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`)]) {
    if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) {
      return { relPath: candidate, src: readFileSync(candidate, "utf8") };
    }
  }
  return null;
}

type ExportedAction =
  /** `at` is the node in the SCANNED file the export is written at (for the line). */
  | { kind: "action"; name: string; at: ts.Node; decl: ts.Statement; body: ts.Block }
  | { kind: "unresolved"; name: string; at: ts.Node; why: string };

/** What a name declared in a module turns out to be. */
type Binding =
  | { kind: "action"; decl: ts.Statement; body: ts.Block }
  /** Declared, but not an async function (a constant, a sync helper, a class). */
  | { kind: "other" }
  | { kind: "unresolved"; why: string };

type Ctx = { resolve: ModuleResolver; hops: number };

/** Every exported server action of `sf`, under the name a client calls it by. */
function exportedActions(sf: ts.SourceFile, relPath: string, resolve: ModuleResolver) {
  return collectExports(sf, relPath, { resolve, hops: 0 }).actions;
}

type ModuleExports = { actions: ExportedAction[]; others: Set<string> };

function addExport(out: ModuleExports, name: string, at: ts.Node, b: Binding): void {
  if (b.kind === "action")
    out.actions.push({ kind: "action", name, at, decl: b.decl, body: b.body });
  else if (b.kind === "unresolved") out.actions.push({ kind: "unresolved", name, at, why: b.why });
  else out.others.add(name);
}

/**
 * The module's exports: async-function ones as actions (or unresolved), and
 * the NAMES of every other export, so a lookup can tell "exported, but not an
 * action" from "not exported at all".
 */
function collectExports(sf: ts.SourceFile, relPath: string, ctx: Ctx): ModuleExports {
  const out: ModuleExports = { actions: [], others: new Set<string>() };
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) collectExportDeclaration(out, sf, relPath, stmt, ctx);
    else if (ts.isExportAssignment(stmt)) {
      // `export default a` — followed like `export { a as default }`.
      const b: Binding = ts.isIdentifier(stmt.expression)
        ? resolveLocal(sf, relPath, stmt.expression.text, ctx)
        : { kind: "other" };
      addExport(out, "default", stmt, b);
    } else if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
      collectExportedDeclaration(out, sf, relPath, stmt, ctx);
    }
  }
  return out;
}

/** `export { a, b as c }`, `export { a } from "…"`, `export * from "…"`. */
function collectExportDeclaration(
  out: ModuleExports,
  sf: ts.SourceFile,
  relPath: string,
  stmt: ts.ExportDeclaration,
  ctx: Ctx,
): void {
  if (stmt.isTypeOnly) return;
  const spec = stmt.moduleSpecifier;
  const from = spec !== undefined && ts.isStringLiteral(spec) ? spec.text : null;
  const clause = stmt.exportClause;
  if (clause === undefined) {
    // `export * from "…"`: every export of the target, under its own name.
    if (from !== null) collectStarExport(out, relPath, from, stmt, ctx);
    return;
  }
  if (ts.isNamespaceExport(clause)) {
    // `export * as ns from "…"` exports an object, not a function.
    out.others.add(clause.name.text);
    return;
  }
  for (const el of clause.elements) {
    if (el.isTypeOnly) continue;
    const local = (el.propertyName ?? el.name).text;
    const b =
      from === null
        ? resolveLocal(sf, relPath, local, ctx)
        : resolveExport(relPath, from, local, ctx);
    addExport(out, el.name.text, stmt, b);
  }
}

function collectStarExport(
  out: ModuleExports,
  relPath: string,
  from: string,
  stmt: ts.ExportDeclaration,
  ctx: Ctx,
): void {
  const target = followModule(relPath, from, ctx);
  if ("why" in target) {
    out.actions.push({ kind: "unresolved", name: `* from "${from}"`, at: stmt, why: target.why });
    return;
  }
  for (const a of target.exports.actions) out.actions.push({ ...a, at: stmt });
  for (const o of target.exports.others) out.others.add(o);
}

/** A statement carrying the `export` modifier. */
function collectExportedDeclaration(
  out: ModuleExports,
  sf: ts.SourceFile,
  relPath: string,
  stmt: ts.Statement,
  ctx: Ctx,
): void {
  if (ts.isFunctionDeclaration(stmt)) {
    // A named `export default async function f` keeps the key `f` it always had.
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
    const name = stmt.name?.text ?? (isDefault ? "default" : null);
    if (name !== null) addExport(out, name, stmt, functionBinding(stmt));
    return;
  }
  if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) {
        addExport(out, d.name.text, stmt, variableBinding(sf, relPath, stmt, d, ctx));
      }
    }
    return;
  }
  if (
    (ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt)) &&
    stmt.name !== undefined &&
    ts.isIdentifier(stmt.name)
  ) {
    out.others.add(stmt.name.text);
  }
}

function functionBinding(fn: ts.FunctionDeclaration): Binding {
  return fn.body !== undefined && hasModifier(fn, ts.SyntaxKind.AsyncKeyword)
    ? { kind: "action", decl: fn, body: fn.body }
    : { kind: "other" };
}

/** `const f = async () => {}` is an action; `const f = g` is whatever `g` is. */
function variableBinding(
  sf: ts.SourceFile,
  relPath: string,
  stmt: ts.VariableStatement,
  d: ts.VariableDeclaration,
  ctx: Ctx,
): Binding {
  const init = d.initializer === undefined ? undefined : unwrapCasts(d.initializer);
  const body = asyncFunctionBody(init);
  if (body !== null) return { kind: "action", decl: stmt, body };
  if (init === undefined) return { kind: "other" };
  if (ts.isIdentifier(init)) return resolveLocal(sf, relPath, init.text, ctx);
  // `export const g = withAuth(f)`: the client calls the WRAPPER, whose body
  // this file cannot see. If any argument is itself an action, say so instead
  // of reading the export as "not an action" — fail closed.
  if (ts.isCallExpression(init)) {
    for (const arg of init.arguments) {
      const a = unwrapCasts(arg);
      const inner = ts.isIdentifier(a)
        ? resolveLocal(sf, relPath, a.text, ctx)
        : asyncFunctionBody(a) !== null
          ? ({ kind: "action" } as const)
          : null;
      if (inner?.kind === "action") {
        return {
          kind: "unresolved",
          why: `\`${d.name.getText(sf)}\` wraps an action in ${init.expression.getText(sf)}(), whose body is not followed`,
        };
      }
    }
  }
  return { kind: "other" };
}

/** `f as T`, `f!`, `(f)`, `f satisfies T` → `f`. */
function unwrapCasts(e: ts.Expression): ts.Expression {
  let x = e;
  while (
    ts.isAsExpression(x) ||
    ts.isNonNullExpression(x) ||
    ts.isParenthesizedExpression(x) ||
    ts.isSatisfiesExpression(x) ||
    ts.isTypeAssertionExpression(x)
  ) {
    x = x.expression;
  }
  return x;
}

/** What the module-level name `local` of `sf` is bound to, following imports. */
function resolveLocal(sf: ts.SourceFile, relPath: string, local: string, ctx: Ctx): Binding {
  if (ctx.hops >= MAX_EXPORT_HOPS) {
    return {
      kind: "unresolved",
      why: `alias chain deeper than ${MAX_EXPORT_HOPS} at \`${local}\``,
    };
  }
  for (const stmt of sf.statements) {
    const b = bindingDeclaredBy(stmt, sf, relPath, local, ctx);
    if (b !== null) return b;
  }
  return { kind: "unresolved", why: `\`${local}\` is not declared in ${relPath}` };
}

/** What `stmt` binds `local` to, or null when it does not declare that name. */
function bindingDeclaredBy(
  stmt: ts.Statement,
  sf: ts.SourceFile,
  relPath: string,
  local: string,
  ctx: Ctx,
): Binding | null {
  if (ts.isFunctionDeclaration(stmt)) {
    // An overload signature has no body; the implementation follows it.
    return stmt.name?.text === local && stmt.body !== undefined ? functionBinding(stmt) : null;
  }
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations.find(
      (x) => ts.isIdentifier(x.name) && x.name.text === local,
    );
    return d === undefined
      ? null
      : variableBinding(sf, relPath, stmt, d, { ...ctx, hops: ctx.hops + 1 });
  }
  if (ts.isImportDeclaration(stmt)) return importedBinding(stmt, relPath, local, ctx);
  if (
    (ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt)) &&
    stmt.name?.text === local
  ) {
    return { kind: "other" };
  }
  return null;
}

/** `import a from`, `import { x as a } from`, `import * as a from` — or null. */
function importedBinding(
  stmt: ts.ImportDeclaration,
  relPath: string,
  local: string,
  ctx: Ctx,
): Binding | null {
  const clause = stmt.importClause;
  if (clause === undefined || clause.isTypeOnly || !ts.isStringLiteral(stmt.moduleSpecifier)) {
    return null;
  }
  const from = stmt.moduleSpecifier.text;
  if (clause.name?.text === local) return resolveExport(relPath, from, "default", ctx);
  const named = clause.namedBindings;
  if (named === undefined) return null;
  if (ts.isNamespaceImport(named)) return named.name.text === local ? { kind: "other" } : null;
  const el = named.elements.find((e) => e.name.text === local && !e.isTypeOnly);
  return el === undefined
    ? null
    : resolveExport(relPath, from, (el.propertyName ?? el.name).text, ctx);
}

/** What module `from` (imported by `relPath`) exports as `name`. */
function resolveExport(relPath: string, from: string, name: string, ctx: Ctx): Binding {
  const target = followModule(relPath, from, ctx);
  if ("why" in target) return { kind: "unresolved", why: target.why };
  const hit = target.exports.actions.find((a) => a.name === name);
  if (hit !== undefined) {
    return hit.kind === "action"
      ? { kind: "action", decl: hit.decl, body: hit.body }
      : { kind: "unresolved", why: hit.why };
  }
  if (target.exports.others.has(name)) return { kind: "other" };
  return { kind: "unresolved", why: `${target.relPath} does not export \`${name}\`` };
}

function followModule(
  relPath: string,
  from: string,
  ctx: Ctx,
): { relPath: string; exports: ModuleExports } | { why: string } {
  if (ctx.hops >= MAX_EXPORT_HOPS) {
    return { why: `re-export chain deeper than ${MAX_EXPORT_HOPS} modules at "${from}"` };
  }
  const target = ctx.resolve(relPath, from);
  if (target === null) {
    return {
      why: `cannot resolve "${from}" from ${relPath} (only @/ and relative paths are followed)`,
    };
  }
  const sf = parse(target.relPath, target.src);
  return {
    relPath: target.relPath,
    exports: collectExports(sf, target.relPath, { ...ctx, hops: ctx.hops + 1 }),
  };
}

/** The block body of an async arrow / function expression, else null. */
function asyncFunctionBody(init: ts.Expression | undefined): ts.Block | null {
  if (init === undefined) return null;
  if (!(ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return null;
  if (!hasModifier(init, ts.SyntaxKind.AsyncKeyword)) return null;
  return ts.isBlock(init.body) ? init.body : null;
}

/** Offender identities (`path#name`) in one file. */
export function findScopingOffenders(
  relPath: string,
  src: string,
  resolve: ModuleResolver = resolveFromDisk,
): string[] {
  return analyzeActions(relPath, src, resolve)
    .filter((v) => v.subject && v.scopedBy === null)
    .map((v) => `${relPath}#${v.name}`);
}

export type SurfaceScan = {
  /** Offender identity → `path:line` for messages. */
  offenders: Map<string, string>;
  /** Exports whose body the fence could not follow: identity → `path:line — why`. Fails the run. */
  unresolved: Map<string, string>;
  subjects: number;
  scoped: number;
};

export function scanSurface(
  files: ReadonlyArray<{ relPath: string; src: string }>,
  resolve: ModuleResolver = resolveFromDisk,
): SurfaceScan {
  const offenders = new Map<string, string>();
  const unresolved = new Map<string, string>();
  let subjects = 0;
  let scoped = 0;
  for (const { relPath, src } of files) {
    for (const v of analyzeActions(relPath, src, resolve)) {
      if (v.unresolved !== undefined) {
        unresolved.set(`${relPath}#${v.name}`, `${relPath}:${v.line} — ${v.unresolved}`);
        continue;
      }
      if (!v.subject) continue;
      subjects++;
      if (v.scopedBy !== null) scoped++;
      else offenders.set(`${relPath}#${v.name}`, `${relPath}:${v.line}`);
    }
  }
  return { offenders, unresolved, subjects, scoped };
}

/** Non-vacuity problems; empty when the scan demonstrably looked at something. */
export function vacuityViolations(
  scan: Pick<SurfaceScan, "subjects" | "scoped">,
  homes: Readonly<Record<string, readonly string[]>> = GUARD_HOMES,
): string[] {
  const out: string[] = [];
  if (scan.subjects < MIN_SUBJECTS) {
    out.push(
      `found ${scan.subjects} tenant-guarded action(s), floor is ${MIN_SUBJECTS} — the scan is not seeing the action surface (parser, glob or guard names changed)`,
    );
  }
  if (scan.scoped < MIN_SCOPED) {
    out.push(
      `recognised ${scan.scoped} scoped action(s), floor is ${MIN_SCOPED} — the scoping recogniser stopped recognising real scoping`,
    );
  }
  for (const g of TENANT_GUARDS) {
    if (homes[g] === undefined) {
      out.push(
        `TENANT_GUARDS: \`${g}\` has no entry in check-authz-guards.ts GUARD_HOMES — a dead name is a free pass for whoever defines it first`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Baseline — identity → reason
// ---------------------------------------------------------------------------

export type Baseline = Record<string, string>;

const BASELINE_PATH = "scripts/authz-scoping-baseline.json";
export const UNREVIEWED = "UNREVIEWED";

export type Ratchet = {
  /** Offenders with no baseline entry: new holes. */
  added: string[];
  /** Baseline entries that no longer offend: fixed or removed, must leave the JSON. */
  stale: string[];
  /** Baseline entries with an empty or UNREVIEWED reason. */
  unreasoned: string[];
};

export function ratchet(baseline: Baseline, offenders: Iterable<string>): Ratchet {
  const live = new Set(offenders);
  const added = [...live].filter((k) => baseline[k] === undefined).sort();
  const stale = Object.keys(baseline)
    .filter((k) => !live.has(k))
    .sort();
  const unreasoned = Object.entries(baseline)
    .filter(([, reason]) => reason.trim() === "" || reason.trim().startsWith(UNREVIEWED))
    .map(([k]) => k)
    .sort();
  return { added, stale, unreasoned };
}

/** Only `clean` passes. `growth` wins: a new hole is reported before bookkeeping. */
export function ratchetVerdict(r: Ratchet): "clean" | "growth" | "stale" | "unreasoned" {
  if (r.added.length > 0) return "growth";
  if (r.stale.length > 0) return "stale";
  if (r.unreasoned.length > 0) return "unreasoned";
  return "clean";
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function readBaseline(): Baseline {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch {
    console.error(
      `✗ check-authz-scoping: cannot read baseline at ${BASELINE_PATH}. Generate it with --write-baseline.`,
    );
    process.exit(1);
  }
}

function runScan(): void {
  const scan = scanSurface(
    listActionFiles().map((f) => ({
      relPath: f.replaceAll("\\", "/"),
      src: readFileSync(f, "utf8"),
    })),
  );

  // Fail closed BEFORE the ratchet: an export the fence cannot follow to its
  // body is neither cleared nor baselined — it was never read.
  if (scan.unresolved.size > 0) {
    for (const [k, where] of scan.unresolved) console.error(`  ${where} (${k.split("#")[1]})`);
    console.error(
      "\n✗ authz-scoping cannot follow these exports to the function that implements them." +
        " Declare the action in the scanned module, or re-export it from an @/ or relative path" +
        " that declares it — a body the fence cannot read is not a body it has cleared.",
    );
    process.exit(1);
  }

  const vacuous = vacuityViolations(scan);
  if (vacuous.length > 0) {
    for (const v of vacuous) console.error(`  ${v}`);
    console.error("\n✗ authz-scoping is VACUOUS — a fence that finds nothing reports nothing.");
    process.exit(1);
  }

  if (process.argv.includes("--write-baseline")) {
    const old = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    const next: Baseline = {};
    for (const k of [...scan.offenders.keys()].sort()) {
      next[k] = old[k] ?? `${UNREVIEWED}: write why this export is tolerated`;
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`✓ wrote ${BASELINE_PATH} — ${Object.keys(next).length} baselined offender(s).`);
    return;
  }

  const baseline = readBaseline();
  const r = ratchet(baseline, scan.offenders.keys());
  const verdict = ratchetVerdict(r);
  const summary = `${scan.subjects} tenant-guarded action(s), ${scan.scoped} scoped, ${scan.offenders.size} baselined offender(s)`;

  if (verdict === "clean") {
    console.log(
      `✓ authz-scoping clean — ${summary}; every offender is a named, reasoned baseline entry (adding a key to the baseline JSON is accepting a new offender, so review its diff).`,
    );
    return;
  }

  if (verdict === "growth") {
    for (const k of r.added) {
      console.error(
        `  ${scan.offenders.get(k)} ${k.split("#")[1]} — tenant-guarded, but nothing bound from the guard or the session reaches the work`,
      );
    }
    console.error(
      "\n✗ NEW guard-called-but-not-scoped action(s). Bind the actor/tenant from the guard's result" +
        " (const { user } = await requireAdminOrRedirect(); writer(user.id, …)), pin the resource to" +
        " it in a predicate, or re-check it inline. A guard whose result is thrown away proves" +
        " admission, not scope.",
    );
    process.exit(1);
  }

  if (verdict === "stale") {
    for (const k of r.stale) console.error(`  ${k} — no longer an offender (fixed or removed)`);
    console.error(
      "\n✗ authz-scoping baseline has STALE entries. Remove them in this same commit (pnpm tsx scripts/check-authz-scoping.ts --write-baseline) — a leftover entry is a free pass for the next regression under that name.",
    );
    process.exit(1);
  }

  for (const k of r.unreasoned) console.error(`  ${k} — "${baseline[k]}"`);
  console.error(
    "\n✗ authz-scoping baseline entries without a reason. Write one line per entry saying why it is tolerated (prefix TODO: when it needs a follow-up).",
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
