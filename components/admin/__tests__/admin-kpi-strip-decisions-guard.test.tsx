// AdminKpiStrip — the "Decisiones 7d" tile's small-N delta guard (T4.10,
// 2026-08-01).
//
// Bug: `decisionsDeltaPct`'s approximated prior-week base could be as small
// as 1 or 2 decisions, and the tile painted a colored +/-N% verdict off it
// exactly the same as it would off a healthy base — an "n=2" swing (e.g.
// 1 → 2 decisions reads as "+100%") is noise, not a trend, but the old code
// had no way to tell OpKpi that. `decisionsDeltaPct` now returns the
// `priorBase` alongside the pct, wired through `guardInput.priorBase` to the
// catalog's `queue_decisions_7d` `unstableDeltaBase` floor (5, matching
// sterilizations_per_month's convention). Below the floor the delta chip is
// suppressed and the guard note explains why; at/above it the chip renders.
//
// Pattern: renderToStaticMarkup (repo convention for this component — see
// __tests__/admin-cockpit-links.test.tsx).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminKpiStrip, type AdminKpiStripData } from "@/components/admin/AdminKpiStrip";

function baseData(over: Partial<AdminKpiStripData>): AdminKpiStripData {
  return {
    totalPersonal: 120,
    totalInstitutionalActive: 8,
    pendingTotal: 6,
    oldestPendingDaysAgo: 3,
    decisionsTotal7d: 10,
    approved7d: 7,
    rejected7d: 3,
    decisionsDelta: null,
    decisionsPriorBase: null,
    ...over,
  };
}

describe("AdminKpiStrip — Decisiones 7d suppresses the delta on an unstable (n<5) prior base", () => {
  it("suppresses the % chip and shows the guard note when priorBase is 2", () => {
    const html = renderToStaticMarkup(
      <AdminKpiStrip
        data={baseData({ decisionsDelta: 100, decisionsPriorBase: 2 })}
        omitPendingQueue
      />,
    );
    expect(html).not.toContain("+100");
    expect(html).toContain("Base del período anterior inestable — variación no mostrada.");
  });

  it("suppresses the % chip when priorBase is exactly at the boundary just below the floor (4)", () => {
    const html = renderToStaticMarkup(
      <AdminKpiStrip
        data={baseData({ decisionsDelta: 25, decisionsPriorBase: 4 })}
        omitPendingQueue
      />,
    );
    expect(html).not.toContain("+25");
    expect(html).toContain("Base del período anterior inestable — variación no mostrada.");
  });

  it("renders the % chip when priorBase clears the floor (5)", () => {
    const html = renderToStaticMarkup(
      <AdminKpiStrip
        data={baseData({ decisionsDelta: 20, decisionsPriorBase: 5 })}
        omitPendingQueue
      />,
    );
    expect(html).toContain("+20");
    expect(html).not.toContain("Base del período anterior inestable — variación no mostrada.");
  });

  it("renders the % chip unguarded when priorBase is null (no baseline info at all)", () => {
    // decisionsDeltaPct returned null upstream (no prior-week baseline) — the
    // guard has nothing to gate on, same as before T4.10.
    const html = renderToStaticMarkup(
      <AdminKpiStrip
        data={baseData({ decisionsDelta: 20, decisionsPriorBase: null })}
        omitPendingQueue
      />,
    );
    expect(html).toContain("+20");
    expect(html).not.toContain("Base del período anterior inestable — variación no mostrada.");
  });
});
