// Titular-row resolution fence — one active ownership row is not one active
// ownership ROW.
//
// THE BUG, SEVEN TIMES
// ---------------------------------------------------------------------------
// `(pet_id, ended_at IS NULL)` used to mean "exactly one row". Custodia-temporal
// ended that on the day it shipped: an accepted caretaker grant opens a SECOND
// active `ownerships` row, and a rehome sponsorship opens a third (an org
// `shelter_custody` row alongside the owner's). Every query that kept pairing
// that predicate with `.limit(1)` and no role predicate has been picking a row
// BY HEAP ORDER ever since — and each of them was answering the question "who
// is the titular of this pet?".
//
// It shipped to production seven times before anybody counted:
//   · the public credential's owner row (cad8b854d) — published the CARETAKER's
//     phone number on a lost pet's public page.
//   · the finder flow ×3, the printable lost poster, the sighting recipient
//     (afd01fb3c) — a caretaker's name and phone on a flyer stapled to a
//     lamppost, a stranger's contact delivered to the wrong person.
//   · setPetFoundAction (2026-08-23) — the titular marks their own pet found
//     and the confirmation goes to the caretaker.
// The sixth commit closed five of them and declared the corpus bounded. The
// seventh was found the next day, by hand, in a file that commit had read.
//
// WHY A FENCE AND NOT SEVEN TESTS
// ---------------------------------------------------------------------------
// This repo has the lesson written down (memory: "fence enumerates forms, not
// the thing"): a guard that lists the instances it knows about misses the next
// one. Seven unit tests would have pinned seven call sites and said nothing
// about the eighth — and the eighth is the whole problem, because this defect's
// signature is that it keeps being re-introduced by people copying a query that
// looks correct. One structural rule catches all seven AND the eighth.
//
// THE RULE
// ---------------------------------------------------------------------------
// A query that reads `ownerships`, filters on `ended_at IS NULL`, and takes a
// SINGLE ROW must either
//   · constrain the ROLE (`eq(ownerships.role, …)`, `inArray`, `ne`), or
//   · not be resolving a titular identity at all — see EXEMPT SHAPES below.
//
// Filtering is not always the right remedy, and this fence deliberately does
// not say which one to use. `lib/infra/pet-alert-recipients.ts` refuses a role
// filter with an argument worth reading before "fixing" anything here: a pet in
// shelter custody has no `owner` row at all, so where the read is a hard gate,
// filtering turns a mis-routed alert into NO alert. Ranking is the fix there.
// The rule this fence enforces is the one both remedies satisfy: STOP LETTING
// POSTGRES CHOOSE.
//
// EXEMPT SHAPES — documented, because each is a legitimate single-row read:
//   · CALLER-SCOPED   `eq(ownerships.ownerUserId, user.id)` — resolving the
//     caller's own relationship to a pet. No third party's identity crosses.
//   · ORG-SCOPED      `eq(ownerships.ownerOrganizationId, …)` — an institution's
//     own custody row.
//   · BY-OWNERSHIP-ID `eq(ownerships.id, …)` — the row is already chosen.
//   · COUNT / EXISTS  — asks how many, not which.
//   · EXISTENCE PROBE the projection is nothing but `ownerships.id`, used as a
//     boolean. The free-claim guard is this shape and MUST stay role-blind: a
//     pet is claimable only when it has no active custody of ANY role, so
//     narrowing it to `owner` would make a refugio's foster-held animal
//     directly claimable by a stranger.
//   · ALL ROWS        no `.limit(1)` and no `[0]` destructure — the caller sees
//     every holder and decides in JS, which is what ranking is.
//
// NON-VACUITY (mandatory, same lesson)
// A fence that matches nothing and reports success is worse than no fence.
// Three floors must hold or the run FAILS: the scan must find at least
// MIN_FILES files reading `ownerships`, at least MIN_QUERIES query sites, and
// at least MIN_SUBJECT of those must be single-row reads under `ended_at IS
// NULL` — the population the rule is about. If a refactor renames the table
// symbol or changes the query idiom, these trip instead of the fence quietly
// passing over a corpus it can no longer see.
//
// KNOWN LIMITS — stated, not hidden:
//   · REGEX/SCANNER, NOT AST, like all 59 sibling linters. The statement slice
//     is found by a depth-aware walk in both directions — and that walk has been
//     wrong twice, in both directions, each time producing a plausible verdict:
//     once it cut the `.select({…})` projection off (every existence probe read
//     as unprojected), once it walked back past whole `if (…) { … }` blocks and
//     dragged an unrelated `const [x] = …limit(1)` into a query that reads ALL
//     rows. Both are pinned by the slicer case in the test file.
//   · A query broken across statements (`const q = db.select()…; const [row] =
//     await q.limit(1);`) is read as two fragments and the `.limit(1)` half
//     carries no `ownerships` marker. No occurrence exists on this tree; it
//     would be a MISS, never a false alarm.
//   · The role predicate is recognised by shape, not by meaning. A query that
//     mentions `ownerships.role` only in its SELECT projection does not exempt
//     itself — deliberately, since projecting a column is not filtering on it.
//   · An aliased table (`ownerships as o`) is invisible. Not used on this tree.
//
// Run: pnpm tsx scripts/check-titular-row-resolution.ts
//      (or: pnpm lint:titular-row)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { stripComments } from "./lib/strip-comments.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const SCAN_ROOTS = ["app", "lib", "src", "scripts", "db"];

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "__tests__",
  "__mocks__",
  "migrations",
]);

