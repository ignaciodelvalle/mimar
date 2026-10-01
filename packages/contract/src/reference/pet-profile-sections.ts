// The sections of "Editar datos", in the order BOTH platforms show them
// (owner-pet-actions, PO 2026-10-01: "Editar datos" split into sections, each
// with its own Guardar, and "the web gets the same order").
//
// One list for the same reason the action catalogue is one list: the app's
// edit screen and the web's form are two drawings of one record, and two
// hand-kept copies of their order and titles are how they come to disagree.
//
// `id` is the `seccion` a link lands on (`?sheet=editar-mascota&seccion=…` on
// the web, `editPetRoute(token, { seccion })` in the app). `saveLabel` is the
// section's own button, named after what it saves (AGENTS.md: never a bare
// "Guardar"); `null` for Contactos, which is a door to its own screen rather
// than fields of this form.

export const PET_PROFILE_EDIT_SECTION_IDS = [
  "identidad",
  "salud",
  "contactos",
  "credencial-publica",
  "seguro",
  "origen",
] as const;
export type PetProfileEditSectionId = (typeof PET_PROFILE_EDIT_SECTION_IDS)[number];

export type PetProfileEditSection = {
  id: PetProfileEditSectionId;
  title: string;
  saveLabel: string | null;
};

export const PET_PROFILE_EDIT_SECTIONS: readonly PetProfileEditSection[] = [
  { id: "identidad", title: "Identidad", saveLabel: "Guardar identidad" },
  { id: "salud", title: "Salud y cuidados", saveLabel: "Guardar salud y cuidados" },
  { id: "contactos", title: "Contactos", saveLabel: null },
  {
    id: "credencial-publica",
    title: "Qué muestra la credencial pública",
    saveLabel: "Guardar lo que se muestra",
  },
  { id: "seguro", title: "Seguro", saveLabel: "Guardar seguro" },
  { id: "origen", title: "Origen", saveLabel: "Guardar origen" },
];

/** A section by id, for a screen that draws one at a time. */
export function petProfileEditSection(id: PetProfileEditSectionId): PetProfileEditSection {
  const section = PET_PROFILE_EDIT_SECTIONS.find((s) => s.id === id);
  if (!section) throw new Error(`unknown Editar datos section: ${id}`);
  return section;
}
