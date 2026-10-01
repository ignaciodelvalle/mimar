// The owner's pet actions — ONE catalogue for the web panel and the app panel.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Until owner-pet-actions (PO, 2026-10-01) the same set of doors was written out
// three times: the web's "⋯ Más" sheet (`MasSheet.helpers.ts`), the app's "Más"
// list (`OwnerFace.tsx` reading `ownerFaceGates`) and the "Perfil" category of
// the web's Anotar catalogue (`anotar/handoff.ts`). Each carried its own labels,
// its own order and its own gates, and they had drifted: "Transferir mascota"
// beside "Transferir la titularidad", a return door the web only linked when a
// proposal was already pending, a co-owner offered a row whose page 404'd. Three
// copies of a rule is how the copies come to disagree, and no test could see it
// because each copy was internally consistent.
//
// So the WHAT lives here, once: which actions exist, their es-AR labels and
// hints, the primary row, the groups and their order, and — the part that
// drifted — who gets each row, live or grey. The WHERE does not: a destination
// is a route on one platform and a sheet on the other, so each platform keeps an
// exhaustive `Record<PetActionId, …>` of its own, and a new id here fails to
// compile on both until both say where it goes.
//
// THE THREE STATES A ROW CAN BE IN, and why "hidden" survives at all
// ---------------------------------------------------------------------------
//   · LIVE — the viewer may do it now.
//   · INERT, WITH A REASON — the row exists for this viewer but not right now,
//     drawn grey with one short line saying why (PO decision: "lo que no aplica
//     en gris con el motivo"). A co-owner sees "Transferir la titularidad —
//     Solo el titular" BEFORE typing an address, instead of a refusal after.
//   · ABSENT — the row is not part of this viewer's world at all. Three cases,
//     each narrow: a DECEASED animal keeps only Compartir, Editar datos, Foto and
//     Contactos (PO decision; every other row is a write with nothing left to
//     act on); an ORGANIZATION MEMBER gets Compartir and acts from the org
//     portal, as on both platforms before this file; and the assistance-dog row
//     exists for DOGS only (a cat's owner is not "refused" a dog credential).
//     A group left with no rows is dropped rather than drawn as a heading over
//     nothing.
//
// A SECTION THAT DID NOT LOAD TAKES NOTHING AWAY — `null` in the context means
// "no fact", never "not active" or "not a dog". The server's refusal still
// stands behind every row, so the permissive direction is the safe one; an
// outage must not remove a control (the rule `ownerFaceGates` founded).
// The ONE exception is the attestation door, below, and it says why.
//
// THE DANGEROUS-BREED ATTESTATION IS NOT A ROW. It stays on the compliance card
// (PO decision), and `attestationDoor` is reported here only so both platforms
// gate that door from the same facts as everything else.

import type { OwnerPetDetailViewerRole } from "../api/owner-pet-detail.ts";
import type { PublicPetStatus } from "../api/public-credential.ts";
import type { PetProfileIconName } from "../icons/pet-profile-icons.ts";

/** Every action the owner's pet panel can offer, on either platform. */
export const PET_ACTION_IDS = [
  "record",
  "share",
  "lost",
  "edit",
  "photo",
  "contacts",
  "service_dog",
  "physical_tag",
  "vaccine_reminders",
  "travel",
  "caretaker",
  "return",
  "find_home",
  "transfer",
  "death",
] as const;
export type PetActionId = (typeof PET_ACTION_IDS)[number];

/** The row directly under the credential, in order. */
export const PET_ACTION_PRIMARY_ROW: readonly PetActionId[] = ["record", "share", "lost"];

export const PET_ACTION_GROUP_IDS = ["pet", "health", "trips", "custody", "closing"] as const;
export type PetActionGroupId = (typeof PET_ACTION_GROUP_IDS)[number];

export type PetActionGroupDef = {
  id: PetActionGroupId;
  /**
   * Sentence case on purpose; a platform that draws an eyebrow uppercases it in
   * STYLE, so a screen reader reads a word rather than spelling out capitals.
   * `null` for the closing group, which is drawn as a separator: the one act in
   * it closes the record, and a heading would make it read as a category.
   */
  heading: string | null;
  actions: readonly PetActionId[];
};

