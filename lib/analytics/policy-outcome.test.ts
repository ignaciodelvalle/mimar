// Unit tests for the policy→outcome loop (Task #44.2).
// Pure helpers + mapping completeness — no DB, no Next.js runtime — plus an
// integration block for fetchRuleChanges' jurisdiction scope (F3
// prerequisite / G1 posture), which needs real rows to prove the SQL filter.

import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { setAuditMutationGucs } from "@/__tests__/_helpers/db-overrides";
// The pure tests below only need GOVT_BUSINESS_RULE_TYPES, imported from the
// schema module directly rather than the "@/db" barrel. The integration
// block further down needs the barrel (auditLog, db) to seed/query real rows.
import { auditLog, db } from "@/db";
import { GOVT_BUSINESS_RULE_TYPES } from "@/db/schema";

import {
  POLICY_OUTCOME_K_ANON,
  POLICY_OUTCOME_MIN_AFTER_DAYS,
  POLICY_OUTCOME_WINDOW_DAYS,
  RULE_OUTCOME_METRICS,
  fetchRuleChanges,
  isDeltaUnstable,
  isSuppressedPair,
  outcomeDelta,
  windowsAround,
} from "./policy-outcome";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("RULE_OUTCOME_METRICS", () => {
  it("maps EVERY govt business rule type to an observed metric", () => {
    for (const ruleType of GOVT_BUSINESS_RULE_TYPES) {
      expect(RULE_OUTCOME_METRICS[ruleType]).toBeDefined();
      expect(RULE_OUTCOME_METRICS[ruleType].eventType.length).toBeGreaterThan(0);
      expect(RULE_OUTCOME_METRICS[ruleType].metricLabel.length).toBeGreaterThan(0);
    }
  });

  it("has no extra keys beyond the schema rule types", () => {
    expect(Object.keys(RULE_OUTCOME_METRICS).sort()).toEqual([...GOVT_BUSINESS_RULE_TYPES].sort());
  });
});

describe("windowsAround", () => {
  const changedAt = new Date("2026-03-01T00:00:00Z");

  it("builds symmetric full windows when the change is old enough", () => {
    const now = new Date(changedAt.getTime() + 90 * DAY_MS);
    const w = windowsAround(changedAt, now, 60);
    expect(w.before.since).toEqual(new Date(changedAt.getTime() - 60 * DAY_MS));
    expect(w.before.until).toEqual(changedAt);
    expect(w.after.since).toEqual(changedAt);
    expect(w.after.until).toEqual(new Date(changedAt.getTime() + 60 * DAY_MS));
    expect(w.afterDaysCovered).toBe(60);
    expect(w.partialAfter).toBe(false);
  });

  it("clamps the after-window to now and flags it partial", () => {
    const now = new Date(changedAt.getTime() + 20 * DAY_MS);
    const w = windowsAround(changedAt, now, 60);
    expect(w.after.until).toEqual(now);
    expect(w.afterDaysCovered).toBe(20);
    expect(w.partialAfter).toBe(true);
  });

  it("covers zero days for a change made right now", () => {
    const w = windowsAround(changedAt, changedAt, 60);
    expect(w.afterDaysCovered).toBe(0);
    expect(w.partialAfter).toBe(true);
  });

  it("defaults to the documented window constant", () => {
    const now = new Date(changedAt.getTime() + 365 * DAY_MS);
    const w = windowsAround(changedAt, now);
    expect(w.afterDaysCovered).toBe(POLICY_OUTCOME_WINDOW_DAYS);
  });
});

describe("outcomeDelta", () => {
  it("computes the percent movement with one decimal", () => {
    expect(outcomeDelta(40, 50)).toBe(25);
    expect(outcomeDelta(50, 40)).toBe(-20);
    expect(outcomeDelta(3, 4)).toBe(33.3);
  });

  it("returns null when the before-window has no baseline", () => {
    expect(outcomeDelta(0, 10)).toBeNull();
    expect(outcomeDelta(0, 0)).toBeNull();
  });

  it("returns 0 for no movement", () => {
    expect(outcomeDelta(7, 7)).toBe(0);
  });
});

describe("isSuppressedPair (k-anon)", () => {
  it("suppresses only when BOTH windows are under k", () => {
    expect(isSuppressedPair(2, 3)).toBe(true);
    expect(isSuppressedPair(0, 4)).toBe(true);
    expect(isSuppressedPair(5, 0)).toBe(false);
    expect(isSuppressedPair(2, 12)).toBe(false);
    expect(isSuppressedPair(10, 20)).toBe(false);
  });

  it("uses the documented k=5 default", () => {
    expect(POLICY_OUTCOME_K_ANON).toBe(5);
    expect(isSuppressedPair(4, 4)).toBe(true);
    expect(isSuppressedPair(5, 5)).toBe(false);
  });
});

