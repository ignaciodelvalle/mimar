// Unit tests for pure case-rules derived from lifecycle declarations.
// Layer: Unit (pure functions, no DB, no Next.js).
// TDD: RED written first — case-rules.ts does not exist yet.

import { describe, expect, it } from "vitest";

import {
  CASCADE_TRIGGER_PAYLOAD_KEY,
  allowedStatuses,
  cascadeTriggerPayload,
  isCascadeEvent,
  isTerminalEvent,
  manualOpenAllowed,
  opensCase,
  reopenAllowed,
} from "@/src/modules/cases/domain/case-rules";

// ---------------------------------------------------------------------------
// isTerminalEvent
// ---------------------------------------------------------------------------

describe("isTerminalEvent", () => {
  it("returns true for a terminal event declared in the lifecycle", () => {
    // adoption_application_resolved is terminal for adoption_application
    expect(isTerminalEvent("adoption_application", "adoption_application_resolved")).toBe(true);
  });

  it("returns false for a non-terminal event of the same kind", () => {
    expect(isTerminalEvent("adoption_application", "adoption_application_submitted")).toBe(false);
  });

  it("returns false for event that is terminal in another kind", () => {
    // rabies_observation_ended is terminal for bite_incident, not adoption_application
    expect(isTerminalEvent("adoption_application", "rabies_observation_ended")).toBe(false);
  });

  it("returns true for rabies_observation_ended on bite_incident", () => {
    expect(isTerminalEvent("bite_incident", "rabies_observation_ended")).toBe(true);
  });

  it("returns false for unknown kind", () => {
    // @ts-expect-error — deliberate bad input for runtime guard
    expect(isTerminalEvent("nonexistent_kind", "some_event")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// opensCase
// ---------------------------------------------------------------------------

describe("opensCase", () => {
  it("returns true for an unconditional opens event", () => {
    // adoption_application_submitted unconditionally opens adoption_application
    expect(opensCase("adoption_application", "adoption_application_submitted", {})).toBe(true);
  });

  it("returns true when payload guard passes", () => {
    // adoption_listing opens when eligible=true
    expect(opensCase("adoption_listing", "adoption_eligibility_set", { eligible: true })).toBe(
      true,
    );
  });

  it("returns false when payload guard fails", () => {
    // adoption_listing does NOT open when eligible=false
    expect(opensCase("adoption_listing", "adoption_eligibility_set", { eligible: false })).toBe(
      false,
    );
  });

  it("returns false for an event that does not open the kind", () => {
    expect(opensCase("adoption_application", "adoption_application_resolved", {})).toBe(false);
  });

  it("returns true for incident_reported with bite payload on bite_incident", () => {
    expect(
      opensCase("bite_incident", "incident_reported", { incident_type: "bite_inflicted" }),
    ).toBe(true);
  });

  it("returns false for incident_reported without bite payload on bite_incident", () => {
    expect(opensCase("bite_incident", "incident_reported", { incident_type: "lost" })).toBe(false);
  });

  it("returns false for unknown kind", () => {
    // @ts-expect-error — deliberate bad input
    expect(opensCase("nonexistent_kind", "some_event", {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// manualOpenAllowed
// ---------------------------------------------------------------------------

describe("manualOpenAllowed", () => {
  it("returns true for welfare_denuncia (admin/govt manual open)", () => {
    expect(manualOpenAllowed("welfare_denuncia")).toBe(true);
  });

  it("returns false for adoption_application (no manual open)", () => {
    expect(manualOpenAllowed("adoption_application")).toBe(false);
  });

  it("returns false for bite_incident (event-driven only)", () => {
    expect(manualOpenAllowed("bite_incident")).toBe(false);
  });

  it("returns false for unknown kind", () => {
    // @ts-expect-error — deliberate bad input
    expect(manualOpenAllowed("nonexistent_kind")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reopenAllowed
// ---------------------------------------------------------------------------

describe("reopenAllowed", () => {
  it("returns true only for adoption_listing", () => {
    expect(reopenAllowed("adoption_listing")).toBe(true);
  });

  it("returns false for adoption_application", () => {
    expect(reopenAllowed("adoption_application")).toBe(false);
  });

  it("returns false for bite_incident", () => {
    expect(reopenAllowed("bite_incident")).toBe(false);
  });

  it("returns false for unknown kind", () => {
    // @ts-expect-error — deliberate bad input
    expect(reopenAllowed("nonexistent_kind")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// allowedStatuses
// ---------------------------------------------------------------------------

describe("allowedStatuses", () => {
  it("returns the status values declared in the lifecycle", () => {
    const statuses = allowedStatuses("bite_incident");
    expect(statuses).toEqual(expect.arrayContaining(["open", "escalated", "closed"]));
    expect(statuses).toHaveLength(3);
  });

  it("returns merged in welfare_denuncia status set", () => {
    const statuses = allowedStatuses("welfare_denuncia");
    expect(statuses).toContain("merged");
  });

  it("returns empty array for unknown kind", () => {
    // @ts-expect-error — deliberate bad input
    expect(allowedStatuses("nonexistent_kind")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cascadeTriggerPayload + isCascadeEvent + CASCADE_TRIGGER_PAYLOAD_KEY
// ---------------------------------------------------------------------------

describe("cascadeTriggerPayload", () => {
  it("returns object with triggered_by_event_id key", () => {
    const payload = cascadeTriggerPayload("event-123");
    expect(payload).toEqual({ [CASCADE_TRIGGER_PAYLOAD_KEY]: "event-123" });
  });

  it("uses the exported constant as the key", () => {
    expect(CASCADE_TRIGGER_PAYLOAD_KEY).toBe("triggered_by_event_id");
  });
});

describe("isCascadeEvent", () => {
  it("returns true when payload contains CASCADE_TRIGGER_PAYLOAD_KEY", () => {
    const payload = cascadeTriggerPayload("evt-abc");
    expect(isCascadeEvent(payload)).toBe(true);
  });

  it("returns false for plain payload without the marker key", () => {
    expect(isCascadeEvent({ some_other_key: "value" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isCascadeEvent(null)).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(isCascadeEvent("string")).toBe(false);
    expect(isCascadeEvent(42)).toBe(false);
  });
});
