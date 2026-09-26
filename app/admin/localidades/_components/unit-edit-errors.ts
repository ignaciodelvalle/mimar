// What an admin reads when the unit editor refuses a change (localidades-por-id
// C4). Pure, so the copy is tested without a browser.

const MESSAGES: Record<string, string> = {
  CAPABILITY_DENIED: "Solo un administrador de la plataforma puede editar unidades.",
  NOT_FOUND: "No encontramos esa unidad o esa localidad.",
  PROVINCE_MISMATCH: "La localidad es de otra provincia que la unidad.",
  PROVINCIAL_UNIT_HAS_NO_MEMBERS:
    "La unidad provincial abarca toda la provincia: no se le suman localidades.",
  MUNICIPAL_MEMBERSHIP_MOVES_ONLY:
    "Una localidad no puede quedar sin municipio: movela a otra unidad desde esa unidad.",
  NOT_A_MEMBER: "Esa localidad ya no estaba en la unidad.",
  ALREADY_CONFIRMED: "La unidad ya estaba confirmada.",
  // localidades-por-id D2: confirming a govt user's grants onto a unit.
  NO_GRANTS:
    "Esa persona no tiene una concesión que pase a esta unidad: ninguna registra una localidad de la unidad.",
  WHOLE_PROVINCE_GRANT:
    "Una concesión de toda la provincia pasa a la unidad provincial, no a una parte de la provincia.",
  PARTIAL_GRANT:
    "La unidad suma localidades que la concesión no tenía. Marcá cada localidad que se suma para confirmarlo.",
  UNIT_NOT_CONFIRMED: "Confirmá la unidad con la autoridad antes de pasarle concesiones.",
  // localidades-por-id D9: the unresolved-place queue.
  NOT_UNRESOLVED: "Ese lugar ya se resolvió a una localidad. Recargá la lista.",
  // localidades-por-id E3: memberships of localities the INDEC removed.
  LOCALITY_NOT_REMOVED:
    "Esa localidad sigue en el catálogo: su pertenencia no se cierra, se mueve a otra unidad.",
};

export function unitEditErrorMessage(error: string): string {
  if (error.startsWith("VALIDATION_ERROR: ")) return error.slice("VALIDATION_ERROR: ".length);
  return MESSAGES[error] ?? "No se pudo guardar el cambio. Probá de nuevo.";
}
