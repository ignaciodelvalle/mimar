// Unit tests for the outbreak_investigation lifecycle declaration.
//
// Verifies that the lifecycle object satisfies the structural invariants
// expected by the case system:
//   - kind + statusValues are declared correctly.
//   - opensEvents points to outbreak_signal.
//   - No terminal events (investigations are closed manually by govt/admin).
//   - No auto-close cron (ENO pipeline marks brote linkage as v2 out-of-scope).
//   - manualOpenAllowed=true (govt can open without an outbreak_signal e.g.
//     on receipt of an external lab report).
//   - reopenAllowed=false (new signal opens a fresh investigation).
//   - escalated status is supported (severity can rise while open).

import { describe, expect, it } from "vitest";

import { getNormativesForCase } from "@/lib/domain/case-normatives";
import { getLifecycle } from "@/src/modules/cases/domain/lifecycles";

describe("outbreak_investigation lifecycle — declaration", () => {
  const lifecycle = getLifecycle("outbreak_investigation");

  it("is registered and kind matches", () => {
    expect(lifecycle).not.toBeNull();
    expect(lifecycle?.kind).toBe("outbreak_investigation");
  });

  it("admits open + escalated + closed statuses", () => {
    expect(lifecycle?.statusValues).toContain("open");
    expect(lifecycle?.statusValues).toContain("escalated");
    expect(lifecycle?.statusValues).toContain("closed");
    expect(lifecycle?.statusValues).not.toContain("merged");
  });

  it("opens on outbreak_signal event", () => {
    const triggers = lifecycle?.opensEvents ?? [];
    expect(triggers.some((t) => t.eventType === "outbreak_signal")).toBe(true);
  });

  it("has no terminal events (closed manually by govt/admin via case action)", () => {
    expect(lifecycle?.terminalEvents).toHaveLength(0);
  });

  it("has no auto-close cron (brote linkage is v2 per ENO pipeline spec)", () => {
    expect(lifecycle?.cronCloseRoute).toBeNull();
    expect(lifecycle?.cronCloseScheduleHours).toBe(0);
  });

  it("allows manual open (govt can open from external lab report without signal)", () => {
    expect(lifecycle?.manualOpenAllowed).toBe(true);
  });

  it("does not allow reopen", () => {
    expect(lifecycle?.reopenAllowed).toBeFalsy();
  });
});

describe("outbreak_investigation normatives", () => {
  it("surfaces Ley 15.465/60 nationwide (notificación obligatoria)", () => {
    const laws = getNormativesForCase("outbreak_investigation", { country: "AR" });
    expect(laws.some((l) => l.id === "ley_15465_60_decreto_3640_64")).toBe(true);
  });

  it("surfaces Ley 5325/1948 PBA for Buenos Aires jurisdiction", () => {
    const laws = getNormativesForCase("outbreak_investigation", {
      country: "AR",
      province: "Buenos Aires",
    });
    expect(laws.some((l) => l.id === "ley_5325_1948_pba")).toBe(true);
  });

  it("country-level law is present for any province without specific entry", () => {
    const laws = getNormativesForCase("outbreak_investigation", {
      country: "AR",
      province: "Mendoza",
    });
    expect(laws.length).toBeGreaterThan(0);
    expect(laws.some((l) => l.id === "ley_15465_60_decreto_3640_64")).toBe(true);
  });
});
