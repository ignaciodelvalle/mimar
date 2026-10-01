// The web half of the owner's action panel: where each catalogue row goes on
// THIS platform.
//
// The WHAT — which rows, live or grey, and why — is `derivePetActions`, tested
// in the contract. What is pinned here is the WHERE: a sheet on this page, a
// page of its own, or the lost case already on screen. Since the web gained its
// own photo door (`?sheet=foto`, the app's photo screen's twin) there is no row
// the catalogue makes live that the web cannot open.

import { describe, expect, it } from "vitest";

import {
  PET_ACTION_INERT_CAPTIONS,
  type PetActionContext,
  type PetActionId,
  derivePetActions,
} from "@dim/contract/reference";

import {
  LOST_CASE_ANCHOR,
  type WebPetAction,
  type WebPetActions,
  resolveWebPetActions,
} from "./pet-action-web";

const TOKEN = "DIM-PAMP-0001";

const TITULAR: PetActionContext = {
  viewerRole: "owner",
  isTitular: true,
  petStatus: "active",
  species: "dog",
  pppDoor: false,
};

function web(ctx: PetActionContext): WebPetActions {
  return resolveWebPetActions(derivePetActions(ctx), {
    petPublicToken: TOKEN,
    petStatus: ctx.petStatus ?? "active",
  });
}

function all(actions: WebPetActions): WebPetAction[] {
  return [...actions.primary, ...actions.groups.flatMap((g) => g.actions)];
}

function find(actions: WebPetActions, id: PetActionId): WebPetAction {
  const action = all(actions).find((a) => a.id === id);
  if (!action) throw new Error(`${id} is absent`);
  return action;
}

describe("resolveWebPetActions — where each row goes on the web", () => {
  it("opens the primary row's three sheets on this same page", () => {
    const actions = web(TITULAR);
    expect(actions.primary.map((a) => [a.id, a.link])).toEqual([
      ["record", { kind: "sheet", href: `/mis-mascotas/${TOKEN}?sheet=anotar` }],
      ["share", { kind: "sheet", href: `/mis-mascotas/${TOKEN}?sheet=compartir` }],
      ["lost", { kind: "sheet", href: `/mis-mascotas/${TOKEN}?sheet=marcar-perdida` }],
    ]);
  });

  it("sends Modo perdida to the lost case already on the page when the animal IS lost", () => {
    const lost = web({ ...TITULAR, petStatus: "lost" });
    expect(find(lost, "lost").link).toEqual({ kind: "anchor", href: `#${LOST_CASE_ANCHOR}` });
  });

  it("routes every live row of a titular's panel somewhere — none is a dead row", () => {
    const actions = web(TITULAR);
    const live = all(actions).filter((a) => a.link !== null);
    expect(live.length).toBe(all(actions).length);
    expect(Object.fromEntries(live.map((a) => [a.id, a.link?.href]))).toMatchObject({
      edit: `/mis-mascotas/${TOKEN}?sheet=editar-mascota`,
      photo: `/mis-mascotas/${TOKEN}?sheet=foto`,
      contacts: `/mis-mascotas/${TOKEN}?sheet=emergencia`,
      service_dog: `/mis-mascotas/${TOKEN}/asistencia`,
      physical_tag: `/mis-mascotas/${TOKEN}?sheet=chapita`,
      vaccine_reminders: `/mis-mascotas/${TOKEN}/vacunas/programar`,
      travel: `/mis-mascotas/${TOKEN}/viaje`,
      caretaker: `/mis-mascotas/${TOKEN}/cuidado`,
      return: `/mis-mascotas/${TOKEN}/devolucion`,
      find_home: `/mis-mascotas/${TOKEN}/buscar-hogar`,
      transfer: `/mis-mascotas/${TOKEN}?sheet=transferir-mascota`,
      death: `/mis-mascotas/${TOKEN}/eventos/nuevo/fallecimiento`,
    });
  });

  it("tells a sheet on this page from a page of its own — they open differently", () => {
    const actions = web(TITULAR);
    expect(find(actions, "transfer").link?.kind).toBe("sheet");
    expect(find(actions, "travel").link?.kind).toBe("route");
  });
});