/** The panel below the primary row, top to bottom. */
export const PET_ACTION_GROUPS: readonly PetActionGroupDef[] = [
  {
    id: "pet",
    heading: "La mascota",
    actions: ["edit", "photo", "contacts", "service_dog", "physical_tag"],
  },
  { id: "health", heading: "Salud", actions: ["vaccine_reminders"] },
  { id: "trips", heading: "Viajes", actions: ["travel"] },
  { id: "custody", heading: "Custodia", actions: ["caretaker", "return", "find_home", "transfer"] },
  // LAST, with nothing under it: a terminal act beside "Foto" reads as one more
  // option; at the bottom, after everything else, it reads as what it is.
  { id: "closing", heading: null, actions: ["death"] },
];

export type PetActionCopy = {
  label: string;
  /** What the row does, for a screen reader (and a tooltip, where one exists). */
  hint: string;
};

/**
 * Label and hint per action. The labels are the ones the PO validated on the
 * mockup; where the two platforms disagreed, the app's wording won when it named
 * the act the person performs ("Transferir la titularidad", not "Transferir
 * mascota") and the web's when the app's was a container ("Modo perdida" stays:
 * it is the cockpit for BOTH directions, marking lost and marking found).
 */
export const PET_ACTION_COPY: Readonly<Record<PetActionId, PetActionCopy>> = {
  record: { label: "Anotar", hint: "Anotar un evento en la libreta." },
  share: {
    label: "Compartir",
    hint: "Crear o revocar links de la libreta, y mostrarla en la credencial pública.",
  },
  lost: {
    label: "Modo perdida",
    hint: "Marcar la mascota como perdida, seguir la búsqueda o marcarla encontrada.",
  },
  edit: {
    label: "Editar datos",
    hint: "Cambiar la identidad, la salud, el seguro y el origen de la mascota.",
  },
  photo: { label: "Foto", hint: "Elegir la foto que muestra la credencial." },
  contacts: {
    label: "Contactos de emergencia",
    hint: "El veterinario y la persona a la que llamamos por esta mascota.",
  },
  service_dog: {
    label: "Perro de asistencia",
    hint: "Registrar o gestionar la credencial de perro de asistencia (Ley 26.858).",
  },
  physical_tag: {
    label: "Chapa física",
    hint: "Anotar interés en una chapita física con el QR de tu mascota.",
  },
  vaccine_reminders: {
    label: "Recordatorios de vacunas",
    hint: "Programar un recordatorio de vacuna, o eliminar uno que ya no hace falta.",
  },
  travel: {
    label: "Viaje y movilidad",
    hint: "Registrar un viaje, cargar el CVI y ver qué pide el destino.",
  },
  caretaker: {
    label: "Cuidador temporal",
    hint: "Dejarle la mascota a alguien de confianza por un tiempo, o terminar un cuidado en curso.",
  },
  return: {
    label: "Devolución",
    hint: "Responder a quien quiere devolverte la mascota, o proponer devolvérsela a la organización que te la dio.",
  },
  find_home: {
    label: "Acompañamiento de adopción",
    hint: "Pedirle a una organización verificada que acompañe la adopción, cancelar el pedido, o dar de baja el acompañamiento.",
  },
  transfer: {
    label: "Transferir la titularidad",
    hint: "Ofrecerle esta mascota a otra persona. No cambia nada hasta que acepte.",
  },
  death: {
    label: "Reportar fallecimiento",
    hint: "Asentar el fallecimiento. Se cierra el registro del animal y después solo se pueden agregar notas.",
  },
};

/**
 * The FOSTER's wording of `find_home`. One destination, two asks: the titular
 * asks an organization to accompany an adoption, the foster tells one the
 * animal in transit needs a permanent home (`buscar-hogar/page.tsx` serves
 * both, and only these two).
 */
export const FOSTER_FIND_HOME_COPY: PetActionCopy = {
  label: "Buscar hogar",
  hint: "Avisarle a una organización verificada que la mascota necesita un hogar definitivo.",
};

/** A standing line under a LIVE row's label — what it does, before the tap. */
const PET_ACTION_NOTES: Partial<Record<PetActionId, string>> = {
  death: "Cierra el registro del animal",
};

/** The primary row's glyphs, in the shared icon vocabulary. */
const PET_ACTION_ICONS: Partial<Record<PetActionId, PetProfileIconName>> = {
  record: "libreta",
  share: "share",
  lost: "alert-triangle",
};

