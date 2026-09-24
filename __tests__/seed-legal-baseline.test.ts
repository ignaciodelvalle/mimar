// DB-backed tests for scripts/seed-legal-baseline.ts (jurisdiction-compliance
// WU2, spec BD2/BD4/BD5/BD6).
//
// The four legal-liability guarantees pinned here:
//   1. A checksum/sign-off mismatch aborts BEFORE any write (fail-closed gate).
//   2. Re-running the same approved dataset is a no-op — no duplicate rows, no
//      audit noise (idempotency on the type+jurisdiction unique constraint).
//   3. Admin-authored rows (`baseline_version IS NULL`) are never clobbered.
//   4. Every seeded insert/update writes the SAME audit_log row shape the
//      console writers produce, so /admin/inteligencia B4 diffs and panorama
//      rule-change markers see baseline seeding as a rule change.
//
// Fixtures are locality-scoped under the LB-SEED- prefix (canonical province
// "Buenos Aires" — migration 0055 CHECK rejects non-canonical spellings), so
// they can never collide with real country/province-level rules.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, govtBusinessRules } from "@/db";
import {
  type LegalBaselineDataset,
  type LegalBaselineRow,
  legalBaselineDatasetSchema,
} from "../data/legal-baseline/schema";
import {
  BASELINE_SIGNOFF_DECISION,
  type BaselineSignoff,
  buildManifest,
  computeDatasetChecksum,
  isLocalSeedTarget,
  parsePgHost,
  runSeedLegalBaseline,
} from "../scripts/seed-legal-baseline";

const PREFIX = "LB-SEED-";
const PROVINCE = "Buenos Aires";
const LOC_A = `${PREFIX}A`;
const LOC_B = `${PREFIX}B`;
const LOC_ADMIN = `${PREFIX}ADMIN`;
const LOC_M3 = `${PREFIX}M3`;

const ROW_A: LegalBaselineRow = {
  ruleKey: "rabies_vaccination",
  jurisdiction: { country: "AR", province: PROVINCE, locality: LOC_A },
  requirementLevel: "mandatory",
  legalBasis: "Test Ley 1",
  authority: "Test Autoridad",
  sourceUrl: null,
  effectiveFrom: "2020-01-01",
  rulePayload: { frequency_months: 12 },
  reviewStatus: "pending_legal_review",
};

const ROW_B: LegalBaselineRow = {
  ruleKey: "microchip_required",
  jurisdiction: { country: "AR", province: PROVINCE, locality: LOC_B },
  requirementLevel: "not_regulated",
  legalBasis: "Test Ord. 2",
  authority: null,
  sourceUrl: null,
  effectiveFrom: null,
  // Write-both parity: not mandatory → required:false (spec OR5).
  rulePayload: { required: false },
  reviewStatus: "pending_legal_review",
};

function makeDataset(version: string, rows: LegalBaselineRow[]): LegalBaselineDataset {
  return { version, rows };
}

/** Manifest + matching sign-off + matching --approved-checksum for `dataset`. */
function approvalFor(dataset: LegalBaselineDataset) {
  const manifest = buildManifest(dataset);
  const signoff: BaselineSignoff = {
    version: dataset.version,
    sha256: manifest.sha256,
    engramDecision: BASELINE_SIGNOFF_DECISION,
    approvedBy: "test-po",
    approvedAt: "2026-08-16",
  };
  return { manifest, approvedChecksum: manifest.sha256, signoff };
}

async function seededRowCount(): Promise<number> {
  const rows = (await db.execute(sql`
    select count(*)::int as n from govt_business_rules
    where jurisdiction_locality like ${`${PREFIX}%`}
  `)) as unknown as Array<{ n: number }>;
  return rows[0].n;
}

async function auditRowsForRule(ruleId: string) {
  return db.select().from(auditLog).where(sql`${auditLog.payload}->>'ruleId' = ${ruleId}`);
}

async function ruleRowAt(locality: string) {
  const rows = await db
    .select()
    .from(govtBusinessRules)
    .where(sql`${govtBusinessRules.jurisdictionLocality} = ${locality}`);
  return rows;
}

async function cleanup(): Promise<void> {
  await db.execute(
    sql`delete from govt_business_rules where jurisdiction_locality like ${`${PREFIX}%`}`,
  );
  // audit_log is append-only — leftover rows reference deleted rule UUIDs and
  // every assertion here scopes by ruleId, so they cannot bleed across runs.
}

