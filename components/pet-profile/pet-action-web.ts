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
// EVERY LIVE ROW HAS A DOOR HERE. The photo was the last one missing: its only
// web field lived inside "Editar datos", which a caretaker may not use, while
// the app had a photo screen for any holder (`POST /pets/{token}/photo`). The
// web's `?sheet=foto` is that screen's twin (`updatePetPhotoAction`, the same
// rule), so the catalogue's live photo row opens it for every holder — the
// owner included, as on the app — and the credential's frame opens it too.
//
// Pure: no React, no I/O. The page derives once and hands the result to the
// primary row, the panel and the credential's photo frame, so the three cannot
// disagree about a door.

import type { PetProfileIconName } from "@dim/contract/icons";
import type {
  DerivedPetAction,
  DerivedPetActions,
  PetActionGroupId,
  PetActionId,
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
  /** The credential's photo frame: the Foto row's door, or `null` with no Foto row (the org path). */
  photoHref: string | null;
};

export type WebPetActionContext = {
  petPublicToken: string;
  petStatus: "active" | "lost" | "deceased";
};

function sheet(ctx: WebPetActionContext, id: string): WebPetActionLink {
  return { kind: "sheet", href: `/mis-mascotas/${ctx.petPublicToken}?sheet=${id}` };
}

function route(ctx: WebPetActionContext, path: string): WebPetActionLink {
  return { kind: "route", href: `/mis-mascotas/${ctx.petPublicToken}/${path}` };
}

type Destination = (ctx: WebPetActionContext) => WebPetActionLink;

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
  // Its own sheet, for any holder the catalogue gives the row to — the app's
  // photo screen's twin, not a field of the edit form a caretaker cannot open.
  photo: (ctx) => sheet(ctx, "foto"),
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

function toWeb(action: DerivedPetAction, ctx: WebPetActionContext): WebPetAction {
  const base = {
    id: action.id,
    label: action.label,
    hint: action.hint,
    caption: action.caption,
    icon: action.icon,
    tone: action.tone,
  };
  if (action.state.kind === "inert") return { ...base, link: null };
  return { ...base, link: WEB_PET_ACTION_DESTINATIONS[action.id](ctx) };
}

/** The derived panel, with this platform's doors. Pure. */
export function resolveWebPetActions(
  derived: DerivedPetActions,
  ctx: WebPetActionContext,
): WebPetActions {
  const primary = derived.primary.map((action) => toWeb(action, ctx));
  const groups = derived.groups.map((group) => ({
    id: group.id,
    heading: group.heading,
    actions: group.actions.map((action) => toWeb(action, ctx)),
  }));
  const photo = groups.flatMap((g) => g.actions).find((a) => a.id === "photo");
  return { primary, groups, photoHref: photo?.link?.href ?? null };
}
