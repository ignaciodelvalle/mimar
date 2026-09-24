// C2a — KPI ↔ layer relevance (manual-mode honesty).

import { describe, expect, it } from "vitest";

import {
  isKpiRelevant,
  partitionKpiIdsByRelevance,
} from "@/src/modules/panorama/domain/metric-relevance";
import type { PanoramaKpiId } from "@/src/modules/panorama/domain/types";

describe("isKpiRelevant", () => {
  it("is true when the KPI's namesake layer is active", () => {
    expect(isKpiRelevant("cobertura", ["cobertura"])).toBe(true);
    expect(isKpiRelevant("denuncias", ["denuncias", "decomisos"])).toBe(true);
  });

  it("is false when no related layer is active", () => {
    expect(isKpiRelevant("cobertura", ["denuncias"])).toBe(false);
    expect(isKpiRelevant("zoonosis", ["esterilizacion", "refugios"])).toBe(false);
  });

  it("is false for an empty active-layer set", () => {
    expect(isKpiRelevant("mordeduras", [])).toBe(false);
  });

  it("cross-links pérdidas ↔ reunificación (derived outcome of the same events)", () => {
    expect(isKpiRelevant("reunificacion", ["perdidas"])).toBe(true);
    expect(isKpiRelevant("perdidas", ["reunificacion"])).toBe(true);
  });
});

describe("partitionKpiIdsByRelevance", () => {
  it("splits by relevance while preserving input order in both groups", () => {
    const kpis: { id: PanoramaKpiId }[] = [
      { id: "cobertura" },
      { id: "denuncias" },
      { id: "zoonosis" },
      { id: "mordeduras" },
    ];
    const { relevant, irrelevant } = partitionKpiIdsByRelevance(kpis, ["denuncias"]);
    expect(relevant.map((k) => k.id)).toEqual(["denuncias"]);
    expect(irrelevant.map((k) => k.id)).toEqual(["cobertura", "zoonosis", "mordeduras"]);
  });

  it("puts everything in irrelevant when no layer matches", () => {
    const kpis: { id: PanoramaKpiId }[] = [{ id: "cobertura" }, { id: "zoonosis" }];
    const { relevant, irrelevant } = partitionKpiIdsByRelevance(kpis, ["refugios"]);
    expect(relevant).toEqual([]);
    expect(irrelevant.map((k) => k.id)).toEqual(["cobertura", "zoonosis"]);
  });
});
