// Cross-border corridor reference data (movilidad-jurisdiccional Fase 1).
//
// Spec R3.1: corridor data lives in CODE (sibling to disease-legal-anchors.ts,
// same "not a database table, regulations change rarely" rationale),
// version-tracked by git history — NOT in govt_business_rules for Fase 1.
//
// Spec R3.3: EXACTLY 5 corridors exist — Chile, Uruguay, Brasil, UE-España,
// USA. The load-time coverage check below throws on any other registry
// content. This is the enforcement mechanism for "never a world engine":
// adding a 6th corridor requires editing assertCorridorCoverage, making scope
// creep visible in review, not silent.
//
// ⚠ REGULATORY DATA STATUS (PO gate — do not remove until resolved):
// Corridor requirement CONTENT (window days, wait days, quarantine, document
// lists) is regulatory data that needs source-cited validation by the product
// owner before it can be shipped. Fase 1 ships the corridor STRUCTURE with
// `rules: {}` (citation-pending) — values are intentionally EMPTY rather than
// fabricated. The aggregation surfaces an explicit "requisitos pendientes de
// validación oficial" warning for a corridor with no validated rules, so the
// semáforo can never read "verde" off missing data.
// TODO(PO): populate `rules` per corridor with per-value citations, bump
// `version` and `effectiveFrom` on each edit.

import type { TravelRuleType, TravelRuleValueByType } from "@/lib/domain/travel-strictness";

// R3.5 staleness disclaimer — rendered on ALL THREE surfaces (checklist,
// semáforo, exported PDF). es-AR wording pending PO sign-off (design open
// question); the SENASA + consular-authority framing comes from the spec.
export const TRAVEL_DISCLAIMER =
  "Verificá con SENASA y la autoridad consular del destino antes de viajar — esta información puede desactualizarse.";

export const CORRIDOR_IDS = ["chile", "uruguay", "brasil", "ue_espana", "usa"] as const;
export type CorridorId = (typeof CORRIDOR_IDS)[number];

export type CorridorRules = { [K in TravelRuleType]?: TravelRuleValueByType[K] };

export interface Corridor {
  id: CorridorId;
  /** es-AR display name. */
  label: string;
  /** Destination descriptor. */
  jurisdiction: { country: string; region?: string };
  /** Bumped on ANY rule-value edit (spec R3.2). */
  version: string;
  /** ISO date — when this version's values took effect. */
  effectiveFrom: string;
  /** Citation for the authority/regulation this corridor encodes. */
  sourceUrl: string;
  /** Fase 1 is outbound-from-Argentina only (spec R3.4). */
  appliesTo: { species: readonly ("dog" | "cat")[]; direction: "outbound_from_ar" };
  rules: CorridorRules;
}

// Structure-only registry: version 2026.0 marks the citation-pending state.
// sourceUrl points at the destination authority responsible for the corridor's
// entry requirements (real agencies; exact regulation citations pending PO).
const STRUCTURE_VERSION = "2026.0";
const STRUCTURE_EFFECTIVE_FROM = "2026-07-04";
const SPECIES: readonly ("dog" | "cat")[] = ["dog", "cat"];

// PO gate PARTIALLY resolved (2026-07-18): the research package
// (datos-investigados-2026-07-18/corredores-transfronterizos.json) source-cites
// rule values for the 3 corridors the package calls "más sólidos para
// arrancar" — Uruguay, UE-España, USA. Chile and Brasil are left at
// `rules: {}` (STRUCTURE_VERSION) because the package flags open
// discrepancies for both (Chile: microchip-mandate effective date conflict
// SAG 27/07/2026 vs SENASA 28/06/2026, plus an unconfirmed 10-day home
// confinement; Brasil: microchip requirement and CVI validity window both
// "verificar") — populating them now would fabricate confidence the source
// itself does not have. `assertCorridorCoverage` still requires all 5 ids
// with a sourceUrl regardless of `rules` contents, and
// deriveTravelCompliance (lib/projections/travel-compliance.ts) keys the
// "requisitos pendientes de validación oficial" warning off
// `Object.keys(rules).length === 0` — so Chile/Brasil keep surfacing that
// warning unchanged; Uruguay/UE-España/USA stop surfacing it once rules load.
const RULES_VERSION = "2026.1";
const RULES_EFFECTIVE_FROM = "2026-07-18";

