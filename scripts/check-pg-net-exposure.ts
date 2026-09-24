// Auditor de superficie HTTP saliente (pg_net) — READ-ONLY.
//
// POR QUÉ EXISTE
// --------------
// La 2a pasada de auditoría concluyó "sin superficie SSRF/HTTP/JWT-forgery"
// afirmando que `pg_net`, `http`, `dblink` y `pgjwt` estaban AUSENTES. Medido
// contra la base local el 2026-08-13, `pg_net` ESTÁ instalado: lo pone la
// plataforma Supabase, no nuestras migraciones, así que un barrido del SQL
// versionado del repo no puede verlo. El informe lo había anticipado en su
// sección "Qué NO pude verificar" — la limitación mordió justo ahí.
//
// Este script existe para que esa pregunta se responda contra la BASE VIVA y no
// contra el repo, y para que se pueda repetir en cada entorno sin acordarse de
// las cuatro queries.
//
// QUÉ RESPONDE (y qué NO)
// -----------------------
// Responde: qué extensiones de red hay, en qué schema, quién puede EJECUTAR sus
// funciones, y quién tiene USAGE sobre ese schema.
//
// NO responde —y lo dice— cuáles son los schemas EXPUESTOS por PostgREST. Eso
// es configuración del servicio, no de la base: no vive en pg_settings ni en
// pg_db_role_setting (verificado). Se chequea en el dashboard
// (Settings → API → Exposed schemas) o probando el endpoint. El script imprime
// esa instrucción en vez de adivinar, porque el veredicto final depende de ella:
// las funciones pueden estar concedidas a `anon` y ser inalcanzables si su
// schema no está expuesto.
//
// MEDIDO EN STAGING (2026-08-13): NO alcanzable. Se le preguntó el OpenAPI a
// PostgREST — `GET {SUPABASE_URL}/rest/v1/` con la service-role key, que ve todo
// lo expuesto — y devolvió 408 KB de spec con CERO apariciones de http_get,
// http_post o pg_net. Las funciones existen y anon tiene EXECUTE, pero viven en
// el schema `net` y PostgREST no lo expone. La conclusión del informe era
// correcta; su premisa no.
//
// Ese camino es preferible a llamar al RPC: llamar `http_get` haría que la base
// emitiera una request HTTP saliente real. Pedir el spec no ejecuta nada.
//
// CORRECCIÓN A LA MIGRACIÓN 0174: su header dice que las funciones están en
// `extensions` y que eso importa porque ese schema está en `extra_search_path`.
// Están en `net`, que NO está en el search path — así que el argumento de riesgo
// de esa migración está sobreestimado. Pinnear el search_path sigue siendo lo
// correcto por sí mismo. El archivo de migración no se edita: cambiaría su
// checksum y dispararía la detección de drift de migrate.ts.
//
// Uso:
//   DATABASE_URL="<url>" pnpm exec tsx scripts/check-pg-net-exposure.ts
//
// Sólo lee catálogo. No escribe nada. Sale 0 siempre que pueda conectarse: su
// trabajo es informar, no fallar un gate.

import postgres from "postgres";

const NETWORK_EXTENSIONS = ["pg_net", "http", "dblink", "pgjwt"];
const LOW_TRUST = ["anon", "authenticated", "public"];

