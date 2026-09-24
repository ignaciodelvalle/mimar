// `shares-view-model` — the mapping between an exposure and what a person reads.
//
// The render test beside this one proves the screen wires up; these prove the
// DECISIONS the mapping makes. Three of them are privacy decisions — whether a
// link is described as live, whether a revoke control is offered to somebody who
// cannot use it, and whether the permanent Tier-2 window is presented as a peer
// of the bounded ones — which is the kind that must not depend on somebody
// remembering to tap through six screens.

import { describe, expect, it } from "@jest/globals";

import type { LibretaShareV1, PetSharesV1, Tier2StateV1 } from "@dim/contract/api";
import { MAX_ACTIVE_LIBRETA_SHARES } from "@dim/contract/input";

import {
  SHARE_DURATION_CHOICES,
  TIER2_WINDOW_CHOICES,
  buildCreateShare,
  buildEnableTier2,
  buildRevokeShare,
  buildRevokeTier2,
  createBlockedReason,
  libretaShareUrl,
  shareExpiryLabel,
  shareInputCodeMessage,
  shareRevokeBlockedReason,
  shareTitle,
  shareViewsLabel,
  tier2BlockedReason,
  tier2StateLabel,
} from "./shares-view-model";

const A_SHARE: LibretaShareV1 = {
  id: "11111111-1111-4111-8111-111111111111",
  shareToken: "LBR-ABCD-EFGH",
  label: "Veterinaria Norte",
  createdAt: "2026-08-01T12:00:00.000Z",
  expiresAt: "2026-09-01T12:00:00.000Z",
  expired: false,
  canRevoke: true,
  viewCount: 0,
  lastViewedAt: null,
};

const TIER2_OFF: Tier2StateV1 = { isActive: false, isPermanent: false, activeUntil: null };

function payload(over: Partial<PetSharesV1> = {}): PetSharesV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T12:00:00.000Z",
    staleAfter: "2026-08-26T12:01:00.000Z",
    publicToken: "DIM-PAMP-0001",
    petName: "Pampa",
    libretaShares: [],
    tier2: TIER2_OFF,
    capabilities: {
      canCreateLibretaShare: true,
      remainingShareSlots: MAX_ACTIVE_LIBRETA_SHARES,
      canEnableTier2: true,
      canRevokeTier2: true,
    },
    ...over,
  };
}

describe("libretaShareUrl", () => {
  it("builds the PUBLIC web url from the shared deep-link table, not a template", () => {
    expect(libretaShareUrl("https://example.test", "LBR-ABCD-EFGH")).toBe(
      "https://example.test/libreta/compartir/LBR-ABCD-EFGH",
    );
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(libretaShareUrl("https://example.test/", "LBR-ABCD-EFGH")).toBe(
      "https://example.test/libreta/compartir/LBR-ABCD-EFGH",
    );
  });
});

describe("shareExpiryLabel", () => {
  it("trusts the SERVER's `expired`, never a recomputation from the device clock", () => {
    // The dangerous direction: a past date the server says is still live. A view
    // model that compared `expiresAt` against `Date.now()` would call this dead
    // and send an owner off to mint a replacement, leaving the real link running.
    const stale = { ...A_SHARE, expiresAt: "2000-01-01T00:00:00.000Z", expired: false };
    expect(shareExpiryLabel(stale)).toMatch(/^Vence el/);

    const dead = { ...A_SHARE, expiresAt: "2099-01-01T00:00:00.000Z", expired: true };
    expect(shareExpiryLabel(dead)).toMatch(/^Venció el/);
  });

  it("says so plainly when a link never expires", () => {
    expect(shareExpiryLabel({ ...A_SHARE, expiresAt: null })).toBe("Sin vencimiento");
  });
});

describe("shareViewsLabel", () => {
  it("singularises one view and pluralises the rest", () => {
    expect(shareViewsLabel({ ...A_SHARE, viewCount: 0 })).toBe("Sin vistas");
    expect(shareViewsLabel({ ...A_SHARE, viewCount: 1 })).toBe("1 vista");
    expect(shareViewsLabel({ ...A_SHARE, viewCount: 4 })).toBe("4 vistas");
  });

  it("appends the last view only when there is one", () => {
    expect(
      shareViewsLabel({ ...A_SHARE, viewCount: 2, lastViewedAt: "2026-08-20T12:00:00.000Z" }),
    ).toContain("última el");
    expect(shareViewsLabel({ ...A_SHARE, viewCount: 2, lastViewedAt: null })).toBe("2 vistas");
  });
});

describe("shareTitle", () => {
  it("falls back to an honest stand-in rather than an empty row", () => {
    expect(shareTitle(A_SHARE)).toBe("Veterinaria Norte");
    expect(shareTitle({ ...A_SHARE, label: null })).toBe("Link sin nombre");
  });
});

describe("shareRevokeBlockedReason", () => {
  it("offers revoke when the SERVER says this caller may", () => {
    expect(shareRevokeBlockedReason(A_SHARE)).toBeNull();
  });

  it("names the RULE, not the refusal, when it may not", () => {
    // Revocation is creator-or-admin while the list is every current holder, so
    // a co-owner sees links they cannot revoke. "Sin permisos" over a link the
    // person is plainly looking at reads like a bug; the rule reads like a rule.
    const reason = shareRevokeBlockedReason({ ...A_SHARE, canRevoke: false });
    expect(reason).toBe("Solo quien creó este link puede revocarlo.");
  });
});

