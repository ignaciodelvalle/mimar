// Operator-shift REACH fence — CI guardrail (B9).
//
// THE QUESTION THIS ASKS, AND WHY NOTHING ASKED IT BEFORE
// ---------------------------------------------------------------------------
// check-authz-guards.ts asks "is there a guard AT ALL?". check-authz-scoping.ts
// asks "is the resource bound to the caller's tenant?". check-titular-gate.ts
// asks "is the ROLE in the ownership row allowed to do this?". None of them asks
// the question B9 introduced: "this code decides that somebody holds
// INSTITUTIONAL or OPERATOR authority — does that decision ever consult the
// 8-hour shift?"
//
// On 2026-08-25 the answer was no in four places, and the four had nothing in
// common except that nobody had a reason to look at them together:
//
//   · app/org/[orgToken]/atender/atender-access.ts — seven append-only CLINICAL
//     server actions at a veterinary clinic's shared front desk, authorized by a
//     bare getUser() plus a capability READ imported straight out of the authz
//     resolver. The literal scenario B9 was written for.
//   · app/actions/alert-firings.ts — six national-surveillance triage actions
//     behind a file-local `requireAdminUser` (bare getUser + a hand-rolled
//     profile query). 100% of its callers are role:"admin", i.e. institutional
//     by definition.
//   · app/api/gob/_guard.ts and app/api/panorama/_guard.ts — the inspector and
//     analytics consoles, seven GET routes, same bare-getUser opening.
//
// Every one of them passed check-authz-guards, because a guard existed. What was
// missing was not a guard; it was a fence that could say the guard reached the
// control. This is that fence.
//
// WHAT IT KEYS ON — THE SUBJECT, NOT A LIST OF FILES
// ---------------------------------------------------------------------------
// A list of "these five guards apply the shift" proves nothing about the sixth,
// which is precisely the one that will not be on the list. So the antecedent is
// DERIVED on every run, from two properties a function has or does not have:
//
//   1. IT RESOLVES A SESSION — its body calls `.auth.getUser(`, or it calls a
//      function this scan has already classified as reaching the shift (every
//      such function reaches it BY resolving a session first).
//   2. IT MAKES AN OPERATOR DECISION — its body carries one of OPERATOR_SIGNALS
//      below: a comparison against the `admin`/`govt` roles, the
//      `institutional` account type, an org membership or capability-grant
//      read, or a jurisdiction-assignment read.
//
// A function with both is an OPERATOR-ACTOR RESOLVER. It must REACH the shift:
// call `isOperatorShiftExpired`, or `requireLiveUser` / `resolveOptionalLiveUser`
// (which apply it), or call something that does — transitively, along call edges,
// to a fixpoint. check-titular-gate.ts is the model for that propagation and its
// header explains why the naive "same function must contain both" rule is
// unsatisfiable in this codebase: DIM puts the guard in one layer and the effect
// two files away.
//
// A brand-new guard in a module that does not exist yet is caught on its first
// commit, with no fence update — as long as it says, in code, that it is deciding
// something about an operator. That is the whole design.
//
// WHAT IT DELIBERATELY DOES NOT COVER — stated, not glossed
// ---------------------------------------------------------------------------
//   · WHETHER THE SHIFT APPLIES TO THE RIGHT PRINCIPAL. `requireLiveUser`
//     enforces it only for an INSTITUTIONAL profile; an org staffer commonly
//     holds `role: "vet"` / `accountType: "personal"` and needs the SECOND
//     application inside the org capability path. This fence cannot tell those
//     two apart — reaching `requireLiveUser` satisfies it either way.
//     __tests__/org-capability-shift.test.ts is what holds that line, on purpose
//     and by behaviour rather than by pattern.
//   · ANYTHING BELOW THE APP LAYER. Drizzle connects with postgres-js and
//     bypasses RLS; a PostgREST caller holding the same bearer token is not
//     gated by any TypeScript in this repo. Track 2's "native talks to our own
//     /api/v1, never to Supabase directly" is a deployment invariant, not
//     something a linter can enforce.
//   · FUNCTION-SCOPED `"use server"` closures inside a page or component. They
//     are real server actions and this scan binds to declared functions, so a
//     guard written inside one is invisible here — the same gap
//     check-authz-guards.ts names for its own rules.
//   · A REACH THIS SCANNER CANNOT SEE. Call edges are matched BY NAME, so a
//     guard reached through a dynamic `await import()`, a callback parameter or
//     an object-property indirection reads as NOT reaching. The direction is
//     safe (it over-reports) and the cost is one allowlist entry with a reason.
//   · TWO FUNCTIONS SHARING A NAME over-taint rather than under-taint, which is
//     the same trade check-titular-gate takes for the same reason.
//   · Regex over comment-stripped bodies, like all 60 sibling linters. An
//     operator decision assembled out of a variable (`profile.role !== wanted`)
//     carries no signal and is invisible.
//
// Run: pnpm tsx scripts/check-operator-shift-reach.ts   (or: pnpm lint:shift-reach)
// Exits 0 when every operator-actor resolver reaches the shift; exits 1 naming
// each that does not.

