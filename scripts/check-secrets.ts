// Secret-scanning fence (L-24) — a committed credential fails `pnpm verify`.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Nothing in the gate looked for secrets. The repo carries hundreds of
// connection strings, JWTs and passwords by design — the local Supabase stack's
// published demo credentials are in every DB-backed test — so a real one would
// sit in that noise with nothing to tell it apart. This fence is the thing that
// tells it apart: it knows the demo values by SHAPE (not by "it's in a test"),
// and anything else of a secret's shape fails, naming file:line and the kind of
// secret, never the value.
//
// The patterns are gitleaks-shaped and deliberately few. Each one is a kind of
// credential this project actually has or could plausibly acquire:
//
//   postgres_url_password  postgres:// or postgresql:// with an inline password.
//                          Exempt: the local stack's `postgres:postgres` on a
//                          loopback host — the default every Supabase CLI prints.
//   service_role_jwt       a JWT whose payload says role=service_role. Exempt:
//                          the local stack's demo keys, which are issued by
//                          `supabase-demo`. An anon key is public by design and
//                          is not flagged.
//   supabase_secret_key    the newer `sb_secret_…` API key format.
//   stripe_live_key        `sk_live_…` / `rk_live_…`.
//   resend_api_key         Resend's `re_<id>_<secret>`.
//   aws_access_key_id      `AKIA…` / `ASIA…` (16 more upper-alphanumerics).
//   private_key_block      a PEM/OpenSSH/PGP private key header.
//   password_assignment    `password = "…"` / `password: '…'` (and secret,
//                          passwd, contraseña) with a literal value, in CONFIG
//                          and DOCS files only — in source the same shape is
//                          mostly form-field plumbing, and the credential kinds
//                          above already cover what source can leak.
//   env_secret_assignment  `FOO_SECRET=…`, `BAR_API_KEY: …`, `X_TOKEN="…"`,
//                          `DB_PASSWORD=…` — an env-var-shaped name ending in
//                          SECRET/PASSWORD/TOKEN/API_KEY, quoted or bare
//                          (YAML, .env), whose value looks high-entropy
//                          (>= 16 chars, a digit, two character classes).
//                          Config and docs only, like password_assignment.
//                          Added 2026-09-18 (security review): a pasted
//                          `CRON_SECRET=<hex>` in a runbook matched nothing.
//   demo_password         the seeded demo accounts' password, by value. It is
//                          published (the seed scripts need it), but the demo
//                          accounts also exist on staging, so it is confined to
//                          the code that logs those accounts in and kept out of
//                          prose, where it used to be copied into every runbook.
//
// Placeholders are not secrets: `<password>`, `[YOUR-PASSWORD]`, `${PGPASS}`,
// `***`, `PASSWORD`, `changeme` and the like are skipped (isPlaceholder).
//
// THE ALLOWLIST (ALLOWLIST below). Every entry names ONE kind in ONE path (or a
// path prefix ending in `/`) and carries a reason. There is no per-file
// baseline count and no inline pragma: a secret-shaped string that is fine is
// fine for a reason somebody can read, and a count would say "three are fine"
// without saying which. An entry that no longer matches anything FAILS the run
// (stale allowlist entries are how a list like this rots into a blanket).
//
// THE SYNTHETIC SECRETS in __tests__/check-secrets.test.ts are assembled at
// runtime from fragments, so the test file itself never contains a match and
// needs no allowlist entry. The non-vacuity floor lives there: every kind above
// must fire on a synthetic sample, and every exemption must be proven not to
// swallow a near-miss.
//
// Scope: every file `git ls-files` returns, minus binaries (a NUL byte in the
// first 8 KiB) and files over 2 MiB. Untracked files are not the repo's
// problem; ignored ones (.env.local) are exactly where secrets belong.
//
// Run:  pnpm tsx scripts/check-secrets.ts   (or: pnpm lint:secrets)
// Exits 0 when clean; 1 listing file:line and kind for each finding.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const SECRET_KINDS = [
  "postgres_url_password",
  "service_role_jwt",
  "supabase_secret_key",
  "stripe_live_key",
  "resend_api_key",
  "aws_access_key_id",
  "private_key_block",
  "password_assignment",
  "env_secret_assignment",
  "demo_password",
] as const;

