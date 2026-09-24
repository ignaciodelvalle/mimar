// UI tests for /admin/libro (WS-L — Libro de eventos).
//
// Pattern: react-dom/server renderToStaticMarkup (repo convention — no jsdom).
//
// Coverage:
//   1. EventLedgerTable a11y — every <th> has scope="col"; a <caption> exists.
//   2. Stream beat — es-AR event-type label rendered (not the raw enum); both
//      occurredAt and recordedAt shown.
//   3. Amendment beat — a row with hasAmendment renders the "Corregido por
//      enmienda" marker and the expand affordance with aria-expanded.
//   4. tipo filter — narrowing to one event type yields only those rows
//      (view-model level).
//   5. Temporal replay — the deep-link builds a valid ?asOf=<iso> that round-
//      trips through the Panorama parseAsOf parser; province/locality appended.
//   6. Empty-state distinction is exercised in the page; here we assert the
//      view-model + href builders that the page relies on.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventLedgerTable } from "@/components/admin/EventLedgerTable";
import type { EventLedgerRow } from "@/lib/metrics/event-ledger";
import { parseAsOf } from "@/src/modules/panorama/domain/time-scrub";

import { buildReplayHref, toLedgerRowView } from "@/app/admin/libro/view";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<EventLedgerRow> = {}): EventLedgerRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    petPublicToken: "DIM-AAAA-1111",
    eventType: "vaccination_administered",
    occurredAt: new Date("2026-03-15T10:00:00.000Z"),
    recordedAt: new Date("2026-03-15T12:30:00.000Z"),
    authorRole: "vet",
    authorOrganizationId: null,
    authorVerified: true,
    province: "Santa Fe",
    locality: "Rosario",
    hasAmendment: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1 + 2. a11y + stream beat
// ---------------------------------------------------------------------------

describe("EventLedgerTable — a11y + stream beat", () => {
  it("every <th> has scope='col' and a <caption> exists", () => {
    const rows = [toLedgerRowView(makeRow())];
    const html = renderToStaticMarkup(<EventLedgerTable rows={rows} />);

    const thMatches = html.match(/<th(?:\s[^>]*)?>[\s\S]*?<\/th>/g) ?? [];
    expect(thMatches.length).toBeGreaterThan(0);
    for (const tag of thMatches) {
      const openTag = tag.match(/^<th[^>]*/)?.[0] ?? "";
      expect(openTag.includes('scope="col"')).toBe(true);
    }
    expect(html).toContain("<caption");
  });

  it("renders the es-AR event-type label, not the raw enum", () => {
    const rows = [toLedgerRowView(makeRow({ eventType: "vaccination_administered" }))];
    const html = renderToStaticMarkup(<EventLedgerTable rows={rows} />);
    expect(html).toContain("Vacuna administrada");
    expect(html).not.toContain("vaccination_administered");
  });

  it("shows BOTH occurred and recorded timestamps", () => {
    const rows = [toLedgerRowView(makeRow())];
    const html = renderToStaticMarkup(<EventLedgerTable rows={rows} />);
    expect(html).toContain("ocurrió");
    expect(html).toContain("se registró");
  });
});

// ---------------------------------------------------------------------------
// 3. Amendment beat
// ---------------------------------------------------------------------------

describe("EventLedgerTable — amendment beat", () => {
  it("an amended row shows the 'Corregido por enmienda' marker and an expand toggle", () => {
    const rows = [toLedgerRowView(makeRow({ hasAmendment: true }))];
    const html = renderToStaticMarkup(<EventLedgerTable rows={rows} />);
    expect(html).toContain("Corregido por enmienda");
    // Expand affordance with aria-expanded (collapsed initial state).
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Ver corrección");
  });

  it("a non-amended row has no amendment marker or toggle", () => {
    const rows = [toLedgerRowView(makeRow({ hasAmendment: false }))];
    const html = renderToStaticMarkup(<EventLedgerTable rows={rows} />);
    expect(html).not.toContain("Corregido por enmienda");
    expect(html).not.toContain("aria-expanded");
  });
});

// ---------------------------------------------------------------------------
// 4. tipo filter (view-model level)
// ---------------------------------------------------------------------------

describe("event-type filtering reduces rendered rows", () => {
  it("rendering only the filtered type yields rows of that type", () => {
    const all = [
      makeRow({ id: "a1", eventType: "vaccination_administered" }),
      makeRow({ id: "b2", eventType: "weight_recorded" }),
      makeRow({ id: "c3", eventType: "vaccination_administered" }),
    ];
    // Simulate the server filter: only vaccination rows reach the table.
    const filtered = all
      .filter((r) => r.eventType === "vaccination_administered")
      .map(toLedgerRowView);
    expect(filtered).toHaveLength(2);

    const html = renderToStaticMarkup(<EventLedgerTable rows={filtered} />);
    expect(html).not.toContain("Peso registrado");
  });
});

// ---------------------------------------------------------------------------
// 5. Temporal replay deep-link
// ---------------------------------------------------------------------------

describe("buildReplayHref — temporal replay", () => {
  it("builds a valid ?asOf=<iso> that round-trips through parseAsOf", () => {
    const occurredAt = new Date("2026-03-15T10:00:00.000Z");
    const href = buildReplayHref({ occurredAt, province: null, locality: null });

    expect(href.startsWith("/admin/panorama?")).toBe(true);
    const url = new URL(href, "https://example.test");
    const asOfRaw = url.searchParams.get("asOf");
    expect(asOfRaw).toBe(occurredAt.toISOString());

    const parsed = parseAsOf(asOfRaw);
    expect(parsed).not.toBeNull();
    expect(parsed?.getTime()).toBe(occurredAt.getTime());
  });

  it("appends province and locality when present", () => {
    const href = buildReplayHref({
      occurredAt: new Date("2026-03-15T10:00:00.000Z"),
      province: "Santa Fe",
      locality: "Rosario",
    });
    const url = new URL(href, "https://example.test");
    expect(url.searchParams.get("province")).toBe("Santa Fe");
    expect(url.searchParams.get("locality")).toBe("Rosario");
  });

  it("omits province/locality when absent", () => {
    const href = buildReplayHref({
      occurredAt: new Date("2026-03-15T10:00:00.000Z"),
      province: null,
      locality: null,
    });
    const url = new URL(href, "https://example.test");
    expect(url.searchParams.has("province")).toBe(false);
    expect(url.searchParams.has("locality")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. view-model mapping
// ---------------------------------------------------------------------------

describe("toLedgerRowView", () => {
  it("exposes the pet PUBLIC token and never a raw petId (PII gating)", () => {
    const view = toLedgerRowView(makeRow());
    expect(view.petPublicToken).toBe("DIM-AAAA-1111");
    expect(view).not.toHaveProperty("petId");
  });

  it("maps the event type to its es-AR label", () => {
    const view = toLedgerRowView(makeRow({ eventType: "death_recorded" }));
    expect(view.eventTypeLabel).toBe("Fallecimiento");
  });
});
