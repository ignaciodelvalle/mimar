// `derivePetActions` — the one answer both owner panels render from.
//
// The web's "⋯ Más" sheet, the app's "Más" list and the Anotar catalogue's
// "Perfil" category each kept their own labels, order and gates, and the three
// had drifted apart (a co-owner read a live row the web refused, a deceased
// animal offered pages the web hid). These tests pin the merged rules once, as
// behaviour: who sees a row, who sees it grey and why, and when a row is gone.
//
// Every scenario names the viewer, the animal's situation and the species,
// because those three are the whole input — a test that varies one of them and
// leaves the others implicit proves less than it reads.

import { describe, expect, it } from "vitest";

import { toViewerRole } from "../../api/owner-pet-detail.ts";
import {
  type DerivedPetActions,
  PET_ACTION_IDS,
  PET_ACTION_INERT_CAPTIONS,
  PET_ACTION_INERT_REASONS,
  type PetActionContext,
  type PetActionId,
  derivePetActions,
  findPetAction,
} from "../pet-actions.ts";

const OWNER_ACTIVE_DOG: PetActionContext = {
  viewerRole: "owner",
  isTitular: true,
  petStatus: "active",
  species: "dog",
  pppDoor: false,
};

function ids(derived: DerivedPetActions): {
  primary: PetActionId[];
  groups: Array<[string, PetActionId[]]>;
} {
  return {
    primary: derived.primary.map((a) => a.id),
    groups: derived.groups.map((g) => [g.id, g.actions.map((a) => a.id)]),
  };
}

function stateOf(derived: DerivedPetActions, id: PetActionId): string {
  const action = findPetAction(derived, id);
  if (action === null) return "absent";
  return action.state.kind === "live" ? "live" : `inert:${action.state.reason}`;
}

describe("derivePetActions — the titular of a healthy dog sees every door open", () => {
  const derived = derivePetActions(OWNER_ACTIVE_DOG);

  it("puts Anotar, Compartir and Modo perdida in the primary row, in that order", () => {
    expect(derived.primary.map((a) => a.label)).toEqual(["Anotar", "Compartir", "Modo perdida"]);
  });

  it("groups the rest under the four themes plus the closing act, in the panel's order", () => {
    expect(ids(derived).groups).toEqual([
      ["pet", ["edit", "photo", "contacts", "service_dog", "physical_tag"]],
      ["health", ["vaccine_reminders"]],
      ["trips", ["travel"]],
      ["custody", ["caretaker", "return", "find_home", "transfer"]],
      ["closing", ["death"]],
    ]);
    expect(derived.groups.map((g) => g.heading)).toEqual([
      "La mascota",
      "Salud",
      "Viajes",
      "Custodia",
      null,
    ]);
  });

  it("offers every row live", () => {
    for (const id of PET_ACTION_IDS) {
      expect(stateOf(derived, id), id).toBe("live");
    }
  });

  it("captions the death row with what it does, even while live", () => {
    expect(findPetAction(derived, "death")?.caption).toBe("Cierra el registro del animal");
    expect(findPetAction(derived, "edit")?.caption).toBeNull();
  });

  it("names the titular's rehoming row by what the titular asks for", () => {
    expect(findPetAction(derived, "find_home")?.label).toBe("Acompañamiento de adopción");
  });
});

describe("derivePetActions — a deceased animal keeps four doors and nothing else", () => {
  it("drops every write except Compartir, Editar datos, Foto and Contactos", () => {
    const derived = derivePetActions({ ...OWNER_ACTIVE_DOG, petStatus: "deceased" });
    expect(ids(derived)).toEqual({
      primary: ["share"],
      groups: [["pet", ["edit", "photo", "contacts"]]],
    });
  });

  it("keeps each of the four under its own rule — a caretaker still cannot edit", () => {
    const derived = derivePetActions({
      ...OWNER_ACTIVE_DOG,
      viewerRole: "caretaker",
      isTitular: false,
      petStatus: "deceased",
    });
    expect(stateOf(derived, "edit")).toBe("inert:caretaker");
    expect(stateOf(derived, "photo")).toBe("live");
    expect(stateOf(derived, "contacts")).toBe("inert:titular_only");
  });
});

