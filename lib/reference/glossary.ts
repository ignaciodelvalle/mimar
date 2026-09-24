// Operator-surface glossary (red-team-admin-2 P2.5): the admin/gob dashboards
// carry acronyms and jargon (ENO, SLA, PII, PPP, RUPPPA, k<5, P75, "no cohorte")
// that a new official does not know. Rendered on hover via <GlossaryTerm> (which
// wraps HoverTip) so the definition is one hover away, in context — never a
// separate reference the operator has to go find.
//
// Definitions are es-AR and VERIFIED against the codebase's own legal/reference
// sources (lib/reference/legal-knowledge-base.ts, disease-legal-anchors.ts,
// lib/analytics/ppp-exports.ts) — no invented expansions. Keys are the literal
// term as it appears in the UI.

export const GLOSSARY: Record<string, string> = {
  ENO: "Enfermedades de Notificación Obligatoria — el régimen legal que obliga a reportar ciertas enfermedades a la autoridad sanitaria (rabia, hidatidosis, leptospirosis, leishmaniasis, brucelosis).",
  SLA: "Acuerdo de Nivel de Servicio — el plazo comprometido para completar una acción (por ejemplo, entregar una notificación). 'Vencido' significa que pasó ese plazo.",
  PII: "Información Personal Identificable — datos que permiten identificar a una persona (nombre, DNI, contacto). Su acceso se audita.",
  PPP: "Perro Potencialmente Peligroso — perro de una raza incluida en el régimen legal de tenencia responsable (Ley CABA 4078 / Ley Prov. 14.107).",
  RUPPPA:
    "Registro Único de Perros Potencialmente Peligrosos — el padrón provincial de perros PPP (CABA, Ley 4078).",
  "k<5":
    "Protección de privacidad (k-anonimato): se ocultan las celdas con menos de 5 casos para que un dato agregado no permita identificar a una persona o animal individual.",
  P75: "Percentil 75 — el valor por debajo del cual queda el 75% de los casos. Sirve para ver la 'cola' de casos lentos, no solo el promedio.",
  "no cohorte":
    "No es el seguimiento de un mismo grupo en el tiempo: cada etapa es un conteo independiente, así que una etapa posterior puede superar a una anterior sin que sea un error.",
};

/** Case-insensitive lookup so "eno"/"ENO"/"Eno" all resolve. */
export function lookupGlossary(term: string): string | undefined {
  if (GLOSSARY[term]) return GLOSSARY[term];
  const hit = Object.keys(GLOSSARY).find((k) => k.toLowerCase() === term.toLowerCase());
  return hit ? GLOSSARY[hit] : undefined;
}
