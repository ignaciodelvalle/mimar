// Airline pet-transport policies (viajes-fase-2, design D1).
//
// WHAT THIS IS. The 20 airlines an owner flying out of Argentina is most likely
// to use, and what each one publishes about carrying a dog or a cat: which
// modality it offers (cabin, hold, cargo), weight, minimum age, breed
// restrictions, the documents it checks at the counter, embargoes and booking
// lead time. Reference data in CODE, like the corridors: it changes by an
// airline's decision, not by an owner's action, and git history is its audit.
//
// EVERY LEAF CARRIES ITS SOURCE. `Sourced<T>` (lib/domain/travel-freshness.ts):
// the public URL it was read from, when, until when that reading holds (90
// days — airlines change policy often: GOL suspended its hold in 2024, ITA
// changed twice in 2025), and whether it was confirmed against the airline's
// own page. Many were not: several airlines answer 403 to automated readers,
// and some figures come only from a search engine's indexed excerpt or from a
// third-party aggregator. Those are `verification: "unverified"` with a `note`
// saying which, and the UI never presents them as certain ("Verificá con tu
// aerolínea"). A field the research could not establish at all is OMITTED,
// never guessed.
//
// BREED RESTRICTIONS HAVE THREE KINDS that must not be merged into one flag:
//   · brachycephalic — a physiology, not a list; points at miMAR's curated
//     BRACHYCEPHALIC_LIST (lib/reference/brachycephalic-breeds.ts);
//   · dangerous_list — an airline's "razas peligrosas" policy list;
//   · airline_veto   — one airline's own ban on named breeds.
// Named breeds use the breed CATALOGUE's labels so `resolveBreedLabel` can match
// them; breeds an airline names that the catalogue does not have are kept in
// `offCatalogue`, verbatim, so they are not silently lost.
//
// Freshness is fenced by scripts/check-travel-reference-freshness.ts.

import type { SourceMeta, Sourced } from "@/lib/domain/travel-freshness";
import type { CorridorId } from "@/lib/reference/cross-border-corridors";

export const AIRLINE_IDS = [
  "aerolineas_argentinas",
  "flybondi",
  "jetsmart",
  "latam",
  "gol",
  "sky",
  "american",
  "united",
  "delta",
  "iberia",
  "air_europa",
  "air_france",
  "klm",
  "lufthansa",
  "ita",
  "turkish",
  "emirates",
  "qatar",
  "copa",
  "avianca",
] as const;
export type AirlineId = (typeof AIRLINE_IDS)[number];

export type Modality = "cabin" | "hold" | "cargo";
export type PetSpecies = "dog" | "cat";

export type BreedRestriction = {
  kind: "brachycephalic" | "dangerous_list" | "airline_veto";
  /** Catalogue labels, or the curated brachycephalic list. */
  breeds: "BRACHYCEPHALIC_LIST" | readonly string[];
  /** Breeds the airline names that the catalogue does not list, verbatim. */
  offCatalogue?: readonly string[];
  appliesTo: readonly Modality[];
  effect: "banned" | "muzzle" | "cabin_only";
};

export type AirlineDocument =
  | "vet_health_certificate"
  | "rabies_certificate"
  | "senasa_cvi"
  | "senasa_boarding_permit"
  | "airline_form";

export type RequiredDocument = {
  doc: AirlineDocument;
  /** Issued at most this many days before the flight. */
  maxDaysBeforeFlight?: number;
  /** A dose applied at least this many days before the flight. */
  minDaysSinceDose?: number;
  /** A dose applied at most this many days before the flight. */
  maxDaysSinceDose?: number;
};

export type Embargo = {
  kind: "seasonal" | "temperature" | "route";
  /** MM-DD, for seasonal embargoes. */
  from?: string;
  to?: string;
  note: string;
};

export type MinAge = {
  /** Minimum age in days. */
  default: number;
  /** Minimum on international flights, when it differs. */
  international?: number;
  byCorridor?: Partial<Record<CorridorId, number>>;
};

export interface AirlineModalityRule {
  offered: Sourced<"yes" | "no" | "restricted">;
  species?: Sourced<readonly PetSpecies[]>;
  maxWeightKg?: Sourced<{ kg: number; includesCarrier: boolean }>;
  /** Carrier dimensions, informational only. */
  carrierCm?: Sourced<string>;
  minAgeDays?: Sourced<MinAge>;
  breedRestrictions?: Sourced<readonly BreedRestriction[]>;
  requiredDocuments?: Sourced<readonly RequiredDocument[]>;
  embargoes?: Sourced<readonly Embargo[]>;
  bookingLeadHours?: Sourced<number>;
}

