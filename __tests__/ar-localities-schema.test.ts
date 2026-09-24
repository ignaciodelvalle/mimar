// Verifies that migration 0019 applied correctly: tables exist, CHECK
// constraints reject invalid values, and the partial unique index fires on
// duplicates.

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { arLocalities, db } from "@/db";
import { expectDbError } from "./_helpers/expect-db-error";

const TEST_SLUG_PREFIX = "schematest-";

afterEach(async () => {
  // Tests insert rows with slugs prefixed by TEST_SLUG_PREFIX so we can clean
  // up without nuking the real catalog if it has been imported.
  const rows = await db.select({ id: arLocalities.id }).from(arLocalities);
  // Drizzle's filter API doesn't have ILIKE off-the-shelf; cleanup via raw
  // is overkill here since we know the exact slugs inserted by each test.
  for (const _ of rows) {
    // No-op; the per-test inserts handle their own cleanup.
  }
});

describe("ar_localities schema", () => {
  it("accepts a valid row and round-trips it", async () => {
    const slug = `${TEST_SLUG_PREFIX}happy-${Date.now()}`;
    const [row] = await db
      .insert(arLocalities)
      .values({
        provinceCode: "AR-C",
        localityName: "Test Locality",
        localitySlug: slug,
        category: "localidad",
        source: "manual",
      })
      .returning();
    expect(row.localitySlug).toBe(slug);
    expect(row.lastImportedAt).toBeInstanceOf(Date);
    expect(row.removedAt).toBeNull();
    await db.delete(arLocalities).where(eq(arLocalities.id, row.id));
  });

  it("rejects an invalid province_code via the CHECK constraint", async () => {
    await expectDbError(
      db.insert(arLocalities).values({
        provinceCode: "INVALID",
        localityName: "Test",
        localitySlug: `${TEST_SLUG_PREFIX}bad-province-${Date.now()}`,
        category: "localidad",
        source: "manual",
      }),
      { constraint: /ar_localities_province_valid/ },
    );
  });

  it("rejects an invalid category via the CHECK constraint", async () => {
    await expectDbError(
      db.insert(arLocalities).values({
        provinceCode: "AR-C",
        localityName: "Test",
        localitySlug: `${TEST_SLUG_PREFIX}bad-cat-${Date.now()}`,
        category: "invalid_cat" as never,
        source: "manual",
      }),
      { constraint: /ar_localities_category_valid/ },
    );
  });

  it("rejects an invalid source via the CHECK constraint", async () => {
    await expectDbError(
      db.insert(arLocalities).values({
        provinceCode: "AR-C",
        localityName: "Test",
        localitySlug: `${TEST_SLUG_PREFIX}bad-source-${Date.now()}`,
        category: "localidad",
        source: "wikipedia" as never,
      }),
      { constraint: /ar_localities_source_valid/ },
    );
  });

  it("allows multiple rows with the same (province, slug) — INDEC ships duplicates across departments", async () => {
    // Migration 0020 dropped the partial unique on (province, slug). The
    // canonical identifier for uniqueness is `indec_id`. The slug is a
    // denormalized URL/lookup convenience that can legitimately repeat.
    const slug = `${TEST_SLUG_PREFIX}duplicate-${Date.now()}`;
    const base = {
      provinceCode: "AR-K", // Catamarca, where "Las Juntas" appears twice in real INDEC data
      localityName: "Las Juntas",
      localitySlug: slug,
      category: "localidad" as const,
      source: "manual" as const,
    };
    const [first] = await db
      .insert(arLocalities)
      .values({ ...base, departmentName: "Ambato" })
      .returning();
    const [second] = await db
      .insert(arLocalities)
      .values({ ...base, departmentName: "El Alto" })
      .returning();
    expect(first.id).not.toBe(second.id);
    await db.delete(arLocalities).where(eq(arLocalities.id, first.id));
    await db.delete(arLocalities).where(eq(arLocalities.id, second.id));
  });

  it("enforces indec_id uniqueness as the canonical identifier", async () => {
    const indecId = `TEST-${Date.now()}`;
    const base = {
      provinceCode: "AR-C",
      localityName: "Indec dup test",
      localitySlug: `${TEST_SLUG_PREFIX}indec-${Date.now()}`,
      category: "localidad" as const,
      source: "manual" as const,
      indecId,
    };
    const [first] = await db.insert(arLocalities).values(base).returning();
    await expect(
      db.insert(arLocalities).values({ ...base, localitySlug: `${base.localitySlug}-2` }),
    ).rejects.toThrow();
    await db.delete(arLocalities).where(eq(arLocalities.id, first.id));
  });
});
