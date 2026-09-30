// capability-state — the "Tus permisos" row states (portal-vet-p0 D12).
//
// Pure: the page reads capabilityStateFor for every row, so asserting it here
// covers what a vet_individual without a verified matrícula sees without a
// full server-page render.

import { describe, expect, it } from "vitest";

import type { OrganizationCapability } from "@/db/schema";
import { VET_CREDENTIAL_CAPS } from "@/src/modules/organizations/domain/capabilities";
import {
  MATRICULA_UPGRADE_HREF,
  NEEDS_MATRICULA_LABEL,
  STATE_PILL_LABEL,
  canRequestFromRow,
  capabilityStateFor,
  historyStates,
} from "./capability-state";

const NO_HISTORY = new Map();

describe("capabilityStateFor — vet_individual without a verified matrícula", () => {
  it.each(VET_CREDENTIAL_CAPS)("%s reads needs_matricula, not 'No concedido'", (capability) => {
    const state = capabilityStateFor(capability, {
      granted: new Set(["appointment.manage"]),
      membershipRole: "vet_individual",
      history: NO_HISTORY,
    });
    expect(state.kind).toBe("needs_matricula");
    expect(STATE_PILL_LABEL[state.kind]).toBe("Requiere matrícula verificada");
  });

  it("offers no request form on a needs_matricula row (nobody can concede it)", () => {
    expect(canRequestFromRow({ kind: "needs_matricula" }, false)).toBe(false);
  });

  it("a legacy approved grant row does not read as 'Concedido' while the matrícula is not valid", () => {
    // resolveGrantedCaps ignores the row, so `granted` lacks event.write; the
    // history still says approved. The credential gate must win over history.
    const state = capabilityStateFor("event.write", {
      granted: new Set(["appointment.manage"]),
      membershipRole: "vet_individual",
      history: historyStates([
        { capability: "event.write", status: "approved", decisionReason: null },
      ]),
    });
    expect(state.kind).toBe("needs_matricula");
  });

  it("the baseline (Turnos) is granted", () => {
    const state = capabilityStateFor("appointment.manage", {
      granted: new Set(["appointment.manage"]),
      membershipRole: "vet_individual",
      history: NO_HISTORY,
    });
    expect(state.kind).toBe("granted");
  });

  it("links to the one place that resolves it", () => {
    expect(MATRICULA_UPGRADE_HREF).toBe("/cuenta/upgrade");
    expect(NEEDS_MATRICULA_LABEL).toBe("Requiere matrícula verificada");
  });
});

describe("capabilityStateFor — unchanged for everyone else", () => {
  it("a verified vet's clinical capability is granted", () => {
    const state = capabilityStateFor("event.write", {
      granted: new Set(["event.write"]),
      membershipRole: "vet_individual",
      history: NO_HISTORY,
    });
    expect(state.kind).toBe("granted");
  });

  it("a member without event.write reads 'No concedido' and may request it", () => {
    const state = capabilityStateFor("event.write", {
      granted: new Set<string>(),
      membershipRole: "member",
      history: NO_HISTORY,
    });
    expect(state.kind).toBe("none");
    expect(canRequestFromRow(state, false)).toBe(true);
  });

  it("history wins for a non-gated capability: pending, denied with reason, revoked without", () => {
    const history = historyStates([
      { capability: "foster.assign", status: "pending", decisionReason: null },
      { capability: "adoption.review", status: "denied", decisionReason: "Falta capacitación" },
      { capability: "custody.transfer", status: "revoked", decisionReason: "motivo del alta" },
    ]);
    const input = { granted: new Set<string>(), membershipRole: "member", history };
    expect(capabilityStateFor("foster.assign", input)).toEqual({ kind: "pending" });
    expect(capabilityStateFor("adoption.review", input)).toEqual({
      kind: "denied",
      reason: "Falta capacitación",
    });
    expect(capabilityStateFor("custody.transfer" as OrganizationCapability, input)).toEqual({
      kind: "revoked",
      reason: null,
    });
  });

  it("an admin never gets a request form", () => {
    expect(canRequestFromRow({ kind: "none" }, true)).toBe(false);
  });
});
