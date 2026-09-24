// UI-2 (notification actionability): convention enforcement.
//
// NotificationCard (components/NotificationCard.tsx) only renders an actionable
// button when BOTH `ctaLabel` AND `ctaUrl` are set. Notifications inserted
// without them are dead informational rows. This fitness test makes a NEW dead
// notification impossible to ship silently.
//
// It statically scans every notification-building site across app/, src/, and
// lib/ (every object literal that carries a `notificationType:` key, whether
// inserted via `db.insert(notifications).values({...})`, `tx.insert(...)`, or
// pushed onto a `pendingNotifications` array) and asserts, per object:
//
//   1. HARD FAIL — if the object's `severity` is `'urgent'`, it MUST set
//      `ctaUrl`. An urgent alert with no destination is a safety bug
//      (the rabies-escalation P0 class). There is NO opt-out for urgent.
//
//   2. ALLOWLIST-BY-COMMENT — any object WITHOUT `ctaUrl` must carry a
//      `// no-cta:` comment inside the object literal, stating why no
//      destination exists. This is the explicit allowlist: a reviewer sees
//      the reason in the diff; a forgotten CTA fails the test.
//
// This is a regex/brace-matching linter, not a real AST analyzer — the cheapest
// reliable approximation, matching the idiom of
// __tests__/server-actions-auth-coverage.test.ts. It can be fooled by exotic
// formatting, but on this codebase the style is consistent and the
// false-positive rate is zero.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

// Directories whose notification inserts are real production sites.
const SCAN_DIRS = ["app", "src", "lib"];

// Excluded: tests, type-only files (the bare `notificationType: string` field
// definition), and any non-.ts file.
function isExcludedRel(rel: string): boolean {
  const norm = rel.split(sep).join("/");
  return (
    norm.includes("__tests__/") ||
    norm.endsWith(".test.ts") ||
    norm.endsWith("/types.ts") ||
    norm === "db/schema.ts"
  );
}

// Recursively walk a directory collecting `.ts` files (skips node_modules).
function walkTsFiles(dir: string, acc: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walkTsFiles(full, acc);
    } else if (stat.isFile() && name.endsWith(".ts")) {
      acc.push(full);
    }
  }
}

function listNotificationFiles(): string[] {
  const seen = new Set<string>();
  for (const base of SCAN_DIRS) {
    const acc: string[] = [];
    walkTsFiles(join(ROOT, base), acc);
    for (const abs of acc) {
      const rel = relative(ROOT, abs).split(sep).join("/");
      if (isExcludedRel(rel)) continue;
      const src = readFileSync(abs, "utf8");
      // Only files with a real notificationType assignment to a string literal.
      if (/notificationType:\s*["'`]/.test(src)) {
        seen.add(rel);
      }
    }
  }
  return [...seen].sort();
}

type NotificationObject = {
  startLine: number; // 1-indexed, line of the notificationType: key
  text: string; // the full object-literal text containing the key
};

// For a `notificationType:` occurrence, capture the enclosing object literal by
// scanning backwards to its opening `{` (brace-matching) and forwards to the
// matching `}`. Returns the object text so we can inspect severity / ctaUrl /
// no-cta within that single object only.
function extractNotificationObjects(src: string): NotificationObject[] {
  const lines = src.split("\n");
  const out: NotificationObject[] = [];
  const keyRe = /notificationType:\s*(["'`])/;

  for (let i = 0; i < lines.length; i++) {
    if (!keyRe.test(lines[i])) continue;
    // Skip matches that are inside a line comment.
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // Scan backwards to find the opening `{` of the object literal that holds
    // this key (the first unmatched `{` going up).
    let openLine = i;
    let depth = 0;
    let found = false;
    for (let b = i; b >= 0 && b > i - 60; b--) {
      const ln = lines[b];
      for (let c = ln.length - 1; c >= 0; c--) {
        const ch = ln[c];
        if (ch === "}") depth++;
        else if (ch === "{") {
          if (depth === 0) {
            openLine = b;
            found = true;
            break;
          }
          depth--;
        }
      }
      if (found) break;
    }

    // Scan forwards from openLine to the matching `}`.
    let closeLine = openLine;
    let d = 0;
    let started = false;
    for (let f = openLine; f < lines.length && f < openLine + 60; f++) {
      for (const ch of lines[f]) {
        if (ch === "{") {
          d++;
          started = true;
        } else if (ch === "}") {
          d--;
        }
      }
      if (started && d === 0) {
        closeLine = f;
        break;
      }
    }

    out.push({
      startLine: i + 1,
      text: lines.slice(openLine, closeLine + 1).join("\n"),
    });
  }

  return out;
}

function severityOf(objText: string): string | null {
  const m = objText.match(/severity:\s*(?:\(\s*)?["'`](\w+)["'`]/);
  return m ? m[1] : null;
}

function hasCtaUrl(objText: string): boolean {
  // Matches both `ctaUrl: ...` and the shorthand `ctaUrl,`.
  return /\bctaUrl\b\s*[,:]/.test(objText);
}

function hasNoCtaComment(objText: string): boolean {
  return /\/\/\s*no-cta:/.test(objText);
}

describe("UI-2 — every notification insert is actionable or explicitly opted out", () => {
  const files = listNotificationFiles();

  it("discovers notification-building files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}: urgent notifications set ctaUrl; CTA-less ones carry // no-cta:`, () => {
      const src = readFileSync(join(ROOT, file), "utf8");
      const objects = extractNotificationObjects(src);

      const hardFailures: string[] = [];
      const allowlistGaps: string[] = [];

      for (const obj of objects) {
        const severity = severityOf(obj.text);
        const cta = hasCtaUrl(obj.text);

        // (1) HARD FAIL: urgent without a ctaUrl. No opt-out.
        if (severity === "urgent" && !cta) {
          hardFailures.push(
            `${file}:${obj.startLine} — severity 'urgent' notification has NO ctaUrl. An urgent alert must give the recipient a destination. Add ctaLabel/ctaUrl.`,
          );
          continue;
        }

        // (2) ALLOWLIST: any CTA-less notification must explain itself.
        if (!cta && !hasNoCtaComment(obj.text)) {
          allowlistGaps.push(
            `${file}:${obj.startLine} — notification has no ctaUrl and no \`// no-cta: <reason>\` comment. Add a ctaLabel/ctaUrl pointing at a destination the recipient can ACCESS, or add a \`// no-cta: <reason>\` comment inside the object literal.`,
          );
        }
      }

      expect(hardFailures, hardFailures.join("\n")).toEqual([]);
      expect(allowlistGaps, allowlistGaps.join("\n")).toEqual([]);
    });
  }
});
