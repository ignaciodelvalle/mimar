// Integration tests for listCasesForOrg SQL filter push-down (ARCH-M).
//
// Verifies that:
//   1. kind filter is applied in SQL — returns only matching rows.
//   2. status filter (open/closed) is applied in SQL — closedAt IS NULL / NOT NULL.
//   3. A case beyond the first N rows (limit injected via _limitOverride) is
//      still returned when it matches a kind/status filter. This is the
//      regression guard for the previous in-memory filter + LIMIT 200 bug.
//   4. listCaseKindDistributionForOrg returns the distinct kinds for the org.
//   5. truncated flag is set only when the deduplicated result set hits the cap.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, organizations, pets } from "@/db";
import { closeCase, openCase } from "@/lib/infra/case-helpers";
import { listCaseKindDistributionForOrg, listCasesForOrg } from "@/lib/infra/case-queries";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const ORG_TOKEN = "DIM-ARCH-M-ORG1";
const PET_TOKEN_A = "DIM-ARCH-M-PA1";
const PET_TOKEN_B = "DIM-ARCH-M-PA2";

let orgId: string;
let petAId: string;
let petBId: string;

// Track all case IDs inserted by this suite for cleanup.
const insertedCaseIds: string[] = [];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean up any leftover data from prior runs (idempotent).
  await withMutationOverride(async (tx) => {
    // Null-out FK references before deleting to satisfy RESTRICT constraints.
    await tx.execute(sql`
      UPDATE cases SET welfare_report_id = NULL
      WHERE opened_by_organization_id IN (
        SELECT id FROM organizations WHERE public_token = ${ORG_TOKEN}
      )
    `);
    await tx.execute(sql`
      DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token IN (${PET_TOKEN_A}, ${PET_TOKEN_B})
      )
    `);
    await tx.execute(sql`
      DELETE FROM cases WHERE opened_by_organization_id IN (
        SELECT id FROM organizations WHERE public_token = ${ORG_TOKEN}
      )
    `);
    await tx.execute(sql`
      DELETE FROM pets WHERE public_token IN (${PET_TOKEN_A}, ${PET_TOKEN_B})
    `);
    await tx.execute(sql`
      DELETE FROM organizations WHERE public_token = ${ORG_TOKEN}
    `);
  });

  // Insert org.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Org ARCH-M Test SRL",
      displayName: "Org ARCH-M",
      orgType: "shelter",
      email: "arch-m@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  // Insert two pets (for pet-subject cases).
  const [petA] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_A,
      name: "ArchM PetA",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petAId = petA.id;

  const [petB] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_B,
      name: "ArchM PetB",
      species: "cat",
      sex: "female",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petBId = petB.id;

  // Open cases of different kinds:
  //   - bite_incident (general subject, opened by org) — will be closed in tests
  //   - lost_pet_episode (pet subject) opened by org
  //   - adoption_listing (pet subject) opened by org
  const biteCase = await openCase({
    kind: "bite_incident",
    primarySubjectKind: "general",
    openedByOrganizationId: orgId,
    openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
  });
  insertedCaseIds.push(biteCase.id);

  const lostCase = await openCase({
    kind: "lost_pet_episode",
    primarySubjectKind: "registered_pet",
    primaryPetId: petAId,
    openedByOrganizationId: orgId,
    openedReason: { code: "pet_marked_lost", petPublicToken: null, ownerNote: "episodio ARCH-M" },
  });
  insertedCaseIds.push(lostCase.id);

  const adoptionCase = await openCase({
    kind: "adoption_listing",
    primarySubjectKind: "registered_pet",
    primaryPetId: petBId,
    openedByOrganizationId: orgId,
    openedReason: { code: "adoption_listing_opened" },
  });
  insertedCaseIds.push(adoptionCase.id);

  // Close the bite_incident so we can test the closed status filter.
  await closeCase({ caseId: biteCase.id, reason: "resolved" });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const id of insertedCaseIds) {
      // Null welfare_report_id FK before deleting to avoid RESTRICT violation.
      await tx.execute(sql`UPDATE cases SET welfare_report_id = NULL WHERE id = ${id}`);
      await tx.execute(sql`DELETE FROM cases WHERE id = ${id}`);
    }
    await tx.execute(sql`
      DELETE FROM pets WHERE public_token IN (${PET_TOKEN_A}, ${PET_TOKEN_B})
    `);
    await tx.execute(sql`
      DELETE FROM organizations WHERE public_token = ${ORG_TOKEN}
    `);
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listCasesForOrg — no filters", () => {
  it("returns all cases for the org", async () => {
    const { items } = await listCasesForOrg(orgId);
    const ids = new Set(items.map((c) => c.id));
    for (const id of insertedCaseIds) {
      expect(ids.has(id), `case ${id} should appear in unfiltered list`).toBe(true);
    }
  });

  it("truncated is false when results fit within the limit", async () => {
    const { truncated } = await listCasesForOrg(orgId);
    expect(truncated).toBe(false);
  });
});

describe("listCasesForOrg — kind filter (SQL push-down)", () => {
  it("returns only bite_incident cases when kind=bite_incident", async () => {
    const { items } = await listCasesForOrg(orgId, { kind: "bite_incident" });
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const c of items) {
      expect(c.caseKind).toBe("bite_incident");
    }
  });

  it("returns only lost_pet_episode cases when kind=lost_pet_episode", async () => {
    const { items } = await listCasesForOrg(orgId, { kind: "lost_pet_episode" });
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const c of items) {
      expect(c.caseKind).toBe("lost_pet_episode");
    }
  });

  it("returns only adoption_listing cases when kind=adoption_listing", async () => {
    const { items } = await listCasesForOrg(orgId, { kind: "adoption_listing" });
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const c of items) {
      expect(c.caseKind).toBe("adoption_listing");
    }
  });
});

