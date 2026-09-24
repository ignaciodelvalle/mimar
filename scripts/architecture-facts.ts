// Architecture facts generator.
//
// Writes `docs/architecture/facts.json`: every NUMBER the architecture docs
// quote about this repository, each one carrying the path it came from and the
// method used to get it. Run:
//
//   pnpm facts:write
//
// WHY THIS EXISTS. A number written into prose is a claim with no owner. It is
// true the day it is typed and silently false a month later, and nothing in the
// tree notices — AGENTS.md said "48 event types" while `EVENT_TYPES` held 55,
// and the git history shows the same line lagging at 23, 39, 45 and 47 before
// that. Docs cite these facts as `<!-- fact:key -->N<!-- /fact -->` markers and
// `__tests__/architecture-facts.test.ts` fails when a marker and this file
// disagree, or when this file and the tree disagree.
//
// TWO RULES THIS FILE OBEYS.
//
//  1. IMPORT, DO NOT REGEX. Where the thing being counted exists as an
//     exported constant, the count is `CONSTANT.length` from a real import.
//     The 60-vs-55 event-count bug came from a regex over quoted strings in a
//     file that also contained a deprecation list; the array was importable the
//     whole time. Every regex left in here is a regex because no constant
//     exists, and its `method` says so out loud.
//  2. NEVER INVENT. A number that cannot be sourced honestly is OMITTED, not
//     estimated. `rls_policies` and `triggers` are absent for exactly this
//     reason — see the note at the bottom of this file.
//
// DB-LESS BY CONSTRUCTION. Everything imported here is a pure constant module.
// `computeFacts()` touches the filesystem and nothing else, so the test can
// recompute the whole file in-process without shelling out or opening a socket.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EVENT_TYPES } from "@dim/contract/events";

import { discoverTestFiles } from "@/__tests__/db-reachability";
import { ORGANIZATION_CAPABILITIES } from "@/db/schema";
import { DAILY_JOB_ORDER } from "@/lib/infra/cron-dispatcher";
import { OPERATOR_SHIFT_MS } from "@/lib/infra/operator-shift";
import { ANONYMITY_K } from "@/lib/metrics/anonymity";
import { KPI_CATALOG_LIST } from "@/lib/metrics/kpi-catalog";
import { CREDENTIAL_TOKEN_PREFIXES } from "@/lib/observability/redact";
import { WELFARE_REPORT_KINDS } from "@/src/modules/welfare/domain/types";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const FACTS_JSON = "docs/architecture/facts.json";

export type Fact = {
  /** The number itself. */
  value: number;
  /** Repo path(s) the number comes from. */
  source: string;
  /** HOW it was counted, precisely enough to reproduce or refute. */
  method: string;
};

export type FactsFile = {
  generatedAt: string;
  /** HEAD at generation time — necessarily the PARENT of the commit carrying
   *  this file. See `headSha` for why, and why no fence can pin it. */
  sha: string;
  facts: Record<string, Fact>;
};

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

const SKIP = new Set(["node_modules", ".next", ".git", ".turbo", "dist", "coverage"]);

/** Every file under `rel` (recursively) for which `pred(name)` holds. */
function filesUnder(root: string, rel: string, pred: (name: string) => boolean): string[] {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  const acc: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (SKIP.has(ent.name)) continue;
        walk(join(dir, ent.name), `${prefix}/${ent.name}`);
      } else if (pred(ent.name)) acc.push(`${prefix}/${ent.name}`);
    }
  };
  walk(abs, rel);
  return acc.sort();
}

/** Immediate subdirectories of `rel`. */
function dirsIn(root: string, rel: string): string[] {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

const readText = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

/** Occurrences of `needle` in `haystack` (literal, non-overlapping). */
function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Exactly one capture, or throw.
 *
 * A generator that quietly picks the first of several matches is how a wrong
 * number gets a `source` and a `method` and becomes believable. If the shape of
 * the file changes under a regex, this stops the run instead.
 */
function theOnlyMatch(text: string, re: RegExp, what: string): string {
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1) {
    throw new Error(
      `architecture-facts: expected exactly 1 match for ${what}, found ${hits.length}`,
    );
  }
  return hits[0][1];
}

