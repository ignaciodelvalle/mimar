// Audit filter dedupe-by-label parity (fences wave S #8).
//
// The /admin/auditoria (and /gob/historial) action filter is a <select>. Its
// options used to be `Object.entries(AUDIT_ACTION_LABELS)` — one <option> per
// CODE. But AUDIT_ACTION_LABELS deliberately maps several ALIAS codes to the SAME
// label (an old + a new code for one real action), so the dropdown rendered
// visibly DUPLICATE rows ("Revocación verificación org" twice, etc.). The fix is
// buildAuditActionOptions(), which is UNIQUE by visible label and carries every
// aliased code in the option value (comma-joined) so filtering still matches all
// of them via parseAuditActions()'s existing comma split. This test pins that.

import { describe, expect, it } from "vitest";

import { AUDIT_ACTION_LABELS } from "@/lib/ui/audit-action-labels";
import { buildAuditActionOptions, parseAuditActions } from "@/lib/ui/audit-filters";

describe("buildAuditActionOptions — unique by visible label", () => {
  const options = buildAuditActionOptions();

  it("emits no duplicate visible labels", () => {
    const labels = options.map((o) => o.label);
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
    expect(dupes, `duplicate labels: ${[...new Set(dupes)].join(", ")}`).toEqual([]);
    expect(new Set(labels).size).toBe(options.length);
  });

  it("has strictly fewer options than raw codes (aliases collapsed)", () => {
    const rawCodeCount = Object.keys(AUDIT_ACTION_LABELS).length;
    const distinctLabelCount = new Set(Object.values(AUDIT_ACTION_LABELS)).size;
    expect(options.length).toBe(distinctLabelCount);
    expect(options.length).toBeLessThan(rawCodeCount);
  });

  it("covers EVERY code exactly once across all option values", () => {
    const seen = new Map<string, number>();
    for (const opt of options) {
      for (const code of opt.value.split(",")) {
        seen.set(code, (seen.get(code) ?? 0) + 1);
      }
    }
    for (const code of Object.keys(AUDIT_ACTION_LABELS)) {
      expect(seen.get(code), `code ${code} missing from options`).toBe(1);
    }
    // No stray codes beyond the label map.
    expect(seen.size).toBe(Object.keys(AUDIT_ACTION_LABELS).length);
  });

  it("collapses a known alias pair into one option carrying both codes", () => {
    const orgRevocation = options.find((o) => o.label === "Revocación verificación org");
    expect(orgRevocation).toBeDefined();
    const codes = orgRevocation?.value.split(",") ?? [];
    expect(codes).toContain("revocation_org");
    expect(codes).toContain("revocation_org_verified");
  });

  it("every option value parses back to valid, in-map action codes", () => {
    for (const opt of options) {
      const parsed = parseAuditActions(opt.value);
      expect(parsed.length, `option "${opt.label}" (${opt.value}) parsed empty`).toBeGreaterThan(0);
      for (const code of parsed) expect(code in AUDIT_ACTION_LABELS).toBe(true);
    }
  });

  it("is sorted by label (es-AR)", () => {
    const labels = options.map((o) => o.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b, "es-AR"));
    expect(labels).toEqual(sorted);
  });
});