describe("tier2StateLabel", () => {
  it("distinguishes closed, bounded and permanent", () => {
    expect(tier2StateLabel(TIER2_OFF)).toContain("no se muestra");
    expect(tier2StateLabel({ isActive: true, isPermanent: true, activeUntil: null })).toContain(
      "siempre",
    );
    expect(
      tier2StateLabel({
        isActive: true,
        isPermanent: false,
        activeUntil: "2026-09-01T12:00:00.000Z",
      }),
    ).toContain("hasta el");
  });
});

describe("createBlockedReason", () => {
  it("is null when the server says the control is live", () => {
    expect(createBlockedReason(payload())).toBeNull();
  });

  it("tells the CAP apart from the PERMISSION — two refusals, two fixes", () => {
    const capped = payload({
      capabilities: {
        canCreateLibretaShare: false,
        remainingShareSlots: 0,
        canEnableTier2: true,
        canRevokeTier2: true,
      },
    });
    expect(createBlockedReason(capped)).toContain("Revocá uno");

    const notTitular = payload({
      capabilities: {
        canCreateLibretaShare: false,
        remainingShareSlots: MAX_ACTIVE_LIBRETA_SHARES,
        canEnableTier2: true,
        canRevokeTier2: true,
      },
    });
    expect(createBlockedReason(notTitular)).toContain("titular");
  });
});

describe("tier2BlockedReason", () => {
  it("names the titular rule when the window may not be opened", () => {
    const blocked = payload({
      capabilities: {
        canCreateLibretaShare: true,
        remainingShareSlots: 5,
        canEnableTier2: false,
        canRevokeTier2: true,
      },
    });
    expect(tier2BlockedReason(blocked)).toContain("titular");
    expect(tier2BlockedReason(payload())).toBeNull();
  });
});

describe("the choice lists", () => {
  it("offers every duration the contract accepts, plus the deliberate null", () => {
    expect(SHARE_DURATION_CHOICES.map((c) => c.days)).toEqual([7, 30, 90, null]);
  });

  it("keeps `siempre` LAST and MARKED — it is not a peer of the bounded windows", () => {
    const last = TIER2_WINDOW_CHOICES[TIER2_WINDOW_CHOICES.length - 1];
    expect(last?.window).toBe("siempre");
    expect(last?.advanced).toBe(true);
    // And nothing else is marked advanced — a flat list of four equals would
    // have undone the web's own expander decision silently.
    expect(TIER2_WINDOW_CHOICES.filter((c) => c.advanced)).toHaveLength(1);
  });
});

describe("the command builders", () => {
  it("builds a create command for every offered duration", () => {
    for (const choice of SHARE_DURATION_CHOICES) {
      const result = buildCreateShare({ days: choice.days, label: "Vet" });
      expect(result.ok).toBe(true);
    }
  });

  it("refuses a duration the contract does not offer, with copy and a code", () => {
    const result = buildCreateShare({ days: 365, label: "" });
    expect(result).toMatchObject({ ok: false, code: "EXPIRY_INVALID" });
  });

  it("refuses an over-long label rather than letting the server store it", () => {
    const result = buildCreateShare({ days: 7, label: "x".repeat(200) });
    expect(result).toMatchObject({ ok: false, code: "LABEL_TOO_LONG" });
  });

  it("turns a blank label into null, so 'not stated' has one representation", () => {
    const result = buildCreateShare({ days: 7, label: "   " });
    expect(result.ok).toBe(true);
    if (result.ok && result.input.command === "create_libreta_share") {
      expect(result.input.label).toBeNull();
    }
  });

  it("revokes by ROW id and refuses anything that is not one", () => {
    expect(buildRevokeShare(A_SHARE.id).ok).toBe(true);
    // A share TOKEN is not a uuid, which is the shape check that keeps a bearer
    // secret out of this request body by construction rather than by discipline.
    expect(buildRevokeShare("LBR-ABCD-EFGH")).toMatchObject({
      ok: false,
      code: "SHARE_ID_REQUIRED",
    });
  });

  it("builds every Tier-2 window the picker offers, and refuses an invented one", () => {
    for (const choice of TIER2_WINDOW_CHOICES) {
      expect(buildEnableTier2(choice.window).ok).toBe(true);
    }
    // The web would silently give this 24 hours; the contract refuses it.
    expect(buildEnableTier2("7days" as never)).toMatchObject({
      ok: false,
      code: "WINDOW_INVALID",
    });
    expect(buildRevokeTier2().ok).toBe(true);
  });
});

describe("shareInputCodeMessage", () => {
  it("is honest when the contract does not name the failure", () => {
    expect(shareInputCodeMessage(null)).toContain("no pudo interpretar");
  });

  it("has a non-empty sentence for every code", () => {
    const codes = [
      "COMMAND_REQUIRED",
      "EXPIRY_INVALID",
      "LABEL_TOO_LONG",
      "SHARE_ID_REQUIRED",
      "WINDOW_INVALID",
    ] as const;
    for (const code of codes) {
      expect(shareInputCodeMessage(code).length).toBeGreaterThan(0);
    }
  });
});

describe("token hygiene", () => {
  it("no view-model helper returns a bare share token", () => {
    // The token reaches exactly one place: inside the url a person shares. Every
    // other helper describes the row without quoting the credential, so a screen
    // rendering a list cannot put one on screen — or into a log — by accident.
    const described = [
      shareTitle(A_SHARE),
      shareExpiryLabel(A_SHARE),
      shareViewsLabel(A_SHARE),
      shareRevokeBlockedReason({ ...A_SHARE, canRevoke: false }) ?? "",
    ];
    for (const line of described) {
      expect(line).not.toContain(A_SHARE.shareToken);
    }
    expect(libretaShareUrl("https://example.test", A_SHARE.shareToken)).toContain(
      A_SHARE.shareToken,
    );
  });
});
