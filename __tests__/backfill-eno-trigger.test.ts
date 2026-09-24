// Pure unit tests for the ENO trigger backfill helpers.
//
// Tests the gating predicate `isEnoEligible` and the CLI flag parser
// `parseFlags` — both are side-effect-free functions in
// `lib/backfill-eno-trigger-helpers.ts`.
//
// No DB connection required. This file runs in the standard Vitest suite
// without Supabase.

import { describe, expect, it } from "vitest";

import { isEnoEligible, parseFlags } from "@/lib/infra/backfill-eno-trigger-helpers";

// ---------------------------------------------------------------------------
// isEnoEligible
// ---------------------------------------------------------------------------

describe("isEnoEligible", () => {
  // ── happy path — form codes that were silently broken before #137 ──

  it("rabies_confirmed + disease_diagnosis sub_kind → true", () => {
    expect(isEnoEligible({ sub_kind: "disease_diagnosis", disease_code: "rabies_confirmed" })).toBe(
      true,
    );
  });

  it("rabies_suspected → true", () => {
    expect(isEnoEligible({ sub_kind: "disease_diagnosis", disease_code: "rabies_suspected" })).toBe(
      true,
    );
  });

  it("canine_brucellosis → true (maps to brucelosis_canina in ENO catalog)", () => {
    expect(
      isEnoEligible({ sub_kind: "disease_diagnosis", disease_code: "canine_brucellosis" }),
    ).toBe(true);
  });

  it("visceral_leishmaniasis → true (maps to leishmaniasis in ENO catalog)", () => {
    expect(
      isEnoEligible({ sub_kind: "disease_diagnosis", disease_code: "visceral_leishmaniasis" }),
    ).toBe(true);
  });

  it("hydatidosis → true (maps to hidatidosis in ENO catalog)", () => {
    expect(isEnoEligible({ sub_kind: "disease_diagnosis", disease_code: "hydatidosis" })).toBe(
      true,
    );
  });

  it("leptospirosis → true (identity mapping — was always working)", () => {
    expect(isEnoEligible({ sub_kind: "disease_diagnosis", disease_code: "leptospirosis" })).toBe(
      true,
    );
  });

  // ── all 5 ENO form codes in one table-driven pass ──

  it("all 5 ENO form codes resolve to eligible (table-driven)", () => {
    const ENO_FORM_CODES = [
      "rabies_confirmed",
      "rabies_suspected",
      "leptospirosis",
      "canine_brucellosis",
      "visceral_leishmaniasis",
      "hydatidosis",
    ];
    for (const code of ENO_FORM_CODES) {
      expect(
        isEnoEligible({ sub_kind: "disease_diagnosis", disease_code: code }),
        `expected ${code} to be ENO-eligible`,
      ).toBe(true);
    }
  });

  // ── wrong sub_kind ──

  it("rabies_confirmed with sub_kind='note' → false (wrong sub_kind)", () => {
    expect(isEnoEligible({ sub_kind: "note", disease_code: "rabies_confirmed" })).toBe(false);
  });

  it("rabies_confirmed with no sub_kind → false", () => {
    expect(isEnoEligible({ disease_code: "rabies_confirmed" })).toBe(false);
  });

  // ── non-ENO disease ──

  it("parvovirus (non-ENO disease) → false", () => {
    expect(isEnoEligible({ sub_kind: "disease_diagnosis", disease_code: "parvovirus" })).toBe(
      false,
    );
  });

  it("distemper (non-ENO disease) → false", () => {
    expect(isEnoEligible({ sub_kind: "disease_diagnosis", disease_code: "distemper" })).toBe(false);
  });

  // ── missing disease_code ──

  it("no disease_code → false", () => {
    expect(isEnoEligible({ sub_kind: "disease_diagnosis" })).toBe(false);
  });

  it("disease_code=null → false", () => {
    expect(isEnoEligible({ sub_kind: "disease_diagnosis", disease_code: null })).toBe(false);
  });

  it("disease_code as number (type coercion guard) → false", () => {
    expect(isEnoEligible({ sub_kind: "disease_diagnosis", disease_code: 42 })).toBe(false);
  });

  // ── empty payload ──

  it("empty payload → false", () => {
    expect(isEnoEligible({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

describe("parseFlags", () => {
  it("no args → defaults (dry_run=false, since=null, limit=1000, until≈now)", () => {
    const before = Date.now();
    const flags = parseFlags([]);
    const after = Date.now();

    expect(flags.dryRun).toBe(false);
    expect(flags.since).toBeNull();
    expect(flags.limit).toBe(1000);
    // until should be close to now (within the test execution window)
    expect(flags.until.getTime()).toBeGreaterThanOrEqual(before);
    expect(flags.until.getTime()).toBeLessThanOrEqual(after + 5);
  });

  it("--dry-run sets dryRun=true", () => {
    const flags = parseFlags(["--dry-run"]);
    expect(flags.dryRun).toBe(true);
  });

  it("--since 2026-01-01 parses to a valid Date", () => {
    const flags = parseFlags(["--since", "2026-01-01"]);
    expect(flags.since).not.toBeNull();
    expect(flags.since?.toISOString().startsWith("2026-01-01")).toBe(true);
  });

  it("--until 2026-06-01 parses to a valid Date", () => {
    const flags = parseFlags(["--until", "2026-06-01"]);
    expect(flags.until.toISOString().startsWith("2026-06-01")).toBe(true);
  });

  it("--limit 50 parses to number 50", () => {
    const flags = parseFlags(["--limit", "50"]);
    expect(flags.limit).toBe(50);
  });

  it("all flags together", () => {
    const flags = parseFlags([
      "--dry-run",
      "--since",
      "2026-03-01",
      "--until",
      "2026-05-01",
      "--limit",
      "250",
    ]);
    expect(flags.dryRun).toBe(true);
    expect(flags.since?.toISOString().startsWith("2026-03-01")).toBe(true);
    expect(flags.until.toISOString().startsWith("2026-05-01")).toBe(true);
    expect(flags.limit).toBe(250);
  });

  it("invalid --since value is ignored, since stays null", () => {
    const flags = parseFlags(["--since", "not-a-date"]);
    expect(flags.since).toBeNull();
  });

  it("invalid --limit value is ignored, limit stays 1000", () => {
    const flags = parseFlags(["--limit", "abc"]);
    expect(flags.limit).toBe(1000);
  });

  it("zero --limit is ignored (must be positive), limit stays 1000", () => {
    const flags = parseFlags(["--limit", "0"]);
    expect(flags.limit).toBe(1000);
  });

  it("negative --limit is ignored, limit stays 1000", () => {
    const flags = parseFlags(["--limit", "-5"]);
    expect(flags.limit).toBe(1000);
  });
});
