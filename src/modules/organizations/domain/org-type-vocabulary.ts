// How each kind of organization is spoken to (portal-vet-p0 D13).
//
// The words follow the ONE org-type rule (./org-type): a rehoming org (refugio,
// red de rescate) keeps exactly the copy it always had — byte for byte, pinned
// by its regression test — and every other org type stops being addressed as a
// shelter: a clinic's animals are "Pacientes" (PO decision 2026-09-30), its
// inbox receives consultations, not volunteer offers, and it is an
// "organización de origen", not a "refugio de origen".
//
// Pure strings, no imports beyond the rule: a "use client" form reads it.

import { isRehomingOrgType } from "./org-type";

export type OrgVocabulary = {
  /** Heading and breadcrumb of the org's animal list (`/org/[orgToken]/mascotas`). */
  heldPetsTitle: string;
  /** Lead of the Mensajes intro, followed by " {org name}." on screen. */
  messagesIntroLead: string;
  /** Mensajes empty state. */
  messagesEmptyDescription: string;
  /** The settings toggle that names the org on the public credential. */
  originOrgToggleLabel: string;
  originOrgToggleHint: string;
};

const REHOMING_VOCABULARY: OrgVocabulary = {
  heldPetsTitle: "Mascotas en custodia",
  messagesIntroLead:
    "Consultas y ofrecimientos de voluntariado que llegaron desde el perfil público de",
  messagesEmptyDescription:
    "Cuando alguien escriba desde el perfil público o se ofrezca como voluntario/a, va a aparecer acá.",
  originOrgToggleLabel:
    "Mostrar a mi organización como refugio de origen en la credencial pública de las mascotas",
  originOrgToggleHint:
    "Cuando está activo, la credencial pública muestra el nombre de tu organización como refugio de origen de la mascota.",
};

const CLINICAL_VOCABULARY: OrgVocabulary = {
  heldPetsTitle: "Pacientes",
  messagesIntroLead: "Consultas que llegaron desde el perfil público de",
  messagesEmptyDescription: "Cuando alguien escriba desde el perfil público, va a aparecer acá.",
  originOrgToggleLabel:
    "Mostrar a mi organización como organización de origen en la credencial pública de las mascotas",
  originOrgToggleHint:
    "Cuando está activo, la credencial pública muestra el nombre de tu organización como organización de origen de la mascota.",
};

/** The copy an organization of this type is addressed with. */
export function orgVocabulary(orgType: string): OrgVocabulary {
  if (isRehomingOrgType(orgType)) return REHOMING_VOCABULARY;
  // "Pacientes" is a clinic's word (PO). A sanitary authority or an "other"
  // org is not a shelter either, but its animals are not patients.
  if (orgType === "clinic") return CLINICAL_VOCABULARY;
  return { ...CLINICAL_VOCABULARY, heldPetsTitle: "Mascotas a cargo" };
}
