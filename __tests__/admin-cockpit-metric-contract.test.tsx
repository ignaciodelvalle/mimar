// D-1 / D-3 (Lote D) — the /admin home cockpit under the metric contract.
//
// Before this, QueueHealthCockpit's eight tiles rendered through a bespoke
// local `QueueTile`: a retyped label, a raw count, an ad-hoc tone, and no
// descriptor at all — the largest descriptor-less reporting surface of either
// operator portal, on the first screen an admin sees. These are the two claims
// that regression-guard the fix:
//
//   1. Every tile resolves a catalogued descriptor, and DISPLAYS that
//      descriptor's own label (never a retyped string). The ⓘ affordance is the
//      observable proof the descriptor resolved: OpKpi only renders it when a
//      descriptorId produced catalog `ui` copy.
//   2. A zero tile states that its zero was MEASURED (D-3). Every count in
//      QueueCockpit is an unconditional aggregate over a live table, so a 0 here
//      is never a no-signal blank — and the tile says so instead of leaving a
//      bare digit to be read either way.
//
// Pattern: renderToStaticMarkup (repo convention — no jsdom), same as
// admin-cockpit-links.test.tsx.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QueueHealthCockpit } from "@/components/admin/QueueHealthCockpit";
import type { QueueCockpit } from "@/lib/analytics/admin-metrics";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";

/** The eight descriptors the cockpit is contractually required to render. */
const COCKPIT_DESCRIPTOR_IDS = [
  "queue_approvals_role_upgrade_vet",
  "queue_approvals_org_verification",
  "queue_approvals_service_dog_credential",
  "queue_moderation_pending",
  "queue_alerts_open",
  "queue_outbox_sla_breaches",
  "queue_cases_open_national",
  "queue_rabies_observations_in_progress",
] as const;

const busy: QueueCockpit = {
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

const allClear: QueueCockpit = {
  approvals: {
    pendingTotal: 0,
    oldestPendingDaysAgo: null,
    roleUpgradeVet: 0,
    organizationVerification: 0,
    serviceDogCredentialVerification: 0,
  },
  moderationPending: 0,
  alertsOpen: 0,
  outboxBreaches: 0,
  casesOpen: 0,
  rabiesInProgress: 0,
};

describe("QueueHealthCockpit — every tile carries its catalogued descriptor (D-1)", () => {
  const html = renderToStaticMarkup(<QueueHealthCockpit cockpit={busy} />);

  it.each(COCKPIT_DESCRIPTOR_IDS)("renders %s's catalogued label verbatim", (id) => {
    const descriptor = KPI_CATALOG[id];
    expect(descriptor, `${id} must exist in KPI_CATALOG`).toBeDefined();
    expect(html).toContain(descriptor.label);
  });

  it("every catalogued tile exposes the ⓘ affordance (proof the descriptor resolved)", () => {
    const infoButtons = html.split('aria-label="Información sobre este indicador"').length - 1;
    expect(infoButtons).toBe(COCKPIT_DESCRIPTOR_IDS.length);
  });

  it("no descriptor is reused across two tiles — eight tiles, eight distinct metrics", () => {
    expect(new Set(COCKPIT_DESCRIPTOR_IDS).size).toBe(COCKPIT_DESCRIPTOR_IDS.length);
  });
});

describe("QueueHealthCockpit — a zero says it was measured (D-3)", () => {
  const MEASURED = "Consultado ahora: la cola está vacía.";

  it("an all-clear cockpit annotates EVERY zero tile", () => {
    const html = renderToStaticMarkup(<QueueHealthCockpit cockpit={allClear} />);
    expect(html.split(MEASURED).length - 1).toBe(COCKPIT_DESCRIPTOR_IDS.length);
  });

  it("a busy cockpit annotates none of them — the count is its own evidence", () => {
    const html = renderToStaticMarkup(<QueueHealthCockpit cockpit={busy} />);
    expect(html).not.toContain(MEASURED);
  });

  it("annotates exactly the zero tiles when the cockpit is mixed", () => {
    const html = renderToStaticMarkup(
      <QueueHealthCockpit cockpit={{ ...busy, alertsOpen: 0, casesOpen: 0 }} />,
    );
    expect(html.split(MEASURED).length - 1).toBe(2);
  });
});
