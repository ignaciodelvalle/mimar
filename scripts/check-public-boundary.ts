// Public/private boundary fence — what may live in this PUBLIC repository.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// This repository is public on purpose: the code is what a municipality, an
// auditor or a citizen can inspect to see how the credential, the event log
// and the privacy controls actually work. Everything else — deploy and
// cutover playbooks, incident runbooks, review and audit results, plans and
// handoffs, pilot and outreach material, presentations — lives in the private
// companion repository, dim-interno, mostly under the same relative paths
// (docs/README.md; policy: docs/agents/public-private-boundary.md).
//
// "Tanda R" (2026-09-18) moved that material out BY HAND, and a boundary that
// is only remembered is a boundary that erodes one convenient commit at a
// time. This fence makes it structural: it scans every TRACKED file and fails
// on four kinds of finding.
//
//   undeclared_doc_category  a file under docs/ whose category (its first
//                            directory, or the file itself at docs/ root) is
//                            not declared in PUBLIC_DOC_CATEGORIES below. The
//                            docs tree is ALLOWLISTED, not denylisted: a new
//                            kind of document is private until somebody says,
//                            with a reason, that it is public.
//   private_path_shape       a path shaped like the material that belongs in
//                            dim-interno wherever it sits — a reviews/,
//                            handoff/, pilotos/, outreach/ or presentation(s)/
//                            directory (any non-source file); a demo/,
//                            pilot(s)/, piloto/, critique/ or backlog/
//                            directory holding a DOCUMENT; or a document named
//                            cutover-*, *incident*, *remediation*, or with a
//                            handoff, demo, pilot/piloto, critique or backlog
//                            word in its name, or a sell/pitch/venta(s) word.
//                            The document-scoped shapes (markdown, text, SQL,
//                            office/PDF, anything under docs/, or a non-code
//                            file under an ops/ directory) leave code alone:
//                            src/…/bite-incident.ts, the decomiso *handoff*
//                            modules, scripts/ops/*.ts and an e2e/demo/*.spec.ts
//                            are never findings. The file-NAME shapes skip
//                            db/migrations/: a migration's name describes the
//                            schema change, and the files are immutable.
//   maintainer_email /       the maintainer's personal mailbox and the test
//   test_gmail               Gmail account. Neither is written here in ANY form:
//                            the fence knows them only as SHA-256 digests of the
//                            normalized local part (lowercase, `+alias` cut), and
//                            hashes the local part of every e-mail-shaped token
//                            it reads to compare, so every `+alias` and any
//                            casing match. Commit-author metadata is out of
//                            scope: this reads file CONTENTS only.
//   credential_pair          an e-mail address and a password-looking literal
//                            on the same line of a config or docs file (the
//                            `user@x / S3cret!` shape of a pasted login), or a
//                            `password:` line right after an e-mail line. The
//                            secret SHAPES (keys, JWTs, the seeded demo
//                            password) are check-secrets.ts's job. Placeholders
//                            are decided HERE, on the whole value: check-secrets'
//                            isPlaceholder treats any value containing one of
//                            `$ % < > [ ] { }` as a placeholder, which is right
//                            for its URL scan and wrong for a pasted password
//                            (`Zq8$vT2mLp` is a password, not a template).
//   env_file_value           a tracked `.env` / `.env.*` file with a VALUE. The
//                            only env file that may be tracked is a template
//                            whose every key is empty or a placeholder.
//
// THE EXCEPTIONS (EXCEPTIONS below). Each names ONE kind and ONE path (or a
// path prefix ending in "/") with a one-line reason. An exception or a docs
// category that matches nothing FAILS the run — a stale entry is how an
// allowlist rots into a blanket.
//
// NON-VACUITY. A fence that scans nothing passes everything, so the run also
// fails when `git ls-files` returns fewer than MIN_TRACKED_FILES paths or when
// no file under docs/ was seen. The synthetic violations that prove every kind
// fires live in __tests__/check-public-boundary.test.ts; like the secret
// fence's, they are assembled at runtime so neither file contains a match.
//
// A published file is not unpublished by moving it: history keeps it. If a
// secret was ever committed, the fix is ROTATION; this fence only keeps the
// tree clean from here on.
//
// Run:  pnpm tsx scripts/check-public-boundary.ts   (or: pnpm lint:public-boundary)
// Exits 0 when clean; 1 listing path[:line] and kind for each finding.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { isConfigOrDoc } from "./check-secrets";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const BOUNDARY_KINDS = [
  "undeclared_doc_category",
  "private_path_shape",
  "maintainer_email",
  "test_gmail",
  "credential_pair",
  "env_file_value",
] as const;

