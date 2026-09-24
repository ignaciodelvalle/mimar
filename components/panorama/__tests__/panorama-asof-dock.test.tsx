// @vitest-environment jsdom
//
// PO decision 2026-07-26 — a temporal frame survives a dock tab change.
//
// The original guard cleared `asOf` whenever the "Línea de tiempo" pane was
// hidden, dock-collapsed OR any other tab. Its premise was that a scrubbed
// frame would otherwise sit on screen with nothing announcing it. That premise
// no longer holds: the vista caption states the corte and current-state KPI
// tiles carry an "ESTADO ACTUAL · NO VARÍA CON LA FECHA" badge, both OUTSIDE
// the dock.
//
// What the guard cost: reproducing a past moment and crossing it against the
// ranking or the records table is the instrument's central use, and clicking
// "Registros" to inspect a frame destroyed that frame.
//
// This fences the RULE, not the wiring: hiding the scrubber by switching tabs
// must NOT reset the frame, while collapsing the dock still must — with the
// dock shut there is no control on screen to move or clear the frame with.

import { describe, expect, it } from "vitest";

import { shouldParkAtLive } from "@/components/panorama/panorama-console-helpers";

describe("temporal frame — survives a tab change, not a collapse", () => {
  it("keeps the frame when the operator switches to another dock tab", () => {
    expect(shouldParkAtLive({ dockOpen: true, dockTab: "table", asOf: "2026-06-15" })).toBe(false);
  });

  it("keeps the frame on the ranking tab — the whole point of crossing it", () => {
    expect(shouldParkAtLive({ dockOpen: true, dockTab: "stats", asOf: "2026-06-15" })).toBe(false);
  });

  it("parks at live when the dock is collapsed — no control left on screen", () => {
    expect(shouldParkAtLive({ dockOpen: false, dockTab: "timeline", asOf: "2026-06-15" })).toBe(
      true,
    );
  });

  it("does nothing when there is no frame to park", () => {
    expect(shouldParkAtLive({ dockOpen: false, dockTab: "timeline", asOf: null })).toBe(false);
  });
});
