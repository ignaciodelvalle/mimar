// Fence: name→catalogue-row lookups are called through lib/place/, and the
// callers that predate the resolver can only shrink (localidades-por-id B3).
// The detector is pinned on fixtures; its verdict over the repository must be
// clean (the same verdict `pnpm lint:place-resolver` prints).

import { describe, expect, it } from "vitest";

import {
  countCalls,
  evaluate,
  isExempt,
  readSources,
} from "../scripts/check-place-resolver-single-entry";

describe("the detector", () => {
  it("counts a call, not the definition, an import or a comment", () => {
    const src = [
      'import { localityByName } from "@/lib/infra/ar-localidades";',
      "export async function localityByName(code: string) {}",
      "// localityByName(code, name) settles homonyms",
      "const row = await localityByName(code, name);",
      "const rows = await localitiesByName (code, name);",
    ].join("\n");
    expect(countCalls(src)).toBe(2);
  });

  it("flags a new caller and names it", () => {
    const { violations } = evaluate([
      { file: "lib/new-writer.ts", source: "await resolveCanonicalJurisdiction(input);" },
    ]);
    expect(violations).toContainEqual({ file: "lib/new-writer.ts", calls: 1, frozen: 0 });
  });

  it("lets the resolver and the defining modules call them", () => {
    expect(isExempt("lib/place/resolve-place.ts")).toBe(true);
    expect(isExempt("lib/infra/ar-localidades.ts")).toBe(true);
    expect(isExempt("lib/infra/ar-localidades-extra.ts")).toBe(false);
    expect(isExempt("lib/placement.ts")).toBe(false);
  });
});

describe("the repository", () => {
  it("calls the lookups only from the frozen list", () => {
    const { violations, total } = evaluate(readSources());
    expect(violations).toEqual([]);
    expect(total).toBeGreaterThan(0);
  });
});