export type BoundaryKind = (typeof BOUNDARY_KINDS)[number];

export type BoundaryFinding = {
  path: string;
  /** 1-based line for content findings; absent for path findings. */
  line?: number;
  kind: BoundaryKind;
  detail: string;
};

// ---------------------------------------------------------------------------
// The docs allowlist — the categories that are public ON PURPOSE.
// ---------------------------------------------------------------------------

/**
 * `path` is a directory (ending in "/") covering everything under it, or an
 * exact file. Derived from the tree and docs/README.md at 2026-09-24. docs/ops/
 * is enumerated file by file on purpose: it is where deploy, cutover and
 * incident runbooks would naturally land, and those are private.
 */
export type DocCategory = { path: string; reason: string };

export const PUBLIC_DOC_CATEGORIES: DocCategory[] = [
  { path: "docs/README.md", reason: "the docs index, including the public/private note" },
  {
    path: "docs/architecture/",
    reason: "system context, data model, authorization, privacy controls, canon and facts",
  },
  { path: "docs/adr/", reason: "architecture decision records — why the code is shaped as it is" },
  { path: "docs/agents/", reason: "standing contracts for the agents that write to this repo" },
  { path: "docs/superpowers/", reason: "design specs and plans the code descends from" },
  { path: "docs/db/", reason: "database notes (migration errata)" },
  { path: "docs/testing/", reason: "the testing plan" },
  { path: "docs/patterns/", reason: "code-pattern notes" },
  { path: "docs/mobile/", reason: "mobile build profiles, emulator runbook, OTA policy" },
  { path: "docs/design/", reason: "the design canon and the two-mode design system" },
  { path: "docs/a11y/", reason: "accessibility audits of the product itself" },
  {
    path: "docs/datos-abiertos/",
    reason: "open-data dictionary and methodology — public by nature",
  },
  { path: "docs/onboarding/", reason: "user guides for each kind of user" },
  {
    path: "docs/ops/local-dev-runbook.md",
    reason: "running the stack locally — needed by any outside contributor",
  },
  {
    path: "docs/ops/db-bootstrap-runbook.md",
    reason: "rebuilding the local database — local-only by construction",
  },
  {
    path: "docs/ops/migrations.md",
    reason: "how migrations are written and applied (forward-only discipline)",
  },
  {
    path: "docs/ops/advisory-allowlist.md",
    reason: "dependency-advisory triage, cited by SECURITY.md",
  },
  { path: "docs/ops/load-probe.md", reason: "the load-probe tool's usage" },
  {
    path: "docs/event-design-checklist.md",
    reason: "the checklist every new event type follows (AGENTS.md cites it)",
  },
  {
    path: "docs/legal-framework-full.md",
    reason: "the Argentine legal framework the product is built against — public law",
  },
  { path: "docs/org-portal-event-flows.md", reason: "org-portal event-flow design" },
  { path: "docs/org-portal-permissions.md", reason: "org-portal capability model" },
  { path: "docs/org-portal-plan.md", reason: "org-portal design plan" },
];

function categoryMatches(path: string, c: DocCategory): boolean {
  return c.path.endsWith("/") ? path.startsWith(c.path) : path === c.path;
}

/** The category a docs path would have to be declared under. */
export function docCategoryOf(path: string): string {
  const rest = path.slice("docs/".length);
  const slash = rest.indexOf("/");
  return slash === -1 ? path : `docs/${rest.slice(0, slash + 1)}`;
}

// ---------------------------------------------------------------------------
// Private path shapes
// ---------------------------------------------------------------------------

const PRIVATE_DIRS = ["reviews", "handoff", "pilotos", "outreach", "presentation", "presentations"];

/**
 * Directories whose name marks private material only when they hold a
 * DOCUMENT: e2e/demo/walkthrough.spec.ts or a demo/ JSON fixture is code,
 * demo/guion.md is the demo itself.
 */
