// Inventario de policies sobre storage.objects — READ-ONLY.
//
// POR QUÉ EXISTE (2026-08-13)
// ---------------------------
// La migración 0172 cerró los buckets de export borrando por NOMBRE las policies
// que declara db/exports_storage.sql. Corrida contra staging, el fence de RLS
// siguió reportando tres lecturas abiertas: staging tenía
// `exports_authenticated_read_{welfare,ppp,travel}_exports` — una por bucket,
// creadas A MANO en el hot-patch del primer deploy (el header de
// db/exports_storage.sql lo documenta). Nombres distintos, mismo agujero, y el
// DROP ... IF EXISTS por nombre no las tocó.
//
// La lección es que el SQL versionado describe lo que NOSOTROS creamos, no lo
// que HAY. Un entorno que fue parcheado a mano diverge, y la divergencia es
// invisible desde el repo. Este script mira la base.
//
// Uso:
//   DATABASE_URL="<url>" pnpm exec tsx scripts/list-storage-policies.ts
//
// Imprime toda policy de storage.objects agrupada por bucket, marcando cuáles
// son alcanzables por roles de baja confianza sin nombrar al llamador — el mismo
// criterio que el check 4 de check-rls-coverage.ts, pero listando TODO en vez de
// sólo las violaciones, para poder comparar entornos.

import postgres from "postgres";

const LOW_TRUST = new Set(["anon", "authenticated", "public"]);

type Row = {
  policyname: string;
  cmd: string;
  roles: string[];
  qual: string | null;
  with_check: string | null;
};

function bucketOf(row: Row): string {
  const clause = `${row.qual ?? ""} ${row.with_check ?? ""}`;
  const single = clause.match(/bucket_id = '([^']+)'/)?.[1];
  if (single) return single;
  const many = clause.match(/bucket_id = ANY \(ARRAY\[([^\]]+)\]/)?.[1];
  if (many) return many.replace(/'|::text/g, "").trim();
  return "(sin bucket en el predicado)";
}

/** Mismo criterio que el check 4 de check-rls-coverage: una lectura alcanzable
 *  por un rol de baja confianza cuyo predicado no nombra al llamador es una
 *  enumeración del bucket entero. */
function classify(r: Row): { openRead: boolean; mark: string } {
  const lowTrust = r.roles.some((x) => LOW_TRUST.has(x));
  const clause = r.cmd === "INSERT" ? r.with_check : r.qual;
  const namesCaller = (clause ?? "").includes("auth.uid()");
  if (!lowTrust || namesCaller) return { openRead: false, mark: "" };
  if (r.cmd === "SELECT" || r.cmd === "ALL") {
    return { openRead: true, mark: " ← LECTURA ABIERTA" };
  }
  return { openRead: false, mark: " ← sin auth.uid()" };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: falta DATABASE_URL.");
    process.exit(2);
  }

  const ref =
    url.match(/postgres\.([a-z0-9]+)[.:]/)?.[1] ?? url.match(/db\.([a-z0-9]+)\.supabase\.co/)?.[1];
  console.log(`\n  Base: ${url.match(/@([^:/]+)/)?.[1] ?? "?"}${ref ? `  ref=${ref}` : ""}\n`);

  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const rows = (await sql`
      select policyname::text, cmd::text, roles::text[] as roles, qual, with_check
      from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
      order by policyname
    `) as unknown as Row[];

    console.log(`storage.objects — ${rows.length} policies\n`);

    const byBucket = new Map<string, Row[]>();
    for (const r of rows) {
      const b = bucketOf(r);
      byBucket.set(b, [...(byBucket.get(b) ?? []), r]);
    }

    let openReads = 0;
    for (const [bucket, list] of [...byBucket.entries()].sort()) {
      console.log(`  ${bucket}`);
      for (const r of list) {
        const verdict = classify(r);
        if (verdict.openRead) openReads++;
        console.log(
          `    ${r.cmd.padEnd(6)} to ${r.roles.join(",").padEnd(22)} ${r.policyname}${verdict.mark}`,
        );
      }
      console.log("");
    }

    console.log(
      openReads > 0
        ? `  ${openReads} lectura(s) abierta(s) — enumerables por cualquier cuenta con ese rol.\n`
        : "  Sin lecturas abiertas.\n",
    );
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("list-storage-policies falló:", err instanceof Error ? err.message : err);
  process.exit(1);
});
