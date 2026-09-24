// Authorization-coverage linter — CI guardrail (WS-AUTHZ 1.2).
//
// Enforces the "no server action without a guard" convention across the whole
// server-action surface. Every exported `async function` in a server-action
// file must be one of:
//   1. an inner writer (name ends in a `For…` / `Writer` / `From…` suffix) —
//      the public wrapper that calls it is what's required to be guarded;
//   2. a function whose body calls a known auth guard (AUTH_GUARDS); or
//   3. explicitly opted out with a `// @no-auth-required: <reason>` comment in
//      the contiguous comment block above the export — so the exception is
//      visible and justified, never silent.
//
// Scope — discovered by CONTENT, not by filename (see listActionFiles below):
// every module under app/, src/ or lib/ whose FIRST statement is the "use server"
// directive. The old filename globs (app/actions/*.ts + src/modules/**/actions.ts)
// are kept as a union floor so discovery can only ever widen.
//
// THE SAME COVERAGE RULE ALSO RUNS OVER ROUTE HANDLERS (D4, 2026-08-21).
// A Server Action and a `route.ts` are the same thing from the outside: a
// client-addressable server entry point that answers with data. Until D4 this
// file looked at exactly one of the two, so the ENTIRE `app/**/route.ts`
// surface — 47 handlers, 25 of them crons — inherited no coverage rule at all
// (docs/architecture/api-invariants.md §7 called it the biggest structural gap
// on that table). Widened BEFORE the first `/api/v1` route lands, because
// widening a fence over what already exists costs one audit and widening it
// later costs that audit plus everything added in between.
//
// Discovery for handlers is SEPARATE (listRouteHandlerFiles) rather than a
// wider listActionFiles(): four other fences import listActionFiles() and
// would have silently changed scope — check-audit-log-coverage.ts,
// check-authz-scoping.ts, check-confused-deputy.ts, check-titular-gate.ts.
// A fence must not move another fence's boundary as a side effect.
//
// Run: pnpm tsx scripts/check-authz-guards.ts   (or: pnpm lint:authz)
// Exits 1 listing each offender; exits 0 when the whole surface is covered.
//
// Regex-based, not a full AST analyzer — the cheapest reliable approximation,
// matching the sibling linters (check-ui-invariants.ts, check-design-tokens.ts).
// It can be fooled by a guard-like string literal, but the false-positive rate
// is zero on this codebase and a new unguarded `…Action` is reliably caught.

import { globSync, readFileSync } from "node:fs";

import { stripComments } from "./lib/strip-comments.mjs";

// Recognized auth-gate calls. A function whose body contains a call to any of
// these is considered guarded. Mixes named helpers (lib/auth-guards.ts,
// lib/pet-access.ts), org/capability guards, file-local admin guards, and the
// `requireLiveUser` family.
//
// BARE `auth.getUser` WAS THE LAST ENTRY UNTIL 2026-09-18 (A01-3), and it was
// removed on purpose. getUser() proves a JWT is valid and nothing else: it never
// reads profiles.deleted_at, the deactivation flag or the maintenance window. As
// a recognised guard it let a new "use server" export that wrote to ANY non-pet
// table pass Rule 1.2 on a session an erased account still holds. No live
// action relied on it (every caller also called a real guard), so removing it
// narrowed nothing today and closes the door for the next one. The legacy
// "getUser + if (!user)" shape now has to go through requireLiveUser /
// resolveOptionalLiveUser, or carry a written @no-auth-required reason.
export const AUTH_GUARDS = [
  "requireUserOrRedirect",
  // The ONE result-shaped liveness guard (T1.2, lib/infra/live-user.ts).
  // Resolves the session, refuses an erased account, refuses a deactivated
  // institutional account, and refuses ANY caller during a maintenance window —
  // the last of which no guard in this list did before, because the kill-switch
  // lived in four layouts and a layout does not run on a Server Action POST.
  "requireLiveUser",
  // Same guard for the three write boundaries where an ANONYMOUS caller is
  // legitimate (the anonymous denuncia + the two adoption-application actions).
  // NO_SESSION becomes `user: null`; erasure, deactivation and maintenance are
  // still refusals, which is what a bare getUser() gave those three for free.
  "resolveOptionalLiveUser",
  "requireCapability",
  // Confused-deputy-safe capability guard (Wave F3): resolves the org from the
  // URL orgToken, then delegates to requireCapability pinned to that org.id — so
  // a /org/{token} action authorizes against the URL org, not the session-default
  // membership. Distinct name so the `requireCapability` entry above does not
  // match it (the regex anchors `requireCapability\s*\(`, which the `ForOrgToken`
  // suffix breaks). Already blessed by __tests__/server-actions-auth-coverage.test.ts.
  "requireCapabilityForOrgToken",
  "requireOrgAccessByToken",
  "requireAdminOrRedirect",
  "requireAdminOrGovtOrRedirect",
  "requireDecomisoPrincipal",
  // Denuncia-moderation authority (Wave A/F). Reuses requireAdminOrGovtOrRedirect
  // verbatim — same role set + jurisdictions query — named separately so call
  // sites read as "requires denuncia moderation authority". Deletion-aware via
  // the reused institutional guard.
  "requireDenunciaModerationPrincipal",
  "requirePetAccess",
  "requireAlivePetAccess",
  // Titular-only gate (custodia-temporal). Composes with requirePetAccess and
  // denies exactly one thing: a person-path holder whose ownership role is
  // `caretaker`. It IS a guard for coverage purposes — it resolves the session,
  // the profile and the ownership row through requirePetAccess before deciding.
  "requireTitularAccess",
  "requireOwnedPetByToken",
  // File-local admin guard used by the alert-subscriptions / alert-firings
  // actions: wraps auth.getUser + a profiles.role === 'admin' re-check.
  "requireAdminUser",
  // Module-private org-intervention guard (welfare derived-report actions):
  // wraps requireUserOrRedirect + an org-membership + intervention-role check.
  "requireOrgInterventionAccess",
  // Walk-in (atender) authorization boundary — app/org/[orgToken]/atender/
  // atender-access.ts. Enters through `resolveLiveOrgActor`, so it resolves the
  // acting org FROM THE URL TOKEN and requires an active membership with
  // `event.write` on top of the full liveness set (maintenance, session,
  // erasure, deactivation, 8-hour shift); it also rate-limits the DIM-code
  // lookup. Became visible to this linter when discovery moved from filename
  // globs to the "use server" directive (2026-08-05); it was always a real
  // guard, just outside the old glob — and until 2026-08-25 it was a real guard
  // that reached NONE of the liveness checks (see atender-access.ts's header).
  "resolveAtenderPet",
  "resolveAtenderContext",
] as const;

// WS-AUTHZ 1.3 — operator-route ↔ guard rule.
//
// Institutional guards establish admin/govt *authority* (not just a logged-in
// session). A file under an operator route tree (app/admin, app/gob) that gates
// access must use one of these.
export const INSTITUTIONAL_GUARDS = [
  "requireAdminOrRedirect",
  "requireAdminOrGovtOrRedirect",
  // The /gob READ gate (admin | govt | national — the read-only national role,
  // migration 0214). Institutional authority for a PAGE, and DELIBERATELY NOT
  // in AUTH_GUARDS above: a "use server" export or a route handler that
  // adopted it would be flagged as unguarded by rule 1.2 / D4, which is the
  // fence that keeps the government slice's writers closed to `national`.
  "requireGobReadAccessOrRedirect",
  "requireDecomisoPrincipal",
  // The route-handler equivalents (added 2026-08-21 with the app/api widening).
  // They are not redirect-shaped because a handler answers with a status, not a
  // navigation — but they run the same three checks the page guard's
  // loadActiveInstitutionalProfile centralizes: role in {admin, govt}, account
  // type institutional, not deactivated; plus an erased-account refusal.
  //
  // Listing them is not cosmetic. Without it the API surface passed this rule
  // only by NOT using a personal-tier guard — the fence never confirmed it was
  // institutionally gated, it just had nothing to complain about. And the first
  // handler to add a personal guard alongside its real one would have been
  // false-flagged.
  "resolveInstitutionalGobActor",
  "resolveInstitutionalPanoramaActor",
] as const;

