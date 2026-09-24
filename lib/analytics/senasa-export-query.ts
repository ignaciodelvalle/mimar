// SENASA / LSUCyF batch export — scoped gather (IO stage).
//
// See dim-interno:docs/design/sdd/2026-07-07-senasa-lsucyf-batch-export.md.
//
// The ONLY database-touching part of the SENASA export — the scoped gather and
// (since the route landed, 2026-09-11) the mandatory audit row. Gathers sanitary-
// aligned pet_events (tipo_evento_code IS NOT NULL) within a ProjectionContext
// (jurisdiction scope + period), joined to their pets, and returns plain
// SenasaEventRow[] for the pure transform in senasa-export.ts. Scoping mirrors
// lib/analytics/campaign-metrics.ts exactly:
//   - admin (scope.kind='global') → no jurisdiction WHERE.
//   - govt  (scope.kind='jurisdictions') → OR of (province AND locality) pairs
//     matched against pets.jurisdiction_province / pets.jurisdiction_locality.

import { type SQL, and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";

import { auditLog, db, petEvents, pets } from "@/db";
import type { SenasaEventRow } from "@/lib/analytics/senasa-export";
import {
  type ProjectionContext,
  jurisdictionPairClause,
  withoutSyntheticRows,
} from "@/lib/metrics";

/** Filas por página del keyset. Acota la memoria, no el total exportado. */
const SENASA_PAGE_SIZE = 1000;

/**
 * La fila tal como sale de la query: SenasaEventRow más las dos columnas que
 * usa el keyset y que NO viajan al transform. Declarada explícitamente porque
 * el cursor se alimenta del resultado y el resultado depende del cursor —
 * TypeScript no puede inferir eso sin ayuda (TS7022).
 */
type SenasaPageRow = Omit<SenasaEventRow, "tipoEventoCode"> & {
  id: string;
  tipoEventoCode: string | null;
};

/**
 * Recorre los eventos alineados a SENASA en scope, DE A PÁGINAS.
 *
 * Acota en occurred_at (la fecha clínica), NO en recorded_at.
 * No emite nada para un contexto govt sin jurisdicciones (nada en scope).
 *
 * POR QUÉ ES UN GENERADOR Y NO DEVUELVE UN ARRAY (2026-08-13). Hasta hoy esto
 * era `fetchSenasaBatch(ctx): Promise<SenasaEventRow[]>`: una query sin LIMIT
 * sobre `pet_events` que materializaba el resultado entero en memoria. Está
 * dormida —cero callers— y por eso la 2a pasada de auditoría la dejó como nota
 * y no como hallazgo.
 *
 * Se cambia igual, y ahora, precisamente porque está dormida: el día que
 * alguien cablee la ruta de export SENASA no va a auditar esta función, va a
 * asumir que está lista. Es la misma forma del hallazgo #4 (correcto por ítem,
 * ruinoso por barrido) atrapada antes de tener consecuencias, y el costo ahora
 * es una fracción del costo después. Para dimensionar: `pets` tiene 32.428 filas
 * en la base local y `pet_events` es varias veces eso.
 *
 * La firma es la que impide el mal uso, no un comentario: no existe una función
 * que devuelva todo junto. Quien quiera el array completo tiene que escribir el
 * `for await` y acumular a propósito, que es una decisión visible en su código.
 *
 * El keyset es compuesto `(occurred_at, id)` porque occurred_at no es único —
 * paginar sólo por fecha saltearía o repetiría filas que comparten el instante.
 */
export async function* streamSenasaBatch(
  ctx: ProjectionContext,
  // `pageSize` existe para que un test pueda cruzar el límite de página con
  // pocas filas. El default sigue acotando la memoria en producción; no hay
  // forma de pedir "todo en una página" sin escribirlo explícitamente.
  opts: { pageSize?: number } = {},
): AsyncGenerator<SenasaEventRow, void, undefined> {
  const pageSize = opts.pageSize ?? SENASA_PAGE_SIZE;
  const { since, until } = ctx.period;

  // Base predicate: only sanitary-aligned rows, within the clinical-date window.
  const base = and(
    isNotNull(petEvents.tipoEventoCode),
    gte(petEvents.occurredAt, since),
    lt(petEvents.occurredAt, until),
  );

  // Jurisdiction scope.
  let where = base;
  if (ctx.scope.kind === "jurisdictions") {
    const { jurisdictions } = ctx.scope;
    if (jurisdictions.length === 0) return;
    // jurisdictionPairClause applies whole-province subsumption — see
    // lib/metrics/scope.ts. Found via authz-subsumption fence hardening
    // (2026-07-22) — same bug class as commit 68501bb4. Without it, a
    // whole-province operator's SENASA export would silently drop every
    // barrio-tagged sanitary event in their own province.
    const scopeClause =
      jurisdictionPairClause(
        [...jurisdictions],
        sql`${pets.jurisdictionProvince}`,
        sql`${pets.jurisdictionLocality}`,
      ) ?? sql`false`;
    where = and(base, scopeClause);
  }
  // T1-P1: a synthetic (seed-tagged) animal never reaches SENASA from a non-admin
  // export. Admin keeps the whole set for demos.
  const synthetic = withoutSyntheticRows(ctx.actor.role, "pets", null);
  if (synthetic) where = and(where, synthetic);

  let cursor: { occurredAt: Date; id: string } | null = null;

  for (;;) {
    const pageWhere: SQL | undefined = cursor
      ? and(
          where,
          // Comparación de fila: ordena por (occurred_at, id) igual que el
          // ORDER BY, así que retoma exactamente donde cortó la página anterior.
          // Los tipos van explícitos: sin el cast, el driver no sabe bindear un
          // Date y un uuid dentro de un constructor de fila y tira
          // ERR_INVALID_ARG_TYPE. Lo encontró el test de límite de página.
          sql`(${petEvents.occurredAt}, ${petEvents.id}) > (${cursor.occurredAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
        )
      : where;

    const rows: SenasaPageRow[] = await db
      .select({
        id: petEvents.id,
        animalToken: pets.publicToken,
        species: pets.species,
        jurisdictionProvince: pets.jurisdictionProvince,
        jurisdictionLocality: pets.jurisdictionLocality,
        occurredAt: petEvents.occurredAt,
        tipoEventoCode: petEvents.tipoEventoCode,
        loteBiologico: petEvents.loteBiologico,
        laboratorio: petEvents.laboratorio,
        vencimientoBiologico: petEvents.vencimientoBiologico,
        viaAplicacionCode: petEvents.viaAplicacionCode,
        vetMatricula: petEvents.vetMatricula,
        vetJurisdiccionCode: petEvents.vetJurisdiccionCode,
        establecimientoRenspa: petEvents.establecimientoRenspa,
        proximaDosisAt: petEvents.proximaDosisAt,
      })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(pageWhere)
      .orderBy(petEvents.occurredAt, petEvents.id)
      .limit(pageSize);

    if (rows.length === 0) return;

    for (const r of rows) {
      // `id` es del keyset, no del contrato de salida: no viaja al transform.
      const { id: _id, ...row } = r;
      // tipoEventoCode is guaranteed non-null by the isNotNull predicate; narrow
      // the column type (text → string) for the pure transform's input contract.
      yield { ...row, tipoEventoCode: row.tipoEventoCode as string };
    }

    const last = rows[rows.length - 1];
    cursor = { occurredAt: last.occurredAt, id: last.id };
    if (rows.length < pageSize) return;
  }
}

// ---------------------------------------------------------------------------
// Audit — the mandatory row for a RAW-ROW export (R4.1)
// ---------------------------------------------------------------------------

/**
 * One `senasa_export_generated` row per SENASA batch download.
 *
 * WHY ITS OWN ACTION, AND NOT `gob_dashboard_export_generated`.
 * That action's catalog entry (db/schema.ts) says what it means in as many
 * words: "aggregate/scoped rows only, no raw PII pet lists". This export is the
 * opposite — ONE ROW PER ANIMAL PER SANITARY EVENT, carrying the animal's
 * public token and the exact clinical date. Filing it under an action that
 * declares itself aggregate would make the trail say something untrue about
 * what was downloaded, and would put it in the same filter bucket as the four
 * dashboard CSVs on /admin/auditoria — so an auditor asking "who pulled raw
 * sanitary rows for my province" could not ask it. Migration 0220 declares the
 * action; `AUDIT_LOG_ACTIONS` is the same single source of truth it projects.
 *
 * WHY BEFORE THE FIRST BYTE, AND WHY NO ROW COUNT.
 * The response is STREAMED, so the count is not knowable when the row is
 * written, and a row written after the stream drains is absent in exactly the
 * case that matters most: a download that was interrupted AFTER the sensitive
 * rows had already crossed the wire (client disconnect, pod recycle, a crash in
 * the middle of a 200k-row pull). The audited fact here is the authorized
 * DISCLOSURE OF A SCOPE — actor, jurisdiction, period, format — and that is
 * fully known before any data moves. R4.1 asks for a row count; it was written
 * against a buffered export where the count was free. Recording a scope that
 * cannot be lost serves the requirement's intent better than a count that can.
 *
 * THE JURISDICTIONS ARE RECORDED AS PAIRS, NOT AS A COUNT, and the first draft
 * of this function got that wrong in a way that defeated its own stated purpose.
 * That draft wrote `province`/`locality` from `ctx.adminProvince`/`adminLocality`
 * — but `resolveJurisdictionScope` gates both of those on `role === "admin"`
 * ("Govt callers get null", its own docblock). So for EVERY govt operator the
 * payload read `{ jurisdiction_count: 3, province: null, locality: null }`, and
 * an operator assigned three localities who pulled `?province=AR-B` produced a
 * row byte-identical to the same operator pulling all three.
 *
 * The whole argument for minting a separate action, three paragraphs up, is
 * that an auditor must be able to ask "who pulled raw sanitary rows FOR MY
 * PROVINCE". For the actors who are not admins — which is most of them — the
 * province was not in the row. It is now: the effective pairs the query was
 * actually scoped to. Bounded and small; an operator holds a handful of
 * assignments, not a country.
 */
export async function logSenasaExport(
  actorUserId: string,
  ctx: ProjectionContext,
  formatterId: string,
): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId,
    action: "senasa_export_generated",
    payload: {
      format: formatterId,
      scope: {
        kind: ctx.scope.kind,
        jurisdiction_count: ctx.scope.kind === "jurisdictions" ? ctx.scope.jurisdictions.length : 0,
        // The EFFECTIVE pairs, whatever narrowed them — an admin's drill-down
        // and a govt operator's mandate both land here, so the row answers the
        // province question for either actor. Empty for a global scope, which
        // `kind` already says.
        jurisdictions:
          ctx.scope.kind === "jurisdictions"
            ? ctx.scope.jurisdictions.map((j) => ({
                province: j.province ?? null,
                locality: j.locality ?? null,
              }))
            : [],
        province: ctx.adminProvince ?? null,
        locality: ctx.adminLocality ?? null,
      },
      period: {
        since: ctx.period.since.toISOString(),
        until: ctx.period.until.toISOString(),
      },
    },
  });
}
