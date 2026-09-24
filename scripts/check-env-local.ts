#!/usr/bin/env tsx
// Local env doctor — `pnpm env:doctor` (NOT part of `pnpm verify`).
//
// WHY THIS EXISTS
// ---------------
// A `.env.local` breakage took down local dev: the file had DATABASE_URL
// defined TWICE (dotenv silently keeps the last occurrence, so the duplicate is
// invisible — you edit the first one and nothing changes), and a hand-edit had
// left a required key blank. Boot-time validation (lib/infra/env.ts) catches
// MISSING vars, but only once the server starts and only against the merged
// process.env — it cannot see a duplicate line or tell you which FILE is wrong.
//
// This doctor reads the RAW .env.local text (not the dotenv-merged result) so
// it can:
//   1. Flag duplicate key definitions (the double-DATABASE_URL footgun).
//   2. Confirm every always-required key exists and is non-empty.
//   3. Warn on empty-string values for prod-only keys (an empty
//      NEXT_PUBLIC_SITE_URL, for example, silently breaks the hero QR).
//
// PRIVACY: this script NEVER prints a value. It reports key NAMES and line
// numbers only — safe to paste into a chat or a CI log.
//
// Exit codes: 0 = no hard errors (warnings allowed); 1 = a required key is
// missing/empty or a duplicate was found.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Always required for the app to function locally (mirrors lib/infra/env.ts).
const REQUIRED_KEYS = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

// Prod-only keys — dev/test rely on documented fallbacks, so ABSENT is fine
// locally. But an explicitly EMPTY value is a footgun (e.g. empty
// NEXT_PUBLIC_SITE_URL makes the QR encode a relative, unscannable URL).
const PROD_ONLY_KEYS = ["NEXT_PUBLIC_SITE_URL", "CRON_SECRET", "DNI_HASH_PEPPER"] as const;

const ENV_FILE = resolve(process.cwd(), ".env.local");

interface ParsedKey {
  /** 1-based line numbers where this key is defined. */
  lines: number[];
  /** True when the LAST definition has a non-empty value (quotes stripped). */
  lastNonEmpty: boolean;
}

/** Strip one layer of matching surrounding quotes, then trim. */
function unquote(raw: string): string {
  const t = raw.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse raw .env text into a name→ParsedKey map. Duplicates are preserved. */
function parseEnvFile(text: string): Map<string, ParsedKey> {
  const map = new Map<string, ParsedKey>();
  const lines = text.split(/\r?\n/);
  const keyLine = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line) || line.trim() === "") return;
    const m = line.match(keyLine);
    if (!m) return;
    const [, key, rawValue] = m;
    const nonEmpty = unquote(rawValue).length > 0;
    const existing = map.get(key);
    if (existing) {
      existing.lines.push(i + 1);
      existing.lastNonEmpty = nonEmpty; // last definition wins (dotenv semantics)
    } else {
      map.set(key, { lines: [i + 1], lastNonEmpty: nonEmpty });
    }
  });
  return map;
}

function main(): void {
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];

  if (!existsSync(ENV_FILE)) {
    console.error(
      "✗ .env.local not found. Copy .env.local.example and fill it in — or, if this\n" +
        "  project is Vercel-linked, run `vercel env pull .env.local`. Never hand-author\n" +
        "  secrets you can pull. See docs/ops/local-dev-runbook.md.",
    );
    process.exit(1);
  }

  const parsed = parseEnvFile(readFileSync(ENV_FILE, "utf8"));

  // 1) Duplicate key definitions — the double-DATABASE_URL footgun.
  for (const [key, info] of parsed) {
    if (info.lines.length > 1) {
      errors.push(
        `duplicate key ${key} defined ${info.lines.length}× (lines ${info.lines.join(", ")}). dotenv silently keeps the LAST one — delete the earlier definitions.`,
      );
    }
  }

  // 2) Required keys present + non-empty (in the file, or via the shell env).
  for (const key of REQUIRED_KEYS) {
    const inFile = parsed.get(key);
    const inShell = (process.env[key] ?? "").trim().length > 0;
    if (!inFile && inShell) {
      infos.push(`${key} not in .env.local but present in the shell environment — OK.`);
      continue;
    }
    if (!inFile) {
      errors.push(`missing required key ${key}.`);
    } else if (!inFile.lastNonEmpty) {
      errors.push(`required key ${key} is present but EMPTY (line ${inFile.lines.at(-1)}).`);
    }
  }

  // 3) Prod-only keys — empty string is a footgun; absent is fine locally.
  for (const key of PROD_ONLY_KEYS) {
    const inFile = parsed.get(key);
    if (inFile && !inFile.lastNonEmpty) {
      warnings.push(
        `${key} is present but EMPTY (line ${inFile.lines.at(-1)}). Remove the line to use the documented dev fallback, or give it a real value — an empty string is not the same as unset (e.g. empty NEXT_PUBLIC_SITE_URL breaks the QR).`,
      );
    }
  }

  for (const i of infos) console.log(`  · ${i}`);
  for (const w of warnings) console.warn(`⚠ ${w}`);
  for (const e of errors) console.error(`✗ ${e}`);

  if (errors.length > 0) {
    console.error(
      `\n✗ env:doctor found ${errors.length} error(s)${warnings.length ? ` and ${warnings.length} warning(s)` : ""}. Fix .env.local (see .env.local.example and docs/ops/local-dev-runbook.md) before starting the app.`,
    );
    process.exit(1);
  }

  console.log(
    `\n✓ env:doctor clean — ${REQUIRED_KEYS.length} required keys present and non-empty${warnings.length ? `, ${warnings.length} warning(s) above` : ""}. Values were never read or printed.`,
  );
}

main();