export interface Airline {
  id: AirlineId;
  name: string;
  iata: string;
  /** Which of its flights the pet policy covers for an owner leaving Argentina. */
  scope: "domestic_ar" | "international";
  /** The airline's main pet-policy page. */
  sourceUrl: string;
  lastVerifiedAt: string;
  reviewBy: string;
  modalities: Partial<Record<Modality, AirlineModalityRule>>;
}

// Every value below was read on this date.
const LAST_VERIFIED = "2026-09-30";
// LAST_VERIFIED + 90 days (FRESHNESS_TTL_DAYS.airline).
const REVIEW_BY = "2026-12-29";

const NOTE_403 = "La página oficial respondió 403 al leerla; dato tomado del fragmento indexado.";
const NOTE_INDEXED =
  "Lectura directa de la página oficial no confirmada; dato del fragmento indexado.";
const NOTE_THIRD_PARTY =
  "No se pudo leer la página oficial; dato de agregadores de terceros, sin confirmar contra la fuente primaria.";

function meta(sourceUrl: string): Pick<SourceMeta, "sourceUrl" | "lastVerifiedAt" | "reviewBy"> {
  return { sourceUrl, lastVerifiedAt: LAST_VERIFIED, reviewBy: REVIEW_BY };
}

/** A value confirmed against `sourceUrl`. */
function verified<T>(value: T, sourceUrl: string, note?: string): Sourced<T> {
  return { value, ...meta(sourceUrl), verification: "verified", ...(note ? { note } : {}) };
}

/** A value NOT confirmed against the source itself — `note` says why. */
function unverified<T>(value: T, sourceUrl: string, note: string): Sourced<T> {
  return { value, ...meta(sourceUrl), verification: "unverified", note };
}

const DOG_CAT: readonly PetSpecies[] = ["dog", "cat"];

/** Iberia's "razas peligrosas" list — Air Europa applies the same one. */
const IBERIA_DANGEROUS_BREEDS: readonly string[] = [
  "Pit Bull Terrier",
  "Staffordshire Bull Terrier",
  "American Staffordshire Terrier",
  "Rottweiler",
  "Dogo Argentino",
  "Fila Brasileiro",
  "Tosa Inu",
  "Akita Inu",
];

// --- Sources ----------------------------------------------------------------
const AR_PETS = "https://www.aerolineas.com.ar/informacion-util/mascotas";
const AR_CARGO = "https://cargo.aerolineas.com.ar/es-AR/envios_personales";
const FO_CABIN =
  "https://ayuda.flybondi.com/es-419/article/81-puedo-viajar-con-mi-mascota-en-cabina-en-vuelos-nacionales";
const FO_PETS = "https://flybondi.com/ar/viajaconmascota";
const JA_BLOG = "https://www.dudimascotas.com.ar/blog/posts/jetsmart-mascotas-cabina-c5dc9a0d0480/";
// JetSMART's help centre, the stable entry point to its policies. The
// regulations themselves are a PDF (Regulaciones, 15/11/2022) whose asset URL
// is built from CMS ids, which are not a stable address — and whose
// UUID-shaped segments lint:uuid rightly refuses in source.
const JA_RULES = "https://jetsmart.com/co/es/centro-de-ayuda";
const JA_RULES_NOTE =
  "Dato de las Regulaciones oficiales en PDF (15/11/2022), enlazadas desde el centro de ayuda regional; pueden estar desactualizadas y no son específicas de Argentina.";
const LA_PETS =
  "https://www.latamairlines.com/ar/es/centro-ayuda/preguntas/mascotas/transporte/viaje-avion";
const G3_CABIN = "https://www.voegol.com.br/en/nh/dog-cat-cabine";
const G3_HOLD =
  "https://www.cnnbrasil.com.br/nacional/gol-mantem-suspensao-de-transporte-de-animais-no-porao-das-aeronaves/";
const H2_BLOG = "https://blog.skyairline.com/mascotas-en-cabina/";
const AA_PETS = "https://www.aa.com/web/i18n/travel-info/special-assistance/pets.html";
const UA_PETS = "https://www.united.com/en/us/fly/travel/special-travel/pets.html";
const DL_PETS =
  "https://www.delta.com/content/www/en_US/traveling-with-us/special-travel-needs/pets/pet-requirements-restrictions.html";
