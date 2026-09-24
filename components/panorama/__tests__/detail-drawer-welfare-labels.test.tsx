// @vitest-environment jsdom
//
// Regression guard (leanness/dedup sweep, 2026-08-02, fix #1 + #2): the
// drawer's per-feature label maps used to be LOCAL, hand-rolled copies of
// enums owned elsewhere, and had silently drifted out of sync with the
// canonical source:
//
//   - "denuncias" rendered `kind` off a local WELFARE_KIND_LABEL with 5
//     entries keyed `abuse` — but welfare_reports.kind is the 9-value
//     WelfareReportKind enum (db/schema.ts welfareReportKindEnum) keyed
//     `physical_abuse`, not `abuse`. physical_abuse/chained/no_shelter/
//     dog_fighting/trafficking fell through to the raw English enum value.
//   - "decomisos" rendered `status` off a local CASE_STATUS_LABEL with
//     open/in_progress/escalated/closed/resolved — but cases.status is the
//     CaseStatus enum (db/schema.ts CASE_STATUSES): open/escalated/closed/
//     merged. `in_progress`/`resolved` never occur; `merged` (a real value)
//     fell through to the raw English "merged".
//
// Both now defer to the canonical source (welfareReportKindLabel /
// CASE_STATUS_CONFIG) instead of a second, incomplete opinion. These tests
// FAIL against the pre-fix local maps — physical_abuse and merged would
// render their raw English keys — and pass once FeatureBody defers to the
// canonical source.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeatureBody } from "@/components/panorama/DetailDrawer";

vi.mock("next/navigation", () => ({
  usePathname: () => "/gob/panorama",
}));

afterEach(cleanup);

describe("DetailDrawer FeatureBody — denuncias kind (T5.2 dedup, physical_abuse)", () => {
  it("renders the canonical es-AR label for physical_abuse, never the raw English key", () => {
    render(
      <FeatureBody
        layerId="denuncias"
        properties={{ kind: "physical_abuse", severity: "high", locality: "La Plata" }}
      />,
    );

    expect(screen.getByText("Maltrato físico / golpes / lesiones")).toBeInTheDocument();
    expect(screen.queryByText("physical_abuse")).not.toBeInTheDocument();
  });

  it.each([
    ["chained", "Animal encadenado o sin movilidad"],
    ["no_shelter", "Sin refugio del clima"],
    ["dog_fighting", "Peleas de perros"],
    ["trafficking", "Tráfico / venta clandestina"],
  ])("renders the canonical label for %s (never the raw key)", (kind, label) => {
    render(<FeatureBody layerId="denuncias" properties={{ kind, severity: "low" }} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText(kind)).not.toBeInTheDocument();
  });

  it("still labels the kinds the old local map already covered (no regression)", () => {
    render(<FeatureBody layerId="denuncias" properties={{ kind: "hoarding", severity: "low" }} />);

    expect(screen.getByText("Acumulación de animales")).toBeInTheDocument();
  });
});

describe("DetailDrawer FeatureBody — decomisos status (T5.2 dedup, merged)", () => {
  it("renders the canonical es-AR label for a merged case, never the raw English key", () => {
    render(
      <FeatureBody
        layerId="decomisos"
        properties={{ code: "CASE-0001", status: "merged", openedAt: "2026-01-15" }}
      />,
    );

    expect(screen.getByText("Fusionado")).toBeInTheDocument();
    expect(screen.queryByText("merged")).not.toBeInTheDocument();
  });

  it("still labels the statuses the old local map already covered (no regression)", () => {
    render(
      <FeatureBody
        layerId="decomisos"
        properties={{ code: "CASE-0002", status: "escalated", openedAt: "2026-01-15" }}
      />,
    );

    expect(screen.getByText("Escalado")).toBeInTheDocument();
  });
});
