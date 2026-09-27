// Spanish labels for authority-unit kinds and levels (localidades-por-id C4).

const KIND_LABELS: Record<string, string> = {
  provincia: "Provincia",
  region: "Región",
  municipio: "Municipio",
  ciudad: "Ciudad",
  comuna: "Comuna",
  departamento: "Departamento (propuesta del INDEC)",
};

const LEVEL_LABELS: Record<string, string> = {
  provincial: "provincial",
  regional: "regional",
  municipal: "municipal",
  submunicipal: "submunicipal",
};

export function unitKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function unitLevelLabel(level: string): string {
  return LEVEL_LABELS[level] ?? level;
}

// A unit editor's change-log rows (the audit actions loadAuthorityUnitDetail
// reads back), in Spanish.
const CHANGE_LABELS: Record<string, string> = {
  authority_unit_created: "Unidad creada",
  authority_unit_renamed: "Unidad renombrada",
  authority_unit_confirmed: "Unidad confirmada",
  authority_unit_membership_moved: "Localidad sumada",
  authority_unit_membership_removed: "Localidad quitada",
  govt_assignment_unit_confirmed: "Concesión de gobierno pasada a la unidad",
  // jurisdiction-admin: the platform admin's reversals.
  authority_unit_unconfirmed: "Unidad vuelta a borrador",
  govt_assignment_unit_unconfirmed: "Concesión de gobierno sacada de la unidad",
};

/**
 * The label of one change of unit `unitId`. A membership move is read from
 * both ends: it added a locality to the unit it went to, and took one from
 * the unit it left (`afterUnitId` is where it went).
 */
export function unitChangeLabel(action: string, afterUnitId: unknown, unitId: string): string {
  if (action === "authority_unit_membership_moved" && afterUnitId !== unitId) {
    return "Localidad movida a otra unidad";
  }
  return CHANGE_LABELS[action] ?? action;
}