const IB_PETS = "https://www.iberia.com/us/fly-with-iberia/pets/";
const UX_PETS = "https://www.aireuropa.com/us/en/aea/travel-information/passengers/pets.html";
const AF_PETS = "https://www.pettravel.com/information/airlines/air-france-pet-policy/";
const KL_PETS = "https://www.klm.com/information/pets/reservation";
const LH_PETS = "https://www.pettravel.com/information/airlines/lufthansa-pet-policy/";
const AZ_CABIN =
  "https://www.ita-airways.com/ch/it/book-and-prepare/other-requests/travelling-with-pets/pets-in-cabin";
const AZ_HOLD =
  "https://www.ita-airways.com/it/it/book-and-prepare/other-requests/travelling-with-pets/pets-as-cargo";
const TK_PETS = "https://www.turkishairlines.com/en-cl/any-questions/traveling-with-pets/";
const EK_PETS = "https://www.skycargo.com/products/live/pets/";
const QR_PETS = "https://www.qatarairways.com/en/help/submit-request-form/carriage-of-pets.html";
const CM_PETS =
  "https://www.copaair.com/assets/esp-com-24-027-actualizacion-politica-transporte-perro-servicio-apoyo-emocional-mascota-cabina.pdf";
const AV_PETS = "https://www.avianca.com/en/information-and-help/pet-transport/";

// Ages, in days.
const WEEKS_8 = 56;
const WEEKS_10 = 70;
const WEEKS_12 = 84;
const WEEKS_16 = 112;
const MONTHS_2 = 60;
const MONTHS_3 = 90;
const MONTHS_4 = 120;
const MONTHS_6 = 183;

