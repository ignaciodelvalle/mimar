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
// REGULATORY DATA STATUS: every corridor carries source-cited rules since
// 2026-09-30 (history below the types). A corridor with `rules: {}` would still
// surface the "requisitos pendientes de validación oficial" warning, so the
// semáforo can never read "verde" off missing data. Bump `version` and
// `effectiveFrom` on any rule-value edit.
//
// FRESHNESS (viajes-fase-2, design D6): every corridor and every declared rule
// carries `sourceUrl`, `lastVerifiedAt` and `reviewBy` (at most 180 days
// later). scripts/check-travel-reference-freshness.ts fails `pnpm verify` on a
// missing or malformed one, and only WARNS when a rule is merely past its
// review date — the calendar never blocks a merge.

import type { SourceMeta, Sourced } from "@/lib/domain/travel-freshness";
import type { TravelRuleType, TravelRuleValueByType } from "@/lib/domain/travel-strictness";

// R3.5 staleness disclaimer — rendered on ALL THREE surfaces (checklist,
// semáforo, exported PDF). es-AR wording pending PO sign-off (design open
// question); the SENASA + consular-authority framing comes from the spec.
export const TRAVEL_DISCLAIMER =
  "Verificá con SENASA y la autoridad consular del destino antes de viajar — esta información puede desactualizarse.";

export const CORRIDOR_IDS = ["chile", "uruguay", "brasil", "ue_espana", "usa"] as const;
export type CorridorId = (typeof CORRIDOR_IDS)[number];

export type CorridorRules = { [K in TravelRuleType]?: TravelRuleValueByType[K] };

/** Provenance of each declared rule (viajes-fase-2, design D6). */
export type CorridorRuleSources = { [K in TravelRuleType]?: SourceMeta };

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
  /** ISO date the corridor as a whole was last checked against its sources. */
  lastVerifiedAt: string;
  /** ISO date after which it must be checked again (TTL: 180 days). */
  reviewBy: string;
  /** Fase 1 is outbound-from-Argentina only (spec R3.4). */
  appliesTo: { species: readonly ("dog" | "cat")[]; direction: "outbound_from_ar" };
  rules: CorridorRules;
  /**
   * Where each declared rule came from. Every key of `rules` has an entry —
   * scripts/check-travel-reference-freshness.ts fails otherwise.
   */
  ruleSources: CorridorRuleSources;
  /**
   * Requirements verified at the source that the rule table cannot express
   * yet: a minimum ANIMAL age, a deworming FLOOR, a mandatory microchip. The
   * rule engine (viajes-fase-2 Phase 3) turns each into a rule type; until then
   * they are carried here, cited, so nothing verified is dropped.
   */
  pendingRequirements?: readonly Sourced<string>[];
}

// Structure-only registry: version 2026.0 marked the citation-pending state.
const SPECIES: readonly ("dog" | "cat")[] = ["dog", "cat"];

// PO gate PARTIALLY resolved (2026-07-18): the research package
// (datos-investigados-2026-07-18/corredores-transfronterizos.json) source-cited
// rule values for Uruguay, UE-España and USA.
//
// FULLY resolved (2026-09-30): the destination-country research of that date
// settled both discrepancies that had kept Chile and Brasil at `rules: {}`.
//   · Chile — the two microchip dates are the SAME measure announced by two
//     administrations (SENASA 28/06/2026 on the Argentine side, SAG 27/07/2026
//     on the Chilean side): the chip is mandatory. The "10-day home
//     confinement" appears in no official or press source; quarantine is left
//     undeclared, not 0.
//   · Brasil — the microchip is OPTIONAL (it must appear on the CVI if
//     implanted) and the CVI is valid 60 days, as for the rest of Mercosur.
// The same pass reconfirmed every Uruguay, UE-España and USA value against its
// primary source, and found one requirement the USA corridor lacked: a dog
// must be at least 6 months old on entry (CDC) — carried in
// `pendingRequirements` until the rule table has a minimum-animal-age type.
//
// deriveTravelCompliance (lib/projections/travel-compliance.ts) keys the
// "requisitos pendientes de validación oficial" warning off
// `Object.keys(rules).length === 0`; with Chile and Brasil populated, no
// corridor surfaces it any more.
const RULES_VERSION = "2026.1";
const RULES_EFFECTIVE_FROM = "2026-07-18";
const CORRECTED_VERSION = "2026.2";
const CORRECTED_EFFECTIVE_FROM = "2026-09-30";