import { globSync, readFileSync } from "node:fs";

import { stripComments } from "./lib/strip-comments.mjs";

// ---------------------------------------------------------------------------
// The control, and the ways of reaching it
// ---------------------------------------------------------------------------

/**
 * Calling any of these IS reaching the shift.
 *
 * `isOperatorShiftExpired` is the control itself (lib/infra/operator-shift.ts).
 * The two liveness entry points are listed because they apply it internally for
 * an institutional principal — see the caveat in the header about which
 * principal that covers.
 */
export const SHIFT_REACHING_CALLS = [
  "isOperatorShiftExpired",
  "requireLiveUser",
  "resolveOptionalLiveUser",
] as const;

/**
 * How a body says "I am resolving who is calling".
 *
 * Only the bare Supabase call is listed. Every OTHER way of resolving a session
 * in this codebase goes through a function that reaches the shift, and the
 * transitive index below picks those up on its own — listing them here as well
 * would be a second, hand-maintained copy of an answer the scan derives.
 *
 * IT CONTRIBUTES NOTHING TO ANY OTHER NUMBER IN THIS FILE, which is why it has a
 * floor of its own — see MIN_SESSION_RESOLUTIONS.
 */
export const SESSION_RESOLUTION_RE = /\.auth\.getUser\s*\(/;

/**
 * How a body says "I am deciding something about an OPERATOR".
 *
 * Each entry is a decision the citizen surfaces never make. A function that
 * resolves a session and then consults one of these is establishing
 * institutional or operator authority, which is exactly the population B9
 * bounds.
 */
export const OPERATOR_SIGNALS: ReadonlyArray<{ readonly re: RegExp; readonly why: string }> = [
  {
    // `profile.role !== "admin"`, `role === "govt"`,
    // `opts.allow.includes(profile.role as "admin" | "govt")`, and the reverse
    // order (`allow: ["admin","govt"]` a couple of lines above a `.role` read).
    //
    // The window spans newlines on purpose: the real predicates in this codebase
    // are formatted across three or four lines by Biome, and a single-line
    // window would have missed every one of them. 160 characters is wide enough
    // for those and narrow enough that a body merely MENTIONING both things far
    // apart does not light up — and when it does, over-matching is the safe
    // direction: it costs an allowlist entry, not a bypass.
    re: /\brole\b[\s\S]{0,160}?["'](?:admin|govt)["']|["'](?:admin|govt)["'][\s\S]{0,160}?\brole\b/,
    why: "compares a profile role against the admin/govt operator roles",
  },
  {
    re: /["']institutional["']/,
    why: "consults the `institutional` account type",
  },
  {
    re: /\bisInstitutionalPrincipal\s*\(/,
    why: "calls isInstitutionalPrincipal",
  },
  {
    re: /\bloadActiveInstitutionalProfile\s*\(/,
    why: "loads an active institutional profile",
  },
  {
    // Org staff are operators too, and their operator-ness lives in
    // organization_memberships — the table requireLiveUser never reads.
    re: /\borganizationMemberships\b|\bgetActiveMemberships\s*\(|\bgetOrgMembershipCached\s*\(/,
    why: "resolves an organization membership (org staff are operators under B9)",
  },
  {
    re: /\borganizationCapabilityGrants\b|\bgetGrantedCapabilities\s*\(|\bresolveGrantedCaps\s*\(/,
    why: "reads org capability grants",
  },
  {
    re: /\bgetJurisdictionsCached\s*\(|\bgovtAssignments\b/,
    why: "reads a govt account's jurisdiction assignments",
  },
];

/**
 * Documented exceptions: `"<relPath>#<fn>"` → reason. EMPTY IS THE GOAL.
 *
 * IT WAS NOT BORN EMPTY EITHER — it was born with nothing in it because the four
 * real offenders this fence was written for were FIXED in the same batch rather
 * than baselined (atender-access.ts, alert-firings.ts, and the two institutional
 * API guards). The red proof lives in
 * __tests__/check-operator-shift-reach.test.ts, which detaches a guard from a
 * synthetic source and asserts this scan says so.
 */
export const SHIFT_REACH_ALLOWLIST: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

/**
 * app/, src/ and lib/ — the same three roots check-authz-guards.ts sweeps for
 * guard shadowing, and for the same reason: a resolver that lives in a helper
 * module and is imported into an action is the same decision one hop away.
 */
const SCAN_GLOBS = [
  "app/**/*.ts",
  "app/**/*.tsx",
  "src/**/*.ts",
  "src/**/*.tsx",
  "lib/**/*.ts",
  "lib/**/*.tsx",
];

/**
 * Non-vacuity floor for discovery. Measured 2026-08-25: 1,861 files under the
 * three roots. Far below the measurement so files can move, and far above zero
 * because A FENCE THAT SCANS NOTHING REPORTS SUCCESS.
 */
export const MIN_SCANNED_FILES = 1200;

/**
 * Non-vacuity floor for the shift-reach index. If the propagation breaks, the
 * index empties, every resolver reads as NOT reaching, and the fence goes loudly
 * red — so this floor is not what protects against a broken index. What it
 * protects against is the OPPOSITE break: a `SHIFT_REACHING_CALLS` regex that
 * stops matching would empty the index too, and a tree where nothing reaches the
 * shift AND nothing resolves an operator is a scan that has stopped reading its
 * own inputs. Measured 2026-08-25: 341 names.
 */
export const MIN_SHIFT_REACHERS = 200;

/**
 * Non-vacuity floor for the ANTECEDENT, and this is the one that matters.
 *
 * If OPERATOR_SIGNALS stops matching, the fence finds no operator-actor
 * resolvers, therefore no offenders, and prints green — the exact failure every
 * sibling fence's floor exists to catch, reached here by the only door that
 * stays quiet. Measured 2026-08-25: 57 resolvers across the six families — the
 * operator page screens (admin/gob), the institutional API guards, the export
 * route handlers, the decomiso / return-to-owner / welfare org actions, the
 * shared guards in lib/infra, and the org capability path.
 *
 * (This comment claimed 55 when it was written and the tree held 56, which is
 * the kind of number a reader trusts and nobody re-derives. It is 57 since
 * `/turno-vencido` grew the org-staff leg of the shift predicate.)
 *
 * IT DOES NOT COVER SESSION_RESOLUTION_RE, although the sentence above used to
 * say it did. That is the whole subject of MIN_SESSION_RESOLUTIONS below.
 */
export const MIN_OPERATOR_RESOLVERS = 35;

/**
 * Non-vacuity floor for the SESSION-RESOLUTION leg specifically, and it needs
 * its own number for a reason MIN_OPERATOR_RESOLVERS structurally cannot cover.
 *
 * Read the antecedent as the code computes it:
 *
 *     const resolvesSession = SESSION_RESOLUTION_RE.test(unit.body) || reaches;
 *
 * On a CLEAN tree every operator-actor resolver reaches the shift — that is what
 * the fence being green means — so `reaches` is already true for every unit that
 * survives the operator-signal filter, and the regex leg decides nothing.
 * Measured 2026-08-25: exactly 2 units in the tree match both the regex and an
 * operator signal, and BOTH of them reach anyway. So `SESSION_RESOLUTION_RE`
 * contributes ZERO to `MIN_OPERATOR_RESOLVERS`, zero to the offender list, and
 * zero to the green line — a dead regex would move nothing and the fence would
 * keep printing today's number while going blind to its actual subject: A NEW
 * BARE-getUser OPERATOR GUARD, which is the exact shape of all four bypasses
 * this fence was written for.
 *
 * The same trap, in the same week, in check-storage-write-policies.ts: no `alter
 * policy` targets storage.objects today, so its ALTER branch contributed zero to
 * every other count and needed MIN_ALTER_STATEMENTS to have anything to fail on.
 * This is that floor, in that idiom.
 *
 * COUNTED OVER THE RAW REGEX, before the operator-signal filter and before the
 * reach credit — the honest denominator, and it is a SMALL one. Measured
 * 2026-08-25: 13 functions across the three roots call `.auth.getUser(`
 * directly, and that is the point rather than a weakness. The number is small
 * BECAUSE the codebase has been moving identity resolution behind
 * `requireLiveUser`; the survivors are `requireLiveUser` itself, the SSR cookie
 * refresh in lib/supabase/middleware.ts, and eleven application-layer actions
 * (transfers ×4, the gob analytics export, the two auth completion flows, the
 * caretaker email read, the PPP export, the scan log, the stub claim).
 *
 * The floor is 8 rather than 12: that direction of travel is HEALTHY and must
 * not turn a good change red, and the storage fence took the same ratio for the
 * same reason (80 measured, floor 50). Above zero is what matters — a regex
 * that matches nothing is a leg that guards nothing.
 */
export const MIN_SESSION_RESOLUTIONS = 8;

function isScannable(relPath: string): boolean {
  if (relPath.includes("__tests__")) return false;
  if (/\.test\.[jt]sx?$/.test(relPath)) return false;
  return !relPath.endsWith(".d.ts");
}

export type ScanSource = { relPath: string; src: string };

export function listScanSources(): ScanSource[] {
  const paths = new Set<string>();
  for (const pattern of SCAN_GLOBS) {
    for (const f of globSync(pattern)) {
      const relPath = f.replaceAll("\\", "/");
      if (isScannable(relPath)) paths.add(relPath);
    }
  }
  return [...paths].sort().map((relPath) => ({ relPath, src: readFileSync(relPath, "utf8") }));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
//
// NOT `extractExportedAsyncFunctions` from check-authz-guards.ts, and the
// difference is load-bearing: that walker anchors on `^export`, and TWO of the
// four bypasses this fence exists for were module-PRIVATE functions
// (`requireAdminUser` in alert-firings.ts, `resolveAtenderContext`'s old body).
// A scan that can only see exports cannot see the guard that hides behind one.

/** Index just past the `)` closing the parameter list that opens at `from`. */
function skipParams(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/**
 * Index of the `{` that opens the body. The return annotation may carry braces
 * inside `Promise<{ … }>`, so the walk waits for a brace at angle-depth zero.
 */
function findBodyStart(src: string, from: number): number {
  let angle = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "{" && angle === 0) return i;
  }
  return src.length;
}

/** Index of the `}` matching the `{` at `from`. */
function matchBrace(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/** The first `(` at angle-depth zero at or after `from` — past any generics. */
function findParamsStart(src: string, from: number): number {
  let angle = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "(" && angle === 0) return i;
  }
  return src.length;
}

export type AsyncFn = { name: string; body: string };

/**
 * Every async function declaration in a module — exported or not — plus the
 * `const x = async (…) => {}` form, which is how several guards in this codebase
 * are written and which a declaration-only walker would silently skip.
 */
export function extractAsyncFunctions(src: string): AsyncFn[] {
  const out: AsyncFn[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:export\s+)?async\s+function\s+(\w+)\s*[(<]/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=\n]*)?=\s*async\s*(?:<[^>]*>)?\s*\(/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const paramsStart = findParamsStart(src, (m.index ?? 0) + m[0].length - 1);
      const paramsEnd = skipParams(src, paramsStart);
      const bodyStart = findBodyStart(src, paramsEnd);
      const bodyEnd = matchBrace(src, bodyStart);
      out.push({ name: m[1], body: src.slice(bodyStart, bodyEnd + 1) });
    }
  }
  return out;
}

/** `import { requireLiveUser as live }` → `live` ⇒ `requireLiveUser`. */
export function importAliases(src: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const raw of m[1].split(",")) {
      const parts = raw.trim().split(/\s+as\s+/);
      if (parts.length === 2 && parts[0] && parts[1]) aliases.set(parts[1].trim(), parts[0].trim());
    }
  }
  return aliases;
}

type Unit = {
  relPath: string;
  name: string;
  /** Comment-stripped. A guard named in prose is documentation, not a call. */
  body: string;
  aliases: Map<string, string>;
};

/**
 * Parsed units, memoised on the SOURCE ARRAY's identity.
 *
 * The three exported entry points below each need the units, and a run that
 * calls all three — `runScan` does, and so does the test — used to strip
 * comments and walk 1,861 files once per call. Keyed on the array itself, so a
 * caller that builds a fresh list gets a fresh parse and cannot be handed a
 * stale one.
 */
const unitCache = new WeakMap<readonly ScanSource[], Unit[]>();

function parseUnits(sources: readonly ScanSource[]): Unit[] {
  const cached = unitCache.get(sources);
  if (cached !== undefined) return cached;

  const units: Unit[] = [];
  for (const { relPath, src } of sources) {
    const code = stripComments(src);
    const aliases = importAliases(code);
    for (const fn of extractAsyncFunctions(code)) {
      units.push({ relPath, name: fn.name, body: fn.body, aliases });
    }
  }
  unitCache.set(sources, units);
  return units;
}

/**
 * Compiled `\bname\s*\(` matchers, cached by name.
 *
 * THIS IS THE HOT PATH, and it is worth a cache rather than being tidy: the
 * fixpoint asks "does this unit call any reaching name?" for every unit against
 * every name in the index — roughly 4,000 × 340 questions per pass. Building a
 * RegExp for each of those is over a million compilations for one run, which is
 * what made the whole-repo test time out under suite contention (measured
 * 2026-08-25). The set of names is small and closed; the cache is bounded by it.
 */
const callRegexCache = new Map<string, RegExp>();

function callRegex(name: string): RegExp {
  let re = callRegexCache.get(name);
  if (re === undefined) {
    re = new RegExp(`\\b${name.replace(/\./g, "\\.")}\\s*\\(`);
    callRegexCache.set(name, re);
  }
  return re;
}

function callsIdentifier(unit: Unit, name: string): boolean {
  if (callRegex(name).test(unit.body)) return true;
  for (const [local, original] of unit.aliases) {
    if (original === name && callRegex(local).test(unit.body)) return true;
  }
  return false;
}

/** Does `unit` call ANY of `names`? Iterates the Set without materialising it. */
function callsAnyOf(unit: Unit, names: ReadonlySet<string>): boolean {
  for (const name of names) {
    if (callsIdentifier(unit, name)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase 1 — who reaches the shift
// ---------------------------------------------------------------------------

/**
 * The names of every function that reaches `isOperatorShiftExpired`, directly or
 * through a chain of calls.
 *
 * Seeded with SHIFT_REACHING_CALLS themselves so a body that calls
 * `requireLiveUser` is credited without the scan having to find and parse
 * requireLiveUser's own body first — it does find it, but the seed makes the
 * fixpoint independent of whether lib/infra/live-user.ts is in scope.
 */
const reachCache = new WeakMap<readonly ScanSource[], Set<string>>();

export function indexShiftReachers(sources: readonly ScanSource[]): Set<string> {
  const cached = reachCache.get(sources);
  // A COPY, so a caller that mutates what it got back cannot quietly change what
  // the next caller sees. 340 strings; the copy is not the cost here.
  if (cached !== undefined) return new Set(cached);

  const units = parseUnits(sources);
  const reaching = new Set<string>(SHIFT_REACHING_CALLS);

  // Bounded fixpoint. The guard is a safety net against a pathological cycle,
  // not an expected exit.
  for (let pass = 0; pass < 20; pass++) {
    let grew = false;
    for (const unit of units) {
      if (reaching.has(unit.name)) continue;
      if (!callsAnyOf(unit, reaching)) continue;
      reaching.add(unit.name);
      grew = true;
    }
    if (!grew) break;
  }

  reachCache.set(sources, reaching);
  return new Set(reaching);
}

// ---------------------------------------------------------------------------
// Phase 2 — who must reach it
// ---------------------------------------------------------------------------

/** The operator decisions a body makes, as human-readable reasons. */
export function operatorSignalsIn(body: string): string[] {
  return OPERATOR_SIGNALS.filter(({ re }) => re.test(body)).map(({ why }) => why);
}

export type OperatorResolver = {
  relPath: string;
  name: string;
  signals: string[];
  reaches: boolean;
};

/**
 * How many units resolve a session with a bare `.auth.getUser(`.
 *
 * The RAW count: no operator-signal filter, no reach credit, no dedup by file.
 * It exists so MIN_SESSION_RESOLUTIONS has something to count that the rest of
 * this file does not already count for it — see that constant for why the leg is
 * otherwise unobservable.
 */
export function countSessionResolvingUnits(sources: readonly ScanSource[]): number {
  return parseUnits(sources).filter((unit) => SESSION_RESOLUTION_RE.test(unit.body)).length;
}

export function findOperatorResolvers(sources: readonly ScanSource[]): OperatorResolver[] {
  const units = parseUnits(sources);
  const reaching = indexShiftReachers(sources);
  const resolvers: OperatorResolver[] = [];

  for (const unit of units) {
    // A function that IS one of the reaching set is a guard, not a caller of
    // one; it is the thing the rule is about, not a subject of it.
    const reaches = reaching.has(unit.name) || callsAnyOf(unit, reaching);

    // Property 1 — does it resolve a session at all? A pure helper handed a
    // userId is not making an authorization decision about a caller.
    const resolvesSession = SESSION_RESOLUTION_RE.test(unit.body) || reaches;
    if (!resolvesSession) continue;

    // Property 2 — does it decide something about an OPERATOR?
    const signals = operatorSignalsIn(unit.body);
    if (signals.length === 0) continue;

    resolvers.push({ relPath: unit.relPath, name: unit.name, signals, reaches });
  }
  return resolvers;
}

export function findShiftReachOffenders(sources: readonly ScanSource[]): string[] {
  const offenders: string[] = [];
  for (const resolver of findOperatorResolvers(sources)) {
    if (resolver.reaches) continue;
    if (SHIFT_REACH_ALLOWLIST[`${resolver.relPath}#${resolver.name}`] !== undefined) continue;
    offenders.push(
      `${resolver.relPath} — ${resolver.name} resolves a session AND ${resolver.signals.join(
        "; ",
      )}, but never reaches the 8-hour operator shift (${SHIFT_REACHING_CALLS.join(
        " / ",
      )}), directly or through anything it calls. An operator console on a shared municipal desk must not still be authenticated the next morning (B9). Route the identity step through requireLiveUser (lib/infra/live-user.ts) — or, for an ORG staffer who may hold a personal profile, through the org capability path, which re-applies the shift for exactly that principal (src/modules/organizations/infrastructure/authz-resolver.ts). If this really is an exception, write it into SHIFT_REACH_ALLOWLIST with a reason.`,
    );
  }
  return offenders.sort();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runScan(): void {
  const sources = listScanSources();

  if (sources.length < MIN_SCANNED_FILES) {
    console.error(
      `✗ check-operator-shift-reach: only ${sources.length} file(s) discovered (floor ${MIN_SCANNED_FILES}). The globs stopped matching — a fence that scans nothing reports success. See MIN_SCANNED_FILES.`,
    );
    process.exit(1);
  }

  const reaching = indexShiftReachers(sources);
  if (reaching.size < MIN_SHIFT_REACHERS) {
    console.error(
      `✗ check-operator-shift-reach: the shift-reach index holds only ${reaching.size} name(s) (floor ${MIN_SHIFT_REACHERS}). Either the call-edge propagation broke or SHIFT_REACHING_CALLS stopped matching; both make this fence measure nothing. See MIN_SHIFT_REACHERS.`,
    );
    process.exit(1);
  }

  // The session-resolution leg is alive. Checked BEFORE the resolver floor
  // because it is the only failure here that leaves every other number in this
  // file exactly where it is — on a clean tree the reach credit already answers
  // for every resolver, so a dead regex changes nothing that anyone would see.
  const sessionResolutions = countSessionResolvingUnits(sources);
  if (sessionResolutions < MIN_SESSION_RESOLUTIONS) {
    console.error(
      [
        `✗ check-operator-shift-reach: only ${sessionResolutions} function(s) match SESSION_RESOLUTION_RE (floor ${MIN_SESSION_RESOLUTIONS}).`,
        "  That leg decides nothing on a clean tree — every operator-actor resolver",
        "  already reaches the shift, so `resolvesSession` is satisfied by the reach",
        "  credit and the regex adds zero to every other count here. Which means a",
        "  regex that stopped matching would leave this fence printing the same green",
        "  line while a NEW bare-getUser operator guard — the shape of all four",
        "  bypasses this fence was written for — walked straight through. See",
        "  MIN_SESSION_RESOLUTIONS.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const resolvers = findOperatorResolvers(sources);
  if (resolvers.length < MIN_OPERATOR_RESOLVERS) {
    console.error(
      `✗ check-operator-shift-reach: found only ${resolvers.length} operator-actor resolver(s) (floor ${MIN_OPERATOR_RESOLVERS}). No antecedent means no offenders, and no offenders reads exactly like a clean run — which is the failure this floor exists for. See MIN_OPERATOR_RESOLVERS.`,
    );
    process.exit(1);
  }

  const offenders = findShiftReachOffenders(sources);
  if (offenders.length > 0) {
    console.error(offenders.join("\n\n"));
    console.error(
      `\n✗ ${offenders.length} operator-actor resolver(s) never reach the 8-hour shift.`,
    );
    process.exit(1);
  }

  const allowlisted = Object.keys(SHIFT_REACH_ALLOWLIST).length;
  console.log(
    `✓ operator-shift reach clean — ${sources.length} files scanned, ${reaching.size} shift-reaching name(s) indexed, ${sessionResolutions} bare-getUser session resolution(s) seen, ${resolvers.length} operator-actor resolver(s) all reaching the control${
      allowlisted > 0 ? ` (${allowlisted} allowlisted)` : ""
    }.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-operator-shift-reach.ts") ||
    process.argv[1].endsWith("check-operator-shift-reach.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