type ExtRow = { extname: string; schema: string };
type FnRow = { proname: string; schema: string; acl: string | null };
type NspRow = { nspname: string; nspacl: string | null };

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: falta DATABASE_URL.");
    process.exit(2);
  }

  // Muestra a qué base se conectó ANTES de imprimir conclusiones. La cuenta
  // tiene dos proyectos Supabase que comparten host de pooler, y el ref viaja
  // en el usuario de la URL — el mismo problema que arregló 5bee0f27.
  const ref =
    url.match(/postgres\.([a-z0-9]+)@/)?.[1] ?? url.match(/db\.([a-z0-9]+)\.supabase\.co/)?.[1];
  const host = url.match(/@([^:/]+)/)?.[1] ?? "(desconocido)";
  console.log(`\n  Base: ${host}${ref ? `  ref=${ref}` : ""}\n`);

  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });

  try {
    const exts = (await sql`
      select e.extname::text as extname, n.nspname::text as schema
      from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      order by 1
    `) as unknown as ExtRow[];

    const present = exts.filter((e) => NETWORK_EXTENSIONS.includes(e.extname));

    console.log("EXTENSIONES DE RED");
    if (present.length === 0) {
      console.log("  ninguna instalada — sin superficie HTTP saliente desde la base.\n");
      console.log(`  (todas las instaladas: ${exts.map((e) => e.extname).join(", ")})`);
      return;
    }
    for (const e of present) {
      console.log(`  ${e.extname}  →  schema "${e.schema}"`);
    }
    console.log("");

    const fns = (await sql`
      select p.proname::text as proname,
             n.nspname::text as schema,
             array_to_string(p.proacl, ',') as acl
      from pg_proc p
      join pg_depend d on d.objid = p.oid
      join pg_extension e on e.oid = d.refobjid
      join pg_namespace n on n.oid = p.pronamespace
      where e.extname = any(${NETWORK_EXTENSIONS})
      order by 1
    `) as unknown as FnRow[];

    // OJO: el schema que importa es donde viven las FUNCIONES, no donde está
    // registrada la extensión. pg_net se registra en `extensions` pero expone
    // sus funciones en `net`. Mirar extnamespace daba la respuesta equivocada —
    // lo detecté corriendo esto contra la base local.
    const schemas = [...new Set(fns.map((f) => f.schema))];

    const reachable = fns.filter(
      (f) => f.acl === null || LOW_TRUST.some((r) => (f.acl ?? "").includes(`${r}=`)),
    );

    console.log("FUNCIONES EJECUTABLES POR ROLES DE BAJA CONFIANZA");
    if (reachable.length === 0) {
      console.log("  ninguna.\n");
    } else {
      for (const f of reachable) {
        const who = f.acl === null ? "(default: PUBLIC)" : f.acl;
        console.log(`  ${f.schema}.${f.proname}  →  ${who}`);
      }
      console.log("");
    }

    const nsp = (await sql`
      select nspname::text as nspname, array_to_string(nspacl, ',') as nspacl
      from pg_namespace where nspname = any(${schemas})
    `) as unknown as NspRow[];

    console.log("USAGE SOBRE EL SCHEMA QUE LAS ALOJA");
    for (const n of nsp) {
      const grantedTo = LOW_TRUST.filter((r) => (n.nspacl ?? "").includes(`${r}=`));
      console.log(
        `  ${n.nspname}  →  ${grantedTo.length > 0 ? `USAGE para ${grantedTo.join(", ")}` : "sin USAGE a roles de baja confianza"}`,
      );
    }
    console.log("");

    const anyLowTrustUsage = nsp.some((n) =>
      LOW_TRUST.some((r) => (n.nspacl ?? "").includes(`${r}=`)),
    );

    console.log("VEREDICTO");
    if (reachable.length > 0 && anyLowTrustUsage) {
      console.log("  Las funciones de red son ejecutables por anon/authenticated Y su schema");
      console.log("  tiene USAGE para esos roles.");
      console.log("");
      console.log("  ESO NO ALCANZA PARA QUE SEAN ALCANZABLES: falta saber si PostgREST expone");
      console.log(`  el/los schema(s) "${schemas.join('", "')}". Eso NO se puede leer desde SQL.`);
      console.log("");
      console.log("  CHEQUEALO ASÍ (10 segundos):");
      console.log("    Dashboard → Settings → API → Exposed schemas");
      console.log("");
      console.log("    Si dice sólo `public, graphql_public`  → NO alcanzable. Cerrado.");
      console.log(`    Si aparece "${schemas[0]}"                → INCIDENTE: anon puede hacer`);
      console.log("      HTTP saliente con la key del bundle. Revocar EXECUTE y sacar el schema.");
    } else {
      console.log("  Sin ruta de baja confianza a las funciones de red.");
    }
    console.log("");
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("check-pg-net-exposure falló:", err instanceof Error ? err.message : err);
  process.exit(1);
});
