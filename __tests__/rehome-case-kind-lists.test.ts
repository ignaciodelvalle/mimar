// rehome_request and the four kind registries (rehome-by-titular WU5, tasks
// 5.5 and 5.6; design ADR-4 "three explicit non-additions, each with a test").
//
// One assertion per list, on purpose. Each registry means a different thing
// and each would fail a different person:
//   - PUBLIC_ANONYMOUS_KINDS: "this family is giving up this animal", next to
//     a pet living at a private address, readable with no session.
//   - HIDDEN_FROM_SUBJECT_CASE_KINDS: the subject owner IS the requester.
//   - GENERIC_CASE_LIST_EXCLUDED_KINDS: the titular must see their own request
//     on the pet page.
//   - ORG_CASE_KINDS_ROUTED_ELSEWHERE: the org queue's own routing registry
//     (PO inbox-scoping, refinement 2) — separate from the /gob one, whose
//     destinations are static hrefs and whose queue would otherwise lose the
//     handshakes it has no other screen for.

import { describe, expect, it } from "vitest";

import { HIDDEN_FROM_SUBJECT_CASE_KINDS, isPubliclyVisibleKind } from "@/lib/infra/case-access";
import { GENERIC_CASE_LIST_EXCLUDED_KINDS } from "@/lib/infra/case-queries";
import {
  CASE_KINDS_ROUTED_ELSEWHERE,
  ORG_CASE_KINDS_ROUTED_ELSEWHERE,
  orgRoutedElsewhereDestination,
} from "@/src/modules/cases/domain/case-kinds";

describe("rehome_request — the three non-additions (5.5)", () => {
  it("is NOT publicly visible to an anonymous viewer", () => {
    expect(isPubliclyVisibleKind("rehome_request")).toBe(false);
    // Non-vacuity: the predicate says yes to something.
    expect(isPubliclyVisibleKind("adoption_listing")).toBe(true);
  });

  it("is NOT hidden from the subject pet's owner", () => {
    expect(HIDDEN_FROM_SUBJECT_CASE_KINDS.has("rehome_request")).toBe(false);
    expect(HIDDEN_FROM_SUBJECT_CASE_KINDS.has("welfare_denuncia")).toBe(true);
  });

  it("is NOT excluded from the generic owner-facing case lists", () => {
    expect(GENERIC_CASE_LIST_EXCLUDED_KINDS).not.toContain("rehome_request");
    expect(GENERIC_CASE_LIST_EXCLUDED_KINDS).toContain("lost_pet_episode");
  });
});

describe("the org queue's routing registry (5.6)", () => {
  it("declares custody_transfer_handshake routed to the org's received-transfers inbox", () => {
    expect(ORG_CASE_KINDS_ROUTED_ELSEWHERE).toEqual(["custody_transfer_handshake"]);
    const dest = orgRoutedElsewhereDestination("DIM-ORG-0001", "custody_transfer_handshake");
    expect(dest?.href).toBe("/org/DIM-ORG-0001/transferencias/recibidas");
    expect(dest?.label).toMatch(/transferencia/i);
  });

  it("a kind that is not routed has no destination", () => {
    expect(orgRoutedElsewhereDestination("DIM-ORG-0001", "rehome_request")).toBeNull();
  });

  it("the /gob registry is untouched — govt keeps seeing handshakes in its queue", () => {
    // The org-scoped registry exists so this one does not have to change: a
    // handshake routed out of /gob/casos would have nowhere to go there.
    expect(CASE_KINDS_ROUTED_ELSEWHERE).not.toContain("custody_transfer_handshake");
    expect(CASE_KINDS_ROUTED_ELSEWHERE).toContain("custody_dispute");
  });
});
