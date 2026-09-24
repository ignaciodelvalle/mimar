// Conventions-canon renderer.
//
// `docs/architecture/conventions-canon.json` is the SOURCE OF TRUTH for the
// project's convention canon: 512 rules harvested from the repo's own prose and
// classified against the enforcer that can actually fail on each one. This
// script renders the human-readable view of that file.
//
// The markdown is NOT hand-edited and NOT part of `pnpm verify`. Run:
//
//   pnpm canon:render
//
// `__tests__/conventions-canon-parity.test.ts` pins the two together BYTE FOR
// BYTE: it re-runs this renderer in-process and compares every rendered file
// against the one on disk. Editing the markdown by hand turns that test red —
// which is the point. Change the JSON, re-render.
//
// The output is split ONE FILE PER SCOPE (plus an index) rather than one giant
// document. Nothing in `pnpm verify` fences the size of a markdown file — the
// file-size ratchet globs `{app,components,lib,packages,src}/**/*.{ts,tsx}`
// (scripts/check-file-size.ts:45) and jscpd's corpus is `["app","components",
// "lib","src"]` (jscpd.json:2) — but the single-file render measures ~490 KB,
// which is past the point where GitHub stops rendering a blob and past the point
// where anyone can read it. The split is a legibility decision, stated here so
// nobody mistakes it for a fence requirement.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");

export const CANON_JSON = "docs/architecture/conventions-canon.json";
export const CANON_INDEX = "docs/architecture/conventions-canon.md";
export const CANON_SCOPE_DIR = "docs/architecture/conventions-canon";
export const FACTS_JSON = "docs/architecture/facts.json";

/**
 * The date the header states, read from `facts.json` rather than hardcoded.
 *
 * A date typed into this file is a number with no owner: it stays at whatever
 * the last editor believed while the facts it claims to date move underneath
 * it. Read it from the artifact it describes, and FAIL when that artifact is
 * missing or dateless — a render that invents a date is worse than no render.
 */
