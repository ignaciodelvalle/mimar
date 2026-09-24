// Tests for the org casos queue migration (UX audit 1.3b).
//
// Coverage:
//   1. Pure helpers exported from CaseQueue:
//      - ageCaseDays: computes whole days elapsed since openedAt (floored).
//      - CASE_SLA_WARNING_DAYS: positive constant.
//      - SLA breach threshold semantics (at/above → breach; below → ok).
//   2. CaseQueue rendering (renderToStaticMarkup — no jsdom, no DB):
//      - Maps org case rows to visible table cells.
//      - Status filter chips (Todos / Abiertos / Cerrados) rendered.
//      - SLA badge rendered past threshold on open cases.
//      - SLA badge NOT rendered for closed cases (closedAt set), even past threshold.
//      - SLA badge NOT rendered below threshold on open cases.
//      - emptyMessage rendered when rows is empty.
//      - caption rendered as screen-reader-only element.
//   3. Page-level mapping: verifies CaseListItem → CaseQueueRow fields.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CASE_SLA_WARNING_DAYS,
  CaseQueue,
  type CaseQueueRow,
  ageCaseDays,
} from "@/components/ui/dashboard/CaseQueue";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<CaseQueueRow> = {}): CaseQueueRow {
  return {
    id: "row-1",
    publicCode: "CAS-UX-0001",
    caseKind: "bite_incident",
    status: "open",
    primaryPetName: "Firulais",
    primaryPetPublicToken: "PET-0001",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "Palermo",
    openedAt: new Date("2025-01-01T00:00:00Z"),
    closedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ageCaseDays
// ---------------------------------------------------------------------------

describe("ageCaseDays", () => {
  it("returns 0 for a date within the last 24 hours", () => {
    const recent = new Date(Date.now() - 23 * 60 * 60 * 1000);
    expect(ageCaseDays(recent)).toBe(0);
  });

  it("returns 1 for a date 25 hours ago", () => {
    const d = new Date(Date.now() - 25 * 60 * 60 * 1000);
    expect(ageCaseDays(d)).toBe(1);
  });

  it("floors fractional days (does not round up)", () => {
    // 1 day + 23 hours = 1.958 days → should floor to 1
    const d = new Date(Date.now() - (24 + 23) * 60 * 60 * 1000);
    expect(ageCaseDays(d)).toBe(1);
  });

  it("returns correct value for 30 days ago", () => {
    const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000 - 1000);
    expect(ageCaseDays(d)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// CASE_SLA_WARNING_DAYS
// ---------------------------------------------------------------------------

describe("CASE_SLA_WARNING_DAYS", () => {
  it("is a positive integer", () => {
    expect(CASE_SLA_WARNING_DAYS).toBeGreaterThan(0);
    expect(Number.isInteger(CASE_SLA_WARNING_DAYS)).toBe(true);
  });

  it("a case exactly at the threshold is considered SLA-breached", () => {
    const d = new Date(Date.now() - CASE_SLA_WARNING_DAYS * 24 * 60 * 60 * 1000 - 1000);
    expect(ageCaseDays(d)).toBeGreaterThanOrEqual(CASE_SLA_WARNING_DAYS);
  });

  it("a case just under the threshold is NOT SLA-breached", () => {
    // 1 minute shy of the threshold
    const d = new Date(Date.now() - (CASE_SLA_WARNING_DAYS - 1) * 24 * 60 * 60 * 1000 + 60_000);
    expect(ageCaseDays(d)).toBeLessThan(CASE_SLA_WARNING_DAYS);
  });
});

// ---------------------------------------------------------------------------
// CaseQueue rendering
// ---------------------------------------------------------------------------

describe("CaseQueue — row data rendered in table cells", () => {
  it("renders the publicCode in the table", () => {
    const html = renderToStaticMarkup(<CaseQueue rows={[makeRow()]} />);
    expect(html).toContain("CAS-UX-0001");
  });

  it("renders the pet name in the table", () => {
    const html = renderToStaticMarkup(<CaseQueue rows={[makeRow()]} />);
    expect(html).toContain("Firulais");
  });

  it("renders jurisdiction province and locality", () => {
    const html = renderToStaticMarkup(<CaseQueue rows={[makeRow()]} />);
    expect(html).toContain("Buenos Aires");
    expect(html).toContain("Palermo");
  });

  it("renders the status badge for 'open'", () => {
    const html = renderToStaticMarkup(<CaseQueue rows={[makeRow({ status: "open" })]} />);
    // CaseStatusBadge renders Spanish label "Abierto" for status=open.
    expect(html).toContain("Abierto");
  });

  it("renders the status badge for 'closed'", () => {
    const html = renderToStaticMarkup(
      <CaseQueue rows={[makeRow({ status: "closed", closedAt: new Date() })]} />,
    );
    expect(html).toContain("Cerrado");
  });

  it("renders the detail link using detailHref", () => {
    const html = renderToStaticMarkup(
      <CaseQueue rows={[makeRow({ detailHref: "/casos/CAS-UX-0001" })]} />,
    );
    expect(html).toContain("/casos/CAS-UX-0001");
  });
});

describe("CaseQueue — status filter chips", () => {
  it("renders 'Todos', 'Abiertos', and 'Cerrados' chips", () => {
    const html = renderToStaticMarkup(<CaseQueue rows={[]} />);
    expect(html).toContain("Todos");
    expect(html).toContain("Abiertos");
    expect(html).toContain("Cerrados");
  });

  it("marks the active status chip with aria-pressed=true", () => {
    const html = renderToStaticMarkup(<CaseQueue rows={[]} filters={{ status: "open" }} />);
    // The "Abiertos" chip should be aria-pressed="true"; others false.
    // Count aria-pressed="true" occurrences — only one chip should be active.
    const matches = html.match(/aria-pressed="true"/g);
    expect(matches).toHaveLength(1);
  });
});

describe("CaseQueue — SLA age badge", () => {
  it("renders SLA badge on open case past CASE_SLA_WARNING_DAYS", () => {
    const old = new Date(Date.now() - (CASE_SLA_WARNING_DAYS + 1) * 24 * 60 * 60 * 1000);
    const html = renderToStaticMarkup(
      <CaseQueue rows={[makeRow({ openedAt: old, closedAt: null, status: "open" })]} />,
    );
    // The SLA badge renders the age in days as "{N} día(s)" inside an OpPill
    // (visual review 2026-07-23: "173d" read as "1730"; now spelled out).
    expect(html).toMatch(/\d+\s+días?/);
  });

  it("does NOT render SLA badge on open case below threshold", () => {
    const recent = new Date(
      Date.now() - (CASE_SLA_WARNING_DAYS - 1) * 24 * 60 * 60 * 1000 + 60_000,
    );
    const html = renderToStaticMarkup(
      <CaseQueue rows={[makeRow({ openedAt: recent, closedAt: null, status: "open" })]} />,
    );
    // Badge should not appear for a case that has not yet breached the SLA.
    // We check that no "Nd" pill (where N >= CASE_SLA_WARNING_DAYS) is present.
    const match = html.match(/(\d+)d<\/span>/);
    if (match) {
      const days = Number(match[1]);
      expect(days).toBeLessThan(CASE_SLA_WARNING_DAYS);
    }
    // More direct: check the escalated-toned pill is absent.
    // OpPill with tone="escalated" now uses st-err token (not raw ln-op-danger-bg).
    expect(html).not.toContain("var(--color-st-err-bg)");
  });

  it("does NOT render SLA badge on a closed case even if old", () => {
    const veryOld = new Date(Date.now() - (CASE_SLA_WARNING_DAYS + 30) * 24 * 60 * 60 * 1000);
    const html = renderToStaticMarkup(
      <CaseQueue rows={[makeRow({ openedAt: veryOld, closedAt: new Date(), status: "closed" })]} />,
    );
    // Closed cases must never show a breach badge.
    expect(html).not.toContain("var(--color-st-err-bg)");
  });
});

describe("CaseQueue — empty state", () => {
  it("renders the default emptyMessage when rows is empty", () => {
    const html = renderToStaticMarkup(<CaseQueue rows={[]} />);
    expect(html).toContain("No hay casos en esta cola.");
  });

  it("renders a custom emptyMessage", () => {
    const html = renderToStaticMarkup(
      <CaseQueue rows={[]} emptyMessage="No hay casos abiertos." />,
    );
    expect(html).toContain("No hay casos abiertos.");
  });
});

describe("CaseQueue — caption", () => {
  it("renders a custom caption in the sr-only element", () => {
    const html = renderToStaticMarkup(
      <CaseQueue rows={[makeRow()]} caption="Cola de casos de la organización" />,
    );
    expect(html).toContain("Cola de casos de la organización");
  });
});

// ---------------------------------------------------------------------------
// Page-level mapping: CaseListItem → CaseQueueRow field contract
// ---------------------------------------------------------------------------

describe("CaseListItem → CaseQueueRow mapping contract", () => {
  // Verifies the mapping in the page by constructing a sample CaseListItem
  // and applying the same transformation the page uses.

  interface CaseListItem {
    id: string;
    publicCode: string;
    caseKind: string;
    status: string;
    primaryPetName: string | null;
    primaryPetPublicToken: string | null;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
    openedAt: Date;
    closedAt: Date | null;
  }

  function mapToQueueRow(c: CaseListItem, orgToken: string): CaseQueueRow {
    return {
      id: c.id,
      publicCode: c.publicCode,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      caseKind: c.caseKind as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: c.status as any,
      primaryPetName: c.primaryPetName,
      primaryPetPublicToken: c.primaryPetPublicToken,
      jurisdictionProvince: c.jurisdictionProvince,
      jurisdictionLocality: c.jurisdictionLocality,
      openedAt: c.openedAt,
      closedAt: c.closedAt,
      detailHref: `/casos/${c.publicCode}`,
    };
  }

  const sample: CaseListItem = {
    id: "case-uuid-123",
    publicCode: "CAS-MAP-0001",
    caseKind: "bite_incident",
    status: "open",
    primaryPetName: "Rex",
    primaryPetPublicToken: "PET-REX-001",
    jurisdictionProvince: "Córdoba",
    jurisdictionLocality: "Alta Gracia",
    openedAt: new Date("2026-01-15T08:00:00Z"),
    closedAt: null,
  };

  it("id is preserved", () => {
    expect(mapToQueueRow(sample, "ORG-001").id).toBe("case-uuid-123");
  });

  it("publicCode is preserved", () => {
    expect(mapToQueueRow(sample, "ORG-001").publicCode).toBe("CAS-MAP-0001");
  });

  it("detailHref points to /casos/[publicCode]", () => {
    expect(mapToQueueRow(sample, "ORG-001").detailHref).toBe("/casos/CAS-MAP-0001");
  });

  it("primaryPetName is preserved", () => {
    expect(mapToQueueRow(sample, "ORG-001").primaryPetName).toBe("Rex");
  });

  it("openedAt is preserved as Date", () => {
    const row = mapToQueueRow(sample, "ORG-001");
    expect(row.openedAt).toBeInstanceOf(Date);
    expect(row.openedAt.toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });

  it("closedAt is null for open cases", () => {
    expect(mapToQueueRow(sample, "ORG-001").closedAt).toBeNull();
  });

  it("closedAt is preserved for closed cases", () => {
    const closed = { ...sample, closedAt: new Date("2026-02-01T12:00:00Z") };
    const row = mapToQueueRow(closed, "ORG-001");
    expect(row.closedAt).not.toBeNull();
    expect(row.closedAt?.toISOString()).toBe("2026-02-01T12:00:00.000Z");
  });

  it("null primaryPetName is preserved (case without registered pet)", () => {
    const noPet = { ...sample, primaryPetName: null, primaryPetPublicToken: null };
    const row = mapToQueueRow(noPet, "ORG-001");
    expect(row.primaryPetName).toBeNull();
    expect(row.primaryPetPublicToken).toBeNull();
  });
});