describe("derivePetActions — what does not apply is shown grey, with the reason", () => {
  it("a co-owner sees the titular-only rows inert, captioned 'Solo el titular'", () => {
    const derived = derivePetActions({
      ...OWNER_ACTIVE_DOG,
      viewerRole: "co_owner",
      isTitular: false,
    });
    for (const id of ["contacts", "service_dog", "caretaker", "transfer", "find_home"] as const) {
      expect(stateOf(derived, id), id).toBe("inert:titular_only");
      expect(findPetAction(derived, id)?.caption, id).toBe("Solo el titular");
    }
    // Everything a co-owner may do stays live.
    for (const id of ["record", "lost", "edit", "photo", "travel", "return", "death"] as const) {
      expect(stateOf(derived, id), id).toBe("live");
    }
  });

  it("a titular with a LOST animal cannot transfer it or lend it, and is told why", () => {
    const derived = derivePetActions({ ...OWNER_ACTIVE_DOG, petStatus: "lost" });
    expect(stateOf(derived, "transfer")).toBe("inert:not_active");
    expect(stateOf(derived, "caretaker")).toBe("inert:not_active");
    expect(findPetAction(derived, "transfer")?.caption).toBe("No se puede en esta situación");
    // Lost mode is the cockpit for both directions: it stays on a lost animal.
    expect(stateOf(derived, "lost")).toBe("live");
    expect(stateOf(derived, "find_home")).toBe("live");
  });

  it("a caretaker keeps the acts the role exists for and sees the owner's rows grey", () => {
    const derived = derivePetActions({
      ...OWNER_ACTIVE_DOG,
      viewerRole: "caretaker",
      isTitular: false,
    });
    expect(stateOf(derived, "edit")).toBe("inert:caretaker");
    expect(stateOf(derived, "travel")).toBe("inert:caretaker");
    expect(stateOf(derived, "contacts")).toBe("inert:titular_only");
    expect(findPetAction(derived, "edit")?.caption).toBe(PET_ACTION_INERT_CAPTIONS.caretaker);
    for (const id of [
      "record",
      "share",
      "lost",
      "photo",
      "physical_tag",
      "return",
      "death",
    ] as const) {
      expect(stateOf(derived, id), id).toBe("live");
    }
  });

  it("a foster gets the rehoming row under the foster's own name, live", () => {
    const derived = derivePetActions({
      ...OWNER_ACTIVE_DOG,
      viewerRole: "foster",
      isTitular: false,
    });
    const findHome = findPetAction(derived, "find_home");
    expect(findHome?.label).toBe("Buscar hogar");
    expect(findHome?.state).toEqual({ kind: "live" });
    expect(stateOf(derived, "travel")).toBe("live");
    expect(stateOf(derived, "transfer")).toBe("inert:titular_only");
  });
});

describe("derivePetActions — rows that are not this viewer's world are absent", () => {
  it("an organization member gets Compartir and no panel at all", () => {
    const derived = derivePetActions({
      ...OWNER_ACTIVE_DOG,
      viewerRole: "org_member",
      isTitular: false,
    });
    expect(ids(derived)).toEqual({ primary: ["share"], groups: [] });
  });

  it("the assistance-dog row exists for dogs only", () => {
    const cat = derivePetActions({ ...OWNER_ACTIVE_DOG, species: "cat" });
    expect(stateOf(cat, "service_dog")).toBe("absent");
    expect(cat.groups[0]?.actions.map((a) => a.id)).toEqual([
      "edit",
      "photo",
      "contacts",
      "physical_tag",
    ]);
  });
});

describe("derivePetActions — a section that did not load takes nothing away", () => {
  it("an unread status reads as no fact, so the titular rows stay live", () => {
    const derived = derivePetActions({ ...OWNER_ACTIVE_DOG, petStatus: null });
    expect(stateOf(derived, "transfer")).toBe("live");
    expect(stateOf(derived, "record")).toBe("live");
  });

  it("an unread species keeps the assistance-dog row offered", () => {
    const derived = derivePetActions({ ...OWNER_ACTIVE_DOG, species: null });
    expect(stateOf(derived, "service_dog")).toBe("live");
  });
});