// System guards — a SHARED SECRET, not an identity (D4, 2026-08-21).
//
// `authorizeCronRequest` (lib/domain/cron-auth.ts) compares the request's
// `Authorization: Bearer <CRON_SECRET>` / legacy `x-cron-secret` header against
// the environment secret in constant time and fails closed in production.
// `checkCronSecret` (lib/infra/case-cron.ts) is its deprecated wrapper, kept
// while the 25 cron handlers migrate; both are listed so a half-migrated tree
// never reads as unguarded.
//
// THEY COUNT FOR ROUTE HANDLERS ONLY, and the separation is the point. A cron
// endpoint has no user: proving the caller is Vercel Cron IS the whole
// authorization decision, and there is no session to resolve. A SERVER ACTION
// is reached from a logged-in browser with the caller's cookies attached, so a
// secret check there answers "did a trusted scheduler call me" while leaving
// "who is acting" unasked — which is precisely the hole Rule 1.2 exists to
// close. Keeping this list out of AUTH_GUARDS is what makes a `"use server"`
// export that calls authorizeCronRequest() still fail the action rule.
export const SYSTEM_GUARDS = ["authorizeCronRequest", "checkCronSecret"] as const;

// Personal-tier guards authenticate a user (or scope to their own pet/org) but
// do NOT establish operator authority. They are correct for citizen/owner
// surfaces, but insufficient as the SOLE gate on an operator route — that is the
// AC1 "weaker guard than the route needs" class this rule catches.
export const PERSONAL_TIER_GUARDS = [
  "requireUserOrRedirect",
  "requirePetAccess",
  "requireAlivePetAccess",
  // Titular-only: still a PERSONAL guard. It narrows WHICH holder may act, not
  // whether the caller holds operator authority — an admin/gob route gated by
  // this alone is exactly as weak as one gated by requirePetAccess alone.
  "requireTitularAccess",
  "requireOwnedPetByToken",
] as const;

// WS-AUTHZ 1.4 — deletion-aware guard rule (Wave E2, Ley 25.326 art. 16).
//
// A valid Supabase JWT is necessary but NOT sufficient to MUTATE a pet. A self-
// erased account (profiles.deleted_at set by erase_subject_data) keeps a live
// token until it naturally expires; `supabase.auth.getUser()` returns that user
// and never consults deleted_at. So an action that authorizes a WRITE on a bare
// getUser() lets an erased account keep writing. (Rule 1.2 counted bare
// `auth.getUser` as a guard until 2026-09-18; it no longer does, so this rule is
// now the second of two nets, not the only one.)
//
// Only these guards resolve the acting user AND reject an erased profile — they
// all funnel through requireUserOrRedirect (which checks deleted_at, Wave D2) or
// requirePetAccess/requireAlivePetAccess (which check it at the mutation
// boundary, Wave E2). Bare `auth.getUser` is deliberately NOT here.
//
// `requireAdminUser` JOINED THE LIST ON 2026-08-25, and the sentence above used
// to exclude it by name ("auth.getUser + role re-check"). That description was
// accurate and is no longer: the guard now calls requireLiveUser and keeps only
// the two questions liveness does not answer (role, account type). Listing it is
// not cosmetic — a guard that IS deletion-aware and is not listed makes its
// callers read as unaware, which is a fence lying in the safe direction, and a
// fence that lies in either direction stops being read.
export const DELETION_AWARE_GUARDS = [
  // Both live-user entry points read profiles.deleted_at themselves and refuse
  // before returning a user, so anything gated by either is deletion-aware.
  "requireLiveUser",
  "resolveOptionalLiveUser",
  "requireUserOrRedirect",
  "requirePetAccess",
  // Deletion-aware for free: it calls requirePetAccess first and returns its
  // failure verbatim, so the erased-profile check runs before the role check.
  "requireTitularAccess",
  "requireAlivePetAccess",
  "requireOwnedPetByToken",
  "requireOrgAccessByToken",
  "requireAdminOrRedirect",
  "requireAdminOrGovtOrRedirect",
  "requireDecomisoPrincipal",
  "requireDenunciaModerationPrincipal",
  "requireOrgInterventionAccess",
  "requireCapability",
  "requireCapabilityForOrgToken",
  // File-local admin guard for the six alert-firing triage actions. Deletion-
  // aware since 2026-08-25, when its bare getUser() + hand-rolled profile query
  // was replaced by requireLiveUser (which also gave those six the maintenance
  // kill-switch and the 8-hour shift they had never had).
  "requireAdminUser",
  // Both atender resolvers funnel through resolveAtenderContext, which since
  // 2026-08-25 authorizes through resolveLiveOrgActor → requireLiveUser and so
  // refuses an erased account with the one canonical check rather than a
  // hand-copied deletedAt read of its own (atender-access.ts).
  "resolveAtenderPet",
  "resolveAtenderContext",
] as const;

// Write signal (inline), on ANY table. What it catches, exactly:
//   - a query-builder write: `.insert(`, `.update(`, `.delete(`, `.upsert(`
//     (Drizzle and supabase-js share these method names);
//   - a raw SQL write: a `sql` (or typed `sql<T>`) template whose text opens
//     with `insert into`, `update <table>` or `delete from` (case-insensitive,
//     an optional leading `-- comment` line tolerated), as passed to
//     `db.execute(sql`...`)`;
//   - a PostgREST RPC call: `.rpc(` — a SECURITY DEFINER function can write
//     anything, and the fence cannot see inside it, so it counts as a write.
// It does NOT see a write behind a helper call, a raw SQL string built outside
// a `sql` template, or a CTE (`with ... insert`). Widened on 2026-09-22 (the
// fresh-context security review): `.upsert(`, raw SQL and `.rpc(` all passed.
//
// The raw-SQL alternative was ITSELF re-widened the same day. The original
// `update\s` put the mandatory `\b` word-boundary check right after a SINGLE
// whitespace character, so it silently required exactly one space between
// `update` and the table name: `UPDATE\n    reminders` (a newline, then
// indentation) or `update  reminders` (a double space) both failed, because
// the character immediately after that one consumed whitespace char was
// ANOTHER whitespace char, not the word character `\b` needed to fire — a
// multi-line or over-indented raw UPDATE read as no write at all. Requiring
// `\s+\w` (whitespace, THEN the identifier's first letter) instead of a
// trailing `\b` fixes it for arbitrary whitespace shape, applied uniformly to
// all three keywords. `insert into` / `delete from` were not exposed to the
// SAME bug (their `\b` sat right after a word character, "into"/"from",
// which is always a boundary regardless of what follows), but they take the
// identical `\s+\w` shape now so the three read as one rule, not one fixed
// and two coincidentally fine. A typed tag (`sql<Row>\``) was invisible
// outright — the regex required a literal backtick right after `sql` — and
// is now optional via `(?:<[^>]*>)?`.
//
// Until 2026-09-18 (A01-3) the rule also required the body to name a pet table
// (`petEvents` or `pets`), so a bare-getUser write to appointments, ownerships,
// notifications or welfare_reports passed it. The erased-account hazard is not
// specific to pets (Ley 25.326 art. 16 covers every row the subject can still
// author), so the table filter was dropped. Shims that delegate the write to an
// application use-case are still covered by that use-case routing through a
// guard.
const DB_MUTATION_RE =
  /\.(insert|update|delete|upsert|rpc)\s*\(|\bsql(?:<[^>]*>)?`\s*(?:--[^\n]*\n\s*)*(insert\s+into\s+\w|update\s+\w|delete\s+from\s+\w)/i;
const BARE_GET_USER_RE = /\.auth\.getUser\s*\(/;

// Documented safe exports: `"<relPath>#<name>"` → reason. Use ONLY when the
// action resolves identity through a bare getUser() and writes a table but
// the erased-account write is provably impossible (e.g. a deletion-aware check
// happens in a delegated use-case). Empty is the goal.
export const DELETION_AWARE_ALLOWLIST: Record<string, string> = {};

function callsAnyGuard(body: string, guards: readonly string[]): boolean {
  return guards.some((g) => new RegExp(`\\b${g.replace(/\./g, "\\.")}\\s*\\(`).test(body));
}

// Returns one offender line per exported action that authorizes an inline write
// (any table) on a bare auth.getUser() with no deletion-aware guard. Empty = clean.
export function findDeletionUnawareMutations(relPath: string, src: string): string[] {
  const offenders: string[] = [];
  for (const fn of extractExportedAsyncFunctions(src)) {
    // stripComments (2026-08-09): the body was tested RAW, so naming a
    // deletion-aware guard in a comment satisfied the rule. Same shape as the
    // check-db-budget substring hole. The module-level check already stripped;
    // the per-function checks did not.
    const body = stripComments(fn.body);
    if (isInnerWriter(fn.name)) continue;
    if (!BARE_GET_USER_RE.test(body)) continue;
    if (callsAnyGuard(body, DELETION_AWARE_GUARDS)) continue;
    if (!DB_MUTATION_RE.test(body)) continue;
    if (DELETION_AWARE_ALLOWLIST[`${relPath}#${fn.name}`] !== undefined) continue;
    offenders.push(
      `${relPath}:${fn.startLine} export async function ${fn.name} — authorizes a write on a bare auth.getUser() with no deletion-aware guard (one of ${DELETION_AWARE_GUARDS.join("/")}). An erased account (profiles.deleted_at) keeps a valid JWT and could still write. Route the write through requirePetAccess/requireAlivePetAccess, or add the deleted_at check (see lib/infra/pet-access.ts).`,
    );
  }
  return offenders;
}

