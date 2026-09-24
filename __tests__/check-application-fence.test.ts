/**
 * Unit tests for scripts/check-application-fence.ts — the ratchet over the
 * application layer's import fence (native-readiness T1.3).
 *
 * Pure fixture tests for the classifiers, plus integration assertions against
 * the REAL biome.json and the REAL tree: the ratchet has to be true of the
 * repo as it stands today, not only of fixtures. That is the half that catches
 * a stale exemption, and it is the half that was missing — measured 2026-08-20,
 * the frozen list carried two entries whose files had already been fixed.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  APPLICATION_INCLUDE,
  BIOME_CONFIG,
  type BiomeConfig,
  extractSpecifiers,
  findExemptionOverrides,
  findFenceOverride,
  isConcretePath,
  listApplicationFiles,
  readBaseline,
  restrictedImportsIn,
  restrictedSpecifiers,
  unsortedOrDuplicate,
} from "../scripts/check-application-fence";

const config = JSON.parse(readFileSync(BIOME_CONFIG, "utf8")) as BiomeConfig;

// ---------------------------------------------------------------------------
// extractSpecifiers — what counts as an import
// ---------------------------------------------------------------------------

describe("extractSpecifiers", () => {
  it("sees a static value import", () => {
    expect(extractSpecifiers('import { redirect } from "next/navigation";')).toEqual([
      "next/navigation",
    ]);
  });

  it("sees a bare side-effect import (the server-only marker shape)", () => {
    expect(extractSpecifiers('import "server-only";')).toEqual(["server-only"]);
  });

  it("sees a type-only static import — biome flags those too", () => {
    expect(extractSpecifiers('import type { Metadata } from "next";')).toEqual(["next"]);
  });

  it("sees a re-export", () => {
    expect(extractSpecifiers('export { x } from "next/cache";')).toEqual(["next/cache"]);
  });

  it("sees a multi-line import block", () => {
    expect(extractSpecifiers('import {\n  a,\n  b,\n} from "@/db";')).toEqual(["@/db"]);
  });

  it("sees a RUNTIME dynamic import — the hole biome itself does not cover", () => {
    expect(extractSpecifiers('const { cookies } = await import("next/headers");')).toEqual([
      "next/headers",
    ]);
  });

  it("IGNORES a typeof import() type reference", () => {
    // This is the shape of a use-case that already takes its client as a
    // parameter and only needs to NAME the type. It erases at compile time and
    // biome does not flag it, so neither may the ratchet — otherwise it would
    // demand an exemption for a file that is already decoupled.
    expect(
      extractSpecifiers(
        'type C = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;',
      ),
    ).toEqual([]);
  });
});

describe("restrictedImportsIn", () => {
  const restricted = new Set(["next/cache", "server-only"]);

  it("dedupes repeated hits and keeps only restricted ones", () => {
    const src = [
      'import "server-only";',
      'import { revalidatePath } from "next/cache";',
      'import { unstable_cache } from "next/cache";',
      'import { db } from "@/db";',
    ].join("\n");
    expect(restrictedImportsIn(src, restricted)).toEqual(["server-only", "next/cache"]);
  });

  it("returns nothing for a clean use-case", () => {
    expect(restrictedImportsIn('import { db } from "@/db";', restricted)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Override discovery
// ---------------------------------------------------------------------------

describe("isConcretePath", () => {
  it("accepts an enumerated file", () => {
    expect(isConcretePath("src/modules/pets/application/intake/create-intake.ts")).toBe(true);
  });

  it("rejects anything with a glob metacharacter", () => {
    expect(isConcretePath("src/modules/*/application/**")).toBe(false);
    expect(isConcretePath("src/modules/*/application/**/*.test.ts")).toBe(false);
  });
});

describe("findExemptionOverrides", () => {
  it("does not mistake the glob-based test carve-out for the exemption list", () => {
    const fixture: BiomeConfig = {
      overrides: [
        {
          include: ["src/modules/*/application/**/*.test.ts"],
          linter: { rules: { nursery: { noRestrictedImports: "off" } } },
        },
        {
          include: ["src/modules/pets/application/intake/create-intake.ts"],
          linter: { rules: { nursery: { noRestrictedImports: "off" } } },
        },
      ],
    };
    const found = findExemptionOverrides(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]?.include).toEqual(["src/modules/pets/application/intake/create-intake.ts"]);
  });

  it("finds exactly one exemption override in the real biome.json", () => {
    // More than one would let the list be split until nobody can see its size,
    // which is the single number this ratchet exists to hold down.
    expect(findExemptionOverrides(config)).toHaveLength(1);
  });
});

describe("unsortedOrDuplicate", () => {
  it("flags an out-of-order list", () => {
    expect(unsortedOrDuplicate(["b.ts", "a.ts"]).unsorted).toBe(true);
  });

  it("flags a repeated entry", () => {
    expect(unsortedOrDuplicate(["a.ts", "a.ts"]).duplicates).toEqual(["a.ts"]);
  });

  it("accepts a sorted, unique list", () => {
    const r = unsortedOrDuplicate(["a.ts", "b.ts"]);
    expect(r.unsorted).toBe(false);
    expect(r.duplicates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration — the real repo
// ---------------------------------------------------------------------------

describe("the fence itself (real biome.json)", () => {
  it("declares the application override", () => {
    expect(findFenceOverride(config)?.include).toContain(APPLICATION_INCLUDE);
  });

  it("bans @/lib/supabase/server — next/headers behind an alias (T1.3)", () => {
    // The hole this track closed: the factory calls cookies(), so a use-case
    // importing it is coupled to a Next request while looking like it is not.
    expect(restrictedSpecifiers(config)).toContain("@/lib/supabase/server");
  });

  it("still bans every specifier the original ADR named", () => {
    const restricted = restrictedSpecifiers(config);
    for (const s of ["next", "next/cache", "next/navigation", "next/headers", "server-only"]) {
      expect(restricted).toContain(s);
    }
  });
});

describe("the ratchet (real tree)", () => {
  const exempt = findExemptionOverrides(config)[0]?.include ?? [];
  const restricted = new Set(restrictedSpecifiers(config));

  it("scans a non-empty corpus", () => {
    // A fence whose glob stopped matching reports success forever.
    expect(listApplicationFiles().length).toBeGreaterThan(0);
  });

  it("has no STALE exemption — every listed file still imports something restricted", () => {
    const stale = exempt.filter(
      (f) => restrictedImportsIn(readFileSync(f, "utf8"), restricted).length === 0,
    );
    expect(stale).toEqual([]);
  });

  it("has no coupled application file outside the list", () => {
    const exemptSet = new Set(exempt);
    const unlisted = listApplicationFiles().filter(
      (f) =>
        !exemptSet.has(f) && restrictedImportsIn(readFileSync(f, "utf8"), restricted).length > 0,
    );
    expect(unlisted).toEqual([]);
  });

  it("matches the baseline exactly, so a fix must lower the number", () => {
    expect(exempt.length).toBe(readBaseline().exemptions);
  });

  it("keeps the list sorted and duplicate-free", () => {
    expect(unsortedOrDuplicate(exempt)).toEqual({ unsorted: false, duplicates: [] });
  });
});
