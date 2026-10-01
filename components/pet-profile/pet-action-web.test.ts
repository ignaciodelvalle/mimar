// The web half of the owner's action panel: where each catalogue row goes on
// THIS platform, and what happens to a row the web has no door for.
//
// The WHAT — which rows, live or grey, and why — is `derivePetActions`, tested
// in the contract. What is pinned here is the WHERE: a sheet on this page, a
// page of its own, or the lost case already on screen; and the one platform
// rule the catalogue cannot know, that the web's only photo field lives inside
// "Editar datos".

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
      photo: `/mis-mascotas/${TOKEN}?sheet=editar-mascota&seccion=foto`,
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

  it("greys the photo for a holder the web's edit form refuses, naming the app that has the door", () => {
    // The catalogue gives a caretaker the photo LIVE (the app's photo door
    // admits any holder) and "Editar datos" grey; the web's photo IS that form.
    const caretaker = web({ ...TITULAR, viewerRole: "caretaker", isTitular: false });
    expect(find(caretaker, "edit").link).toBeNull();
    const photo = find(caretaker, "photo");
    expect(photo.link).toBeNull();
    expect(photo.caption).toBe(PET_ACTION_INERT_CAPTIONS.app_only);
    // And the credential's photo frame is not a door for them either.
    expect(caretaker.photoHref).toBeNull();
  });

  it("keeps the photo door for a deceased animal's titular — the form still admits them", () => {
    const deceased = web({ ...TITULAR, petStatus: "deceased" });
    expect(find(deceased, "photo").link?.href).toContain("seccion=foto");
  });

  it("makes the photo frame the same door as the Foto row when the viewer may use it", () => {
    const titular = web(TITULAR);
    expect(titular.photoHref).toBe(find(titular, "photo").link?.href);
    expect(titular.photoHref).toContain("seccion=foto");
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