// ---------------------------------------------------------------------------
// SQL scanning
// ---------------------------------------------------------------------------

/**
 * The DB declaration surface, in application order: the bootstrap `db/*.sql`
 * files first, then `db/migrations/*.sql` in numeric order. Both are real —
 * `db/rls.sql` and friends declare policies that migrations later alter, so
 * scanning only `db/migrations` reads half the story.
 */
function sqlSurface(root: string): string[] {
  const all = filesUnder(root, "db", (n) => n.endsWith(".sql"));
  return [
    ...all.filter((f) => !f.includes("/migrations/")),
    ...all.filter((f) => f.includes("/migrations/")),
  ];
}

/** SQL with `--` line comments and block comments removed. */
const stripSqlComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** A bare or `public.`-qualified SQL identifier, lowercased and unquoted. */
const SQL_IDENT = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
const normIdent = (raw: string): string =>
  raw
    .replace(/"/g, "")
    .replace(/;$/, "")
    .toLowerCase()
    .replace(/^public\./, "");

/**
 * One pass over the whole SQL surface, collecting the two things that can be
 * counted honestly there. Extracted from `computeFacts` so that function stays
 * a readable list of facts rather than a parser with facts mixed in.
 */
function scanSqlSurface(repoRoot: string): {
  rlsTables: Set<string>;
  securityDefiner: Set<string>;
} {
  const rlsTables = new Set<string>();
  const securityDefiner = new Set<string>();
  for (const rel of sqlSurface(repoRoot)) {
    const sql = stripSqlComments(readText(repoRoot, rel));
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w".]+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
    )) {
      const t = normIdent(m[1]);
      if (SQL_IDENT.test(t)) rlsTables.add(t);
    }
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w".]+)\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
    )) {
      rlsTables.delete(normIdent(m[1]));
    }
    for (const m of sql.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w".]+)\s*\(([\s\S]*?)\$\$/gi,
    )) {
      const n = normIdent(m[1]);
      const header = m[2];
      const nested = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i.test(header);
      if (!nested && /SECURITY\s+DEFINER/i.test(header) && SQL_IDENT.test(n))
        securityDefiner.add(n);
    }
    for (const m of sql.matchAll(/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\w".]+)/gi)) {
      securityDefiner.delete(normIdent(m[1]));
    }
  }
  return { rlsTables, securityDefiner };
}

/**
 * Calls to the service-role Supabase factory, which bypasses RLS by design.
 *
 * The needle is assembled at runtime so THIS file does not contain the string it
 * searches for. Written as one literal it counted its own two mentions and
 * reported 36 where the tree has 34 — a scanner that scans itself is a scanner
 * that lies.
 */
function serviceRoleCallSites(repoRoot: string): number {
  const ADMIN_FACTORY = "lib/supabase/admin.ts";
  const needle = `${"createAdminClient"}(`;
  let n = 0;
  for (const dir of ["app", "src", "lib", "scripts"]) {
    for (const rel of filesUnder(repoRoot, dir, (name) => /\.tsx?$/.test(name))) {
      if (rel === ADMIN_FACTORY) continue;
      n += occurrences(readText(repoRoot, rel), needle);
    }
  }
  return n;
}

/** The signed-URL TTL, asserted to be the same for both attachment kinds. */
function signedUrlTtlSeconds(repoRoot: string): number {
  const storage = readText(repoRoot, "lib/infra/storage.ts");
  const numeric = (raw: string): number => Number(raw.replace(/_/g, ""));
  const eventTtl = numeric(
    theOnlyMatch(
      storage,
      /EVENT_ATTACHMENT_URL_TTL_SECONDS\s*=\s*(\d[\d_]*)/g,
      "the event attachment TTL",
    ),
  );
  const welfareTtl = numeric(
    theOnlyMatch(
      storage,
      /WELFARE_ATTACHMENT_URL_TTL_SECONDS\s*=\s*(\d[\d_]*)/g,
      "the welfare attachment TTL",
    ),
  );
  if (eventTtl !== welfareTtl) {
    throw new Error(
      `architecture-facts: the two signed-URL TTLs have diverged (event=${eventTtl}s, welfare=${welfareTtl}s). \`signed_url_ttl_seconds\` is one key because they agreed; split it rather than picking one.`,
    );
  }
  return eventTtl;
}