beforeAll(cleanup);
afterAll(cleanup);

describe("gate (spec BD4/BD5 — refusal before any write)", () => {
  it("refuses on --approved-checksum mismatch and writes nothing", async () => {
    const dataset = makeDataset("ar-v900", [ROW_A, ROW_B]);
    const { manifest, signoff } = approvalFor(dataset);
    const result = await runSeedLegalBaseline({
      db,
      dataset,
      manifest,
      approvedChecksum: "0".repeat(64),
      signoff,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.join("\n")).toContain("--approved-checksum");
    expect(await seededRowCount()).toBe(0);
  });

  it("refuses when the sign-off approves a different hash or decision", async () => {
    const dataset = makeDataset("ar-v900", [ROW_A]);
    const { manifest, approvedChecksum, signoff } = approvalFor(dataset);

    const staleHash = await runSeedLegalBaseline({
      db,
      dataset,
      manifest,
      approvedChecksum,
      signoff: { ...signoff, sha256: "f".repeat(64) },
    });
    expect(staleHash.ok).toBe(false);
    if (!staleHash.ok) expect(staleHash.refusals.join("\n")).toContain("changed after approval");

    const wrongDecision = await runSeedLegalBaseline({
      db,
      dataset,
      manifest,
      approvedChecksum,
      signoff: { ...signoff, engramDecision: "sdd/other/decision" },
    });
    expect(wrongDecision.ok).toBe(false);

    const noSignoff = await runSeedLegalBaseline({
      db,
      dataset,
      manifest,
      approvedChecksum,
      signoff: null,
    });
    expect(noSignoff.ok).toBe(false);

    expect(await seededRowCount()).toBe(0);
  });

  it("refuses when the dataset drifted from its manifest", async () => {
    const approved = makeDataset("ar-v900", [ROW_A]);
    const { manifest, signoff } = approvalFor(approved);
    const drifted = makeDataset("ar-v900", [
      { ...ROW_A, legalBasis: "Test Ley 1 (edited after approval)" },
    ]);
    const result = await runSeedLegalBaseline({
      db,
      dataset: drifted,
      manifest,
      approvedChecksum: computeDatasetChecksum(drifted),
      signoff,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.join("\n")).toContain("manifest checksum mismatch");
    expect(await seededRowCount()).toBe(0);
  });
});

describe("seeding (spec BD2/BD3/BD6)", () => {
  it("fresh seed inserts rows with baseline_version + console-shaped audit rows, and a re-run is a silent no-op", async () => {
    const dataset = makeDataset("ar-v900", [ROW_A, ROW_B]);
    const approval = approvalFor(dataset);

    const first = await runSeedLegalBaseline({ db, dataset, ...approval });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.summary.inserted).toHaveLength(2);
    expect(first.summary.updated).toHaveLength(0);
    expect(first.summary.protectedRows).toHaveLength(0);

    // Row content — tier + provenance columns + origin badge (BD3).
    const [rowA] = await ruleRowAt(LOC_A);
    expect(rowA).toBeDefined();
    expect(rowA.ruleType).toBe("rabies_vaccination");
    expect(rowA.requirementLevel).toBe("mandatory");
    expect(rowA.legalBasis).toBe("Test Ley 1");
    expect(rowA.authority).toBe("Test Autoridad");
    expect(rowA.effectiveFrom).toBe("2020-01-01");
    expect(rowA.baselineVersion).toBe("ar-v900");
    expect(rowA.rulePayload).toEqual({ frequency_months: 12 });

    const [rowB] = await ruleRowAt(LOC_B);
    expect(rowB.requirementLevel).toBe("not_regulated");
    expect(rowB.rulePayload).toEqual({ required: false });
    expect(rowB.baselineVersion).toBe("ar-v900");

    // Audit rows in the exact console writer shape (BD6 — B4 diff visible).
    const auditsA = await auditRowsForRule(rowA.id);
    expect(auditsA).toHaveLength(1);
    expect(auditsA[0].action).toBe("govt_business_rule_created");
    const payloadA = auditsA[0].payload as Record<string, unknown>;
    expect(payloadA.ruleType).toBe("rabies_vaccination");
    expect(payloadA.jurisdiction).toEqual({
      country: "AR",
      province: PROVINCE,
      locality: LOC_A,
    });
    expect(payloadA.newPayload).toEqual({ frequency_months: 12 });
    // Same 6-key metadata object create-business-rule.ts audits — no extras.
    expect(payloadA.newLegalMetadata).toEqual({
      requirementLevel: "mandatory",
      legalBasis: "Test Ley 1",
      authority: "Test Autoridad",
      sourceUrl: null,
      effectiveFrom: "2020-01-01",
      effectiveUntil: null,
    });

    // Idempotent re-run (BD2): no duplicates, no state change, no audit noise.
    const second = await runSeedLegalBaseline({ db, dataset, ...approval });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.summary.inserted).toHaveLength(0);
    expect(second.summary.updated).toHaveLength(0);
    expect(second.summary.unchanged).toHaveLength(2);
    expect(await seededRowCount()).toBe(2);
    expect(await auditRowsForRule(rowA.id)).toHaveLength(1);
    expect(await auditRowsForRule(rowB.id)).toHaveLength(1);
  });

  it("a new dataset version updates seeded rows and audits previous→new metadata", async () => {
    const v2 = makeDataset("ar-v901", [{ ...ROW_A, legalBasis: "Test Ley 1 modificada" }, ROW_B]);
    const result = await runSeedLegalBaseline({ db, dataset: v2, ...approvalFor(v2) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both rows take the new version tag (ROW_B content is identical but its
    // baseline_version changes — a real, auditable re-application).
    expect(result.summary.updated).toHaveLength(2);
    expect(await seededRowCount()).toBe(2);

    const [rowA] = await ruleRowAt(LOC_A);
    expect(rowA.legalBasis).toBe("Test Ley 1 modificada");
    expect(rowA.baselineVersion).toBe("ar-v901");

    const audits = await auditRowsForRule(rowA.id);
    expect(audits).toHaveLength(2);
    const updateAudit = audits.find((a) => a.action === "govt_business_rule_updated");
    expect(updateAudit).toBeDefined();
    const payload = updateAudit?.payload as Record<string, Record<string, unknown>>;
    expect(payload.previousLegalMetadata.legalBasis).toBe("Test Ley 1");
    expect(payload.newLegalMetadata.legalBasis).toBe("Test Ley 1 modificada");
    expect(payload.previousPayload).toEqual({ frequency_months: 12 });
    expect(payload.newPayload).toEqual({ frequency_months: 12 });
  });

  it("never clobbers an admin-authored row (baseline_version IS NULL)", async () => {
    // Admin-authored row inserted directly (as the console writer would).
    const [adminRow] = await db
      .insert(govtBusinessRules)
      .values({
        jurisdictionCountry: "AR",
        jurisdictionProvince: PROVINCE,
        jurisdictionLocality: LOC_ADMIN,
        ruleType: "sterilization",
        rulePayload: { min_age_months: 6 },
        requirementLevel: "recommended",
        legalBasis: "Admin basis",
        baselineVersion: null,
      })
      .returning();

    const dataset = makeDataset("ar-v902", [
      {
        ruleKey: "sterilization",
        jurisdiction: { country: "AR", province: PROVINCE, locality: LOC_ADMIN },
        requirementLevel: "mandatory",
        legalBasis: "Baseline basis that must NOT win",
        authority: null,
        sourceUrl: null,
        effectiveFrom: null,
        rulePayload: { min_age_months: 12 },
        reviewStatus: "pending_legal_review",
      },
    ]);
    const result = await runSeedLegalBaseline({ db, dataset, ...approvalFor(dataset) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.protectedRows).toHaveLength(1);
    expect(result.summary.inserted).toHaveLength(0);
    expect(result.summary.updated).toHaveLength(0);

    const [after] = await ruleRowAt(LOC_ADMIN);
    expect(after.id).toBe(adminRow.id);
    expect(after.requirementLevel).toBe("recommended");
    expect(after.legalBasis).toBe("Admin basis");
    expect(after.rulePayload).toEqual({ min_age_months: 6 });
    expect(after.baselineVersion).toBeNull();
    // The seed wrote no audit row for the protected rule.
    expect(await auditRowsForRule(adminRow.id)).toHaveLength(0);
  });

  // T6 review M3: the console's update writer now CLEARS baseline_version (the
  // detach is pinned end-to-end in __tests__/business-rules-flow.test.ts —
  // "clears baseline_version on edit"). This asserts the consequence the seed
  // owns: once detached, a legal reviewer's correction to a row THIS seed wrote
  // survives a re-run of the very same version, instead of being silently
  // reverted with an audit row that looks like routine seed maintenance.
  it("an admin correction to a SEEDED row survives a re-run of the same version (M3)", async () => {
    const dataset = makeDataset("ar-v903", [
      { ...ROW_A, jurisdiction: { country: "AR", province: PROVINCE, locality: LOC_M3 } },
    ]);
    const first = await runSeedLegalBaseline({ db, dataset, ...approvalFor(dataset) });
    expect(first.ok).toBe(true);
    const [seeded] = await ruleRowAt(LOC_M3);
    expect(seeded.baselineVersion).toBe("ar-v903");

    // What updateBusinessRuleWriter does when a reviewer corrects the citation:
    // new value + baseline detach in the same statement.
    await db
      .update(govtBusinessRules)
      .set({ legalBasis: "Corrección del revisor legal", baselineVersion: null })
      .where(sql`${govtBusinessRules.id} = ${seeded.id}`);

    const second = await runSeedLegalBaseline({ db, dataset, ...approvalFor(dataset) });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.summary.protectedRows).toHaveLength(1);
    expect(second.summary.updated).toHaveLength(0);

    const [after] = await ruleRowAt(LOC_M3);
    expect(after.legalBasis).toBe("Corrección del revisor legal");
    expect(after.baselineVersion).toBeNull();
  });
});

describe("dataset schema fences", () => {
  it("rejects a microchip row whose boolean disagrees with its tier (write-both parity, OR5)", () => {
    const parsed = legalBaselineDatasetSchema.safeParse(
      makeDataset("ar-v900", [
        { ...ROW_B, requirementLevel: "not_regulated", rulePayload: { required: true } },
      ]),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate (rule_key, jurisdiction) tuples before the DB ever sees them", () => {
    const parsed = legalBaselineDatasetSchema.safeParse(makeDataset("ar-v900", [ROW_A, ROW_A]));
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-canonical province spelling (migration 0055 CHECK parity)", () => {
    const parsed = legalBaselineDatasetSchema.safeParse(
      makeDataset("ar-v900", [
        {
          ...ROW_A,
          jurisdiction: {
            country: "AR",
            province: "Ciudad Autónoma de Buenos Aires",
            locality: null,
          },
        },
      ]),
    );
    expect(parsed.success).toBe(false);
  });
});

// T6 review M6: the target guard used to FAIL OPEN. Its host regex required an
// `@`, so a credential-less DSN (auth via PGPASSWORD / .pgpass / client cert)
// parsed to null, and null was treated as "local" — a remote DB could receive
// the legal baseline without anyone passing --allow-remote.
describe("seed target guard (M6 — fail closed)", () => {
  it("recognises the local hosts, with or without credentials in the DSN", () => {
    expect(isLocalSeedTarget("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).toBe(true);
    expect(isLocalSeedTarget("postgresql://localhost:5432/dim")).toBe(true);
    expect(isLocalSeedTarget("postgres://host.docker.internal:5432/dim")).toBe(true);
    expect(isLocalSeedTarget("postgresql://[::1]:5432/dim")).toBe(true);
  });

  it("a CREDENTIAL-LESS remote DSN is NOT local (the fail-open hole)", () => {
    expect(isLocalSeedTarget("postgresql://prod-db.example.com:5432/dim")).toBe(false);
    expect(parsePgHost("postgresql://prod-db.example.com:5432/dim")).toBe("prod-db.example.com");
  });

  it("a remote DSN with credentials is NOT local", () => {
    expect(isLocalSeedTarget("postgresql://u:p@db.prod.supabase.co:5432/postgres")).toBe(false);
  });

  it("an UNPARSEABLE DSN is NOT local — cannot prove local means the gate applies", () => {
    expect(isLocalSeedTarget("")).toBe(false);
    expect(isLocalSeedTarget("not-a-url")).toBe(false);
    expect(isLocalSeedTarget("mysql://127.0.0.1:3306/dim")).toBe(false);
  });
});