/** Non-vacuity floors. Raise them if the corpus grows; never lower to pass. */
const MIN_FILES = 40;
const MIN_QUERIES = 80;
const MIN_SUBJECT = 10;

/**
 * Documented exceptions: `"<relPath>:<line>"` → reason. EMPTY IS THE GOAL.
 *
 * It was not born empty in spirit: the seven sites this fence exists for were
 * all fixed in the two commits before it, which is why it is green on arrival.
 * A fence green on the tree that motivated it proves nothing on its own — the
 * evidence here is __tests__/check-titular-row-resolution.test.ts, which feeds
 * it each of the seven original shapes and requires it to reject them.
 */
const ALLOWLIST: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function listSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
      if (/\.d\.ts$/.test(entry)) continue;
      out.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

// ---------------------------------------------------------------------------
// Query slicing
// ---------------------------------------------------------------------------

export type QuerySite = {
  relPath: string;
  line: number;
  /** The statement text the query lives in, comments already stripped. */
  text: string;
};

/** 1-based line number of a character offset. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * The statement each `.from(ownerships)` sits in.
 *
 * Bounded by the nearest statement delimiter on each side. A drizzle chain
 * carries no `;` and no bare brace between `db.select(` and `.limit(1)`, so the
 * whole chain — plus the `const [row] =` that receives it — lands in one slice,
 * which is exactly the unit the rule is about.
 */
/**
 * Start of the statement containing `at`, walking backwards at bracket depth 0.
 *
 * NOT `lastIndexOf("{")`. The nearest `{` behind `.from(ownerships)` is the one
 * opening the `.select({ … })` PROJECTION, so the naive boundary sliced the
 * projection off and every existence probe read as an unprojected query. Depth
 * tracking is what tells a block brace from a chain's own.
 */
function statementStart(source: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === ")" || ch === "]") {
      depth++;
      continue;
    }
    // A `}` met at depth 0 is the END of a preceding block — `if (…) { … }` —
    // and therefore a statement boundary. Without this the walk skipped whole
    // blocks looking for a `;` and swallowed every statement back to the top of
    // the enclosing transaction callback, dragging an unrelated
    // `const [targetOrg] = …limit(1)` into the slice and flagging a query that
    // reads ALL rows and ranks them in JS.
    if (ch === "}") {
      if (depth === 0) return i + 1;
      depth++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) return i + 1;
      depth--;
      continue;
    }
    if (ch === ";" && depth === 0) return i + 1;
  }
  return 0;
}

/** End of that statement, walking forwards at bracket depth 0. */
function statementEnd(source: string, at: number): number {
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return i;
      depth--;
      continue;
    }
    if (ch === ";" && depth === 0) return i;
  }
  return source.length;
}

