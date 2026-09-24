// lib/metrics/alert-firing.test.ts — pure unit tests for the firing domain (K1).
// No DB, no I/O.

import { describe, expect, it } from "vitest";

import type { AlertFiringStatus } from "@/db/schema";
import {
  type AlertFiringTransition,
  investigationDiseaseCode,
  isOpenStatus,
  metricOpensInvestigation,
  nextStatus,
  shouldOpenFiring,
} from "./alert-firing";

describe("isOpenStatus", () => {
  it("treats the 4 non-terminal statuses as open", () => {
    for (const s of [
      "disparada",
      "reconocida",
      "en_investigacion",
      "autoridad_contactada",
    ] as AlertFiringStatus[]) {
      expect(isOpenStatus(s)).toBe(true);
    }
  });

  it("treats resuelta and descartada as closed", () => {
    expect(isOpenStatus("resuelta")).toBe(false);
    expect(isOpenStatus("descartada")).toBe(false);
  });
});

describe("shouldOpenFiring — dedup gate", () => {
  it("opens when breaching and no existing open firing", () => {
    expect(shouldOpenFiring([], { breaching: true })).toBe(true);
  });

  it("does NOT open when not breaching", () => {
    expect(shouldOpenFiring([], { breaching: false })).toBe(false);
  });

  it("does NOT open a second firing while one is already open (dedup)", () => {
    expect(shouldOpenFiring([{ status: "disparada" }], { breaching: true })).toBe(false);
    expect(shouldOpenFiring([{ status: "en_investigacion" }], { breaching: true })).toBe(false);
  });

  it("opens again once all prior firings are closed", () => {
    expect(
      shouldOpenFiring([{ status: "resuelta" }, { status: "descartada" }], { breaching: true }),
    ).toBe(true);
  });

  it("respects a mix: any open row blocks, all-closed allows", () => {
    expect(
      shouldOpenFiring([{ status: "resuelta" }, { status: "reconocida" }], { breaching: true }),
    ).toBe(false);
  });
});

describe("nextStatus — validated state machine", () => {
  // Happy path: disparada → reconocida → en_investigacion → autoridad_contactada → resuelta
  it("acknowledge: disparada → reconocida", () => {
    expect(nextStatus("disparada", "acknowledge")).toBe("reconocida");
  });

  it("open_investigation: reconocida → en_investigacion", () => {
    expect(nextStatus("reconocida", "open_investigation")).toBe("en_investigacion");
  });

  it("contact_authority: en_investigacion → autoridad_contactada", () => {
    expect(nextStatus("en_investigacion", "contact_authority")).toBe("autoridad_contactada");
  });

  it("contact_authority: reconocida → autoridad_contactada (skip investigation)", () => {
    expect(nextStatus("reconocida", "contact_authority")).toBe("autoridad_contactada");
  });

  it("resolve: from any worked status → resuelta", () => {
    expect(nextStatus("reconocida", "resolve")).toBe("resuelta");
    expect(nextStatus("en_investigacion", "resolve")).toBe("resuelta");
    expect(nextStatus("autoridad_contactada", "resolve")).toBe("resuelta");
  });

  it("dismiss: disparada | reconocida → descartada", () => {
    expect(nextStatus("disparada", "dismiss")).toBe("descartada");
    expect(nextStatus("reconocida", "dismiss")).toBe("descartada");
  });

  // Illegal transitions return null.
  it("rejects acknowledging an already-acknowledged firing", () => {
    expect(nextStatus("reconocida", "acknowledge")).toBeNull();
  });

  it("rejects resolving straight from disparada (must be acknowledged first)", () => {
    expect(nextStatus("disparada", "resolve")).toBeNull();
  });

  it("rejects re-opening a closed firing (resuelta → reconocida is impossible)", () => {
    for (const transition of [
      "acknowledge",
      "open_investigation",
      "contact_authority",
      "resolve",
      "dismiss",
    ] as AlertFiringTransition[]) {
      expect(nextStatus("resuelta", transition)).toBeNull();
      expect(nextStatus("descartada", transition)).toBeNull();
    }
  });

  it("rejects opening an investigation from disparada (must acknowledge first)", () => {
    expect(nextStatus("disparada", "open_investigation")).toBeNull();
  });

  it("rejects dismissing an already-investigated firing", () => {
    expect(nextStatus("en_investigacion", "dismiss")).toBeNull();
    expect(nextStatus("autoridad_contactada", "dismiss")).toBeNull();
  });
});

describe("metric → action mapping (K-D2)", () => {
  it("only active_zoonosis opens an investigation", () => {
    expect(metricOpensInvestigation("active_zoonosis")).toBe(true);
    for (const m of [
      "eno_sla_ontime_pct",
      "queue_oldest_days",
      "sterilization_coverage_pct",
      "microchip_penetration_pct",
      "open_welfare_reports",
    ]) {
      expect(metricOpensInvestigation(m)).toBe(false);
    }
  });

  it("active_zoonosis maps to the rabies_suspected disease code", () => {
    expect(investigationDiseaseCode("active_zoonosis")).toBe("rabies_suspected");
  });

  it("non-zoonosis metrics have no disease code", () => {
    expect(investigationDiseaseCode("queue_oldest_days")).toBeNull();
    expect(investigationDiseaseCode("open_welfare_reports")).toBeNull();
  });
});