describe("derivePetActions — the attestation door is the compliance card's, not a row", () => {
  it("opens only when the regime is KNOWN to apply and the animal is alive", () => {
    expect(derivePetActions({ ...OWNER_ACTIVE_DOG, pppDoor: true }).attestationDoor).toBe(true);
    expect(derivePetActions({ ...OWNER_ACTIVE_DOG, pppDoor: false }).attestationDoor).toBe(false);
    // The one place an unread fact CLOSES a door: offering the dangerous-breed
    // form on an outage would put it in front of almost every owner.
    expect(derivePetActions({ ...OWNER_ACTIVE_DOG, pppDoor: null }).attestationDoor).toBe(false);
    expect(
      derivePetActions({ ...OWNER_ACTIVE_DOG, pppDoor: true, petStatus: "deceased" })
        .attestationDoor,
    ).toBe(false);
  });

  it("never appears as a panel row", () => {
    const derived = derivePetActions({ ...OWNER_ACTIVE_DOG, pppDoor: true });
    const everyLabel = [...derived.primary, ...derived.groups.flatMap((g) => g.actions)].map(
      (a) => a.label,
    );
    expect(everyLabel.some((label) => /atestaci/i.test(label))).toBe(false);
  });
});

describe("the catalogue itself", () => {
  it("places every action id exactly once across the primary row and the groups", () => {
    const placed = ids(derivePetActions(OWNER_ACTIVE_DOG));
    const all = [...placed.primary, ...placed.groups.flatMap(([, actions]) => actions)];
    expect([...all].sort()).toEqual([...PET_ACTION_IDS].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("gives every action a hint a screen reader can say", () => {
    const derived = derivePetActions(OWNER_ACTIVE_DOG);
    for (const action of [...derived.primary, ...derived.groups.flatMap((g) => g.actions)]) {
      expect(action.hint.length, action.id).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// The gate matrix — role × status × species × PPP (owner-pet-actions 6.1)
// ---------------------------------------------------------------------------
//
// The scenarios above each vary one fact. This walks EVERY combination the
// catalogue reads — five roles, four statuses (one of them unread), three
// species (one unread) and three PPP facts (one unread): 180 panels — against
// an oracle written from the PO's plan (sdd/owner-pet-actions/design), NOT from
// `RULES`. Two encodings of one rule that agree on all 180 cells are evidence;
// one encoding checked against itself is not. The app's runner walks the same
// matrix through its own panel (apps/mobile/src/pets/OwnerActionPanel.test.tsx).

type Expected = "live" | `inert:${string}` | "absent";

const MATRIX_ROLES = ["owner", "co_owner", "foster", "caretaker", "org_member"] as const;
const MATRIX_STATUSES = ["active", "lost", "deceased", null] as const;
const MATRIX_SPECIES = ["dog", "cat", null] as const;
const MATRIX_PPP = [true, false, null] as const;

const GATE_MATRIX: PetActionContext[] = MATRIX_ROLES.flatMap((viewerRole) =>
  MATRIX_STATUSES.flatMap((petStatus) =>
    MATRIX_SPECIES.flatMap((species) =>
      MATRIX_PPP.map((pppDoor) => ({
        viewerRole,
        isTitular: viewerRole === "owner",
        petStatus,
        species,
        pppDoor,
      })),
    ),
  ),
);

/** The four doors a deceased animal keeps (PO). */
const DECEASED_KEEPS: readonly PetActionId[] = ["share", "edit", "photo", "contacts"];

/**
 * The plan, restated row by row. Each line names the PO decision or the server
 * rule it comes from, so a disagreement with the catalogue says which side
 * moved.
 */
function oracle(id: PetActionId, ctx: PetActionContext): Expected {
  // An organization member acts from the org portal: Compartir, and nothing else.
  if (ctx.viewerRole === "org_member") return id === "share" ? "live" : "absent";
  // A deceased animal keeps Compartir, Editar datos, Foto and Contactos (PO).
  if (ctx.petStatus === "deceased" && !DECEASED_KEEPS.includes(id)) return "absent";
  const titular = ctx.isTitular;
  const caretaker = ctx.viewerRole === "caretaker";
  switch (id) {
    // Every holder, while the animal is alive (or for any animal: share, photo).
    case "record":
    case "share":
    case "lost":
    case "photo":
    case "physical_tag":
    case "vaccine_reminders":
    case "return":
    case "death":
      return "live";
    // requireTitularAccess refuses a caretaker and nobody else on this path.
    case "edit":
      return caretaker ? "inert:caretaker" : "live";
    // The titular's own vet and person to call.
    case "contacts":
      return titular ? "live" : "inert:titular_only";
    // Dogs only — a cat's owner is not "refused" a dog credential; unread
    // species keeps the row.
    case "service_dog":
      if (ctx.species !== null && ctx.species !== "dog") return "absent";
      return titular ? "live" : "inert:titular_only";
    // TRAVEL_TITULAR_ROLES: owner, co-owner, foster.
    case "travel":
      return caretaker ? "inert:caretaker" : "live";
    // Titular-only, and only for an animal not KNOWN to be lost.
    case "caretaker":
    case "transfer":
      if (!titular) return "inert:titular_only";
      return ctx.petStatus === "lost" ? "inert:not_active" : "live";
    // Two audiences for one page: the foster's ask and the titular's.
    case "find_home":
      return titular || ctx.viewerRole === "foster" ? "live" : "inert:titular_only";
  }
}

function matrixName(ctx: PetActionContext): string {
  return `${ctx.viewerRole}/${ctx.petStatus ?? "unread"}/${ctx.species ?? "unread"}/ppp:${ctx.pppDoor ?? "unread"}`;
}

describe("derivePetActions — the whole gate matrix agrees with the plan", () => {
  it("walks every role, status, species and PPP fact: 180 panels", () => {
    expect(GATE_MATRIX).toHaveLength(180);
  });

  it("gives every action, in every cell, the state the plan gives it", () => {
    const offences: string[] = [];
    let inert = 0;
    let absent = 0;
    for (const ctx of GATE_MATRIX) {
      const derived = derivePetActions(ctx);
      for (const id of PET_ACTION_IDS) {
        const want = oracle(id, ctx);
        const got = stateOf(derived, id);
        if (got !== want) offences.push(`${matrixName(ctx)} ${id}: ${got}, plan says ${want}`);
        if (want.startsWith("inert")) inert += 1;
        if (want === "absent") absent += 1;
      }
    }
    // Non-vacuity: the matrix exercises all three states, many times over.
    expect(inert).toBeGreaterThan(100);
    expect(absent).toBeGreaterThan(100);
    expect(offences).toEqual([]);
  });

  it("captions every grey row with its reason, and no live row but the death row", () => {
    const offences: string[] = [];
    for (const ctx of GATE_MATRIX) {
      const derived = derivePetActions(ctx);
      for (const action of [...derived.primary, ...derived.groups.flatMap((g) => g.actions)]) {
        const want =
          action.state.kind === "inert"
            ? PET_ACTION_INERT_CAPTIONS[action.state.reason]
            : action.id === "death"
              ? "Cierra el registro del animal"
              : null;
        if (action.caption !== want) offences.push(`${matrixName(ctx)} ${action.id}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("keeps the panel's shape in every cell: primary row, group order, no empty group", () => {
    // Spelled out, not read off PET_ACTION_GROUPS: the order is the plan's.
    const groupOrder: string[] = ["pet", "health", "trips", "custody", "closing"];
    const primaryRow: PetActionId[] = ["record", "share", "lost"];
    for (const ctx of GATE_MATRIX) {
      const derived = derivePetActions(ctx);
      const name = matrixName(ctx);
      expect([name, derived.primary.map((a) => a.id)]).toEqual([
        name,
        primaryRow.filter((id) => oracle(id, ctx) !== "absent"),
      ]);
      const groups: string[] = derived.groups.map((g) => g.id);
      expect([name, groups]).toEqual([name, groupOrder.filter((id) => groups.includes(id))]);
      for (const group of derived.groups) {
        expect([name, group.id, group.actions.length > 0]).toEqual([name, group.id, true]);
      }
    }
  });

  it("opens the attestation door exactly when the regime is KNOWN to apply to a live animal", () => {
    for (const ctx of GATE_MATRIX) {
      expect([matrixName(ctx), derivePetActions(ctx).attestationDoor]).toEqual([
        matrixName(ctx),
        ctx.pppDoor === true && ctx.petStatus !== "deceased",
      ]);
    }
  });

  it("names the rehoming row by who asks: the foster's 'Buscar hogar', everyone else's adoption", () => {
    let named = 0;
    for (const ctx of GATE_MATRIX) {
      const row = findPetAction(derivePetActions(ctx), "find_home");
      if (row === null) continue;
      named += 1;
      expect([matrixName(ctx), row.label]).toEqual([
        matrixName(ctx),
        ctx.viewerRole === "foster" ? "Buscar hogar" : "Acompañamiento de adopción",
      ]);
    }
    // Every person-path cell on a live animal carries the row.
    expect(named).toBe(
      GATE_MATRIX.filter((c) => c.viewerRole !== "org_member" && c.petStatus !== "deceased").length,
    );
  });
});

describe("the platform caption — a door one platform does not have yet", () => {
  it("is never derived: the catalogue knows nothing about platforms", () => {
    const reasons = new Set<string>();
    for (const viewerRole of ["owner", "co_owner", "foster", "caretaker", "org_member"] as const) {
      for (const petStatus of ["active", "lost", "deceased", null] as const) {
        const derived = derivePetActions({
          viewerRole,
          isTitular: viewerRole === "owner",
          petStatus,
          species: "dog",
          pppDoor: false,
        });
        for (const action of [...derived.primary, ...derived.groups.flatMap((g) => g.actions)]) {
          if (action.state.kind === "inert") reasons.add(action.state.reason);
        }
      }
    }
    // The matrix did produce grey rows, so the absence below is real.
    expect(reasons.size).toBeGreaterThan(0);
    expect(reasons.has("web_only")).toBe(false);
  });

  it("names the platform that does have the door", () => {
    expect(PET_ACTION_INERT_CAPTIONS.web_only).toBe("Se hace desde la web");
  });

  it("keeps no word for a gap that is closed — the web has every door the app has", () => {
    // `app_only` ("Se hace desde la app") named the caretaker's photo, which the
    // web could only reach through "Editar datos". The web's `?sheet=foto` is the
    // app's photo screen's twin now, so no platform has a reason to say it; a
    // caption nobody draws is a sentence nobody reviews.
    expect([...PET_ACTION_INERT_REASONS]).toEqual([
      "titular_only",
      "not_active",
      "caretaker",
      "web_only",
    ]);
  });
});

describe("toViewerRole — the role the catalogue reads, one mapping for the web and the API", () => {
  it("passes the four holder roles through", () => {
    for (const role of ["owner", "co_owner", "foster", "caretaker"] as const) {
      expect(toViewerRole("owner", role)).toBe(role);
    }
  });

  it("reads the org path as a member, whatever role the organization's row holds", () => {
    expect(toViewerRole("org", null)).toBe("org_member");
    expect(toViewerRole("org", "shelter_custody")).toBe("org_member");
  });

  it("reads any other person-path role as a caretaker — the least privileged holder word", () => {
    // A user-held shelter_custody row (the vecino who picked up a stray), a
    // role added tomorrow, and no role at all.
    expect(toViewerRole("owner", "shelter_custody")).toBe("caretaker");
    expect(toViewerRole("owner", "guardian")).toBe("caretaker");
    expect(toViewerRole("owner", null)).toBe("caretaker");
  });
});
