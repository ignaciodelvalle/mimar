// Unit tests for lib/outbox-list.ts
//
// Strict TDD mode: tests written before implementation.
// Tests the pure helper functions for breach predicate and filter logic.
// No real DB needed — all tested logic is pure.

import { describe, expect, it } from "vitest";

import {
  ENO_PENDING_TRANSMISSION_STATUS,
  applyOutboxFilters,
  buildBreachCue,
  buildStatusLabel,
  describeEnoNotification,
  externalDeliveryNote,
  isPendingExternalTransmission,
  isSlaBreached,
} from "@/lib/infra/outbox-list";
import {
  ENO_DISEASES_AR,
  diseaseCodeToEnoCode,
} from "@/src/modules/surveillance/domain/eno-catalog";

// ---------------------------------------------------------------------------
// describeEnoNotification — the legal queue's "Enfermedad · plazo legal" cell
// (2026-09-09). Reads the enqueue-time payload snapshot; bridges the code the
// SAME way the SLA was minted (event-outbox-rules.ts), so the hours shown are
// the hours the row's sla_due_at came from.
// ---------------------------------------------------------------------------

describe("describeEnoNotification", () => {
  it("names the catalog disease and its statutory window for a snapshot carrying disease_code", () => {
    // Every catalog entry must round-trip through the bridge — the cell is
    // only honest if the code the enqueue rule accepted is the code we read.
    for (const disease of ENO_DISEASES_AR) {
      expect(describeEnoNotification({ disease_code: disease.code, sub_kind: "x" })).toEqual({
        diseaseLabel: disease.label,
        legalHours: disease.notifyHours,
      });
    }
    // The catalog's first entry is rabies: 24 h, the number the deck quotes.
    expect(describeEnoNotification({ disease_code: "rabies" })).toEqual({
      diseaseLabel: "Rabia",
      legalHours: 24,
    });
  });

  it("bridges a diseases.ts code through diseaseCodeToEnoCode, never a second mapping", () => {
    const bridged = diseaseCodeToEnoCode("rabies");
    expect(describeEnoNotification({ disease_code: "rabies" })?.diseaseLabel).toBe(
      ENO_DISEASES_AR.find((d) => d.code === bridged)?.label,
    );
  });

  it("returns null — never an invented disease — for a non-ENO code, a missing code, or a malformed snapshot", () => {
    expect(describeEnoNotification({ disease_code: "not_a_disease" })).toBeNull();
    expect(describeEnoNotification({ disease_code: "" })).toBeNull();
    expect(describeEnoNotification({ disease_code: 42 })).toBeNull();
    expect(describeEnoNotification({ sub_kind: "disease_diagnosis" })).toBeNull();
    expect(describeEnoNotification(null)).toBeNull();
    expect(describeEnoNotification(undefined)).toBeNull();
    expect(describeEnoNotification("rabies")).toBeNull();
    expect(describeEnoNotification([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isSlaBreached — breach predicate
// ---------------------------------------------------------------------------

describe("isSlaBreached", () => {
  it("returns true when status is pending and slaDueAt is in the past", () => {
    const past = new Date(Date.now() - 60_000); // 1 min ago
    expect(isSlaBreached("pending", past)).toBe(true);
  });

  it("returns false when status is pending and slaDueAt is in the future", () => {
    const future = new Date(Date.now() + 60_000); // 1 min from now
    expect(isSlaBreached("pending", future)).toBe(false);
  });

  it("returns false when status is delivered (regardless of slaDueAt)", () => {
    const past = new Date(Date.now() - 60_000);
    expect(isSlaBreached("delivered", past)).toBe(false);
  });

  it("returns false when status is failed (terminal, not a SLA breach)", () => {
    const past = new Date(Date.now() - 60_000);
    expect(isSlaBreached("failed", past)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildStatusLabel — human-readable status
// ---------------------------------------------------------------------------

describe("buildStatusLabel", () => {
  it("maps delivered to the expected Spanish label", () => {
    expect(buildStatusLabel("delivered")).toBe("Entregado");
  });

  it("maps failed to the expected Spanish label", () => {
    expect(buildStatusLabel("failed")).toBe("Fallido");
  });

  it("maps pending to the expected Spanish label", () => {
    expect(buildStatusLabel("pending")).toBe("Pendiente");
  });

  // G7 (2026-08-02): a delivered eno_authority row must NEVER read
  // "Entregado" — no external receiving endpoint exists, so 'delivered' only
  // means our pipeline processed the row. The honest pending-transmission
  // state IS the status, not a footnote.
  describe("G7 — endpoint-less external-authority rows", () => {
    it("relabels delivered+eno_authority to the honest pending-transmission state", () => {
      expect(buildStatusLabel("delivered", "eno_authority")).toBe(ENO_PENDING_TRANSMISSION_STATUS);
    });

    it("never shows 'Entregado' for a delivered eno_authority row", () => {
      expect(buildStatusLabel("delivered", "eno_authority")).not.toBe("Entregado");
      expect(buildStatusLabel("delivered", "eno_authority")).not.toMatch(/entregad/i);
    });

    // CORRECTED 2026-08-04 (copy audit). This test used to assert the OPPOSITE
    // — that these three keep "Entregado" because they are "genuinely
    // delivered". They are not: deliverOutboxRow routes all four kinds into the
    // same v1 no-op branch, whose audit payload says `v1_noop: true` and "real
    // receiver not yet implemented". The test was defending the defect.
    it("never shows 'Entregado' for any kind — v1 has no real receiver", () => {
      for (const kind of ["govt_webhook", "audit_export", "internal_dashboard"]) {
        expect(buildStatusLabel("delivered", kind)).not.toMatch(/entregad/i);
      }
    });

    it("gives each kind its own destination-accurate wording", () => {
      expect(buildStatusLabel("delivered", "govt_webhook")).toMatch(/webhook/i);
      expect(buildStatusLabel("delivered", "audit_export")).toMatch(/exportación/i);
      expect(buildStatusLabel("delivered", "internal_dashboard")).toMatch(/tablero/i);
      // A govt_webhook row must not borrow the ENO phrasing.
      expect(buildStatusLabel("delivered", "govt_webhook")).not.toMatch(/autoridad/i);
    });

    it("only relabels the delivered status — pending/failed eno rows keep honest labels", () => {
      expect(buildStatusLabel("pending", "eno_authority")).toBe("Pendiente");
      expect(buildStatusLabel("failed", "eno_authority")).toBe("Fallido");
    });

    it("keeps the kind-agnostic label when no targetKind is given (filter options)", () => {
      expect(buildStatusLabel("delivered")).toBe("Entregado");
    });
  });
});

// ---------------------------------------------------------------------------
// isPendingExternalTransmission — the endpoint-less delivered class (G7)
// ---------------------------------------------------------------------------

describe("isPendingExternalTransmission", () => {
  it("is true exactly for delivered + eno_authority", () => {
    expect(isPendingExternalTransmission("delivered", "eno_authority")).toBe(true);
  });

  it("is false for every other status of an eno_authority row", () => {
    expect(isPendingExternalTransmission("pending", "eno_authority")).toBe(false);
    expect(isPendingExternalTransmission("failed", "eno_authority")).toBe(false);
  });

  // CORRECTED 2026-08-04: in v1 every kind is endpoint-less, so a delivered row
  // of ANY kind is pending external transmission.
  it("is true for delivered rows of every kind — none has a receiver in v1", () => {
    expect(isPendingExternalTransmission("delivered", "govt_webhook")).toBe(true);
    expect(isPendingExternalTransmission("delivered", "audit_export")).toBe(true);
    expect(isPendingExternalTransmission("delivered", "internal_dashboard")).toBe(true);
  });

  it("is false for a kind with no note — the class has one definition", () => {
    // The escape hatch that lets a real receiver ship: drop the kind from
    // PENDING_TRANSMISSION_BY_KIND and both the status and the note follow.
    expect(isPendingExternalTransmission("delivered", "kind_with_real_receiver")).toBe(false);
  });

  it("stays anchored on externalDeliveryNote (one definition of the class)", () => {
    // If a target kind gains a note, it must also gain the honest relabel.
    expect(isPendingExternalTransmission("delivered", "eno_authority")).toBe(
      externalDeliveryNote("eno_authority") !== null,
    );
  });
});

// ---------------------------------------------------------------------------
// externalDeliveryNote — C2 honest-delivery note (2026-07-22)
// ---------------------------------------------------------------------------

describe("externalDeliveryNote", () => {
  it("returns the honest external-transmission note for eno_authority", () => {
    const note = externalDeliveryNote("eno_authority");
    expect(note).toBe(
      "Registrada y auditada — transmisión a la autoridad pendiente de endpoint receptor.",
    );
  });

  it("never says 'próximamente' (the pipeline itself is real, running today)", () => {
    expect(externalDeliveryNote("eno_authority")).not.toMatch(/próximamente/i);
  });

  // CORRECTED 2026-08-04: the old assertion encoded the false claim that these
  // three "resolve to a real, already-built destination". They do not.
  it("returns a note for all four v1 kinds", () => {
    for (const kind of ["eno_authority", "govt_webhook", "audit_export", "internal_dashboard"]) {
      expect(externalDeliveryNote(kind)).not.toBeNull();
    }
  });

  it("returns null for an unknown kind (so a real receiver can opt out)", () => {
    expect(externalDeliveryNote("kind_with_real_receiver")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildBreachCue — traffic-light emoji
// ---------------------------------------------------------------------------

describe("buildBreachCue", () => {
  it("returns green circle for delivered rows", () => {
    const future = new Date(Date.now() + 60_000);
    expect(buildBreachCue("delivered", future)).toBe("delivered");
  });

  it("returns failed indicator for failed rows", () => {
    const past = new Date(Date.now() - 60_000);
    expect(buildBreachCue("failed", past)).toBe("failed");
  });

  it("returns breach indicator for pending rows past SLA", () => {
    const past = new Date(Date.now() - 60_000);
    expect(buildBreachCue("pending", past)).toBe("breach");
  });

  it("returns ok indicator for pending rows within SLA", () => {
    const future = new Date(Date.now() + 60_000);
    expect(buildBreachCue("pending", future)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// applyOutboxFilters — JS-side filter predicate
// ---------------------------------------------------------------------------

describe("applyOutboxFilters", () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);

  const rows = [
    {
      status: "pending" as const,
      targetKind: "govt_webhook",
      slaDueAt: past,
      targetJurisdictionProvince: "Buenos Aires",
    },
    {
      status: "delivered" as const,
      targetKind: "eno_authority",
      slaDueAt: future,
      targetJurisdictionProvince: "Córdoba",
    },
    {
      status: "pending" as const,
      targetKind: "govt_webhook",
      slaDueAt: future,
      targetJurisdictionProvince: "Santa Fe",
    },
  ];

  it("returns all rows when no filters applied", () => {
    expect(applyOutboxFilters(rows, {})).toHaveLength(3);
  });

  it("filters by status=delivered returns only delivered rows", () => {
    const result = applyOutboxFilters(rows, { status: "delivered" });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("delivered");
  });

  it("filters by breach=yes returns only pending+past-SLA rows", () => {
    const result = applyOutboxFilters(rows, { breach: "yes" });
    expect(result).toHaveLength(1);
    expect(result[0].targetJurisdictionProvince).toBe("Buenos Aires");
  });

  it("filters by province returns only matching jurisdiction rows", () => {
    const result = applyOutboxFilters(rows, { province: "Córdoba" });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("delivered");
  });
});
