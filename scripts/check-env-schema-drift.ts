// Comparador de estructura entre dos bases — READ-ONLY.
//
// POR QUÉ EXISTE
// --------------
// Dos veces en el mismo día (2026-08-13) apareció el mismo agujero: el repo
// describe una base que no existe.
//
//   1. La migración 0172 borró policies de storage por NOMBRE. Staging tenía
//      otros nombres, puestos a mano en el primer deploy. Se aplicó, dijo "ok",
//      y dejó el hallazgo crítico vivo.
//   2. La migración 0084 dropea `pets_tattoo_location_valid`, y `db/schema.ts`
//      la declara borrada. **Staging la sigue teniendo.** Local no. Es decir:
//      local tiene 12 CHECK en `pets` y staging 13, y nada en el repo lo dice.
//
// El patrón es siempre el mismo: `DROP ... IF EXISTS` sobre un entorno que
// divergió es un no-op exitoso, y un entorno baselineado nunca ejecutó las
// migraciones anteriores al baseline — se las dio por aplicadas.
//
// Nada leyendo el repo puede detectar esto. Hay que mirar las dos bases.
//
// QUÉ COMPARA
// -----------
// COLUMNAS, CHECK constraints, índices (incluyendo únicos y parciales) y
// constraints de unicidad, por nombre y por definición. Un nombre que está en una y no en la
// otra es DERIVA. Una definición distinta con el mismo nombre es peor: las dos
// creen tener la misma regla.
//
// USO
//   REFERENCE_DATABASE_URL="<local>" DATABASE_URL="<destino>" \
//     pnpm exec tsx scripts/check-env-schema-drift.ts --allow-remote
//
// La REFERENCIA debería ser una base construida desde las migraciones (el local
// de `pnpm db:bootstrap`), porque es la única que sí representa lo que el repo
// dice. El DESTINO es el entorno del que se sospecha.
//
// Sale 0 si no hay deriva, 7 si hay. Estrictamente de lectura: sólo consulta
// pg_constraint y pg_indexes.

import postgres from "postgres";

import { DEFAULT_LOCAL_URL, describeTarget, lines, remoteRemedy } from "./_db-target";

type Row = { clave: string; definicion: string };

const CONSTRAINTS_SQL = `
  select c.conrelid::regclass::text || '.' || c.conname as clave,
         pg_get_constraintdef(c.oid) as definicion
  from pg_constraint c
  join pg_namespace n on n.oid = c.connamespace
  where contype in ('c', 'u') and n.nspname = 'public'
`;

const INDEXES_SQL = `
  select schemaname || '.' || indexname as clave,
         regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX [^ ]+ ', 'CREATE \\1INDEX ') as definicion
  from pg_indexes
  where schemaname = 'public'
`;

// Columnas. La primera versión de este script no las miraba, y eso le dio a la
// comparación un aire de completitud que no tenía: staging conservaba
// `organizations.latitude` y `.longitude`, dos columnas que la migración 0103
// borró y que en el repo no existen desde entonces. Se descubrió de casualidad,
// porque una migración escrita contra el schema del repo falló al correr.
// Una columna de más es peor que un índice de más: cambia lo que devuelve un
// SELECT *, y sobrevive a cualquier revisión que sólo lea el repo.
const COLUMNS_SQL = `
  select table_name || '.' || column_name as clave,
         data_type || (case when is_nullable = 'YES' then ' null' else ' not null' end) as definicion
  from information_schema.columns
  where table_schema = 'public'
`;

async function fingerprint(url: string): Promise<Map<string, string>> {
  const sql = postgres(url, { max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    const out = new Map<string, string>();
    for (const query of [CONSTRAINTS_SQL, INDEXES_SQL, COLUMNS_SQL]) {
      const rows = (await sql.unsafe(query)) as unknown as Row[];
      for (const r of rows) out.set(r.clave, r.definicion);
    }
    return out;
  } finally {
    await sql.end({ timeout: 3 }).catch(() => {});
  }
}

function report(title: string, items: string[]): void {
  if (items.length === 0) return;
  console.log(`\n  ${title} (${items.length})`);
  for (const item of items.slice(0, 40)) console.log(`    ${item}`);
  if (items.length > 40) console.log(`    … y ${items.length - 40} más`);
}

async function main(): Promise<void> {
  const allowRemote = process.argv.includes("--allow-remote");
  const referenceUrl = process.env.REFERENCE_DATABASE_URL ?? DEFAULT_LOCAL_URL;
  const targetUrl = process.env.DATABASE_URL;

  if (!targetUrl) {
    console.error("ERROR: falta DATABASE_URL (la base a auditar).");
    process.exit(2);
  }

  const reference = describeTarget(referenceUrl);
  const target = describeTarget(targetUrl);

  if (!target.isLocal && !allowRemote) {
    console.warn(
      lines(
        "[skip] check-env-schema-drift: DATABASE_URL apunta a un host no local.",
        `  Base de destino: ${target.label}`,
        "  No se comparó nada.",
        remoteRemedy("lee pg_constraint y pg_indexes"),
      ),
    );
    process.exit(0);
  }

  console.log("");
  console.log(`  Referencia: ${reference.label}${reference.isLocal ? "  [LOCAL]" : "  [REMOTO]"}`);
  console.log(`  Destino:    ${target.label}${target.isLocal ? "  [LOCAL]" : "  [REMOTO]"}`);

  if (reference.label === target.label) {
    console.error("\nERROR: referencia y destino son la misma base. No hay nada que comparar.");
    process.exit(4);
  }

  const [ref, tgt] = await Promise.all([fingerprint(referenceUrl), fingerprint(targetUrl)]);

  const faltanEnDestino = [...ref.keys()].filter((k) => !tgt.has(k)).sort();
  const sobranEnDestino = [...tgt.keys()].filter((k) => !ref.has(k)).sort();
  const definicionDistinta = [...ref.keys()]
    .filter((k) => tgt.has(k) && tgt.get(k) !== ref.get(k))
    .sort();

  console.log(`\n  Referencia: ${ref.size} objetos · Destino: ${tgt.size} objetos`);

  report("FALTAN en el destino (el repo las declara y la base no las tiene)", faltanEnDestino);
  report("SOBRAN en el destino (la base las tiene y el repo no las declara)", sobranEnDestino);
  report(
    "MISMO NOMBRE, DEFINICIÓN DISTINTA — las dos creen tener la misma regla",
    definicionDistinta,
  );

  const total = faltanEnDestino.length + sobranEnDestino.length + definicionDistinta.length;

  if (total === 0) {
    console.log("\n✓ Sin deriva estructural entre las dos bases.\n");
    process.exit(0);
  }

  console.log(
    lines(
      "",
      `✗ ${total} diferencia(s) de estructura.`,
      "",
      "  Una diferencia acá NO se arregla a mano en la base: eso es justo lo que",
      "  produjo la deriva. Se arregla con una migración forward-only que lleve al",
      "  destino a donde el repo dice, y se vuelve a correr esto para confirmarlo.",
      "",
    ),
  );
  process.exit(7);
}

main().catch((err) => {
  console.error("check-env-schema-drift falló:", err instanceof Error ? err.message : err);
  process.exit(1);
});
