// The reserved zero-pet owner's address must live in EXACTLY ONE place.
//
// WHY A FENCE AND NOT JUST A CONSTANT
// ---------------------------------------------------------------------------
// A5's root cause was not "carla had pets". It was that two independent places
// hardcoded an owner email — e2e/owner-ia-p6.spec.ts asserting she was empty,
// scripts/seed-demo-polish.ts handing her pets — with nothing tying them
// together. Extracting a constant fixes today; this fence stops the literal
// from being re-pasted tomorrow, which is the only way the same drift returns.
//
// Companion to the DB-side guard in __tests__/seed-hygiene.test.ts: that one
// catches an account that ACQUIRED pets, this one catches a call site that
// bypassed the constant. Neither replaces the other.

import { type Dirent, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RESERVED_ACCOUNT_EMAILS,
  ZERO_PET_OWNER_DISPLAY_NAME,
  ZERO_PET_OWNER_EMAIL,
  isReservedAccount,
  rejectReservedAccounts,
} from "../scripts/seed-reserved-accounts";

const REPO_ROOT = join(__dirname, "..");

/** The one file allowed to spell a reserved address out. */
const DEFINITION_FILE = "scripts/seed-reserved-accounts.ts";

/**
 * Roots that hold hand-written source. `docs/` is excluded on purpose: prose
 * naming the account is documentation, not a call site, and forcing docs to
 * reference a TypeScript symbol would make them unreadable.
 */
const SCAN_ROOTS = ["scripts", "e2e", "__tests__", "app", "components", "lib", "src", "db"];

const SCAN_EXTENSIONS = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|sql)$/;

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const absoluteRoot = join(REPO_ROOT, root);
  let entries: Dirent[];
  try {
    entries = readdirSync(absoluteRoot, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !SCAN_EXTENSIONS.test(entry.name)) continue;
    const dir = entry.parentPath ?? entry.path ?? absoluteRoot;
    if (dir.includes("node_modules") || dir.includes(".next")) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

const SOURCE_FILES = SCAN_ROOTS.flatMap(collectSourceFiles);

function relative(file: string): string {
  return file.replace(REPO_ROOT, "").replace(/\\/g, "/").replace(/^\//, "");
}

/** Files (other than the definition) whose text contains a reserved address. */
function filesHardcodingReservedEmail(): string[] {
  const hits: string[] = [];
  for (const file of SOURCE_FILES) {
    const rel = relative(file);
    if (rel === DEFINITION_FILE) continue;
    const source = readFileSync(file, "utf8");
    if (RESERVED_ACCOUNT_EMAILS.some((email) => source.includes(email))) {
      hits.push(rel);
    }
  }
  return hits;
}

// The budget belongs to ONE step, and it is not the one at line 60.
//
// `SOURCE_FILES` above is a module-level directory walk: it runs at COLLECTION,
// before any test starts, so no per-test timeout covers it. What this budget
// covers is the third test's `filesHardcodingReservedEmail()` — a readFileSync
// of every file the walk found — which gate 0901f measured at 2379ms clean.
//
// It is written on the `describe`, so vitest applies it to all three tests in
// the block, not only to the expensive one. That is deliberate and not an
// oversight: the cheap two share the same corpus, and a budget that only the
// slow test carries goes stale the moment the cost moves. 30s matches the
// repo's convention for machine-bound suites.
const SCAN_BUDGET = { timeout: 30_000 };

describe("reserved seed accounts — single source of truth", SCAN_BUDGET, () => {
  it("scans a real tree — the fence must not go inert", () => {
    // A glob that silently matches nothing passes forever.
    expect(SOURCE_FILES.length).toBeGreaterThan(200);
    expect(SOURCE_FILES.map(relative)).toContain(DEFINITION_FILE);
  });

  it("finds the address in the definition file — the detector works", () => {
    // Proves the substring search would actually fire. Without this, a typo in
    // the constant would make the fence below pass by matching nothing at all.
    const definition = readFileSync(join(REPO_ROOT, DEFINITION_FILE), "utf8");
    expect(definition).toContain(ZERO_PET_OWNER_EMAIL);
  });

  it("is hardcoded nowhere else — every consumer imports the constant", () => {
    expect(
      filesHardcodingReservedEmail(),
      [
        "These files spell a reserved seed account's address out instead of importing",
        "it from scripts/seed-reserved-accounts.ts.",
        "",
        "That is exactly how the previous zero-pet owner was lost: e2e/owner-ia-p6",
        "asserted carla@dim.test was empty while scripts/seed-demo-polish.ts handed her",
        "pets, and nothing connected the two literals. Import the constant so the next",
        "person who widens a recipient list is stopped by the compiler and by",
        "rejectReservedAccounts(), not by a red e2e three weeks later.",
      ].join("\n"),
    ).toEqual([]);
  });
});

describe("rejectReservedAccounts — the filter seed scripts run recipients through", () => {
  it("drops a reserved recipient and warns", () => {
    const warnings: string[] = [];
    const kept = rejectReservedAccounts(
      ["owner@dim.test", ZERO_PET_OWNER_EMAIL, "noeli@dim.test"],
      "unit test",
      (message) => warnings.push(message),
    );

    expect(kept).toEqual(["owner@dim.test", "noeli@dim.test"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(ZERO_PET_OWNER_EMAIL);
    expect(warnings[0]).toContain("unit test");
  });

  it("passes an all-clean list through untouched, with no warning", () => {
    const warnings: string[] = [];
    const input = ["owner@dim.test", "noeli@dim.test"] as const;
    const kept = rejectReservedAccounts(input, "unit test", (m) => warnings.push(m));

    expect(kept).toEqual([...input]);
    expect(warnings).toEqual([]);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    // Seed lists get hand-edited. A stray space or a capital letter must not be
    // enough to sneak a reserved account past the filter.
    expect(isReservedAccount(`  ${ZERO_PET_OWNER_EMAIL.toUpperCase()} `)).toBe(true);
    expect(isReservedAccount("owner@dim.test")).toBe(false);
    expect(rejectReservedAccounts([` ${ZERO_PET_OWNER_EMAIL} `], "unit test", () => {})).toEqual(
      [],
    );
  });
});

describe("reserved zero-pet owner — shape of the account", () => {
  it("is a @dim.test address and is itself reserved", () => {
    expect(ZERO_PET_OWNER_EMAIL).toMatch(/@dim\.test$/);
    expect(RESERVED_ACCOUNT_EMAILS).toContain(ZERO_PET_OWNER_EMAIL);
    expect(isReservedAccount(ZERO_PET_OWNER_EMAIL)).toBe(true);
  });

  it("carries a human display name, not a seed marker", () => {
    // profiles.display_name is a RENDERABLE column (scripts/hygiene-rules.ts):
    // a funcionario must never be able to tell "demo" from "broken". The
    // reservation is enforced in code, never in copy.
    expect(ZERO_PET_OWNER_DISPLAY_NAME).not.toMatch(/reserv|zero|seed|test|empty|vac[ií]/i);
    expect(ZERO_PET_OWNER_DISPLAY_NAME.trim()).toBe(ZERO_PET_OWNER_DISPLAY_NAME);
    expect(ZERO_PET_OWNER_DISPLAY_NAME.length).toBeGreaterThan(3);
  });
});
