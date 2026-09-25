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
