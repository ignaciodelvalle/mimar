// `isLegalAcceptancePending` — who is sent to the re-acceptance screen
// (2026-10-07; legal review 2026-10-02 rows P10/P11; PO decision D2 = b).

import { describe, expect, it } from "vitest";

import {
  KNOWN_LEGAL_VERSIONS,
  LEGAL_VERSION_CHANGES,
  legalChangesSince,
} from "@/lib/reference/legal-version";

import { toMeV1User } from "./identity-completeness";
import {
  LEGAL_ACCEPTANCE_PATH,
  isLegalAcceptancePending,
  legalAcceptanceHref,
} from "./legal-acceptance";

const ACCEPTED_AT = new Date("2026-09-25T12:00:00.000Z");

describe("isLegalAcceptancePending", () => {
  it("is TRUE for a personal account that accepted an older version", () => {
    for (const tosVersion of ["2026-07-23", "2026-09-24"]) {
      expect(
        isLegalAcceptancePending({
          accountType: "personal",
          tosAcceptedAt: ACCEPTED_AT,
          tosVersion,
        }),
      ).toBe(true);
    }
  });

  it("is TRUE for a version this build does not know (never read as a newer acceptance)", () => {
    expect(
      isLegalAcceptancePending({
        accountType: "personal",
        tosAcceptedAt: ACCEPTED_AT,
        tosVersion: "2099-01-01",
      }),
    ).toBe(true);
  });

  it("is FALSE on the current version (written out: 2026-10-07)", () => {
    expect(
      isLegalAcceptancePending({
        accountType: "personal",
        tosAcceptedAt: ACCEPTED_AT,
        tosVersion: "2026-10-07",
      }),
    ).toBe(false);
  });

  it("is FALSE for an institutional account, whatever it holds", () => {
    expect(
      isLegalAcceptancePending({
        accountType: "institutional",
        tosAcceptedAt: ACCEPTED_AT,
        tosVersion: "2026-07-23",
      }),
    ).toBe(false);
  });

  it("is TRUE with no recorded acceptance: an account older than 0087 never accepted anything", () => {
    // PO 2026-10-07. Seed personas are stamped by the seeds; a signup still on
    // step 2 is excluded by the callers' identity check, not here.
    expect(
      isLegalAcceptancePending({ accountType: "personal", tosAcceptedAt: null, tosVersion: null }),
    ).toBe(true);
  });

  it("is FALSE when the columns were not loaded at all — never a false gate", () => {
    expect(isLegalAcceptancePending({ accountType: "personal" })).toBe(false);
  });
});

describe("legalChangesSince — the general re-acceptance circuit", () => {
  it("lists every change since the accepted version, oldest first", () => {
    const fromJuly = legalChangesSince("2026-07-23");
    expect(fromJuly[0]).toBe(
      "La política de privacidad nombra a cada proveedor que procesa tus datos y en qué país está.",
    );
    expect(fromJuly).toContain("Te pedimos que confirmes que tenés 18 años o más.");
    expect(legalChangesSince("2026-09-24")).toEqual([...LEGAL_VERSION_CHANGES["2026-10-07"]]);
  });

  it("falls back to the current version's changes, never an empty list", () => {
    expect(legalChangesSince(null)).toEqual([...LEGAL_VERSION_CHANGES["2026-10-07"]]);
    expect(legalChangesSince("2099-01-01").length).toBeGreaterThan(0);
    expect(legalChangesSince("2026-10-07").length).toBeGreaterThan(0);
  });

  it("has an entry for every known version", () => {
    for (const v of KNOWN_LEGAL_VERSIONS)
      expect(LEGAL_VERSION_CHANGES[v].length).toBeGreaterThan(0);
  });
});

describe("legalAcceptanceHref", () => {
  it("carries the destination", () => {
    expect(legalAcceptanceHref("/mis-mascotas/DIM-AAAA-BBBB")).toBe(
      "/aceptar-condiciones?returnTo=%2Fmis-mascotas%2FDIM-AAAA-BBBB",
    );
  });

  it("carries nothing for no destination or for itself", () => {
    expect(legalAcceptanceHref(null)).toBe(LEGAL_ACCEPTANCE_PATH);
    expect(legalAcceptanceHref(LEGAL_ACCEPTANCE_PATH)).toBe(LEGAL_ACCEPTANCE_PATH);
  });
});

describe("toMeV1User carries the flag only when owed", () => {
  const PROFILE = {
    displayName: "Ana Pérez",
    role: "owner",
    accountType: "personal",
  } as const;

  it("adds legalAcceptancePending: true for an older recorded version", () => {
    expect(
      toMeV1User({
        id: "u1",
        email: "ana@example.com",
        profile: { ...PROFILE, tosAcceptedAt: ACCEPTED_AT, tosVersion: "2026-09-24" },
      }),
    ).toEqual({
      profilePending: false,
      id: "u1",
      displayName: "Ana Pérez",
      role: "owner",
      accountType: "personal",
      legalAcceptancePending: true,
    });
  });

  it("leaves the payload byte-for-byte as before when nothing is owed", () => {
    const projected = toMeV1User({
      id: "u1",
      email: "ana@example.com",
      profile: { ...PROFILE, tosAcceptedAt: ACCEPTED_AT, tosVersion: "2026-10-07" },
    });
    expect(Object.keys(projected).sort()).toEqual([
      "accountType",
      "displayName",
      "id",
      "profilePending",
      "role",
    ]);
  });

  it("never puts the flag on a pending identity", () => {
    expect(
      toMeV1User({
        id: "u1",
        email: "ana@example.com",
        profile: { ...PROFILE, displayName: "ana", tosAcceptedAt: ACCEPTED_AT, tosVersion: "x" },
      }),
    ).toEqual({ profilePending: true, id: "u1" });
  });
});
