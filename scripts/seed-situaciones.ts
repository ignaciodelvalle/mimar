/**
 * QA situations seed — `pnpm seed:situaciones`. LOCAL ONLY.
 *
 * Seeds one pet per owner-visible situation of lib/ui/pet-situation.ts, plus
 * the variants the QA battery needs (three kinds of lost, a brand-new pet, a
 * pet with many notices at once, a pet owner@dim.test does not hold as
 * titular). The plan — tokens, names, recipes, the situations that cannot be
 * reached and why — is the pure module ./seed-situaciones-plan.ts.
 *
 * ─── EVERY STATE THROUGH A PRODUCTION USE CASE ─────────────────────────────
 *   This repo is event-sourced. A seed that inserts into `pets`/`ownerships`
 *   writes a cache the spine never heard of, and lint:spine,
 *   lint:holder-drift and rederivePetCache report it. So nothing here writes
 *   a state row by hand: each pet is registered by `registerPet` (the alta
 *   wizard's use case) and moved by the same use case the web action calls,
 *   with the deps the action composes. The only seams used are the ones the
 *   use cases expose for exactly this:
 *     - registerPet's injected `repo.generatePublicToken`, to pin the token
 *       (same seam scripts/seed-demo-scenario.ts uses);
 *     - setPetLostWriter's injected `broadcastLostPet`, replaced by a no-op so
 *       a QA seed does not fan "se perdió" alerts out to every subscriber.
 *   Auth is the one thing skipped: there is no session, so the actor ids are
 *   resolved here — the same ids the action's guard would have produced.
 *
 * ─── PREREQUISITE ───────────────────────────────────────────────────────────
 *   `pnpm seed:test` — owner2@ (titular of the not-titular pet), govt@ /
 *   govt-local@ with the seeded sanitary authority (decomiso) and the verified
 *   Refugio Test (decomiso receiver). owner@dim.test is created here if it is
 *   missing; a pet whose actor is missing is SKIPPED with the reason, never
 *   faked.
 *
 * ─── IDEMPOTENCY ────────────────────────────────────────────────────────────
 *   Pets are found by their fixed DIM-QSIT-* token. A pet found under a name
 *   that is not the plan's (the QA names changed on 2026-10-06) is renamed
 *   through `updatePet`, the use case "Editar datos" calls, so the correction
 *   is a `pet_profile_updated` event and not a raw column write. Each step either carries a
 *   fixed client idempotency key (the use case's own replay guard) or checks
 *   the state it would create (already lost, grant already there, custody
 *   episode already open) and skips.
 *
 * ─── LOCAL-ONLY GUARD ───────────────────────────────────────────────────────
 *   Refuses unless BOTH NEXT_PUBLIC_SUPABASE_URL and DATABASE_URL are local.
 *   There is no --allow-remote: this is QA furniture, not demo data.
 *
 * Usage: pnpm seed:situaciones
 */

import { createHash } from "node:crypto";

import { config as loadEnv } from "dotenv";