export function factsGeneratedAt(repoRoot: string = REPO_ROOT): string {
  const abs = join(repoRoot, FACTS_JSON);
  if (!existsSync(abs)) {
    throw new Error(`${FACTS_JSON} does not exist — run \`pnpm facts:write\` before rendering.`);
  }
  const { generatedAt } = JSON.parse(readFileSync(abs, "utf8")) as { generatedAt?: unknown };
  if (typeof generatedAt !== "string" || generatedAt.trim() === "") {
    throw new Error(`${FACTS_JSON} has no \`generatedAt\` — the canon header will not invent one.`);
  }
  return generatedAt;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanonRow = {
  id: string;
  rule: string;
  scope: string;
  sources?: string[];
  enforcer?: string[];
  enforcementKind?: string;
  wired?: string;
  status: string;
  partialShape?: string;
  clause?: string;
  statusBasis?: string;
  notes?: string;
  confidence?: number;
  numberKey?: string;
  verifiedAt: string;
};

export type Canon = {
  sha: string;
  generatedFrom: string;
  provenance?: string;
  rules: Record<string, string>;
  adoptionConvention: string;
  calibration: {
    sampled: number;
    perBand: number;
    disagreements: number;
    dissent: { id: string; canonSays: string; blindReaderSaid: string; resolution: string }[];
  };
  stats: { rows: number; byStatus: Record<string, number> };
  rows: CanonRow[];
  recommendations: Record<string, unknown>[];
  violatedLive: Record<string, unknown>[];
  contradictions: Record<string, unknown>[];
  merged: Record<string, unknown>[];
  unmapped: { kind: string; id: string; path: string | null; note?: string }[];
};

// ---------------------------------------------------------------------------
// Shared helpers (also imported by the parity fence)
// ---------------------------------------------------------------------------

/**
 * Reduce one `enforcer[]` citation to the repo-relative path it names.
 *
 * Citations come in four shapes and all four have to survive a round trip:
 *   `scripts/check-x.ts`                    -> scripts/check-x.ts
 *   `scripts/check-x.ts:51,79-82,91`        -> scripts/check-x.ts
 *   `biome.json:67-88 (domain overrides)`   -> biome.json
 *   `docs/x.md#some-anchor`                 -> docs/x.md
 */
export function enforcerPath(entry: string): string {
  const head = entry.trim().split(/\s+/)[0] ?? "";
  return head.split("#")[0].replace(/:[\d,\s-]*$/, "");
}

/** The `:line` / `:line-line` / `:a,b-c` suffix of a citation, or "". */
export function enforcerLines(entry: string): string {
  const head = entry.trim().split(/\s+/)[0] ?? "";
  const m = /:([\d,-]+)$/.exec(head.split("#")[0]);
  return m ? m[1] : "";
}

/** Whatever follows the path in a citation — a human annotation, kept verbatim. */
export function enforcerNote(entry: string): string {
  const parts = entry.trim().split(/\s+/);
  return parts.slice(1).join(" ");
}

/** `PARTIAL (subset)` when a shape exists, otherwise the bare status. */
export function statusLabel(row: Pick<CanonRow, "status" | "partialShape">): string {
  return row.partialShape ? `${row.status} (${row.partialShape})` : row.status;
}

/** Make a value safe inside a one-line markdown table cell. */
export function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/** Human title for a scope key. */
const SCOPE_TITLES: Record<string, string> = {
  contract: "Contract (`packages/contract`)",
  db: "Database, RLS and the event spine",
  docs: "Documentation",
  e2e: "End-to-end (Playwright)",
  mobile: "Mobile (`apps/mobile`)",
  process: "Process, CI and the gate chain",
  web: "Web application",
};

const scopeTitle = (scope: string): string => SCOPE_TITLES[scope] ?? scope;
const scopeFile = (scope: string): string => `${CANON_SCOPE_DIR}/${scope}.md`;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function headerBlock(canon: Canon, verifiedOn: string): string {
  return [
    `> Snapshot: \`${canon.sha}\` (\`main\`) · Facts: \`${FACTS_JSON}\` generated ${verifiedOn}`,
    `> Verified against code on ${verifiedOn} by canon v4 + blind calibration · Status: reviewed`,
    "> Numbers in this file are `<!-- fact:key -->` markers checked by `__tests__/architecture-facts.test.ts`.",
  ].join("\n");
}

function fact(key: string, value: number): string {
  return `<!-- fact:${key} -->${value}<!-- /fact -->`;
}

function howItWasBuilt(canon: Canon): string {
  const { calibration } = canon;
  const d = calibration.dissent[0];
  return [
    "## How this canon was built",
    "",
    "The rows were harvested from the prose the project already writes about itself:",
    "`AGENTS.md`, `CLAUDE.md`, the fence headers under `scripts/`, the `docs/agents/`",
    "briefs, `docs/architecture/`, `e2e/README.md`, `CONTRIBUTING.md`, and the comment",
    "blocks at the top of the tests. Anything stated as a rule became a candidate row.",
    "",
    "Four stages turned candidates into verdicts:",
    "",
    "1. **Extraction** — every rule-shaped sentence became a row with its source quote,",
    "   its scope, and whatever enforcer the text itself pointed at. Near-duplicates were",
    "   merged only when one row's requirement was fully contained in another's.",
    "2. **Refutation** — each row's cited enforcer was OPENED and read. The question is",
    '   never "does a fence with a matching name exist" but "can this predicate FAIL on a',
    "   violation of this rule, over this rule's own files\". Rows whose enforcer turned out",
    "   to be a configuration line, a vacuous assertion, or a corpus that excludes the",
    "   rule's own subject were demoted here.",
    "3. **Judgment** — a blind reader re-derived a stratified sample of rows from the",
    "   enforcer alone, without seeing the previous verdict. Bands whose residual error",
    "   exceeded 1 in 6 were sent back whole.",
    "4. **Band re-refutation** — the ENFORCED and PARTIAL bands were re-derived row by row",
    "   under the rulebook below, drafting a verdict before reading the previous basis and",
    "   reconciling only against evidence actually opened.",
    "",
    `**Calibration.** A final blind pass re-derived ${calibration.sampled} sampled rows`,
    `(${calibration.perBand} per status band) and disagreed on`,
    `${calibration.disagreements} of ${calibration.sampled}.`,
    d
      ? `The single dissent is \`${d.id}\`: this canon says **${d.canonSays}**, the blind reader said **${d.blindReaderSaid}**. ${d.resolution}`
      : "",
    "",
    "**The JSON is the source of truth.** `docs/architecture/conventions-canon.json`",
    "carries every field; this file and its per-scope pages are a rendered view produced",
    "by `pnpm canon:render` (`scripts/conventions-canon-render.ts`) and pinned to the JSON",
    "by `__tests__/conventions-canon-parity.test.ts` — one table row per JSON row, same",
    "status, same enforcer set. Hand-editing the markdown turns that fence red. Fix the",
    "JSON and re-render instead.",
    "",
    "**What a verdict is not.** `ENFORCED` means something in the tree fails when the rule",
    "is broken. It does not mean the rule is a good rule, that its wording is current, or",
    "that the enforcer covers the rule's intent beyond its literal predicate. `UNENFORCED`",
    "means nothing fails — the rule may still be true today and may still be worth keeping.",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n(?=(##|\*\*|1\.|2\.|3\.|4\.))/g, "\n\n");
}

function rulebook(canon: Canon): string {
  const lines = [
    "## Status rulebook",
    "",
    "How a row earned its verdict, in the order the rules apply:",
    "",
  ];
  for (const [key, text] of Object.entries(canon.rules)) {
    lines.push(`- **${key}** — ${text}`);
  }
  lines.push("");
  lines.push(canon.adoptionConvention);
  return lines.join("\n");
}

function totals(canon: Canon): string {
  const s = canon.stats.byStatus;
  return [
    "## Totals",
    "",
    `${fact("canon_rows", canon.stats.rows)} rules, of which ` +
      `${fact("canon_enforced", s.ENFORCED ?? 0)} are ENFORCED, ` +
      `${fact("canon_partial", s.PARTIAL ?? 0)} PARTIAL and ` +
      `${fact("canon_unenforced", s.UNENFORCED ?? 0)} UNENFORCED.`,
    "",
    "| Scope | Rules | ENFORCED | PARTIAL | UNENFORCED | Page |",
    "| --- | --- | --- | --- | --- | --- |",
  ]
    .concat(
      scopesOf(canon).map((scope) => {
        const rows = canon.rows.filter((r) => r.scope === scope);
        const n = (status: string) => rows.filter((r) => r.status === status).length;
        return `| ${scopeTitle(scope)} | ${rows.length} | ${n("ENFORCED")} | ${n("PARTIAL")} | ${n("UNENFORCED")} | [\`${scope}.md\`](./conventions-canon/${scope}.md) |`;
      }),
    )
    .join("\n");
}

function scopesOf(canon: Canon): string[] {
  return [...new Set(canon.rows.map((r) => r.scope))].sort();
}

function enforcerCell(row: CanonRow): string {
  if (!row.enforcer?.length) return "—";
  return row.enforcer
    .map((e) => {
      const lines = enforcerLines(e);
      const note = enforcerNote(e);
      const path = `\`${enforcerPath(e)}${lines ? `:${lines}` : ""}\``;
      return note ? `${path} ${cell(note)}` : path;
    })
    .join("<br>");
}

function sourceCell(row: CanonRow): string {
  if (!row.sources?.length) return "—";
  return row.sources.map((s) => `\`${cell(s)}\``).join("<br>");
}

function basisCell(row: CanonRow): string {
  const parts: string[] = [];
  if (row.statusBasis) parts.push(cell(row.statusBasis));
  if (row.notes) parts.push(`*${cell(row.notes)}*`);
  return parts.length ? parts.join(" ") : "—";
}

export function renderScopePage(canon: Canon, scope: string, verifiedOn: string): string {
  // Code-unit order, NOT `localeCompare`: the parity fence sorts ids with a bare
  // `.sort()`, and the two disagree on non-ASCII. One id outside [A-Za-z0-9-]
  // would put the render and its fence in different orders forever.
  const rows = canon.rows
    .filter((r) => r.scope === scope)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = (status: string) => rows.filter((r) => r.status === status).length;
  const lines = [
    `# Conventions canon — ${scopeTitle(scope)}`,
    "",
    headerBlock(canon, verifiedOn),
    "",
    `[← canon index](../conventions-canon.md) · scope \`${scope}\` · ${rows.length} rules ` +
      `(${n("ENFORCED")} ENFORCED, ${n("PARTIAL")} PARTIAL, ${n("UNENFORCED")} UNENFORCED).`,
    "",
    "| Id | Rule | Source | Status | Enforcer | Basis |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${cell(row.rule)} | ${sourceCell(row)} | ${statusLabel(row)} | ${enforcerCell(row)} | ${basisCell(row)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function listSection(
  title: string,
  intro: string,
  entries: Record<string, unknown>[],
  fields: string[][],
): string {
  const lines = [`## ${title}`, "", intro, ""];
  if (entries.length === 0) {
    lines.push("_None._", "");
    return lines.join("\n");
  }
  for (const e of entries) {
    const head = String(e.id ?? e.subject ?? "");
    lines.push(`### ${head}`, "");
    for (const [key, label] of fields) {
      const v = e[key];
      if (v === undefined || v === null || v === "") continue;
      lines.push(`- **${label}:** ${cell(Array.isArray(v) ? v.join(", ") : String(v))}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function unmappedSection(canon: Canon): string {
  const lines = [
    "## Unmapped enforcers",
    "",
    "Enforcement machinery that exists in the tree and that NO canon row cites. Every",
    "`lint:*` key in `package.json`, every `scripts/check-*.ts`, every",
    "`__tests__/**/*{fence,parity,coverage}*.test.ts`, and every path listed in the parity",
    "fence's `EXTRA_FENCES` (fences whose FILENAME hides them from that glob) is either",
    "cited by a row's enforcer or listed here. The parity fence pins this list's length",
    "EXACTLY: growing it and shrinking it are both hand edits, and both are reviewable.",
    "",
    `${canon.unmapped.length} unmapped.`,
    "",
  ];
  if (canon.unmapped.length === 0) {
    lines.push("_None._", "");
    return lines.join("\n");
  }
  lines.push("| Kind | Item | Why it is unmapped |", "| --- | --- | --- |");
  for (const u of canon.unmapped) {
    lines.push(`| ${u.kind} | \`${u.id}\` | ${u.note ? cell(u.note) : "—"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderIndex(canon: Canon, verifiedOn: string): string {
  return [
    "# Conventions canon",
    "",
    headerBlock(canon, verifiedOn),
    "",
    "Every convention this repository states about itself, with the answer to the only",
    "question that matters about a convention: **what fails when you break it?**",
    "",
    howItWasBuilt(canon),
    "",
    rulebook(canon),
    "",
    totals(canon),
    "",
    listSection(
      "Recommendations",
      "Rows that are a review's open proposal rather than a rule the tree follows.",
      canon.recommendations,
      [
        ["rule", "Proposal"],
        ["sources", "Source"],
        ["statusBasis", "State on this tree"],
        ["notes", "Note"],
      ],
    ),
    listSection(
      "Live violations",
      "Rules whose text is FALSE on the tree at this snapshot — not merely unenforced.",
      canon.violatedLive,
      [
        ["rule", "Rule"],
        ["scope", "Scope"],
        ["status", "Status"],
        ["evidence", "Evidence"],
      ],
    ),
    listSection(
      "Contradictions",
      "Places where two documents, or a document and the code, say different things.",
      canon.contradictions,
      [
        ["docSays", "The doc says"],
        ["liveValue", "The tree says"],
        ["evidence", "Evidence"],
      ],
    ),
    listSection(
      "Merged rows",
      "Ids folded into another row during extraction. Kept so an old citation still resolves.",
      canon.merged,
      [
        ["into", "Merged into"],
        ["rule", "Rule"],
        ["reason", "Reason"],
      ],
    ),
    unmappedSection(canon),
  ].join("\n");
}

/** Every rendered file, as repo-relative path -> content. */
export function renderCanon(
  canon: Canon,
  verifiedOn: string = factsGeneratedAt(),
): Map<string, string> {
  const out = new Map<string, string>();
  out.set(
    CANON_INDEX,
    `${renderIndex(canon, verifiedOn)
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()}\n`,
  );
  for (const scope of scopesOf(canon)) {
    out.set(scopeFile(scope), `${renderScopePage(canon, scope, verifiedOn).trimEnd()}\n`);
  }
  return out;
}

export function loadCanon(repoRoot: string = REPO_ROOT): Canon {
  return JSON.parse(readFileSync(join(repoRoot, CANON_JSON), "utf8")) as Canon;
}

function main(): void {
  const canon = loadCanon();
  const files = renderCanon(canon);
  mkdirSync(join(REPO_ROOT, CANON_SCOPE_DIR), { recursive: true });
  for (const [rel, content] of files) {
    writeFileSync(join(REPO_ROOT, rel), content, "utf8");
    console.log(`  ${rel} — ${(Buffer.byteLength(content) / 1024).toFixed(1)} KB`);
  }
  console.log(`✓ rendered ${files.size} file(s) from ${CANON_JSON} (${canon.rows.length} rows)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