export const CORRIDORS: readonly Corridor[] = [
  {
    id: "chile",
    label: "Chile",
    jurisdiction: { country: "CL" },
    version: STRUCTURE_VERSION,
    effectiveFrom: STRUCTURE_EFFECTIVE_FROM,
    sourceUrl: "https://www.sag.gob.cl",
    appliesTo: { species: SPECIES, direction: "outbound_from_ar" },
    rules: {},
  },
  {
    // Consultado 2026-07-18. Fuentes: SENASA — Requisitos por destino Mercosur
    // (act. 2026-04-17) https://www.argentina.gob.ar/senasa/requisitos-particulares-por-destino/mercosur-brasil-paraguay-uruguay
    // + Uruguay gub.uy — Solicitud de ingreso con mascotas (MGAP/DGSG, act.
    // 2026-01-30) https://www.gub.uy/tramites/solicitud-ingreso-mascotas-uruguay
    // Confianza ALTA — sin flags "verificar" en la fuente para este corredor.
    id: "uruguay",
    label: "Uruguay",
    jurisdiction: { country: "UY" },
    version: RULES_VERSION,
    effectiveFrom: RULES_EFFECTIVE_FROM,
    sourceUrl: "https://www.gub.uy/tramites/solicitud-ingreso-mascotas-uruguay",
    appliesTo: { species: SPECIES, direction: "outbound_from_ar" },
    rules: {
      // CVI válido 60 días desde emisión (examen clínico dentro de los 10
      // días previos a la emisión — ese es el paso más ajustado, pero el
      // dato modelable de "ventana de emisión" es la validez del CVI).
      document_issuance_window_days: 60,
      // Primovacunación aplicada >=21 días antes del ingreso.
      rabies_vaccination_to_travel_wait_days: 21,
      // Antiparasitario interno+externo dentro de los 15 días previos al CVI.
      parasite_treatment_window_days: 15,
      rabies_titer_test_required: false,
      import_permit_required: false,
      // Microchip obligatorio para perros >90 días (Res. 273 DGSG,
      // 27/08/2018) — no exigido para gatos; no hay requisito documentado de
      // que el chip preceda a la vacuna (a diferencia de UE), por eso
      // microchip_before_vaccination_required queda sin declarar.
      required_documents: [
        "Certificado Veterinario Internacional (CVI) modelo Mercosur — SENASA",
        "Microchip ISO 11784/11785 (perros >90 días; Res. 273 DGSG)",
        "Antiparasitario interno con praziquantel + externo, hasta 15 días antes del CVI",
        "Test de leishmaniasis negativo (perros >90 días, hasta 60 días antes del ingreso)",
      ],
      required_vaccines: ["Antirrábica"],
      // Sin cuarentena (cuarentena.aplica=false en la fuente) — se omite el
      // rule type en lugar de declarar 0, para no sugerir un requisito de
      // "0 días" donde no existe ninguno.
    },
  },
  {
    id: "brasil",
    label: "Brasil",
    jurisdiction: { country: "BR" },
    version: STRUCTURE_VERSION,
    effectiveFrom: STRUCTURE_EFFECTIVE_FROM,
    sourceUrl: "https://www.gov.br/agricultura",
    appliesTo: { species: SPECIES, direction: "outbound_from_ar" },
    rules: {},
  },
  {
    // Consultado 2026-07-18. Fuente clave (titulación): Reglamento de
    // Ejecución (UE) 2026/636 (20/03/2026), Anexo II (lista "AR -
    // Argentina") https://eur-lex.europa.eu/legal-content/ES/TXT/HTML/?uri=OJ%3AL_202600636
    // + SENASA — Requisitos por destino UE + MAPA España — Viajar con la
    // mascota. Confianza ALTA (titulación verificada contra el reglamento
    // primario). sourceUrl actualizada del Reg. 576/2013 (legacy) al
    // Reglamento de Ejecución 2026/636 vigente, que es el que lista a
    // Argentina en el Anexo II.
    //
    // Punto crítico: Argentina NO necesita test de titulación de rabia — es
    // tercer país LISTADO en el Anexo II, exento del análisis de anticuerpos
    // que sí aplica a países no listados. rabies_titer_test_required queda
    // en false por esto (no por falta de dato).
    //
    // flags "verificar" del research (NO codificados por incertidumbre):
    // validez del certificado de circulación interno UE (6 vs 4 meses según
    // la fuente) y ley de razas peligrosas por comunidad autónoma española —
    // ninguno de los 2 mapea a un TravelRuleType de Fase 1.
    id: "ue_espana",
    label: "Unión Europea (España)",
    jurisdiction: { country: "ES", region: "UE" },
    version: RULES_VERSION,
    effectiveFrom: RULES_EFFECTIVE_FROM,
    sourceUrl: "https://eur-lex.europa.eu/legal-content/ES/TXT/HTML/?uri=OJ%3AL_202600636",
    appliesTo: { species: SPECIES, direction: "outbound_from_ar" },
    rules: {
      // Certificado Sanitario UE emitido <=10 días antes de la llegada.
      document_issuance_window_days: 10,
      // >=21 días desde la (primo)vacunación antirrábica antes de viajar.
      rabies_vaccination_to_travel_wait_days: 21,
      // Vacuna solo válida si el animal tiene >=12 semanas (84 días).
      rabies_vaccination_min_age_days: 84,
      // Argentina está en el Anexo II — exenta del test de titulación.
      rabies_titer_test_required: false,
      import_permit_required: false,
      // El microchip DEBE implantarse ANTES de la vacuna antirrábica para
      // que la vacuna cuente — requisito explícito de la fuente.
      microchip_before_vaccination_required: true,
      required_documents: [
        "Certificado Sanitario UE emitido por veterinario oficial SENASA",
        "Microchip ISO 11784/11785 implantado antes de la vacuna antirrábica",
      ],
      required_vaccines: ["Antirrábica"],
      // Sin cuarentena si se cumple el régimen. Sin antiparasitario
      // obligatorio para España (el tratamiento contra Echinococcus
      // multilocularis solo aplica a Finlandia/Irlanda/Malta/Noruega) — se
      // omiten ambos rule types en lugar de declarar valores nulos/0.
    },
  },
  {
    // Consultado 2026-07-18. Fuentes: CDC — Entry Requirements for Dogs from
    // Dog-Rabies-Free or Low-Risk Countries (rev. 2024-07-22, vigente desde
    // 2024-08-01) https://www.cdc.gov/importation/dogs/rabies-free-low-risk-countries.html
    // + SENASA — EE.UU. (act. 2025-09-25) + USDA-APHIS — Bring a Pet From
    // Another Country (act. 2026-03-19). Confianza ALTA en reglas
    // CDC/perros; MEDIA en la línea "Import Permit" de SENASA.
    //
    // Argentina está clasificada por el CDC como país libre/de bajo riesgo
    // de rabia canina → CDC NO exige vacuna antirrábica ni titulación para
    // un perro que solo estuvo en países de bajo riesgo en los últimos 6
    // meses (proceso simplificado vigente desde 2024-08-01). Por eso NO se
    // declara rabies_vaccination_to_travel_wait_days ni
    // rabies_vaccination_min_age_days para este corredor (SENASA igual
    // exige la vacuna vigente en el CVI del lado argentino, pero eso no es
    // un requisito de ingreso a EE.UU.).
    //
    // import_permit_required queda SIN declarar (no false): la fuente marca
    // explícitamente "verificar" — la línea "Import Permit" de la página
    // EE.UU. de SENASA no está confirmada contra USDA-APHIS. No fabricar un
    // valor con más confianza de la que tiene la fuente.
    id: "usa",
    label: "Estados Unidos",
    jurisdiction: { country: "US" },
    version: RULES_VERSION,
    effectiveFrom: RULES_EFFECTIVE_FROM,
    sourceUrl: "https://www.cdc.gov/importation/dogs/rabies-free-low-risk-countries.html",
    appliesTo: { species: SPECIES, direction: "outbound_from_ar" },
    rules: {
      // Certificado Libre de Miasis (screwworm), emitido <=5 días antes del
      // embarque — la ventana de emisión más ajustada de las exigidas.
      document_issuance_window_days: 5,
      rabies_titer_test_required: false,
      required_documents: [
        "Certificado Veterinario Internacional (CVI) — SENASA",
        "Certificado Libre de Miasis (screwworm), emitido hasta 5 días antes del embarque",
        "CDC Dog Import Form (online, completado por el dueño; válido 6 meses)",
        "Microchip legible ISO 11784/11785 (detectable por escáner universal)",
      ],
      // Sin cuarentena federal (SENASA sugiere separar al perro del ganado
      // 5 días por precaución screwworm — no es una cuarentena formal, no se
      // modela como quarantine_days_required).
    },
  },
];

