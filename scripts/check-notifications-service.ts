// Notifications single-write-path ratchet — CI guard.
//
// Enforces that NO NEW file writes to the `notifications` table with a direct
// `db.insert(notifications)` (or `tx.insert(...)`, `dbInstance.insert(...)`,
// etc.). Every new notification MUST go through the canonical write path,
// createNotification() / createNotificationsBulk() in
// lib/infra/notification-service.ts, which supplies the two guarantees the
// 2026-07-04 consistency review found missing at 84 ad-hoc call sites:
//   - idempotency via ON CONFLICT (dedupe_key) DO NOTHING, and
//   - durability via the notification_dead_letter surface.
//
// Rule:
//   Any file under app/, lib/, src/ (excluding *.test.ts and the service
//   itself) that contains `.insert(notifications)` MUST appear in the baseline
//   (scripts/notifications-service-baseline.json). A file NOT in the baseline
//   that matches is a NEW direct insert → this script exits 1.
//
//   The baseline is the set of not-yet-migrated legacy sites captured on
//   2026-07-04. The full 84-site migration is a lint-enforced follow-on: as
//   each baselined file is migrated onto the service, delete its key from the
//   baseline in the same PR. The list only ever shrinks.
//
// Run: pnpm tsx scripts/check-notifications-service.ts   (or: pnpm lint:notifications)
// Exits 0 when clean; exits 1 listing each unexpected new direct insert.
//
// Regex-based, not a full AST analyzer — mirrors the sibling linters
// (check-lib-root-files.ts, check-dependency-direction.ts, etc.).

import { existsSync, readFileSync } from "node:fs";

import { globSync } from "node:fs";
import { stripComments } from "./check-scope-discipline";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASELINE_PATH = "scripts/notifications-service-baseline.json";

// Globs scanned for direct notification inserts. Kept to the application source
// roots; scripts/ (seeds) and docs/ are out of scope.
const SCAN_GLOBS = ["app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "src/**/*.ts"];

// The canonical write path — the ONE file allowed to db.insert(notifications).
const SERVICE_FILE = "lib/infra/notification-service.ts";

// Matches a direct insert into the `notifications` table on any client handle
// (db / tx / dbInstance / client). Deliberately does NOT match
// `notificationDeadLetter` (different identifier) or `notifications_...`.
const INSERT_RE = /\.insert\(\s*notifications\s*\)/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceViolation = {
  file: string;
  reason: string;
};

export type Baseline = Record<string, true | string>;

// ---------------------------------------------------------------------------
// Core logic (exported for unit tests)
// ---------------------------------------------------------------------------

/** Normalize a path to forward slashes for cross-platform baseline keys. */
export function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

/** True when a file is exempt from the ban (test file or the service itself). */
export function isExempt(normalized: string): boolean {
  return normalized.endsWith(".test.ts") || normalized === SERVICE_FILE;
}

export function checkNotificationsService(
  baseline: Baseline,
  matchingFiles: string[],
): ServiceViolation[] {
  const violations: ServiceViolation[] = [];

  for (const filePath of matchingFiles) {
    const normalized = normalizePath(filePath);
    if (isExempt(normalized)) continue;
    // Allowed only if explicitly baselined (a known legacy site awaiting migration).
    if (baseline[normalized] === true) continue;

    violations.push({
      file: normalized,
      reason:
        "direct db.insert(notifications) is banned in NEW code. Route notifications through createNotification() / createNotificationsBulk() in lib/infra/notification-service.ts (idempotent + dead-lettered). If this is an intentional legacy carve-out, it must be added to the baseline by a maintainer — but the intent is to MIGRATE, not baseline-grow.",
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function discoverMatchingFiles(): string[] {
  const seen = new Set<string>();
  for (const pattern of SCAN_GLOBS) {
    for (const p of globSync(pattern)) {
      const normalized = normalizePath(p);
      if (seen.has(normalized)) continue;
      let src: string;
      try {
        src = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      // Comments are stripped BEFORE matching. Without this the fence reads its
      // own explanations: a file that documents "migrated away from a raw
      // .insert(notifications)" was reported as an offender, and so was a
      // types.ts holding no executable code at all (found 2026-08-19 while
      // migrating src/modules/caretakers). That is a perverse incentive —
      // it penalises leaving the reason behind, which is exactly what a future
      // reader needs. Same hole check-db-budget hit on 2026-08-09; the shared
      // helper already exists.
      if (INSERT_RE.test(stripComments(src))) seen.add(normalized);
    }
  }
  return [...seen].sort();
}

function runScan(): void {
  let baseline: Baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch {
    console.error(`✗ check-notifications-service: cannot read baseline at ${BASELINE_PATH}`);
    process.exit(1);
  }

  if (!existsSync("lib")) {
    console.error("✗ check-notifications-service: no lib/ directory — is the cwd correct?");
    process.exit(1);
  }

  const matchingFiles = discoverMatchingFiles();
  const violations = checkNotificationsService(baseline, matchingFiles);

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}: ${v.reason}`);
    }
    console.error(
      `\n✗ ${violations.length} new direct db.insert(notifications) call(s). Use lib/infra/notification-service.ts.`,
    );
    process.exit(1);
  }

  // Count baseline entries (exclude the "//" comment key).
  const baselineCount = Object.keys(baseline).filter((k) => k !== "//").length;
  console.log(
    `✓ notifications write path clean — ${matchingFiles.length} file(s) with a direct insert, all ${baselineCount} baselined (awaiting migration to lib/infra/notification-service.ts). No new direct inserts.`,
  );
}

// Guard: only scan when run directly; importing from tests exposes helpers
// without triggering the filesystem scan.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-notifications-service.ts") ||
    process.argv[1].endsWith("check-notifications-service.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
