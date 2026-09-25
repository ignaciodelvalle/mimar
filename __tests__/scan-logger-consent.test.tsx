// Structure test — ScanLogger (Task #45).
//
// Rendering strategy mirrors the repo's other component structure tests:
// react-dom/server → static HTML string, no jsdom. useEffect does not run
// under renderToStaticMarkup, so no scan is fired here — the action module is
// mocked out entirely.
//
// Contract (PO 2026-07-24, Option A; W8 2026-09-24 — no device location):
//   - ScanLogger renders NOTHING (returns null) for ANY pet. It only fires the
//     coordless scan-floor action on mount (not exercised here). It NO LONGER
//     renders an on-load location-consent prompt, and nothing in the product
//     reads the device's location any more: a finder who reports a sighting
//     places the point by hand (PetSightingForm → LocationFields: address
//     search or map pin).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/scans", () => ({
  logScanAction: vi.fn(async () => undefined),
}));

import { ScanLogger } from "@/app/(public)/p/[publicToken]/ScanLogger";

describe("ScanLogger — passive scan floor only (no on-load location prompt)", () => {
  it("renders nothing (no on-load location-consent card)", () => {
    const html = renderToStaticMarkup(<ScanLogger publicToken="DIM-TEST-0001" />);
    expect(html).toBe("");
  });

  it("never renders the removed on-load consent copy", () => {
    const html = renderToStaticMarkup(<ScanLogger publicToken="DIM-TEST-0001" />);
    expect(html).not.toContain("Compartir mi ubicación");
    expect(html).not.toContain("Compartí tu ubicación");
  });
});
