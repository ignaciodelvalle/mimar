// Regression guard for the admin cockpit deep-link changes (fd2bbb1e:
// "fix(admin): deep-link cockpit tiles, drop duplicate cola KPI, fix clickable
// site map").
//
// Covers two things that previously drifted without a test:
//   1. QueueHealthCockpit's approval tiles deep-link to /admin/cola?type=<exact
//      type> for the three approval types, and the SLA tile deep-links to
//      /admin/outbox?breach=yes (breached rows only, not the full outbox).
//   2. AdminKpiStrip's `omitPendingQueue` flag: the admin home (cockpit above
//      already owns the per-type pending count) must NOT also render "Cola
//      pendiente", while /admin/sistema (no cockpit) keeps it.
//
// Pattern: renderToStaticMarkup (repo convention — no jsdom). Both components
// are presentational server components; OpKpi's InfoButton uses useState,
// which renders fine with an initial value under renderToStaticMarkup (see
// __tests__/a11y-badge-kpi.test.tsx for the same pattern against OpKpi).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminKpiStrip, type AdminKpiStripData } from "@/components/admin/AdminKpiStrip";
import { QueueHealthCockpit } from "@/components/admin/QueueHealthCockpit";
import type { QueueCockpit } from "@/lib/analytics/admin-metrics";

const cockpit: QueueCockpit = {
  approvals: {
    pendingTotal: 6,
    oldestPendingDaysAgo: 3,
    roleUpgradeVet: 2,
    organizationVerification: 3,
    serviceDogCredentialVerification: 1,
  },
  moderationPending: 4,
  alertsOpen: 2,
  outboxBreaches: 5,
  casesOpen: 7,
  rabiesInProgress: 1,
};

describe("QueueHealthCockpit — approval tiles deep-link to their own filtered queue", () => {
  const html = renderToStaticMarkup(<QueueHealthCockpit cockpit={cockpit} />);

  it("Matrículas veterinarias tile links to /admin/cola?type=role_upgrade_vet", () => {
    expect(html).toContain('href="/admin/cola?type=role_upgrade_vet"');
  });

  it("Verificación de organizaciones tile links to /admin/cola?type=organization_verification", () => {
    expect(html).toContain('href="/admin/cola?type=organization_verification"');
  });

  it("Credenciales RUPGA tile links to /admin/cola?type=service_dog_credential_verification", () => {
    expect(html).toContain('href="/admin/cola?type=service_dog_credential_verification"');
  });

  it("SLA (outbox) tile links to /admin/outbox?breach=yes, not the bare outbox", () => {
    expect(html).toContain('href="/admin/outbox?breach=yes"');
    expect(html).not.toContain('href="/admin/outbox"');
  });

  // This tile used to point at /admin/moderacion, which has been a redirect-only
  // shim since the F1 fusion — one extra hop to reach the exact URL below
  // (link-integrity.test.ts block 5 found it, 2026-08-01).
  //
  // It needs its OWN assertion rather than leaning on that guard. The guard
  // skips any route named in REDIRECT_LINK_ALLOWLIST, and /admin/moderacion has
  // to stay listed there for a DIFFERENT holder: the ADMIN_NAV "Moderación"
  // entry, which keeps that href so matchPrefix highlights the [id] detail
  // routes. One allowlist entry, two consumers — so the guard is structurally
  // blind to a regression here. Measured, not assumed: reverting this href with
  // only the guard in place left all 15 tests in scope green.
  it("Moderación tile links straight to the Denuncias hub stage, not the /admin/moderacion shim", () => {
    expect(html).toContain('href="/gob/denuncias?etapa=moderacion"');
    expect(html).not.toContain('href="/admin/moderacion"');
  });
});

describe("AdminKpiStrip — omitPendingQueue prevents the duplicate 'Aprobaciones pendientes' tile", () => {
  const baseData: AdminKpiStripData = {
    totalPersonal: 120,
    totalInstitutionalActive: 8,
    pendingTotal: 6,
    oldestPendingDaysAgo: 3,
    decisionsTotal7d: 10,
    approved7d: 7,
    rejected7d: 3,
    decisionsDelta: null,
    decisionsPriorBase: null,
  };

  it("renders 'Aprobaciones pendientes' when omitPendingQueue is NOT set (e.g. /admin/sistema)", () => {
    const html = renderToStaticMarkup(<AdminKpiStrip data={baseData} />);
    expect(html).toContain("Aprobaciones pendientes");
  });

  it("does NOT render 'Aprobaciones pendientes' when omitPendingQueue is set (the admin home)", () => {
    const html = renderToStaticMarkup(<AdminKpiStrip data={baseData} omitPendingQueue />);
    expect(html).not.toContain("Aprobaciones pendientes");
    // The promoted non-duplicated metric takes its place.
    expect(html).toContain("Instituciones activas");
  });
});
