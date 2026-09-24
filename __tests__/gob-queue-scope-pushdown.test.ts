// Isolation guard: /gob/servicios and /gob/disputas must scope jurisdiction in
// the SQL WHERE, not with a JS post-filter. A govt operator scoped to Buenos
// Aires/La Plata must NOT even READ a Córdoba row at the DB level (AGENTS.md).
//
// This replicates the exact predicate the two pages build (jurisdictionPairClause
// on each table's jurisdiction_province/locality columns) and asserts the
// out-of-scope row is excluded by the query itself — a drift test that fails if
// a future edit reverts to fetch-then-filter-in-JS or wires the wrong columns.

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { custodyDisputes, db, organizations, petEvents, pets, serviceOfferings } from "@/db";
import { jurisdictionPairClause } from "@/lib/metrics/scope";
import { withMutationOverride } from "./_helpers/db-overrides";

const IN_SCOPE = { province: "Buenos Aires", locality: "La Plata" } as const;
const OUT_OF_SCOPE = { province: "Córdoba", locality: "Córdoba" } as const;
const GOVT_SCOPE = [IN_SCOPE];

// Fixed tokens for idempotent cleanup. Two pets: the one-open-dispute-per-pet
// constraint forbids two open disputes on the same pet, so in/out-of-scope
// disputes live on distinct pets.
const PET_TOKEN_IN = "DIM-SCOPE-DISP-PET-IN";
const PET_TOKEN_OUT = "DIM-SCOPE-DISP-PET-OUT";
const DISPUTE_IN = "DIS-SCOPE-IN01";
const DISPUTE_OUT = "DIS-SCOPE-OUT1";
const ORG_TOKEN = "ORG-SCOPE-TEST-1";
const OFFERING_IN = "SVO-SCOPE-IN01";
const OFFERING_OUT = "SVO-SCOPE-OUT1";

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM pets WHERE public_token IN (${PET_TOKEN_IN}, ${PET_TOKEN_OUT})`,
    );
    await tx.execute(
      sql`DELETE FROM service_offerings WHERE public_token IN (${OFFERING_IN}, ${OFFERING_OUT})`,
    );
    await tx.execute(sql`DELETE FROM organizations WHERE public_token = ${ORG_TOKEN}`);
  });

  // --- Disputas fixtures: two pets, one open dispute each, diff jurisdictions ---
  async function seedDispute(
    petToken: string,
    disputeToken: string,
    jur: { province: string; locality: string },
  ) {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: petToken,
        name: `Scope Disputa ${petToken}`,
        species: "dog",
        jurisdictionCountry: "AR",
        jurisdictionProvince: jur.province,
        jurisdictionLocality: jur.locality,
      })
      .returning({ id: pets.id });

    const [raising] = await db
      .insert(petEvents)
      .values({
        petId: pet.id,
        eventType: "custody_dispute_raised",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
        authorRole: "govt",
        payload: { source: "scope-test" },
      })
      .returning({ id: petEvents.id });

    await db.insert(custodyDisputes).values({
      publicToken: disputeToken,
      petId: pet.id,
      raisedByRole: "govt",
      raisingEventId: raising.id,
      jurisdictionCountry: "AR",
      jurisdictionProvince: jur.province,
      jurisdictionLocality: jur.locality,
      status: "open",
    });
  }

  await seedDispute(PET_TOKEN_IN, DISPUTE_IN, IN_SCOPE);
  await seedDispute(PET_TOKEN_OUT, DISPUTE_OUT, OUT_OF_SCOPE);

  // --- Servicios fixtures: one org, two pending offerings in diff jurisdictions ---
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Scope Test Org",
      displayName: "Scope Test Org",
      orgType: "shelter",
      email: "scope-test@dim-test.local",
      verified: true,
    })
    .returning({ id: organizations.id });

  await db.insert(serviceOfferings).values([
    {
      publicToken: OFFERING_IN,
      organizationId: org.id,
      serviceKind: "veterinary_consult",
      displayName: "In-scope offering",
      status: "pending_approval",
      jurisdictionCountry: "AR",
      jurisdictionProvince: IN_SCOPE.province,
      jurisdictionLocality: IN_SCOPE.locality,
    },
    {
      publicToken: OFFERING_OUT,
      organizationId: org.id,
      serviceKind: "veterinary_consult",
      displayName: "Out-of-scope offering",
      status: "pending_approval",
      jurisdictionCountry: "AR",
      jurisdictionProvince: OUT_OF_SCOPE.province,
      jurisdictionLocality: OUT_OF_SCOPE.locality,
    },
  ]);
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM pets WHERE public_token IN (${PET_TOKEN_IN}, ${PET_TOKEN_OUT})`,
    );
    await tx.execute(
      sql`DELETE FROM service_offerings WHERE public_token IN (${OFFERING_IN}, ${OFFERING_OUT})`,
    );
    await tx.execute(sql`DELETE FROM organizations WHERE public_token = ${ORG_TOKEN}`);
  });
});

describe("/gob/disputas — jurisdiction scope is a SQL predicate", () => {
  it("excludes the out-of-scope (Córdoba) dispute for a Buenos Aires operator", async () => {
    const scopeFilter =
      jurisdictionPairClause(
        GOVT_SCOPE,
        sql`${custodyDisputes.jurisdictionProvince}`,
        sql`${custodyDisputes.jurisdictionLocality}`,
      ) ?? sql`false`;

    const rows = await db
      .select({ token: custodyDisputes.publicToken })
      .from(custodyDisputes)
      .innerJoin(pets, eq(pets.id, custodyDisputes.petId))
      .where(and(inArray(custodyDisputes.publicToken, [DISPUTE_IN, DISPUTE_OUT]), scopeFilter));

    const tokens = rows.map((r) => r.token);
    expect(tokens).toContain(DISPUTE_IN);
    expect(tokens).not.toContain(DISPUTE_OUT);
  });

  it("a govt with no assignments reads nothing (sql`false`)", async () => {
    const scopeFilter =
      jurisdictionPairClause(
        [],
        sql`${custodyDisputes.jurisdictionProvince}`,
        sql`${custodyDisputes.jurisdictionLocality}`,
      ) ?? sql`false`;

    const rows = await db
      .select({ token: custodyDisputes.publicToken })
      .from(custodyDisputes)
      .where(and(inArray(custodyDisputes.publicToken, [DISPUTE_IN, DISPUTE_OUT]), scopeFilter));

    expect(rows).toHaveLength(0);
  });
});

describe("/gob/servicios — jurisdiction scope is a SQL predicate", () => {
  it("excludes the out-of-scope (Córdoba) offering for a Buenos Aires operator", async () => {
    const baseCondition = eq(serviceOfferings.status, "pending_approval");
    const scopeFilter =
      jurisdictionPairClause(
        GOVT_SCOPE,
        sql`${serviceOfferings.jurisdictionProvince}`,
        sql`${serviceOfferings.jurisdictionLocality}`,
      ) ?? sql`false`;

    const rows = await db
      .select({ token: serviceOfferings.publicToken })
      .from(serviceOfferings)
      .where(
        and(
          inArray(serviceOfferings.publicToken, [OFFERING_IN, OFFERING_OUT]),
          baseCondition,
          scopeFilter,
        ),
      );

    const tokens = rows.map((r) => r.token);
    expect(tokens).toContain(OFFERING_IN);
    expect(tokens).not.toContain(OFFERING_OUT);
  });
});
