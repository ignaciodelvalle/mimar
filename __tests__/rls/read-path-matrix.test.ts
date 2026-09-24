// RLS READ-PATH matrix fitness test — el gemelo de write-path-matrix.test.ts.
// ============================================================================
//
// GARANTÍA ESTRUCTURAL (lecturas): ninguna tabla `public` con RLS habilitado
// expone una lectura INCONDICIONAL a los roles `anon` / `authenticated` /
// `public` de PostgREST, salvo las declaradas acá con su razón.
//
// POR QUÉ EXISTE ESTE ARCHIVO (2026-08-12). El lado de ESCRITURA ya estaba
// cubierto por write-path-matrix.test.ts y el de STORAGE por el check 4 de
// scripts/check-rls-coverage.ts. La lectura de tablas `public` no la miraba
// nadie: `time_slots` tiene `SELECT USING (true)` a anon y ningún fence dice
// nada. Esa tabla es benigna —oferta, horarios, capacidad, contador, cero
// identidad— pero la ausencia del chequeo significa que una policy igual sobre
// una tabla CON identidad tampoco saltaría.
//
// El hueco se encontró barriendo a mano la clase "policies permisivas a anon"
// después de que la 2a pasada de auditoría hallara el INSERT anónimo de
// welfare_reports leyendo el ledger de riesgos aceptados en vez de enumerando
// la clase. El barrido manual encontró un solo hermano; este archivo convierte
// ese barrido en método, que es lo que faltaba.
//
// HEURÍSTICA (introspección pura de catálogo, igual que su gemelo):
//   Para toda policy PERMISSIVE de lectura (cmd ∈ SELECT/ALL) sobre una tabla
//   public con RLS habilitado, es INSEGURA si a la vez:
//     (a) la alcanza un rol de baja confianza (anon / authenticated / public), y
//     (b) su cláusula USING es INCONDICIONAL — ausente o trivialmente `true`.
//   Una policy con predicado (auth.uid(), organization_id, un subselect a
//   ownerships) es SEGURA: `anon` tiene auth.uid() NULL, así que nunca pasa, y
//   un `authenticated` queda fijado a sus propias filas.
//
// CÓMO SATISFACER UNA FALLA: una lectura incondicional nueva a anon/auth casi
// siempre es un bug — acotala con un predicado en la migración. Si la apertura
// es GENUINAMENTE deliberada (un catálogo público sin identidad), agregá
// `${table}.${cmd}` a INTENTIONAL_UNCONDITIONAL_READS con su razón. No debilites
// la aserción.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

// ---------------------------------------------------------------------------
// Lecturas abiertas a propósito. Cada entrada necesita una razón que diga POR
// QUÉ la tabla no tiene nada que proteger — no "es de bajo impacto", sino qué
// columnas tiene y por qué ninguna identifica a una persona.
// ---------------------------------------------------------------------------
const INTENTIONAL_UNCONDITIONAL_READS: Readonly<Record<string, string>> = {
  // Disponibilidad de turnos: service_offering_id, starts_at, ends_at, capacity,
  // bookings_count, status. Cero identidad — ni quién reservó ni cuántos son
  // esas reservas de quién. El buscador público de turnos (/turnos/buscar) lee
  // esta tabla sin sesión por diseño: es la vidriera de horarios disponibles.
  // Verificado columna por columna el 2026-08-12; si alguna vez se le agrega
  // una columna que apunte a una persona, esta excepción deja de ser válida.
  "time_slots.SELECT":
    "Disponibilidad pública de turnos; la tabla no tiene ninguna columna que identifique a una persona (offering, horarios, capacidad, contador).",
};

// ---------------------------------------------------------------------------
// Tipos + introspección
// ---------------------------------------------------------------------------

type ReadPolicyRow = {
  tablename: string;
  policyname: string;
  cmd: string; // SELECT | ALL
  roles: string; // nombres de rol unidos por coma
  qual: string | null; // expresión USING (NULL cuando falta)
};

const LOW_TRUST_ROLES = new Set(["anon", "authenticated", "public"]);

