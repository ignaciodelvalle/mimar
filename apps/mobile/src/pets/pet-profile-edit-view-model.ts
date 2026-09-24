// Editar — turning the server's answer into what a person reads, and what they
// typed into what the contract accepts.
//
// PURE, like every other view-model in this app. It owns the es-AR sentence for
// every state and every refusal, and the mapping from a draft to a
// `PetProfileCommandInput`. Nothing here touches the network.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported and not re-stated — the
// rule `shares-view-model.ts` and `lost-view-model.ts` both follow. What lives
// here is the WORDS: the contract carries codes, the consumer owns its copy.
//
// THE CAPABILITIES ARE THE SERVER'S TOO, AND THIS FILE NEVER RECOMPUTES THEM.
// `payload.capabilities` carries TWO booleans because the two halves of this
// screen answer to two different rules — identity is every holder except a
// caretaker, the contacts are the legal owner alone. A screen that derived
// either from "this pet is mine" would show a foster in transit the titular's
// own vet and phone number, which is exactly the fix the web made in its M2
// review and exactly what this app must not undo.

import type { PetProfileEditV1 } from "@dim/contract/api";
import type {
  PetProfileCommandInput,
  PetProfileCommandInputCode,
  PetSpecies,
  StoredPetIdentityText,
} from "@dim/contract/input";
import {
  EMERGENCY_CONTACT_NAME_MAX,
  EMERGENCY_CONTACT_PHONE_MAX,
  PET_COLOR_MAX,
  PET_NAME_MAX,
  PET_SPECIES,
  firstPetProfileCommandInputCode,
  petIdentityFieldCap,
  petProfileCommandInputSchema,
  resolvePetIdentityLengths,
} from "@dim/contract/input";
import { breedsForSpecies } from "@dim/contract/reference";

/** The identity form's fields, as strings — what a `TextInput` actually holds. */
export type IdentityDraft = {
  name: string;
  breed: string;
  color: string;
};

/** The contacts form's fields. Empty means "clear the override". */
export type EmergencyDraft = {
  preferredVetName: string;
  preferredVetPhone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
};

/**
 * The caps the CONTACTS form puts on its own inputs, from the contract.
 *
 * The two identity fields are not here: their cap depends on what the animal
 * already holds — see `identityFieldCaps`.
 */
export const FIELD_LIMITS = {
  contactName: EMERGENCY_CONTACT_NAME_MAX,
  contactPhone: EMERGENCY_CONTACT_PHONE_MAX,
} as const;

/**
 * The `maxLength` the two identity inputs may carry for THIS animal.
 *
 * A FIXED CAP HERE SILENTLY EDITS THE PET. `TextInput` truncates the value it is
 * handed, so an animal whose stored name is longer than `PET_NAME_MAX` would
 * arrive on screen already shortened and the next "Guardar datos" would write
 * the shortened name — a correction nobody asked for, to the field the
 * credential is read by. `petIdentityFieldCap` raises the cap to whatever is
 * stored, which is the same grandfather `resolvePetIdentityLengths` grants the
 * value on the way back.
 */
export function identityFieldCaps(payload: PetProfileEditV1): { name: number; color: number } {
  return {
    name: petIdentityFieldCap(PET_NAME_MAX, payload.identity.name),
    color: petIdentityFieldCap(PET_COLOR_MAX, payload.identity.color),
  };
}

/** The server's current values, as the form should start. */
export function identityDraftFrom(payload: PetProfileEditV1): IdentityDraft {
  return {
    name: payload.identity.name,
    breed: payload.identity.breed ?? "",
    color: payload.identity.color ?? "",
  };
}

/**
 * The contacts form's starting values, or `null` when this caller may not have
 * them.
 *
 * `null` IS NOT AN EMPTY DRAFT and the difference is the whole point: the server
 * sends `emergencyContacts: null` for anybody but the legal owner, and a screen
 * that turned that into four blank inputs would be offering a form whose save
 * can only be refused.
 */
export function emergencyDraftFrom(payload: PetProfileEditV1): EmergencyDraft | null {
  if (payload.emergencyContacts === null) return null;
  return { ...payload.emergencyContacts };
}

