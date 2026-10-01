// The owner panel's rows ARE the server's gates — pinned, for every role.
//
// The catalogue (`derivePetActions`) decides who gets a row live; the server
// decides who may actually do the thing. When the two disagree a person meets a
// live row that refuses them, or misses a door they have — and the old "⋯ Más"
// sheet did both (a titular tapped "Buscar hogar" into a 404, 2026-08-20). The
// pins that sheet's own test carried move here with it, against the catalogue
// that replaced it, and a third joins them: "web = app" for "Editar datos"
// (owner-pet-actions, PO 2026-10-01), where the web's form, the app's command
// and the panel's row now read ONE predicate.
//
// Every role the database knows is walked (`ownershipRoleEnum`), through the
// same role mapping the API and the page use (`toViewerRole`), so a role added
// to the enum is judged here the day it exists.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ownershipRoleEnum } from "@/db/schema";
import { canEditPetProfile } from "@/lib/domain/profile-editors";
import { TRAVEL_TITULAR_ROLES } from "@/lib/infra/travel-private-events";
import { toViewerRole } from "@dim/contract/api";
import { type PetActionId, derivePetActions, findPetAction } from "@dim/contract/reference";

const ROLES = ownershipRoleEnum.enumValues;

/** The row's state for a person-path holder of `role`, on an active dog. */
function rowFor(id: PetActionId, role: string): "live" | "inert" | "absent" {
  const derived = derivePetActions({
    viewerRole: toViewerRole("owner", role),
    isTitular: role === "owner",
    petStatus: "active",
    species: "dog",
    pppDoor: false,
  });
  const action = findPetAction(derived, id);
  return action === null ? "absent" : action.state.kind;
}

describe("Editar datos — the panel's row, the web's form and the app's command are one gate", () => {
  it("walks every ownership role the database knows", () => {
    expect(ROLES.length).toBeGreaterThanOrEqual(5);
  });

  it.each(ROLES)("a %s holder: the row is live exactly when the server lets them save", (role) => {
    expect(rowFor("edit", role) === "live").toBe(canEditPetProfile("owner", role));
  });

  it("the org path: no row, and no save", () => {
    const member = derivePetActions({
      viewerRole: toViewerRole("org", null),
      isTitular: false,
      petStatus: "active",
      species: "dog",
      pppDoor: false,
    });
    expect(findPetAction(member, "edit")).toBeNull();
    expect(canEditPetProfile("org", null)).toBe(false);
  });

  it("refuses a user-held custody row and a caretaker, and admits the three titular roles", () => {
    // Spelled out once, so the walk above cannot pass by both sides being wrong
    // the same way.
    expect(ROLES.filter((role) => canEditPetProfile("owner", role)).sort()).toEqual(
      ["co_owner", "foster", "owner"].sort(),
    );
  });
});

describe("Viaje y movilidad — the row is TRAVEL_TITULAR_ROLES, the list /viaje and the API enforce", () => {
  it.each(ROLES)("a %s holder: live exactly when the role is a travel titular", (role) => {
    const live = rowFor("travel", role) === "live";
    expect(live).toBe((TRAVEL_TITULAR_ROLES as readonly string[]).includes(role));
  });
});

describe("Buscar hogar — the row cannot outrun the page behind it", () => {
  // DERIVED from the page rather than restated: a hard-coded list would pass
  // just as happily the day someone widens one side again.
  const PAGE = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "app",
      "(app)",
      "mis-mascotas",
      "[publicToken]",
      "buscar-hogar",
      "page.tsx",
    ),
    "utf8",
  );
  const accepted = [...PAGE.matchAll(/eq\(\s*ownerships\.role\s*,\s*"([a-z_]+)"\s*\)/g)].map(
    (m) => m[1],
  );

  it("reads the page's role gate (non-vacuity: the pattern must match)", () => {
    expect(accepted.length).toBeGreaterThan(0);
  });

  it("offers the row live to no role the page would reject", () => {
    const offered = ROLES.filter((role) => rowFor("find_home", role) === "live");
    expect(offered.length).toBeGreaterThan(0);
    for (const role of offered) expect(accepted).toContain(role);
  });
});