export const PET_ACTION_INERT_REASONS = [
  "titular_only",
  "not_active",
  "caretaker",
  "web_only",
] as const;
export type PetActionInertReason = (typeof PET_ACTION_INERT_REASONS)[number];

/**
 * The line under a grey row. Kept apart per reason because the moves differ: a
 * co-owner has to ask the titular, a titular whose animal is lost has to find
 * it first, and a caretaker is holding someone else's animal.
 *
 * `web_only` is never produced by `derivePetActions`, which knows nothing about
 * platforms: it is the caption a platform uses for a destination it does not
 * have yet (the app's foster "Buscar hogar"), kept here so that copy has one
 * home like every other line on the panel.
 */
export const PET_ACTION_INERT_CAPTIONS: Readonly<Record<PetActionInertReason, string>> = {
  titular_only: "Solo el titular",
  not_active: "No se puede en esta situación",
  caretaker: "No disponible para cuidadores",
  web_only: "Se hace desde la web",
};

/**
 * What the panel is derived from. `null` means the section did not load and is
 * read as "no fact" — see the header.
 */
export type PetActionContext = {
  viewerRole: OwnerPetDetailViewerRole;
  /** The contract's own flag: `role === "owner"`, and a co-owner is NOT one. */
  isTitular: boolean;
  petStatus: PublicPetStatus | null;
  species: string | null;
  /**
   * Whether the dangerous-breed regime applies to this animal — the owner
   * detail's `pppRegistries.data !== null`. `null` when that section did not
   * load, and here an unread fact CLOSES the door rather than opening it: the
   * regime applies to a small minority of dogs, and offering its form on an
   * outage would put it in front of almost every owner.
   */
  pppDoor: boolean | null;
};

export type PetActionState = { kind: "live" } | { kind: "inert"; reason: PetActionInertReason };

export type DerivedPetAction = {
  id: PetActionId;
  label: string;
  hint: string;
  /**
   * The short line under the label: the reason when the row is inert, the
   * standing note when it is live and has one ("Cierra el registro del
   * animal"), otherwise `null`.
   */
  caption: string | null;
  /** The primary row's glyph; `null` for the rows of the groups. */
  icon: PetProfileIconName | null;
  tone: "default" | "danger";
  state: PetActionState;
};

export type DerivedPetActionGroup = {
  id: PetActionGroupId;
  heading: string | null;
  actions: DerivedPetAction[];
};

export type DerivedPetActions = {
  primary: DerivedPetAction[];
  /** Only the groups with at least one row, in panel order. */
  groups: DerivedPetActionGroup[];
  /** The compliance card's "Registrar atestación" door. Never a panel row. */
  attestationDoor: boolean;
};

/** What every rule reads, computed once from the context. */
type Facts = {
  /** Any holder on the person path — every viewer but an organization member. */
  person: boolean;
  /** KNOWN to be fallecida. False while the status is unread. */
  deceased: boolean;
  /** KNOWN to be lost or deceased. False while the status is unread. */
  notActive: boolean;
  isTitular: boolean;
  role: OwnerPetDetailViewerRole;
  /** Known to be a species other than a dog. False while the species is unread. */
  knownNotDog: boolean;
};

const LIVE: PetActionState = { kind: "live" };

function inert(reason: PetActionInertReason): PetActionState {
  return { kind: "inert", reason };
}

/** `null` = the row is absent for this viewer. */
type Rule = (facts: Facts) => PetActionState | null;

/** Present on the person path while the animal is alive; live for every holder. */
const personWhileAlive: Rule = (f) => (f.person && !f.deceased ? LIVE : null);

/** Titular-only and active-only, inert otherwise: transfer and the caretaker grant. */
const titularWhileActive: Rule = (f) => {
  if (!f.person || f.deceased) return null;
  if (!f.isTitular) return inert("titular_only");
  if (f.notActive) return inert("not_active");
  return LIVE;
};

/**
 * Who travels with the family's trips: owner, co-owner and foster — the
 * server's `TRAVEL_TITULAR_ROLES`. A caretaker is often the person keeping the
 * animal while the family is away, and the trip is not theirs to read.
 */
