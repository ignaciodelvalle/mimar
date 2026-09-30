// The ONE org-type rule and what hangs off it (portal-vet-p0 D13).
//
// Two things are pinned here. The rule itself — which org types run the
// custody-rehoming lifecycle — and, for the shelters that always had it, that
// NOTHING changed: every shelter string is asserted byte for byte, so a clinic
// fix can never leak into a refugio's screens.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { capabilityAppliesToOrgType } from "./capabilities";
import { REHOMING_ORG_TYPES, isRehomingOrgType } from "./org-type";
import { orgVocabulary } from "./org-type-vocabulary";
import { INVITABLE_ROLES, roleAppliesToOrgType } from "./role-rules";

const REHOMING = ["shelter", "rescue_network"] as const;
const NON_REHOMING = ["clinic", "sanitary_authority", "other"] as const;

describe("isRehomingOrgType — the one rule", () => {
  it("is exactly shelter and rescue_network", () => {
    expect([...REHOMING_ORG_TYPES].sort()).toEqual(["rescue_network", "shelter"]);
    for (const t of REHOMING) expect(isRehomingOrgType(t), t).toBe(true);
    for (const t of NON_REHOMING) expect(isRehomingOrgType(t), t).toBe(false);
  });

  it("is a zero-import leaf, so a client component can read it", () => {
    const source = readFileSync(new URL("./org-type.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it("is the rule capabilityAppliesToOrgType asks", () => {
    for (const t of [...REHOMING, ...NON_REHOMING]) {
      expect(capabilityAppliesToOrgType("adoption.review", t), t).toBe(isRehomingOrgType(t));
      expect(capabilityAppliesToOrgType("event.write", t), t).toBe(true);
    }
  });
});

describe("roleAppliesToOrgType — coordinator and volunteer are shelter roles", () => {
  it("offers every invitable role to a shelter and a rescue network", () => {
    for (const t of REHOMING) {
      for (const role of INVITABLE_ROLES) expect(roleAppliesToOrgType(role, t), role).toBe(true);
    }
  });

  it("withholds coordinator and volunteer everywhere else, and nothing more", () => {
    for (const t of NON_REHOMING) {
      expect(INVITABLE_ROLES.filter((r) => roleAppliesToOrgType(r, t))).toEqual([
        "admin",
        "member",
        "vet_individual",
      ]);
    }
  });
});

describe("orgVocabulary", () => {
  it("keeps every shelter string byte-identical (regression)", () => {
    for (const t of REHOMING) {
      expect(orgVocabulary(t)).toEqual({
        heldPetsTitle: "Mascotas en custodia",
        messagesIntroLead:
          "Consultas y ofrecimientos de voluntariado que llegaron desde el perfil público de",
        messagesEmptyDescription:
          "Cuando alguien escriba desde el perfil público o se ofrezca como voluntario/a, va a aparecer acá.",
        originOrgToggleLabel:
          "Mostrar a mi organización como refugio de origen en la credencial pública de las mascotas",
        originOrgToggleHint:
          "Cuando está activo, la credencial pública muestra el nombre de tu organización como refugio de origen de la mascota.",
      });
    }
  });

  it('calls a clinic\'s animals "Pacientes" (PO decision)', () => {
    expect(orgVocabulary("clinic").heldPetsTitle).toBe("Pacientes");
  });

  it("does not call an authority's animals patients", () => {
    expect(orgVocabulary("sanitary_authority").heldPetsTitle).toBe("Mascotas a cargo");
    expect(orgVocabulary("other").heldPetsTitle).toBe("Mascotas a cargo");
  });

  it("never speaks of volunteers or a refugio to a non-rehoming org", () => {
    for (const t of NON_REHOMING) {
      const words = Object.values(orgVocabulary(t)).join(" ");
      expect(words, t).not.toMatch(/voluntari|refugio/i);
    }
  });
});
