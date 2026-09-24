// Tier-2 libreta share — amendment overlay coverage.
//
// Event-sourcing integrity review 2026-07-04, item 1: the shared libreta
// (vet-facing clinical surface) rendered RAW event payloads, so corrections
// recorded via event_amended were invisible exactly where a wrong dose or
// vaccine name matters most.
//
// Two layers of protection:
//   1. Behavior: the exact pipeline the page uses — overlayAmendments →
//      groupLibretaEvents — projects the corrected value into the grouped
//      output and drops the event_amended row itself (it is an audit
//      artifact, not a clinical entry).
//   2. Convention: a source-level assertion that page.tsx keeps fetching
//      event_amended rows and applying overlayAmendments before grouping.
//      Same regex-linter approach as §4.4 event-payload-validation-convention.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { overlayAmendments } from "@/lib/infra/amendment";
import { groupLibretaEvents } from "@/lib/infra/libreta-sanitaria";

// ---------------------------------------------------------------------------
// 1. Behavior — amended event renders the corrected value on the share view
// ---------------------------------------------------------------------------

describe("shared libreta amendment overlay pipeline", () => {
  const vaccinationId = "11111111-1111-4111-8111-111111111111";

  const events = [
    // The correction: vaccine_name was recorded wrong and amended later.
    {
      id: "22222222-2222-4222-8222-222222222222",
      eventType: "event_amended",
      occurredAt: new Date("2026-07-02T10:00:00Z"),
      payload: {
        payload_version: 1,
        target_event_id: vaccinationId,
        reason: "typo",
        changes: [{ field: "vaccine_name", old: "Séxtuple", new: "Antirrábica" }],
      },
    },
    // The original clinical entry with the WRONG value.
    {
      id: vaccinationId,
      eventType: "vaccination_administered",
      occurredAt: new Date("2026-07-01T10:00:00Z"),
      payload: {
        payload_version: 1,
        vaccine_name: "Séxtuple",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
    },
  ];

  it("projects the corrected value into the grouped libreta output", () => {
    const grouped = groupLibretaEvents(overlayAmendments(events));

    expect(grouped.vacunas).toHaveLength(1);
    const projected = grouped.vacunas[0].payload as Record<string, unknown>;
    expect(projected.vaccine_name).toBe("Antirrábica");
    // The overlay also marks the row as corrected for badge rendering.
    expect(grouped.vacunas[0].amendedAt).toEqual(new Date("2026-07-02T10:00:00Z"));
  });

  it("drops the event_amended row itself from every group", () => {
    const grouped = groupLibretaEvents(overlayAmendments(events));
    const all = Object.values(grouped).flat();
    expect(all.some((e) => e.eventType === "event_amended")).toBe(false);
  });

  it("without the overlay the raw (wrong) value would render — regression guard", () => {
    // Documents the pre-fix failure mode: grouping the raw stream shows the
    // uncorrected value. If this ever passes with the corrected value, the
    // overlay became redundant and this file should be revisited.
    const grouped = groupLibretaEvents(events);
    const raw = grouped.vacunas[0].payload as Record<string, unknown>;
    expect(raw.vaccine_name).toBe("Séxtuple");
  });
});

// ---------------------------------------------------------------------------
// 2. Convention — page.tsx must keep the overlay wired in
// ---------------------------------------------------------------------------

describe("share page applies overlayAmendments before groupLibretaEvents", () => {
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

  it("fetches event_amended rows alongside libreta entries", () => {
    expect(src).toMatch(/event_amended/);
  });

  it("wraps the event stream with overlayAmendments before grouping", () => {
    expect(src).toMatch(/groupLibretaEvents\(\s*overlayAmendments\(/);
  });
});