export type SecretKind = (typeof SECRET_KINDS)[number];

export type SecretFinding = { line: number; kind: SecretKind; preview: string };

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

const PLACEHOLDER_WORDS = new Set([
  "password",
  "passwd",
  "pass",
  "pwd",
  "secret",
  "changeme",
  "change-me",
  "example",
  "redacted",
  "your-password",
  "yourpassword",
  "your_password",
  "contraseña",
  "tu-contraseña",
  "xxxx",
  // The canonical fake password of every tutorial and test fixture.
  "hunter2",
]);

/** A value that stands for a secret rather than being one. */
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  // Too short to be a credential anyone would use; fixtures write `u:p@host`.
  if (v.length < 4) return true;
  if (PLACEHOLDER_WORDS.has(v.toLowerCase())) return true;
  // supabase/config.toml's substitution syntax: the value lives in the env.
  if (/^env\(/.test(v)) return true;
  // Template / shell / markup placeholders: <x>, [x], {x}, ${x}, $X, %X%.
  if (/[<>[\]{}$%]/.test(v)) return true;
  // Masked: ***, xxxx, ••••, ....
  if (/^[*x•.·-]+$/i.test(v)) return true;
  // SHOUTING_SNAKE names an env var, not a value.
  if (/^[A-Z][A-Z0-9_]*$/.test(v)) return true;
  // Code references (`process.env.X`, `env.DB_PASSWORD`, `input.password`).
  if (/^[a-z_][\w]*(\.[\w]+)+$/i.test(v)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** user, password, host of a postgres URL with an inline password. */
const POSTGRES_URL = /postgres(?:ql)?:\/\/([^:\s/@'"`]+):([^@\s'"`/]+)@([^\s/:'"`?,)]+)/g;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"]);

/** The local stack's default: postgres:postgres on a loopback host. */
export function isLocalDemoPostgres(user: string, password: string, host: string): boolean {
  return user === "postgres" && password === "postgres" && LOCAL_HOSTS.has(host.toLowerCase());
}

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** The JWT payload as an object, or null when it does not decode. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The issuer every local Supabase CLI stack signs its demo keys with. */
export const LOCAL_DEMO_JWT_ISSUER = "supabase-demo";

/**
 * The `sb_secret_…` key every local Supabase CLI stack prints — the same value
 * on every machine (verified 2026-09-18 against `supabase status`), used by CI
 * and the DB-backed tests as the local service-role key. Any OTHER sb_secret
 * value is a real project's key.
 */
export const LOCAL_DEMO_SECRET_KEY = ["sb_secret_", "N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz"].join("");

const SIMPLE_PATTERNS: { kind: SecretKind; re: RegExp }[] = [
  { kind: "supabase_secret_key", re: /\bsb_secret_[A-Za-z0-9_-]{20,}/g },
  { kind: "stripe_live_key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}/g },
  { kind: "aws_access_key_id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    kind: "private_key_block",
    re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
];

/**
 * Resend: `re_` + an 8-char id + `_` + a long random tail. The tail must look
 * random (a digit and an upper-case letter) so a snake_case identifier that
 * happens to start with `re_` never matches.
 */
const RESEND = /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}\b/g;
function looksRandom(s: string): boolean {
  return /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

const PASSWORD_ASSIGNMENT =
  /\b(?:password|passwd|pwd|secret|contraseña|db_password|postgres_password)\b["']?\s*[:=]\s*["'`]([^"'`\s]{4,})["'`]/gi;

/**
 * `NAME_SECRET=value`, `FOO_API_KEY: value`, `export DB_PASSWORD="value"` — the
 * env-var shape, quoted or not (YAML and .env write values bare). The name must
 * END in one of the credential words, so `SECRET_PATH=` or `TOKEN_TTL_MS=` do
 * not match. Case-sensitive on purpose: SHOUTING_SNAKE is what names an env var.
 * The value stops at whitespace, a quote, a comma or a `#` comment.
 */
const ENV_SECRET_ASSIGNMENT =
  /(?<![A-Za-z0-9_])[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|API_KEY)["']?\s*[:=]\s*["'`]?([^\s"'`,#]+)/g;

/** Minimum length for an env-style value to be worth reporting as a secret. */
const ENV_SECRET_MIN_LENGTH = 16;

/**
 * High-entropy enough to be a real credential rather than a label: at least
 * ENV_SECRET_MIN_LENGTH chars, a digit, and at least two character classes
 * (lower, upper, digit, symbol). A hex secret (`openssl rand -hex 32`) passes;
 * a descriptive dummy such as `test-cron-secret-value` does not.
 */
export function looksHighEntropy(value: string): boolean {
  if (value.length < ENV_SECRET_MIN_LENGTH) return false;
  if (!/\d/.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return classes >= 2;
}

/** Split so this file never contains the literal it hunts for. */
export const DEMO_PASSWORD = ["Test", "1234!"].join("");

/** Files where `password_assignment` applies: config and docs, not source. */
export function isConfigOrDoc(path: string): boolean {
  return (
    /\.(?:md|mdx|txt|ya?ml|toml|ini|json|jsonc|env|cfg|conf|properties|sql)$/i.test(path) ||
    /(?:^|\/)\.env(?:\.[\w.-]+)?$/.test(path)
  );
}

function preview(secret: string): string {
  return `${secret.slice(0, 4)}…(${secret.length} chars)`;
}

/** One kind's hits on one line: the kind plus the matched secret. */
type LineHit = { kind: SecretKind; secret: string };
type LineScanner = (line: string, configOrDoc: boolean) => LineHit[];

const scanPostgres: LineScanner = (line) =>
  [...line.matchAll(POSTGRES_URL)]
    .filter(([, user, password, host]) => {
      if (isPlaceholder(password)) return false;
      return !isLocalDemoPostgres(user, password, host);
    })
    .map((m) => ({ kind: "postgres_url_password", secret: m[2] }));

const scanJwt: LineScanner = (line) =>
  [...line.matchAll(JWT)]
    .filter((m) => {
      const payload = decodeJwtPayload(m[0]);
      if (!payload || payload.role !== "service_role") return false;
      return payload.iss !== LOCAL_DEMO_JWT_ISSUER;
    })
    .map((m) => ({ kind: "service_role_jwt", secret: m[0] }));

const scanSimple: LineScanner = (line) =>
  SIMPLE_PATTERNS.flatMap(({ kind, re }) =>
    [...line.matchAll(re)]
      .filter((m) => !(kind === "supabase_secret_key" && m[0] === LOCAL_DEMO_SECRET_KEY))
      .map((m) => ({ kind, secret: m[0] })),
  );

const scanResend: LineScanner = (line) =>
  [...line.matchAll(RESEND)]
    .filter((m) => looksRandom(m[0].slice(3)))
    .map((m) => ({ kind: "resend_api_key", secret: m[0] }));

const scanPasswordAssignment: LineScanner = (line, configOrDoc) => {
  if (!configOrDoc) return [];
  return [...line.matchAll(PASSWORD_ASSIGNMENT)]
    .map((m) => m[1])
    .filter((value) => {
      if (isPlaceholder(value)) return false;
      // The demo password has its own kind; do not report it twice.
      return value !== DEMO_PASSWORD;
    })
    .map((value) => ({ kind: "password_assignment", secret: value }));
};

const scanEnvSecretAssignment: LineScanner = (line, configOrDoc) => {
  if (!configOrDoc) return [];
  return [...line.matchAll(ENV_SECRET_ASSIGNMENT)]
    .map((m) => m[1])
    .filter((value) => {
      if (isPlaceholder(value)) return false;
      if (!looksHighEntropy(value)) return false;
      // A URL is not the secret; a postgres URL with a password is its own kind.
      if (value.includes("://")) return false;
      // A JWT is judged by scanJwt, which knows the demo issuer and that an anon
      // key is public by design — do not second-guess it here.
      if (/^eyJ[A-Za-z0-9_-]+\.eyJ/.test(value)) return false;
      // The local stack's published sb_secret key, and the demo password, each
      // have their own kind (and their own exemption).
      if (value === LOCAL_DEMO_SECRET_KEY || value === DEMO_PASSWORD) return false;
      return true;
    })
    .map((value) => ({ kind: "env_secret_assignment", secret: value }));
};

const scanDemoPassword: LineScanner = (line) =>
  line.includes(DEMO_PASSWORD) ? [{ kind: "demo_password", secret: DEMO_PASSWORD }] : [];

const SCANNERS: LineScanner[] = [
  scanPostgres,
  scanJwt,
  scanSimple,
  scanResend,
  scanPasswordAssignment,
  scanEnvSecretAssignment,
  scanDemoPassword,
];

/**
 * `DB_PASSWORD="…"` is both a password_assignment and an env_secret_assignment.
 * Report it once, under the older kind, so an allowlist entry never has to be
 * written twice for one value.
 */
function dedupeOverlap(hits: LineHit[]): LineHit[] {
  const passwordValues = new Set(
    hits.filter((h) => h.kind === "password_assignment").map((h) => h.secret),
  );
  return hits.filter((h) => !(h.kind === "env_secret_assignment" && passwordValues.has(h.secret)));
}

/** Every secret-shaped finding in one file's text. */
export function findSecrets(path: string, src: string): SecretFinding[] {
  const configOrDoc = isConfigOrDoc(path);
  return src.split(/\r?\n/).flatMap((line, i) =>
    dedupeOverlap(SCANNERS.flatMap((scan) => scan(line, configOrDoc))).map(({ kind, secret }) => ({
      line: i + 1,
      kind,
      preview: kind === "demo_password" ? "the seeded demo password" : preview(secret),
    })),
  );
}

// ---------------------------------------------------------------------------
// Allowlist — one kind, one path (or path prefix ending in "/"), one reason.
// ---------------------------------------------------------------------------

/**
 * `path` is exact unless `prefix` is set, in which case it matches every
 * tracked path that starts with it (a directory ending in "/", or a file-name
 * family such as "scripts/seed-").
 */
export type AllowEntry = { path: string; prefix?: boolean; kind: SecretKind; reason: string };

const DEMO_LOGIN =
  "logs the seeded demo accounts in against the LOCAL stack (or staging, whose demo accounts share the seed); the password is published by the seed scripts and a rotation is tracked in dim-interno:docs/ops/cutover-debts.md";

export const ALLOWLIST: AllowEntry[] = [
  // --- demo_password: the code that creates or logs in the demo accounts ---
  {
    path: "scripts/seed-",
    prefix: true,
    kind: "demo_password",
    reason:
      "the seed scripts CREATE the demo accounts; the password has to be somewhere, and here it is published on purpose (local demo)",
  },
  {
    path: "scripts/_env-target.ts",
    kind: "demo_password",
    reason:
      "resolveSeedPassword's local default (R8, 2026-09-23) — the single place every scripts/seed-*.ts caller now gets the local literal from, instead of each one repeating it; a remote target requires SEED_DEMO_PASSWORD from env, this default is never used off localhost",
  },
  { path: "e2e/", prefix: true, kind: "demo_password", reason: `Playwright specs: ${DEMO_LOGIN}` },
  {
    path: "__tests__/rls/",
    prefix: true,
    kind: "demo_password",
    reason: `RLS suites: ${DEMO_LOGIN}`,
  },
  { path: "scripts/qa-", prefix: true, kind: "demo_password", reason: `QA probes: ${DEMO_LOGIN}` },
  {
    path: "scripts/cursor-",
    prefix: true,
    kind: "demo_password",
    reason: `QA probes: ${DEMO_LOGIN}`,
  },
  {
    path: "scripts/load-probe",
    prefix: true,
    kind: "demo_password",
    reason: `load probes: ${DEMO_LOGIN}`,
  },
  {
    path: "scripts/report-panorama-a11y.ts",
    kind: "demo_password",
    reason: `a11y report driver: ${DEMO_LOGIN}`,
  },

  // --- postgres_url_password: fixtures of the local-target classifiers ---
  {
    path: "__tests__/rehome-rollback-contract.test.ts",
    kind: "postgres_url_password",
    reason:
      "a table of URLs pinning which hosts count as the local writer target: the local demo `postgres:postgres` on non-loopback hosts (db, host.docker.internal, supabase_db_dim, 0.0.0.0) that must be REFUSED — no real credential",
  },
  {
    path: "__tests__/env-target-is-local-url.test.ts",
    kind: "postgres_url_password",
    reason:
      "the word `localhost` used as a PASSWORD on a pooler host, proving the local-URL check reads the host and not the userinfo — no real credential",
  },

  // --- stripe_live_key: a synthetic token the redactor must strip ---
  {
    path: "lib/observability/redact.test.ts",
    kind: "stripe_live_key",
    reason:
      "a made-up `sk_live_` token fed to redactText to prove Authorization values are stripped from logs — no Stripe account exists",
  },
];

function allowed(path: string, kind: SecretKind, list: AllowEntry[]): AllowEntry | undefined {
  return list.find(
    (e) => e.kind === kind && (e.prefix ? path.startsWith(e.path) : path === e.path),
  );
}

export type ScanResult = {
  findings: { path: string; finding: SecretFinding }[];
  allowlisted: number;
  unusedEntries: AllowEntry[];
};

/** Apply the allowlist to a set of files' findings. Pure, for the tests. */
export function applyAllowlist(
  files: { path: string; findings: SecretFinding[] }[],
  list: AllowEntry[] = ALLOWLIST,
): ScanResult {
  const used = new Set<AllowEntry>();
  const findings: ScanResult["findings"] = [];
  let allowlisted = 0;
  for (const { path, findings: fs } of files) {
    for (const finding of fs) {
      const entry = allowed(path, finding.kind, list);
      if (entry) {
        used.add(entry);
        allowlisted += 1;
      } else {
        findings.push({ path, finding });
      }
    }
  }
  return { findings, allowlisted, unusedEntries: list.filter((e) => !used.has(e)) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

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
    // Deleted in the working tree but still tracked — nothing to scan.
    return null;
  }
}

function runCheck(): void {
  const paths = trackedFiles();
  if (paths.length === 0) {
    console.error(
      "✗ check-secrets: `git ls-files` returned ZERO files. That is not a pass — the listing broke and this fence would wave everything through.",
    );
    process.exit(1);
  }

  const scanned: { path: string; findings: SecretFinding[] }[] = [];
  let textFiles = 0;
  for (const path of paths) {
    const src = readText(path);
    if (src === null) continue;
    textFiles += 1;
    const findings = findSecrets(path, src);
    if (findings.length > 0) scanned.push({ path, findings });
  }

  const result = applyAllowlist(scanned);
  let failed = false;

  if (result.findings.length > 0) {
    failed = true;
    for (const { path, finding } of result.findings) {
      console.error(`${path}:${finding.line}: ${finding.kind} — ${finding.preview}`);
    }
    console.error(
      [
        "",
        `✗ ${result.findings.length} secret-shaped string(s) in tracked files.`,
        "  Remove the value (reference an env var or a placeholder such as <password>),",
        "  and rotate it if it was ever real — deleting it from HEAD does not delete it from history.",
        "  Only if it is genuinely not a secret: add an ALLOWLIST entry in scripts/check-secrets.ts",
        "  with the kind, the narrowest path, and the reason.",
        "",
      ].join("\n"),
    );
  }

  if (result.unusedEntries.length > 0) {
    failed = true;
    for (const e of result.unusedEntries) {
      console.error(`✗ stale allowlist entry — ${e.kind} @ ${e.path} matches nothing; delete it.`);
    }
  }

  if (failed) process.exit(1);

  console.log(
    `✓ Secrets clean — ${textFiles} tracked text file(s) scanned, ${SECRET_KINDS.length} kinds, ${result.allowlisted} allowlisted hit(s) across ${ALLOWLIST.length} reasoned entr(ies).`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-secrets.ts") || process.argv[1].endsWith("check-secrets.js"));

if (isMain) runCheck();