// Names of exported async functions that are inner writers / scoped helpers,
// taking caller identity as a parameter. They are called from public wrappers
// that themselves call a guard, so they are not required to be guarded.
export const INNER_WRITER_SUFFIXES = [
  "ForUser",
  "ForAuthority",
  "ForOrg",
  "ForOrganization",
  "ForAudit",
  "ForVet",
  "ForVetProvider",
  "ForVetServiceProvider",
  "ForAdmin",
  "ForGovt",
  "ForCaller",
  "Writer",
  "ForToken",
  "FromCron",
  "FromEvent",
  "FromTrigger",
] as const;

export const NO_AUTH_COMMENT = "@no-auth-required";

export type ExportedFn = {
  name: string;
  startLine: number; // 1-indexed
  endLine: number;
  body: string;
  hasNoAuthComment: boolean;
  /**
   * Whatever follows `@no-auth-required` on the marker line, minus a leading
   * `:` and a trailing block-comment terminator. `""` when the marker is bare,
   * `null` when there is no marker at all.
   *
   * The action rule (findOffenders) reads only `hasNoAuthComment` and is
   * unchanged by this field. The ROUTE-handler rule requires the reason to be
   * non-empty: an opt-out nobody had to justify is a baseline with better
   * manners.
   */
  noAuthReason: string | null;
};

/** Text after the marker on its own comment line, normalized. */
function noAuthReasonFrom(line: string): string {
  const after = line.slice(line.indexOf(NO_AUTH_COMMENT) + NO_AUTH_COMMENT.length);
  return after
    .replace(/^\s*:/, "")
    .replace(/\*\/\s*$/, "")
    .trim();
}

// Walk the file, find every `export async function NAME(` declaration, then
// brace-match to the closing `}` to capture the body. One entry per export.
//
// Braces are counted ONLY inside the body. Counting them from the export line
// was a real recall bug: an inline object type in the PARAMETER LIST
// (`input: { fileHash: string; rows: { index: number }[] }`) drove the depth
// back to zero on the signature's own `}`, so the captured "body" was just the
// signature and the guard call in the real body was never seen — the action
// read as UNGUARDED (bit importIntakeRowsAction, 2026-08-06). Object types in
// the RETURN annotation have the same shape (`Promise<{ ok: boolean }>`), which
// is why the walk waits for a brace at angle-depth zero instead of taking the
// first `{` after the parameter list's closing paren.
//
// Phases: `signature` (up to the parameter list, including an optional `<T…>`
// type-parameter list) → `params` (paren-matched) → `returnType` (angle-aware)
// → `body` (brace-matched). Still line-based and dependency-free, like the rest
// of this script.
export function extractExportedAsyncFunctions(src: string): ExportedFn[] {
  const out: ExportedFn[] = [];
  const lines = src.split("\n");
  const exportRe = /^export\s+async\s+function\s+(\w+)\s*[(<]/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(exportRe);
    if (!m) continue;
    const name = m[1];

    let phase: "signature" | "generics" | "params" | "returnType" | "body" = "signature";
    let angleDepth = 0;
    let parenDepth = 0;
    let braceDepth = 0;
    let endLine = i;
    let body = "";
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (phase === "signature") {
          if (ch === "<") {
            angleDepth = 1;
            phase = "generics";
          } else if (ch === "(") {
            parenDepth = 1;
            phase = "params";
          }
        } else if (phase === "generics") {
          if (ch === "<") angleDepth++;
          else if (ch === ">") {
            angleDepth--;
            if (angleDepth === 0) phase = "signature";
          }
        } else if (phase === "params") {
          if (ch === "(") parenDepth++;
          else if (ch === ")") {
            parenDepth--;
            if (parenDepth === 0) phase = "returnType";
          }
        } else if (phase === "returnType") {
          // `async` forces a Promise-shaped return type, so any brace here is
          // inside `<…>`: track the angle depth and skip those.
          if (ch === "<") angleDepth++;
          else if (ch === ">") {
            if (angleDepth > 0) angleDepth--;
          } else if (ch === "{" && angleDepth === 0) {
            braceDepth = 1;
            phase = "body";
          }
        } else if (ch === "{") {
          braceDepth++;
        } else if (ch === "}") {
          braceDepth--;
        }
      }
      body += `${lines[j]}\n`;
      if (phase === "body" && braceDepth === 0) {
        endLine = j;
        break;
      }
    }

    // Walk backwards through the contiguous comment block above the export.
    // The @no-auth-required marker may sit anywhere in that block.
    let hasNoAuthComment = false;
    let noAuthReason: string | null = null;
    for (let back = i - 1; back >= 0; back--) {
      const line = lines[back].trim();
      const isCommentLine =
        line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line === "";
      if (!isCommentLine) break;
      if (line.includes(NO_AUTH_COMMENT)) {
        hasNoAuthComment = true;
        noAuthReason = noAuthReasonFrom(line);
        break;
      }
    }

    out.push({
      name,
      startLine: i + 1,
      endLine: endLine + 1,
      body,
      hasNoAuthComment,
      noAuthReason,
    });
  }

  return out;
}

