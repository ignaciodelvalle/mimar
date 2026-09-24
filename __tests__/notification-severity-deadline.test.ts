// Fence — a notification with a deadline must not be emitted as `info`.
//
// The inbox sorts by severity first (documented and tested in
// notification-ordering.ts). That sort is correct; what broke was its INPUT.
// On 2026-08-13 a foster proposal that auto-expires in 7 days shipped as
// `info` — the last rank — and sank below week-old warnings, so the person who
// had to answer it never saw it. The rule now lives in
// lib/infra/notification-deadlines.ts; this fence keeps the call sites honest.
//
// It scans SOURCE rather than checking a registry on purpose: severity is
// chosen at each `insert(notifications)` call site, so a registry alone would
// let the two drift. A fence that reads the code cannot be satisfied by good
// intentions.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ACTION_REQUIRED_BEFORE_DEADLINE } from "@/lib/infra/notification-deadlines";

const ROOTS = ["src", "lib", "app"];
const SKIP_DIRS = new Set(["node_modules", ".next", "__tests__"]);

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Every `notificationType: "X"` occurrence paired with the severity literal that
 * follows it within a few lines — the shape every call site in this repo uses.
 */
function emittedSeverities(): Array<{
  type: string;
  severity: string;
  file: string;
  line: number;
}> {
  const found: Array<{ type: string; severity: string; file: string; line: number }> = [];
  for (const root of ROOTS) {
    for (const file of collectSourceFiles(root)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const typeMatch = lines[i].match(/notificationType:\s*"([a-z0-9_]+)"/);
        if (!typeMatch) continue;
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const sevMatch = lines[j].match(/severity:\s*"([a-z]+)"/);
          if (sevMatch) {
            found.push({ type: typeMatch[1], severity: sevMatch[1], file, line: i + 1 });
            break;
          }
          if (/notificationType:/.test(lines[j])) break;
        }
      }
    }
  }
  return found;
}

describe("notifications with a deadline", () => {
  const emitted = emittedSeverities();

  it("finds call sites at all — a fence that scans nothing proves nothing", () => {
    // Without this, a broken scanner would report a clean sweep forever.
    expect(emitted.length).toBeGreaterThan(30);
  });

  it("never emits an action-required-before-deadline type as info", () => {
    const offenders = emitted
      .filter((e) => ACTION_REQUIRED_BEFORE_DEADLINE.has(e.type) && e.severity === "info")
      .map((e) => `${e.file}:${e.line} → ${e.type} is "info"`);

    expect(
      offenders,
      "These expire on a cron. At `info` they rank last in the inbox and the person " +
        "who has to answer never sees them — see lib/infra/notification-deadlines.ts.",
    ).toEqual([]);
  });

  it("covers every type declared in the rule — no dead entries", () => {
    // A type listed in the set but emitted nowhere means the set is stale, and a
    // stale set makes the fence above quietly weaker than it reads.
    const emittedTypes = new Set(emitted.map((e) => e.type));
    for (const type of ACTION_REQUIRED_BEFORE_DEADLINE) {
      expect(emittedTypes, `${type} is in the rule but emitted by no call site`).toContain(type);
    }
  });
});