const PRIVATE_DOC_DIRS = [
  "demo",
  "demos",
  "pilot",
  "pilots",
  "piloto",
  "critique",
  "critiques",
  "backlog",
  "backlogs",
];

/**
 * Words that, as a whole token of a DOCUMENT's file name (split on - _ . and
 * spaces), mark it as private material: a session or design handoff, a demo
 * script or demo-readiness plan, pilot material, a critique, a backlog, or
 * sales material (sell, pitch, venta/ventas).
 * Token-matched, so "democracia.md" is not hit, and document-scoped, so the
 * decomiso-handoff code modules are not either.
 */
const PRIVATE_NAME_TOKENS = new Set([
  "handoff",
  "handoffs",
  "demo",
  "demos",
  "pilot",
  "pilots",
  "piloto",
  "pilotos",
  "critique",
  "critiques",
  "backlog",
  "backlogs",
  "sell",
  "pitch",
  "venta",
  "ventas",
]);

/** Source code: a directory shape on a code file is a route or a module, not a report. */
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss)$/i;

/** Documents: where a file-name shape means the material, not an identifier. */
const DOCUMENT_EXT =
  /\.(?:md|mdx|markdown|txt|sql|pdf|docx?|pptx?|xlsx?|odt|odp|ods|csv|html?|rtf|key)$/i;

