// @vitest-environment jsdom
//
// H17 (external red-team 2026-07-30) — "Actividad reciente" said nothing about
// WHICH emptiness it was showing.
//
// The card's empty branch printed one sentence, "Sin novedades en los últimos
// 7 días.", for two situations that are not the same thing:
//
//   1. the feed queried the operator's scope and the honest answer was zero;
//   2. the operator has NO jurisdictions assigned, so fetchNovedadesGroups
//      short-circuits before running any query at all (lib/metrics/
//      novedades-feed.ts) and returns the identical empty shape.
//
// In case 2 the sentence is a statement about the world made by a screen that
// never looked. That is the same lie the /gob briefing's blanket "las métricas
// con meta están dentro de rango" was making until 2026-07-31, and it gets the
// same treatment: the fetcher carries the reason, the card renders it, and the
// "we could not measure" branch uses LnEmptyState's no-signal nature so it can
// never be mistaken for reassurance.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/novedades", () => ({
  markNovedadesSeenAction: vi.fn(),
}));

import type { NovedadesGroupedFeed } from "@/lib/metrics/novedades-feed";
import { NovedadesCard } from "./NovedadesCard";

function feed(over: Partial<NovedadesGroupedFeed> = {}): NovedadesGroupedFeed {
  return {
    groups: [],
    sinceWatermark: false,
    windowStart: new Date("2026-07-24T00:00:00Z"),
    scopeEmpty: false,
    ...over,
  };
}

describe("NovedadesCard — an empty feed says which emptiness it is", () => {
  afterEach(cleanup);

  it("states plainly that the scope WAS queried when the zero is measured", () => {
    const { container } = render(<NovedadesCard feed={feed()} />);
    expect(container.textContent).toContain("Sin novedades en los últimos 7 días");
    // The distinguishing claim, not just the headline: this zero is a
    // measurement, and the copy says so rather than leaving the operator to
    // guess between "nothing happened" and "nothing loaded".
    expect(container.textContent).toContain("Se consultó tu alcance");
  });

  it("never claims 'sin novedades' when no scope was queried at all", () => {
    const { container } = render(<NovedadesCard feed={feed({ scopeEmpty: true })} />);
    expect(container.textContent).toContain("no tiene jurisdicciones asignadas");
    expect(container.textContent).toContain("no significa que no haya novedades");
  });

  it("marks the un-queried state as no-signal, and the measured zero as not", () => {
    // LnEmptyState's no-signal nature is what stops an unmeasured emptiness
    // from reading as calm (it renders role="status" + the warn treatment).
    // Asserted as a PAIR: the same query on both renders, opposite answers, so
    // neither assertion can quietly pass on a component that lost the prop.
    render(<NovedadesCard feed={feed({ scopeEmpty: true })} />);
    expect(screen.getByRole("status")).toBeTruthy();
    cleanup();

    render(<NovedadesCard feed={feed()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("adapts the measured-zero window to the watermark, and keeps the distinction", () => {
    const { container } = render(<NovedadesCard feed={feed({ sinceWatermark: true })} />);
    expect(container.textContent).toContain("Sin novedades desde tu última visita");
    expect(container.textContent).toContain("Se consultó tu alcance");
  });

  it("shows no empty state at all when the feed has groups", () => {
    const { container } = render(
      <NovedadesCard
        feed={feed({
          groups: [
            {
              key: "incident_reported||",
              eventType: "incident_reported",
              province: "Córdoba",
              locality: "Villa Allende",
              count: 3,
              latestRecordedAt: new Date("2026-07-29T12:00:00Z"),
            },
          ],
        })}
      />,
    );
    expect(container.textContent).not.toContain("Se consultó tu alcance");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

// T4.15 (2026-08-01): the count badge is a bare number with no label — it
// reads as an event count, but fetchNovedadesGroupedFeed's query counts
// DISTINCT pet_id (novedades-feed.ts), i.e. animals affected. A group with 3
// events on the SAME pet still shows "3", so an unlabeled badge invites the
// wrong read. Pin the disclosure so a regression that drops it fails here.
describe("NovedadesCard — the count badge names what it counts (T4.15)", () => {
  afterEach(cleanup);

  function groupFeed(count: number): NovedadesGroupedFeed {
    return feed({
      groups: [
        {
          key: "incident_reported||",
          eventType: "incident_reported",
          province: "Córdoba",
          locality: "Villa Allende",
          count,
          latestRecordedAt: new Date("2026-07-29T12:00:00Z"),
        },
      ],
    });
  }

  it("carries a title/aria-label disclosing animals affected when count > 1", () => {
    const { container } = render(<NovedadesCard feed={groupFeed(3)} />);
    const badge = container.querySelector('[title="3 animales afectados"]');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("aria-label")).toBe("3 animales afectados");
    expect(badge?.textContent).toBe("3");
  });

  it("renders no badge at all for a single-subject group (unchanged behavior)", () => {
    const { container } = render(<NovedadesCard feed={groupFeed(1)} />);
    expect(container.querySelector('[title$="animales afectados"]')).toBeNull();
  });
});