/**
 * S8 hard bound: throws unless `corridors` contains EXACTLY the 5 registered
 * ids (no more, no fewer, no duplicates) and every corridor carries a
 * citation sourceUrl. Same throw-at-load pattern as disease-legal-anchors.ts.
 */
export function assertCorridorCoverage(corridors: readonly Corridor[]): void {
  const ids = corridors.map((c) => c.id);
  const expected = [...CORRIDOR_IDS].sort();
  const actual = [...ids].sort();
  if (
    actual.length !== expected.length ||
    actual.some((id, i) => id !== expected[i]) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error(
      `lib/reference/cross-border-corridors.ts: corridor registry must contain exactly {${expected.join(", ")}} — got {${ids.join(", ")}}. Fase 1 is 5 corridors ONLY (spec R3.3); a new corridor requires a spec update first.`,
    );
  }
  const missingSource = corridors.filter(
    (c) => !c.sourceUrl || !c.sourceUrl.startsWith("https://"),
  );
  if (missingSource.length > 0) {
    throw new Error(
      `lib/reference/cross-border-corridors.ts: corridor(s) without a citation sourceUrl: ${missingSource.map((c) => c.id).join(", ")}`,
    );
  }
}

export function getCorridor(id: CorridorId): Corridor {
  const corridor = CORRIDORS.find((c) => c.id === id);
  if (!corridor) {
    // Unreachable while the load-time check holds; kept as a hard failure so
    // a future regression cannot silently return undefined.
    throw new Error(`Unknown corridor id: ${id}`);
  }
  return corridor;
}

// Static load-time check (S8) — mirrors disease-legal-anchors.ts.
void assertCorridorCoverage(CORRIDORS);