const TRAVEL_ROLES: readonly OwnerPetDetailViewerRole[] = ["owner", "co_owner", "foster"];

const RULES: Readonly<Record<PetActionId, Rule>> = {
  record: personWhileAlive,
  share: () => LIVE,
  // Kept on a LOST animal: the row is the cockpit for both directions.
  lost: personWhileAlive,
  // `requireTitularAccess` denies a caretaker and nobody else on this path.
  edit: (f) => {
    if (!f.person) return null;
    return f.role === "caretaker" ? inert("caretaker") : LIVE;
  },
  // Any holder: `titular-only.ts` lists photos among what a caretaker MAY do.
  photo: (f) => (f.person ? LIVE : null),
  // The titular's own vet and person to call: the writer joins `role = 'owner'`.
  contacts: (f) => {
    if (!f.person) return null;
    return f.isTitular ? LIVE : inert("titular_only");
  },
  service_dog: (f) => {
    if (!f.person || f.deceased || f.knownNotDog) return null;
    return f.isTitular ? LIVE : inert("titular_only");
  },
  physical_tag: personWhileAlive,
  vaccine_reminders: personWhileAlive,
  travel: (f) => {
    if (!f.person || f.deceased) return null;
    return TRAVEL_ROLES.includes(f.role) ? LIVE : inert("caretaker");
  },
  caretaker: titularWhileActive,
  // Every person-path holder: the page answers each state itself.
  return: personWhileAlive,
  // Two audiences for one page: the foster's ask and the titular's.
  find_home: (f) => {
    if (!f.person || f.deceased) return null;
    if (f.role === "foster" || f.isTitular) return LIVE;
    return inert("titular_only");
  },
  transfer: titularWhileActive,
  // Allowed to a caretaker (`titular-only.ts`); a second death is a 409.
  death: personWhileAlive,
};

function factsOf(ctx: PetActionContext): Facts {
  return {
    person: ctx.viewerRole !== "org_member",
    deceased: ctx.petStatus === "deceased",
    notActive: ctx.petStatus !== null && ctx.petStatus !== "active",
    isTitular: ctx.isTitular,
    role: ctx.viewerRole,
    knownNotDog: ctx.species !== null && ctx.species !== "dog",
  };
}

function copyFor(id: PetActionId, facts: Facts): PetActionCopy {
  if (id === "find_home" && facts.role === "foster") return FOSTER_FIND_HOME_COPY;
  return PET_ACTION_COPY[id];
}

function deriveOne(id: PetActionId, facts: Facts): DerivedPetAction | null {
  const state = RULES[id](facts);
  if (state === null) return null;
  const copy = copyFor(id, facts);
  return {
    id,
    label: copy.label,
    hint: copy.hint,
    caption:
      state.kind === "inert"
        ? PET_ACTION_INERT_CAPTIONS[state.reason]
        : (PET_ACTION_NOTES[id] ?? null),
    icon: PET_ACTION_ICONS[id] ?? null,
    tone: id === "lost" ? "danger" : "default",
    state,
  };
}

function deriveAll(ids: readonly PetActionId[], facts: Facts): DerivedPetAction[] {
  const out: DerivedPetAction[] = [];
  for (const id of ids) {
    const action = deriveOne(id, facts);
    if (action !== null) out.push(action);
  }
  return out;
}

/** The whole panel for one viewer and one animal. Pure. */
export function derivePetActions(ctx: PetActionContext): DerivedPetActions {
  const facts = factsOf(ctx);
  const groups: DerivedPetActionGroup[] = [];
  for (const group of PET_ACTION_GROUPS) {
    const actions = deriveAll(group.actions, facts);
    if (actions.length > 0) groups.push({ id: group.id, heading: group.heading, actions });
  }
  return {
    primary: deriveAll(PET_ACTION_PRIMARY_ROW, facts),
    groups,
    attestationDoor: !facts.deceased && ctx.pppDoor === true,
  };
}

/** One action of a derived panel, wherever it sits, or `null` when absent. */
export function findPetAction(
  derived: DerivedPetActions,
  id: PetActionId,
): DerivedPetAction | null {
  for (const action of derived.primary) if (action.id === id) return action;
  for (const group of derived.groups) {
    for (const action of group.actions) if (action.id === id) return action;
  }
  return null;
}