// ---------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------

export function computeFacts(repoRoot: string = REPO_ROOT): Record<string, Fact> {
  const facts: Record<string, Fact> = {};
  const put = (key: string, value: number, source: string, method: string): void => {
    facts[key] = { value, source, method };
  };

  // --- Contract ------------------------------------------------------------

  put(
    "event_types",
    EVENT_TYPES.length,
    "packages/contract/src/events/event-types.ts",
    "EVENT_TYPES.length, imported. `db/schema.ts:289` re-exports the same array from `@dim/contract/events`, and that re-export is what `__tests__/event-catalog-count.test.ts` imports — so this is the identical array the catalog fence counts, reached without pulling Drizzle into this script.",
  );

  // --- The gate chain ------------------------------------------------------

  const pkg = JSON.parse(readText(repoRoot, "package.json")) as { scripts: Record<string, string> };
  const lintKeys = Object.keys(pkg.scripts).filter((k) => k.startsWith("lint:"));
  const verifyLintSteps = new Set(
    [...pkg.scripts.verify.matchAll(/pnpm (lint:[\w-]+)/g)].map((m) => m[1]),
  );

  put(
    "verify_fences",
    verifyLintSteps.size,
    "package.json (the `verify` script string)",
    "distinct `pnpm lint:<key>` tokens matched by /pnpm (lint:[\\w-]+)/g inside the `verify` script string. Counts the fence STEPS only: `pnpm lint` (Biome), `pnpm typecheck`, `pnpm verify:mobile` and `pnpm build` are also in the chain and are not counted here.",
  );
  put(
    "lint_scripts",
    lintKeys.length,
    "package.json (`scripts`)",
    "keys in `scripts` starting with `lint:`. Compare against `verify_fences`: a lint key that exists but is absent from `verify` is a fence nothing runs — `pnpm lint:ci-parity` is what keeps the two in step.",
  );
  put(
    "check_scripts",
    filesUnder(repoRoot, "scripts", (n) => /^check-.*\.ts$/.test(n)).length,
    "scripts/check-*.ts",
    "files in `scripts/` matching /^check-.*\\.ts$/. Three sibling fences are written in plain JS (`check-raw-buttons.mjs`, `check-raw-select.mjs`, `check-op-controls.mjs`) and are deliberately NOT in this count, which is about the TypeScript fence corpus.",
  );

  // --- Application shape ---------------------------------------------------

  put(
    "modules",
    dirsIn(repoRoot, "src/modules").length,
    "src/modules/",
    "immediate subdirectories of `src/modules/`.",
  );
  put(
    "pages",
    filesUnder(repoRoot, "app", (n) => n === "page.tsx").length,
    "app/**/page.tsx",
    "files named exactly `page.tsx` anywhere under `app/`.",
  );
  put(
    "route_handlers",
    filesUnder(repoRoot, "app", (n) => n === "route.ts").length,
    "app/**/route.ts",
    "files named exactly `route.ts` anywhere under `app/`.",
  );
  put(
    "layouts",
    filesUnder(repoRoot, "app", (n) => n === "layout.tsx").length,
    "app/**/layout.tsx",
    "files named exactly `layout.tsx` anywhere under `app/`.",
  );

  // --- Database ------------------------------------------------------------

  put(
    "migrations",
    filesUnder(repoRoot, "db/migrations", (n) => n.endsWith(".sql")).length,
    "db/migrations/*.sql",
    "files ending in `.sql` under `db/migrations/`. Migrations are forward-only and immutable, so this only ever grows.",
  );

  const schema = readText(repoRoot, "db/schema.ts");
  put(
    "tables",
    occurrences(schema, "pgTable("),
    "db/schema.ts",
    "literal occurrences of `pgTable(` in `db/schema.ts`. A call-site count, not an import: Drizzle table objects are not collected into any exported registry, so there is nothing to take `.length` of.",
  );
  put(
    "enums",
    occurrences(schema, "pgEnum("),
    "db/schema.ts",
    "literal occurrences of `pgEnum(` in `db/schema.ts`. Same caveat as `tables` — a call-site count for want of a registry.",
  );

  const { rlsTables, securityDefiner } = scanSqlSurface(repoRoot);

  put(
    "rls_enabled_tables",
    rlsTables.size,
    "db/*.sql + db/migrations/*.sql (declared); the LIVE truth is `__tests__/rls/*`, which reads `pg_class.relrowsecurity`",
    "distinct table names matched by /ALTER TABLE … ENABLE ROW LEVEL SECURITY/i over the whole SQL surface with comments stripped, minus any later DISABLE (there are none at this snapshot). This is the DECLARED count. It is not the number of tables — a table can exist without RLS — and it is not a live catalog reading.",
  );
  put(
    "security_definer_functions",
    securityDefiner.size,
    "db/*.sql + db/migrations/*.sql (declared); the LIVE truth is `__tests__/rls/*`",
    "distinct function names whose `CREATE [OR REPLACE] FUNCTION … $$` header carries `SECURITY DEFINER`, over the whole SQL surface with comments stripped, minus any `DROP FUNCTION` by name. Declared, not read from `pg_proc`.",
  );

  // --- Scheduled work ------------------------------------------------------

  put(
    "cron_route_dirs",
    dirsIn(repoRoot, "app/api/cron").length,
    "app/api/cron/*/",
    "immediate subdirectories of `app/api/cron/`. Higher than `cron_jobs`: some routes are standalone Vercel crons and some are invoked only by the daily dispatcher.",
  );
  const vercel = JSON.parse(readText(repoRoot, "vercel.json")) as { crons?: unknown[] };
  put(
    "vercel_crons_declared",
    vercel.crons?.length ?? 0,
    "vercel.json",
    "length of the `crons` array. Only these are scheduled BY VERCEL; every other job runs because `/api/cron/daily` fans out to it.",
  );
  put(
    "cron_jobs",
    DAILY_JOB_ORDER.length,
    "lib/infra/cron-dispatcher.ts",
    "DAILY_JOB_ORDER.length, imported. This is the registry `app/api/cron/daily/route.ts` maps over; the route itself imports `@/db` and cannot be loaded here, but the registry module has zero imports.",
  );

  // --- CI and the test corpus ----------------------------------------------

  put(
    "ci_workflows",
    filesUnder(repoRoot, ".github/workflows", (n) => n.endsWith(".yml")).length,
    ".github/workflows/*.yml",
    "files ending in `.yml` under `.github/workflows/`. There are no `.yaml` files at this snapshot; if one is added it will not be counted until this method changes.",
  );
  put(
    "vitest_files",
    discoverTestFiles().length,
    "vitest.config.ts -> __tests__/db-reachability.ts",
    "discoverTestFiles().length, imported from the SAME module `vitest.config.ts` feeds into its `include` globs via computeTestPartition(). It walks the repo for /\\.test\\.tsx?$/ skipping node_modules, .next, .git, .claude, apps and e2e — so this is exactly the file set Vitest runs, not an independent glob that could drift from it.",
  );
  put(
    "e2e_specs",
    filesUnder(repoRoot, "e2e", (n) => n.endsWith(".spec.ts")).length,
    "e2e/**/*.spec.ts",
    "files ending in `.spec.ts` under `e2e/`. Playwright's own `testIgnore` drops `demo/**` and `perf/**` at run time, so fewer than this actually run in the default project.",
  );
  put(
    "mobile_jest_files",
    filesUnder(repoRoot, "apps/mobile/src", (n) => /\.test\.tsx?$/.test(n)).length,
    "apps/mobile/src/**/*.test.ts(x)",
    "files matching /\\.test\\.tsx?$/ under `apps/mobile/src/`. A separate runner (jest-expo) from the Vitest corpus — `db-reachability.ts` skips `apps/` for exactly that reason.",
  );

  // --- Domain constants ----------------------------------------------------

  put(
    "org_capabilities",
    ORGANIZATION_CAPABILITIES.length,
    "db/schema.ts",
    "ORGANIZATION_CAPABILITIES.length, imported. The UI-facing `CAPABILITY_CATALOG` in `src/modules/organizations/domain/capabilities.ts` describes a SUBSET and is deliberately not the number quoted here.",
  );
  put(
    "kpi_descriptors",
    KPI_CATALOG_LIST.length,
    "lib/metrics/kpi-catalog.ts",
    "KPI_CATALOG_LIST.length, imported — `Object.values(KPI_CATALOG)`, which merges the queue and compliance sub-catalogs.",
  );
  put(
    "k_anonymity_k",
    ANONYMITY_K,
    "lib/metrics/anonymity.ts",
    "the exported ANONYMITY_K constant, imported. A threshold, not a count: cells with fewer than K subjects are suppressed.",
  );
  put(
    "token_prefixes",
    CREDENTIAL_TOKEN_PREFIXES.length,
    "lib/observability/redact.ts",
    "CREDENTIAL_TOKEN_PREFIXES.length, imported. This array is a hand-maintained mirror of the prefixes `lib/infra/publicToken.ts` generates (that module imports `node:crypto` and exports no prefix list); `lib/observability/redact-prefix-coverage.test.ts` re-derives the true set and fails on drift, so the mirror is fenced rather than trusted.",
  );
  put(
    "denuncia_kinds",
    WELFARE_REPORT_KINDS.length,
    "src/modules/welfare/domain/types.ts",
    "WELFARE_REPORT_KINDS.length, imported. The same array the `denuncias/nueva` step-1 form maps over.",
  );
  put(
    "operator_shift_hours",
    OPERATOR_SHIFT_MS / 3_600_000,
    "lib/infra/operator-shift.ts",
    "OPERATOR_SHIFT_MS imported and divided by 3_600_000. The constant is declared in milliseconds; this key is the hours a human would say.",
  );

  const throttle = readText(repoRoot, "lib/infra/public-token-throttle.ts");
  const throttleBlock = theOnlyMatch(
    throttle,
    /PUBLIC_TOKEN_READ_LIMIT[^=]*=\s*(\{[^}]*\})/g,
    "the PUBLIC_TOKEN_READ_LIMIT object literal",
  );
  const numeric = (raw: string): number => Number(raw.replace(/_/g, ""));
  put(
    "throttle_per_min",
    numeric(theOnlyMatch(throttleBlock, /maxPerMinute:\s*([\d_]+)/g, "maxPerMinute")),
    "lib/infra/public-token-throttle.ts",
    "`maxPerMinute` read out of the PUBLIC_TOKEN_READ_LIMIT object literal by regex. NOT imported: the module also imports `next/headers`, so it cannot be loaded outside a request. The regex demands exactly one match for the literal and one for the field, and throws otherwise.",
  );
  put(
    "throttle_per_hour",
    numeric(theOnlyMatch(throttleBlock, /maxPerHour:\s*([\d_]+)/g, "maxPerHour")),
    "lib/infra/public-token-throttle.ts",
    "`maxPerHour` read out of the PUBLIC_TOKEN_READ_LIMIT object literal by regex, same reason and same exactly-one-match guard as `throttle_per_min`.",
  );

  put(
    "signed_url_ttl_seconds",
    signedUrlTtlSeconds(repoRoot),
    "lib/infra/storage.ts",
    "EVENT_ATTACHMENT_URL_TTL_SECONDS and WELFARE_ATTACHMENT_URL_TTL_SECONDS read by regex — neither is exported, so neither can be imported. The generator asserts the two agree and refuses to emit a single number if they ever diverge.",
  );

  const projectionFiles = filesUnder(
    repoRoot,
    "lib/projections",
    (n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "types.ts",
  );
  put(
    "projections",
    projectionFiles.length,
    "lib/projections/",
    "non-test `.ts` files under `lib/projections/`, excluding the shared `types.ts`. A FILE count, and the only key here that is not backed by either an import or a declaration site: there is no projection registry to import — `scripts/rebuild-projections.ts` names each replay function individually — so adding a projection module without wiring it into the rebuilder would still move this number.",
  );

  // --- Service-role reach --------------------------------------------------

  put(
    "service_role_call_sites",
    serviceRoleCallSites(repoRoot),
    "app/**, src/**, lib/**, scripts/** (excluding lib/supabase/admin.ts)",
    "literal occurrences of the service-role factory's name followed by `(` in `.ts`/`.tsx` files under those four trees, excluding the factory's own module. The trailing paren is what makes this a CALL count and not an import count — an `import { … } from` line has no paren. The needle is concatenated at runtime so this generator does not match itself. Every one of these bypasses RLS by design.",
  );

  // --- The conventions canon ----------------------------------------------

  const canon = JSON.parse(readText(repoRoot, "docs/architecture/conventions-canon.json")) as {
    rows: { status: string }[];
  };
  const byStatus = (status: string): number => canon.rows.filter((r) => r.status === status).length;
  const CANON_SOURCE = "docs/architecture/conventions-canon.json";
  const CANON_METHOD =
    "counted over `rows[]` in the canon JSON, which is the source of truth its markdown is rendered from. The same four numbers appear as `fact:` markers in `docs/architecture/conventions-canon.md` and are cross-checked there by `__tests__/conventions-canon-parity.test.ts`.";
  put("canon_rows", canon.rows.length, CANON_SOURCE, `total rows — ${CANON_METHOD}`);
  put(
    "canon_enforced",
    byStatus("ENFORCED"),
    CANON_SOURCE,
    `rows with status ENFORCED — ${CANON_METHOD}`,
  );
  put(
    "canon_partial",
    byStatus("PARTIAL"),
    CANON_SOURCE,
    `rows with status PARTIAL — ${CANON_METHOD}`,
  );
  put(
    "canon_unenforced",
    byStatus("UNENFORCED"),
    CANON_SOURCE,
    `rows with status UNENFORCED — ${CANON_METHOD}`,
  );

  // --- DELIBERATELY ABSENT -------------------------------------------------
  //
  // `rls_policies` and `triggers`. Both were specified and both are OMITTED,
  // because the net-of-CREATE/DROP arithmetic the other DB keys use does not
  // survive contact with this tree. Measured at d7dbf25f7 over the whole SQL
  // surface: 159 `CREATE POLICY` against 192 `DROP POLICY`, and 15
  // `CREATE TRIGGER` against 16 `DROP TRIGGER`. The drops outnumber the
  // creates because `DROP … IF EXISTS` is used defensively — re-run guards,
  // renames, and drops aimed at objects created under a different name or in a
  // form this scan does not match — so subtracting them yields 5 policies and 0
  // triggers, which is not merely imprecise, it is false. The live catalog is
  // the only honest source for these two, and reading it needs a database that
  // this generator deliberately does not have. Better absent than invented.

  return facts;
}

