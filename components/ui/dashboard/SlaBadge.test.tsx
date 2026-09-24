// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SlaBadge } from "./SlaBadge";

// C2 language contract (2026-07-22) — the #1 trust bug this component kills:
// WelfareDenunciaRow used to render `SLA vencido (${slaDaysForSeverity(severity)} d)`,
// which is the SEVERITY TIER, not days overdue. On a 170-day-old critical case
// that read as "overdue by 1 day" instead of ~169. These tests assert SlaBadge
// renders the HONEST tier + overdue-day-count split for every state, and
// never the bare "SLA vencido" phrasing.

const NOW = new Date("2026-07-22T12:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

afterEach(cleanup);

describe("SlaBadge — breached", () => {
  it("renders the tier AND the actual overdue day count, never the tier alone as 'vencido'", () => {
    // critical tier = 1 day; 170 days old is breached by ~169 days — old
    // enough to demonstrate the trust bug, but still under the
    // HISTORICAL_BACKLOG_DAYS (180) threshold so this stays a live breach,
    // not a historical demotion (covered by its own describe block below).
    render(<SlaBadge severity="critical" status="open" createdAt={daysAgo(170)} now={NOW} />);
    const text = screen.getByText(/vencido hace/i).textContent ?? "";
    expect(text).toContain("SLA 1 día");
    expect(text).toContain("vencido hace 169 días");
    // Never the old bare-tier phrasing that reads as "overdue by 1 day".
    expect(text).not.toBe("SLA vencido (1 d)");
  });

  it("uses singular 'día' for a 1-day overdue count", () => {
    render(<SlaBadge severity="medium" status="triaged" createdAt={daysAgo(8)} now={NOW} />);
    // medium tier = 7 days; 8 days old → overdue by 1 day.
    expect(screen.getByText("SLA 7 días · vencido hace 1 día")).toBeInTheDocument();
  });
});

// A4 (2026-07-31) — THE AGE-BLIND "EN PLAZO" BADGE.
//
// WHAT THIS BLOCK ASSERTED BEFORE, AND WHY IT WAS A LIE:
//   it("renders an honest 'en plazo' state, not a breach alarm", ...)
//     expect(screen.getByText("SLA 3 días · en plazo")).toBeInTheDocument();
//
// That exact-string assertion CERTIFIED the defect as the contract. It pinned
// a badge that names the severity tier and the breach verdict and nothing
// else — so every non-breached report in the maltrato triage queue rendered
// the identical pill regardless of age. A denuncia filed this morning and one
// filed 13 days ago (both under the 14-day `low` tier) were byte-identical to
// the operator. The word "honest" in the old test name was doing work the
// assertion did not: the badge was not dishonest about the breach, it was
// SILENT about the one fact that orders the queue. Silence in the urgency
// voice of an urgency-ordered queue is the product failing its central job.
//
// The assertions below pin the fact the old one omitted: two reports that
// differ ONLY in age must not render the same badge.
describe("SlaBadge — en plazo (not breached)", () => {
  it("renders the tier, the in-plazo verdict AND the report's age", () => {
    render(<SlaBadge severity="high" status="open" createdAt={daysAgo(1)} now={NOW} />);
    expect(screen.getByText("SLA 3 días · en plazo · ingresada ayer")).toBeInTheDocument();
  });

  it("distinguishes a report filed today from one filed 13 days ago — same tier, same verdict", () => {
    // Both are `low` (14-day tier) and neither is breached, so before A4 both
    // rendered the SAME string. This is the triage case the defect broke.
    const { unmount } = render(
      <SlaBadge severity="low" status="open" createdAt={daysAgo(0)} now={NOW} />,
    );
    const today = screen.getByText(/^SLA 14 días · en plazo/).textContent;
    unmount();

    render(<SlaBadge severity="low" status="open" createdAt={daysAgo(13)} now={NOW} />);
    const older = screen.getByText(/^SLA 14 días · en plazo/).textContent;

    expect(today).toBe("SLA 14 días · en plazo · ingresada hoy");
    expect(older).toBe("SLA 14 días · en plazo · hace 13 días");
    expect(today).not.toBe(older);
  });
});

describe("SlaBadge — historical backlog demotion", () => {
  it("demotes a very old, non-terminal report to a neutral 'Histórico' badge instead of danger chrome", () => {
    // low tier = 14 days; 200 days old passes both the breach AND the
    // HISTORICAL_BACKLOG_DAYS (180) threshold — presentation demotes it.
    render(<SlaBadge severity="low" status="open" createdAt={daysAgo(200)} now={NOW} />);
    expect(screen.getByText("Histórico · sin SLA activo · hace 200 días")).toBeInTheDocument();
    expect(screen.queryByText(/vencido hace/i)).not.toBeInTheDocument();
  });

  // The demotion calms the CHROME, not the record. A 200-day and a 900-day
  // backlog row are not the same case to a municipality being asked why
  // neither was ever closed, so the demoted pill still carries the age.
  it("still separates a 200-day backlog row from a 900-day one", () => {
    const { unmount } = render(
      <SlaBadge severity="low" status="open" createdAt={daysAgo(200)} now={NOW} />,
    );
    const younger = screen.getByText(/^Histórico/).textContent;
    unmount();

    render(<SlaBadge severity="low" status="open" createdAt={daysAgo(900)} now={NOW} />);
    expect(screen.getByText(/^Histórico/).textContent).toBe(
      "Histórico · sin SLA activo · hace 900 días",
    );
    expect(younger).not.toBe(screen.getByText(/^Histórico/).textContent);
  });
});

describe("SlaBadge — terminal statuses", () => {
  it("renders nothing for a closed report, no matter how old or severe", () => {
    const { container } = render(
      <SlaBadge severity="critical" status="closed" createdAt={daysAgo(900)} now={NOW} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for invalid/duplicate reports", () => {
    const { container: c1 } = render(
      <SlaBadge severity="high" status="invalid" createdAt={daysAgo(30)} now={NOW} />,
    );
    expect(c1).toBeEmptyDOMElement();
    const { container: c2 } = render(
      <SlaBadge severity="high" status="duplicate" createdAt={daysAgo(30)} now={NOW} />,
    );
    expect(c2).toBeEmptyDOMElement();
  });
});
