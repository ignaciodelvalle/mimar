// Unit tests for the custody_episode lifecycle declaration.
//
// Verifies that the lifecycle object satisfies the structural invariants
// expected by the case system:
//   - kind + statusValues are declared correctly.
//   - opensEvents points to shelter_intake_recorded.
//   - terminalEvents covers the three ways a custody ends:
//       custody_transferred (handoff/return), adoption_finalized,
//       death_recorded (direct terminal per decomiso §13.4 — no cascade-emit
//       entry exists in attachment spec §8 for death_recorded + custody_episode,
//       so the server action closes the case directly).
//   - No auto-close cron (expiry cron only notifies, doesn't close — decomiso §13.5).
//   - manualOpenAllowed=true (admin/govt can execute decomiso directly).
//   - reopenAllowed=false (each new custody period is a fresh episode).
//   - No escalated status (decomiso spec §13.2 uses open/closed only).

import { describe, expect, it } from "vitest";

import { getLifecycle } from "@/src/modules/cases/domain/lifecycles";

describe("custody_episode lifecycle — declaration", () => {
  const lifecycle = getLifecycle("custody_episode");

  it("is registered and kind matches", () => {
    expect(lifecycle).not.toBeNull();
    expect(lifecycle?.kind).toBe("custody_episode");
  });

  it("admits open + closed status only (no escalated)", () => {
    expect(lifecycle?.statusValues).toContain("open");
    expect(lifecycle?.statusValues).toContain("closed");
    expect(lifecycle?.statusValues).not.toContain("escalated");
    expect(lifecycle?.statusValues).not.toContain("merged");
  });

  it("opens on shelter_intake_recorded event", () => {
    const triggers = lifecycle?.opensEvents ?? [];
    expect(triggers.some((t) => t.eventType === "shelter_intake_recorded")).toBe(true);
  });

  it("terminates on custody_transferred (handoff or return to owner)", () => {
    expect(lifecycle?.terminalEvents).toContain("custody_transferred");
  });

  it("terminates on adoption_finalized (pet adopted while in custody)", () => {
    expect(lifecycle?.terminalEvents).toContain("adoption_finalized");
  });

  it("terminates on death_recorded (cascade close)", () => {
    expect(lifecycle?.terminalEvents).toContain("death_recorded");
  });

  it("has no auto-close cron (expiry cron is notification-only per decomiso §13.5)", () => {
    expect(lifecycle?.cronCloseRoute).toBeNull();
    expect(lifecycle?.cronCloseScheduleHours).toBe(0);
  });

  it("allows manual open (govt/admin can initiate decomiso)", () => {
    expect(lifecycle?.manualOpenAllowed).toBe(true);
  });

  it("does not allow reopen", () => {
    expect(lifecycle?.reopenAllowed).toBeFalsy();
  });
});