import { resolveSeedPassword } from "./_env-target";
import {
  QA_PETS,
  type QaPet,
  type QaRow,
  UNREACHABLE_RELATIONSHIPS,
  UNREACHABLE_SITUATIONS,
  formatSituacionesTable,
  situacionesTargetProblem,
} from "./seed-situaciones-plan";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const targetProblem = situacionesTargetProblem(SUPABASE_URL, DATABASE_URL);
if (targetProblem !== null) {
  console.error(
    `[seed:situaciones] Me niego: ${targetProblem}. Este seed es sólo para la base local de QA.`,
  );
  process.exit(2);
}
if (!SERVICE_ROLE_KEY) {
  console.error("[seed:situaciones] Falta SUPABASE_SERVICE_ROLE_KEY en .env.local.");
  process.exit(2);
}
if (process.env.NODE_ENV === "production") {
  console.error("[seed:situaciones] Me niego: NODE_ENV=production.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Deferred imports — after the env is in place (../db throws without it).
// ---------------------------------------------------------------------------

const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { randomUUID } = await import("node:crypto");
const { createClient: createSdkClient } = await import("@supabase/supabase-js");
const { and, eq, inArray } = await import("drizzle-orm");
const { db, pets, petCaretakerGrants, organizations, profiles } = await import("../db");

const { registerPet } = await import("@/src/modules/pets/application/register-pet");
const { updatePet } = await import("@/src/modules/pets/application/update-pet");
const { composePetIdentityEdit } = await import("@/src/modules/pets/domain/pet-identity-edit");
const { fetchActiveIdentifications } = await import("@/lib/infra/pet-identifiers");
const { PetsRepository } = await import("@/src/modules/pets/infrastructure/pets-repository");
const { EventsRepository } = await import("@/src/modules/events/infrastructure/events-repository");
const { flushNotifications } = await import("@/src/modules/events/application/writers");
const { createVaccination } = await import(
  "@/src/modules/events/application/medical/vaccination-use-case"
);
const { createMedicationStart } = await import(
  "@/src/modules/events/application/medical/medication-start-use-case"
);
const { createDeathRecord } = await import(
  "@/src/modules/events/application/lifecycle/death-record-use-case"
);
const { setPetLostWriter } = await import(
  "@/src/modules/events/application/lifecycle/set-pet-lost-use-case"
);
const { recordPregnancyStartedWriter } = await import(
  "@/src/modules/pets/application/pregnancy/record-pregnancy-started"
);
const { reportBite } = await import("@/src/modules/surveillance/application/report-bite");
const { SurveillanceRepository } = await import(
  "@/src/modules/surveillance/infrastructure/surveillance-repository"
);
const { RABIES_OBSERVATION_DAYS } = await import(
  "@/src/modules/surveillance/domain/rabies-observation"
);
const { designateCaretaker } = await import(
  "@/src/modules/caretakers/application/designate-caretaker"
);
const { acceptCaretakerGrant } = await import(
  "@/src/modules/caretakers/application/accept-caretaker-grant"
);
const { CaretakersRepository } = await import(
  "@/src/modules/caretakers/infrastructure/caretakers-repository"
);
const { executeDecomiso, validateExecuteDecomiso } = await import(
  "@/src/modules/decomiso/application/execute-decomiso"
);
const { resolveGovtOrgForUser } = await import(
  "@/src/modules/decomiso/application/resolve-govt-org"
);
const { deliverDecomisoNotifications } = await import(
  "@/src/modules/decomiso/application/deliver-decomiso-notifications"
);
const { ATTACHMENT_BUCKET } = await import("@/src/modules/decomiso/domain/types");
const { findOpenCaseForPetAndKind, openCase } = await import("@/lib/infra/case-helpers");
const { findAuthoritiesForJurisdiction } = await import("@/lib/infra/approval-routing");
const { resolveBusinessRule } = await import("@/lib/infra/business-rules-resolver");
const { resolvePlace } = await import("@/lib/place/resolve-place");
const { getJurisdictionsCached } = await import("@/lib/infra/request-cache");
const { writeAuditLog } = await import("@/lib/infra/audit-log");
const { decomisoEvidenceRowPath } = await import("@/lib/infra/attachment-location");
const { findDrugByLabel } = await import("@/lib/reference/drugs");
const { FREQUENCY_LABELS, generateDoseSchedule, intervalHoursForFrequency } = await import(
  "@/lib/reference/medication-schedule"
);

type ParsedPetInput = import("@/src/modules/pets/domain/types").ParsedPet;
type PetRow = typeof pets.$inferSelect;
type Transaction = <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OWNER_EMAIL = "owner@dim.test";
const OWNER2_EMAIL = "owner2@dim.test";
const GOVT_EMAILS = ["govt-local@dim.test", "govt@dim.test"] as const;
const REFUGIO_EMAIL = "refugio@dim.test";

/** Where the QA pets live (a real barrio — never the whole-city aggregate). */
const HOME_PROVINCE = "CABA";
const HOME_LOCALITY = "Palermo";
/** Plaza Armenia, Palermo — the disclosed last-seen point. */
const LAST_SEEN = { lat: "-34.5886", lng: "-58.4290", text: "Plaza Armenia, Palermo" };

/** Owner-authored event (lib/infra/pet-access.ts OWNER_AUTHORSHIP). */
const OWNER_AUTHORSHIP = {
  authorRole: "owner" as const,
  authorOrganizationId: null,
  authorVerified: false,
};

const transaction: Transaction = <T>(cb: (tx: unknown) => Promise<T>) =>
  db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const daysAhead = (n: number) => new Date(Date.now() + n * DAY_MS);
/**
 * The use cases' own replay guard: one fixed key per pet and step. The column
 * is a uuid, so the readable name is hashed into a stable UUID-shaped value
 * (same input, same key, on every run).
 */
const idemKey = (token: string, step: string) => {
  const hex = createHash("sha256").update(`seed-situaciones:${token}:${step}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const supabase = createSdkClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class Skip extends Error {
  readonly name = "Skip";
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

type AuthUser = { id: string; email: string; emailConfirmed: boolean };

async function findAuthUser(email: string): Promise<AuthUser | null> {
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => u.email === email);
    if (hit) {
      return { id: hit.id, email, emailConfirmed: hit.email_confirmed_at != null };
    }
    if (data.users.length < 200) return null;
    page++;
  }
}

/**
 * owner@dim.test, created the way scripts/seed-demo-scenario.ts creates its
 * personal owner when it is missing (confirmed email, role owner — the profile
 * row comes from the auth trigger). An existing account is reused untouched.
 */
async function ensureOwner(): Promise<AuthUser> {
  const existing = await findAuthUser(OWNER_EMAIL);
  if (existing) return existing;
  const { data, error } = await supabase.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: resolveSeedPassword(true, "seed:situaciones"),
    email_confirm: true,
    user_metadata: { display_name: "Lucía Tester", user_role: "owner" },
  });
  if (error || !data.user) throw new Error(`createUser(${OWNER_EMAIL}): ${error?.message}`);
  console.log(`[OK  ] ${OWNER_EMAIL} creada`);
  return { id: data.user.id, email: OWNER_EMAIL, emailConfirmed: true };
}

// ---------------------------------------------------------------------------
// Pets
// ---------------------------------------------------------------------------

async function petByToken(token: string): Promise<PetRow | null> {
  const [row] = await db.select().from(pets).where(eq(pets.publicToken, token)).limit(1);
  return row ?? null;
}

async function localityIdFor(province: string, locality: string | null): Promise<string | null> {
  if (!locality) return null;
  // The one sanctioned name lookup: a row only when the name names one, never
  // the first homonym. Unresolved keeps a NULL FK, like a real registration
  // outside the INDEC catalogue.
  const place = await resolvePlace({ province, locality });
  return place.status === "resolved" ? place.localityId : null;
}

/**
 * The pet with this token, registered through registerPet when it does not
 * exist yet. Only the token is pinned (injected repo seam); everything else is
 * the alta wizard's path: pet_registered event, ownership, resolved locality.
 */
async function ensurePet(
  qa: QaPet,
  titularId: string,
  opts: {
    custodyKind?: ParsedPetInput["custodyKind"];
    province?: string;
    locality?: string | null;
  } = {},
): Promise<PetRow> {
  const existing = await petByToken(qa.token);
  if (existing) return ensureQaName(qa, existing, titularId);

  const province = opts.province ?? HOME_PROVINCE;
  const locality = opts.locality === undefined ? HOME_LOCALITY : opts.locality;
  const parsed: ParsedPetInput = {
    name: qa.name,
    species: "dog",
    sex: qa.sex,
    breed: "Mixto / Cruza",
    dateOfBirth: "2022-03-01",
    birthDateIsEstimated: true,
    color: "Marrón",
    microchipId: null,
    microchipCountryCode: null,
    microchipImplantedAt: null,
    microchipImplantedBy: null,
    microchipLocation: null,
    estimatedWeightKg: null,
    favouriteFoods: [],
    knownAllergies: [],
    trainingLevel: null,
    insuranceCompany: null,
    insurancePolicyNumber: null,
    jurisdictionProvince: province,
    jurisdictionLocality: locality,
    localityId: await localityIdFor(province, locality),
    acquisitionMethod: null,
    emergencyInfoVisible: false,
    permanentConditions: [],
    permanentConditionsOther: null,
    discloseConditionsPublicly: false,
    custodyKind: opts.custodyKind ?? "owner",
  };

  const result = await registerPet(
    {
      parsed,
      potentiallyDangerousBreed: false,
      uploadedPath: null,
      uploadMimeType: null,
      uploadSize: null,
      clientIdempotencyKey: null,
    },
    {
      repo: { ...PetsRepository, generatePublicToken: async () => qa.token },
      actor: { user: { id: titularId } },
      transaction,
      // Registered a year back, so every asiento below lands after the alta.
      now: () => daysAgo(365),
    },
  );
  if (!result.ok) throw new Error(`registerPet: ${result.error}`);
  const row = await petByToken(qa.token);
  if (!row) throw new Error("registerPet reported ok but the pet row is not there");
  return row;
}

/**
 * The plan's name on a pet seeded under an older one, through `updatePet` —
 * the use case the web's "Editar datos" and the app's `edit_identity` both end
 * in — with the identity composer the app uses, so only the name moves and the
 * correction lands as an event. Idempotent: a pet that already carries the
 * plan's name is returned untouched (and `updatePet` itself no-ops on no diff).
 */
async function ensureQaName(qa: QaPet, pet: PetRow, titularId: string): Promise<PetRow> {
  if (pet.name === qa.name) return pet;
  const parsed = composePetIdentityEdit(pet, {
    name: qa.name,
    breed: pet.breed,
    color: pet.color,
  });
  const ids = await fetchActiveIdentifications(pet.id);
  const result = await updatePet(
    {
      petId: pet.id,
      parsed,
      potentiallyDangerousBreed: pet.potentiallyDangerousBreed,
      uploadedPath: null,
      uploadMimeType: null,
      uploadSize: null,
    },
    {
      repo: PetsRepository,
      actor: {
        user: { id: titularId },
        accessPath: "owner",
        eventAuthorship: OWNER_AUTHORSHIP,
        existingPet: pet,
        existingCanonicalIds: { hasMicrochip: ids.microchip !== null },
      },
      transaction,
    },
  );
  if (!result.ok) throw new Error(`updatePet (renombre a "${qa.name}"): ${result.error}`);
  const row = await petByToken(qa.token);
  if (!row || row.name !== qa.name) throw new Error(`el renombre a "${qa.name}" no quedó`);
  console.log(`[OK  ] ${qa.token} renombrada: "${pet.name}" → "${qa.name}"`);
  return row;
}

// ---------------------------------------------------------------------------
// Steps — each one the use case the web action calls, with the action's deps
// ---------------------------------------------------------------------------

async function stepVaccination(pet: PetRow, userId: string): Promise<void> {
  const result = await createVaccination(
    {
      pet: { id: pet.id },
      user: { id: userId },
      eventAuthorship: OWNER_AUTHORSHIP,
      vaccineName: "Antirrábica",
      occurredAt: daysAgo(60),
      brand: null,
      batch: null,
      administeredBy: null,
      nextDueAt: daysAhead(300),
      notes: null,
      sourceReminderId: null,
      uploadedPath: null,
      uploadedMimeType: null,
      uploadedSize: null,
      clientIdempotencyKey: idemKey(pet.publicToken, "vacuna"),
    },
    { repo: new EventsRepository(), transaction },
  );
  if (!result.ok) throw new Error(`createVaccination: ${result.error}`);
}

async function stepLost(
  pet: PetRow,
  userId: string,
  variant: "with-point" | "without-point" | "not-disclosed",
): Promise<void> {
  const current = await petByToken(pet.publicToken);
  if (current?.status === "lost") return; // already lost — converged
  const withPoint = variant !== "without-point";
  const result = await setPetLostWriter(
    {
      petId: pet.id,
      petPublicToken: pet.publicToken,
      petName: pet.name,
      petStatus: current?.status ?? pet.status,
      petSpecies: pet.species,
      petBreed: pet.breed,
      petColor: pet.color,
      petJurisdictionProvince: pet.jurisdictionProvince,
      petJurisdictionLocality: pet.jurisdictionLocality,
      petJurisdictionLocalityId: pet.localityId ?? null,
      ownerUserId: userId,
      ownerDisplayName: "",
      fromStatus: current?.status ?? pet.status,
      recordedByUserId: userId,
      eventAuthorship: OWNER_AUTHORSHIP,
      locationDescription: LAST_SEEN.text,
      locationLat: withPoint ? LAST_SEEN.lat : null,
      locationLng: withPoint ? LAST_SEEN.lng : null,
      reason: null,
      disclosurePrefs: {
        discloseFirstNameWhenLost: true,
        disclosePhoneWhenLost: false,
        discloseEmailWhenLost: false,
        discloseLastLocationWhenLost: variant !== "not-disclosed",
        allowFinderFormWhenLost: true,
      },
    },
    {
      repo: new EventsRepository(),
      transaction,
      // The one substituted dep: a QA seed must not page every alert
      // subscriber in the barrio. The lost event, the projection and the
      // case are the use case's own and unaffected.
      broadcastLostPet: async () => undefined,
    },
  );
  if (result.error) throw new Error(`setPetLostWriter: ${result.error}`);
}

async function stepMedication(pet: PetRow, userId: string): Promise<void> {
  const firstDoseAt = daysAgo(3);
  const frequency = "twice_daily" as const;
  const schedule = generateDoseSchedule({
    firstDoseAt,
    intervalHours: intervalHoursForFrequency(frequency, null),
    durationDays: 30,
  });
  const drugName = "Amoxicilina";
  const result = await createMedicationStart(
    {
      pet: { id: pet.id, name: pet.name },
      user: { id: userId },
      eventAuthorship: OWNER_AUTHORSHIP,
      drugName,
      dose: "250 mg",
      prescribedBy: "Dr. Juan Veterinario",
      occurredAt: firstDoseAt,
      notes: null,
      uploadedPath: null,
      uploadedMimeType: null,
      uploadedSize: null,
      clientIdempotencyKey: idemKey(pet.publicToken, "medicacion"),
      frequency,
      customHours: null,
      durationDays: 30,
      firstDoseAt,
      schedule,
      matchedDrugCode: findDrugByLabel(drugName)?.code ?? null,
      frequencyLabel: FREQUENCY_LABELS[frequency],
    },
    { repo: new EventsRepository(), transaction },
  );
  if (!result.ok) throw new Error(`createMedicationStart: ${result.error}`);
}

async function stepPregnancy(pet: PetRow, userId: string): Promise<void> {
  const current = (await petByToken(pet.publicToken)) ?? pet;
  if (current.pregnancyStatus === "in_progress") return;
  const result = await recordPregnancyStartedWriter({
    pet: current,
    recordedByUserId: userId,
    eventAuthorship: OWNER_AUTHORSHIP,
    occurredAt: daysAgo(21),
    weeksAtDiagnosis: 3,
    vetConsulted: "Dr. Juan Veterinario",
    notes: null,
    clientIdempotencyKey: idemKey(pet.publicToken, "prenez"),
  });
  if (!result.ok) throw new Error(`recordPregnancyStartedWriter: ${result.error}`);
}

/** Owner bite report — opens the rabies observation and the bite case. */
async function stepBite(pet: PetRow, userId: string): Promise<void> {
  const current = (await petByToken(pet.publicToken)) ?? pet;
  // A re-run SKIPS on state: the open observation is what this step creates, so
  // its presence is the skip. (Until plan A5c reportBite opened the case BEFORE
  // its idempotency check, so a replay hit cases_open_per_pet_kind_idx —
  // measured 2026-10-06; it now replays, and the skip just saves the call.)
  if (current.rabiesObservationStatus === "in_progress") return;
  const repo = new SurveillanceRepository();
  const result = await reportBite(
    {
      pet: {
        id: current.id,
        publicToken: current.publicToken,
        name: current.name,
        species: current.species,
        status: current.status,
        rabiesObservationStatus: current.rabiesObservationStatus ?? null,
        jurisdictionProvince: current.jurisdictionProvince ?? null,
        jurisdictionLocality: current.jurisdictionLocality ?? null,
        localityId: current.localityId ?? null,
      },
      user: { id: userId },
      eventAuthorship: OWNER_AUTHORSHIP,
      occurredAt: daysAgo(2),
      victimKind: "human",
      severity: "minor",
      locationDescription: LAST_SEEN.text,
      context: "Mordió al jugar en la plaza (dato de QA).",
      victimContactName: null,
      victimContactPhone: null,
      victimAgeEstimate: null,
      clientIdempotencyKey: idemKey(pet.publicToken, "mordedura"),
      eventJurisdictionProvince: current.jurisdictionProvince ?? null,
      eventJurisdictionLocality: current.jurisdictionLocality ?? null,
      eventLocalityId: current.localityId ?? null,
      locationLat: Number(LAST_SEEN.lat),
      locationLng: Number(LAST_SEEN.lng),
      locationSource: "pin_manual",
    },
    {
      repo,
      openCase: async (input, tx) =>
        openCase(input as Parameters<typeof openCase>[0], tx as Parameters<typeof openCase>[1]),
      transaction: db.transaction.bind(db) as Transaction,
      findAuthoritiesForJurisdiction: (jurisdiction) =>
        findAuthoritiesForJurisdiction(jurisdiction, { route: "bite_reported_authority" }),
      resolveObservationWindow: async (jurisdiction) => {
        try {
          const r = await resolveBusinessRule("rabies_observation_window", {
            country: "AR",
            ...jurisdiction,
          });
          return { days: Math.max(1, r.payload.days) };
        } catch {
          return { days: RABIES_OBSERVATION_DAYS };
        }
      },
    },
  );
  if (!result.ok) throw new Error(`reportBite: ${result.error}`);
  await flushNotifications(result.notifications as Parameters<typeof flushNotifications>[0]);
}

async function stepDeath(pet: PetRow, userId: string): Promise<void> {
  const current = (await petByToken(pet.publicToken)) ?? pet;
  if (current.status === "deceased") return;
  const custodyEpisode = await findOpenCaseForPetAndKind(current.id, "custody_episode");
  const result = await createDeathRecord(
    {
      pet: {
        id: current.id,
        name: current.name,
        status: current.status,
        rabiesObservationStatus: current.rabiesObservationStatus ?? null,
        jurisdictionProvince: current.jurisdictionProvince ?? null,
        jurisdictionLocality: current.jurisdictionLocality ?? null,
        localityId: current.localityId ?? null,
      },
      recordedByUserId: userId,
      eventAuthorship: OWNER_AUTHORSHIP,
      cause: "natural",
      causeDetail: null,
      confirmedByVet: false,
      vetName: null,
      dispositionMethod: null,
      facility: null,
      occurredAt: daysAgo(10),
      notes: null,
      deathAtClinic: false,
      clinicName: null,
      vetContactedOwner: null,
      vetDecidedAlone: false,
      ownerToPrivateCrematorium: false,
      diseaseCode: null,
      confirmedByLab: false,
      isReportable: false,
      uploadedPath: null,
      uploadedMimeType: null,
      uploadedSize: null,
      clientIdempotencyKey: idemKey(pet.publicToken, "fallecimiento"),
      custodyEpisodeCaseId: custodyEpisode?.id ?? null,
    },
    { repo: new EventsRepository(), transaction, flushNotifications },
  );
  if (!result.ok) throw new Error(`createDeathRecord: ${result.error}`);
}

/** A live (pending or accepted) caretaker grant on this pet, if any. */
async function liveGrant(petId: string) {
  const [grant] = await db
    .select({ publicToken: petCaretakerGrants.publicToken, status: petCaretakerGrants.status })
    .from(petCaretakerGrants)
    .where(
      and(
        eq(petCaretakerGrants.petId, petId),
        inArray(petCaretakerGrants.status, ["pending", "accepted"]),
      ),
    )
    .limit(1);
  return grant ?? null;
}

async function stepDesignateCaretaker(
  pet: PetRow,
  titularId: string,
  inviteeEmail: string,
): Promise<string> {
  const live = await liveGrant(pet.id);
  if (live) return live.publicToken;
  const result = await designateCaretaker(
    {
      petId: pet.id,
      petName: pet.name,
      petPublicToken: pet.publicToken,
      titularUserId: titularId,
      inviteeEmail,
      startsAt: new Date(),
      endsAt: daysAhead(30),
      note: "Cuidado temporal de QA.",
    },
    { repo: CaretakersRepository, now: () => new Date() },
  );
  if (!result.ok) throw new Error(`designateCaretaker: ${result.error}`);
  await flushNotifications(result.notifications as Parameters<typeof flushNotifications>[0]);
  // The action writes this audit row after the use case (caretakers/actions.ts).
  await writeAuditLog(db, {
    action: "caretaker_designated",
    actorUserId: titularId,
    payload: {
      grant_public_token: result.value.grantPublicToken,
      pet_id: pet.id,
      to_email: result.value.inviteeEmail,
      to_user_known: !result.value.inviteeNeedsAccount,
    },
  });
  return result.value.grantPublicToken;
}

async function stepAcceptCaretaker(grantToken: string, caretaker: AuthUser): Promise<void> {
  const [grant] = await db
    .select({ status: petCaretakerGrants.status })
    .from(petCaretakerGrants)
    .where(eq(petCaretakerGrants.publicToken, grantToken))
    .limit(1);
  if (grant?.status === "accepted") return;
  const result = await acceptCaretakerGrant(
    {
      grantPublicToken: grantToken,
      callerUserId: caretaker.id,
      callerEmail: caretaker.email,
      callerEmailConfirmed: caretaker.emailConfirmed,
      publicContactConsent: false,
    },
    { repo: CaretakersRepository, now: () => new Date(), transaction },
  );
  if (!result.ok) throw new Error(`acceptCaretakerGrant: ${result.error}`);
  await flushNotifications(result.notifications as Parameters<typeof flushNotifications>[0]);
  await writeAuditLog(db, {
    action: "caretaker_grant_accepted",
    actorUserId: caretaker.id,
    payload: { grant_public_token: grantToken, public_contact_consent: false },
  });
}

// ---------------------------------------------------------------------------
// Decomiso (custodia oficial) — the /gob/decomisos/nuevo path
// ---------------------------------------------------------------------------

type DecomisoPrincipal = {
  userId: string;
  email: string;
  govtOrg: NonNullable<Awaited<ReturnType<typeof resolveGovtOrgForUser>>>;
  jurisdictions: Awaited<ReturnType<typeof getJurisdictionsCached>>;
};

/**
 * A govt account seeded by seed:test that can seize: role govt, member of a
 * sanitary authority with a province, at least one active assignment. These
 * are the checks executeDecomisoAction runs before the use case.
 */
async function resolveDecomisoPrincipal(): Promise<DecomisoPrincipal | null> {
  for (const email of GOVT_EMAILS) {
    const user = await findAuthUser(email);
    if (!user) continue;
    const [profile] = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    if (profile?.role !== "govt") continue;
    const govtOrg = await resolveGovtOrgForUser(user.id);
    if (!govtOrg?.jurisdictionProvince) continue;
    const jurisdictions = await getJurisdictionsCached(user.id);
    if (jurisdictions.some((j) => j.locality)) {
      return { userId: user.id, email, govtOrg, jurisdictions };
    }
  }
  return null;
}

/** The two evidence files the decomiso form requires: a photo and the acta. */
function decomisoEvidence(): {
  file: File;
  buffer: Buffer;
  mimeType: "image/jpeg" | "application/pdf";
}[] {
  const photo = readFileSync(join(process.cwd(), "public", "landing", "pampa-hero.jpg"));
  const acta = Buffer.from(
    "%PDF-1.4\n% Acta de decomiso de QA (seed:situaciones). Sin valor legal.\n%%EOF\n",
    "utf8",
  );
  return [
    {
      file: new File([photo], "foto-qa.jpg", { type: "image/jpeg" }),
      buffer: photo,
      mimeType: "image/jpeg",
    },
    {
      file: new File([acta], "acta-qa.pdf", { type: "application/pdf" }),
      buffer: acta,
      mimeType: "application/pdf",
    },
  ];
}

async function stepDecomiso(pet: PetRow, principal: DecomisoPrincipal): Promise<void> {
  if (await findOpenCaseForPetAndKind(pet.id, "custody_episode")) return;

  const [receiver] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.email, REFUGIO_EMAIL), eq(organizations.orgType, "shelter")))
    .limit(1);
  if (!receiver) throw new Skip("falta Refugio Test (corré pnpm seed:test)");

  const evidence = decomisoEvidence();
  const input = {
    subjectKind: "registered_pet" as const,
    petPublicToken: pet.publicToken,
    seizureMotive: "abandono_extremo" as const,
    intendedReceiverOrganizationId: receiver.id,
    intakeCondition: "Estable (dato de QA).",
    attachmentFiles: evidence.map((e) => e.file),
  };
  const session = {
    user: { id: principal.userId, email: principal.email },
    profile: { id: principal.userId, role: "govt" as const },
    jurisdictions: principal.jurisdictions,
  };
  const validated = await validateExecuteDecomiso(
    input,
    {
      session: session as Parameters<typeof validateExecuteDecomiso>[1]["session"],
      govtOrg: principal.govtOrg,
    },
    db,
  );
  if (!validated.ok) throw new Error(`validateExecuteDecomiso: ${validated.error}`);

  // Same upload the action does, to the same private bucket, before the tx.
  const dir = randomUUID();
  const uploaded: { filename: string; storagePath: string; mimeType: string; size: number }[] = [];
  for (const e of evidence) {
    const ext = e.mimeType === "application/pdf" ? "pdf" : "jpg";
    const objectPath = `${dir}/${randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .upload(objectPath, e.buffer, { contentType: e.mimeType });
    if (error) throw new Error(`upload de evidencia: ${error.message}`);
    uploaded.push({
      filename: e.file.name,
      storagePath: decomisoEvidenceRowPath(objectPath),
      mimeType: e.mimeType,
      size: e.buffer.byteLength,
    });
  }

  let publicCode = "";
  let pending: Parameters<typeof deliverDecomisoNotifications>[0] = [];
  await db.transaction(async (tx) => {
    const result = await executeDecomiso(
      input,
      {
        user: { id: principal.userId },
        govtOrg: principal.govtOrg as typeof principal.govtOrg & { jurisdictionProvince: string },
        receiverOrg: validated.receiverOrg,
        existingPet: validated.existingPet,
        unownedData: null,
        uploadedAttachments: uploaded,
      },
      tx,
    );
    if (!result.ok) throw new Error(`executeDecomiso: ${result.error}`);
    publicCode = result.publicCode;
    pending = result.pendingNotifications as typeof pending;
  });
  await deliverDecomisoNotifications(pending, { casePublicCode: publicCode, stage: "executed" });
}

// ---------------------------------------------------------------------------
// One pet
// ---------------------------------------------------------------------------

type Actors = {
  owner: AuthUser;
  owner2: AuthUser | null;
  decomiso: DecomisoPrincipal | null;
};

async function seedPet(qa: QaPet, actors: Actors): Promise<string | null> {
  const { owner } = actors;
  switch (qa.recipe) {
    case "new":
      await ensurePet(qa, owner.id);
      return null;
    case "al-dia":
      await stepVaccination(await ensurePet(qa, owner.id), owner.id);
      return null;
    case "lost-disclosed-with-point":
      await stepLost(await ensurePet(qa, owner.id), owner.id, "with-point");
      return null;
    case "lost-disclosed-without-point":
      await stepLost(await ensurePet(qa, owner.id), owner.id, "without-point");
      return null;
    case "lost-not-disclosed":
      await stepLost(await ensurePet(qa, owner.id), owner.id, "not-disclosed");
      return null;
    case "bite-observation":
      await stepBite(await ensurePet(qa, owner.id), owner.id);
      return null;
    case "medication":
      await stepMedication(await ensurePet(qa, owner.id), owner.id);
      return null;
    case "pregnancy":
      await stepPregnancy(await ensurePet(qa, owner.id), owner.id);
      return null;
    case "foster-in-transit":
      // The alta wizard's "lo encontré y lo cuido" path: the registrant holds
      // shelter_custody, which the owner page reads as en tránsito.
      await ensurePet(qa, owner.id, { custodyKind: "foster_in_transit" });
      return null;
    case "death":
      await stepDeath(await ensurePet(qa, owner.id), owner.id);
      return null;
    case "many-notices": {
      if (!actors.owner2) throw new Skip("falta owner2@dim.test (corré pnpm seed:test)");
      const pet = await ensurePet(qa, owner.id);
      await stepPregnancy(pet, owner.id);
      await stepBite(pet, owner.id);
      await stepDesignateCaretaker(pet, owner.id, OWNER2_EMAIL);
      await stepLost(pet, owner.id, "with-point");
      return "preñez + observación + caso de mordedura + cuidador pendiente + perdida";
    }
    case "caretaker-not-titular": {
      if (!actors.owner2) throw new Skip("falta owner2@dim.test (corré pnpm seed:test)");
      const pet = await ensurePet(qa, actors.owner2.id);
      const grant = await stepDesignateCaretaker(pet, actors.owner2.id, OWNER_EMAIL);
      await stepAcceptCaretaker(grant, owner);
      return "titular owner2@; owner@ es cuidador temporal (sustituto del co-titular)";
    }
    case "decomiso": {
      const principal = actors.decomiso;
      if (!principal) {
        throw new Skip(
          "no hay cuenta govt con autoridad sanitaria y jurisdicción (pnpm seed:test)",
        );
      }
      // Registered INSIDE the principal's jurisdiction, or the seizure is
      // refused as out of scope — exactly as it would be for a real operator.
      const scope = principal.jurisdictions.find((j) => j.locality);
      const pet = await ensurePet(qa, owner.id, {
        province: scope?.province ?? principal.govtOrg.jurisdictionProvince ?? HOME_PROVINCE,
        locality: scope?.locality ?? null,
      });
      await stepDecomiso(pet, principal);
      return `decomiso por ${principal.email}; owner@ deja de ser titular (sólo /p/ muestra la custodia)`;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[seed:situaciones] base local — sembrando mascotas de QA por situación\n");

  const owner = await ensureOwner();
  const owner2 = await findAuthUser(OWNER2_EMAIL);
  const decomiso = await resolveDecomisoPrincipal();
  const actors: Actors = { owner, owner2, decomiso };

  const rows: QaRow[] = [];
  for (const qa of QA_PETS) {
    try {
      const note = await seedPet(qa, actors);
      rows.push({ token: qa.token, situation: qa.situation, label: qa.label, status: "ok", note });
    } catch (err) {
      const skipped = err instanceof Skip;
      rows.push({
        token: qa.token,
        situation: qa.situation,
        label: qa.label,
        status: skipped ? "skipped" : "failed",
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(formatSituacionesTable(rows));
  console.log("\nNo sembradas, a propósito:");
  for (const [situation, reason] of Object.entries(UNREACHABLE_SITUATIONS)) {
    console.log(`  ${situation}: ${reason}`);
  }
  for (const [relationship, reason] of Object.entries(UNREACHABLE_RELATIONSHIPS)) {
    console.log(`  ${relationship}: ${reason}`);
  }

  const failed = rows.filter((r) => r.status === "failed").length;
  if (failed > 0) {
    console.error(`\n✗ ${failed} mascota(s) fallaron — ver la columna de arriba.`);
    process.exit(1);
  }
  console.log("\n✓ seed:situaciones listo.");
  process.exit(0);
}

await main();
