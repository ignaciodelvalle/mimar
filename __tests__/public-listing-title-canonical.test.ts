// Integration tests for lib/infra/public-listing-metadata.ts's
// resolveCanonicalTitleLocation — the A03-G11 fix (2026-09).
//
// Before this fix, /perdidas and /adoptar interpolated the raw, unvalidated
// `provincia`/`localidad` query params straight into generateMetadata's
// <title> — `GET /perdidas?localidad=<attacker copy>` yielded an indexable
// page (robots.ts allows the whole tree) with an attacker-chosen title.
//
// Requires a running local Supabase stack with the INDEC catalog imported
// (pnpm db:bootstrap step 4) — same precondition as jurisdiction-validation.test.ts.

import { count as countFn, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { arLocalities, db } from "@/db";
import { resolveCanonicalTitleLocation } from "@/lib/infra/public-listing-metadata";

// The skip guard used to be silent: `if (!catalogPopulated) return;` at the
// top of every catalog-dependent `it` made a missing/unseeded local Supabase
// stack pass ALL THREE of those tests vacuously green — the exact "skip must
// be loud, never silently green" failure mode this suite exists to avoid for
// everything else. `beforeAll` now THROWS with a clear message instead, so a
// missing catalog fails the run loudly (fresh-context review, pre-push).
beforeAll(async () => {
  const [total] = await db
    .select({ count: countFn() })
    .from(arLocalities)
    .where(isNull(arLocalities.removedAt));
  const catalogPopulated = Number(total?.count ?? 0) > 100;
  if (!catalogPopulated) {
    throw new Error(
      "arLocalities catalog is not populated (expected > 100 non-removed rows). " +
        "Run `pnpm db:bootstrap` (step 4 imports the INDEC catalog) before running " +
        "this suite — see jurisdiction-validation.test.ts for the same precondition.",
    );
  }
});

describe("resolveCanonicalTitleLocation", () => {
  it("resolves a well-known (province, locality) pair to its canonical names", async () => {
    const result = await resolveCanonicalTitleLocation({
      rawProvince: "Buenos Aires",
      rawLocality: "La Plata",
    });
    expect(result.province).toBe("Buenos Aires");
    expect(result.locality).toBe("La Plata");
  });

  it("resolves the province even when the locality is absent", async () => {
    const result = await resolveCanonicalTitleLocation({ rawProvince: "Buenos Aires" });
    expect(result.province).toBe("Buenos Aires");
    expect(result.locality).toBeNull();
  });

  // THE A03-G11 REGRESSION: before the fix, this string would have been
  // echoed straight into the page's <title> with no catalog check at all.
  it("drops an attacker-chosen locality that is not in the catalog", async () => {
    const result = await resolveCanonicalTitleLocation({
      rawProvince: "Buenos Aires",
      rawLocality: "<script>alert(1)</script> comprá viagra",
    });
    expect(result.province).toBe("Buenos Aires");
    expect(result.locality).toBeNull();
  });

  it("drops both province and locality when the province itself does not resolve", async () => {
    const result = await resolveCanonicalTitleLocation({
      rawProvince: "Narnia",
      rawLocality: "La Plata",
    });
    expect(result.province).toBeNull();
    expect(result.locality).toBeNull();
  });

  it("returns nulls when neither param is present", async () => {
    const result = await resolveCanonicalTitleLocation({});
    expect(result.province).toBeNull();
    expect(result.locality).toBeNull();
  });
});
