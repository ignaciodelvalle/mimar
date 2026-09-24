// The breed CATALOGS — the data a picker renders, and nothing that decides
// anything (native-readiness WU-B, item 4).
//
// WHY THE DATA MOVED HERE AND THE MATCHER DID NOT
// ---------------------------------------------------------------------------
// `lib/reference/breeds.ts` held two different things under one roof: the LISTS
// (which breeds exist, per species, and which of the dog ones the provincial PPP
// laws name) and the MATCHER (accent/case folding plus a curated alias table
// that turns "pitbull" into "Pit Bull Terrier"). Only the first half is a
// catalog a client needs.
//
// A native registration screen has to render a species-scoped breed picker while
// the phone is on a subway with no signal, so the list has to be IN the app
// bundle — which means it has to be in the one package a React Native app can
// install. The matcher stays in the web app on purpose: it is the SERVER's
// authority (`lib/domain/breed-validation.ts`, QA A4 2026-08-13), and shipping a
// copy of it to clients would invite a client to "resolve" a breed locally and
// send the result as if it were canonical. A picker sends a label FROM this
// list; the server re-resolves whatever arrives and rejects what does not fit.
// One authority, two consumers, no second opinion on the wire.
//
// So `lib/reference/breeds.ts` now re-exports these names rather than declaring
// them. There is exactly one copy of every list, and a breed added here reaches
// the web catalog, the PPP classifier, the drift auditor and the phone in the
// same commit.
//
// ADDING A BREED IS CHEAP. Flattening a real animal into "Pura raza no listada"
// destroys information, so a missing breed is a bug worth fixing. Adding to
// `POTENTIALLY_DANGEROUS_DOG_BREEDS` is NOT cheap: that set is the law's, not
// ours (Ley CABA 4078, Ley Provincial 14.107 and equivalents).

/**
 * The two options every species has, regardless of whether it has a named list.
 * "Mixto / Cruza" is what most of Argentina's dogs actually are.
 */
export const SPECIAL_BREED_OPTIONS = ["Mixto / Cruza", "Pura raza no listada"] as const;

export const DOG_BREEDS = [
  "Akita Inu",
  "American Pit Bull Terrier",
  "American Staffordshire Terrier",
  "Beagle",
  "Bichón Frisé",
  "Border Collie",
  "Boxer",
  "Bull Terrier",
  "Bulldog Francés",
  "Bulldog Inglés",
  "Bullmastiff",
  "Cairn Terrier",
  "Cane Corso",
  "Caniche",
  "Chihuahua",
  "Cocker Spaniel",
  "Collie",
  "Doberman",
  "Dogo Argentino",
  "Dogo Canario (Presa Canario)",
  "Dálmata",
  "Fila Brasileiro",
  "Galgo",
  "Golden Retriever",
  "Gran Danés",
  "Husky Siberiano",
  "Jack Russell Terrier",
  "Labrador",
  "Maltés",
  "Mastín Napolitano",
  "Pastor Alemán",
  "Pastor Australiano",
  "Pastor Belga",
  "Pastor Suizo Blanco",
  "Pequinés",
  "Pit Bull Terrier",
  "Pomerania",
  "Pug",
  "Rottweiler",
  "Salchicha (Dachshund)",
  "San Bernardo",
  "Schnauzer",
  "Setter",
  "Shiba Inu",
  "Shih Tzu",
  "Spinone Italiano",
  "Staffordshire Bull Terrier",
  "Tosa Inu",
  "Yorkshire Terrier",
];

export const CAT_BREEDS = [
  "Abisinio",
  "Bengala",
  "Birmano",
  "British Shorthair",
  "Burmés",
  "Común europeo",
  "Maine Coon",
  "Noruego del Bosque",
  "Oriental",
  "Persa",
  "Ragdoll",
  "Russian Blue",
  "Scottish Fold",
  "Siamés",
  "Sphynx",
];

// Conejo y cobayo no tenían catálogo: `breedsForSpecies` devolvía sólo las dos
// opciones especiales, así que "Conejo común" y "Cobayo americano" —dos filas
// reales de staging, dos razas de verdad— no tenían dónde caer. Listas de
// arranque, cortas a propósito y pensadas para crecer cuando aparezcan datos.
export const RABBIT_BREEDS = [
  "Angora",
  "Belier (Lop)",
  "Cabeza de León",
  "Común",
  "Gigante de Flandes",
  "Holandés enano",
  "Mini Rex",
];

export const GUINEA_PIG_BREEDS = ["Abisinio", "Americano", "Coronet", "Peruano", "Rex", "Sheltie"];

/**
 * The PPP set — the dog breeds Argentine provincial law names.
 *
 * Carried here with the catalogs because a client that renders a picker may
 * legitimately want to warn "esta raza tiene obligaciones registrales" BEFORE
 * the round-trip. It remains advisory on the client: the flag actually stored on
 * a pet is resolved server-side, per jurisdiction, by
 * `lib/infra/ppp-classification.ts` — a national set cannot answer a question
 * whose answer depends on which province the animal lives in.
 */
export const POTENTIALLY_DANGEROUS_DOG_BREEDS: ReadonlySet<string> = new Set([
  "Akita Inu",
  "American Pit Bull Terrier",
  "American Staffordshire Terrier",
  "Bull Terrier",
  "Bullmastiff",
  "Cane Corso",
  "Doberman",
  "Dogo Argentino",
  "Dogo Canario (Presa Canario)",
  "Fila Brasileiro",
  "Mastín Napolitano",
  "Pit Bull Terrier",
  "Rottweiler",
  "Staffordshire Bull Terrier",
  "Tosa Inu",
]);

/**
 * Toda etiqueta de raza válida, de cualquier especie. Es la referencia del
 * auditor de catálogo y del reparador: un valor guardado fuera de este conjunto
 * es un defecto, no una variante.
 */
export const ALL_BREEDS: readonly string[] = [
  ...SPECIAL_BREED_OPTIONS,
  ...DOG_BREEDS,
  ...CAT_BREEDS,
  ...RABBIT_BREEDS,
  ...GUINEA_PIG_BREEDS,
];

/**
 * The picker's options for a species: the two special options first, then the
 * named list (empty for species with no catalog yet, which is why the special
 * options are unconditional — every species must have a valid choice).
 */
export function breedsForSpecies(species: string): string[] {
  const named =
    species === "cat"
      ? CAT_BREEDS
      : species === "dog"
        ? DOG_BREEDS
        : species === "rabbit"
          ? RABBIT_BREEDS
          : species === "guinea_pig"
            ? GUINEA_PIG_BREEDS
            : [];
  return [...SPECIAL_BREED_OPTIONS, ...named];
}
