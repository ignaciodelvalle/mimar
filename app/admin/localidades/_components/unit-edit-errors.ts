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
};

export function unitEditErrorMessage(error: string): string {
  if (error.startsWith("VALIDATION_ERROR: ")) return error.slice("VALIDATION_ERROR: ".length);
  return MESSAGES[error] ?? "No se pudo guardar el cambio. Probá de nuevo.";
}
