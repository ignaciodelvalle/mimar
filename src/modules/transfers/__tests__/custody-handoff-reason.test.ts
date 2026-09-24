// The leak that started the structured-open-reason change — pinned.
//
// transfer-custody.ts opens a case on the DIRECT CUSTODY HANDOFF: the change
// of legal responsible, the most consequential write in the system. It had no
// regex rule for months, so opened_reason fell through the generic `auto:`
// catch-all and a funcionario read:
//
//     "Apertura automática — direct custody handoff to_role=owner"
//
// English plus a raw enum key, wrapped in a Spanish prefix so it read like a
// translation and nobody looked twice. Spec R1 scenario 5.

import { caseOpenedReasonDisplay } from "@/src/modules/cases/domain/opened-reason-display";
import { resolveOpenedReasonColumns } from "@/src/modules/cases/infrastructure/cases-repository";
import { describe, expect, it } from "vitest";

// Exactly what transfer-custody.ts:155 now passes, for both reachable roles
// (resolveNewRole returns TransferableRole = shelter_custody | owner).
const HANDOFFS = [
  ["owner", "Traspaso directo de custodia — pasa a: dueño permanente"],
  ["shelter_custody", "Traspaso directo de custodia — pasa a: custodia temporal"],
] as const;

describe("direct custody handoff renders es-AR end to end", () => {
  it.each(HANDOFFS)("to_role=%s reads as es-AR", (toRole, expected) => {
    const row = resolveOpenedReasonColumns({ code: "custody_handoff_direct", toRole });
    expect(caseOpenedReasonDisplay(row)).toBe(expected);
  });

  it.each(HANDOFFS)("to_role=%s leaks no English and no raw enum key", (toRole) => {
    const row = resolveOpenedReasonColumns({ code: "custody_handoff_direct", toRole });
    const label = caseOpenedReasonDisplay(row);

    // The exact tokens that leaked.
    expect(label).not.toContain("to_role=");
    expect(label).not.toContain("direct custody handoff");
    expect(label).not.toContain("Apertura automática");
    expect(label).not.toContain("auto:");
    // And the raw enum value itself never survives.
    expect(label).not.toMatch(new RegExp(`\\b${toRole}\\b`));
  });

  it("still writes the byte-identical audit prose", () => {
    // The prose did not change — only who reads it. A pre-cutover row and a
    // post-cutover row are indistinguishable in opened_reason.
    expect(resolveOpenedReasonColumns({ code: "custody_handoff_direct", toRole: "owner" })).toEqual(
      {
        openedReason: "auto: direct custody handoff to_role=owner",
        openedReasonCode: "custody_handoff_direct",
        openedReasonParams: { toRole: "owner" },
      },
    );
  });
});

describe("cross-org transfer proposal renders es-AR", () => {
  it("reads as es-AR with the reason translated (spec R1 scenario 6)", () => {
    const row = resolveOpenedReasonColumns({
      code: "cross_org_transfer_proposed",
      reason: "space_constraint",
    });
    expect(caseOpenedReasonDisplay(row)).toBe(
      "Transferencia entre organizaciones propuesta — motivo: falta de espacio",
    );
  });

  it("leaks no raw reason key", () => {
    const row = resolveOpenedReasonColumns({
      code: "cross_org_transfer_proposed",
      reason: "post_adoption_failed_return",
    });
    const label = caseOpenedReasonDisplay(row);
    expect(label).not.toContain("reason=");
    expect(label).not.toContain("post_adoption_failed_return");
    expect(label).toBe(
      "Transferencia entre organizaciones propuesta — motivo: devolución posterior a una adopción",
    );
  });
});
