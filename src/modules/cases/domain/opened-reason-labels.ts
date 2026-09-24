// opened-reason-labels — raw enum → es-AR vocabularies for case open reasons.
//
// Shared by BOTH render paths, which is why they live here rather than in
// either one:
//   - opened-reason-legacy.ts  (frozen regex layer, pre-cutover prose rows)
//   - opened-reason-render.ts  (structured code + params, post-cutover rows)
//
// A legacy row and a structured row describing the same fact must read
// identically to a funcionario — one vocabulary is how that stays true.
//
// Each map is annotated with the module that owns the raw vocabulary. When a
// source enum grows a value, this file is the one place to translate it.

// WELFARE_KINDS in src/modules/welfare/actions.ts
export const WELFARE_KIND_LABEL: Record<string, string> = {
  abandonment: "abandono",
  neglect: "negligencia",
  physical_abuse: "maltrato físico",
  chained: "animal encadenado",
  no_shelter: "sin refugio",
  hoarding: "acumulación de animales",
  dog_fighting: "peleas de perros",
  trafficking: "tráfico de animales",
  other: "otro",
};

// WELFARE_SEVERITIES in src/modules/welfare/actions.ts
export const WELFARE_SEVERITY_LABEL: Record<string, string> = {
  low: "baja",
  medium: "media",
  high: "alta",
  critical: "crítica",
};

// victimKind / severity in src/modules/surveillance/application/report-bite.ts
export const BITE_VICTIM_LABEL: Record<string, string> = {
  human: "persona",
  animal: "animal",
  unknown: "sin determinar",
};

export const BITE_SEVERITY_LABEL: Record<string, string> = {
  minor: "leve",
  moderate: "moderada",
  severe: "grave",
};

// orgTypeToReporterRole in src/modules/surveillance/domain/bite.ts.
//
// `witness` was missing here until 2026-07-16 while being the FUNCTION'S
// DEFAULT — every org type outside the clinic/shelter/sanitary buckets maps to
// it — so an org-reported bite from, say, a municipality rendered
// "Mordedura reportada por X (witness)". Same leak shape as the
// custody-handoff bug, one map entry away. Kept in this shared file so the
// legacy regex path is fixed by the same line.
export const REPORTER_ROLE_LABEL: Record<string, string> = {
  vet: "veterinaria",
  shelter: "refugio",
  govt: "autoridad sanitaria",
  witness: "testigo",
};

// SeizureMotive in src/modules/decomiso/domain/types.ts
export const SEIZURE_MOTIVE_LABEL: Record<string, string> = {
  maltrato_fisico: "maltrato físico",
  abandono_extremo: "abandono extremo",
  acumulacion: "acumulación",
  trafico: "tráfico",
  sin_refugio_critico: "sin refugio (crítico)",
  pelea_de_perros: "pelea de perros",
  otro: "otro",
};

// CROSS_ORG_ALLOWED_REASONS in src/modules/transfers/domain/types.ts
export const TRANSFER_REASON_LABEL: Record<string, string> = {
  space_constraint: "falta de espacio",
  specialization_needed: "se requiere especialización",
  network_redistribution: "redistribución en la red",
  shelter_closing: "cierre del refugio",
  post_adoption_failed_return: "devolución posterior a una adopción",
  other: "otro",
};

// resolveNewRole in src/modules/transfers/application/transfer-custody.ts.
// Same wording that file's own notification copy uses (transfer-custody.ts:202)
// so the case reason and the notification tell the handoff the same way.
export const CUSTODY_HANDOFF_ROLE_LABEL: Record<string, string> = {
  shelter_custody: "custodia temporal",
  owner: "dueño permanente",
};

// INTAKE_REASONS in src/modules/pets/application/intake/create-intake.ts
export const INTAKE_REASON_LABEL: Record<string, string> = {
  rescue: "rescate",
  surrender: "entrega voluntaria",
  stray_found: "animal callejero encontrado",
  other: "otro",
};

// ADMIN_REASONS in src/modules/pets/application/microchip/replace-microchip.ts
export const CHIP_REASON_LABEL: Record<string, string> = {
  damaged: "chip dañado",
  unreadable: "chip ilegible",
  owner_request: "pedido del dueño",
  device_failure: "falla del dispositivo",
  duplicate_detected: "duplicado detectado",
  fraud_detected: "fraude detectado",
  other: "otro",
};

// raised_by_role in the custody_disputes table (db/schema.ts). The DB CHECK is
// the authoritative closed set (4 values).
export const DISPUTE_RAISED_BY_ROLE_LABEL: Record<string, string> = {
  owner: "el dueño",
  org: "una organización",
  govt: "una autoridad",
  admin: "la administración",
};

/** Translate a raw enum value; unknown values pass through unchanged. */
export function label(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}
