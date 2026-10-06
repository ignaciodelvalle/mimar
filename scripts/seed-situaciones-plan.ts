/**
 * The pure half of `pnpm seed:situaciones` (scripts/seed-situaciones.ts).
 *
 * Kept apart from the runner so the unit test can import the plan without
 * loading .env, opening a database or reaching Supabase: the runner does all
 * three at module load, the way every seed in this folder does.
 *
 * WHAT THE PLAN IS. A fixed list of QA pets, one per owner-visible situation
 * of lib/ui/pet-situation.ts plus the variants the test battery needs: three
 * kinds of lost, a brand-new pet, a pet with many notices at once, and a pet
 * where owner@dim.test is not the titular. Every pet has a FIXED public token
 * so the battery can address it and a re-run converges instead of duplicating.
 *
 * NAMES. Every one starts with "QA " and says what the pet is for ("QA Al día",
 * "QA Perdido con punto"…). They used to be plain pet names (Alba, Kiwi…), and
 * e2e specs pick owner@dim.test's pets off /mis-mascotas by their position and
 * name: on a DB with this seed layered on, crisis-owner-lost-flow picked
 * "Kiwi" (DIM-QSIT-0011) instead of the e2e fixture it was written for. A name
 * nobody would give a real animal cannot pass for a fixture, and
 * __tests__/seed-situaciones-plan.test.ts holds that no QA name collides with a
 * pet name the e2e fixtures or the other seeds use. The runner renames a pet
 * seeded under an older name through the production edit use case.
 *
 * TOKENS. `DIM-QSIT-NNNN` — "QA situaciones". Valid against the public token
 * shape (DIM-XXXX-XXXX), absent from every demo/storyline prefix that
 * __tests__/seed-precondition-contract.test.ts tracks, and distinct from the
 * `DIM-MUES-*` samples the /design previews print.
 */

import type { PetSituationKey } from "../lib/ui/pet-situation";
import { isLocalUrl } from "./_env-target";

export const QA_TOKEN_PREFIX = "DIM-QSIT-";

/** How a pet reaches its state — each value names the production use case(s). */
export type QaPetRecipe =
  /** registerPet + createVaccination (owner-declared antirrábica, due in the future). */
  | "al-dia"
  /** registerPet + setPetLostWriter; the variant decides disclosure and point. */
  | "lost-disclosed-with-point"
  | "lost-disclosed-without-point"
  | "lost-not-disclosed"
  /** registerPet in the authority's jurisdiction + executeDecomiso (govt principal). */
  | "decomiso"
  /** registerPet + reportBite (owner path) — opens the observation and the bite case. */
  | "bite-observation"
  /** registerPet + createMedicationStart (owner-recorded, still running). */
  | "medication"
  /** registerPet (female) + recordPregnancyStartedWriter. */
  | "pregnancy"
  /** registerPet with custodyKind "foster_in_transit" (the vecino-helps-stray path). */
  | "foster-in-transit"
  /** registerPet + createDeathRecord. */
  | "death"
  /** registerPet and nothing else. */
  | "new"
  /** pregnancy + bite + pending caretaker grant + lost, on one female pet. */
  | "many-notices"
  /** owner2@ registers, designates owner@ as caretaker, owner@ accepts. */
  | "caretaker-not-titular";

export type QaPet = {
  token: string;
  name: string;
  sex: "male" | "female";
  /** The situation the owner page should derive for this pet. */
  situation: PetSituationKey;
  /** What the battery uses this pet for, in one line (es-AR, it is printed). */
  label: string;
  recipe: QaPetRecipe;
  /** Account that registers the pet (the titular). */
  titular: "owner" | "owner2";
};

