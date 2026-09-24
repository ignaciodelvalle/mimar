// caseOpenedReasonDisplay — the dispatch between the structured and legacy paths.
//
// The contract, in priority order:
//   1. structured code present and parseable → render from the code
//   2. anything else                          → frozen legacy regex on prose
//   3. never throw
//
// Rule 2 is doing more work than it looks. A structured row whose params fail
// to parse still renders correctly FROM ITS PROSE — that is what the dual-write
// buys. The two columns are mutually redundant by design, so an older deploy, a
// seed, or a hand-fixed row degrades to a correct label instead of an error or
// a raw string.

import { describe, expect, it } from "vitest";
import { caseOpenedReasonDisplay } from "../domain/opened-reason-display";

const PET_UUID = "c1d2e3f4-5555-4666-8777-888899990000";

describe("caseOpenedReasonDisplay — structured path wins when present", () => {
  it("renders from the code, ignoring the prose entirely", () => {
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: "custody_handoff_direct",
        openedReasonParams: { toRole: "owner" },
        openedReason: "auto: direct custody handoff to_role=owner",
      }),
    ).toBe("Traspaso directo de custodia — pasa a: dueño permanente");
  });

  it("renders from the code even if the prose is unrelated", () => {
    // Proves the code is the source of truth post-cutover, not the prose.
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: "adoption_application_submitted",
        openedReasonParams: {},
        openedReason: "something else entirely",
      }),
    ).toBe("Postulación de adopción enviada");
  });

  it("handles a param-less code stored as {}", () => {
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: "foster_proposal_sent",
        openedReasonParams: {},
        openedReason: `Foster proposal to volunteer ${PET_UUID} by org ${PET_UUID}`,
      }),
    ).toBe("Propuesta de tránsito enviada a una persona voluntaria");
  });
});

describe("caseOpenedReasonDisplay — legacy path for pre-cutover rows", () => {
  it("renders prose through the frozen regexes when the code is null", () => {
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: null,
        openedReasonParams: null,
        openedReason: "auto: direct custody handoff to_role=owner",
      }),
    ).toBe("Traspaso directo de custodia — pasa a: dueño permanente");
  });

  it("renders a pre-cutover row identically to a post-cutover one (spec R3)", () => {
    const legacy = caseOpenedReasonDisplay({
      openedReasonCode: null,
      openedReasonParams: null,
      openedReason: "Welfare denuncia DEN-2026-0012 — kind=physical_abuse, severity=high",
    });
    const structured = caseOpenedReasonDisplay({
      openedReasonCode: "welfare_report_citizen",
      openedReasonParams: {
        referenceCode: "DEN-2026-0012",
        kind: "physical_abuse",
        severity: "high",
      },
      openedReason: "Welfare denuncia DEN-2026-0012 — kind=physical_abuse, severity=high",
    });
    expect(structured).toBe(legacy);
  });

  it("passes free text through unchanged", () => {
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: null,
        openedReasonParams: null,
        openedReason: "Denuncia telefónica de un vecino",
      }),
    ).toBe("Denuncia telefónica de un vecino");
  });

  it("renders the empty state for a null reason", () => {
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: null,
        openedReasonParams: null,
        openedReason: null,
      }),
    ).toBe("Sin motivo registrado");
  });
});

describe("caseOpenedReasonDisplay — degrades to prose, never throws", () => {
  // Each of these is a row shape that a future deploy, a seed, or a hand-fix
  // could plausibly produce. All must render the correct label from prose.
  const PROSE = "auto: direct custody handoff to_role=owner";
  const EXPECTED = "Traspaso directo de custodia — pasa a: dueño permanente";

  it("unknown code (row written by a NEWER deploy) → legacy", () => {
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: "code_from_the_future",
        openedReasonParams: { anything: true },
        openedReason: PROSE,
      }),
    ).toBe(EXPECTED);
  });

  it("known code with malformed params → legacy", () => {
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: "custody_handoff_direct",
        openedReasonParams: { toRole: "not_a_role" },
        openedReason: PROSE,
      }),
    ).toBe(EXPECTED);
  });

  it("known code with missing params → legacy", () => {
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: "custody_handoff_direct",
        openedReasonParams: {},
        openedReason: PROSE,
      }),
    ).toBe(EXPECTED);
  });

  it.each([null, undefined, "not an object", 42, []])(
    "non-object params (%s) → legacy, no throw",
    (openedReasonParams) => {
      expect(
        caseOpenedReasonDisplay({
          openedReasonCode: "custody_handoff_direct",
          openedReasonParams,
          openedReason: PROSE,
        }),
      ).toBe(EXPECTED);
    },
  );

  it("unparseable code AND null prose → the empty state, still no throw", () => {
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: "custody_handoff_direct",
        openedReasonParams: null,
        openedReason: null,
      }),
    ).toBe("Sin motivo registrado");
  });

  it("empty-string code is treated as absent", () => {
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: "",
        openedReasonParams: null,
        openedReason: PROSE,
      }),
    ).toBe(EXPECTED);
  });
});
