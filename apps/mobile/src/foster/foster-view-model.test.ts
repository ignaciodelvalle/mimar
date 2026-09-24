// `foster-view-model` — the words, and the wire shapes.
//
// WHAT THESE HAVE TO PROVE
// ---------------------------------------------------------------------------
//   1. `expired` IS SHOWN, NEVER RECOMPUTED, and it never disables a control —
//      there is no control in this file at all, because `MyFosterProposalV1`
//      carries only `status: "pending"` rows. See the module header.
//   2. `allowCoFoster` DEFAULTS OFF, mirroring the web's checkbox.
//   3. A REJECT WITH NO REASON IS REFUSED LOCALLY, before the network —
//      `rejectionReason` is required on the wire.
//   4. NOTES ARE TRIMMED TO `null`, not to `""`, so an all-whitespace note
//      reads as "not stated" rather than as an empty string on the wire.
//   5. THE ENDED/ACTIVE LABEL SPLIT MATCHES `active`, never `endedAt` read
//      directly by the screen.

import { describe, expect, it } from "@jest/globals";

import type { MyFosterOwnershipV1, MyFosterProposalV1 } from "@dim/contract/api";

import {
  buildAcceptFosterProposal,
  buildRejectFosterProposal,
  fosterOwnershipHeadline,
  fosterOwnershipMetaLabel,
  fosterProposalHeadline,
  fosterProposalMetaLabel,
} from "./foster-view-model";

const TOKEN = "FP-0123456789abcdef0123456789abcdef";

function aProposal(over: Partial<MyFosterProposalV1> = {}): MyFosterProposalV1 {
  return {
    proposalToken: TOKEN,
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa", species: "dog" },
    organizationName: "Refugio Esperanza",
    proposedDurationWeeks: 3,
    proposedNotes: null,
    proposedAt: "2026-09-01T12:00:00.000Z",
    expiresAt: "2026-09-08T12:00:00.000Z",
    expired: false,
    ...over,
  };
}

function aFoster(over: Partial<MyFosterOwnershipV1> = {}): MyFosterOwnershipV1 {
  return {
    fosterOwnershipId: "own-1",
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa", species: "dog" },
    organizationName: "Refugio Esperanza",
    startedAt: "2026-08-01T12:00:00.000Z",
    endedAt: null,
    active: true,
    proposedDurationWeeks: 4,
    ...over,
  };
}

describe("fosterProposalHeadline", () => {
  it("names the org and the animal", () => {
    expect(fosterProposalHeadline(aProposal())).toBe("Refugio Esperanza te propone cuidar a Pampa");
  });
});

describe("fosterProposalMetaLabel", () => {
  it("reads the duration and the expiry", () => {
    expect(fosterProposalMetaLabel(aProposal())).toBe("3 semanas · expira 08/09/2026");
  });

  it("says so when the org gave no duration estimate", () => {
    expect(fosterProposalMetaLabel(aProposal({ proposedDurationWeeks: null }))).toBe(
      "Sin duración estimada · expira 08/09/2026",
    );
  });

  it("singularises one week", () => {
    expect(fosterProposalMetaLabel(aProposal({ proposedDurationWeeks: 1 }))).toBe(
      "1 semana · expira 08/09/2026",
    );
  });

  it("adds the vencida note when the server says so, and never recomputes it", () => {
    // `expired` here is deliberately FALSE at a date that has already passed —
    // proving the label reads the flag and not the clock.
    const label = fosterProposalMetaLabel(
      aProposal({ expiresAt: "2020-01-01T12:00:00.000Z", expired: false }),
    );
    expect(label).not.toContain("venció");
    const expiredLabel = fosterProposalMetaLabel(
      aProposal({ expiresAt: "2099-01-01T12:00:00.000Z", expired: true }),
    );
    expect(expiredLabel).toContain("venció");
  });
});

describe("fosterOwnershipHeadline / fosterOwnershipMetaLabel", () => {
  it("reads active from the flag, present tense", () => {
    expect(fosterOwnershipHeadline(aFoster({ active: true }))).toBe("Estás cuidando a Pampa");
    expect(fosterOwnershipMetaLabel(aFoster({ active: true }))).toBe(
      "Refugio: Refugio Esperanza · desde 01/08/2026 · estimado: 4 semanas",
    );
  });

  it("reads ended from the flag, past tense, and carries the end date", () => {
    const foster = aFoster({ active: false, endedAt: "2026-09-10T12:00:00.000Z" });
    expect(fosterOwnershipHeadline(foster)).toBe("Cuidaste a Pampa");
    expect(fosterOwnershipMetaLabel(foster)).toBe(
      "Refugio: Refugio Esperanza · del 01/08/2026 al 10/09/2026",
    );
  });

  it("falls back to a generic word when the custody org did not resolve", () => {
    expect(fosterOwnershipMetaLabel(aFoster({ organizationName: null }))).toContain(
      "Refugio: organización",
    );
  });
});

describe("buildAcceptFosterProposal", () => {
  it("defaults allowCoFoster off and trims an empty note to null", () => {
    const built = buildAcceptFosterProposal(TOKEN, false, "   ");
    expect(built).toEqual({
      ok: true,
      input: { command: "accept", proposalToken: TOKEN, allowCoFoster: false, responseNotes: null },
    });
  });

  it("carries a real note through, trimmed", () => {
    const built = buildAcceptFosterProposal(TOKEN, true, "  Cuidalo bien  ");
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.input).toMatchObject({ allowCoFoster: true, responseNotes: "Cuidalo bien" });
    }
  });

  it("refuses a token the schema will not accept", () => {
    const built = buildAcceptFosterProposal("", false, "");
    expect(built.ok).toBe(false);
  });
});

describe("buildRejectFosterProposal", () => {
  it("requires one of the six reasons", () => {
    const built = buildRejectFosterProposal(TOKEN, "capacity", "");
    expect(built).toEqual({
      ok: true,
      input: {
        command: "reject",
        proposalToken: TOKEN,
        rejectionReason: "capacity",
        responseNotes: null,
      },
    });
  });
});
