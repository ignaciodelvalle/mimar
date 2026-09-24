// Drift fence: every credential-code prefix this repo actually MINTS must be
// redacted before a client error report leaves for a third party.
//
// WHY A FENCE AND NOT AN IMPORT
// ---------------------------------------------------------------------------
// The obvious derivation — `redact.ts` imports the prefix list from
// `lib/infra/publicToken.ts` — is not available. That module imports
// `node:crypto`, and `redact.ts` is bundled into the BROWSER; importing it
// would drag a Node builtin into the client bundle.
//
// The second-obvious derivation is not available either: `generatePrefixedToken`
// takes a plain `string`, so the generator does not know its own prefix set.
// Four of the twelve (`CAS`, `DIS`, `PTR`, `FP`) are literals typed at call
// sites in `src/modules/**`, and a fifth (`DEN`) comes from an entirely
// separate generator with its own alphabet. The header of `publicToken.ts`
// lists seven and is stale — which is exactly the failure mode this file
// exists to make loud, and exactly why the previous version of the redaction
// rule shipped covering three of them.
//
// So the list in `redact.ts` is local, and this test re-derives the true set
// from the repository on every run. A transcribed list goes stale in silence.
// A transcribed list with a fence in front of it goes stale in red.
//
// WHAT COUNTS AS "MINTED": a literal passed to `generatePrefixedToken(...)`
// anywhere in shipped source or in the seed scripts (seeds write real rows to
// a real database, so their codes are as real as production's), plus the
// prefix hardcoded by the welfare denuncia generator.

import { globSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CAPABILITY_PATH_SEGMENTS, CREDENTIAL_TOKEN_PREFIXES } from "@/lib/observability/redact";

/** Source globs that can mint a token. Docs and node_modules are not source. */
const SOURCE_GLOBS = "{app,components,lib,packages,src,scripts,apps}/**/*.{ts,tsx}";

/** `generatePrefixedToken("CAS")` → CAS */
const MINTED_PREFIX = /generatePrefixedToken\(\s*"([A-Z][A-Z0-9]{1,5})"\s*\)/g;

const WELFARE_GENERATOR = "src/modules/welfare/domain/reference-code.ts";
/** `let code = "DEN-";` inside generateReferenceCode. */
const WELFARE_PREFIX = /code\s*=\s*"([A-Z][A-Z0-9]{1,5})-"/;

function readSourceFiles(): string[] {
  return globSync(SOURCE_GLOBS)
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes("node_modules/"));
}

/** Every prefix the repo actually mints, re-derived from source. */
function mintedPrefixes(): Set<string> {
  const found = new Set<string>();

  for (const file of readSourceFiles()) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(MINTED_PREFIX)) found.add(match[1]);
  }

  const welfare = readFileSync(WELFARE_GENERATOR, "utf8").match(WELFARE_PREFIX);
  if (welfare) found.add(welfare[1]);

  return found;
}

// Every test below re-scans the repo (mintedPrefixes / globSync), so the cost
// is bound to the disk, not to the assertions: the smoke test measured 2484 ms
// on a clean run (gate 0901f, 2026-09-01) against vitest's 5 s default, and a
// sibling scan suite timed out under I/O contention the same day. Declared,
// not inherited — 30 s is the repo's convention for machine-bound suites.
const SCAN_BUDGET = { timeout: 30_000 };
const SUITE = "credential prefix coverage — the redaction list cannot go stale in silence";

describe(SUITE, SCAN_BUDGET, () => {
  it("finds the prefixes it is supposed to find (the fence's own smoke test)", () => {
    // If the extraction regexes rot, every other assertion here passes
    // vacuously. Anchor on prefixes minted from three DIFFERENT places: the
    // central generator, a call site in src/modules, and the welfare module.
    const minted = mintedPrefixes();

    expect(minted).toContain("DIM"); // lib/infra/publicToken.ts
    expect(minted).toContain("CAS"); // src/modules/cases/infrastructure
    expect(minted).toContain("FP"); // src/modules/foster — two letters, not three
    expect(minted).toContain("DEN"); // src/modules/welfare/domain/reference-code.ts
    expect(minted.size).toBeGreaterThanOrEqual(12);
  });

  it("redacts EVERY prefix the repo mints", () => {
    const covered = new Set(CREDENTIAL_TOKEN_PREFIXES.map((p) => p.replace(/-$/, "")));
    const uncovered = [...mintedPrefixes()].filter((p) => !covered.has(p)).sort();

    // A citizen's token reaching a third-party index is the failure this list
    // prevents. If this fails, add the prefix to CREDENTIAL_TOKEN_PREFIXES.
    expect(uncovered).toEqual([]);
  });

  it("does not carry prefixes the repo no longer mints", () => {
    // The other direction. A stale entry is not a leak, but it is a claim
    // about the product that stopped being true, and this module's whole
    // problem was a header describing intent as if it were behavior.
    const minted = mintedPrefixes();
    const orphaned = CREDENTIAL_TOKEN_PREFIXES.map((p) => p.replace(/-$/, "")).filter(
      (p) => !minted.has(p),
    );

    expect(orphaned).toEqual([]);
  });

  it("covers every route segment whose next segment is a token, code or serial", () => {
    // Second drift fence, same idea against a different source of truth: the
    // ROUTER. Every `.../segment/[somethingToken]/` in the app is a URL where
    // holding the string is the authorization, and a URL is the single most
    // likely thing to appear in a client error report.
    //
    // Derived rather than listed because this is how the gap got in: the
    // original list named six segments from memory. This check found
    // `/api/v1/pets/[publicToken]` on its first run.
    // Glob FILES and derive the directory chain from their paths — globbing
    // for directories whose name is literally "[x]" fights the glob syntax.
    const routeDirs = new Set<string>();
    for (const file of globSync("{app,apps/mobile/app}/**/*.{ts,tsx}")) {
      const parts = String(file).replaceAll("\\", "/").split("/");
      for (let i = 1; i < parts.length; i++) {
        if (parts[i - 1].startsWith("[")) routeDirs.add(parts.slice(0, i).join("/"));
      }
    }

    const uncovered = new Set<string>();
    for (const dir of routeDirs) {
      const parts = dir.split("/");
      const param = parts[parts.length - 1]; // "[publicToken]"
      if (!/token|code|serial/i.test(param)) continue; // not a capability-shaped param

      // Walk back past Next.js route groups — "(app)", "(public)" — which are
      // organisational and never appear in a real URL.
      let i = parts.length - 2;
      while (i >= 0 && parts[i].startsWith("(") && parts[i].endsWith(")")) i--;
      const parent = parts[i];
      if (!parent || parent === "app" || parent.startsWith("[")) continue;

      if (!CAPABILITY_PATH_SEGMENTS.includes(parent)) uncovered.add(`${parent} (from ${dir})`);
    }

    expect([...uncovered].sort()).toEqual([]);
  });

  it("stores each prefix WITH its hyphen, which is what keeps lint:brand green", () => {
    // `scripts/check-brand-casing.ts` Rule 2 flags a bare `DIM` as the internal
    // codename and never flags `DIM-`, because the hyphen is what makes it a
    // public token namespace. Writing the values in their true form is why
    // this file needs no `dim-codename-ok` pragma — and a pragma would have
    // frozen a list we already knew was incomplete.
    for (const prefix of CREDENTIAL_TOKEN_PREFIXES) {
      expect(prefix.endsWith("-")).toBe(true);
    }
  });
});
