// Unit tests for the pure gating logic behind PR-2's destructive-action friction.
//
// Covers:
//   C5 — per-type breakdown + RUPGA warning for bulk approval
//   C6 — positive_rabies close requires typed confirmation OR acknowledgement
//   C7 — spam confirmation requires the irreversibility acknowledgement
//
// These are pure functions (no DB, no DOM), so the test is fast and hermetic.

import { describe, expect, it } from "vitest";

import {
  POSITIVE_RABIES_OUTCOME,
  RABIES_CONFIRMATION_WORD,
  canSubmitModeration,
  canSubmitObservationClose,
} from "@/lib/domain/destructive-confirmation";
import {
  RUPGA_APPROVAL_WARNING,
  RUPGA_TYPE,
  computeApprovalTypeBreakdown,
  selectionHasRupga,
} from "@/lib/infra/approval-queue-breakdown";

// ============================================================================
// C5 — bulk approval breakdown
// ============================================================================

describe("computeApprovalTypeBreakdown (C5)", () => {
  it("counts each selected type and omits zero-count types", () => {
    const breakdown = computeApprovalTypeBreakdown([
      "role_upgrade_vet",
      "role_upgrade_vet",
      "organization_verification",
    ]);

    expect(breakdown).toEqual([
      { type: "role_upgrade_vet", label: "Matrículas veterinarias", count: 2 },
      {
        type: "organization_verification",
        label: "Verificación de organizaciones",
        count: 1,
      },
    ]);
    // RUPGA was not selected → omitted.
    expect(breakdown.some((e) => e.type === RUPGA_TYPE)).toBe(false);
  });

  it("returns an empty breakdown for an empty selection", () => {
    expect(computeApprovalTypeBreakdown([])).toEqual([]);
  });

  it("preserves the canonical type order regardless of selection order", () => {
    const breakdown = computeApprovalTypeBreakdown([
      "service_dog_credential_verification",
      "role_upgrade_vet",
    ]);
    expect(breakdown.map((e) => e.type)).toEqual([
      "role_upgrade_vet",
      "service_dog_credential_verification",
    ]);
  });
});

describe("selectionHasRupga (C5)", () => {
  it("is true when a RUPGA credential is selected", () => {
    expect(selectionHasRupga(["role_upgrade_vet", RUPGA_TYPE])).toBe(true);
  });

  it("is false when no RUPGA credential is selected", () => {
    expect(selectionHasRupga(["role_upgrade_vet", "organization_verification"])).toBe(false);
  });

  it("exposes a non-empty CUD warning string for the UI", () => {
    expect(RUPGA_APPROVAL_WARNING).toMatch(/CUD/);
  });
});

// ============================================================================
// C6 — positive_rabies close gating
// ============================================================================

describe("canSubmitObservationClose (C6)", () => {
  it("blocks submit when no outcome is selected", () => {
    expect(
      canSubmitObservationClose({ outcome: "", typedConfirmation: "", acknowledged: false }),
    ).toBe(false);
  });

  it("allows non-rabies outcomes with no extra friction", () => {
    expect(
      canSubmitObservationClose({
        outcome: "negative",
        typedConfirmation: "",
        acknowledged: false,
      }),
    ).toBe(true);
    expect(
      canSubmitObservationClose({ outcome: "dead", typedConfirmation: "", acknowledged: false }),
    ).toBe(true);
  });

  it("blocks positive_rabies until typed confirmation OR acknowledgement", () => {
    expect(
      canSubmitObservationClose({
        outcome: POSITIVE_RABIES_OUTCOME,
        typedConfirmation: "",
        acknowledged: false,
      }),
    ).toBe(false);
  });

  it("allows positive_rabies when the confirmation word is typed (case/space-insensitive)", () => {
    expect(
      canSubmitObservationClose({
        outcome: POSITIVE_RABIES_OUTCOME,
        typedConfirmation: `  ${RABIES_CONFIRMATION_WORD.toLowerCase()} `,
        acknowledged: false,
      }),
    ).toBe(true);
  });

  it("allows positive_rabies when the acknowledgement box is ticked", () => {
    expect(
      canSubmitObservationClose({
        outcome: POSITIVE_RABIES_OUTCOME,
        typedConfirmation: "",
        acknowledged: true,
      }),
    ).toBe(true);
  });

  it("rejects a wrong confirmation word", () => {
    expect(
      canSubmitObservationClose({
        outcome: POSITIVE_RABIES_OUTCOME,
        typedConfirmation: "SI",
        acknowledged: false,
      }),
    ).toBe(false);
  });
});

// ============================================================================
// C7 — spam confirmation gating
// ============================================================================

describe("canSubmitModeration (C7)", () => {
  it("blocks the idle mode entirely", () => {
    expect(canSubmitModeration({ mode: "none", notes: "x".repeat(20), acknowledged: true })).toBe(
      false,
    );
  });

  it("pass-to-triage only needs the notes gate (no acknowledgement)", () => {
    expect(canSubmitModeration({ mode: "pass", notes: "short", acknowledged: false })).toBe(false);
    expect(
      canSubmitModeration({ mode: "pass", notes: "legítima por X motivo", acknowledged: false }),
    ).toBe(true);
  });

  it("spam needs BOTH the notes gate AND the irreversibility acknowledgement", () => {
    // notes ok but not acknowledged → blocked
    expect(
      canSubmitModeration({ mode: "spam", notes: "patrón repetido spam", acknowledged: false }),
    ).toBe(false);
    // acknowledged but notes too short → blocked
    expect(canSubmitModeration({ mode: "spam", notes: "corto", acknowledged: true })).toBe(false);
    // both satisfied → allowed
    expect(
      canSubmitModeration({ mode: "spam", notes: "patrón repetido spam", acknowledged: true }),
    ).toBe(true);
  });
});
