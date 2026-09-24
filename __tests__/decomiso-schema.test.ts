// Unit tests for the decomiso (Ley 14.346) foundation slice (S1).
//
// Coverage:
//   1. shelterIntakeRecorded schema — superRefine conditional rules (spec §4.3)
//   2. Audit actions: AUDIT_LOG_ACTIONS includes all 4 decomiso strings (spec §4.5)
//   3. Auth guard: requireDecomisoPrincipal exported from lib/auth-guards
//   4. Capability constant: WELFARE_DECOMISO_EXECUTE_CAPABILITY exported

import { describe, expect, it } from "vitest";

import { AUDIT_LOG_ACTIONS } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";

const VALID_UUID = "eb40c5e3-76b7-4985-81f3-37776ff4183b";
const VALID_UUID_2 = "9180cd33-7a5f-470c-8263-ec14c69c5ac2";

const nonSeizureBase = {
  intake_reason: "rescue" as const,
  intake_condition: "good",
  rescue_jurisdiction: "PBA",
};

const seizureBase = {
  intake_reason: "seizure" as const,
  intake_condition: "poor",
  rescue_jurisdiction: "CABA",
  seizure_motive: "maltrato_fisico" as const,
  intended_receiver_organization_id: VALID_UUID,
};

describe("shelterIntakeRecorded — non-seizure intakes (backward-compatible)", () => {
  it("accepts the pre-decomiso shape (rescue, no new fields)", () => {
    expect(() => validateEventPayload("shelter_intake_recorded", nonSeizureBase)).not.toThrow();
  });

  it("accepts surrender without any seizure fields", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        intake_reason: "surrender",
        intake_condition: null,
        rescue_jurisdiction: null,
      }),
    ).not.toThrow();
  });

  it("accepts stray_found without any seizure fields", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        intake_reason: "stray_found",
        intake_condition: null,
        rescue_jurisdiction: null,
      }),
    ).not.toThrow();
  });

  it("non-seizure: seizure_motive present but null — valid", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", { ...nonSeizureBase, seizure_motive: null }),
    ).not.toThrow();
  });

  it("non-seizure: intended_receiver_organization_id absent — valid", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", { ...nonSeizureBase }),
    ).not.toThrow();
  });
});

describe("shelterIntakeRecorded — seizure intake (spec §4.3)", () => {
  it("accepts a valid seizure payload with all required fields", () => {
    expect(() => validateEventPayload("shelter_intake_recorded", seizureBase)).not.toThrow();
  });

  it("accepts seizure with all optional fields populated", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        ...seizureBase,
        seizure_motive_other_detail: null,
        judicial_proceeding_reference: "Expte 12345/2026",
        originating_welfare_report_id: VALID_UUID_2,
      }),
    ).not.toThrow();
  });

  it("rejects seizure with missing seizure_motive", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        intake_reason: "seizure",
        intake_condition: null,
        rescue_jurisdiction: null,
        intended_receiver_organization_id: VALID_UUID,
      }),
    ).toThrow();
  });

  it("rejects seizure with seizure_motive=null", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        ...seizureBase,
        seizure_motive: null,
      }),
    ).toThrow();
  });

  it("rejects seizure with missing intended_receiver_organization_id", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        intake_reason: "seizure",
        intake_condition: null,
        rescue_jurisdiction: null,
        seizure_motive: "abandono_extremo",
      }),
    ).toThrow();
  });

  it("rejects seizure with null intended_receiver_organization_id", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        ...seizureBase,
        intended_receiver_organization_id: null,
      }),
    ).toThrow();
  });

  it("rejects seizure with invalid UUID for intended_receiver_organization_id", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        ...seizureBase,
        intended_receiver_organization_id: "not-a-uuid",
      }),
    ).toThrow();
  });
});

describe("shelterIntakeRecorded — seizure_motive otro conditional", () => {
  it("accepts seizure_motive=otro when seizure_motive_other_detail is provided", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        ...seizureBase,
        seizure_motive: "otro",
        seizure_motive_other_detail: "Incumplimiento ordenanza municipal 4521",
      }),
    ).not.toThrow();
  });

  it("rejects seizure_motive=otro without seizure_motive_other_detail", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        ...seizureBase,
        seizure_motive: "otro",
      }),
    ).toThrow();
  });

  it("rejects seizure_motive=otro with null seizure_motive_other_detail", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        ...seizureBase,
        seizure_motive: "otro",
        seizure_motive_other_detail: null,
      }),
    ).toThrow();
  });

  it("does NOT require seizure_motive_other_detail for motives other than otro", () => {
    const motives = [
      "maltrato_fisico",
      "abandono_extremo",
      "acumulacion",
      "trafico",
      "sin_refugio_critico",
      "pelea_de_perros",
    ] as const;
    for (const motive of motives) {
      expect(() =>
        validateEventPayload("shelter_intake_recorded", {
          ...seizureBase,
          seizure_motive: motive,
        }),
      ).not.toThrow();
    }
  });
});

describe("shelterIntakeRecorded — strict schema", () => {
  it("rejects unknown extra keys on a seizure payload", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        ...seizureBase,
        unexpected_field: "boom",
      }),
    ).toThrow();
  });

  it("rejects unknown extra keys on a non-seizure payload", () => {
    expect(() =>
      validateEventPayload("shelter_intake_recorded", {
        ...nonSeizureBase,
        unexpected_field: "boom",
      }),
    ).toThrow();
  });
});

describe("AUDIT_LOG_ACTIONS — decomiso entries (spec §4.5)", () => {
  const decoActions = [
    "decomiso_executed",
    "decomiso_handoff_accepted",
    "decomiso_handoff_rejected",
    "decomiso_handoff_cancelled",
  ] as const;

  for (const action of decoActions) {
    it(`includes ${action}`, () => {
      expect(AUDIT_LOG_ACTIONS).toContain(action);
    });
  }
});

describe("requireDecomisoPrincipal — export check", () => {
  it("is exported from lib/auth-guards", async () => {
    const guards = await import("@/lib/infra/auth-guards");
    expect(typeof guards.requireDecomisoPrincipal).toBe("function");
  });
});

describe("WELFARE_DECOMISO_EXECUTE_CAPABILITY", () => {
  it("is exported from domain/capabilities with value welfare.decomiso.execute", async () => {
    const caps = await import("@/src/modules/organizations/domain/capabilities");
    expect(caps.WELFARE_DECOMISO_EXECUTE_CAPABILITY).toBe("welfare.decomiso.execute");
  });
});
