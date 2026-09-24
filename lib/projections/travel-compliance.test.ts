// Tests for deriveTravelCompliance (movilidad-jurisdiccional Fase 1).
// Spec R2.1-R2.7, scenarios S5 (min), S6 (max), S7 (union), S9 (semáforo).
//
// The function is PURE — corridors arrive resolved, no DB round-trip (R2.7).
// Goldens use synthetic corridors because the shipped registry deliberately
// carries citation-pending (empty) rule values.

import { describe, expect, it } from "vitest";

import {
  type TravelComplianceInput,
  deriveTravelCompliance,
  deriveTravelContext,
  requirementLevelFor,
} from "@/lib/projections/travel-compliance";
import type { Corridor, CorridorRules } from "@/lib/reference/cross-border-corridors";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-04T12:00:00Z");

function makeCorridor(id: Corridor["id"], label: string, rules: CorridorRules): Corridor {
  return {
    id,
    label,
    jurisdiction: { country: id === "chile" ? "CL" : id === "uruguay" ? "UY" : "BR" },
    version: "test.1",
    effectiveFrom: "2026-01-01",
    sourceUrl: "https://example.gov/test",
    appliesTo: { species: ["dog", "cat"], direction: "outbound_from_ar" },
    rules,
  };
}

function makeInput(overrides?: Partial<TravelComplianceInput>): TravelComplianceInput {
  return {
    now: NOW,
    origin: { country: "AR", province: "Ciudad Autónoma de Buenos Aires", locality: null },
    destinations: [],
    corridors: [],
    travelDate: new Date("2026-08-15T12:00:00Z"),
    events: [],
    ...overrides,
  };
}

const rabiesDose = (occurredAt: string) => ({
  eventType: "vaccination_administered",
  payload: { vaccine_name: "Antirrábica" },
  occurredAt,
});

// ---------------------------------------------------------------------------
// Strictness merges (S5, S6, S7)
// ---------------------------------------------------------------------------

describe("deriveTravelCompliance — strictness merges", () => {
  it("S5 (min): document_issuance_window_days across two corridors takes the tightest", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [
          makeCorridor("chile", "Chile", { document_issuance_window_days: 10 }),
          makeCorridor("uruguay", "Uruguay", { document_issuance_window_days: 5 }),
        ],
      }),
    );
    const ob = state.obligations.find((o) => o.key === "document_issuance_window_days");
    expect(ob).toBeDefined();
    expect(ob?.detail).toContain("5");
    expect(ob?.detail).not.toContain("10");
  });

  it("S6 (max): rabies_vaccination_to_travel_wait_days takes the longest", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [
          makeCorridor("chile", "Chile", { rabies_vaccination_to_travel_wait_days: 21 }),
          makeCorridor("brasil", "Brasil", { rabies_vaccination_to_travel_wait_days: 30 }),
        ],
        events: [rabiesDose("2026-01-10T12:00:00Z")],
      }),
    );
    const ob = state.obligations.find((o) => o.key === "rabies_vaccination_to_travel_wait_days");
    expect(ob).toBeDefined();
    expect(ob?.detail).toContain("30");
  });

  it("S7 (union): required_documents is the union, never a subset", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [
          makeCorridor("chile", "Chile", {
            required_documents: ["health_certificate", "rabies_certificate"],
          }),
          makeCorridor("uruguay", "Uruguay", {
            required_documents: ["health_certificate", "import_permit"],
          }),
        ],
      }),
    );
    const ob = state.obligations.find((o) => o.key === "required_documents");
    expect(ob).toBeDefined();
    for (const doc of ["health_certificate", "rabies_certificate", "import_permit"]) {
      expect(ob?.detail).toContain(doc);
    }
  });

  it("union of boolean flags: required if ANY corridor requires it", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [
          makeCorridor("chile", "Chile", { import_permit_required: false }),
          makeCorridor("uruguay", "Uruguay", { import_permit_required: true }),
        ],
      }),
    );
    const ob = state.obligations.find((o) => o.key === "import_permit_required");
    expect(ob).toBeDefined();
    expect(ob?.requirementLevel).not.toBe("info");
  });

  it("contributingJurisdictions names the corridor(s) that supplied the binding value", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [
          makeCorridor("chile", "Chile", { document_issuance_window_days: 10 }),
          makeCorridor("uruguay", "Uruguay", { document_issuance_window_days: 5 }),
        ],
      }),
    );
    const ob = state.obligations.find((o) => o.key === "document_issuance_window_days");
    expect(ob?.contributingJurisdictions).toContain("Uruguay");
    expect(ob?.contributingJurisdictions).not.toContain("Chile");
  });

  it("union rules list every contributing corridor", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [
          makeCorridor("chile", "Chile", { required_documents: ["health_certificate"] }),
          makeCorridor("uruguay", "Uruguay", { required_documents: ["import_permit"] }),
        ],
      }),
    );
    const ob = state.obligations.find((o) => o.key === "required_documents");
    expect(ob?.contributingJurisdictions).toEqual(expect.arrayContaining(["Chile", "Uruguay"]));
  });
});

