// Fence — todo valor de catálogo guardado tiene que estar en el catálogo.
// READ-ONLY.
//
// POR QUÉ
// -------
// El 2026-08-13 `pets.breed` era texto libre: 44 valores distintos para 69
// mascotas, 34 usados una sola vez. Dos de esas filas eran perros que la ley
// alcanza y el sistema no marcaba, porque el texto no matcheaba:
//
//   "Pit Bull Terrier Americano"  →  la lista dice "American Pit Bull Terrier"
//   "Ovejero alemán"              →  la regla de CABA dice "Pastor Alemán"
//
// Ninguno estaba marcado como PPP. Un régimen legal del que se sale escribiendo
// distinto no es un régimen. El formulario pasó a catálogo y los datos se
// normalizaron; esto es lo que impide que vuelva a abrirse.
//
// Los catálogos viven en TypeScript y este fence los IMPORTA, en vez de
// repetirlos en SQL. Un CHECK con 60 nombres adentro sería una segunda copia
// que hay que mantener sincronizada — o sea, la próxima fuente de divergencia.
//
// Uso:
//   pnpm exec tsx scripts/check-catalog-drift.ts [--allow-remote]
//
// Sale 0 si está limpio, 8 si hay valores fuera de catálogo.

import postgres from "postgres";

import { ALL_BREEDS } from "../lib/reference/breeds";
import { DEFAULT_LOCAL_URL, describeTarget, lines, remoteRemedy, reportSkip } from "./_db-target";

/** Especies válidas — mismas que el CHECK `pets_species_valid` (migración 0178)
 *  y que `speciesLabel` en lib/utils/species.ts. */
const SPECIES = ["dog", "cat", "rabbit", "guinea_pig", "ferret", "other"];

type Offender = { valor: string; n: number };

async function main(): Promise<void> {
  const allowRemote = process.argv.includes("--allow-remote");
  const url = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
  const target = describeTarget(url);

  if (!target.isLocal && !allowRemote) {
    reportSkip({
      fence: "check-catalog-drift",
      reason: `DATABASE_URL apunta a "${target.host}", que no es un host local.`,
      target,
      skipped: "  No se verificó ningún catálogo.",
      remedy: remoteRemedy("lee pets.breed y pets.species"),
    });
    process.exit(0);
  }

  const sql = postgres(url, { max: 1, connect_timeout: 15, onnotice: () => {} });
  let fallas = 0;

  try {
    console.log(`\n  Base: ${target.label}\n`);

    // 1 — raza
    const razas = (await sql`
      select breed as valor, count(*)::int as n
      from pets
      where breed is not null and btrim(breed) <> ''
        and breed not in ${sql([...ALL_BREEDS])}
      group by 1 order by 2 desc, 1
    `) as unknown as Offender[];

    if (razas.length === 0) {
      console.log("  ✓ raza — todos los valores están en catálogo.");
    } else {
      fallas += razas.length;
      console.log(`  ✗ raza — ${razas.length} valor(es) fuera de catálogo:`);
      for (const r of razas.slice(0, 25)) console.log(`      "${r.valor}" (${r.n})`);
      if (razas.length > 25) console.log(`      … y ${razas.length - 25} más`);
    }

    // 2 — especie. Tiene CHECK desde la 0178, así que acá sólo puede fallar si
    // el CHECK no llegó a este entorno — que es exactamente el caso que este
    // repo ya vio dos veces.
    const especies = (await sql`
      select species as valor, count(*)::int as n
      from pets
      where species not in ${sql(SPECIES)}
      group by 1 order by 2 desc, 1
    `) as unknown as Offender[];

    if (especies.length === 0) {
      console.log("  ✓ especie — todos los valores están en catálogo.");
    } else {
      fallas += especies.length;
      console.log(`  ✗ especie — ${especies.length} valor(es) fuera de catálogo:`);
      for (const e of especies) console.log(`      "${e.valor}" (${e.n})`);
      console.log(
        "      (debería ser imposible: existe el CHECK pets_species_valid. Si aparece,",
        "\n       la migración 0178 no llegó a esta base — corré check-env-schema-drift.)",
      );
    }
  } finally {
    await sql.end({ timeout: 3 }).catch(() => {});
  }

  if (fallas === 0) {
    console.log("\n✓ catálogos limpios.\n");
    process.exit(0);
  }

  console.log(
    lines(
      "",
      `✗ ${fallas} valor(es) fuera de catálogo.`,
      "",
      "  Cada uno es una decisión, no un error a aplastar: o es real y falta en el",
      "  catálogo (agregalo a lib/reference/breeds.ts), o es una forma de escribir",
      "  una que ya está (agregala a BREED_ALIASES). Después:",
      "    DATABASE_URL=<base> pnpm exec tsx scripts/repair-breeds.ts   # simulacro",
      "",
    ),
  );
  process.exit(8);
}

main().catch((err) => {
  console.error("check-catalog-drift falló:", err instanceof Error ? err.message : err);
  process.exit(1);
});