/** Todas las policies PERMISSIVE de lectura sobre tablas public con RLS. */
async function readPolicies(): Promise<ReadPolicyRow[]> {
  return (await db.execute(sql`
    select
      p.tablename                     as tablename,
      p.policyname                    as policyname,
      p.cmd                           as cmd,
      array_to_string(p.roles, ',')   as roles,
      p.qual                          as qual
    from pg_policies p
    join pg_class c     on c.relname = p.tablename
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where p.schemaname = 'public'
      and c.relkind = 'r'
      and c.relrowsecurity = true
      and p.permissive = 'PERMISSIVE'
      and p.cmd in ('SELECT', 'ALL')
  `)) as unknown as ReadPolicyRow[];
}

/** Una cláusula es "incondicional" cuando falta o es trivialmente `true`. */
function isUnconditional(clause: string | null): boolean {
  if (clause === null || clause === undefined) return true;
  return clause.trim().toLowerCase() === "true";
}

function isLowTrustReachable(row: ReadPolicyRow): boolean {
  return row.roles
    .split(",")
    .map((r) => r.trim())
    .some((r) => LOW_TRUST_ROLES.has(r));
}

type Offender = ReadPolicyRow & { key: string };

function findUnsafeReads(rows: ReadPolicyRow[]): Offender[] {
  const out: Offender[] = [];
  for (const row of rows) {
    if (!isLowTrustReachable(row)) continue;
    if (!isUnconditional(row.qual)) continue;
    out.push({ ...row, key: `${row.tablename}.${row.cmd}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RLS read-path matrix (deny-all vale también para lecturas)", () => {
  it("introspecta una superficie de lectura no vacía (guarda contra un no-op silencioso)", async () => {
    const rows = await readPolicies();
    // Si esto viniera vacío, el join está mal o la base no tiene RLS, y todas
    // las aserciones de abajo pasarían por vacuidad — que es exactamente el
    // modo de falla que este archivo existe para no repetir.
    expect(
      rows.length,
      "se esperaban policies de lectura sobre tablas public con RLS",
    ).toBeGreaterThan(0);
  });

  it("ninguna tabla expone una lectura INCONDICIONAL a anon/authenticated fuera de la allowlist", async () => {
    const offenders = findUnsafeReads(await readPolicies());
    const unexpected = offenders.filter((o) => !(o.key in INTENTIONAL_UNCONDITIONAL_READS));

    const detail = unexpected
      .map(
        (o) =>
          `${o.tablename}.${o.cmd} (policy "${o.policyname}", roles={${o.roles}}) — USING incondicional; acotala en una migración o agregá "${o.key}" a INTENTIONAL_UNCONDITIONAL_READS con su razón.`,
      )
      .join("\n");

    expect(unexpected, `Lecturas anon/authenticated sin acotar:\n${detail}`).toEqual([]);
  });

  it("cada lectura allowlisteada sigue correspondiendo a una policy real (sin excepciones obsoletas)", async () => {
    // El gemelo de escritura fue el que avisó que la excepción de
    // welfare_reports quedaba obsoleta al dropear la policy en 0173. Misma
    // mecánica acá: una excepción que ya no corresponde a nada se borra, no se
    // acumula.
    const offenders = findUnsafeReads(await readPolicies());
    const liveKeys = new Set(offenders.map((o) => o.key));

    const stale = Object.keys(INTENTIONAL_UNCONDITIONAL_READS).filter((k) => !liveKeys.has(k));
    expect(
      stale,
      `Entradas de allowlist sin policy incondicional viva — la policy se acotó o se borró, así que borrá la excepción: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("las lecturas allowlisteadas traen una justificación no vacía", () => {
    const undocumented = Object.entries(INTENTIONAL_UNCONDITIONAL_READS)
      .filter(([, reason]) => !reason || reason.trim().length === 0)
      .map(([key]) => key);
    expect(undocumented, `Lecturas allowlisteadas sin razón: ${undocumented.join(", ")}`).toEqual(
      [],
    );
  });
});