export function isDocument(path: string): boolean {
  if (DOCUMENT_EXT.test(path) || path.startsWith("docs/")) return true;
  // scripts/ops/*.ts is tooling, not a runbook.
  return /(?:^|\/)ops\//.test(path) && !SOURCE_EXT.test(path);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Why `path` is shaped like private material, or null. */
export function privatePathShape(path: string): string | null {
  const segments = path.split("/").slice(0, -1);
  const dir = segments.find((s) => PRIVATE_DIRS.includes(s.toLowerCase()));
  if (dir && !SOURCE_EXT.test(path)) return `a ${dir}/ directory`;
  if (!isDocument(path)) return null;
  const docDir = segments.find((s) => PRIVATE_DOC_DIRS.includes(s.toLowerCase()));
  if (docDir) return `a document under a ${docDir}/ directory`;
  if (path.startsWith("db/migrations/")) return null;
  const name = basename(path).toLowerCase();
  if (name.startsWith("cutover-")) return "a cutover-* document";
  if (name.includes("incident")) return "an *incident* document";
  if (name.includes("remediation")) return "a *remediation* document";
  const word = name.split(/[-_.\s]+/).find((t) => PRIVATE_NAME_TOKENS.has(t));
  if (word) return `a document named *${word}*`;
  return null;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * A personal mailbox the public tree must never carry, known only by the
 * SHA-256 (hex) of its normalized local part — see normalizeLocalPart. The
 * plaintext is in no tracked file, split or whole: a digest is what lets a
 * public fence hunt for a private string without publishing it.
 */
export type PersonalMailbox = {
  kind: "maintainer_email" | "test_gmail";
  sha256: string;
  detail: string;
};

export const PERSONAL_MAILBOXES: PersonalMailbox[] = [
  {
    kind: "maintainer_email",
    sha256: "c1e693a636252cbb4af62cac9490f6ae7a42b8764377ab29ebfd18db5d9ef796",
    detail: "the maintainer's personal mailbox (or a +alias of it)",
  },
  {
    kind: "test_gmail",
    sha256: "497128810099fa596464831b9fffdfa859bcb2302000c9357ccd03efb89277fb",
    detail: "the personal test Gmail account (or a +alias of it)",
  },
];

/** Lowercase, and cut a `+alias` suffix: `Name+alertas` → `name`. */
export function normalizeLocalPart(local: string): string {
  const lower = local.toLowerCase();
  const plus = lower.indexOf("+");
  return plus === -1 ? lower : lower.slice(0, plus);
}

export function localPartDigest(local: string): string {
  return createHash("sha256").update(normalizeLocalPart(local)).digest("hex");
}

const EMAIL_TOKENS = /([A-Za-z0-9._%+-]+)@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** The personal mailboxes whose digest matches an e-mail-shaped token on the line. */
function personalMailboxesOn(line: string, mailboxes: PersonalMailbox[]): PersonalMailbox[] {
  if (mailboxes.length === 0 || !line.includes("@")) return [];
  const digests = new Set([...line.matchAll(EMAIL_TOKENS)].map((m) => localPartDigest(m[1])));
  return mailboxes.filter((m) => digests.has(m.sha256));
}

const HAS_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

/**
 * A password word followed by the value it introduces: `password: X`,
 * `contraseña X`. The value runs to whitespace or a quote/emphasis mark only,
 * NOT to `, ; )`: a password may contain them, and `ab1,cd9;Q` cut at the
 * comma is `ab1`, which slips under the length floor.
 */
const AFTER_PASSWORD_WORD =
  /\b(?:password|passwd|pwd|contraseña|clave)\b\s*(?:[:=]|is|es)?\s*["'`*]*([^\s"'`*]+)/gi;

/** An e-mail followed by a separator and a value: `user@x / S3cret!`, `user@x:S3cret!`. */
const AFTER_EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+["'`*]*\s*(?:\/|\||:|,)\s*["'`*]*([^\s"'`*]+)/g;

/** Words a template writes where the value goes; compared against the WHOLE value. */
const PLACEHOLDER_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "changeme",
  "change-me",
  "change_me",
  "example",
  "placeholder",
  "redacted",
  "contraseña",
  "clave",
]);

/**
 * A WHOLE-VALUE placeholder test, owned by this fence: `<x>`, `${X}`, `$X`,
 * `%X%`, `env(X)`, a placeholder word, `your-…` / `tu-…`, a masked run
 * (`xxx`, `***`, `...`), an env-var name (`SEED_DEMO_PASSWORD`) or a code
 * reference (`process.env.X`). A value that merely CONTAINS `$` or `%` is not
 * a placeholder: that is what real passwords look like.
 */
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (v === "") return true;
  if (/^<[^<>]*>$/.test(v)) return true;
  if (/^\$\{[^{}]*\}$/.test(v)) return true;
  if (/^\$[A-Z_][A-Z0-9_]*$/.test(v)) return true;
  if (/^%[A-Z_][A-Z0-9_]*%$/.test(v)) return true;
  if (/^env\([^()]*\)$/.test(v)) return true;
  const lower = v.toLowerCase();
  if (PLACEHOLDER_WORDS.has(lower)) return true;
  if (/^(?:your|tu|my|mi)[-_]/.test(lower)) return true;
  if (/^(?:x{3,}|\*{3,}|\.{3,}|•{3,})$/.test(lower)) return true;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return true;
  if (/^(?:process\.env|env|input|config)\.[\w.]+$/i.test(v)) return true;
  return false;
}

/**
 * Looks like a password someone pasted rather than a word, a path or a
 * reference: 6+ characters, a letter, and a digit or one of the symbols
 * password rules ask for. Brackets and slug punctuation do not count — prose
 * such as "(requires" is not a credential. The bare word "pass" is not a
 * password word either ("axe pass", "pass through" are English).
 */
export function looksLikePasswordLiteral(value: string): boolean {
  // Sentence punctuation after the value is prose, not password.
  const v = value.replace(/[.:,;]+$/, "");
  if (v.length < 6) return false;
  if (isPlaceholderValue(v)) return false;
  if (!/[A-Za-z]/.test(v)) return false;
  if (!/\d/.test(v) && !/[!#$%^&*?~+=]/.test(v)) return false;
  if (v.includes("@") || v.includes("://") || /[/\\]/.test(v)) return false;
  return true;
}

function passwordWordValues(line: string): string[] {
  return [...line.matchAll(AFTER_PASSWORD_WORD)].map((m) => m[1]).filter(looksLikePasswordLiteral);
}

function credentialPairs(line: string): string[] {
  if (!HAS_EMAIL.test(line)) return [];
  const afterEmail = [...line.matchAll(AFTER_EMAIL)].map((m) => m[1]);
  return [...passwordWordValues(line), ...afterEmail.filter(looksLikePasswordLiteral)];
}

/** A tracked env file: `.env`, `.env.local.example`, `apps/x/.env.production`. */
export function isEnvFile(path: string): boolean {
  return /^\.env(?:\..+)?$/.test(basename(path));
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * The local Supabase CLI stack's defaults: a URL on a loopback host, the same
 * on every machine (check-secrets.ts exempts the same `postgres:postgres` on
 * loopback by exact shape). A template that pre-fills them tells a newcomer
 * nothing secret and saves them a lookup; any NON-loopback URL is a real
 * environment's and fails.
 */
export function isLocalStackDefault(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Keys of an env file whose value is set (not empty, a placeholder, or a local-stack default). */
export function envKeysWithValues(src: string): { line: number; key: string }[] {
  const out: { line: number; key: string }[] = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) return;
    const value = m[2]
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (isPlaceholderValue(value) || isLocalStackDefault(value)) return;
    out.push({ line: i + 1, key: m[1] });
  });
  return out;
}

/** Every content finding in one file's text. */
export function findContent(
  path: string,
  src: string,
  mailboxes: PersonalMailbox[] = PERSONAL_MAILBOXES,
): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  const doc = isConfigOrDoc(path);
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of personalMailboxesOn(line, mailboxes)) {
      findings.push({ path, line: i + 1, kind: m.kind, detail: m.detail });
    }
    if (doc && credentialPairs(line).length > 0) {
      findings.push({
        path,
        line: i + 1,
        kind: "credential_pair",
        detail: "an e-mail and a password-looking literal on one line",
      });
    } else if (
      doc &&
      i > 0 &&
      HAS_EMAIL.test(lines[i - 1]) &&
      passwordWordValues(line).length > 0
    ) {
      // The two-line form of a pasted login: `user: x@y` then `password: S3cret!`.
      findings.push({
        path,
        line: i + 1,
        kind: "credential_pair",
        detail: "a password-looking literal on the line right after an e-mail",
      });
    }
  });
  if (isEnvFile(path)) {
    for (const { line, key } of envKeysWithValues(src)) {
      findings.push({
        path,
        line,
        kind: "env_file_value",
        detail: `${key} has a value; a tracked env file may only carry empty keys or placeholders`,
      });
    }
  }
  return findings;
}

/** Every path finding for one tracked path. */
export function findPath(path: string, categories: DocCategory[]): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  if (path.startsWith("docs/") && !categories.some((c) => categoryMatches(path, c))) {
    const category = docCategoryOf(path);
    findings.push({
      path,
      kind: "undeclared_doc_category",
      detail: `${category} is not a declared public docs category`,
    });
  }
  const shape = privatePathShape(path);
  if (shape) findings.push({ path, kind: "private_path_shape", detail: `${shape}` });
  return findings;
}

// ---------------------------------------------------------------------------
// Exceptions — one kind, one path (or prefix ending in "/"), one reason.
// ---------------------------------------------------------------------------

export type BoundaryException = { path: string; kind: BoundaryKind; reason: string };

export const EXCEPTIONS: BoundaryException[] = [
  {
    path: "docs/superpowers/plans/archive/2026-06-20-ux-audit-remediation.md",
    kind: "private_path_shape",
    reason:
      "a UX-audit remediation PLAN (copy, layout and a11y fixes to the product), not an incident or security remediation — it is a design plan like its archive siblings",
  },
  {
    path: "docs/superpowers/plans/archive/2026-06-21-panorama-demo-dataset.md",
    kind: "private_path_shape",
    reason:
      "the design plan behind scripts/seed-panorama.ts — a synthetic, population-weighted local dataset; 'demo' names the data's purpose, not a demo script or pitch",
  },
];

function exceptionMatches(f: BoundaryFinding, e: BoundaryException): boolean {
  if (e.kind !== f.kind) return false;
  return e.path.endsWith("/") ? f.path.startsWith(e.path) : f.path === e.path;
}

export type BoundaryScan = {
  findings: BoundaryFinding[];
  excepted: number;
  unusedExceptions: BoundaryException[];
  unusedCategories: DocCategory[];
  docsSeen: number;
};

/** The whole verdict over a set of files. Pure, for the tests. */
export function scanBoundary(
  files: { path: string; src: string | null }[],
  categories: DocCategory[] = PUBLIC_DOC_CATEGORIES,
  exceptions: BoundaryException[] = EXCEPTIONS,
  mailboxes: PersonalMailbox[] = PERSONAL_MAILBOXES,
): BoundaryScan {
  const usedCategories = new Set<DocCategory>();
  const usedExceptions = new Set<BoundaryException>();
  const findings: BoundaryFinding[] = [];
  let excepted = 0;
  let docsSeen = 0;
  for (const { path, src } of files) {
    if (path.startsWith("docs/")) {
      docsSeen += 1;
      for (const c of categories) if (categoryMatches(path, c)) usedCategories.add(c);
    }
    const all = [
      ...findPath(path, categories),
      ...(src === null ? [] : findContent(path, src, mailboxes)),
    ];
    for (const f of all) {
      const e = exceptions.find((x) => exceptionMatches(f, x));
      if (e) {
        usedExceptions.add(e);
        excepted += 1;
      } else {
        findings.push(f);
      }
    }
  }
  return {
    findings,
    excepted,
    unusedExceptions: exceptions.filter((e) => !usedExceptions.has(e)),
    unusedCategories: categories.filter((c) => !usedCategories.has(c)),
    docsSeen,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Below this, the listing broke — this repo tracks thousands of files. */
export const MIN_TRACKED_FILES = 1000;

const MAX_BYTES = 2 * 1024 * 1024;

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

function readText(path: string): string | null {
  try {
    if (statSync(path).size > MAX_BYTES) return null;
    const buf = readFileSync(path);
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    // Deleted in the working tree but still tracked — only its path is checked.
    return null;
  }
}

function where(f: BoundaryFinding): string {
  return f.line === undefined ? f.path : `${f.path}:${f.line}`;
}

function remedy(f: BoundaryFinding): string {
  switch (f.kind) {
    case "undeclared_doc_category":
      return `declare it public on purpose in PUBLIC_DOC_CATEGORIES (scripts/check-public-boundary.ts) with a reason, or move it to dim-interno (dim-interno:${f.path})`;
    case "private_path_shape":
      return `move it to dim-interno (dim-interno:${f.path}); if it is genuinely public, add an EXCEPTIONS entry with the reason`;
    case "maintainer_email":
    case "test_gmail":
      return "use a role address or a placeholder (<email>); personal mailboxes never ship in the public tree";
    case "credential_pair":
      return "replace the value with a placeholder or an env-var name, and ROTATE it if it was ever real";
    case "env_file_value":
      return "leave the value empty in the tracked template; real values live in the git-ignored .env.local";
  }
}

function runCheck(): void {
  const paths = trackedFiles();
  if (paths.length < MIN_TRACKED_FILES) {
    console.error(
      `✗ check-public-boundary: \`git ls-files\` returned ${paths.length} path(s), below the ${MIN_TRACKED_FILES} floor. That is not a pass — the listing broke and this fence would wave everything through.`,
    );
    process.exit(1);
  }

  let textFiles = 0;
  const files = paths.map((path) => {
    const src = readText(path);
    if (src !== null) textFiles += 1;
    return { path, src };
  });
  const result = scanBoundary(files);
  let failed = false;

  if (result.docsSeen === 0) {
    failed = true;
    console.error("✗ no tracked file under docs/ was seen — the docs allowlist checked nothing.");
  }

  if (result.findings.length > 0) {
    failed = true;
    for (const f of result.findings) {
      console.error(`${where(f)}: ${f.kind} — ${f.detail}.\n    → ${remedy(f)}`);
    }
    console.error(
      [
        "",
        `✗ ${result.findings.length} public/private boundary finding(s).`,
        "  This repository is public; internal material lives in dim-interno.",
        "  Policy: docs/agents/public-private-boundary.md",
        "",
      ].join("\n"),
    );
  }

  for (const c of result.unusedCategories) {
    failed = true;
    console.error(`✗ stale docs category — ${c.path} matches no tracked file; delete it.`);
  }
  for (const e of result.unusedExceptions) {
    failed = true;
    console.error(`✗ stale exception — ${e.kind} @ ${e.path} matches nothing; delete it.`);
  }

  if (failed) process.exit(1);

  console.log(
    `✓ Public boundary clean — ${paths.length} tracked path(s), ${textFiles} text file(s) scanned, ${result.docsSeen} docs file(s) across ${PUBLIC_DOC_CATEGORIES.length} declared categor(ies), ${result.excepted} excepted hit(s) across ${EXCEPTIONS.length} reasoned entr(ies).`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-public-boundary.ts") ||
    process.argv[1].endsWith("check-public-boundary.js"));

if (isMain) runCheck();
