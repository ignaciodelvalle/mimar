/**
 * Structure test — "cargar la libreta de papel" roadmap placeholder.
 *
 * PO-approved pattern (visible, disabled, reads as "coming", never as
 * broken — precedent: "Informe de situación (en desarrollo)" in panorama's
 * SituationalMap). Pinned here so a future edit to LibretaSanitariaView
 * can't silently drop the roadmap signal from either the empty state or the
 * populated agrupada/cronológica views.
 *
 * Pattern: react-dom/server renderToStaticMarkup (repo convention — no
 * jsdom, see EventTimeline.test.tsx / anotar/page.test.tsx).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LIBRETA_GROUPS, type LibretaGroupKey } from "@/lib/infra/libreta-sanitaria";
import { LibretaSanitariaView } from "./LibretaSanitariaView";

const ROADMAP_LABEL = "Cargar la libreta de papel (en desarrollo)";

// Mirrors the private `Event` shape LibretaSanitariaView expects — not
// exported by the module, so redeclared here for the fixture.
type Event = {
  id: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date | string;
  notes: string | null;
  authorRole: string;
  authorVerified: boolean;
  authorOrganizationId: string | null;
  tipoEventoCode?: string | null;
};

function emptyGroups(): Record<LibretaGroupKey, Event[]> {
  return Object.fromEntries(LIBRETA_GROUPS.map((g) => [g, [] as Event[]])) as unknown as Record<
    LibretaGroupKey,
    Event[]
  >;
}

const weightEvent: Event = {
  id: "evt-1",
  eventType: "weight_recorded",
  payload: { value_kg: 12.5 },
  occurredAt: new Date("2026-01-01T00:00:00Z"),
  notes: null,
  authorRole: "owner",
  authorVerified: false,
  authorOrganizationId: null,
};

describe("<LibretaSanitariaView> — paper-libreta roadmap placeholder", () => {
  it("renders the placeholder (disabled, aria-disabled, exact copy) in the empty state", () => {
    const html = renderToStaticMarkup(
      <LibretaSanitariaView groupedEvents={emptyGroups()} publicToken="abc123" vista="agrupada" />,
    );
    expect(html).toContain(ROADMAP_LABEL);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('data-testid="paper-libreta-roadmap-cta"');
  });

  it("renders the placeholder in the populated agrupada view (thin, non-empty history)", () => {
    const groups = emptyGroups();
    groups.peso = [weightEvent];
    const html = renderToStaticMarkup(
      <LibretaSanitariaView groupedEvents={groups} publicToken="abc123" vista="agrupada" />,
    );
    expect(html).toContain(ROADMAP_LABEL);
    expect(html).toContain('aria-disabled="true"');
  });

  it("renders the placeholder in the cronológica view", () => {
    const groups = emptyGroups();
    groups.peso = [weightEvent];
    const html = renderToStaticMarkup(
      <LibretaSanitariaView groupedEvents={groups} publicToken="abc123" vista="cronologica" />,
    );
    expect(html).toContain(ROADMAP_LABEL);
    expect(html).toContain('aria-disabled="true"');
  });

  it("button carries a disabled attribute — never a live/dead link", () => {
    const html = renderToStaticMarkup(
      <LibretaSanitariaView groupedEvents={emptyGroups()} publicToken="abc123" vista="agrupada" />,
    );
    const btnMatch = html.match(/<button\b[\s\S]*?Cargar la libreta de papel[\s\S]*?<\/button>/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch?.[0]).toContain("disabled=");
  });
});

// ---------------------------------------------------------------------------
// Clinical timeline — the `1fr` track must be allowed to shrink
// ---------------------------------------------------------------------------

/**
 * The timeline lays each entry out as a `96px 34px 1fr` grid. A grid item's
 * automatic minimum size is its MIN-CONTENT, not zero, so the card in the `1fr`
 * track can push the row wider than its container. With 130px already spent on
 * the two fixed tracks, a 390px phone leaves the card ~200px — and the card
 * holds free text (event notes, payload summaries, SENASA norm citations) where
 * a single unbreakable run is enough to overrun it. Nothing in the ancestor
 * chain clips or scrolls this grid, so the overflow reaches the page body,
 * which is the one thing the project's overflow rule forbids.
 */