// ---------------------------------------------------------------------------
// requirementLevel mapping (R2.6)
// ---------------------------------------------------------------------------

describe("requirementLevelFor — tone → requirementLevel (R2.6)", () => {
  it("over → blocker", () => {
    expect(requirementLevelFor("over", false)).toBe("blocker");
  });
  it("due with reachable deadline → warning", () => {
    expect(requirementLevelFor("due", false)).toBe("warning");
  });
  it("due with lapsed deadline → blocker", () => {
    expect(requirementLevelFor("due", true)).toBe("blocker");
  });
  it("ok → info", () => {
    expect(requirementLevelFor("ok", false)).toBe("info");
  });
  it("neutral (no data) → warning", () => {
    expect(requirementLevelFor("neutral", false)).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// Rabies wait evaluation against events
// ---------------------------------------------------------------------------

describe("deriveTravelCompliance — rabies wait vs travel date", () => {
  const corridor = makeCorridor("chile", "Chile", {
    rabies_vaccination_to_travel_wait_days: 21,
  });

  it("dose old enough → obligation met (info)", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [corridor],
        travelDate: new Date("2026-08-15T12:00:00Z"),
        events: [rabiesDose("2026-01-10T12:00:00Z")],
      }),
    );
    const ob = state.obligations.find((o) => o.key === "rabies_vaccination_to_travel_wait_days");
    expect(ob?.requirementLevel).toBe("info");
    expect(ob?.tone).toBe("ok");
  });

  it("dose too recent for the travel date → blocker", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [corridor],
        travelDate: new Date("2026-07-10T12:00:00Z"),
        events: [rabiesDose("2026-07-01T12:00:00Z")],
      }),
    );
    const ob = state.obligations.find((o) => o.key === "rabies_vaccination_to_travel_wait_days");
    expect(ob?.requirementLevel).toBe("blocker");
  });

  it("no dose but still vaccinable in time → warning", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [corridor],
        travelDate: new Date("2026-08-15T12:00:00Z"),
        events: [],
      }),
    );
    const ob = state.obligations.find((o) => o.key === "rabies_vaccination_to_travel_wait_days");
    expect(ob?.requirementLevel).toBe("warning");
  });

  it("no dose and the wait no longer fits before travel → blocker", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [corridor],
        travelDate: new Date("2026-07-10T12:00:00Z"),
        events: [],
      }),
    );
    const ob = state.obligations.find((o) => o.key === "rabies_vaccination_to_travel_wait_days");
    expect(ob?.requirementLevel).toBe("blocker");
  });
});

// ---------------------------------------------------------------------------
// Semáforo (S9) + staleness metadata (R3.5)
// ---------------------------------------------------------------------------

