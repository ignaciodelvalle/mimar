import { describe, expect, it } from "vitest";
import { pastEventMatchesAudience } from "./libreta-lens";

describe("pastEventMatchesAudience", () => {
  it("owner matches every event type (consolidated timeline, ADR-10)", () => {
    expect(pastEventMatchesAudience("note_added", "owner")).toBe(true);
    expect(pastEventMatchesAudience("vaccination_administered", "owner")).toBe(true);
    expect(pastEventMatchesAudience("status_changed", "owner")).toBe(true);
  });

  it("org matches only the LIBRETA_SANITARIA_EVENT_TYPES whitelist (same predicate as the old oficial lens)", () => {
    expect(pastEventMatchesAudience("vaccination_administered", "org")).toBe(true);
    expect(pastEventMatchesAudience("sterilization_performed", "org")).toBe(true);
    expect(pastEventMatchesAudience("weight_recorded", "org")).toBe(true);
    // Non-libreta types (identity/admin/custody) must NOT pass.
    expect(pastEventMatchesAudience("note_added", "org")).toBe(false);
    expect(pastEventMatchesAudience("status_changed", "org")).toBe(false);
    expect(pastEventMatchesAudience("custody_transferred", "org")).toBe(false);
  });
});