describe("isDeltaUnstable (red-team-admin #15 — fresh-window guard)", () => {
  it("flags an after-window too fresh for the delta to mean anything", () => {
    // The reported regression: a rule changed hours ago → afterDaysCovered 0 →
    // any before>0 gives a spurious ≈-100%. Must be flagged unstable.
    expect(isDeltaUnstable(0)).toBe(true);
    expect(isDeltaUnstable(4)).toBe(true);
  });

  it("does NOT flag once the after-window covers the documented floor", () => {
    expect(POLICY_OUTCOME_MIN_AFTER_DAYS).toBe(5);
    expect(isDeltaUnstable(5)).toBe(false);
    expect(isDeltaUnstable(60)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchRuleChanges — jurisdiction scope (integration, F3 prerequisite / G1)
//
// The upcoming panorama timeline-markers feature calls fetchRuleChanges from
// /gob/panorama, where govt operators are jurisdiction-scoped. Before that
// caller exists, fetchRuleChanges must accept a scope and actually filter —
// an unfiltered fetch would leak other jurisdictions' rule history. These
// tests seed real audit_log rows (the fields the SQL filter reads live in
// payload->'jurisdiction', not a dedicated column) and assert on membership
// by auditId, since the local DB may already carry unrelated rule-change
// rows from other seeds.
// ---------------------------------------------------------------------------
describe("fetchRuleChanges — jurisdiction scope (integration)", () => {
  const seededIds: string[] = [];

  async function seedChange(province: string | null, locality: string | null) {
    const [row] = await db
      .insert(auditLog)
      .values({
        action: "govt_business_rule_created",
        payload: {
          ruleType: "ppp_breed_list",
          jurisdiction: { country: "AR", province, locality },
        },
      })
      .returning({ id: auditLog.id });
    seededIds.push(row.id);
    return row.id;
  }

  afterAll(async () => {
    if (seededIds.length > 0) {
      // audit_log is append-only (invariant #2) — the enforce_audit_log_
      // append_only trigger blocks DELETE unless the explicit test-cleanup
      // GUC bypass is set (mirrors __tests__/profile.test.ts deleteTestUser).
      await db.transaction(async (tx) => {
        await setAuditMutationGucs(tx);
        await tx.delete(auditLog).where(inArray(auditLog.id, seededIds));
      });
    }
  });

  it("province scope: includes national + own-province (any locality), excludes foreign province", async () => {
    const national = await seedChange(null, null);
    const ownProvince = await seedChange("Buenos Aires", null);
    const ownProvinceOtherLocality = await seedChange("Buenos Aires", "Mar del Plata");
    const foreign = await seedChange("Córdoba", null);

    const rows = await fetchRuleChanges(100, { province: "Buenos Aires" });
    const ids = rows.map((r) => r.auditId);

    expect(ids).toContain(national);
    expect(ids).toContain(ownProvince);
    expect(ids).toContain(ownProvinceOtherLocality);
    expect(ids).not.toContain(foreign);
  });

  it("province+locality scope: exact match + province-wide (locality null) + national, excludes other localities in the same province", async () => {
    const national = await seedChange(null, null);
    const provinceWide = await seedChange("Buenos Aires", null);
    const exactMatch = await seedChange("Buenos Aires", "La Plata");
    const otherLocality = await seedChange("Buenos Aires", "Mar del Plata");
    const foreign = await seedChange("Córdoba", "Córdoba Capital");

    const rows = await fetchRuleChanges(100, {
      province: "Buenos Aires",
      locality: "La Plata",
    });
    const ids = rows.map((r) => r.auditId);

    expect(ids).toContain(national);
    expect(ids).toContain(provinceWide);
    expect(ids).toContain(exactMatch);
    expect(ids).not.toContain(otherLocality);
    expect(ids).not.toContain(foreign);
  });

  it("B4: threads previousPayload/newPayload through from the audit payload", async () => {
    const [row] = await db
      .insert(auditLog)
      .values({
        action: "govt_business_rule_updated",
        payload: {
          ruleType: "ppp_breed_list",
          jurisdiction: { country: "AR", province: null, locality: null },
          previousPayload: { breeds: ["a"] },
          newPayload: { breeds: ["a", "b"] },
        },
      })
      .returning({ id: auditLog.id });
    seededIds.push(row.id);

    const rows = await fetchRuleChanges(100);
    const mine = rows.find((r) => r.auditId === row.id);
    expect(mine).toBeDefined();
    expect(mine?.previousPayload).toEqual({ breeds: ["a"] });
    expect(mine?.newPayload).toEqual({ breeds: ["a", "b"] });
    // Created rows (no previousPayload key) surface null, never undefined.
    const created = rows.find((r) => r.action === "govt_business_rule_created");
    if (created) expect(created.previousPayload).toBeNull();
  });

  it("national rules are always included under a scope — the honesty-critical branch", async () => {
    // A national rule must never disappear from a jurisdiction-scoped view:
    // it genuinely governs that jurisdiction too. Regression shape: a naive
    // `province = scope.province` filter (no OR IS NULL) would silently drop
    // it, understating what rules actually apply there.
    const national = await seedChange(null, null);

    const rows = await fetchRuleChanges(100, { province: "Chubut" });
    expect(rows.map((r) => r.auditId)).toContain(national);
  });

  it("unfiltered call keeps current behavior — platform-wide, no scope applied", async () => {
    const foreign = await seedChange("Tierra del Fuego", "Ushuaia");

    const rows = await fetchRuleChanges(100);
    expect(rows.map((r) => r.auditId)).toContain(foreign);
  });
});