// ---------------------------------------------------------------------------

/**
 * The short SHA of HEAD at GENERATION time, or "unknown" outside a git
 * checkout.
 *
 * READ IT AS THE PARENT, and that is structural rather than a slip. `pnpm
 * facts:write` runs BEFORE the commit that carries the file it writes, so the
 * sha it records can never be the sha of that commit — it is the tree the
 * counts were computed from, plus whatever working-tree changes were committed
 * alongside them. Every facts.json this repo has ever committed has that same
 * off-by-one-commit relationship; it is not drift.
 *
 * Consequently there is no fence to write here: an assertion that `sha` equals
 * HEAD would be unsatisfiable by construction, and one that it equals HEAD's
 * parent would fail on any commit that did not regenerate the facts. The
 * instrument for this field is this comment.
 */
function headSha(repoRoot: string): string {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

export function buildFactsFile(repoRoot: string = REPO_ROOT): FactsFile {
  return {
    generatedAt: new Date().toISOString().slice(0, 10),
    sha: headSha(repoRoot),
    facts: computeFacts(repoRoot),
  };
}

function main(): void {
  const file = buildFactsFile(REPO_ROOT);
  writeFileSync(join(REPO_ROOT, FACTS_JSON), `${JSON.stringify(file, null, 2)}\n`, "utf8");
  const keys = Object.keys(file.facts);
  for (const k of keys.sort()) console.log(`  ${k} = ${file.facts[k].value}`);
  console.log(`✓ wrote ${FACTS_JSON} — ${keys.length} facts at ${file.sha}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