/**
 * The breed options to offer: the species catalog, plus the animal's CURRENT
 * stored breed when the catalog does not contain it.
 *
 * THE APPENDED VALUE IS THE PARITY BIT, not a nicety. `resolveBreedForWrite`
 * grandfathers a stored off-catalog breed so a legacy value survives an
 * unrelated edit (QA A5), and the web's edit form appends it as its own
 * `<option>` for exactly that reason. Without this, a picker that only ever
 * offered the catalog would leave the owner of a pet recorded as something the
 * catalog no longer lists with two choices — pick a different breed, or leave —
 * and the "leave" one is the one that silently wipes the value the moment they
 * correct the name.
 */
export function breedChoicesFor(species: string, storedBreed: string | null): string[] {
  const catalog = breedsForSpecies(species);
  const stored = storedBreed?.trim() ?? "";
  if (stored.length === 0 || catalog.includes(stored)) return catalog;
  return [stored, ...catalog];
}

/** Why the identity form is not offered, or `null` when it is. */
export function identityBlockedReason(payload: PetProfileEditV1): string | null {
  if (payload.capabilities.canEditIdentity) return null;
  // The one refusal behind this flag today: a caretaker. The sentence names the
  // ARRANGEMENT rather than the permission, because "no tenés permiso" over an
  // animal somebody is genuinely looking after reads as a bug.
  return "Sos cuidador/a de esta mascota. Editar sus datos es solo del titular.";
}

/**
 * The species chip the correction card starts on: the animal's own, when this
 * build knows it — `null` for a species the contract's list does not carry, so
 * the picker shows nothing selected rather than a chip that is not the animal.
 */
export function speciesDraftFrom(payload: PetProfileEditV1): PetSpecies | null {
  const stored = payload.species.trim();
  return (PET_SPECIES as readonly string[]).includes(stored) ? (stored as PetSpecies) : null;
}

/** Why the species correction is not offered, or `null` when it is. */
export function speciesBlockedReason(payload: PetProfileEditV1): string | null {
  if (payload.capabilities.canCorrectSpecies) return null;
  // The same refusal as the identity form — a caretaker — said about THIS act,
  // because the web's own `NotTitularNotice` names what was asked for. NOT the
  // identity sentence's "es solo del titular" wording: the two cards can be
  // blocked on one screen at once, and two sentences a test cannot tell apart
  // are two sentences a person reads as one.
  return "Sos cuidador/a de esta mascota. La especie la corrige el titular.";
}

/** Why the contacts form is not offered, or `null` when it is. */
export function contactsBlockedReason(payload: PetProfileEditV1): string | null {
  if (payload.capabilities.canEditEmergencyContacts) return null;
  // NOT the same sentence as above, and not "solo el titular" either: a co-owner
  // and a foster both reach this, and both ARE holders. What they are not is the
  // person whose phone number this is.
  return "Estos son el veterinario y el contacto de quien figura como dueño/a. Solo esa persona puede cambiarlos.";
}

/**
 * What a person will see if they clear a field — the account-level default, or
 * an honest "nada".
 *
 * The pair (name + phone) falls back TOGETHER, never mixed across levels: that
 * is `lib/domain/emergency-contacts.ts`, the server's one implementation, and
 * this function reports its inputs rather than re-deriving its rule. It answers
 * per PAIR for the same reason.
 */
export function accountFallbackLabel(payload: PetProfileEditV1, pair: "vet" | "emergency"): string {
  const fallback = payload.emergencyAccountDefault;
  if (fallback === null) return "";
  const name = pair === "vet" ? fallback.preferredVetName : fallback.emergencyContactName;
  const phone = pair === "vet" ? fallback.preferredVetPhone : fallback.emergencyContactPhone;
  const parts = [name, phone].filter((v): v is string => v !== null && v.trim().length > 0);
  if (parts.length === 0) {
    return "Si dejás los dos campos vacíos no se muestra nada: tu cuenta tampoco tiene uno cargado.";
  }
  return `Si dejás los dos campos vacíos mostramos el de tu cuenta: ${parts.join(" · ")}.`;
}

export type CommandResult =
  | { ok: true; input: PetProfileCommandInput }
  | { ok: false; message: string; code: PetProfileCommandInputCode | null };

function validated(wire: unknown): CommandResult {
  const parsed = petProfileCommandInputSchema.safeParse(wire);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstPetProfileCommandInputCode(parsed.error);
  return { ok: false, code, message: petProfileInputCodeMessage(code) };
}

