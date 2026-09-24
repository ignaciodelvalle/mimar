// Normaliza `pets.breed` a los catálogos. MUTA DATOS — leer las guardas.
//
// POR QUÉ
// -------
// Hasta el 2026-08-13 la raza era texto libre. Medido en staging ese día: 69
// mascotas con raza cargada en 44 valores distintos, 34 usados una sola vez. Y
// una de esas filas era "Pit Bull Terrier Americano" SIN marcar como PPP,
// mientras un perro idéntico en otro barrio de la misma ciudad sí lo estaba,
// bajo la misma ley. Lo que decidía si un régimen legal te alcanza era la
// ortografía del dueño.
//
// El formulario ya pasó a catálogo. Esto arregla lo que quedó escrito antes.
//
// CÓMO DECIDE
// -----------
//   1. `resolveBreedLabel` — catálogos (perro, gato, especiales) + alias
//      coloquiales, comparando por clave normalizada.
//   2. Si el texto habla de una cruza ("mestizo", "mestiza", "cruza", "mix"),
//      va a "Mixto / Cruza". Esta regla va DESPUÉS de la 1 a propósito: un
//      "Mestizo Labrador" es una cruza, no un Labrador, y afirmar la raza pura
//      sería inventar un dato que nadie cargó.
//   3. Lo que no cae en ninguna se REPORTA y NO se toca. El script no adivina.
//
// Nada de esto reclasifica PPP por sí solo: eso lo hace el cron
// `business_rules_reeval`, que ya incluye un barrido AR por defecto. Igual
// conviene mirar el conteo de PPP antes y después — lo imprime.
//
// GUARDAS
//   - Sin --apply es SIMULACRO: imprime el plan y no escribe nada.
//   - Contra un host no local exige --allow-remote, igual que los fences.
//   - Imprime a qué base apunta ANTES de tocar nada (ref incluido: los dos
//     proyectos comparten pooler y el host solo no los distingue).

import postgres from "postgres";

import { ALL_BREEDS, resolveBreedLabel } from "../lib/reference/breeds";
import { DEFAULT_LOCAL_URL, describeTarget, lines, remoteRemedy } from "./_db-target";

const MIXED = "Mixto / Cruza";
const MIXED_HINTS = ["mestiz", "cruza", "mix"];

const CATALOG = new Set<string>(ALL_BREEDS);

/** El valor de catálogo que le corresponde a un texto, o null si no se sabe. */
export function decideBreed(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (CATALOG.has(trimmed)) return trimmed;

  const resolved = resolveBreedLabel(trimmed);
  const lower = trimmed.toLowerCase();
  const smellsMixed = MIXED_HINTS.some((h) => lower.includes(h));

  // Una cruza gana sobre el nombre de raza que la acompaña: "Mestizo Labrador"
  // es una cruza. Sólo si el texto NO habla de cruza se acepta la raza pura.
  if (smellsMixed) return MIXED;
  return resolved;
}

type Row = { breed: string; n: number };

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const allowRemote = process.argv.includes("--allow-remote");
  // Sin DATABASE_URL apunta al stack local, igual que los fences. Un script que
  // muta datos NO debería exigir una variable para su caso más inofensivo y
  // quedar cómodo sólo cuando alguien la exporta — así es como una consola con
  // la URL de staging pegada termina siendo el destino por descuido.
  const url = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
  const target = describeTarget(url);
  console.log("");
  console.log(`  Destino: ${target.label}${target.isLocal ? "  [LOCAL]" : "  [REMOTO]"}`);
  console.log(`  Modo:    ${apply ? "APLICAR (escribe)" : "SIMULACRO (no escribe)"}`);
  console.log("");

  if (!target.isLocal && !allowRemote) {
    console.warn(
      lines(
        "[skip] repair-breeds: DATABASE_URL apunta a un host no local.",
        "  No se tocó nada.",
        remoteRemedy("lee y —con --apply— actualiza pets.breed"),
      ),
    );
    process.exit(0);
  }

  const sql = postgres(url, { max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    const rows = (await sql`
      select breed, count(*)::int as n
      from pets
      where breed is not null and btrim(breed) <> ''
      group by 1 order by 2 desc, 1
    `) as unknown as Row[];

    const pppAntes = (
      await sql`select count(*)::int n from pets where potentially_dangerous_breed = true`
    )[0].n;

    const cambios: Array<{ de: string; a: string; n: number }> = [];
    const yaBien: Row[] = [];
    const sinResolver: Row[] = [];

    for (const r of rows) {
      const destino = decideBreed(r.breed);
      if (destino === null) sinResolver.push(r);
      else if (destino === r.breed) yaBien.push(r);
      else cambios.push({ de: r.breed, a: destino, n: r.n });
    }

    console.log(`  ${rows.length} valores distintos · ${rows.reduce((a, r) => a + r.n, 0)} filas`);
    console.log(`  Ya en catálogo: ${yaBien.length} valores`);

    if (cambios.length > 0) {
      console.log(`\n  A NORMALIZAR (${cambios.length}):`);
      for (const c of cambios) {
        console.log(`    ${`"${c.de}"`.padEnd(38)} → ${`"${c.a}"`.padEnd(32)} (${c.n})`);
      }
    }

    if (sinResolver.length > 0) {
      console.log(`\n  SIN RESOLVER — no se tocan (${sinResolver.length}):`);
      for (const r of sinResolver) console.log(`    "${r.breed}" (${r.n})`);
      console.log(
        lines(
          "",
          "  Cada una de estas es una decisión, no un bug del script: o es una raza",
          "  real que falta en el catálogo (agregala a DOG_BREEDS/CAT_BREEDS), o es un",
          "  nombre coloquial (agregalo a BREED_ALIASES). Aplastarlas a 'Pura raza no",
          "  listada' destruye información que alguien cargó.",
        ),
      );
    }

    if (!apply) {
      console.log("\n  SIMULACRO — no se escribió nada. Re-corré con --apply.\n");
      process.exit(0);
    }

    let filas = 0;
    for (const c of cambios) {
      const res = await sql`update pets set breed = ${c.a} where breed = ${c.de}`;
      filas += res.count;
    }

    const restantes = (
      await sql`
        select count(*)::int n from pets
        where breed is not null and btrim(breed) <> ''
          and breed not in ${sql([...CATALOG])}
      `
    )[0].n;

    console.log(`\n  Actualizadas ${filas} fila(s).`);
    console.log(`  PPP marcadas antes: ${pppAntes}`);
    console.log(
      `  Fuera de catálogo que quedan: ${restantes}${restantes > 0 ? " (las SIN RESOLVER de arriba)" : ""}`,
    );
    console.log(
      lines(
        "",
        "  La reclasificación PPP la hace el cron business_rules_reeval (barrido AR",
        "  por defecto incluido). Verificá el conteo después de que corra.",
        "",
      ),
    );
  } finally {
    await sql.end({ timeout: 3 }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("repair-breeds falló:", err instanceof Error ? err.message : err);
  process.exit(1);
});