describe("deriveTravelCompliance — semáforo and disclosure", () => {
  it("S9: any blocker → rojo regardless of other levels", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [
          makeCorridor("chile", "Chile", {
            rabies_vaccination_to_travel_wait_days: 21,
            required_documents: ["health_certificate"],
          }),
        ],
        travelDate: new Date("2026-07-10T12:00:00Z"),
        events: [], // no dose, wait cannot fit → blocker
      }),
    );
    expect(state.semaforo).toBe("rojo");
  });

  it("warnings but no blockers → amarillo", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [makeCorridor("chile", "Chile", { required_documents: ["health_certificate"] })],
      }),
    );
    expect(state.semaforo).toBe("amarillo");
  });

  it("all obligations met → verde", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [makeCorridor("chile", "Chile", { rabies_vaccination_to_travel_wait_days: 21 })],
        travelDate: new Date("2026-08-15T12:00:00Z"),
        events: [rabiesDose("2026-01-10T12:00:00Z")],
      }),
    );
    expect(state.semaforo).toBe("verde");
  });

  it("a corridor with ZERO validated rules yields a pending-validation warning, never verde", () => {
    const state = deriveTravelCompliance(
      makeInput({ corridors: [makeCorridor("chile", "Chile", {})] }),
    );
    expect(state.semaforo).toBe("amarillo");
    const pending = state.obligations.find((o) => o.key === "corridor_rules_pending");
    expect(pending).toBeDefined();
    expect(pending?.requirementLevel).toBe("warning");
    expect(pending?.state).toMatch(/pendiente/i);
  });

  it("exposes per-corridor version/effectiveFrom/sourceUrl for the disclaimer surfaces (R3.5)", () => {
    const state = deriveTravelCompliance(
      makeInput({ corridors: [makeCorridor("chile", "Chile", {})] }),
    );
    expect(state.corridorsShown).toEqual([
      expect.objectContaining({
        id: "chile",
        label: "Chile",
        version: "test.1",
        effectiveFrom: "2026-01-01",
        sourceUrl: "https://example.gov/test",
      }),
    ]);
  });

  it("obligations are sorted worst-first (blocker before warning before info)", () => {
    const state = deriveTravelCompliance(
      makeInput({
        corridors: [
          makeCorridor("chile", "Chile", {
            rabies_vaccination_to_travel_wait_days: 21,
            required_documents: ["health_certificate"],
          }),
        ],
        travelDate: new Date("2026-07-10T12:00:00Z"),
        events: [],
      }),
    );
    const levels = state.obligations.map((o) => o.requirementLevel);
    const order = { blocker: 0, warning: 1, info: 2 } as const;
    const sorted = [...levels].sort((a, b) => order[a] - order[b]);
    expect(levels).toEqual(sorted);
  });

  it("zero corridors and zero destinations → empty obligations, verde withNothing shown", () => {
    const state = deriveTravelCompliance(makeInput({}));
    expect(state.obligations).toHaveLength(0);
    expect(state.corridorsShown).toHaveLength(0);
    expect(state.semaforo).toBe("verde");
  });

  // QA histórico 2026-07-08 item 3: a foreign destination is on record (the
  // pet's jurisdiction changed to Chile) but no corridor could be resolved
  // for it — e.g. no transport_recorded event, or only a stale one. Previous
  // behavior fell through to "verde" off zero obligations, a green that
  // verified nothing. Must render "sin_datos" instead, never a false verde.
  it("foreign destination with zero resolved corridors → sin_datos, never a false verde", () => {
    const state = deriveTravelCompliance(
      makeInput({
        destinations: [{ country: "CL", province: null, locality: null }],
        corridors: [],
      }),
    );
    expect(state.semaforo).toBe("sin_datos");
    const notResolved = state.obligations.find((o) => o.key === "corridor_not_resolved");
    expect(notResolved).toBeDefined();
    expect(notResolved?.state).toMatch(/no disponible/i);
  });

  it("domestic-only destination with zero corridors stays verde (no corridor is expected)", () => {
    const state = deriveTravelCompliance(
      makeInput({
        destinations: [{ country: "AR", province: "Córdoba", locality: null }],
        corridors: [],
      }),
    );
    expect(state.semaforo).toBe("verde");
    expect(state.obligations.find((o) => o.key === "corridor_not_resolved")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deriveTravelContext — movement events → aggregation inputs
// (shared by the /viaje RSC and the travel export use-case)
// ---------------------------------------------------------------------------

describe("deriveTravelContext", () => {
  it("collects destinations from jurisdiction_changed history", () => {
    const ctx = deriveTravelContext(
      [
        {
          sub_kind: "jurisdiction_changed",
          to_country: "AR",
          to_province: "Buenos Aires",
          to_locality: "La Plata",
        },
      ],
      NOW,
    );
    expect(ctx.destinations).toEqual([
      { country: "AR", province: "Buenos Aires", locality: "La Plata" },
    ]);
    expect(ctx.corridorIds).toEqual([]);
    expect(ctx.travelDate).toBeNull();
  });

  it("collects corridor ids and the EARLIEST upcoming travel date from transports", () => {
    const ctx = deriveTravelContext(
      [
        { sub_kind: "transport_recorded", corridor_id: "chile", travel_date: "2026-09-01" },
        { sub_kind: "transport_recorded", corridor_id: "uruguay", travel_date: "2026-08-01" },
      ],
      NOW,
    );
    expect([...ctx.corridorIds].sort()).toEqual(["chile", "uruguay"]);
    expect(ctx.travelDate?.toISOString().slice(0, 10)).toBe("2026-08-01");
  });

  it("ignores stale trips (travel_date older than the recency window)", () => {
    const ctx = deriveTravelContext(
      [{ sub_kind: "transport_recorded", corridor_id: "chile", travel_date: "2025-01-01" }],
      NOW,
    );
    expect(ctx.corridorIds).toEqual([]);
    expect(ctx.travelDate).toBeNull();
  });

  it("keeps a recent past trip (within the 30-day window)", () => {
    const ctx = deriveTravelContext(
      [{ sub_kind: "transport_recorded", corridor_id: "brasil", travel_date: "2026-06-20" }],
      NOW, // 2026-07-04 — 14 days later
    );
    expect(ctx.corridorIds).toEqual(["brasil"]);
  });
});