/**
 * EDITAR LOS DATOS.
 *
 * An empty `breed` or `color` travels as `null`, which CLEARS the field — the
 * contract's own semantics, and the reason the two are required keys rather
 * than optional ones. A person who empties the colour box means to empty it.
 *
 * IT TAKES THE STORED VALUES because the length rule needs them. The cap gates
 * NEW text only: an animal already recorded with a name longer than
 * `PET_NAME_MAX` must still be able to have its COLOUR corrected, and this form
 * posts both fields on every save. Passing the payload's own `identity` is what
 * makes the local refusal agree with the server's, field for field — a screen
 * that refused what the endpoint would accept is the same bug as one that
 * offered what it would refuse.
 */
export function buildIdentityEdit(
  draft: IdentityDraft,
  stored: StoredPetIdentityText,
): CommandResult {
  const name = draft.name.trim();
  const color = draft.color.trim() || null;
  const lengths = resolvePetIdentityLengths({ name, color }, stored);
  if (!lengths.ok) {
    return { ok: false, code: lengths.code, message: petProfileInputCodeMessage(lengths.code) };
  }
  return validated({
    command: "edit_identity",
    name: draft.name,
    breed: draft.breed.trim() || null,
    color,
  });
}

/**
 * CORREGIR LA ESPECIE. Validated against the contract's own `PET_SPECIES`, so a
 * chip this build drew can never post a value the registry refuses.
 */
export function buildCorrectSpecies(species: PetSpecies | null): CommandResult {
  return validated({ command: "correct_species", species });
}

/** GUARDAR LOS CONTACTOS. All four fields travel every time; empty clears. */
export function buildEmergencyContacts(draft: EmergencyDraft): CommandResult {
  return validated({
    command: "set_emergency_contacts",
    preferredVetName: draft.preferredVetName,
    preferredVetPhone: draft.preferredVetPhone,
    emergencyContactName: draft.emergencyContactName,
    emergencyContactPhone: draft.emergencyContactPhone,
  });
}

/** es-AR copy for each input code. Exhaustive: every code has a sentence. */
export function petProfileInputCodeMessage(code: PetProfileCommandInputCode | null): string {
  if (code === null) {
    // The parse failed on something the contract does not name — a client and a
    // contract out of step. Honest about being unable to say more.
    return "Revisá los datos: hay un campo que la app no pudo interpretar.";
  }
  switch (code) {
    case "COMMAND_REQUIRED":
      return "La app no pudo armar la acción. Volvé a intentar.";
    case "NAME_REQUIRED":
      return "El nombre no puede quedar vacío.";
    case "NAME_INVALID":
      // NAMES WHAT IS WRONG WITHOUT NAMING THE CHARACTER. A person who pasted a
      // name with an invisible character in it cannot see the character, so
      // "sacá el U+200B" would be useless; "escribilo con letras" is the move
      // that works for every string this rule refuses.
      return "Ese nombre no se puede mostrar. Escribilo con letras.";
    case "NAME_TOO_LONG":
      return `El nombre es demasiado largo (máximo ${PET_NAME_MAX} caracteres).`;
    case "COLOR_TOO_LONG":
      return `El color es demasiado largo (máximo ${PET_COLOR_MAX} caracteres).`;
    case "CONTACT_NAME_TOO_LONG":
      return `Ese nombre es demasiado largo (máximo ${EMERGENCY_CONTACT_NAME_MAX} caracteres).`;
    case "CONTACT_PHONE_TOO_LONG":
      return `Ese teléfono es demasiado largo (máximo ${EMERGENCY_CONTACT_PHONE_MAX} caracteres).`;
    case "SPECIES_INVALID":
      // The web form's own sentence for the same refusal.
      return "Elegí una especie válida.";
  }
}

/**
 * What the screen says after a save landed.
 *
 * A NO-OP IS A SUCCESS and "listo" would be true but unhelpful. The server
 * measures `changed` against the values it already held, so a person who opened
 * the form, changed their mind and pressed Guardar gets told that nothing
 * needed saving rather than being congratulated on a write that did not happen.
 * The species no-op is the web form's own sentence — there, a refusal; here,
 * the same fact reported as the outcome of a tap.
 */
export function savedLabel(command: PetProfileCommandInput["command"], changed: boolean): string {
  switch (command) {
    case "edit_identity":
      return changed
        ? "Listo. El cambio queda registrado en la libreta."
        : "No había nada que cambiar: ya estaba así.";
    case "set_emergency_contacts":
      return changed
        ? "Listo. Guardamos los contactos de esta mascota."
        : "No había nada que cambiar: los contactos ya estaban así.";
    case "correct_species":
      return changed
        ? "Listo. La corrección queda registrada en la libreta."
        : "La especie es la misma; no hay nada que corregir.";
  }
}
