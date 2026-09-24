// rehome_request — the titular's consent record and the org's inbox item
// (rehome-by-titular, WU3: spec REQ-2, design "Lifecycle declaration" + ADR-2).
//
// Layer: Unit (pure catalog lookups, no DB, no Next.js).
//
// The kind is registered in SIX places that do not compile- or fence-check each
// other as a set: CASE_KINDS / V1_CASE_KINDS, the lifecycle registry, the
// es-AR label, the severity weight, the normatives table, and the attachment
// rules for the two rehome events. This file pins the intended value of each so
// the kind cannot land half-registered with every individual fence green.

import { describe, expect, it } from "vitest";

import { CASE_NORMATIVES, getNormativesForCase } from "@/lib/domain/case-normatives";
import { CASE_ATTACHMENT_RULES, decideAttachment } from "@/lib/infra/case-attachment";
import {
  CASE_KINDS,
  V1_CASE_KINDS,
  caseKindLabel,
  caseKindSeverityWeight,
} from "@/src/modules/cases/domain/case-kinds";
import { getLifecycle } from "@/src/modules/cases/domain/lifecycles";
import { OpenedReasonSchema } from "@/src/modules/cases/domain/opened-reason";
import { openedReasonProse } from "@/src/modules/cases/domain/opened-reason-prose";
import { renderOpenedReason } from "@/src/modules/cases/domain/opened-reason-render";

const KIND = "rehome_request";

describe("rehome_request — catalog membership", () => {
  it("is a CASE_KINDS member and a V1 kind", () => {
    expect(CASE_KINDS).toContain(KIND);
    expect(V1_CASE_KINDS).toContain(KIND);
  });

  it("labels as 'Solicitud de nuevo hogar' in es-AR", () => {
    expect(caseKindLabel(KIND)).toBe("Solicitud de nuevo hogar");
  });

  it("weighs 1 — a process case, not a welfare emergency", () => {
    expect(caseKindSeverityWeight(KIND)).toBe(1);
  });
});

describe("rehome_request — lifecycle declaration", () => {
  const lifecycle = getLifecycle(KIND);

  it("is registered", () => {
    expect(lifecycle?.kind).toBe(KIND);
  });

  it("opens with the request action and closes with the answer — no pet_events on either side", () => {
    // The welfare_denuncia shape: opened atomically by the action, never by an
    // event insert, and nothing on the spine terminates it.
    expect(lifecycle?.opensEvents).toEqual([]);
    expect(lifecycle?.terminalEvents).toEqual([]);
    expect(lifecycle?.manualOpenAllowed).toBe(true);
  });

  it("has only open/closed, no cron, no reopen", () => {
    expect(lifecycle?.statusValues).toEqual(["open", "closed"]);
    expect(lifecycle?.cronCloseRoute).toBeNull();
    expect(lifecycle?.reopenAllowed).toBe(false);
    expect(lifecycle?.manualCloseAllowed).toBe(false);
  });
});

describe("rehome_request — normatives", () => {
  it("has an AR country-level entry with no specific law (a private arrangement)", () => {
    const entries = CASE_NORMATIVES.filter((e) => e.kind === KIND);
    expect(entries.map((e) => e.jurisdiction)).toEqual([{ country: "AR" }]);
    expect(getNormativesForCase(KIND, { country: "AR" })).toEqual([]);
  });
});

describe("rehome_request — attachment rules for the rehome events", () => {
  it("rehome_sponsorship_started REQUIRES the consent case to be open", () => {
    const rule = CASE_ATTACHMENT_RULES.rehome_sponsorship_started;
    expect(rule.mode).toBe("requires-open");
    expect(rule.compatibleWith).toEqual([KIND]);
  });

  it("rehome_sponsorship_started rejects when no rehome_request is open", () => {
    const decision = decideAttachment("rehome_sponsorship_started", {}, []);
    expect(decision.rejectReason).toContain(KIND);
    expect(decision.attachToCaseId).toBeUndefined();
  });

  it("rehome_sponsorship_started attaches to the open rehome_request, never to the listing", () => {
    const decision = decideAttachment("rehome_sponsorship_started", {}, [
      { id: "case-listing", caseKind: "adoption_listing" },
      { id: "case-request", caseKind: KIND },
    ]);
    expect(decision.attachToCaseId).toBe("case-request");
  });

  it("rehome_sponsorship_ended still attaches to the adoption_listing (unchanged from WU1)", () => {
    const decision = decideAttachment("rehome_sponsorship_ended", {}, [
      { id: "case-listing", caseKind: "adoption_listing" },
    ]);
    expect(decision.attachToCaseId).toBe("case-listing");
  });

  it("death_recorded reaches an open rehome_request so the death cascade can close it", () => {
    expect(CASE_ATTACHMENT_RULES.death_recorded.compatibleWith).toContain(KIND);
    const decision = decideAttachment("death_recorded", {}, [
      { id: "case-request", caseKind: KIND },
    ]);
    expect(decision.attachToCaseId).toBe("case-request");
  });
});

describe("rehome_requested — the structured open reason", () => {
  const reason = { code: "rehome_requested", orgDisplayName: "Refugio Padrino" } as const;

  it("parses with the org's display name and nothing else", () => {
    expect(OpenedReasonSchema.parse(reason)).toEqual(reason);
    expect(OpenedReasonSchema.safeParse({ ...reason, petId: "x" }).success).toBe(false);
    expect(OpenedReasonSchema.safeParse({ code: "rehome_requested" }).success).toBe(false);
  });

  it("renders es-AR naming the org the titular asked", () => {
    expect(renderOpenedReason(reason)).toBe(
      "Solicitud de nuevo hogar enviada por el titular a Refugio Padrino",
    );
  });

  it("writes audit prose identical to the label — a new writer has no legacy prose to preserve", () => {
    // The legacy regex layer is frozen (17 rules, never grows), so a rollback
    // renders this row's prose through the passthrough. Making prose == label
    // is what keeps that rollback reading correctly.
    expect(openedReasonProse(reason)).toBe(renderOpenedReason(reason));
    expect(openedReasonProse(reason).length).toBeGreaterThanOrEqual(10);
  });
});