describe("<LibretaSanitariaView> — clinical timeline cannot widen the page", () => {
  /** A note with no spaces — worst case for a min-content-sized track. */
  const unbreakable = "x".repeat(120);

  const longNoteEvent: Event = {
    ...weightEvent,
    id: "evt-long",
    notes: unbreakable,
  };

  function timelineCardTag(html: string): string {
    // The card is the only element carrying the timeline card's border+bg combo.
    const match = html.match(/<div class="[^"]*ml-3\.5[^"]*"/);
    if (!match) throw new Error(`timeline card not found in: ${html.slice(0, 400)}`);
    return match[0];
  }

  it("lets the 1fr track shrink below its min-content (min-w-0)", () => {
    const groups = emptyGroups();
    groups.peso = [longNoteEvent];
    const html = renderToStaticMarkup(
      <LibretaSanitariaView groupedEvents={groups} publicToken="abc123" vista="agrupada" />,
    );
    expect(
      timelineCardTag(html),
      "without min-w-0 the grid item's automatic minimum size is min-content, and " +
        "a long unbreakable note pushes the whole row past the viewport",
    ).toContain("min-w-0");
  });

  it("wraps a long unbreakable run instead of overflowing it", () => {
    const groups = emptyGroups();
    groups.peso = [longNoteEvent];
    const html = renderToStaticMarkup(
      <LibretaSanitariaView groupedEvents={groups} publicToken="abc123" vista="agrupada" />,
    );
    // min-w-0 alone lets the TRACK shrink; the text still needs permission to
    // break mid-word or it just overflows the card instead of the row.
    expect(timelineCardTag(html)).toContain("break-words");
    expect(html).toContain(unbreakable);
  });

  it("keeps the fixed date/dot tracks — the fix must not collapse the layout", () => {
    const groups = emptyGroups();
    groups.peso = [weightEvent];
    const html = renderToStaticMarkup(
      <LibretaSanitariaView groupedEvents={groups} publicToken="abc123" vista="agrupada" />,
    );
    expect(html).toContain("96px 34px 1fr");
  });
});

describe("<LibretaSanitariaView> — Profesional column falls back to the signature", () => {
  // A vet-SIGNED dose with the free-text applier left blank used to render
  // PROFESIONAL "—" while an owner-declared dose showed its cited name — the
  // row with MORE provenance looked like it had less (9-role external run,
  // 2026-08-18). Events are append-only, so pre-existing signed doses can
  // only be repaired at render. The fallback goes through the SAME
  // applierAttribution the asiento card uses — a first draft grew a second
  // local fallback with different strings for the same event.
  function vaccineEvent(overrides: Partial<Event>): Event {
    return {
      id: "evt-vac",
      eventType: "vaccination_administered",
      payload: { vaccine_name: "Antirrábica" },
      occurredAt: new Date("2026-06-01T00:00:00Z"),
      notes: null,
      authorRole: "owner",
      authorVerified: false,
      authorOrganizationId: null,
      ...overrides,
    };
  }

  function renderWith(event: Event): string {
    const groups = emptyGroups();
    groups.vacunas = [event];
    return renderToStaticMarkup(
      <LibretaSanitariaView groupedEvents={groups} publicToken="abc123" vista="agrupada" />,
    );
  }

  it("a signed dose with no typed applier shows the verified signature, not a dash", () => {
    const html = renderWith(
      vaccineEvent({ id: "evt-signed", authorRole: "vet", authorVerified: true }),
    );
    expect(html).toContain("Vet. matriculado/a (firma verificada)");
  });

  it("an owner-declared dose with no applier keeps the dash — the fallback is signature-only", () => {
    const html = renderWith(vaccineEvent({ id: "evt-declared" }));
    expect(html).not.toContain("Vet. matriculado/a (firma verificada)");
    expect(html).toContain("—");
  });

  it("an ORG-signed dose (shelter, unverified vet) names the organization branch, not a dash", () => {
    const html = renderWith(
      vaccineEvent({
        id: "evt-org",
        authorRole: "shelter",
        authorVerified: false,
        authorOrganizationId: "org-1",
      }),
    );
    expect(html).toContain("La organización");
  });

  it("typed free text always wins over the fallback", () => {
    const html = renderWith(
      vaccineEvent({
        id: "evt-typed",
        authorRole: "vet",
        authorVerified: true,
        payload: { vaccine_name: "Antirrábica", administered_by: "Dra. Prueba QA" },
      }),
    );
    expect(html).toContain("Dra. Prueba QA");
    expect(html).not.toContain("Vet. matriculado/a (firma verificada)");
  });
});
