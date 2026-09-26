// A10-3: a govt business rule's (province, locality) is resolved against the
// ar_localities catalog before it is stored.
//
// `resolveBusinessRule` matches a rule to a pet by EXACT string equality on
// `pets.jurisdiction_locality`, which the pet write paths store canonically.
// A rule stored as "palermo" therefore governed zero pets while /gob/reglas
// showed it as configured. normalizeJurisdiction used to be trim-only; these
// cases pin that it now canonicalizes, and refuses what it cannot resolve.
// Read-only against the catalog: nothing is written.

import { TransactionRollbackError, and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { arLocalities, authorityUnitLocalities, db, govtBusinessRules } from "@/db";
import { createBusinessRuleWriter } from "@/src/modules/organizations/application/business-rules/create-business-rule";
import {
  normalizeJurisdiction,
  normalizeRuleJurisdiction,
} from "@/src/modules/organizations/application/business-rules/normalize-jurisdiction";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("normalizeJurisdiction (business rules, A10-3)", () => {
  it("stores the catalog spelling of a lower-case locality", async () => {
    const result = await normalizeJurisdiction(
      form({ jurisdictionProvince: "CABA", jurisdictionLocality: "palermo" }),
    );
    expect(result).toEqual({
      ok: true,
      value: { country: "AR", province: "CABA", locality: "Palermo" },
    });
  });

  it("canonicalizes a province-only rule and keeps its locality null", async () => {
    const result = await normalizeJurisdiction(form({ jurisdictionProvince: "Cordoba" }));
    expect(result).toEqual({
      ok: true,
      value: { country: "AR", province: "Córdoba", locality: null },
    });
  });

  it("refuses a locality that is not in the catalog for that province", async () => {
    const result = await normalizeJurisdiction(
      form({ jurisdictionProvince: "CABA", jurisdictionLocality: "Paraje Sin Catalogo" }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a province that is not a province", async () => {
    const result = await normalizeJurisdiction(form({ jurisdictionProvince: "Narnia" }));
    expect(result.ok).toBe(false);
  });

  it("refuses a locality without a province (the cascade is province first)", async () => {
    const result = await normalizeJurisdiction(form({ jurisdictionLocality: "Palermo" }));
    expect(result.ok).toBe(false);
  });

  it("leaves a national rule national", async () => {
    const result = await normalizeJurisdiction(form({}));
    expect(result).toEqual({
      ok: true,
      value: { country: "AR", province: null, locality: null },
    });
  });
});

// ---------------------------------------------------------------------------
// localidades-por-id D4: the rule's place by id. A homonym is refused only
// when nothing tells the two apart; the picked row's INDEC id does, and a
// CONFIRMED authority unit keys the rule on the unit.
// ---------------------------------------------------------------------------

const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";

async function rowOf(indecId: string): Promise<string> {
  const [r] = await db
    .select({ id: arLocalities.id })
    .from(arLocalities)
    .where(eq(arLocalities.indecId, indecId));
  if (!r) throw new Error(`catalogue row ${indecId} missing`);
  return r.id;
}

describe("normalizeRuleJurisdiction — the place by id (D4)", () => {
  it("a homonym with no id is still refused; with the picked row's INDEC id it resolves that row", async () => {
    const refused = await normalizeRuleJurisdiction(
      form({ jurisdictionProvince: "Buenos Aires", jurisdictionLocality: "Mechita" }),
    );
    expect(refused.ok).toBe(false);

    const picked = await normalizeRuleJurisdiction(
      form({
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Mechita",
        jurisdictionLocalityIndecId: MECHITA_BRAGADO,
      }),
    );
    expect(picked).toEqual({
      ok: true,
      value: { country: "AR", province: "Buenos Aires", locality: "Mechita" },
      place: {
        localityId: await rowOf(MECHITA_BRAGADO),
        authorityUnitId: null,
        placeMethod: "indec_id",
      },
    });
  });

  it("a unit keys the rule only once confirmed, and only in its own province", async () => {
    const bragado = await rowOf(MECHITA_BRAGADO);
    const [membership] = await db
      .select({ unitId: authorityUnitLocalities.unitId })
      .from(authorityUnitLocalities)
      .where(
        and(
          eq(authorityUnitLocalities.localityId, bragado),
          eq(authorityUnitLocalities.level, "municipal"),
        ),
      );
    const unitId = membership?.unitId as string;
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`
          update public.authority_units set status = 'draft' where id = ${unitId}::uuid
        `);
        const draft = await normalizeRuleJurisdiction(
          form({ jurisdictionProvince: "Buenos Aires", jurisdictionUnitId: unitId }),
          tx,
        );
        expect(draft.ok).toBe(false);

        await tx.execute(sql`
          update public.authority_units set status = 'confirmed', confirmed_at = now()
           where id = ${unitId}::uuid
        `);
        const ok = await normalizeRuleJurisdiction(
          form({ jurisdictionProvince: "Buenos Aires", jurisdictionUnitId: unitId }),
          tx,
        );
        expect(ok.ok && ok.place).toEqual({
          localityId: null,
          authorityUnitId: unitId,
          placeMethod: null,
        });
        const elsewhere = await normalizeRuleJurisdiction(
          form({ jurisdictionProvince: "Córdoba", jurisdictionUnitId: unitId }),
          tx,
        );
        expect(elsewhere.ok).toBe(false);
        tx.rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof TransactionRollbackError)) throw e;
      });
  });
});

describe("createBusinessRuleWriter — two homonyms, two rules (migration 0263)", () => {
  const created: string[] = [];
  afterAll(async () => {
    if (created.length > 0) {
      await db.delete(govtBusinessRules).where(inArray(govtBusinessRules.id, created));
    }
  });

  it("Alberti's and Bragado's Mechita each carry their own rule; a second one on the same row is refused", async () => {
    const rows = await Promise.all([rowOf(MECHITA_ALBERTI), rowOf(MECHITA_BRAGADO)]);
    await db
      .delete(govtBusinessRules)
      .where(
        and(
          eq(govtBusinessRules.ruleType, "microchip_required"),
          inArray(govtBusinessRules.localityId, rows),
        ),
      );
    for (const localityId of rows) {
      const r = await createBusinessRuleWriter({
        actorUserId: null as unknown as string,
        ruleType: "microchip_required",
        jurisdictionCountry: "AR",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Mechita",
        rulePayload: { required: false },
        notes: null,
        legalAnchorIds: [],
        legalMetadata: { requirementLevel: "recommended" },
        place: { localityId, authorityUnitId: null, placeMethod: "indec_id" },
      });
      expect(r.ok && r.ruleId, JSON.stringify(r)).toBeTruthy();
      if (r.ok && r.ruleId) created.push(r.ruleId);
    }
    const again = await createBusinessRuleWriter({
      actorUserId: null as unknown as string,
      ruleType: "microchip_required",
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mechita",
      rulePayload: { required: false },
      notes: null,
      legalAnchorIds: [],
      legalMetadata: { requirementLevel: "recommended" },
      place: { localityId: rows[1] as string, authorityUnitId: null, placeMethod: "indec_id" },
    });
    expect(again.ok).toBe(false);
  });
});