export const QA_PETS: readonly QaPet[] = [
  {
    token: "DIM-QSIT-0001",
    name: "QA Al día",
    sex: "female",
    situation: "al-dia",
    label: "Al día, antirrábica vigente (declarada)",
    recipe: "al-dia",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0002",
    name: "QA Perdido con punto",
    sex: "male",
    situation: "perdida",
    label: "Perdido, lugar compartido con punto en el mapa",
    recipe: "lost-disclosed-with-point",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0003",
    name: "QA Perdido sin punto",
    sex: "male",
    situation: "perdida",
    label: "Perdido, lugar compartido sin coordenadas",
    recipe: "lost-disclosed-without-point",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0004",
    name: "QA Perdida reservada",
    sex: "female",
    situation: "perdida",
    label: "Perdida, lugar NO compartido",
    recipe: "lost-not-disclosed",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0005",
    name: "QA Decomiso",
    sex: "female",
    situation: "custodia-oficial",
    label: "Custodia oficial (decomiso de la autoridad sanitaria)",
    recipe: "decomiso",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0006",
    name: "QA Observación",
    sex: "male",
    situation: "observacion-antirrabica",
    label: "En observación antirrábica (mordedura reportada)",
    recipe: "bite-observation",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0007",
    name: "QA Tratamiento",
    sex: "female",
    situation: "en-tratamiento",
    label: "En tratamiento (medicación en curso)",
    recipe: "medication",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0008",
    name: "QA Preñada",
    sex: "female",
    situation: "prenada",
    label: "Preñada",
    recipe: "pregnancy",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0009",
    name: "QA En tránsito",
    sex: "male",
    situation: "en-transito",
    label: "En tránsito (lo tiene un vecino que lo encontró)",
    recipe: "foster-in-transit",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0010",
    name: "QA Fallecida",
    sex: "female",
    situation: "fallecida",
    label: "Fallecida",
    recipe: "death",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0011",
    name: "QA Recién registrado",
    sex: "male",
    situation: "al-dia",
    label: "Recién registrado, sin asientos",
    recipe: "new",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0012",
    name: "QA Muchos avisos",
    sex: "female",
    situation: "perdida",
    label: "Muchos avisos a la vez (preñez, observación, cuidador, perdida)",
    recipe: "many-notices",
    titular: "owner",
  },
  {
    token: "DIM-QSIT-0013",
    name: "QA Cuidador",
    sex: "male",
    situation: "al-dia",
    label: "owner@ NO es titular: cuidador temporal aceptado",
    recipe: "caretaker-not-titular",
    titular: "owner2",
  },
];

/**
 * Situations that NO pet in the plan reaches, each with the reason. Every
 * situation is either reached by a pet above or named here — the unit test
 * holds that against PET_SITUATIONS itself, so a tenth situation added to
 * lib/ui/pet-situation.ts fails the test until the plan answers for it.
 */
export const UNREACHABLE_SITUATIONS: Readonly<Partial<Record<PetSituationKey, string>>> = {
  "en-adopcion":
    "La publicación en adopción es sólo de organizaciones (setAdoptionListingStatus pide la " +
    "custodia de un refugio), y el ingreso de un refugio (createIntake) acuña un token al azar " +
    "sin costura para fijarlo: no hay forma de llegar con un token fijo por un caso de uso.",
};

/**
 * Relationships the battery asked for that the app has NO writer for. Printed
 * by the runner so nobody reads the substitute as the real thing.
 */
export const UNREACHABLE_RELATIONSHIPS: Readonly<Record<string, string>> = {
  "co-titular":
    "co_owner no tiene escritor ni evento en la app (lib/projections/pet-holders.ts); una fila " +
    "insertada a mano la marca lint:holder-drift. DIM-QSIT-0013 usa en su lugar un cuidador " +
    "temporal aceptado, que es la relación no-titular real.",
};

/** The situations the plan reaches with a pet. */
export function reachedSituations(pets: readonly QaPet[] = QA_PETS): Set<PetSituationKey> {
  return new Set(pets.map((p) => p.situation));
}

/**
 * Why this target must not be written, or null when both URLs point at this
 * machine. LOCAL ONLY, with no flag to override it: this seed exists for the
 * local QA battery and has no business on staging or production.
 *
 * BOTH hosts are checked, separately and by name. A half-loaded env (one URL
 * from .env.staging.local, the other completed from .env.local) is the failure
 * scripts/_env-target.ts documents; reporting which half is remote is what
 * makes the refusal actionable.
 */
export function situacionesTargetProblem(supabaseUrl: string, databaseUrl: string): string | null {
  const missing = [
    supabaseUrl ? null : "NEXT_PUBLIC_SUPABASE_URL",
    databaseUrl ? null : "DATABASE_URL",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) return `falta ${missing.join(" y ")}`;

  const remote = [
    isLocalUrl(supabaseUrl) ? null : "NEXT_PUBLIC_SUPABASE_URL",
    isLocalUrl(databaseUrl) ? null : "DATABASE_URL",
  ].filter((name): name is string => name !== null);
  if (remote.length === 0) return null;
  if (remote.length === 2)
    return "NEXT_PUBLIC_SUPABASE_URL y DATABASE_URL apuntan a un host remoto";
  return `entorno partido: ${remote[0]} apunta a un host remoto y la otra URL es local`;
}

export type QaRowStatus = "ok" | "skipped" | "failed";

export type QaRow = {
  token: string;
  situation: string;
  label: string;
  status: QaRowStatus;
  note: string | null;
};

/** The table the runner prints: token → situation → URLs, plus the outcome. */
export function formatSituacionesTable(rows: readonly QaRow[]): string {
  const lines = rows.map((r) => {
    const outcome = r.status === "ok" ? "OK" : r.status === "skipped" ? "SALTEADA" : "FALLÓ";
    const note = r.note ? `  (${r.note})` : "";
    return [
      `${r.token}  ${r.situation.padEnd(24)}  ${outcome}${note}`,
      `    ${r.label}`,
      `    /p/${r.token}`,
      `    /mis-mascotas/${r.token}`,
    ].join("\n");
  });
  return lines.join("\n");
}