// Every corridor value was checked against its source on this date.
const LAST_VERIFIED = "2026-09-30";
// LAST_VERIFIED + 180 days (FRESHNESS_TTL_DAYS.country).
const REVIEW_BY = "2027-03-29";

const SENASA_CHILE =
  "https://www.argentina.gob.ar/senasa/requisitos-particulares-por-destino/chile";
const SENASA_MERCOSUR =
  "https://www.argentina.gob.ar/senasa/requisitos-particulares-por-destino/mercosur-brasil-paraguay-uruguay";
const UY_INGRESO = "https://www.gub.uy/tramites/solicitud-ingreso-mascotas-uruguay";
const EU_2026_636 = "https://eur-lex.europa.eu/legal-content/ES/TXT/HTML/?uri=OJ%3AL_202600636";
const CDC_DOGS = "https://www.cdc.gov/importation/dogs/rabies-free-low-risk-countries.html";

/** A rule verified at `sourceUrl` on LAST_VERIFIED. */
function verifiedAt(sourceUrl: string, note?: string): SourceMeta {
  return {
    sourceUrl,
    lastVerifiedAt: LAST_VERIFIED,
    reviewBy: REVIEW_BY,
    verification: "verified",
    ...(note ? { note } : {}),
  };
}

export const CORRIDORS: readonly Corridor[] = [
  {
    // Consultado 2026-09-30. Fuente: SENASA — Requisitos por destino, Chile.
    // Confirmación del lado chileno (SAG, 07/07/2026, vía prensa):
    // https://www.biobiochile.cl/noticias/nacional/chile/2026/07/07/sag-entrega-detalles-sobre-nuevos-requisitos-zoosanitarios-para-ingreso-de-perros-y-gatos-a-chile.shtml
    id: "chile",
    label: "Chile",
    jurisdiction: { country: "CL" },
    version: CORRECTED_VERSION,
    effectiveFrom: CORRECTED_EFFECTIVE_FROM,
    sourceUrl: SENASA_CHILE,
    lastVerifiedAt: LAST_VERIFIED,
    reviewBy: REVIEW_BY,
    appliesTo: { species: SPECIES, direction: "outbound_from_ar" },
    rules: {
      // CZI: ingreso dentro de los 10 días desde la emisión, prorrogable 5.
      document_issuance_window_days: 10,
      rabies_vaccination_to_travel_wait_days: 21,
      // Techo de la ventana 5–30 días antes del CZI. El PISO (5) no tiene
      // rule type todavía — ver pendingRequirements.
      parasite_treatment_window_days: 30,
      rabies_titer_test_required: false,
      required_documents: [
        "Certificado Zoosanitario de Importación (CZI) — CVI digital SENASA",
        "Microchip ISO 11784/11785 o tatuaje (obligatorio desde el 27/07/2026)",
        "Antiparasitario interno y externo entre 5 y 30 días antes del CZI",
      ],
      required_vaccines: ["Antirrábica"],
      // Sin cuarentena declarada: el "confinamiento domiciliario de 10 días"
      // no aparece en ninguna fuente oficial ni de prensa — se omite el rule
      // type en lugar de declarar 0.
    },
    ruleSources: {
      document_issuance_window_days: verifiedAt(
        SENASA_CHILE,
        "Ingreso dentro de los 10 días desde la emisión del CZI, prorrogable 5 días más.",
      ),
      rabies_vaccination_to_travel_wait_days: verifiedAt(SENASA_CHILE),
      parasite_treatment_window_days: verifiedAt(
        SENASA_CHILE,
        "Ventana de 5 a 30 días antes del CZI; acá solo el techo.",
      ),
      rabies_titer_test_required: verifiedAt(SENASA_CHILE),
      required_documents: verifiedAt(SENASA_CHILE),
      required_vaccines: verifiedAt(SENASA_CHILE),
    },
    pendingRequirements: [
      {
        value: "Microchip o tatuaje ISO obligatorio para perros y gatos desde el 27/07/2026",
        ...verifiedAt(SENASA_CHILE),
      },
      {
        value: "Antiparasitario interno y externo al menos 5 días antes del CZI",
        ...verifiedAt(SENASA_CHILE),
      },
    ],
  },
  {
    // Consultado 2026-07-18 y reconfirmado sin cambios 2026-09-30. Fuentes:
    // SENASA — Requisitos por destino Mercosur + Uruguay gub.uy — Solicitud de
    // ingreso con mascotas (MGAP/DGSG).
    id: "uruguay",
    label: "Uruguay",
    jurisdiction: { country: "UY" },
    version: RULES_VERSION,
    effectiveFrom: RULES_EFFECTIVE_FROM,
    sourceUrl: UY_INGRESO,
    lastVerifiedAt: LAST_VERIFIED,
    reviewBy: REVIEW_BY,
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
    ruleSources: {
      document_issuance_window_days: verifiedAt(SENASA_MERCOSUR),
      rabies_vaccination_to_travel_wait_days: verifiedAt(SENASA_MERCOSUR),
      parasite_treatment_window_days: verifiedAt(SENASA_MERCOSUR),
      rabies_titer_test_required: verifiedAt(SENASA_MERCOSUR),
      import_permit_required: verifiedAt(UY_INGRESO),
      required_documents: verifiedAt(UY_INGRESO),
      required_vaccines: verifiedAt(SENASA_MERCOSUR),
    },
  },
  {
    // Consultado 2026-09-30. Fuente: SENASA — Requisitos por destino Mercosur
    // (Brasil, Paraguay, Uruguay). Modelo de CVI: Portaria MAPA n.º 741/2024,
    // obligatorio desde el 06/09/2025.
    id: "brasil",
    label: "Brasil",
    jurisdiction: { country: "BR" },
    version: CORRECTED_VERSION,
    effectiveFrom: CORRECTED_EFFECTIVE_FROM,
    sourceUrl: SENASA_MERCOSUR,
    lastVerifiedAt: LAST_VERIFIED,
    reviewBy: REVIEW_BY,
    appliesTo: { species: SPECIES, direction: "outbound_from_ar" },
    rules: {
      // CVI válido 60 días desde la emisión.
      document_issuance_window_days: 60,
      rabies_vaccination_to_travel_wait_days: 21,
      // Antirrábica exigida a mascotas de más de 90 días.
      rabies_vaccination_min_age_days: 90,
      parasite_treatment_window_days: 15,
      // Brasil no exige titulación a ningún origen.
      rabies_titer_test_required: false,
      required_documents: [
        "Certificado Veterinario Internacional (CVI) modelo Portaria MAPA n.º 741/2024 — SENASA",
        "Examen clínico hasta 10 días antes de la emisión del CVI",
        "Antiparasitario interno y externo hasta 15 días antes del CVI",
        "Microchip opcional: si está implantado, tiene que figurar en el CVI",
      ],
      required_vaccines: ["Antirrábica"],
      // Sin cuarentena — se omite el rule type en lugar de declarar 0.
    },
    ruleSources: {
      document_issuance_window_days: verifiedAt(SENASA_MERCOSUR),
      rabies_vaccination_to_travel_wait_days: verifiedAt(SENASA_MERCOSUR),
      rabies_vaccination_min_age_days: verifiedAt(SENASA_MERCOSUR),
      parasite_treatment_window_days: verifiedAt(SENASA_MERCOSUR),
      rabies_titer_test_required: verifiedAt(SENASA_MERCOSUR),
      required_documents: verifiedAt(SENASA_MERCOSUR),
      required_vaccines: verifiedAt(SENASA_MERCOSUR),
    },
  },
  {
    // Consultado 2026-07-18 y reconfirmado sin cambios 2026-09-30. Fuente
    // clave (titulación): Reglamento de Ejecución (UE) 2026/636 (20/03/2026),
    // Anexo II (lista "AR - Argentina") + SENASA — Requisitos por destino UE +
    // MAPA España — Viajar con la mascota.
    //
    // Punto crítico: Argentina NO necesita test de titulación de rabia — es
    // tercer país LISTADO en el Anexo II, exento del análisis de anticuerpos
    // que sí aplica a países no listados. rabies_titer_test_required queda
    // en false por esto (no por falta de dato).
    //
    // Sin codificar: la validez del certificado para circular DENTRO de la UE
    // (4 meses o hasta el vencimiento de la vacuna) y la ley de razas
    // peligrosas por comunidad autónoma española — ninguno mapea a un rule
    // type.
    id: "ue_espana",
    label: "Unión Europea (España)",
    jurisdiction: { country: "ES", region: "UE" },
    version: RULES_VERSION,
    effectiveFrom: RULES_EFFECTIVE_FROM,
    sourceUrl: EU_2026_636,
    lastVerifiedAt: LAST_VERIFIED,
    reviewBy: REVIEW_BY,
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
    ruleSources: {
      document_issuance_window_days: verifiedAt(EU_2026_636),
      rabies_vaccination_to_travel_wait_days: verifiedAt(EU_2026_636),
      rabies_vaccination_min_age_days: verifiedAt(EU_2026_636),
      rabies_titer_test_required: verifiedAt(EU_2026_636),
      import_permit_required: verifiedAt(EU_2026_636),
      microchip_before_vaccination_required: verifiedAt(EU_2026_636),
      required_documents: verifiedAt(EU_2026_636),
      required_vaccines: verifiedAt(EU_2026_636),
    },
  },
  {
    // Consultado 2026-07-18 y reconfirmado 2026-09-30. Fuentes: CDC — Entry
    // Requirements for Dogs from Dog-Rabies-Free or Low-Risk Countries (rev.
    // 2024-07-22, vigente desde 2024-08-01) + SENASA — EE.UU. + USDA-APHIS —
    // Bring a Pet From Another Country.
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
    // import_permit_required queda SIN declarar (no false): la línea
    // "Import Permit" de la página EE.UU. de SENASA sigue sin confirmar contra
    // USDA-APHIS. No fabricar un valor con más confianza de la que tiene la
    // fuente.
    id: "usa",
    label: "Estados Unidos",
    jurisdiction: { country: "US" },
    version: CORRECTED_VERSION,
    effectiveFrom: CORRECTED_EFFECTIVE_FROM,
    sourceUrl: CDC_DOGS,
    lastVerifiedAt: LAST_VERIFIED,
    reviewBy: REVIEW_BY,
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
    ruleSources: {
      document_issuance_window_days: verifiedAt(
        CDC_DOGS,
        "La ventana de 5 días es la del Certificado Libre de Miasis que emite el veterinario oficial.",
      ),
      rabies_titer_test_required: verifiedAt(CDC_DOGS),
      required_documents: verifiedAt(CDC_DOGS),
    },
    pendingRequirements: [
      {
        value: "Perros: al menos 6 meses de edad al ingresar a Estados Unidos",
        ...verifiedAt(CDC_DOGS),
      },
    ],
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
