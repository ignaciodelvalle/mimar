// `publicPetByToken` is an EXACT match, and that is a decision, not an
// omission (2026-09-23).
//
// One unpushed commit made the predicate fold its input (trim + uppercase) so
// that `/p/dim-pamp-0001` reached DIM-PAMP-0001. Review turned it back: every
// limiter key on the public-token surfaces (finder_possession*, sighting*,
// the dispute tip, the /api/v1 D3 per-lookup key) and the scan log are built
// from the RAW route param, so a folding predicate let one credential be read
// under every case spelling — each one a fresh, empty limiter bucket. Case is
// canonicalised once, at the edge (middleware.ts 308 → lib/domain/dim-token.ts
// `canonicalDimToken`), and downstream only ever sees the issued spelling.
//
// So these assertions pin the predicate to the literal it was handed. If a
// future change reintroduces folding here, the second and third cases go red
// and point at this header. Proven over the GENERATED SQL via `.toSQL()`, which
// builds the query without touching a database (postgres-js connects lazily).

import { describe, expect, it } from "vitest";

import { db, pets } from "@/db";

import { publicPetByToken, unerasedPetByToken } from "./public-pet-lookup";

function paramsFor(token: string): unknown[] {
  return db.select().from(pets).where(publicPetByToken(token)).toSQL().params;
}

describe("publicPetByToken — exact match; canonicalisation lives at the edge", () => {
  it("compares against the canonical token verbatim", () => {
    expect(paramsFor("DIM-TEST-0001")).toContain("DIM-TEST-0001");
  });

  it("does NOT uppercase a lowercase token (the middleware 308 does that)", () => {
    const params = paramsFor("dim-test-0001");
    expect(params).toContain("dim-test-0001");
    expect(params).not.toContain("DIM-TEST-0001");
  });

  it("does NOT trim surrounding whitespace", () => {
    const params = paramsFor(" DIM-TEST-0001 ");
    expect(params).toContain(" DIM-TEST-0001 ");
    expect(params).not.toContain("DIM-TEST-0001");
  });

  it("filters out soft-deleted rows (PO-4, art. 16)", () => {
    const { sql } = db.select().from(pets).where(publicPetByToken("DIM-TEST-0001")).toSQL();
    expect(sql).toMatch(/"public_token" = \$\d+/);
    expect(sql).toMatch(/deleted_at.*is null/i);
  });

  it("the authenticated alias is the same predicate object (one filter, two names)", () => {
    expect(unerasedPetByToken).toBe(publicPetByToken);
  });
});