export function isInnerWriter(name: string): boolean {
  return INNER_WRITER_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function callsAuthGuard(body: string): boolean {
  return AUTH_GUARDS.some((g) => {
    // Escape `.` so `auth.getUser` matches only a literal dot.
    const escaped = g.replace(/\./g, "\\.");
    return new RegExp(`\\b${escaped}\\s*\\(`).test(body);
  });
}

// Returns one human-readable offender line per unguarded exported action in
// `src`. `relPath` is used only for the message. Empty array = file is covered.
export function findOffenders(relPath: string, src: string): string[] {
  const offenders: string[] = [];
  for (const fn of extractExportedAsyncFunctions(src)) {
    if (isInnerWriter(fn.name)) continue;
    if (fn.hasNoAuthComment) continue;
    // Raw body → a guard named only inside a comment counted as a guard CALL.
    // See findDeletionUnawareMutations for the same 2026-08-09 correction.
    if (callsAuthGuard(stripComments(fn.body))) continue;
    offenders.push(
      `${relPath}:${fn.startLine} export async function ${fn.name} — no auth guard call (name doesn't end in ${INNER_WRITER_SUFFIXES.join("/")} either). Add a guard call, rename to an inner-writer suffix, or add a \`// ${NO_AUTH_COMMENT}: <reason>\` comment immediately above the export.`,
    );
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// Guard shadowing — a recognised NAME has exactly one home (2026-08-22)
// ---------------------------------------------------------------------------
//
// THE HOLE. app/actions/notifications.ts defined its own
// `async function requireUser()` — a bare `auth.getUser()` with no erasure,
// deactivation or maintenance check — and fed it to three writes. `requireUser`
// is on AUTH_GUARDS, so callsAuthGuard() matched the local and every export in
// the file read as guarded by a guard that guarded nothing. Rule 1.2 reads a
// function BODY for a guard's NAME; it cannot tell the real guard from a local
// that borrowed the name, and it never could. This rule closes that from the
// other side: every recognised name is DEFINED in its canonical home and
// nowhere else, tree-wide.
//
// WHY TREE-WIDE AND NOT THE ACTION LIST. A shadow that lives in a helper
// module and is imported into an action is the same hole one hop away, and
// the coverage rule does not follow imports. So the scan is app/, src/ and
// lib/, every non-test .ts/.tsx — the same roots the other fences read.
//
// WHAT COUNTS AS A DEFINITION (on comment-stripped source): a function
// declaration, a const/let/var binding, and an import/export ALIAS
// (`import { getUser as requireLiveUser }` puts the guard's name in every body
// that calls it while running something else). Names that merely START with a
// guard's name (`requireUserProfile`) do not match — the regexes anchor on the
// token that follows.
//
// DEAD NAMES — PRUNED (2026-08-22, same day). Four entries on AUTH_GUARDS —
// requireUser, requireActiveOrgOrRedirect, requireOwnedPet, requireOwnedAndAlive
// — were defined NOWHERE in the tree (proved per name with
// `rg "function <name>\s*[(<]|(const|let|var)\s+<name>\s*[=:]"` over app/,
// src/, lib/, scripts/, components/, db/: zero hits outside comments and test
// fixtures). A dead name is a free pass: whoever defines it first is "the
// guard", which is exactly what happened. They were first kept with an EMPTY
// home so any definition was an offender; pruning them is the STRONGER
// control, because a name that is not recognised makes its callers read as
// UNGUARDED by Rule 1.2 instead of guarded-by-nothing — the coverage rule,
// not the shadow rule, is the one that fires. So the list carries no homeless
// name, and guardHomeViolations() refuses one: a dead entry cannot re-enter.
// (check-authz-scoping.ts's TENANT_GUARDS carried requireActiveOrgOrRedirect
// too, pruned in the same commit.)
//
// STATED BLIND SPOTS: a parameter named like a guard (`fn(requireLiveUser: () =>
// …)`), a destructuring bind (`const { requireLiveUser } = …`), an object-literal
// method or class method with the name, and — as everywhere in this file — a
// definition inside a string literal, which stripComments keeps.

/**
 * Where each recognised guard name is DEFINED. Every entry is NON-EMPTY — a
 * name with no home is a dead name, and guardHomeViolations() refuses it.
 * Relative, forward-slash paths.
 */
export const GUARD_HOMES: Readonly<Record<string, readonly string[]>> = {
  requireUserOrRedirect: ["lib/infra/auth-guards.ts"],
  requireLiveUser: ["lib/infra/live-user.ts"],
  resolveOptionalLiveUser: ["lib/infra/live-user.ts"],
  requireCapability: ["src/modules/organizations/infrastructure/authz-resolver.ts"],
  requireCapabilityForOrgToken: ["src/modules/organizations/infrastructure/authz-resolver.ts"],
  requireOrgAccessByToken: ["lib/infra/auth-guards.ts"],
  requireAdminOrRedirect: ["lib/infra/auth-guards.ts"],
  requireAdminOrGovtOrRedirect: ["lib/infra/auth-guards.ts"],
  requireGobReadAccessOrRedirect: ["lib/infra/auth-guards.ts"],
  requireDecomisoPrincipal: ["lib/infra/auth-guards.ts"],
  requireDenunciaModerationPrincipal: ["lib/infra/auth-guards.ts"],
  requirePetAccess: ["lib/infra/pet-access.ts"],
  requireAlivePetAccess: ["lib/infra/pet-access.ts"],
  requireTitularAccess: ["lib/infra/pet-access.ts"],
  requireOwnedPetByToken: ["lib/infra/pets.ts"],
  requireAdminUser: ["app/actions/alert-firings.ts"],
  requireOrgInterventionAccess: ["src/modules/welfare/actions.ts"],
  resolveAtenderPet: ["app/org/[orgToken]/atender/atender-access.ts"],
  resolveAtenderContext: ["app/org/[orgToken]/atender/atender-access.ts"],
  resolveInstitutionalGobActor: ["app/api/gob/_guard.ts"],
  resolveInstitutionalPanoramaActor: ["app/api/panorama/_guard.ts"],
  authorizeCronRequest: ["lib/domain/cron-auth.ts"],
  checkCronSecret: ["lib/infra/case-cron.ts"],
};

const GUARD_SHADOW_SCAN_GLOBS = [
  "app/**/*.ts",
  "app/**/*.tsx",
  "src/**/*.ts",
  "src/**/*.tsx",
  "lib/**/*.ts",
  "lib/**/*.tsx",
];

/** Every non-test source file under app/, src/ and lib/ — the shadowing scope. */
export function listGuardShadowScanFiles(): string[] {
  const files = new Set<string>();
  for (const pattern of GUARD_SHADOW_SCAN_GLOBS) {
    for (const f of globSync(pattern)) {
      const relPath = f.replaceAll("\\", "/");
      if (isScannableSource(relPath)) files.add(relPath);
    }
  }
  return [...files].sort();
}

/** The three definition shapes, each anchored on the token AFTER the name. */
function guardDefinitionPatterns(name: string): RegExp[] {
  return [
    // function declaration (optionally exported / async / generic)
    new RegExp(`(?:^|[^\\w.$])(?:async\\s+)?function\\s+${name}\\s*[(<]`),
    // binding
    new RegExp(`(?:^|[^\\w.$])(?:const|let|var)\\s+${name}\\s*[=:]`),
    // import / export alias
    new RegExp(`\\bas\\s+${name}\\s*[,}]`),
  ];
}

/**
 * One offender line per definition of a recognised guard name outside that
 * name's canonical home. `relPath` must be forward-slash relative.
 */
export function findShadowedGuardDefinitions(relPath: string, src: string): string[] {
  const offenders: string[] = [];
  const lines = stripComments(src).split("\n");
  for (const [name, homes] of Object.entries(GUARD_HOMES)) {
    if (homes.includes(relPath)) continue;
    const patterns = guardDefinitionPatterns(name);
    for (let i = 0; i < lines.length; i++) {
      if (!patterns.some((re) => re.test(lines[i]))) continue;
      const home =
        homes.length > 0
          ? `Call the real one from ${homes.join(" / ")}.`
          : "This name has NO canonical home — it is a dead entry on the recognised list and nothing may define it.";
      offenders.push(
        `${relPath}:${i + 1} defines \`${name}\`, a name on the recognised-guard list (AUTH_GUARDS / ROUTE_HANDLER_GUARDS). A local with a guard's name makes every caller read as guarded by a guard that guards nothing (app/actions/notifications.ts's requireUser(), 2026-08-22). ${home}`,
      );
    }
  }
  return offenders;
}

/**
 * Non-vacuity for GUARD_HOMES, two ways. (1) Every home must still DEFINE its
 * guard: a home that moved without this map following it would otherwise make
 * the real definition an "offender" somewhere else — or, worse, let the map
 * rot into a list of files that define nothing while the rule keeps passing.
 * (2) Every recognised name must HAVE a home: a name with none is a dead
 * entry, and a dead entry is a free pass for whoever defines it first (the
 * 2026-08-22 hole). `homes` is injectable so the second check is provable.
 */
export function guardHomeViolations(
  homes: Readonly<Record<string, readonly string[]>> = GUARD_HOMES,
): string[] {
  const problems: string[] = [];
  for (const [name, homeList] of Object.entries(homes)) {
    if (homeList.length === 0) {
      problems.push(
        `GUARD_HOMES: \`${name}\` is a recognised guard name with NO home — a dead entry nothing defines. A dead name is a free pass (whoever defines it first is "the guard"); remove it from the recognised lists or point it at the file that defines it.`,
      );
      continue;
    }
    for (const home of homeList) {
      let src: string;
      try {
        src = stripComments(readFileSync(home, "utf8"));
      } catch {
        problems.push(`${home}: listed as the home of \`${name}\` but does not exist`);
        continue;
      }
      const defines = guardDefinitionPatterns(name)
        .slice(0, 2)
        .some((re) => src.split("\n").some((line) => re.test(line)));
      if (!defines) {
        problems.push(
          `${home}: listed as the home of \`${name}\` but no longer defines it — update GUARD_HOMES`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Route-handler coverage — the same rule, one entry-point shape over (D4)
// ---------------------------------------------------------------------------

// Everything that authorizes a ROUTE HANDLER: the session guards an action may
// use, the institutional resolvers the operator API uses, and the cron-secret
// checks that only make sense on a handler. Deduplicated because
// INSTITUTIONAL_GUARDS and AUTH_GUARDS deliberately overlap.
export const ROUTE_HANDLER_GUARDS = [
  ...new Set<string>([...AUTH_GUARDS, ...INSTITUTIONAL_GUARDS, ...SYSTEM_GUARDS]),
] as readonly string[];

export function callsRouteHandlerGuard(body: string): boolean {
  return callsAnyGuard(body, ROUTE_HANDLER_GUARDS);
}

// The HTTP verbs Next's App Router turns into endpoints. Used ONLY to notice an
// export shape this analyzer cannot read — never to decide what gets scanned
// (the rule below covers EVERY exported async function in a route.ts, so a
// helper accidentally exported from one is not a blind spot either).
const HTTP_METHOD_EXPORTS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

// Method exports written in a shape `extractExportedAsyncFunctions` cannot read.
//
// TODAY 47/47 handlers are `export async function GET(…)`, which is why the
// extractor is reused verbatim. That is a MEASUREMENT, not a guarantee: the
// moment someone writes `export const GET = withRateLimit(handler)` the walker
// finds no declaration, the file yields zero functions, and a fence whose
// answer is "nothing to check" reports success. So an unreadable method export
// is an OFFENDER — the fence says it cannot see the handler instead of
// silently passing it.
export function findUnreadableMethodExports(relPath: string, src: string): string[] {
  const code = stripComments(src);
  const readable = new Set(extractExportedAsyncFunctions(src).map((fn) => fn.name));
  const offenders: string[] = [];
  for (const method of HTTP_METHOD_EXPORTS) {
    if (readable.has(method)) continue;
    // `export const|let|var GET =`, a non-async `export function GET(`, or a
    // re-export list naming the method (`export { handler as GET }`).
    const bindingRe = new RegExp(
      String.raw`export\s+(?:const|let|var)\s+${method}\s*[:=]|export\s+function\s+${method}\s*[(<]`,
    );
    const reExportRe = new RegExp(String.raw`export\s*\{[^}]*\b${method}\b[^}]*\}`);
    if (!bindingRe.test(code) && !reExportRe.test(code)) continue;
    offenders.push(
      `${relPath} exports ${method} in a shape this fence cannot read (it understands \`export async function ${method}(…)\`). The guard analysis binds to a declared async function body; any other shape yields NO function and the handler would pass by being invisible. Declare the handler as \`export async function ${method}(…)\` and keep the wrapper inside it, or teach extractExportedAsyncFunctions the new shape.`,
    );
  }
  return offenders;
}

// Returns one offender line per exported async function in a ROUTE HANDLER that
// authorizes nothing. Same three escapes as the action rule (inner-writer
// suffix, a recognized guard call, an explicit `@no-auth-required: <reason>`),
// with SYSTEM_GUARDS added to the recognized set — see that list for why they
// are handler-only.
//
// Plus two shape rules, because "no offenders" must mean "read and covered" and
// never "unread": an HTTP method exported in a shape the walker cannot read is
// an offender (findUnreadableMethodExports), and a route.ts that yields NO
// readable method at all is an offender too (the block at the end of this
// function). Empty array = the handler was read AND is covered.
export function findRouteHandlerOffenders(relPath: string, src: string): string[] {
  const offenders: string[] = [];
  const readable = extractExportedAsyncFunctions(src);
  for (const fn of readable) {
    if (isInnerWriter(fn.name)) continue;
    if (fn.hasNoAuthComment) {
      if ((fn.noAuthReason ?? "").length > 0) continue;
      offenders.push(
        `${relPath}:${fn.startLine} export async function ${fn.name} — opted out with a BARE \`// ${NO_AUTH_COMMENT}\` and no reason. An exemption whose justification nobody had to write is a silent baseline; write \`// ${NO_AUTH_COMMENT}: <why this endpoint is intentionally public>\`.`,
      );
      continue;
    }
    // stripComments for the same reason the action rule does it: a guard named
    // in a comment is documentation, not a call.
    if (callsRouteHandlerGuard(stripComments(fn.body))) continue;
    offenders.push(
      `${relPath}:${fn.startLine} export async function ${fn.name} — route handler with no authorization call (none of ${ROUTE_HANDLER_GUARDS.join("/")}). A route.ts is a client-addressable entry point exactly like a server action. This rule reads the HANDLER BODY ONLY and does not follow calls, so a guard factored out into a module-level helper reads as absent: call the guard directly in the handler body (the helper may still do the rest of the work). Call a guard, or — if the endpoint is intentionally public — add a \`// ${NO_AUTH_COMMENT}: <reason>\` comment immediately above the export saying why.`,
    );
  }

  const unreadable = findUnreadableMethodExports(relPath, src);
  offenders.push(...unreadable);

  // ZERO READABLE EXPORTS — the shape where BOTH rules above answer "nothing".
  //
  // findUnreadableMethodExports notices a method exported under a name it can
  // still SEE (`export const GET =`, `export { h as POST }`, a non-async
  // `export function DELETE(`). Two shapes carry no visible method name at all:
  //
  //   export const { GET, POST } = handlers;   // destructured binding
  //   export * from "./impl";                  // star re-export
  //
  // Neither yields a declaration for the walker, and neither names a method in
  // a form the binding/re-export regexes match. So the loop above iterates zero
  // functions, the unreadable rule fires zero offenders, and the file is
  // reported as authorized — the exact "a fence that scans nothing reports
  // success" failure this rule's sibling was written to prevent, reached by a
  // different door. Measured 2026-08-21 on both shapes.
  //
  // A route.ts that yields no readable HTTP method is therefore an OFFENDER on
  // its own: the fence says it cannot see the handler instead of passing it.
  if (readable.length === 0 && unreadable.length === 0) {
    offenders.push(
      `${relPath} — route handler exports no readable HTTP method (destructured, star, or indirect export). This fence binds its guard analysis to a declared \`export async function METHOD(…)\` body; a file that yields none is not "covered", it is UNREAD, and passing it would be passing it by not seeing it. Declare \`export async function METHOD(…)\` and keep any wrapper inside it, or teach extractExportedAsyncFunctions the new shape.`,
    );
  }

  return offenders;
}

// Authz impersonation-export rule (pattern-based).
// Origin: authz triage 2026-07-04. Widened: security review 07 (2026-07-05).
//
// A "use server" module must NEVER export an inner writer that carries the
// acting identity. Every export of a "use server" file is an independently-
// addressable server action, and such a writer takes its actor / subject /
// org as a caller-supplied parameter — exporting one hands impersonation-as-
// anyone to any client. RLS is NOT a backstop: db/index.ts connects with
// postgres-js (no Supabase JWT), so the app-layer guard is the only defense.
//
// Two signals, both pattern-based (not an allowlist of functions), so the
// class cannot silently regress:
//   (1) NAME — the export's name ends in one of IMPERSONATION_SUFFIXES
//       (*ForUser / *ForAuthority / *ForOrg / *Writer). The original rule
//       matched only the *For* trio; review 07 added *Writer, which had been
//       slipping through: the coverage rule (INNER_WRITER_SUFFIXES) exempts a
//       *Writer from needing its own guard, and nothing forbade exporting one.
//   (2) PARAMS — a DECLARED export whose signature names a caller-supplied
//       actor/subject id (IMPERSONATION_ACTOR_PARAMS), even if its name does
//       not match a suffix (e.g. a no-auth writer taking a bare actorUserId).
//
// A genuinely-safe export (identity derived from the session INSIDE the
// "use server" file, no client-trusted actor) may be listed in
// IMPERSONATION_SAFE_EXPORTS with a documented reason. It is empty today —
// every current writer export was removed rather than baselined.
//
// The writers themselves live on in plain application modules
// (src/modules/**/application/**), where they are not client-addressable;
// guarded `*Action` wrappers derive the actor from the session and delegate.
export const IMPERSONATION_SUFFIXES = ["ForUser", "ForAuthority", "ForOrg", "Writer"] as const;

// Caller-supplied identity parameters. A declared "use server" export whose
// signature names any of these is trusting the client for "who is acting" —
// the impersonation surface, regardless of the function's name.
export const IMPERSONATION_ACTOR_PARAMS = [
  "actorUserId",
  "recordedByUserId",
  "actingUserId",
  "subjectUserId",
  "onBehalfOfUserId",
  "performedByUserId",
] as const;

// Documented safe exports: `"<relPath>#<name>"` → reason. Use ONLY when the
// identity is derived from the session inside the "use server" file and no
// actor is client-supplied.
export const IMPERSONATION_SAFE_EXPORTS: Record<string, string> = {};

const IMPERSONATION_SUFFIX_RE = new RegExp(`(?:${IMPERSONATION_SUFFIXES.join("|")})$`);

function lineOfIndex(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

// Extract the parenthesized parameter list whose opening `(` is at
// `openParenIndex`, balancing parens so destructured `{ … }` params and
// default values are captured whole. Returns the inner text (without the
// outer parens).
function paramListAt(src: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIndex + 1, i);
    }
  }
  return "";
}

function actorParamIn(paramList: string): string | null {
  for (const p of IMPERSONATION_ACTOR_PARAMS) {
    if (new RegExp(`\\b${p}\\b`).test(paramList)) return p;
  }
  return null;
}

// Returns one offender line per impersonation-class export in a "use server"
// module: declared exports (`export async function xWriter`), exports whose
// signature names a caller-supplied actor id, and runtime re-export lists
// (`export { x }`, `export { y as xWriter }`). `export type { ... }` is erased
// at runtime and allowed. Empty array = file is clean.
export function findImpersonationExports(relPath: string, src: string): string[] {
  // Was `src.startsWith('"use server"')` on the RAW source, while listActionFiles()
  // used the comment-stripped form. A header comment — the dominant convention in
  // this repo — therefore switched OFF the impersonation rule while leaving the
  // other two rules on, for the same file. One authority for the directive now.
  if (!isServerActionModule(src)) return [];
  const offenders: string[] = [];
  const isSafe = (name: string) => IMPERSONATION_SAFE_EXPORTS[`${relPath}#${name}`] !== undefined;
  const offendSuffix = (name: string, line: number) => {
    if (isSafe(name)) return;
    offenders.push(
      `${relPath}:${line} exports ${name} — a "use server" module must not export a *${IMPERSONATION_SUFFIXES.join(
        "/*",
      )} writer (caller-supplied identity = impersonation surface; RLS does not backstop). Keep the writer in a plain application module and export only a session-guarded *Action wrapper.`,
    );
  };
  const offendParam = (name: string, param: string, line: number) => {
    if (isSafe(name)) return;
    offenders.push(
      `${relPath}:${line} exports ${name} — its signature takes a caller-supplied \`${param}\` (impersonation surface: a "use server" export lets any client act as any user; RLS does not backstop). Derive the actor from the session in a guarded *Action wrapper and keep the writer in a plain application module.`,
    );
  };

  // Declared exports: `export [async] function name<generics>(params)`.
  const declRe = /export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  for (const m of src.matchAll(declRe)) {
    const name = m[1];
    const line = lineOfIndex(src, m.index);
    if (IMPERSONATION_SUFFIX_RE.test(name)) {
      offendSuffix(name, line);
      continue;
    }
    // The trailing char of the match is the param-list `(`.
    const openParen = (m.index ?? 0) + m[0].length - 1;
    const actor = actorParamIn(paramListAt(src, openParen));
    if (actor) offendParam(name, actor, line);
  }

  // Runtime re-export lists: `export { a, b as c } [from "..."]`.
  // (`export type { ... }` and inline `type x` entries are type-only.)
  // Name-based only — no signature is visible on a re-export.
  const reExportRe = /export\s*(type\s*)?\{([^}]*)\}/g;
  for (const m of src.matchAll(reExportRe)) {
    if (m[1]) continue; // export type { ... } — erased at runtime
    for (const rawEntry of m[2].split(",")) {
      const entry = rawEntry.trim();
      if (entry === "" || entry.startsWith("type ")) continue;
      const parts = entry.split(/\s+as\s+/);
      const exportedName = (parts[1] ?? parts[0]).trim();
      if (IMPERSONATION_SUFFIX_RE.test(exportedName)) {
        offendSuffix(exportedName, lineOfIndex(src, m.index));
      }
    }
  }

  return offenders;
}

function bodyCallsAnyOf(src: string, guards: readonly string[]): boolean {
  return guards.some((g) => new RegExp(`\\b${g.replace(/\./g, "\\.")}\\s*\\(`).test(src));
}

// WS-AUTHZ 1.3 — operator-route ↔ guard rule. For a file under app/admin/** or
// app/gob/**: if it gates with a personal-tier guard but uses NO institutional
// guard, it's flagged. An operator surface must establish admin/govt authority,
// not merely authentication. Empty array = file is fine (institutionally gated,
// or gated upstream by its layout and calling no guard of its own).
//
// NOTE — the plan's stricter "admin folder ⇒ admin-only guard" heuristic is
// deliberately NOT enforced. Four admin surfaces (casos, panorama, and the two
// observaciones pages) use requireAdminOrGovtOrRedirect by design: casos narrows
// to admin via an in-body `redirect("/gob/casos")`, and panorama/observaciones
// are role-adaptive dashboards intentionally shared with govt. A blanket
// folder⇒guard rule would false-flag them; the invariant that actually holds
// tree-wide is the weaker, safer "no operator route gated by auth alone".
export function findRouteGuardViolations(relPath: string, src: string): string[] {
  const normalized = relPath.replaceAll("\\", "/");
  // Includes the operator surface under app/api/. That was NOT covered until
  // 2026-08-21, and the omission was structural rather than an oversight: the
  // predicate matched `app/admin/` and `app/gob/` literally, so `app/api/gob/`
  // — same operators, same data, a route handler instead of a page — fell
  // outside it. Widened while app/api/gob holds three files and app/api/admin
  // holds none, because widening a fence over an almost-empty directory costs
  // one run and widening it later costs an audit of everything already there.
  const isOperatorRoute =
    /(^|\/)app\/(api\/)?admin\//.test(normalized) ||
    /(^|\/)app\/(api\/)?gob\//.test(normalized) ||
    // Panorama is a gob analytics surface with its own institutional guard,
    // and its API routes were outside every operator rule until now.
    /(^|\/)app\/api\/panorama\//.test(normalized);
  if (!isOperatorRoute) return [];

  const usesPersonal = bodyCallsAnyOf(src, PERSONAL_TIER_GUARDS);
  const usesInstitutional = bodyCallsAnyOf(src, INSTITUTIONAL_GUARDS);
  if (usesPersonal && !usesInstitutional) {
    return [
      `${normalized} — operator route gated by a personal-tier guard only (one of ${PERSONAL_TIER_GUARDS.join("/")}) with no institutional guard (${INSTITUTIONAL_GUARDS.join("/")}). An admin/gob surface must establish operator authority, not just authentication.`,
    ];
  }
  return [];
}

// Operator route trees scanned by the route↔guard rule (pages, layouts, actions,
// route handlers).
/**
 * Non-vacuity floor for the operator surface under app/api/. Measured
 * 2026-08-21: 9 files (3 under app/api/gob, 6 under app/api/panorama) against
 * 340 operator routes overall. Set below the measurement so files can move
 * without a false alarm, and far above zero so the glob cannot silently stop
 * covering the API surface — which a TOTAL-count floor could never notice,
 * since dropping all nine takes 340 to 331.
 */
export const MIN_OPERATOR_API_FILES = 6;

export function listOperatorRouteFiles(): string[] {
  const patterns = [
    "app/admin/**/*.ts",
    "app/admin/**/*.tsx",
    "app/gob/**/*.ts",
    "app/gob/**/*.tsx",
    // The same operators through a route handler instead of a page. A native
    // client reaches these and nothing else in this file used to look at them.
    "app/api/admin/**/*.ts",
    "app/api/gob/**/*.ts",
    "app/api/panorama/**/*.ts",
  ];
  const files = patterns.flatMap((p) => globSync(p));
  return [...new Set(files)].filter((f) => !f.includes(".test.")).sort();
}

// ---------------------------------------------------------------------------
// Server-action discovery — by CONTENT, not by filename
// ---------------------------------------------------------------------------
//
// WHY THIS CHANGED (2026-08-05, P2 "el gate miente" audit). The old definition
// was two filename globs: `app/actions/*.ts` (FLAT — not even recursive) plus
// `src/modules/**/actions.ts` (only the literal name `actions.ts`). Next.js
// does not care what a server-action file is called; the "use server" directive
// is what makes every export of a module a client-addressable endpoint. So the
// globs were a naming convention masquerading as a security boundary, and ten
// real "use server" modules were invisible to all three linters that share this
// list — among them app/org/[orgToken]/atender/actions.ts with its eight
// clinical WRITE actions, app/admin/outbox/actions.ts, app/gob/analytics/
// export/actions.ts, app/admin/libro/actions.ts, and four route-colocated
// `action.ts` (SINGULAR) files. check-action-redirect.ts had already paid for
// this exact lesson with its own globs; this is the same fix, done honestly.
//
// A file counts when its FIRST statement (after comments) is the "use server"
// directive — the same thing the bundler looks at.
//
// KNOWN GAP, stated rather than hidden: a FUNCTION-scoped `"use server"` inside
// a component or page (one occurrence today — app/(app)/denuncias/[id]/page.tsx
// :164) is also a server action, but it is a closure, not an exported module
// function, so the `export async function` analysis every rule here performs has
// nothing to bind to. Covering inline actions needs a different rule shape, not
// a wider glob.
//
// `lib/**` JOINED ON 2026-09-18 (A01-7). No "use server" module lives there
// today, but discovery is by content, so the directory being outside the globs
// meant the first one placed there would have been scanned by no rule at all —
// and by none of the four fences that share this list either.
export const ACTION_SOURCE_GLOBS = [
  "app/**/*.ts",
  "app/**/*.tsx",
  "src/**/*.ts",
  "src/**/*.tsx",
  "lib/**/*.ts",
  "lib/**/*.tsx",
];

// The pre-2026-08-05 filename globs, kept as a UNION FLOOR. The content scan is
// a strict superset of them today except for one types-only file, and a union
// guarantees this change can never make the fence narrower than it already was.
const LEGACY_ACTION_GLOBS = ["app/actions/*.ts", "src/modules/**/actions.ts"];

/** True when the module's first statement is the "use server" directive. */
export function isServerActionModule(src: string): boolean {
  return /^(["'])use server\1/.test(stripComments(src).trimStart());
}

function isScannableSource(relPath: string): boolean {
  if (relPath.includes("__tests__")) return false;
  if (/\.test\.[jt]sx?$/.test(relPath)) return false;
  return !relPath.endsWith(".d.ts");
}

// ---------------------------------------------------------------------------
// Route-handler discovery — SEPARATE from listActionFiles on purpose (D4)
// ---------------------------------------------------------------------------
//
// listActionFiles() is imported by four other fences (check-audit-log-coverage,
// check-authz-scoping, check-confused-deputy, check-titular-gate). Widening it
// to include route handlers would have moved all four boundaries at once,
// silently, from an edit whose stated subject was this file. So handlers get
// their own list, modeled on check-api-guard-headers.ts's listApiFiles(): a
// Route Handler is a `route.ts`, wherever the App Router finds it — 13 of the
// 47 live outside app/api, including both auth callbacks and the public
// open-data endpoint.

/**
 * Non-vacuity floor for route-handler discovery. Measured 2026-08-21: 47
 * handlers (34 under app/api — 25 of them crons — plus 13 elsewhere: the two
 * auth callbacks, the two denuncia-seguimiento endpoints, the public open-data
 * download, five gob exports and three org exports).
 *
 * Set below the measurement so handlers can be added or removed without a false
 * alarm, and far above zero because THE FAILURE THIS FENCE GUARDS AGAINST IS A
 * FENCE THAT SCANS NOTHING: a glob that stops matching produces an empty list,
 * an empty list produces no offenders, and no offenders reads exactly like a
 * clean run. A floor is the only thing that tells those two apart.
 */
export const MIN_ROUTE_HANDLER_FILES = 40;

/**
 * Globs for route-handler discovery.
 *
 * The second one exists because `**` DOES NOT MATCH A DOT SEGMENT. Measured
 * 2026-08-25 against Node 22's `fs.globSync`: with a real `route.ts` on disk
 * under `.dot/x/`, `**​/route.ts` returned `[]` and `.dot/**​/route.ts` returned
 * the file. So the first `.well-known` route handler — the Android App Links
 * association at `app/.well-known/assetlinks.json/route.ts`, which Next routes
 * perfectly well — would have been a shipped, anonymous HTTP endpoint that this
 * fence never once looked at, and the fence's own count would not have moved.
 *
 * Named as a directory rather than as a general dot-glob on purpose: `.well-known`
 * is the one dotted path the App Router is expected to serve from (RFC 8615), and
 * a blanket dot-glob would start sweeping in build and tool directories.
 */
const ROUTE_HANDLER_GLOBS = ["app/**/route.ts", "app/.well-known/**/route.ts"];

/** Every App Router route handler in the repo. */
export function listRouteHandlerFiles(): string[] {
  const files = new Set(
    ROUTE_HANDLER_GLOBS.flatMap((pattern) => globSync(pattern)).map((f) => f.replaceAll("\\", "/")),
  );
  return [...files].filter(isScannableSource).sort();
}

// The full server-action surface this linter covers.
export function listActionFiles(): string[] {
  const files = new Set<string>();
  for (const pattern of LEGACY_ACTION_GLOBS) {
    for (const f of globSync(pattern)) files.add(f.replaceAll("\\", "/"));
  }
  for (const pattern of ACTION_SOURCE_GLOBS) {
    for (const f of globSync(pattern)) {
      const relPath = f.replaceAll("\\", "/");
      if (files.has(relPath)) continue;
      if (!isScannableSource(relPath)) continue;
      if (!isServerActionModule(readFileSync(f, "utf8"))) continue;
      files.add(relPath);
    }
  }
  return [...files].filter(isScannableSource).sort();
}

function runScan(): void {
  const actionFiles = listActionFiles();
  if (actionFiles.length === 0) {
    console.error("✗ check-authz-guards: found no server-action files to scan.");
    process.exit(1);
  }

  // Rule 1.2 — every server action must call a guard.
  // Impersonation rule (2026-07-04) — no *ForUser/*ForAuthority/*ForOrg export
  // from a "use server" module, pattern-based.
  const coverageOffenders: string[] = [];
  const impersonationOffenders: string[] = [];
  const deletionOffenders: string[] = [];
  for (const file of actionFiles) {
    const relPath = file.replaceAll("\\", "/");
    const src = readFileSync(file, "utf8");
    coverageOffenders.push(...findOffenders(relPath, src));
    impersonationOffenders.push(...findImpersonationExports(relPath, src));
    deletionOffenders.push(...findDeletionUnawareMutations(relPath, src));
  }

  // Rule 1.3 — no operator route gated by a personal-tier guard alone.
  const operatorFiles = listOperatorRouteFiles();

  // THE FLOOR THAT PROTECTS THE 2026-08-21 WIDENING, and it is separate from
  // any total on purpose. The operator surface under app/api/ was outside this
  // rule entirely; it is 9 files today (3 under app/api/gob, 6 under
  // app/api/panorama) against 340 overall, so a total-count floor could never
  // notice the glob narrowing back — dropping all nine changes 340 to 331.
  // Counting them on their own is the only check that fails when the API
  // surface stops being scanned. (The prose here said "3 … against 334" until
  // 2026-08-21: written against an earlier reading of the same widening and
  // never re-measured. Numbers in a comment rot; this one is now the number the
  // scan prints in its own summary line, so a drift is visible on every run.)
  const operatorApiFiles = operatorFiles.filter((f) =>
    f.replaceAll("\\", "/").includes("app/api/"),
  );
  if (operatorApiFiles.length < MIN_OPERATOR_API_FILES) {
    console.error(
      `✗ check-authz-guards: only ${operatorApiFiles.length} operator route(s) under app/api were scanned (floor ${MIN_OPERATOR_API_FILES}). The glob dropped the API surface — see MIN_OPERATOR_API_FILES.`,
    );
    process.exit(1);
  }

  const routeOffenders: string[] = [];
  for (const file of operatorFiles) {
    const relPath = file.replaceAll("\\", "/");
    routeOffenders.push(...findRouteGuardViolations(relPath, readFileSync(file, "utf8")));
  }

  // Rule 1.2, over route handlers (D4, 2026-08-21). Same coverage question, the
  // other entry-point shape.
  const handlerFiles = listRouteHandlerFiles();
  if (handlerFiles.length < MIN_ROUTE_HANDLER_FILES) {
    console.error(
      `✗ check-authz-guards: only ${handlerFiles.length} route handler(s) were discovered (floor ${MIN_ROUTE_HANDLER_FILES}). The app/**/route.ts glob is broken — a fence that finds nothing to scan reports success. See MIN_ROUTE_HANDLER_FILES.`,
    );
    process.exit(1);
  }

  const handlerOffenders: string[] = [];
  for (const file of handlerFiles) {
    handlerOffenders.push(...findRouteHandlerOffenders(file, readFileSync(file, "utf8")));
  }

  // Guard shadowing (2026-08-22) — tree-wide, see GUARD_HOMES. The home map's
  // own non-vacuity check runs first: a rotten map is a fence that passes.
  const shadowOffenders: string[] = [...guardHomeViolations()];
  const shadowScanFiles = listGuardShadowScanFiles();
  for (const file of shadowScanFiles) {
    shadowOffenders.push(...findShadowedGuardDefinitions(file, readFileSync(file, "utf8")));
  }

  const offenders = [
    ...coverageOffenders,
    ...impersonationOffenders,
    ...deletionOffenders,
    ...routeOffenders,
    ...handlerOffenders,
    ...shadowOffenders,
  ];
  if (offenders.length > 0) {
    console.error(offenders.join("\n"));
    if (coverageOffenders.length > 0) {
      console.error(`\n✗ ${coverageOffenders.length} server action(s) without an auth guard.`);
    }
    if (impersonationOffenders.length > 0) {
      console.error(
        `✗ ${impersonationOffenders.length} impersonation-class export(s) (*${IMPERSONATION_SUFFIXES.join(
          "/*",
        )}) from "use server" module(s).`,
      );
    }
    if (deletionOffenders.length > 0) {
      console.error(
        `✗ ${deletionOffenders.length} write action(s) authorized on a bare auth.getUser() with no deletion-aware guard.`,
      );
    }
    if (routeOffenders.length > 0) {
      console.error(
        `✗ ${routeOffenders.length} operator route(s) gated by a personal-tier guard only.`,
      );
    }
    if (handlerOffenders.length > 0) {
      console.error(
        `✗ ${handlerOffenders.length} route handler export(s) without an authorization call or a justified ${NO_AUTH_COMMENT} opt-out.`,
      );
    }
    if (shadowOffenders.length > 0) {
      console.error(
        `✗ ${shadowOffenders.length} definition(s) of a recognised guard name outside its canonical home (see GUARD_HOMES).`,
      );
    }
    process.exit(1);
  }

  const optedOutHandlers = handlerFiles.filter((file) =>
    extractExportedAsyncFunctions(readFileSync(file, "utf8")).some((fn) => fn.hasNoAuthComment),
  ).length;

  console.log(
    `✓ authz coverage clean — ${actionFiles.length} action files guarded, no impersonation-class exports, no bare-getUser writes; operator routes institutionally gated across ${operatorFiles.length} files (${operatorApiFiles.length} of them under app/api); ${handlerFiles.length} route handlers authorized (${optedOutHandlers} intentionally public, each with a written ${NO_AUTH_COMMENT} reason); no guard name defined outside its home across ${shadowScanFiles.length} files.`,
  );
}

// Guard: only scan when run directly; importing (tests) exposes the helpers
// without triggering the filesystem scan.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-authz-guards.ts") ||
    process.argv[1].endsWith("check-authz-guards.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
