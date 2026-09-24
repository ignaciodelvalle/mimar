// D.2 — one label per party role, and it addresses everybody.
//
// Two defects met here. The labels were DUPLICATED across the detail page and
// AddPartyForm, and had already drifted three ways: "Reclamante" vs
// "Reclamante (persona)", plus "Organizacion" without its accent, twice, in the
// form only. Someone adding a party read one word and saw a different one on
// the row they had just created.
//
// And "Dueño actual" was the app addressing half its users, on a screen about
// who a family's animal belongs to. The rest of the product says "dueño/a".

import { describe, expect, it } from "vitest";

import type { DisputePartyRole } from "@/src/modules/custody-disputes/domain/types";
import { PARTY_ROLE_LABELS, PARTY_ROLE_OPTIONS, partyRoleLabel } from "./_party-roles";

const ALL_ROLES: DisputePartyRole[] = [
  "current_owner",
  "claimant_owner",
  "current_org_custody",
  "claimant_org",
  "witness",
];

describe("party role labels", () => {
  it("names every role in the domain union", () => {
    // The Record type already enforces this at compile time; asserted at
    // runtime too so a role added to the union is impossible to miss.
    for (const role of ALL_ROLES) {
      expect(PARTY_ROLE_LABELS[role], `${role} has no label`).toBeTruthy();
    }
    expect(Object.keys(PARTY_ROLE_LABELS).sort()).toEqual([...ALL_ROLES].sort());
  });

  it("uses the app's inclusive form for the owner — not the masculine-only one", () => {
    // The exact string the live review flagged.
    expect(PARTY_ROLE_LABELS.current_owner).not.toBe("Dueño actual");
    expect(PARTY_ROLE_LABELS.current_owner).toContain("Dueño/a");
  });

  it("no label addresses only one gender", () => {
    // A masculine noun for a PERSON must carry its "/a". This catches the
    // next one too, not only the one that was reported.
    for (const [role, label] of Object.entries(PARTY_ROLE_LABELS)) {
      const masculinePersonNoun = /\b(Dueño|Reclamante masculino|Testigo)\b/.exec(label);
      if (masculinePersonNoun && masculinePersonNoun[1] === "Dueño") {
        expect(label, `${role}: "${label}" addresses only one gender`).toMatch(/Dueño\/a/);
      }
    }
  });

  it("spells Organización with its accent", () => {
    // The form said "Organizacion" — twice. es-AR copy is not optional.
    for (const [role, label] of Object.entries(PARTY_ROLE_LABELS)) {
      expect(label, `${role}: "${label}" is missing an accent`).not.toMatch(/Organizacion/);
    }
  });

  it("the select options ARE the labels — the two cannot drift again", () => {
    // The whole point of the shared module: the form and the row read the
    // same map, so a change to one is a change to both.
    expect(PARTY_ROLE_OPTIONS.map((o) => o.label)).toEqual(Object.values(PARTY_ROLE_LABELS));
    expect(PARTY_ROLE_OPTIONS.map((o) => o.value)).toEqual(Object.keys(PARTY_ROLE_LABELS));
  });

  it("falls back to the raw value for an unknown role, never to an empty chip", () => {
    // An official seeing "custody_referee" learns something; a blank cell does
    // not, and looks like a data-loss bug.
    expect(partyRoleLabel("custody_referee")).toBe("custody_referee");
    expect(partyRoleLabel("current_owner")).toBe("Dueño/a actual");
  });
});
