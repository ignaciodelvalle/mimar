// Synthetic (seed-tagged) pets are for demos and tests — never for real acts.
//
// WHY (security review 2026-09). `lib/metrics/scope.ts` treats a case or event
// as synthetic when its PET carries `seed_tag`, and the govt queues exclude
// synthetic rows. So a REAL neighbour who filed a denuncia on, reported, or
// adopted a seeded pet produced a real act that then vanished from the govt
// queue. The cure is on the other side of that exclusion: a seeded pet is
// never offered to the public (listings, counts, sitemap) and never accepts an
// anonymous write. Its credential page may stay reachable by direct token —
// demo links point at it — but nothing a stranger does there is recorded.
//
// Curated demo pets (the flagship) carry NO seed_tag and are real rows for this
// purpose; they stay visible and writable.
//
// PURE — imported by use-cases and actions alike.

/** es-AR refusal for an anonymous write against a seeded pet. Neutral on purpose. */
export const SYNTHETIC_PET_WRITE_REFUSED = "No es posible registrar esta acción para esta mascota.";

/**
 * Same boundary as `syntheticRowExclusion.pets` in lib/metrics/scope.ts
 * (`seed_tag IS NOT NULL`). Callers must SELECT the column; `undefined` (a row
 * that never read it) is treated as not seeded, matching SQL's view of a
 * column that is simply absent from the projection — it cannot be NULL-tested.
 */
export function isSyntheticPet(pet: { seedTag?: string | null }): boolean {
  return pet.seedTag !== null && pet.seedTag !== undefined;
}
