// Operator-facing notice for /gob/analytics/export (D2, PO 2026-08-23).
//
// Extracted from page.tsx into its own module for ONE reason: it is a factual
// claim about what leaves the database, and a factual claim needs a test. Inline
// JSX inside an async server component behind two auth guards is not testable in
// practice, and the previous copy proved why that matters — it told operators
// "Los datos exportados están anonimizados", while the pipeline hands over a
// ROW-LEVEL padrón: one row per pet / case / organization / event.
//
// The pipeline's `anonymizeRows` (lib/analytics/govt-exports.ts) parses each row
// through a Zod schema, which STRIPS undeclared fields — name, owner, chip, DNI,
// coordinates never reach the file. It suppresses no cell, ever. So
// `SELECT locality, count(*) … GROUP BY 1` over the CSV reconstructs every cell
// the panorama map suppresses under k=5, and the event rows share the pet rows'
// key, which yields a per-animal timeline in localities that often hold exactly
// one animal.
//
// The PO decided NOT to aggregate it: an official needs the padrón of their own
// territory, and suppressing cells breaks the purpose. What was dishonest was
// never that the export existed — it was that AGENTS.md's "Aggregation & privacy
// policy" said one thing and this CSV did another. So the export is declared,
// here and in docs/architecture/privacy-known-limitations.md (entry PD1), as a
// row-level padrón export explicitly OUTSIDE the k-anonymity policy.
//
// The declaration rests on two properties that were VERIFIED against the code,
// not assumed — if either stops holding, this copy is a lie and the entry in the
// register must be reopened:
//
//   1. Scoped to the operator's own jurisdiction. All four fetchers in
//      lib/analytics/dashboards/exports.ts apply a scope clause and every one
//      of them fails CLOSED — `actor.role === "govt" && jurisdictions.length
//      === 0` returns [] before any query. Admin is universal by role, which
//      is the definition of admin, not a leak in this surface.
//   2. Audit-logged. app/gob/analytics/export/actions.ts writes an
//      `analytics_export_generated` row carrying actor, schema version, slices,
//      format, resolved period, jurisdiction, storage path and per-slice row
//      counts.
//
// Kept as a plain string, not JSX: the test asserts on the sentence an operator
// reads, and a string is the only shape where "what it says" and "what the test
// checks" cannot drift apart.

export const EXPORT_PRIVACY_NOTICE =
  "Este archivo es un padrón: viene fila por fila, una por cada registro de tu " +
  "jurisdicción, y no un resumen. No incluye datos personales identificables " +
  "(nombre, dueño, DNI, email, microchip ni coordenadas), pero el k-anonimato " +
  "que sí protege los tableros acá NO se aplica: agrupando las filas se pueden " +
  "reconstruir los conteos que los mapas ocultan. Es una decisión tomada a " +
  "propósito, porque un organismo necesita el padrón de su propio territorio. " +
  "Alcanza únicamente a tu jurisdicción, cada generación queda registrada en el " +
  "log de auditoría con tu usuario, y el link de descarga vence a las 24 horas. " +
  "Tratá el archivo como datos personales bajo la Ley 25.326: no lo redistribuyas " +
  "fuera del organismo ni lo publiques.";