export function ownershipQuerySites(relPath: string, source: string): QuerySite[] {
  const sites: QuerySite[] = [];
  for (const m of source.matchAll(/\.from\(\s*ownerships\s*[),]/g)) {
    const at = m.index ?? 0;
    sites.push({
      relPath,
      line: lineOf(source, at),
      text: source.slice(statementStart(source, at), statementEnd(source, at)),
    });
  }
  return sites;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** Filters out ended rows — the predicate that stopped meaning "one row". */
function filtersActiveOnly(text: string): boolean {
  return /\bisNull\(\s*ownerships\.endedAt\s*\)/.test(text);
}

/** Takes exactly one row and lets the database pick which. */
function takesSingleRow(text: string): boolean {
  if (/\.limit\(\s*1\s*\)/.test(text)) return true;
  // `const [row] = await db.select()…` — the array destructure IS a limit(1)
  // with extra steps, and it is how three of the seven original sites read.
  return /(?:const|let)\s*\[\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\]\s*=/.test(text);
}

/** Constrains the ROLE, by any comparison drizzle offers. */
function constrainsRole(text: string): boolean {
  return /\b(?:eq|ne|inArray|notInArray)\(\s*ownerships\.role\b/.test(text);
}

/**
 * An EXISTENCE PROBE: the projection carries nothing but the row id, so the
 * answer is "is there one", not "which one".
 *
 * This is the shape `count(*)` would take if drizzle made it convenient, and
 * the two occurrences on this tree say so out loud — lookup-for-claim.ts wants
 * "NO active custody of ANY role" and free-claim re-checks the same thing
 * inside its transaction. Narrowing either to `role = 'owner'` would make a
 * refugio's foster-held pet directly claimable by a stranger, which is the
 * exact inversion of what they guard. Recognised by the PROJECTION rather than
 * by path, so the third one is exempt too.
 */
function isExistenceProbe(text: string): boolean {
  const at = text.indexOf(".select(");
  if (at === -1) return false;
  const open = text.indexOf("{", at);
  if (open === -1) return false;
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return false;
  const columns = [...text.slice(open, close).matchAll(/\bownerships\.([A-Za-z_$][\w$]*)/g)].map(
    (m) => m[1],
  );
  return columns.length > 0 && columns.every((c) => c === "id");
}

/** The documented exempt shapes, each with the reason it is not the subject. */
function exemptReason(text: string): string | null {
  if (isExistenceProbe(text)) {
    return "existence probe (projects only ownerships.id — asks whether one exists)";
  }
  if (/\b(?:eq|inArray)\(\s*ownerships\.ownerUserId\b/.test(text)) {
    return "caller-scoped (bound to a specific user id)";
  }
  if (/\b(?:eq|inArray)\(\s*ownerships\.ownerOrganizationId\b/.test(text)) {
    return "org-scoped (bound to a specific organisation id)";
  }
  if (/\beq\(\s*ownerships\.id\b/.test(text)) {
    return "by-ownership-id (the row is already chosen)";
  }
  if (/\bcount\s*\(|\bexists\s*\(/.test(text)) {
    return "count/EXISTS (asks how many, not which)";
  }
  return null;
}

export function findOffenders(sites: QuerySite[]): string[] {
  const offenders: string[] = [];
  for (const site of sites) {
    if (!filtersActiveOnly(site.text)) continue;
    if (!takesSingleRow(site.text)) continue;
    if (constrainsRole(site.text)) continue;
    if (exemptReason(site.text) !== null) continue;
    const key = `${site.relPath}:${site.line}`;
    if (ALLOWLIST[key] !== undefined) continue;
    offenders.push(
      [
        `${key} resolves ONE ownership row from (pet_id, ended_at IS NULL) with no role predicate.`,
        "    Since custodia-temporal that predicate matches the caretaker row too, so Postgres picks",
        "    by heap order and this reads whichever holder it feels like. If the site PUBLISHES the",
        "    titular's identity or contact, add eq(ownerships.role, 'owner') and a deterministic",
        "    orderBy. If it ROUTES A MESSAGE, use resolveLostPetAlertRecipients (lib/infra/",
        "    pet-alert-recipients.ts) instead — a role filter there turns a mis-routed alert into no",
        "    alert for a pet in shelter custody, which has no owner row at all. If the read is",
        "    legitimately exempt, say which shape it is in ALLOWLIST with the reason.",
      ].join("\n"),
    );
  }
  return offenders.sort();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

type Corpus = { sites: QuerySite[]; files: Set<string> };

function scanCorpus(): Corpus {
  const sites: QuerySite[] = [];
  const files = new Set<string>();
  for (const full of listSourceFiles()) {
    const raw = readFileSync(full, "utf8");
    if (!raw.includes("ownerships")) continue;
    const relPath = relative(REPO_ROOT, full).split(sep).join("/");
    // This fence's own source names every marker it looks for.
    if (relPath === "scripts/check-titular-row-resolution.ts") continue;
    const found = ownershipQuerySites(relPath, stripComments(raw) as string);
    if (found.length === 0) continue;
    files.add(relPath);
    sites.push(...found);
  }
  return { sites, files };
}

function main(): void {
  const { sites, files } = scanCorpus();
  const subject = sites.filter((s) => filtersActiveOnly(s.text) && takesSingleRow(s.text));
  const problems: string[] = [];

  if (files.size < MIN_FILES) {
    problems.push(
      `NON-VACUITY: found ownerships queries in only ${files.size} file(s) (floor ${MIN_FILES}). Discovery is broken.`,
    );
  }
  if (sites.length < MIN_QUERIES) {
    problems.push(
      `NON-VACUITY: found only ${sites.length} ownerships query site(s) (floor ${MIN_QUERIES}).`,
    );
  }
  if (subject.length < MIN_SUBJECT) {
    problems.push(
      `NON-VACUITY: only ${subject.length} single-row active-ownership read(s) in the corpus (floor ${MIN_SUBJECT}). The rule's own population has vanished — the slicer or the predicates stopped matching.`,
    );
  }

  problems.push(...findOffenders(sites));

  const tally = `${files.size} file(s), ${sites.length} ownerships query site(s), ${subject.length} single-row active read(s), ${Object.keys(ALLOWLIST).length} allowlisted.`;

  if (problems.length > 0) {
    console.error("\ntitular-row resolution fence — FAILED\n");
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`\n${tally}\n`);
    process.exit(1);
  }
  console.log(`✓ titular-row resolution clean — ${tally}`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-titular-row-resolution.ts") ||
    process.argv[1].endsWith("check-titular-row-resolution.js"));

if (isMain) main();
