// Where the owner's pet actions go ON THE WEB.
//
// THE CATALOGUE SAYS WHAT, THIS FILE SAYS WHERE. `derivePetActions`
// (`@dim/contract/reference`) decides which rows a viewer gets, live or grey
// and why, with the labels the PO validated — once, for the web and the app.
// It cannot say where a row LEADS, because that is a sheet on this platform and
// a screen on the other. So the destinations live here, as an exhaustive
// `Record<PetActionId, …>`: an id added to the catalogue fails to compile on
// the web until it says where it goes, and the app keeps its own record of the
// same shape.
//
// ONE PLATFORM RULE THE CATALOGUE CANNOT KNOW: the web's only photo field lives
// inside "Editar datos" (`updatePetAction`), so a holder that form does not
// admit — a caretaker, a user-held custody row — has no web door to the photo,
// while the app has one of its own (`POST /pets/{token}/photo`, any holder). The
// form admits exactly the viewers whose `edit` row is live, so the photo's door
// is read off that row rather than off a second copy of the rule. A live row the
// web cannot serve is drawn grey with "Se hace desde la app" rather than linking
// to a form that would refuse the save.
//
// Pure: no React, no I/O. The page derives once and hands the result to the
// primary row, the panel and the credential's photo frame, so the three cannot
// disagree about a door.

import type { PetProfileIconName } from "@dim/contract/icons";
import {
  type DerivedPetAction,
  type DerivedPetActions,
  PET_ACTION_INERT_CAPTIONS,
  type PetActionGroupId,
  type PetActionId,
  findPetAction,
} from "@dim/contract/reference";

/** The element the profile wraps the lost case in, for "Modo perdida" to land on. */
export const LOST_CASE_ANCHOR = "modo-perdida";

/**
 * How a row opens. A `sheet` is a `?sheet=` on this same page and opens through
 * the History API (`SheetTriggerLink`, lib/ui/sheet-nav.ts); a `route` is a page
 * of its own; an `anchor` is a block already on this page.
 */
export type WebPetActionLink = { kind: "sheet" | "route" | "anchor"; href: string };

export type WebPetAction = {
  id: PetActionId;
  label: string;
  hint: string;
  /** The reason under a grey row, or a live row's standing note; else `null`. */
  caption: string | null;
  icon: PetProfileIconName | null;
  tone: "default" | "danger";
  /** `null` = the row is grey: shown, not reachable, `caption` says why. */
  link: WebPetActionLink | null;
};

export type WebPetActionGroup = {
  id: PetActionGroupId;
  heading: string | null;
  actions: WebPetAction[];
};

export type WebPetActions = {
  primary: WebPetAction[];
  groups: WebPetActionGroup[];
  /** The credential's photo frame: the Foto row's door, or `null` when it has none here. */
  photoHref: string | null;
};

export type WebPetActionContext = {
  petPublicToken: string;
  petStatus: "active" | "lost" | "deceased";
};

/** What a destination reads: the page's facts, plus what the panel itself decided. */
type DestinationContext = WebPetActionContext & {
  /** The catalogue's `edit` row is live — the web's edit form admits this viewer. */
  editFormAdmits: boolean;
};

function sheet(ctx: DestinationContext, id: string, section?: string): WebPetActionLink {
  const query = section ? `?sheet=${id}&seccion=${section}` : `?sheet=${id}`;
  return { kind: "sheet", href: `/mis-mascotas/${ctx.petPublicToken}${query}` };
}

function route(ctx: DestinationContext, path: string): WebPetActionLink {
  return { kind: "route", href: `/mis-mascotas/${ctx.petPublicToken}/${path}` };
}

/** `null` = the web has no door for this viewer; the row turns grey, `app_only`. */
type Destination = (ctx: DestinationContext) => WebPetActionLink | null;

export const WEB_PET_ACTION_DESTINATIONS: Readonly<Record<PetActionId, Destination>> = {
  record: (ctx) => sheet(ctx, "anotar"),
  share: (ctx) => sheet(ctx, "compartir"),
  // The cockpit for both directions: marking a lost animal opens the wizard;
  // on an animal already lost, the case block on this page IS the cockpit
  // (last seen, sightings, "Marcar como encontrada").
  lost: (ctx) =>
    ctx.petStatus === "lost"
      ? { kind: "anchor", href: `#${LOST_CASE_ANCHOR}` }
      : sheet(ctx, "marcar-perdida"),
  edit: (ctx) => sheet(ctx, "editar-mascota"),
  photo: (ctx) => (ctx.editFormAdmits ? sheet(ctx, "editar-mascota", "foto") : null),
  contacts: (ctx) => sheet(ctx, "emergencia"),
  service_dog: (ctx) => route(ctx, "asistencia"),
  physical_tag: (ctx) => sheet(ctx, "chapita"),
  vaccine_reminders: (ctx) => route(ctx, "vacunas/programar"),
  travel: (ctx) => route(ctx, "viaje"),
  caretaker: (ctx) => route(ctx, "cuidado"),
  // The page answers every holder's state itself: a pending proposal to
  // accept, a return to propose, or why there is nothing to do.
  return: (ctx) => route(ctx, "devolucion"),
  find_home: (ctx) => route(ctx, "buscar-hogar"),
  transfer: (ctx) => sheet(ctx, "transferir-mascota"),
  death: (ctx) => route(ctx, "eventos/nuevo/fallecimiento"),
};

function toWeb(action: DerivedPetAction, ctx: DestinationContext): WebPetAction {
  const base = {
    id: action.id,
    label: action.label,
    hint: action.hint,
    icon: action.icon,
    tone: action.tone,
  };
  if (action.state.kind === "inert") return { ...base, caption: action.caption, link: null };
  const link = WEB_PET_ACTION_DESTINATIONS[action.id](ctx);
  if (link === null) {
    return { ...base, caption: PET_ACTION_INERT_CAPTIONS.app_only, link: null };
  }
  return { ...base, caption: action.caption, link };
}

/** The derived panel, with this platform's doors. Pure. */
export function resolveWebPetActions(
  derived: DerivedPetActions,
  page: WebPetActionContext,
): WebPetActions {
  const ctx: DestinationContext = {
    ...page,
    editFormAdmits: findPetAction(derived, "edit")?.state.kind === "live",
  };
  const primary = derived.primary.map((action) => toWeb(action, ctx));
  const groups = derived.groups.map((group) => ({
    id: group.id,
    heading: group.heading,
    actions: group.actions.map((action) => toWeb(action, ctx)),
  }));
  const photo = groups.flatMap((g) => g.actions).find((a) => a.id === "photo");
  return { primary, groups, photoHref: photo?.link?.href ?? null };
}
