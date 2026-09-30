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
//
// ENVELOPES (viajes-fase-2, design D2): each rule is a `RuleEnvelope` — its
// value AND its provenance in one object, optionally scoped to a species and,
// for document windows, to the document it is about. The requirements that
// Phase 2 could only carry as prose (Chile's microchip and deworming floor,
// the USA minimum dog age) are rule types now, checked against the libreta.

import type { SourceMeta } from "@/lib/domain/travel-freshness";
import type {
  RuleEnvelope,
  TravelDocument,
  TravelRuleEnvelopes,
  TravelSpecies,
} from "@/lib/domain/travel-strictness";

// R3.5 staleness disclaimer — rendered on ALL THREE surfaces (checklist,
// semáforo, exported PDF). es-AR wording pending PO sign-off (design open
// question); the SENASA + consular-authority framing comes from the spec.
export const TRAVEL_DISCLAIMER =
  "Verificá con SENASA y la autoridad consular del destino antes de viajar — esta información puede desactualizarse.";

export const CORRIDOR_IDS = ["chile", "uruguay", "brasil", "ue_espana", "usa"] as const;
export type CorridorId = (typeof CORRIDOR_IDS)[number];

/** Each declared rule, with its own provenance (viajes-fase-2, design D2). */
export type CorridorRules = TravelRuleEnvelopes;

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
  /**
   * Every declared rule carries its own source —
   * scripts/check-travel-reference-freshness.ts fails on one that does not.
   */
  rules: CorridorRules;
}

// Structure-only registry: version 2026.0 marked the citation-pending state.
const SPECIES: readonly TravelSpecies[] = ["dog", "cat"];
const DOGS: readonly TravelSpecies[] = ["dog"];

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
// must be at least 6 months old on entry (CDC).
//
// 2026.3 (viajes-fase-2 Phase 3): no value changed; what changed is what the
// table can SAY. Chile's mandatory microchip, Chile's 5-day deworming floor and
// the USA minimum dog age were carried as prose (`pendingRequirements`) and
// are rule types now (microchip_required, parasite_treatment_min_days_before,
// min_animal_age_days), checked against the libreta. The microchips Uruguay
// (dogs), UE-España and the USA already demanded in `required_documents` are
// declared as microchip_required too, so the libreta is asked about them.
//
// deriveTravelCompliance (lib/projections/travel-compliance.ts) keys the
// "requisitos pendientes de validación oficial" warning off
// `Object.keys(rules).length === 0`; with Chile and Brasil populated, no
// corridor surfaces it any more.
const RULES_VERSION = "2026.3";
const RULES_EFFECTIVE_FROM = "2026-09-30";

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

/** Provenance of a rule verified at `sourceUrl` on LAST_VERIFIED. */
function verifiedAt(sourceUrl: string, note?: string): SourceMeta {
  return {
    sourceUrl,
    lastVerifiedAt: LAST_VERIFIED,
    reviewBy: REVIEW_BY,
    verification: "verified",
    ...(note ? { note } : {}),
  };
}

type EnvelopeScope = {
  note?: string;
  species?: readonly TravelSpecies[];
  document?: TravelDocument;
};

