// Tests for <PetAlertStrip> — pet profile v2.1 (Item 6, spec §3.2 / §6).
//
// Covers the urgency ordering and the empty-renders-nothing contract. Render
// via react-dom/server → HTML string (same pattern as ReminderCard.test.tsx).

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type PetAlert, PetAlertStrip, orderAlertsByUrgency } from "./PetAlertStrip";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("orderAlertsByUrgency", () => {
  it("orders by tone across severities: urgent first, info last", () => {
    // Deliberately scrambled input to prove sorting by tone, not input order.
    const alerts: PetAlert[] = [
      { id: "pregnancy", tone: "info", node: "preg" },
      { id: "open-cases", tone: "warning", node: "cases" },
      { id: "transit", tone: "warning", node: "transit" },
      { id: "rabies", tone: "urgent", node: "rabies" },
    ];

    const ordered = orderAlertsByUrgency(alerts);

    // urgent first, then both warnings, info last.
    expect(ordered[0].id).toBe("rabies");
    expect(ordered.map((a) => a.tone)).toEqual(["urgent", "warning", "warning", "info"]);
    expect(ordered[ordered.length - 1].id).toBe("pregnancy");
  });

  it("preserves input order within the same tone (page pushes transit before open-cases)", () => {
    // The page pushes alerts in this order; same-tone ties are stable, so the
    // real profile renders rabies → transit → open-cases → pregnancy.
    const alerts: PetAlert[] = [
      { id: "rabies", tone: "urgent", node: "rabies" },
      { id: "transit", tone: "warning", node: "transit" },
      { id: "open-cases", tone: "warning", node: "cases" },
      { id: "pregnancy", tone: "info", node: "preg" },
    ];
    expect(orderAlertsByUrgency(alerts).map((a) => a.id)).toEqual([
      "rabies",
      "transit",
      "open-cases",
      "pregnancy",
    ]);
  });

  it("is stable for equal tones", () => {
    const alerts: PetAlert[] = [
      { id: "a", tone: "warning", node: "a" },
      { id: "b", tone: "warning", node: "b" },
      { id: "c", tone: "warning", node: "c" },
    ];
    expect(orderAlertsByUrgency(alerts).map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const alerts: PetAlert[] = [
      { id: "info", tone: "info", node: "i" },
      { id: "urgent", tone: "urgent", node: "u" },
    ];
    orderAlertsByUrgency(alerts);
    expect(alerts.map((a) => a.id)).toEqual(["info", "urgent"]);
  });
});

describe("<PetAlertStrip>", () => {
  it("renders nothing when there are no alerts", () => {
    const html = render(<PetAlertStrip alerts={[]} />);
    expect(html).toBe("");
  });

  it("renders each alert node with its tone marked, in urgency order", () => {
    const alerts: PetAlert[] = [
      { id: "pregnancy", tone: "info", node: <p>Gestación en curso</p> },
      { id: "rabies", tone: "urgent", node: <p>Observación antirrábica</p> },
    ];
    const html = render(<PetAlertStrip alerts={alerts} />);

    expect(html).toContain("Observación antirrábica");
    expect(html).toContain("Gestación en curso");
    expect(html).toContain('data-section="alert-strip"');
    expect(html).toContain('data-alert-tone="urgent"');
    // urgent appears before info in the output.
    expect(html.indexOf("antirrábica")).toBeLessThan(html.indexOf("Gestación"));
  });
});