describe("listCasesForOrg — status filter (SQL push-down)", () => {
  it("returns only open cases when status=open", async () => {
    const { items } = await listCasesForOrg(orgId, { status: "open" });
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const c of items) {
      expect(c.closedAt).toBeNull();
    }
    // The closed bite_incident must NOT appear.
    const hasClosedBite = items.some((c) => c.caseKind === "bite_incident" && c.closedAt !== null);
    expect(hasClosedBite).toBe(false);
  });

  it("returns only closed cases when status=closed", async () => {
    const { items } = await listCasesForOrg(orgId, { status: "closed" });
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const c of items) {
      expect(c.closedAt).not.toBeNull();
    }
    // Every open case (lost, adoption) must NOT appear.
    const hasOpenCase = items.some((c) => c.closedAt === null);
    expect(hasOpenCase).toBe(false);
  });
});

describe("listCasesForOrg — combined kind + status filter", () => {
  it("kind=bite_incident + status=closed returns only the closed bite", async () => {
    const { items } = await listCasesForOrg(orgId, {
      kind: "bite_incident",
      status: "closed",
    });
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const c of items) {
      expect(c.caseKind).toBe("bite_incident");
      expect(c.closedAt).not.toBeNull();
    }
  });

  it("kind=bite_incident + status=open returns empty (bite is closed)", async () => {
    const { items } = await listCasesForOrg(orgId, {
      kind: "bite_incident",
      status: "open",
    });
    // The bite_incident was closed in beforeAll — it must not appear here.
    const hasBite = items.some((c) => c.caseKind === "bite_incident");
    expect(hasBite).toBe(false);
  });
});

describe("listCasesForOrg — filter beyond cap (_limitOverride)", () => {
  it("a case inserted at position > limit is found when kind filter matches", async () => {
    // Inject a limit of 2. We have 3 cases. The oldest case (adoption_listing,
    // inserted last in beforeAll and therefore sorted last by openedAt DESC)
    // would be position 3 — beyond the cap of 2.
    // With the filter pushed into SQL the query only considers matching rows,
    // so LIMIT 2 is applied AFTER filtering — the adoption case must appear.
    const { items } = await listCasesForOrg(
      orgId,
      { kind: "adoption_listing" },
      2, // _limitOverride
    );
    const found = items.some((c) => c.caseKind === "adoption_listing");
    expect(found, "adoption_listing case must be found even with limit=2").toBe(true);
  });

  it("truncated flag is true when the filtered+deduped result set exceeds the override", async () => {
    // Insert 2 extra open bite_incidents (general subject — no pet, avoids the
    // cases_open_per_pet_kind_idx unique constraint) so we have 2 open bite
    // cases visible to the org. The bite from beforeAll is already closed.
    // With limit=1 the query fetches limit+1=2 rows → deduped.length > 1 → truncated=true.
    const extra1 = await openCase({
      kind: "bite_incident",
      primarySubjectKind: "general",
      openedByOrganizationId: orgId,
      openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
    });
    const extra2 = await openCase({
      kind: "bite_incident",
      primarySubjectKind: "general",
      openedByOrganizationId: orgId,
      openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
    });

    try {
      // status=open filters out the closed bite from beforeAll.
      // We now have 2 open bite_incidents; limit=1 → truncated.
      const { truncated } = await listCasesForOrg(
        orgId,
        { kind: "bite_incident", status: "open" },
        1, // _limitOverride — only 1 result allowed; 2 open bite_incidents exist
      );
      expect(truncated).toBe(true);
    } finally {
      await db.delete(cases).where(eq(cases.id, extra1.id));
      await db.delete(cases).where(eq(cases.id, extra2.id));
    }
  });
});

// The listOpenCasesForAdminPreview / listOpenCasesForGovtPreview blocks that
// used to sit here went with the functions (demo review 2026-08-01): their
// only caller, the /gob "Casos regulatorios" tile, now counts through
// countCasesForGovt / countCasesForAdmin — the same functions /gob/casos uses
// — because the preview pair's predicate silently disagreed with the queue's
// (38 on the tile, "32 casos" on the screen it linked to). The behaviour those
// tests protected (SQL-side cap, separate total, empty scope → 0) lives on in
// the count/list pair and its own tests.

describe("listCaseKindDistributionForOrg", () => {
  it("returns all distinct case kinds the org has", async () => {
    const kinds = await listCaseKindDistributionForOrg(orgId);
    expect(kinds).toContain("bite_incident");
    expect(kinds).toContain("lost_pet_episode");
    expect(kinds).toContain("adoption_listing");
  });

  it("includes closed case kinds in the distribution", async () => {
    // The bite_incident was closed — it must still appear in the distribution.
    const kinds = await listCaseKindDistributionForOrg(orgId);
    expect(kinds).toContain("bite_incident");
  });

  it("returns an empty array for an org with no cases", async () => {
    // Insert a temporary org with no cases.
    const [tempOrg] = await db
      .insert(organizations)
      .values({
        publicToken: "DIM-ARCH-M-EMPTY",
        legalName: "Org Empty Test SRL",
        displayName: "Org Empty",
        orgType: "shelter",
        email: "arch-m-empty@dim-test.local",
        verified: true,
      })
      .returning();
    try {
      const kinds = await listCaseKindDistributionForOrg(tempOrg.id);
      expect(kinds).toHaveLength(0);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, tempOrg.id));
    }
  });
});