/** A rule value verified at `sourceUrl`, with its scope. */
function rule<V>(value: V, sourceUrl: string, scope: EnvelopeScope = {}): RuleEnvelope<V> {
  return {
    value,
    ...verifiedAt(sourceUrl, scope.note),
    ...(scope.species ? { appliesToSpecies: scope.species } : {}),
    ...(scope.document ? { document: scope.document } : {}),
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
    version: RULES_VERSION,
    effectiveFrom: RULES_EFFECTIVE_FROM,
    sourceUrl: SENASA_CHILE,
    lastVerifiedAt: LAST_VERIFIED,
    reviewBy: REVIEW_BY,
    appliesTo: { species: SPECIES, direction: "outbound_from_ar" },
    rules: {
      // CZI: ingreso dentro de los 10 días desde la emisión, prorrogable 5.
      document_issuance_window_days: rule(10, SENASA_CHILE, {
        document: "senasa_cvi",
        note: "Ingreso dentro de los 10 días desde la emisión del CZI, prorrogable 5 días más.",
      }),
      rabies_vaccination_to_travel_wait_days: rule(21, SENASA_CHILE),
      // Ventana 5–30 días antes del CZI: el techo y el piso son dos reglas.
      parasite_treatment_window_days: rule(30, SENASA_CHILE, {
        note: "Ventana de 5 a 30 días antes del CZI; esta regla es el techo.",
      }),
      parasite_treatment_min_days_before: rule(5, SENASA_CHILE, {
        note: "Antiparasitario interno y externo al menos 5 días antes del CZI; esta regla es el piso.",
      }),
      // Obligatorio desde el 27/07/2026, perros y gatos (microchip o tatuaje ISO).
      microchip_required: rule(true, SENASA_CHILE, {
        note: "Microchip o tatuaje ISO obligatorio para perros y gatos desde el 27/07/2026.",
      }),
      rabies_titer_test_required: rule(false, SENASA_CHILE),
      required_documents: rule(
        [
          "Certificado Zoosanitario de Importación (CZI) — CVI digital SENASA",
          "Microchip ISO 11784/11785 o tatuaje (obligatorio desde el 27/07/2026)",
          "Antiparasitario interno y externo entre 5 y 30 días antes del CZI",
        ],
        SENASA_CHILE,
      ),
      required_vaccines: rule(["Antirrábica"], SENASA_CHILE),
      // Sin cuarentena declarada: el "confinamiento domiciliario de 10 días"
      // no aparece en ninguna fuente oficial ni de prensa — se omite el rule
      // type en lugar de declarar 0.
    },
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
      document_issuance_window_days: rule(60, SENASA_MERCOSUR, { document: "senasa_cvi" }),
      // Primovacunación aplicada >=21 días antes del ingreso.
      rabies_vaccination_to_travel_wait_days: rule(21, SENASA_MERCOSUR),
      // Antiparasitario interno+externo dentro de los 15 días previos al CVI.
      parasite_treatment_window_days: rule(15, SENASA_MERCOSUR),
      rabies_titer_test_required: rule(false, SENASA_MERCOSUR),
      import_permit_required: rule(false, UY_INGRESO),
      // Microchip obligatorio para perros >90 días (Res. 273 DGSG,
      // 27/08/2018) — no exigido para gatos; no hay requisito documentado de
      // que el chip preceda a la vacuna (a diferencia de UE), por eso
      // microchip_before_vaccination_required queda sin declarar.
      microchip_required: rule(true, UY_INGRESO, {
        species: DOGS,
        note: "Perros de más de 90 días (Res. 273 DGSG, 27/08/2018); no se exige a gatos.",
      }),
      required_documents: rule(
        [
          "Certificado Veterinario Internacional (CVI) modelo Mercosur — SENASA",
          "Microchip ISO 11784/11785 (perros >90 días; Res. 273 DGSG)",
          "Antiparasitario interno con praziquantel + externo, hasta 15 días antes del CVI",
          "Test de leishmaniasis negativo (perros >90 días, hasta 60 días antes del ingreso)",
        ],
        UY_INGRESO,
      ),
      required_vaccines: rule(["Antirrábica"], SENASA_MERCOSUR),
      // Sin cuarentena (cuarentena.aplica=false en la fuente) — se omite el
      // rule type en lugar de declarar 0, para no sugerir un requisito de
      // "0 días" donde no existe ninguno.
    },
  },
  {
    // Consultado 2026-09-30. Fuente: SENASA — Requisitos por destino Mercosur
    // (Brasil, Paraguay, Uruguay). Modelo de CVI: Portaria MAPA n.º 741/2024,
    // obligatorio desde el 06/09/2025.
    id: "brasil",
    label: "Brasil",
    jurisdiction: { country: "BR" },
    version: RULES_VERSION,
    effectiveFrom: RULES_EFFECTIVE_FROM,
    sourceUrl: SENASA_MERCOSUR,
    lastVerifiedAt: LAST_VERIFIED,
    reviewBy: REVIEW_BY,
    appliesTo: { species: SPECIES, direction: "outbound_from_ar" },
    rules: {
      // CVI válido 60 días desde la emisión.
      document_issuance_window_days: rule(60, SENASA_MERCOSUR, { document: "senasa_cvi" }),
      rabies_vaccination_to_travel_wait_days: rule(21, SENASA_MERCOSUR),
      // Antirrábica exigida a mascotas de más de 90 días.
      rabies_vaccination_min_age_days: rule(90, SENASA_MERCOSUR),
      parasite_treatment_window_days: rule(15, SENASA_MERCOSUR),
      // Brasil no exige titulación a ningún origen.
      rabies_titer_test_required: rule(false, SENASA_MERCOSUR),
      required_documents: rule(
        [
          "Certificado Veterinario Internacional (CVI) modelo Portaria MAPA n.º 741/2024 — SENASA",
          "Examen clínico hasta 10 días antes de la emisión del CVI",
          "Antiparasitario interno y externo hasta 15 días antes del CVI",
          "Microchip opcional: si está implantado, tiene que figurar en el CVI",
        ],
        SENASA_MERCOSUR,
      ),
      required_vaccines: rule(["Antirrábica"], SENASA_MERCOSUR),
      // Sin cuarentena — se omite el rule type en lugar de declarar 0. El
      // microchip es opcional: microchip_required queda sin declarar.
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
      // Certificado Sanitario UE, emitido por el veterinario oficial de SENASA
      // <=10 días antes de la llegada.
      document_issuance_window_days: rule(10, EU_2026_636, { document: "senasa_cvi" }),
      // >=21 días desde la (primo)vacunación antirrábica antes de viajar.
      rabies_vaccination_to_travel_wait_days: rule(21, EU_2026_636),
      // Vacuna solo válida si el animal tiene >=12 semanas (84 días).
      rabies_vaccination_min_age_days: rule(84, EU_2026_636),
      // Argentina está en el Anexo II — exenta del test de titulación.
      rabies_titer_test_required: rule(false, EU_2026_636),
      import_permit_required: rule(false, EU_2026_636),
      microchip_required: rule(true, EU_2026_636),
      // El microchip DEBE implantarse ANTES de la vacuna antirrábica para
      // que la vacuna cuente — requisito explícito de la fuente.
      microchip_before_vaccination_required: rule(true, EU_2026_636),
      required_documents: rule(
        [
          "Certificado Sanitario UE emitido por veterinario oficial SENASA",
          "Microchip ISO 11784/11785 implantado antes de la vacuna antirrábica",
        ],
        EU_2026_636,
      ),
      required_vaccines: rule(["Antirrábica"], EU_2026_636),
      // Sin cuarentena si se cumple el régimen. Sin antiparasitario
      // obligatorio para España (el tratamiento contra Echinococcus
      // multilocularis solo aplica a Finlandia/Irlanda/Malta/Noruega) — se
      // omiten ambos rule types en lugar de declarar valores nulos/0.
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
    version: RULES_VERSION,
    effectiveFrom: RULES_EFFECTIVE_FROM,
    sourceUrl: CDC_DOGS,
    lastVerifiedAt: LAST_VERIFIED,
    reviewBy: REVIEW_BY,
    appliesTo: { species: SPECIES, direction: "outbound_from_ar" },
    rules: {
      // Certificado Libre de Miasis (screwworm), emitido <=5 días antes del
      // embarque — la ventana es la de ESE certificado, no la del CVI.
      document_issuance_window_days: rule(5, CDC_DOGS, {
        document: "miasis_certificate",
        note: "La ventana de 5 días es la del Certificado Libre de Miasis que emite el veterinario oficial.",
      }),
      // CDC: el perro tiene que tener al menos 6 meses al ingresar. 183 días
      // es la lectura conservadora de "6 meses".
      min_animal_age_days: rule(183, CDC_DOGS, {
        species: DOGS,
        note: "Perros: al menos 6 meses de edad al ingresar a Estados Unidos.",
      }),
      // Microchip legible por escáner universal, exigido por el CDC a perros.
      microchip_required: rule(true, CDC_DOGS, { species: DOGS }),
      rabies_titer_test_required: rule(false, CDC_DOGS),
      required_documents: rule(
        [
          "Certificado Veterinario Internacional (CVI) — SENASA",
          "Certificado Libre de Miasis (screwworm), emitido hasta 5 días antes del embarque",
          "CDC Dog Import Form (online, completado por el dueño; válido 6 meses)",
          "Microchip legible ISO 11784/11785 (detectable por escáner universal)",
        ],
        CDC_DOGS,
      ),
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
