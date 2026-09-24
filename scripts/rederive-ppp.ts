// Re-deriva `pets.potentially_dangerous_breed`. MUTA DATOS — leer las guardas.
//
// POR QUÉ
// -------
// `pets.potentially_dangerous_breed` es una CACHÉ de una decisión legal: se
// calcula al escribir la mascota y no se recalcula sola. Cuando cambia lo que
// alimenta esa decisión —la raza guardada, el matcher, o la lista PPP de una
// jurisdicción— la caché queda vieja y una mascota puede quedar fuera del
// régimen sin que nada lo diga.
//
// Pasó el 2026-08-13: `scripts/repair-breeds.ts` normalizó
// "Pit Bull Terrier Americano" a "American Pit Bull Terrier", y la fila siguió
// con el flag en false porque nadie la volvió a clasificar.
//
// El cron `business_rules_reeval` hace exactamente esto una vez por día. Este
// script existe para no esperarlo: mismo clasificador, misma composición de
// reglas por jurisdicción. NO reimplementa la lógica — la importa. Calcular el
// régimen a mano en un UPDATE es cómo se fabrica la próxima divergencia.
//
// GUARDAS
//   - Sin --apply es SIMULACRO.
//   - Contra un host no local exige --allow-remote.
//   - Imprime destino con ref antes de tocar nada.
//   - Sólo toca filas cuyo valor calculado DIFIERE del guardado.

import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db, pets } from "../db";
import { resolvePppClassificationForJurisdiction } from "../lib/infra/ppp-classification";
import { describeTarget, lines, remoteRemedy } from "./_db-target";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const allowRemote = process.argv.includes("--allow-remote");
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.error("ERROR: falta DATABASE_URL.");
    process.exit(2);
  }

  const target = describeTarget(url);
  console.log("");
  console.log(`  Destino: ${target.label}${target.isLocal ? "  [LOCAL]" : "  [REMOTO]"}`);
  console.log(`  Modo:    ${apply ? "APLICAR (escribe)" : "SIMULACRO (no escribe)"}`);
  console.log("");

  if (!target.isLocal && !allowRemote) {
    console.warn(
      lines(
        "[skip] rederive-ppp: DATABASE_URL apunta a un host no local.",
        "  No se tocó nada.",
        remoteRemedy("lee pets y —con --apply— actualiza potentially_dangerous_breed"),
      ),
    );
    process.exit(0);
  }

  // Sólo perros CON raza: el resto no puede ser PPP y no hay nada que decidir.
  const rows = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      species: pets.species,
      breed: pets.breed,
      weight: pets.estimatedWeightKg,
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
      country: pets.jurisdictionCountry,
      actual: pets.potentiallyDangerousBreed,
    })
    .from(pets)
    .where(and(eq(pets.species, "dog"), isNotNull(pets.breed)));

  console.log(`  ${rows.length} perro(s) con raza cargada.`);

  const cambios: Array<{ token: string; breed: string; de: boolean; a: boolean }> = [];
  for (const r of rows) {
    const esperado = await resolvePppClassificationForJurisdiction(
      r.species,
      r.breed,
      r.weight === null ? null : Number(r.weight),
      { country: r.country ?? "AR", province: r.province, locality: r.locality },
    );
    if (esperado !== r.actual) {
      cambios.push({ token: r.publicToken, breed: r.breed ?? "", de: r.actual, a: esperado });
    }
  }

  if (cambios.length === 0) {
    console.log("\n✓ La caché coincide con la clasificación. Nada que corregir.\n");
    process.exit(0);
  }

  console.log(`\n  DIFIEREN (${cambios.length}):`);
  for (const c of cambios) {
    console.log(`    ${c.token}  "${c.breed}"  ${c.de} → ${c.a}`);
  }

  if (!apply) {
    console.log("\n  SIMULACRO — no se escribió nada. Re-corré con --apply.\n");
    process.exit(0);
  }

  for (const c of cambios) {
    await db
      .update(pets)
      .set({ potentiallyDangerousBreed: c.a, updatedAt: sql`now()` })
      .where(eq(pets.publicToken, c.token));
  }
  console.log(`\n  Actualizadas ${cambios.length} fila(s).\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("rederive-ppp falló:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
