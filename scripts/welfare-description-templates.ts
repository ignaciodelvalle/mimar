// Shared welfare-report description templates — plan-maestro-integridad C5.
//
// Realistic citizen-report prose, per welfare kind. Used by:
//   - scripts/seed-panorama.ts     (generators — picks via the seeded rng())
//   - scripts/seed-demo-polish.ts  (repair — deterministic pick by row id,
//     so re-running the repair against an already-clean row is a no-op)
//
// Extracted to one file so both writers stay in lockstep — a repair whose
// prose looks different in kind/tone from what fresh seeding produces would
// itself be a "looks fake" tell.
//
// C5 audit finding: description used to carry the seed-correlation index
// directly ("PANO-welfare-00042 — denuncia sintética de demostración",
// "PANO-HIST-WEL-001243 denuncia histórica") — an internal id baked into
// text a funcionario reads as a real citizen's words. The index now lives in
// welfare_reports.seed_tag (migration 0155, never rendered); description
// reads like something a real reporter would actually write.
export const WELFARE_DESCRIPTION_TEMPLATES: Record<string, readonly string[]> = {
  abandonment: [
    "Vecinos vieron a una persona dejar al animal atado en la puerta de un local cerrado y se fue en auto.",
    "Encontramos al animal solo hace varios días en el mismo lugar, sin nadie que lo reclame.",
    "Lo abandonaron en un terreno baldío cerca de casa; nadie del barrio lo reconoce.",
  ],
  neglect: [
    "El animal está muy flaco y sin agua en el patio, hace calor y no tiene sombra.",
    "Se lo ve enfermo y sin atención hace tiempo; el dueño no lo lleva al veterinario.",
    "Vive en el balcón sin refugio, se escuchan quejidos seguido.",
  ],
  physical_abuse: [
    "Vimos al dueño pegarle varias veces frente a los vecinos.",
    "El animal tiene heridas visibles y cojea; sospechamos que lo golpean.",
    "Escuchamos gritos y golpes desde la casa de al lado, varias veces por semana.",
  ],
  chained: [
    "Está atado con una cadena corta hace meses, no puede moverse ni resguardarse.",
    "Lo mantienen encadenado todo el día en el fondo, sin sombra ni agua a la vista.",
  ],
  no_shelter: [
    "Duerme a la intemperie, no tiene ningún tipo de refugio contra la lluvia o el frío.",
    "Vive en el patio sin techo; con la última tormenta se mojó toda la noche.",
  ],
  hoarding: [
    "Hay muchos animales en el mismo departamento, huele muy fuerte y algunos se ven en mal estado.",
    "El vecino junta cada vez más animales en la casa; el consorcio recibió varias quejas por el olor.",
  ],
  dog_fighting: [
    "Sospechamos peleas organizadas de perros los fines de semana en un terreno cercano.",
    "Vimos varios perros con heridas compatibles con peleas y gente apostando dinero.",
  ],
  trafficking: [
    "Ofrecen cachorros de dudoso origen por redes sociales, sin ningún control sanitario.",
    "Sospechamos venta ilegal de animales silvestres en la feria del barrio.",
  ],
  other: [
    "Situación irregular con un animal en la cuadra; preferimos que un inspector la evalúe.",
    "Vecinos reportan una situación confusa que no encaja en las categorías habituales.",
  ],
};

/** FNV-1a 32-bit — deterministic, good enough spread for seed/repair data. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic template pick by a stable key (e.g. the row's id) — used by
 * the repair path so reruns are stable no-ops. */
export function pickWelfareDescriptionDeterministic(kind: string, stableKey: string): string {
  const templates = WELFARE_DESCRIPTION_TEMPLATES[kind] ?? WELFARE_DESCRIPTION_TEMPLATES.other;
  return templates[hashString(stableKey) % templates.length];
}
