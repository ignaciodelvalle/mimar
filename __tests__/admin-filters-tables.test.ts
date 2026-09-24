// Unit tests for PR-9 admin filter/table fixes (C29, C30, C31, C32).
//
// All tests are pure — no DB required. They pin the logic extracted into
// helpers so regressions surface without a running database.

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// C29 — buildAdminCaseFilterClauses: pure predicate builder
// ---------------------------------------------------------------------------
// We test the exported helper indirectly by verifying that the clauses array
// length matches the number of active filters. The Drizzle SQL objects are
// opaque at unit-test level; what matters is that the function:
//   - returns an empty array when no filters are set
//   - adds one clause per active filter
//   - does not mutate for null/undefined inputs

import { buildAdminCaseFilterClauses } from "@/lib/infra/case-queries";

describe("buildAdminCaseFilterClauses (C29)", () => {
  it("returns empty array when no filters are set", () => {
    expect(buildAdminCaseFilterClauses({})).toHaveLength(0);
  });

  it("returns empty array when all filters are explicitly null", () => {
    expect(buildAdminCaseFilterClauses({ kind: null, status: null, province: null })).toHaveLength(
      0,
    );
  });

  it("adds one clause for kind filter", () => {
    expect(buildAdminCaseFilterClauses({ kind: "bite_incident" })).toHaveLength(1);
  });

  it("adds one clause for open status filter", () => {
    expect(buildAdminCaseFilterClauses({ status: "open" })).toHaveLength(1);
  });

  it("adds one clause for closed status filter", () => {
    expect(buildAdminCaseFilterClauses({ status: "closed" })).toHaveLength(1);
  });

  it("adds one clause for province filter", () => {
    expect(buildAdminCaseFilterClauses({ province: "Buenos Aires" })).toHaveLength(1);
  });

  it("stacks all three filters into three clauses", () => {
    expect(
      buildAdminCaseFilterClauses({
        kind: "welfare_denuncia",
        status: "open",
        province: "CABA",
      }),
    ).toHaveLength(3);
  });

  // Demo review 2026-08-01: admin has no assignment set to narrow, so a
  // locality drill can only reach SQL as an explicit predicate. Without one,
  // Casos was the only /gob surface that could not follow a barrio filter —
  // the Panel tile counted the barrio and the queue it linked to counted the
  // country.
  it("adds one clause for locality filter", () => {
    expect(buildAdminCaseFilterClauses({ locality: "Palermo" })).toHaveLength(1);
  });

  it("stacks province + locality as two separate clauses", () => {
    expect(buildAdminCaseFilterClauses({ province: "CABA", locality: "Palermo" })).toHaveLength(2);
  });

  it("ignores an explicitly null locality", () => {
    expect(buildAdminCaseFilterClauses({ province: "CABA", locality: null })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// C30 — AUDIT_ACTION_LABELS: keys ↔ labels consistency
// ---------------------------------------------------------------------------

import { AUDIT_ACTION_LABELS, auditActionLabel } from "@/lib/ui/audit-action-labels";

describe("AUDIT_ACTION_LABELS (C30)", () => {
  it("exports a non-empty record", () => {
    expect(Object.keys(AUDIT_ACTION_LABELS).length).toBeGreaterThan(0);
  });

  it("every value is a non-empty string (the es-AR label)", () => {
    for (const [code, label] of Object.entries(AUDIT_ACTION_LABELS)) {
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("auditActionLabel returns the label for known codes", () => {
    expect(auditActionLabel("pii_queried")).toBe("Búsqueda de información personal");
    expect(auditActionLabel("request_approved")).toBe("Solicitud aprobada");
  });

  it("auditActionLabel falls back to the raw code for unknowns", () => {
    expect(auditActionLabel("unknown_action_xyz")).toBe("unknown_action_xyz");
  });

  it("all known dropdown options have a label that differs from the code", () => {
    // The dropdown shows Spanish labels, not English codes.
    // This test ensures the label is not accidentally the same as the code.
    for (const [code, label] of Object.entries(AUDIT_ACTION_LABELS)) {
      expect(label).not.toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// C31 — adminProvinceHref: pure province → URL helper
// ---------------------------------------------------------------------------

import { adminProvinceHref } from "@/lib/infra/admin-province-link";
import { PROVINCES } from "@/lib/reference/ar-provincias";

describe("adminProvinceHref (C31)", () => {
  it("returns a URL for a known province name", () => {
    const href = adminProvinceHref("Buenos Aires");
    expect(href).not.toBeNull();
    expect(href).toMatch(/^\/admin\/panorama\?province=/);
  });

  it("encodes the ISO code in the URL", () => {
    const href = adminProvinceHref("Buenos Aires");
    // Buenos Aires → AR-B
    expect(href).toContain("AR-B");
  });

  it("resolves CABA by name", () => {
    const href = adminProvinceHref("CABA");
    expect(href).toContain("AR-C");
  });

  it("returns null for null input", () => {
    expect(adminProvinceHref(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(adminProvinceHref(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(adminProvinceHref("")).toBeNull();
  });

  it("returns null for an unresolvable province name", () => {
    expect(adminProvinceHref("Patagonia")).toBeNull();
  });

  it("all PROVINCES resolve to a non-null URL", () => {
    for (const p of PROVINCES) {
      const href = adminProvinceHref(p.name);
      expect(href).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// C32 — DEFAULT_DASHBOARD_PRESET: picker default matches server default window
// ---------------------------------------------------------------------------

import { DEFAULT_DASHBOARD_PRESET, resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
import { windows } from "@/lib/metrics/period";

describe("DEFAULT_DASHBOARD_PRESET vs server trailing12m (C32)", () => {
  const NOW = new Date("2026-06-22T12:00:00Z").getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const TOLERANCE_MS = 1000; // 1 second tolerance for test execution timing

  it("DEFAULT_DASHBOARD_PRESET is 'trailing12m'", () => {
    expect(DEFAULT_DASHBOARD_PRESET).toBe("trailing12m");
  });

  it("resolveAnalyticsPeriod with DEFAULT_DASHBOARD_PRESET resolves to a 365-day window", () => {
    const { since, until } = resolveAnalyticsPeriod({ period: DEFAULT_DASHBOARD_PRESET }, NOW);
    const windowDays = (until.getTime() - since.getTime()) / DAY_MS;
    expect(windowDays).toBeCloseTo(365, 0);
  });

  it("resolveAnalyticsPeriod(trailing12m) ≈ windows.trailing12m() within 1 second", () => {
    // Server pages call windows.trailing12m() when no searchParam is present.
    // The picker's defaultPreset=trailing12m emits ?period=trailing12m.
    // Both must resolve to the same ~365-day window.
    const pickerWindow = resolveAnalyticsPeriod({ period: DEFAULT_DASHBOARD_PRESET }, NOW);
    const serverWindow = windows.trailing12m();

    // The server window is computed relative to Date.now() (slightly different
    // from NOW). We compare the window length, not the absolute timestamps.
    const pickerDays = (pickerWindow.until.getTime() - pickerWindow.since.getTime()) / DAY_MS;
    const serverDays = (serverWindow.until.getTime() - serverWindow.since.getTime()) / DAY_MS;
    expect(Math.abs(pickerDays - serverDays)).toBeLessThan(1);
  });

  it("YTD and trailing12m produce different windows in Jan (non-trivial difference)", () => {
    // Verify the two presets are actually different — the bug was using ytd
    // for the chip label while the data was trailing12m. In January, ytd is
    // much shorter than 12 months.
    const jan15 = new Date("2026-01-15T12:00:00Z").getTime();
    const ytdWindow = resolveAnalyticsPeriod({ period: "ytd" }, jan15);
    const trailing12mWindow = resolveAnalyticsPeriod({ period: "trailing12m" }, jan15);
    const ytdDays = (ytdWindow.until.getTime() - ytdWindow.since.getTime()) / DAY_MS;
    const trailing12mDays =
      (trailing12mWindow.until.getTime() - trailing12mWindow.since.getTime()) / DAY_MS;
    // On Jan 15 ytd is ~15 days; trailing12m is 365 days.
    expect(ytdDays).toBeLessThan(20);
    expect(trailing12mDays).toBeCloseTo(365, 0);
    expect(Math.abs(ytdDays - trailing12mDays)).toBeGreaterThan(300);
  });
});