describe("resolveWebPetActions — what stays grey", () => {
  it("keeps the catalogue's reason on a row it greyed, and gives it no link", () => {
    const coOwner = web({ ...TITULAR, viewerRole: "co_owner", isTitular: false });
    const transfer = find(coOwner, "transfer");
    expect(transfer.link).toBeNull();
    expect(transfer.caption).toBe(PET_ACTION_INERT_CAPTIONS.titular_only);
  });

  it("opens the photo for a CARETAKER, as the app does — the edit form stays grey", () => {
    // The catalogue gives a caretaker the photo LIVE (photos are among what a
    // caretaker MAY do) and "Editar datos" grey. The photo is its own door on
    // both platforms now, so the grey edit form no longer takes it with it.
    const caretaker = web({ ...TITULAR, viewerRole: "caretaker", isTitular: false });
    expect(find(caretaker, "edit").link).toBeNull();
    const photo = find(caretaker, "photo");
    expect(photo.link).toEqual({ kind: "sheet", href: `/mis-mascotas/${TOKEN}?sheet=foto` });
    expect(photo.caption).toBeNull();
    // And the credential's photo frame is the same door.
    expect(caretaker.photoHref).toBe(`/mis-mascotas/${TOKEN}?sheet=foto`);
  });

  it("draws no live row grey for want of a web door, for any holder in any state", () => {
    const offences: string[] = [];
    let checked = 0;
    for (const viewerRole of ["owner", "co_owner", "foster", "caretaker"] as const) {
      for (const petStatus of ["active", "lost", "deceased"] as const) {
        const ctx = { ...TITULAR, viewerRole, isTitular: viewerRole === "owner", petStatus };
        const derived = derivePetActions(ctx);
        const actions = web(ctx);
        for (const action of [...derived.primary, ...derived.groups.flatMap((g) => g.actions)]) {
          if (action.state.kind !== "live") continue;
          checked += 1;
          if (find(actions, action.id).link === null) {
            offences.push(`${viewerRole}/${petStatus}/${action.id}`);
          }
        }
      }
    }
    // Non-vacuity: the twelve panels above hold dozens of live rows.
    expect(checked).toBeGreaterThan(50);
    expect(offences).toEqual([]);
  });

  it("keeps the photo door for a deceased animal's titular", () => {
    const deceased = web({ ...TITULAR, petStatus: "deceased" });
    expect(find(deceased, "photo").link?.href).toBe(`/mis-mascotas/${TOKEN}?sheet=foto`);
  });

  it("makes the photo frame the same door as the Foto row", () => {
    const titular = web(TITULAR);
    expect(titular.photoHref).toBe(find(titular, "photo").link?.href);
    expect(titular.photoHref).toBe(`/mis-mascotas/${TOKEN}?sheet=foto`);
  });

  it("keeps the standing note under a live row — the death row says what it closes", () => {
    expect(find(web(TITULAR), "death").caption).toBe("Cierra el registro del animal");
  });

  it("carries the catalogue's own words — the web adds no label of its own", () => {
    const derived = derivePetActions(TITULAR);
    const actions = web(TITULAR);
    for (const [index, action] of derived.primary.entries()) {
      expect(actions.primary[index]?.label).toBe(action.label);
      expect(actions.primary[index]?.hint).toBe(action.hint);
    }
    expect(actions.groups.map((g) => g.heading)).toEqual(derived.groups.map((g) => g.heading));
  });

  it("gives an organization member nothing but Compartir, and no photo door", () => {
    const member = web({ ...TITULAR, viewerRole: "org_member", isTitular: false });
    expect(all(member).map((a) => a.id)).toEqual(["share"]);
    expect(member.groups).toEqual([]);
    expect(member.photoHref).toBeNull();
  });
});