export const AIRLINES: readonly Airline[] = [
  {
    id: "aerolineas_argentinas",
    name: "Aerolíneas Argentinas",
    iata: "AR",
    scope: "international",
    ...meta(AR_PETS),
    modalities: {
      cabin: {
        offered: unverified("yes", AR_PETS, NOTE_INDEXED),
        species: unverified(DOG_CAT, AR_PETS, NOTE_INDEXED),
        maxWeightKg: unverified({ kg: 9, includesCarrier: true }, AR_PETS, NOTE_INDEXED),
        carrierCm: unverified(
          "Bolso blando 44×30×23 (obligatorio desde abril 2024)",
          AR_PETS,
          NOTE_INDEXED,
        ),
        minAgeDays: unverified(
          { default: WEEKS_12, byCorridor: { usa: WEEKS_16 } },
          AR_PETS,
          NOTE_INDEXED,
        ),
        requiredDocuments: unverified(
          [{ doc: "vet_health_certificate" }, { doc: "rabies_certificate" }],
          AR_PETS,
          NOTE_INDEXED,
        ),
        bookingLeadHours: unverified(72, AR_PETS, NOTE_INDEXED),
      },
      hold: {
        offered: verified(
          "no",
          AR_CARGO,
          "Las mascotas que superan la cabina viajan por Aerolíneas Cargo.",
        ),
      },
      cargo: {
        offered: verified("yes", AR_CARGO),
        species: verified(DOG_CAT, AR_CARGO),
        carrierCm: verified(
          "Canil rígido IATA LAR, con precintos y malla desde el 01/09/2025",
          AR_CARGO,
        ),
        breedRestrictions: verified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["hold", "cargo"],
              effect: "banned",
            },
          ],
          AR_CARGO,
        ),
        requiredDocuments: verified(
          [{ doc: "senasa_cvi" }, { doc: "rabies_certificate" }, { doc: "senasa_boarding_permit" }],
          AR_CARGO,
        ),
      },
    },
  },
  {
    id: "flybondi",
    name: "Flybondi",
    iata: "FO",
    scope: "domestic_ar",
    ...meta(FO_PETS),
    modalities: {
      cabin: {
        offered: unverified(
          "restricted",
          FO_CABIN,
          `${NOTE_403} Solo vuelos domésticos; no se pudo confirmar la condición para vuelos internacionales.`,
        ),
        species: unverified(DOG_CAT, FO_CABIN, NOTE_403),
        maxWeightKg: unverified({ kg: 10, includesCarrier: true }, FO_CABIN, NOTE_403),
        minAgeDays: unverified({ default: MONTHS_4 }, FO_CABIN, NOTE_403),
      },
      hold: {
        offered: unverified("no", FO_PETS, NOTE_403),
      },
    },
  },
  {
    id: "jetsmart",
    name: "JetSMART",
    iata: "WJ",
    scope: "international",
    ...meta(JA_RULES),
    modalities: {
      cabin: {
        offered: unverified(
          "yes",
          JA_BLOG,
          "Fuente de terceros; las regulaciones oficiales son de noviembre 2022 y pueden estar desactualizadas.",
        ),
        species: unverified(DOG_CAT, JA_BLOG, "Fuente de terceros."),
        maxWeightKg: unverified({ kg: 10, includesCarrier: true }, JA_BLOG, "Fuente de terceros."),
        minAgeDays: unverified({ default: MONTHS_3 }, JA_BLOG, "Fuente de terceros."),
        breedRestrictions: unverified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["cabin"],
              effect: "banned",
            },
          ],
          JA_RULES,
          `${JA_RULES_NOTE} Texto ambiguo: restringe por 'condiciones fisiológicas' sin aclarar si prohíbe el viaje.`,
        ),
        requiredDocuments: unverified(
          [
            { doc: "vet_health_certificate", maxDaysBeforeFlight: 10 },
            { doc: "rabies_certificate", minDaysSinceDose: 30, maxDaysSinceDose: 365 },
          ],
          JA_RULES,
          `${JA_RULES_NOTE} No se encontró una versión 2025/2026.`,
        ),
      },
      hold: {
        offered: unverified(
          "no",
          JA_BLOG,
          "No se vio confirmación de bodega para pasajeros en Argentina.",
        ),
      },
    },
  },
  {
    id: "latam",
    name: "LATAM",
    iata: "LA",
    scope: "international",
    ...meta(LA_PETS),
    modalities: {
      cabin: {
        offered: unverified("yes", LA_PETS, NOTE_403),
        species: unverified(DOG_CAT, LA_PETS, NOTE_403),
        maxWeightKg: unverified({ kg: 7, includesCarrier: true }, LA_PETS, NOTE_403),
        carrierCm: unverified("Rígido 36×33×19 o flexible 36×33×23", LA_PETS, NOTE_403),
        minAgeDays: unverified({ default: WEEKS_16 }, LA_PETS, NOTE_403),
        breedRestrictions: unverified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["cabin", "hold"],
              effect: "banned",
            },
          ],
          LA_PETS,
          `${NOTE_403} También prohíbe 'razas peligrosas', sin publicar la lista.`,
        ),
        bookingLeadHours: unverified(4, LA_PETS, NOTE_403),
      },
      hold: {
        offered: unverified("yes", LA_PETS, NOTE_403),
        species: unverified(DOG_CAT, LA_PETS, NOTE_403),
        maxWeightKg: unverified(
          { kg: 32, includesCarrier: true },
          LA_PETS,
          `${NOTE_403} 32 kg es el tope en vuelos hacia, desde o vía Argentina.`,
        ),
        minAgeDays: unverified({ default: WEEKS_16 }, LA_PETS, NOTE_403),
        bookingLeadHours: unverified(48, LA_PETS, NOTE_403),
      },
    },
  },
  {
    id: "gol",
    name: "GOL",
    iata: "G3",
    scope: "international",
    ...meta(G3_CABIN),
    modalities: {
      cabin: {
        offered: verified("yes", G3_CABIN),
        species: verified(DOG_CAT, G3_CABIN),
        maxWeightKg: unverified(
          { kg: 10, includesCarrier: true },
          G3_CABIN,
          "Las fuentes discrepan: 10 kg o 12 kg.",
        ),
        carrierCm: verified("Rígido 22×32×43 o bolso flexible 24×32×43", G3_CABIN),
        minAgeDays: verified({ default: MONTHS_6 }, G3_CABIN),
        requiredDocuments: verified(
          [
            { doc: "vet_health_certificate", maxDaysBeforeFlight: 10 },
            { doc: "rabies_certificate", minDaysSinceDose: 30 },
          ],
          G3_CABIN,
        ),
      },
      hold: {
        offered: verified("no", G3_HOLD, "Transporte en bodega suspendido desde 2024."),
      },
    },
  },
  {
    id: "sky",
    name: "Sky Airline",
    iata: "H2",
    scope: "international",
    ...meta(H2_BLOG),
    modalities: {
      cabin: {
        offered: verified("yes", H2_BLOG),
        species: verified(DOG_CAT, H2_BLOG),
        maxWeightKg: verified({ kg: 10, includesCarrier: true }, H2_BLOG),
        carrierCm: verified("Bolso blando 20×40×33, sin ruedas", H2_BLOG),
        minAgeDays: unverified(
          { default: WEEKS_12 },
          H2_BLOG,
          "Confirmado solo por redes sociales de la aerolínea, no por el blog oficial.",
        ),
        requiredDocuments: unverified(
          [{ doc: "vet_health_certificate", maxDaysBeforeFlight: 10 }],
          H2_BLOG,
          "Validez del certificado confirmada solo por redes sociales de la aerolínea.",
        ),
        embargoes: verified(
          [{ kind: "route", note: "Sin mascotas en vuelos hacia o desde Estados Unidos." }],
          H2_BLOG,
        ),
        bookingLeadHours: verified(48, H2_BLOG),
      },
      hold: {
        offered: verified("yes", H2_BLOG),
        maxWeightKg: unverified(
          { kg: 32, includesCarrier: true },
          H2_BLOG,
          "45 kg en Chile y Perú según redes sociales; no confirmado para Argentina.",
        ),
        breedRestrictions: verified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["hold"],
              effect: "cabin_only",
            },
          ],
          H2_BLOG,
        ),
        embargoes: verified(
          [{ kind: "route", note: "Sin mascotas en vuelos hacia o desde Estados Unidos." }],
          H2_BLOG,
        ),
      },
    },
  },
  {
    id: "american",
    name: "American Airlines",
    iata: "AA",
    scope: "international",
    ...meta(AA_PETS),
    modalities: {
      cabin: {
        offered: unverified("yes", AA_PETS, `${NOTE_403} ${NOTE_THIRD_PARTY}`),
        species: unverified(DOG_CAT, AA_PETS, NOTE_THIRD_PARTY),
        maxWeightKg: unverified({ kg: 9, includesCarrier: true }, AA_PETS, NOTE_THIRD_PARTY),
      },
      hold: {
        offered: unverified(
          "restricted",
          AA_PETS,
          `${NOTE_THIRD_PARTY} Solo militares en servicio activo y personal del Departamento de Estado.`,
        ),
      },
      cargo: {
        offered: unverified("yes", AA_PETS, NOTE_THIRD_PARTY),
      },
    },
  },
  {
    id: "united",
    name: "United Airlines",
    iata: "UA",
    scope: "international",
    ...meta(UA_PETS),
    modalities: {
      cabin: {
        offered: unverified("yes", UA_PETS, `La página oficial no respondió. ${NOTE_THIRD_PARTY}`),
        species: unverified(DOG_CAT, UA_PETS, NOTE_THIRD_PARTY),
        minAgeDays: unverified(
          { default: MONTHS_2, international: MONTHS_6 },
          UA_PETS,
          NOTE_THIRD_PARTY,
        ),
      },
      hold: {
        offered: unverified("no", UA_PETS, NOTE_THIRD_PARTY),
      },
      cargo: {
        offered: unverified(
          "restricted",
          UA_PETS,
          `${NOTE_THIRD_PARTY} PetSafe cerrado a civiles desde 2018.`,
        ),
      },
    },
  },
  {
    id: "delta",
    name: "Delta Air Lines",
    iata: "DL",
    scope: "international",
    ...meta(DL_PETS),
    modalities: {
      cabin: {
        offered: verified(
          "yes",
          DL_PETS,
          "No disponible en Delta One ni Business en tramos internacionales.",
        ),
        species: verified(DOG_CAT, DL_PETS),
        minAgeDays: verified({ default: WEEKS_10, byCorridor: { usa: MONTHS_6 } }, DL_PETS),
        requiredDocuments: verified(
          [{ doc: "vet_health_certificate", maxDaysBeforeFlight: 10 }],
          DL_PETS,
          "Cuando el destino lo exige.",
        ),
      },
      hold: {
        offered: verified(
          "restricted",
          DL_PETS,
          "Solo personal militar y del servicio exterior de EE.UU.",
        ),
        breedRestrictions: verified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["hold"],
              effect: "banned",
            },
          ],
          DL_PETS,
        ),
      },
      cargo: {
        offered: verified("yes", DL_PETS),
        embargoes: verified(
          [
            {
              kind: "temperature",
              note: "Sin transporte con pronóstico bajo −12 °C o sobre 29,4 °C en origen, escala o destino.",
            },
            {
              kind: "seasonal",
              from: "05-15",
              to: "09-15",
              note: "Sin mascotas facturadas en vuelos operados por Delta o Aeroméxico.",
            },
          ],
          DL_PETS,
        ),
      },
    },
  },
  {
    id: "iberia",
    name: "Iberia",
    iata: "IB",
    scope: "international",
    ...meta(IB_PETS),
    modalities: {
      cabin: {
        offered: unverified("yes", IB_PETS, NOTE_INDEXED),
        species: unverified(DOG_CAT, IB_PETS, NOTE_INDEXED),
        maxWeightKg: unverified({ kg: 8, includesCarrier: true }, IB_PETS, NOTE_INDEXED),
        carrierCm: unverified("Transportín ventilado 45×35×25", IB_PETS, NOTE_INDEXED),
      },
      hold: {
        offered: unverified(
          "yes",
          IB_PETS,
          `${NOTE_INDEXED} Requiere autorización previa de Iberia.`,
        ),
        species: unverified(DOG_CAT, IB_PETS, NOTE_INDEXED),
        maxWeightKg: unverified({ kg: 45, includesCarrier: true }, IB_PETS, NOTE_INDEXED),
        breedRestrictions: unverified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["hold"],
              effect: "banned",
            },
            {
              kind: "dangerous_list",
              breeds: IBERIA_DANGEROUS_BREEDS,
              appliesTo: ["hold"],
              effect: "banned",
            },
          ],
          IB_PETS,
          NOTE_INDEXED,
        ),
      },
    },
  },
  {
    id: "air_europa",
    name: "Air Europa",
    iata: "UX",
    scope: "international",
    ...meta(UX_PETS),
    modalities: {
      cabin: {
        offered: unverified("yes", UX_PETS, NOTE_INDEXED),
        species: unverified(
          DOG_CAT,
          UX_PETS,
          `${NOTE_INDEXED} En larga distancia, solo perro y gato.`,
        ),
        maxWeightKg: unverified(
          { kg: 10, includesCarrier: true },
          UX_PETS,
          `${NOTE_INDEXED} 8 kg el animal + 2 kg el transportín.`,
        ),
        carrierCm: unverified("Transportín 55×35×25, bajo el asiento", UX_PETS, NOTE_INDEXED),
        minAgeDays: unverified(
          { default: MONTHS_3 },
          UX_PETS,
          "Las fuentes discrepan: 3 meses (cabina) o 10 semanas (bodega).",
        ),
        breedRestrictions: unverified(
          [
            {
              kind: "dangerous_list",
              breeds: IBERIA_DANGEROUS_BREEDS,
              appliesTo: ["cabin", "hold"],
              effect: "muzzle",
            },
          ],
          UX_PETS,
          NOTE_INDEXED,
        ),
        embargoes: unverified(
          [{ kind: "route", note: "No acepta animales hacia o desde el Reino Unido." }],
          UX_PETS,
          NOTE_INDEXED,
        ),
      },
      hold: {
        offered: unverified("yes", UX_PETS, NOTE_INDEXED),
        maxWeightKg: unverified({ kg: 50, includesCarrier: true }, UX_PETS, NOTE_INDEXED),
        minAgeDays: unverified(
          { default: WEEKS_10 },
          UX_PETS,
          "Las fuentes discrepan: 10 semanas (bodega) o 3 meses (cabina).",
        ),
        breedRestrictions: unverified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["hold"],
              effect: "cabin_only",
            },
            {
              kind: "dangerous_list",
              breeds: IBERIA_DANGEROUS_BREEDS,
              appliesTo: ["cabin", "hold"],
              effect: "muzzle",
            },
          ],
          UX_PETS,
          NOTE_INDEXED,
        ),
        embargoes: unverified(
          [
            {
              kind: "seasonal",
              from: "06-15",
              to: "09-15",
              note: "Sin bodega en conexiones por Madrid entre las 11:00 y las 20:00.",
            },
            { kind: "route", note: "No acepta animales hacia o desde el Reino Unido." },
          ],
          UX_PETS,
          NOTE_INDEXED,
        ),
      },
    },
  },
  {
    id: "air_france",
    name: "Air France",
    iata: "AF",
    scope: "international",
    ...meta(AF_PETS),
    modalities: {
      cabin: {
        offered: unverified(
          "restricted",
          AF_PETS,
          `${NOTE_THIRD_PARTY} La cabina aparece limitada a rutas dentro de EE.UU., Canadá, Puerto Rico e Islas Vírgenes.`,
        ),
        maxWeightKg: unverified({ kg: 8, includesCarrier: true }, AF_PETS, NOTE_THIRD_PARTY),
      },
      hold: {
        offered: unverified("yes", AF_PETS, NOTE_THIRD_PARTY),
        maxWeightKg: unverified({ kg: 75, includesCarrier: true }, AF_PETS, NOTE_THIRD_PARTY),
        breedRestrictions: unverified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["hold"],
              effect: "cabin_only",
            },
          ],
          AF_PETS,
          NOTE_THIRD_PARTY,
        ),
      },
      cargo: {
        offered: unverified("yes", AF_PETS, NOTE_THIRD_PARTY),
      },
    },
  },
  {
    id: "klm",
    name: "KLM",
    iata: "KL",
    scope: "international",
    ...meta(KL_PETS),
    modalities: {
      cabin: {
        offered: unverified("yes", KL_PETS, NOTE_INDEXED),
        species: unverified(DOG_CAT, KL_PETS, NOTE_INDEXED),
        maxWeightKg: unverified({ kg: 8, includesCarrier: true }, KL_PETS, NOTE_INDEXED),
        carrierCm: unverified("Transportín cerrado 46×28×24", KL_PETS, NOTE_INDEXED),
        bookingLeadHours: unverified(48, KL_PETS, NOTE_INDEXED),
      },
      hold: {
        offered: unverified(
          "yes",
          KL_PETS,
          `${NOTE_INDEXED} No disponible en B787-9, B787-10 ni A321neo.`,
        ),
        maxWeightKg: unverified({ kg: 75, includesCarrier: true }, KL_PETS, NOTE_INDEXED),
      },
    },
  },
  {
    id: "lufthansa",
    name: "Lufthansa",
    iata: "LH",
    scope: "international",
    ...meta(LH_PETS),
    modalities: {
      cabin: {
        offered: unverified("yes", LH_PETS, NOTE_THIRD_PARTY),
        species: unverified(DOG_CAT, LH_PETS, NOTE_THIRD_PARTY),
        maxWeightKg: unverified({ kg: 8, includesCarrier: true }, LH_PETS, NOTE_THIRD_PARTY),
        carrierCm: unverified("Transportín blando 55×40×23", LH_PETS, NOTE_THIRD_PARTY),
        bookingLeadHours: unverified(72, LH_PETS, NOTE_THIRD_PARTY),
      },
      hold: {
        offered: unverified("yes", LH_PETS, NOTE_THIRD_PARTY),
        breedRestrictions: unverified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["hold"],
              effect: "cabin_only",
            },
          ],
          LH_PETS,
          `${NOTE_THIRD_PARTY} Vigente desde el 01/01/2020.`,
        ),
      },
    },
  },
  {
    id: "ita",
    name: "ITA Airways",
    iata: "AZ",
    scope: "international",
    ...meta(AZ_CABIN),
    modalities: {
      cabin: {
        offered: verified("yes", AZ_CABIN),
        species: verified(DOG_CAT, AZ_CABIN, "Solo perro y gato desde el 01/12/2025."),
        maxWeightKg: verified(
          { kg: 8, includesCarrier: true },
          AZ_CABIN,
          "12 kg solo en vuelos domésticos italianos.",
        ),
      },
      hold: {
        offered: verified("yes", AZ_HOLD),
        species: verified(DOG_CAT, AZ_HOLD),
        maxWeightKg: verified({ kg: 75, includesCarrier: true }, AZ_HOLD),
        breedRestrictions: verified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["hold"],
              effect: "cabin_only",
            },
          ],
          AZ_HOLD,
          "Venta de bodega suspendida para braquicéfalos desde el 26/10/2025.",
        ),
      },
    },
  },
  {
    id: "turkish",
    name: "Turkish Airlines",
    iata: "TK",
    scope: "international",
    ...meta(TK_PETS),
    modalities: {
      cabin: {
        offered: unverified("yes", TK_PETS, `${NOTE_INDEXED} Solo en Economy.`),
        species: unverified(DOG_CAT, TK_PETS, NOTE_INDEXED),
        maxWeightKg: unverified({ kg: 8, includesCarrier: true }, TK_PETS, NOTE_INDEXED),
        carrierCm: unverified("Transportín 23×30×40", TK_PETS, NOTE_INDEXED),
        breedRestrictions: unverified(
          [
            {
              kind: "airline_veto",
              breeds: [
                "Tosa Inu",
                "Doberman",
                "Dogo Canario (Presa Canario)",
                "Rottweiler",
                "Mastín Napolitano",
              ],
              offCatalogue: [
                "American Bulldog",
                "Bandog",
                "Ovejero del Cáucaso",
                "Dogue de Bordeaux",
                "Cruzas de perro lobo",
                "Pastor de Anatolia",
                "Boerboel",
              ],
              appliesTo: ["cabin", "hold"],
              effect: "banned",
            },
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["cabin", "hold"],
              effect: "banned",
            },
          ],
          TK_PETS,
          `${NOTE_INDEXED} Una fuente matiza que los braquicéfalos sí entrarían en cabina si cumplen peso y tamaño.`,
        ),
      },
      hold: {
        offered: unverified("yes", TK_PETS, NOTE_INDEXED),
        carrierCm: unverified("Canil rígido hasta 75×75×125", TK_PETS, NOTE_INDEXED),
      },
    },
  },
  {
    id: "emirates",
    name: "Emirates",
    iata: "EK",
    scope: "international",
    ...meta(EK_PETS),
    modalities: {
      cabin: {
        offered: verified(
          "no",
          EK_PETS,
          "Solo perros de servicio certificados y halcones en rutas puntuales.",
        ),
      },
      hold: {
        offered: verified("no", EK_PETS),
      },
      cargo: {
        offered: verified("yes", EK_PETS, "Emirates SkyCargo; sin vuelo directo a Buenos Aires."),
        species: verified(DOG_CAT, EK_PETS),
        minAgeDays: verified({ default: MONTHS_4 }, EK_PETS),
        breedRestrictions: verified(
          [
            {
              kind: "airline_veto",
              breeds: ["Bulldog Inglés", "Bulldog Francés"],
              appliesTo: ["cabin", "hold", "cargo"],
              effect: "banned",
            },
          ],
          EK_PETS,
        ),
        requiredDocuments: verified([{ doc: "vet_health_certificate" }], EK_PETS),
      },
    },
  },
  {
    id: "qatar",
    name: "Qatar Airways",
    iata: "QR",
    scope: "international",
    ...meta(QR_PETS),
    modalities: {
      cabin: {
        offered: verified("no", QR_PETS, "Solo perros de servicio certificados y halcones."),
      },
      hold: {
        offered: verified(
          "yes",
          QR_PETS,
          "Como equipaje facturado; sin vuelo directo a Buenos Aires.",
        ),
        species: verified(DOG_CAT, QR_PETS),
        maxWeightKg: verified({ kg: 75, includesCarrier: true }, QR_PETS),
        breedRestrictions: verified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["hold"],
              effect: "banned",
            },
          ],
          QR_PETS,
          "Solo por carga, no como equipaje facturado.",
        ),
      },
      cargo: {
        offered: verified("yes", QR_PETS),
      },
    },
  },
  {
    id: "copa",
    name: "Copa Airlines",
    iata: "CM",
    scope: "international",
    ...meta(CM_PETS),
    modalities: {
      cabin: {
        offered: verified(
          "yes",
          CM_PETS,
          "Vuelos internacionales con mascota solo de lunes a viernes.",
        ),
        species: verified(DOG_CAT, CM_PETS),
        maxWeightKg: verified({ kg: 10, includesCarrier: true }, CM_PETS),
        carrierCm: verified("Transportín blando 45,7×28×28", CM_PETS),
        minAgeDays: verified({ default: WEEKS_8 }, CM_PETS),
        requiredDocuments: verified(
          [{ doc: "vet_health_certificate" }, { doc: "rabies_certificate" }],
          CM_PETS,
        ),
        bookingLeadHours: verified(48, CM_PETS),
      },
      hold: {
        offered: verified("yes", CM_PETS),
        species: verified(DOG_CAT, CM_PETS),
        maxWeightKg: verified({ kg: 40, includesCarrier: true }, CM_PETS),
      },
    },
  },
  {
    id: "avianca",
    name: "Avianca",
    iata: "AV",
    scope: "international",
    ...meta(AV_PETS),
    modalities: {
      cabin: {
        offered: verified("yes", AV_PETS),
        species: verified(DOG_CAT, AV_PETS),
        maxWeightKg: verified({ kg: 10, includesCarrier: true }, AV_PETS),
        carrierCm: verified("Contenedor flexible 55×35×25", AV_PETS),
        minAgeDays: verified({ default: MONTHS_4 }, AV_PETS),
        requiredDocuments: verified(
          [
            { doc: "vet_health_certificate" },
            { doc: "rabies_certificate" },
            { doc: "airline_form" },
          ],
          AV_PETS,
          "El certificado lleva la matrícula profesional del veterinario.",
        ),
        bookingLeadHours: verified(48, AV_PETS),
      },
      hold: {
        offered: verified("yes", AV_PETS),
        species: verified(DOG_CAT, AV_PETS),
        maxWeightKg: verified(
          { kg: 50, includesCarrier: true },
          AV_PETS,
          "En la familia A32S con bodega ventilada: hasta 15 mascotas por vuelo.",
        ),
        breedRestrictions: verified(
          [
            {
              kind: "brachycephalic",
              breeds: "BRACHYCEPHALIC_LIST",
              appliesTo: ["hold"],
              effect: "banned",
            },
          ],
          AV_PETS,
        ),
      },
    },
  },
];

export function getAirline(id: AirlineId): Airline {
  const airline = AIRLINES.find((a) => a.id === id);
  if (!airline) throw new Error(`Unknown airline id: ${id}`);
  return airline;
}

/** Narrowing for a slug read from a payload (airline_id is a slug, not an enum). */
export function isAirlineId(value: unknown): value is AirlineId {
  return typeof value === "string" && (AIRLINE_IDS as readonly string[]).includes(value);
}
