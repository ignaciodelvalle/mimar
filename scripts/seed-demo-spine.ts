/**
 * DIM Demo Spine — assets adicionales sobre seed-demo.ts para que
 * los 5 ciclos del demo institucional corran sin altas mid-demo.
 *
 * Ejecutar DESPUÉS de seed-demo.ts:
 *   pnpm seed:demo
 *   node --conditions=react-server --import tsx scripts/seed-demo-spine.ts
 * (el plain `pnpm tsx` NO alcanza: los módulos de dominio importan código
 *  react-server; ver scripts/reset-demo-pets.ts para la cadena completa.)
 *
 * Qué agrega:
 *   1. Argo  — perro callejero en intake en "Patitas del Norte", con
 *              historial precargado (intake + microchip + antirrábica +
 *              esterilización + 2 weight_recorded). NO publicado a
 *              adopción. El operador del refugio lo publica en vivo
 *              durante el cycle 3.
 *   2. Dra. Carla Pérez — usuario owner con dni_verified=true y un
 *              approval_request pendiente tipo 'role_upgrade_vet' para
 *              CABA Recoleta. Aparece en la cola de Lucas (cycle 5).
 *   3. Welfare reports — 5 anónimas + 3 institucionales (Patitas del
 *              Norte) distribuidas en CABA C1/C2/C14 en las últimas 4
 *              semanas. Pueblan /gob/maltrato y /denuncias/codigo
 *              (cycle 4 y cycle 5).
 *   4. Disputa de custodia — "Bruno" (CABA Palermo), reclamo de
 *              graciela@dim.test contra noeli@dim.test (dueña activa), 2
 *              partes iniciales (current_owner/claimant_owner). PO interview
 *              2026-07-23, item 13 ("sembrar UNA disputa de demo"): sin
 *              esto /gob/casos?expediente=disputas y el picker V9 de
 *              búsqueda de partes no tenían ningún dato real para demostrar.
 *   5. Adoptante — adoptante@dim.test (Adriana Sosa) con
 *              "Mora" (DIM-MORA-DEMO): intake en Patitas del Norte →
 *              apta para adopción → adoption_finalized con su uuid REAL
 *              como adopter_user_id + recordatorios post-adopción abiertos.
 *              Habilita el check-in post-adopción (QA A9) y el recorrido
 *              demo 3 sin finalizar una adopción en vivo.
 *
 * Idempotente:
 *   Cada entidad se busca por una clave estable antes de insertarse.
 *   Re-correrlo no duplica nada.
 *
 * Circuito real de alta:
 *   Argo y Bruno se crean con registerPet — el mismo caso de uso que maneja el
 *   wizard de alta — y no con db.insert(pets). Ver la sección 4b. Para
 *   REGENERARLOS hay que borrarlos primero (scripts/reset-demo-pets.ts): la
 *   idempotencia por existencia hace que este seed saltee una mascota que ya
 *   está, defectos incluidos.
 *
 * Notas:
 *   - Local-only por defecto; `--allow-remote` habilita un destino remoto
 *     (p. ej. staging) con banner. NODE_ENV=production se rechaza SIEMPRE,
 *     y el entorno partido (Auth y DB en lados distintos) también — sin flag
 *     que lo saltee (ver scripts/_env-target.ts).
 *   - Comparte el patrón de log/safety de seed-demo.ts.
 *   - El org "Refugio Pendiente" (verified=false) que va a aprobar
 *     Lucas en cycle 5 ya está creado por seed-demo.ts — no se toca acá.
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap + safety
// ---------------------------------------------------------------------------

// Side-effect import — must come FIRST so DATABASE_URL is set before any
// downstream import evaluates db/index.ts (which throws on missing env).
// See scripts/_load-env.ts for why.
import "./_load-env";

import { resolveEnvTarget, resolveSeedPassword } from "./_env-target";

// --allow-remote opts out of the local-only guard so the spine storylines
// (Argo, Bruno's dispute, Mora/adoptante) can be seeded into a remote (e.g.
// staging) project — same pattern as seed-demo.ts. NODE_ENV=production stays
// hard-blocked. The seed is idempotent (every entity is looked up by a stable
// key before insert), so a remote re-run converges instead of duplicating.
const ALLOW_REMOTE = process.argv.includes("--allow-remote");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — aborting.");
  process.exit(2);
}
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed: NODE_ENV=production.");
  process.exit(2);
}
// Tres estados, no dos — incluido el PARTIDO. Ver scripts/_env-target.ts.
// Local-only by default; --allow-remote opts out with a loud banner.
const ENV_TARGET = resolveEnvTarget(SUPABASE_URL, DATABASE_URL, ALLOW_REMOTE, "seed:demo-spine");

// ---------------------------------------------------------------------------
// 2. Logger
// ---------------------------------------------------------------------------

type LogLevel = "STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "FAIL";
function log(level: LogLevel, msg: string): void {
  const tag = `[spine ${level}]`.padEnd(13);
  console.log(`${tag} ${msg}`);
}

// ---------------------------------------------------------------------------
// 3. Imports (DB-touching modules load AFTER env bootstrap)
// ---------------------------------------------------------------------------

import { validateEventPayload } from "@/lib/events/event-schemas";
import { isPetAdoptedByUser } from "@/lib/infra/adoption-checkin";
import { openCase } from "@/lib/infra/case-helpers";
import { resolveCanonicalJurisdiction } from "@/lib/infra/jurisdiction-validation";
import { generateApprovalRequestToken } from "@/lib/infra/publicToken";
import { resolveBreedLabel } from "@/lib/reference/breeds";
import { dniLast4, hashDni } from "@/lib/utils/dni-hash";
import { openDisputeFromEvent } from "@/src/modules/custody-disputes/application/open-dispute";
import { registerPet } from "@/src/modules/pets/application/register-pet";
import type { ParsedPet } from "@/src/modules/pets/domain/types";
import { PetsRepository } from "@/src/modules/pets/infrastructure/pets-repository";
import { createClient } from "@supabase/supabase-js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import * as schemas from "../db/schema";
import { generateReferenceCode } from "../src/modules/welfare/domain/reference-code";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Local keeps the literal the test suite and local dev depend on. Any other
// target (staging, etc.) requires SEED_DEMO_PASSWORD from the environment —
// this repo is public and "Test1234!" is published in it (R8, 2026-09-23).
const SHARED_PASSWORD = resolveSeedPassword(ENV_TARGET.isLocal, "seed:demo-spine");

// ---------------------------------------------------------------------------
// 4. Helpers
// ---------------------------------------------------------------------------

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

async function findOrgByEmail(email: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schemas.organizations.id })
    .from(schemas.organizations)
    .where(eq(schemas.organizations.email, email))
    .limit(1);
  return row?.id ?? null;
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  // List all users (small set in dev). Match by email.
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error || !data) return null;
  const found = data.users.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());
  return found?.id ?? null;
}

async function findProfileByEmail(email: string): Promise<{ id: string } | null> {
  const authId = await findUserIdByEmail(email);
  if (!authId) return null;
  const [row] = await db
    .select({ id: schemas.profiles.id })
    .from(schemas.profiles)
    .where(eq(schemas.profiles.id, authId))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// 4b. The real intake circuit
//
// WHY registerPet AND NOT db.insert(pets)
// ---------------------------------------
// A pets row inserted directly is an operational cache row with no fact behind
// it: the credential exists, but the append-only spine never recorded that
// anyone registered the animal. That is the cache outranking the log, which is
// exactly what invariant #3 forbids — and deriving the missing pet_registered
// back OUT of the pets row (its name, its created_at) makes the inversion
// worse, because it promotes the cache to the origin of the fact. The only
// honest fix is to create these pets the way a user creates one: through the
// use-case the alta wizard drives. It emits the pets row, the ownership row and
// the pet_registered event in one transaction, and resolves the canonical
// locality_id that a direct insert always left NULL.
//
// TWO INJECTED SEAMS, both already part of the use-case's Deps:
//   1. repo.generatePublicToken → the stable DIM-ARGO-DEMO / DIM-BRUNO-DEMO
//      tokens the runbook, e2e specs and this script's own idempotency guards
//      key off. generatePublicToken is an injected repo method, so overriding
//      it is the seam working as designed, not a bypass.
//   2. now → the historical registration instant. These assets carry months of
//      curated history; the default `new Date()` would stamp the registration
//      AFTER the events it owns.
//
// WHAT THE CALLER STILL WRITES ITSELF
// -----------------------------------
// ParsedPet has no distinguishing_features, no jurisdiction_country and no
// notion of an organization holding the animal — registerPet always writes an
// OWNER ownership. Shelter custody is a custody_transferred hand-off on the
// spine with the rows it implies (handSpinePetToShelter); curated identity trim
// is a post-registration cache update, the same dual-write discipline the
// production writers use.
// ---------------------------------------------------------------------------

/** Shelter operator who performs Argo's intake — org admin of Patitas del Norte. */
const SHELTER_OPERATOR_EMAIL = "alejo@dim.test";

type SpinePetSpec = {
  token: string;
  name: string;
  breed: string;
  color: string;
  sex: ParsedPet["sex"];
  dateOfBirth: string;
  birthDateIsEstimated: boolean;
  estimatedWeightKg: string | null;
  acquisitionMethod: ParsedPet["acquisitionMethod"];
  province: string;
  locality: string;
  /** The instant the credential was created. Must precede every curated event. */
  registeredAt: Date;
  /** The human who registered it — becomes recorded_by on pet_registered. */
  actorUserId: string;
};

async function registerSpinePet(spec: SpinePetSpec): Promise<string | null> {
  // Breeds come from the catalog (lib/reference/breeds.ts) — the alta wizard
  // only offers catalog values, so a seed that writes "Mestizo" raw drifts
  // pets.breed off-catalog and check-catalog-drift (pnpm verify) rejects the
  // whole database. Normalize through the same resolver the repair tool uses;
  // an unresolvable breed is a spec bug, so fail loud instead of inserting it.
  const canonicalBreed = resolveBreedLabel(spec.breed);
  if (!canonicalBreed) {
    log("FAIL", `Raza fuera de catálogo para ${spec.token}: "${spec.breed}"`);
    return null;
  }

  // Resolve the canonical locality FK exactly as the write path does
  // (normalizeLocationForWrite → resolveCanonicalJurisdiction). A miss leaves
  // the FK NULL — what a real registration outside the INDEC catalogue
  // produces — never a fabricated id.
  let localityId: string | null = null;
  try {
    const canonical = await resolveCanonicalJurisdiction({
      rawProvince: spec.province,
      rawLocality: spec.locality,
    });
    localityId = canonical.locality.id;
  } catch {
    localityId = null;
  }

  const parsed: ParsedPet = {
    name: spec.name,
    species: "dog",
    sex: spec.sex,
    breed: canonicalBreed,
    dateOfBirth: spec.dateOfBirth,
    birthDateIsEstimated: spec.birthDateIsEstimated,
    color: spec.color,
    // Chip left null on purpose: Argo arrives as an unchipped stray and is
    // chipped two days later, which the microchip_implanted event and the
    // canonical pet_identifications row below already tell. Declaring a chip
    // at registration would make the credential claim a fact that had not
    // happened yet.
    microchipId: null,
    microchipCountryCode: null,
    microchipImplantedAt: null,
    microchipImplantedBy: null,
    microchipLocation: null,
    estimatedWeightKg: spec.estimatedWeightKg,
    favouriteFoods: [],
    knownAllergies: [],
    trainingLevel: null,
    insuranceCompany: null,
    insurancePolicyNumber: null,
    jurisdictionProvince: spec.province,
    jurisdictionLocality: spec.locality,
    localityId,
    acquisitionMethod: spec.acquisitionMethod,
    emergencyInfoVisible: false,
    permanentConditions: [],
    permanentConditionsOther: null,
    discloseConditionsPublicly: false,
    custodyKind: "owner",
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
      repo: { ...PetsRepository, generatePublicToken: async () => spec.token },
      actor: { user: { id: spec.actorUserId } },
      transaction: async <T>(cb: (tx: unknown) => Promise<T>) =>
        db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
      now: () => spec.registeredAt,
    },
  );

  if (!result.ok) {
    log("FAIL", `registerPet falló para ${spec.token}: ${result.error}`);
    return null;
  }
  // result.notifications is deliberately dropped — registerPet only COLLECTS
  // them; the action flushes them post-transaction. A seed has no user to ping.
  return (result.value as NonNullable<typeof result.value>).petId;
}

/**
 * Hand a pet registerSpinePet just created from its registering operator to the
 * refuge, on the spine. registerPet always opens an OWNER interval for the
 * operator (pet_registered custody_kind owner); the org's custody has to be a
 * fact too, or the shelter_custody row is one no event explains and
 * lint:holder-drift fails on it. Same shape seed-panorama gives its shelter
 * pets: a custody_transferred owner → shelter_custody (citizen_to_org_handoff)
 * an hour after the registration, ending the operator's row and opening the
 * org's at that instant. The intake asiento is dated at the hand-off too, so
 * the replay opens the org's custody once, whichever of the two it reads first.
 *
 * Returns the hand-off instant.
 */
async function handSpinePetToShelter(args: {
  petId: string;
  orgId: string;
  operatorId: string;
  registeredAt: Date;
}): Promise<Date> {
  const { petId, orgId, operatorId, registeredAt } = args;
  const handoffAt = new Date(registeredAt.getTime() + 3_600_000);

  await db.insert(schemas.petEvents).values({
    petId,
    eventType: "custody_transferred",
    occurredAt: handoffAt,
    recordedByUserId: operatorId,
    authorRole: "shelter",
    authorOrganizationId: orgId,
    authorVerified: true,
    payload: validateEventPayload("custody_transferred", {
      from_user_id: operatorId,
      from_organization_id: null,
      to_user_id: null,
      to_organization_id: orgId,
      from_role: "owner",
      to_role: "shelter_custody",
      reason: "citizen_to_org_handoff",
      foster_ended_event_id: null,
      notes: null,
    }),
  });

  // End the operator's owner row BEFORE opening the org's, so the
  // one-active-owner-per-pet index never sees two live holders.
  await db
    .update(schemas.ownerships)
    .set({ endedAt: handoffAt })
    .where(
      and(
        eq(schemas.ownerships.petId, petId),
        eq(schemas.ownerships.role, "owner"),
        isNull(schemas.ownerships.endedAt),
      ),
    );
  await db.insert(schemas.ownerships).values({
    petId,
    ownerOrganizationId: orgId,
    role: "shelter_custody",
    startedAt: handoffAt,
  });

  return handoffAt;
}

// ---------------------------------------------------------------------------
// 5. Asset 1 — Argo (stray dog at Patitas del Norte)
// ---------------------------------------------------------------------------

const ARGO_PUBLIC_TOKEN = "DIM-ARGO-DEMO";
const PATITAS_EMAIL = "contacto@patitasdelnorte.test";
// Alejo's sanitary_authority org (Retiro) — the fiscalización target for the
// derived welfare report (#46). Its email is set by scripts/seed-demo.ts.
const AUTHORITY_EMAIL = "centro@mascotasba.test";
// Government official who forwards the report. lucas@dim.test is the demo govt
// user; his id becomes derived_by_user_id, matching the real derivation action.
const GOVT_DERIVER_EMAIL = "lucas@dim.test";

async function seedArgo(): Promise<void> {
  log("STEP", "Asset 1 — Argo (stray dog at Patitas del Norte)");

  const orgId = await findOrgByEmail(PATITAS_EMAIL);
  if (!orgId) {
    log("FAIL", `No se encontró org ${PATITAS_EMAIL}. ¿Corriste seed-demo.ts primero?`);
    return;
  }

  const [existing] = await db
    .select({ id: schemas.pets.id })
    .from(schemas.pets)
    .where(eq(schemas.pets.publicToken, ARGO_PUBLIC_TOKEN))
    .limit(1);

  if (existing) {
    log("SKIP", `Argo (${ARGO_PUBLIC_TOKEN}) ya existe.`);
    return;
  }

  const intakeDate = daysAgo(30);
  const microchipDate = daysAgo(28);
  const vaccineDate = daysAgo(25);
  const sterilizationDate = daysAgo(20);
  const weight1 = daysAgo(28);
  const weight2 = daysAgo(10);

  // ISO 11784/11785 chip: exactly 15 numeric digits (3 country + 4 manufacturer
  // + 8 national). The pet_identifications.chip_requires_iso_fields CHECK enforces
  // length(code) = 15 for kind='microchip_iso'; an 18-digit code aborts the insert
  // (and the whole spine). Matches the 858-prefixed 15-digit convention used by the
  // other seed scripts (seed-test-users, seed-storylines-*).
  const ARGO_CHIP = "858985112999000";

  // The shelter operator who takes Argo in is the actor on his registration.
  const operator = await findProfileByEmail(SHELTER_OPERATOR_EMAIL);
  if (!operator) {
    log("FAIL", `No se encontró ${SHELTER_OPERATOR_EMAIL}. ¿Corriste seed-demo.ts primero?`);
    return;
  }

  // Registered the day he is taken in: a shelter creates the credential when
  // the animal enters its custody, which is also what shelter_intake_recorded
  // says. Every later asiento (chip, vacuna, castración, pesos) then falls
  // after the registration that created the credential.
  const petId = await registerSpinePet({
    token: ARGO_PUBLIC_TOKEN,
    name: "Argo",
    breed: "Mestizo",
    color: "Marrón con manchas blancas",
    sex: "male",
    dateOfBirth: "2023-08-15",
    birthDateIsEstimated: true,
    // Matches the last weight_recorded below, so the pet-cache re-derivation
    // sweep sees the cache agree with the replayed spine.
    estimatedWeightKg: "22.5",
    acquisitionMethod: "found_stray",
    province: "CABA",
    locality: "Palermo",
    registeredAt: intakeDate,
    actorUserId: operator.id,
  });
  if (!petId) return;

  // Post-registration cache facts ParsedPet cannot carry.
  await db
    .update(schemas.pets)
    .set({ distinguishingFeatures: "Oreja izquierda con muesca" })
    .where(eq(schemas.pets.id, petId));

  // Shelter custody: registerPet always writes an OWNER ownership (it has no
  // notion of an organization holding an animal), so the refuge takes him over
  // on the spine — see handSpinePetToShelter.
  const handoffAt = await handSpinePetToShelter({
    petId,
    orgId,
    operatorId: operator.id,
    registeredAt: intakeDate,
  });

  const events = [
    {
      eventType: "shelter_intake_recorded",
      occurredAt: handoffAt,
      payload: {
        intake_kind: "stray",
        location_found: "Av. Santa Fe y Coronel Díaz, Palermo",
        condition_on_intake: "regular",
        notes: "Encontrado deambulando. Sin chip. Aproximadamente 2 años.",
      },
    },
    {
      // Canonical microchip_implanted shape (lib/events/event-schemas.ts →
      // microchipImplanted): the re-derivation harness (replayPetMicrochip) reads
      // chip_number / country_code / implanted_by / location_on_body /
      // implant_date_known. Using the legacy keys (chip_id / location) made the
      // projection derive a null chip, drifting from the canonical
      // pet_identifications row and failing pet-cache-rederivation.
      eventType: "microchip_implanted",
      occurredAt: microchipDate,
      payload: {
        chip_number: ARGO_CHIP,
        country_code: "858",
        implanted_by: "Refugio Patitas del Norte",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      eventType: "vaccination_administered",
      occurredAt: vaccineDate,
      payload: {
        vaccine_name: "Antirrábica + DHPP",
        lot_number: "LOT-A2026-457",
        next_due_at: daysAgo(-340).toISOString().slice(0, 10),
        applied_by: "Patitas del Norte (campaña interna)",
      },
    },
    {
      eventType: "sterilization_performed",
      occurredAt: sterilizationDate,
      payload: {
        procedure: "orchiectomy",
        notes: "Recuperación sin complicaciones.",
      },
    },
    {
      // Canonical weight_recorded shape: payload.kg (string). replayPetWeight
      // (lib/projections/pet-weight.ts) reads `kg`, not `weight_kg` — the legacy
      // key derived no weight, drifting estimatedWeightKg from the cached 22.5.
      eventType: "weight_recorded",
      occurredAt: weight1,
      payload: { kg: "21.0" },
    },
    {
      eventType: "weight_recorded",
      occurredAt: weight2,
      payload: { kg: "22.5" },
    },
  ] as const;

  for (const e of events) {
    await db.insert(schemas.petEvents).values({
      petId,
      eventType: e.eventType,
      occurredAt: e.occurredAt,
      authorRole: "shelter",
      authorOrganizationId: orgId,
      authorVerified: true,
      payload: e.payload as Record<string, unknown>,
    });
  }

  // Canonical microchip row — legacy pets.* columns not written (ARCH-R).
  await db.insert(schemas.petIdentifications).values({
    petId,
    kind: "microchip_iso",
    code: ARGO_CHIP,
    recordedAt: microchipDate.toISOString().slice(0, 10),
    recordedByLabel: "Refugio Patitas del Norte",
    isoCountryCode: ARGO_CHIP.slice(0, 3),
    isoManufacturerCode: ARGO_CHIP.slice(3, 7),
    isoNationalId: ARGO_CHIP.slice(7, 15),
    isoCompliant: true,
    // Mirror the microchip_implanted event's location_on_body so the re-derivation
    // harness (microchipLocation, implantSite compare) sees both sides normalize to
    // the same canonical enum via chipImplantSiteFromLocation.
    implantationSite: "interescapular",
  });

  log(
    "OK",
    `Argo creado (${ARGO_PUBLIC_TOKEN}) — ${events.length} eventos, en custodia de Patitas del Norte`,
  );
}

// ---------------------------------------------------------------------------
// 6. Asset 2 — Dra. Carla Pérez (pending vet upgrade)
// ---------------------------------------------------------------------------

const CARLA_EMAIL = "carla@dim.test";

async function seedCarlaVetUpgrade(): Promise<void> {
  log("STEP", "Asset 2 — Dra. Carla Pérez (pending vet upgrade)");

  // 1) crear o resolver auth user
  let authId = await findUserIdByEmail(CARLA_EMAIL);
  if (!authId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: CARLA_EMAIL,
      password: SHARED_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "Dra. Carla Pérez", user_role: "owner" },
    });
    if (error || !data.user) {
      log("FAIL", `No pude crear auth user para ${CARLA_EMAIL}: ${error?.message}`);
      return;
    }
    authId = data.user.id;
    log("OK", `Auth user creado para ${CARLA_EMAIL}`);
  } else {
    log("SKIP", `Auth user ${CARLA_EMAIL} ya existe`);
  }

  // 2) profile
  const [existingProfile] = await db
    .select({ id: schemas.profiles.id })
    .from(schemas.profiles)
    .where(eq(schemas.profiles.id, authId))
    .limit(1);

  if (!existingProfile) {
    await db.insert(schemas.profiles).values({
      id: authId,
      accountType: "personal",
      role: "owner",
      displayName: "Dra. Carla Pérez",
      // Wave 5 Item 25a: no plaintext DNI in seed — store hash + last4 only.
      dniHash: hashDni("32145678"),
      dniLast4: dniLast4("32145678"),
      dniVerified: true,
    });
    log("OK", "Profile de Carla creado con DNI verificado");
  } else {
    // Idempotency backfill: an earlier run may have created Carla BEFORE the
    // dni_hash line existed, leaving her without a DNI hash — so DNI search
    // (hashDni equality) can't find her. Re-writing the hash on the existing row
    // makes the seed self-healing instead of silently skipping the demo data.
    await db
      .update(schemas.profiles)
      .set({
        dniHash: hashDni("32145678"),
        dniLast4: dniLast4("32145678"),
        dniVerified: true,
      })
      .where(eq(schemas.profiles.id, authId));
    log("OK", "Profile de Carla ya existía — DNI hash backfilled");
  }

  // 3) approval_request pendiente
  const [existingReq] = await db
    .select({ id: schemas.approvalRequests.id })
    .from(schemas.approvalRequests)
    .where(
      and(
        eq(schemas.approvalRequests.applicantUserId, authId),
        eq(schemas.approvalRequests.type, "role_upgrade_vet"),
        eq(schemas.approvalRequests.status, "pending"),
      ),
    )
    .limit(1);

  if (existingReq) {
    log("SKIP", "Approval request de Carla ya existe en estado pending");
    return;
  }

  await db.insert(schemas.approvalRequests).values({
    publicToken: generateApprovalRequestToken(),
    type: "role_upgrade_vet",
    status: "pending",
    applicantUserId: authId,
    initiatedBy: "self",
    initiatedByUserId: authId,
    targetUserId: authId,
    targetOrganizationId: null,
    jurisdictionCountry: "AR",
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Recoleta",
    payload: {
      matricula_number: "MV-CABA-08847",
      matricula_jurisdiccion: "CABA",
      colegio_emisor: "Colegio Médico Veterinario de CABA",
      especialidad: "Clínica de pequeños animales",
      evidence_summary:
        "Matrícula vigente · Título UBA Veterinaria 2018 · 7 años de práctica en clínica privada",
    },
  });

  log("OK", "Approval request pending creado para Carla → Lucas la aprueba en cycle 5");
}

// ---------------------------------------------------------------------------
// 7. Asset 3 — Welfare reports (denuncias) previas
// ---------------------------------------------------------------------------

type WelfareKind =
  | "abandonment"
  | "neglect"
  | "physical_abuse"
  | "chained"
  | "no_shelter"
  | "hoarding"
  | "dog_fighting"
  | "trafficking"
  | "other";

type WelfareSeverity = "low" | "medium" | "high" | "critical";

interface ReportSpec {
  daysAgo: number;
  kind: WelfareKind;
  severity: WelfareSeverity;
  description: string;
  locality: string;
  anonymous: boolean;
  contactEmail?: string;
}

const REPORTS: ReportSpec[] = [
  // Anónimas
  {
    daysAgo: 27,
    kind: "abandonment",
    severity: "high",
    description:
      "Vi a alguien dejando dos cachorros en una caja en la esquina y se fue en un auto.",
    locality: "Recoleta",
    anonymous: true,
  },
  {
    daysAgo: 21,
    kind: "neglect",
    severity: "medium",
    description:
      "Perro encadenado al sol todo el día, no tiene agua ni refugio. Vecinos del edificio escuchan llantos.",
    locality: "Palermo",
    anonymous: true,
  },
  {
    daysAgo: 14,
    kind: "physical_abuse",
    severity: "critical",
    description: "Una persona patea al perro de su vecino cada vez que lo cruza en la entrada.",
    locality: "Recoleta",
    anonymous: true,
  },
  {
    daysAgo: 9,
    kind: "hoarding",
    severity: "high",
    description:
      "Departamento con olor fuerte a orina. Se escuchan muchos gatos. Vecinos del PB lo reportaron al consorcio.",
    locality: "Caballito",
    anonymous: true,
  },
  {
    daysAgo: 3,
    kind: "no_shelter",
    severity: "medium",
    description: "Perro en patio sin techo bajo la tormenta de ayer. Sigue afuera hoy.",
    locality: "Palermo",
    anonymous: true,
  },
  // Institucionales (Patitas del Norte)
  {
    daysAgo: 12,
    kind: "abandonment",
    severity: "high",
    description:
      "Tomamos intake de 4 gatos abandonados en bolsa de cartón frente al refugio. Confirmamos identidad del responsable por cámara del local de al lado.",
    locality: "Recoleta",
    anonymous: false,
    contactEmail: PATITAS_EMAIL,
  },
  {
    daysAgo: 6,
    kind: "neglect",
    severity: "high",
    description:
      "Caso visto durante operativo de castración: perro con desnutrición severa, dueño se niega a recibir tratamiento. Adjuntamos parte veterinario.",
    locality: "Caballito",
    anonymous: false,
    contactEmail: PATITAS_EMAIL,
  },
  {
    daysAgo: 2,
    kind: "dog_fighting",
    severity: "critical",
    description:
      "Sospecha fuerte de organización de peleas clandestinas. Tres perros recibidos con heridas compatibles. Reporte detallado para autoridad sanitaria.",
    locality: "Palermo",
    anonymous: false,
    contactEmail: PATITAS_EMAIL,
  },
];

async function seedWelfareReports(): Promise<void> {
  log("STEP", `Asset 3 — Welfare reports (${REPORTS.length} denuncias previas)`);

  const orgId = await findOrgByEmail(PATITAS_EMAIL);
  if (!orgId) {
    log("WARN", `No se encontró org ${PATITAS_EMAIL}, salteando institucionales.`);
  }

  for (const r of REPORTS) {
    // Idempotencia: buscar por description (es estable y única por reporte)
    const [existing] = await db
      .select({ id: schemas.welfareReports.id })
      .from(schemas.welfareReports)
      .where(eq(schemas.welfareReports.description, r.description))
      .limit(1);

    if (existing) {
      log("SKIP", `Denuncia "${r.description.slice(0, 50)}..." ya existe`);
      continue;
    }

    const reporterOrgId = !r.anonymous && r.contactEmail === PATITAS_EMAIL ? orgId : null;

    await db.insert(schemas.welfareReports).values({
      referenceCode: generateReferenceCode(),
      reporterUserId: null,
      reporterOrganizationId: reporterOrgId,
      reporterContactEmail: r.anonymous ? null : (r.contactEmail ?? null),
      reporterContactPhone: null,
      kind: r.kind,
      severity: r.severity,
      description: r.description,
      subjectKind: "unowned_animal",
      subjectPetId: null,
      subjectDescription: null,
      locationAddress: null,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: r.locality,
      occurredAt: daysAgo(r.daysAgo),
      status: "open",
      createdAt: daysAgo(r.daysAgo),
    } as any);

    const flag = r.anonymous ? "anónima" : "institucional (Patitas del Norte)";
    log("OK", `Denuncia ${r.kind}/${r.severity} ${flag} en ${r.locality}, hace ${r.daysAgo} días`);
  }
}

// ---------------------------------------------------------------------------
// 7a-bis. Asset 3c — in-scope welfare report WITH a linked subject pet (#58)
//
// The govt inspector's master-detail flow (/gob/maltrato) offers a "Ver mascota"
// drill ONLY when a report carries subject_kind='registered_pet' + a resolvable
// subject_pet_id. Every report seeded above is subject_kind='unowned_animal'
// (subject_pet_id null), so that drill never renders for visual QA. This seeds
// ONE report tied to Argo (DIM-ARGO-DEMO), who lives in Palermo — one of Lucas's
// 5 CABA barrios (Palermo, Puerto Madero, Recoleta, Retiro, San Nicolás) — so it
// falls inside his jurisdiction scope and the pet-drill is exercisable.
//
// Shape mirrors the real welfare writer (src/modules/welfare): subject_kind is a
// first-class enum value; subject_pet_id is the FK to pets. No check constraint
// couples the two (unlike cases.cases_subject_pet_consistency), but the app
// writer only sets subject_pet_id when subject_kind='registered_pet', so we do
// the same.
const SUBJECT_REPORT_DESCRIPTION =
  "Vecino reporta que el perro (hoy en custodia del refugio Patitas del Norte) estuvo semanas sin agua ni refugio antes del rescate. Pide seguimiento del caso.";

async function seedInScopeSubjectReport(): Promise<void> {
  log("STEP", "Asset 3c — denuncia in-scope con mascota vinculada (#58, Palermo / Lucas)");

  const [argo] = await db
    .select({ id: schemas.pets.id })
    .from(schemas.pets)
    .where(eq(schemas.pets.publicToken, ARGO_PUBLIC_TOKEN))
    .limit(1);

  if (!argo) {
    log("WARN", `No se encontró Argo (${ARGO_PUBLIC_TOKEN}); ¿corrió seedArgo? Salteando #58.`);
    return;
  }

  const [existing] = await db
    .select({ id: schemas.welfareReports.id })
    .from(schemas.welfareReports)
    .where(eq(schemas.welfareReports.description, SUBJECT_REPORT_DESCRIPTION))
    .limit(1);

  if (existing) {
    log("SKIP", "Denuncia in-scope con mascota vinculada ya existe.");
    return;
  }

  await db.insert(schemas.welfareReports).values({
    referenceCode: generateReferenceCode(),
    reporterUserId: null,
    reporterOrganizationId: null,
    reporterContactEmail: null,
    reporterContactPhone: null,
    kind: "neglect",
    severity: "medium",
    description: SUBJECT_REPORT_DESCRIPTION,
    subjectKind: "registered_pet",
    subjectPetId: argo.id,
    subjectDescription: "Argo — mestizo marrón con manchas blancas, oreja izquierda con muesca.",
    locationAddress: null,
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Palermo",
    occurredAt: daysAgo(5),
    status: "open",
    createdAt: daysAgo(5),
  } as any);

  log(
    "OK",
    "Denuncia neglect/medium en Palermo, vinculada a Argo (registered_pet) → pet-drill QA.",
  );
}

// ---------------------------------------------------------------------------
// 7b. Derive one welfare report to Alejo's sanitary authority (#46)
//
// Unblocks D3: without a derived report, "Denuncias de maltrato derivadas" is
// always 0 for Alejo's orgs and the maltrato/Recibidos flow can't be exercised
// end-to-end. We forward the institutional dog-fighting report (kind
// 'dog_fighting', authored "para autoridad sanitaria") to Mascotas BA Centro —
// the natural fiscalización target.
//
// Shape mirrors the REAL derivation action (deriveWelfareToOrgAction,
// src/modules/welfare/actions.ts): sets derived_to_organization_id / derived_at
// / derived_by_user_id and resets any org-intervention state to null. The report
// keeps status 'open', so it counts as live derived work (countDerivedWelfare).
//
// Known tension (reported, not a data problem): the live gov derivation action
// currently restricts targets to shelter / rescue_network, so this exact target
// (a sanitary_authority) is not reproducible through today's gov UI. The
// receiving surfaces — the Recibidos inbox, the panel counter, and the
// Pendientes row — are all org-type-agnostic (they key purely on
// derived_to_organization_id), so the row renders correctly everywhere it must.
async function deriveWelfareToAuthority(): Promise<void> {
  log("STEP", "Asset 3b — derivar 1 denuncia de maltrato a la autoridad (Mascotas BA Centro)");

  const authorityId = await findOrgByEmail(AUTHORITY_EMAIL);
  if (!authorityId) {
    log("WARN", `No se encontró autoridad ${AUTHORITY_EMAIL}, salteando derivación.`);
    return;
  }

  const deriver = await findProfileByEmail(GOVT_DERIVER_EMAIL);
  if (!deriver) {
    log("WARN", `No se encontró usuario gov ${GOVT_DERIVER_EMAIL}, salteando derivación.`);
    return;
  }

  // Pick the institutional dog-fighting report seeded above (stable by kind —
  // it is the only dog_fighting report in this seed set). Non-terminal only.
  const [report] = await db
    .select({
      id: schemas.welfareReports.id,
      referenceCode: schemas.welfareReports.referenceCode,
      derivedToOrganizationId: schemas.welfareReports.derivedToOrganizationId,
    })
    .from(schemas.welfareReports)
    .where(
      and(
        eq(schemas.welfareReports.kind, "dog_fighting"),
        eq(schemas.welfareReports.reporterContactEmail, PATITAS_EMAIL),
      ),
    )
    .limit(1);

  if (!report) {
    log("WARN", "No se encontró la denuncia dog_fighting para derivar, salteando.");
    return;
  }

  if (report.derivedToOrganizationId === authorityId) {
    log("SKIP", `Denuncia ${report.referenceCode} ya está derivada a la autoridad.`);
    return;
  }

  await db
    .update(schemas.welfareReports)
    .set({
      derivedToOrganizationId: authorityId,
      derivedAt: daysAgo(1),
      derivedByUserId: deriver.id,
      orgInterventionStatus: null,
      orgInterventionAt: null,
    })
    .where(eq(schemas.welfareReports.id, report.id));

  log("OK", `Denuncia ${report.referenceCode} (dog_fighting) derivada a Mascotas BA Centro.`);
}

// ---------------------------------------------------------------------------
// 8. Asset 5 — custody dispute demo (V9 party-search picker + Casos hub row)
// ---------------------------------------------------------------------------
//
// PO interview 2026-07-23, item 13 ("sembrar UNA disputa de demo"): V9 (the
// AddPartyForm search/select picker, replacing the old raw-UUID-paste flow)
// could never actually be demoed — the seed had ZERO custody_dispute rows, so
// /gob/casos?expediente=disputas always rendered its empty state. This asset
// opens exactly ONE open dispute, with its real 2 initial parties
// (current_owner + claimant_owner), following the SAME transactional sequence
// production uses (submitClaimDisputeForUser,
// src/modules/pets/application/claim/submit-claim-dispute.ts): openCase FIRST
// (so the raising pet_event can carry case_id), then the raising
// custody_dispute_raised event, then openDisputeFromEvent links the dispute
// row + writes the initial parties. Canonical jurisdiction (CABA/Palermo,
// already used by Asset 1/Argo above).

const DISPUTE_PET_PUBLIC_TOKEN = "DIM-BRUNO-DEMO";
const DISPUTE_CURRENT_OWNER_EMAIL = "noeli@dim.test";
const DISPUTE_CLAIMANT_EMAIL = "graciela@dim.test";

async function seedCustodyDisputeDemo(): Promise<void> {
  log("STEP", "Asset 5 — disputa de custodia demo (V9 party-search picker)");

  const [existingPet] = await db
    .select({ id: schemas.pets.id })
    .from(schemas.pets)
    .where(eq(schemas.pets.publicToken, DISPUTE_PET_PUBLIC_TOKEN))
    .limit(1);

  if (existingPet) {
    const [existingDispute] = await db
      .select({ id: schemas.custodyDisputes.id })
      .from(schemas.custodyDisputes)
      .where(eq(schemas.custodyDisputes.petId, existingPet.id))
      .limit(1);
    if (existingDispute) {
      log("SKIP", `Disputa demo (${DISPUTE_PET_PUBLIC_TOKEN}) ya existe.`);
      return;
    }

    // SELF-HEAL (operational rule, 2026-07-23): a full test-suite run can
    // delete this demo dispute's row while leaving its ORPHAN TRIO behind —
    // pets.in_custody_dispute still true and the open custody_dispute case
    // still present. Re-opening then FAILS on the unique-open-case-per-pet
    // index, which used to require a manual psql heal. Detect the orphan
    // state (no dispute row, but flag/case remnants) and clean it here so
    // "reseed the spine after any full-suite run" is one guaranteed command.
    const orphanCases = await db.execute(
      sql`DELETE FROM cases
          WHERE case_kind = 'custody_dispute'
            AND status = 'open'
            AND primary_pet_id = ${existingPet.id}` as never,
    );
    await db
      .update(schemas.pets)
      .set({ inCustodyDispute: false })
      .where(and(eq(schemas.pets.id, existingPet.id), eq(schemas.pets.inCustodyDispute, true)));
    void orphanCases;
    log("OK", "Estado huérfano de disputa saneado (caso abierto/flag sin fila de disputa).");
  }

  const currentOwner = await findProfileByEmail(DISPUTE_CURRENT_OWNER_EMAIL);
  const claimant = await findProfileByEmail(DISPUTE_CLAIMANT_EMAIL);
  if (!currentOwner || !claimant) {
    log(
      "FAIL",
      `No se encontraron ${DISPUTE_CURRENT_OWNER_EMAIL}/${DISPUTE_CLAIMANT_EMAIL}. ¿Corriste seed-demo.ts primero?`,
    );
    return;
  }

  let petId = existingPet?.id;
  if (!petId) {
    // Registered by his current owner a year before the claim. The dispute
    // only reads as a dispute if the credential predates it — a pet registered
    // after the claim was raised would be a different, incoherent story.
    const registeredId = await registerSpinePet({
      token: DISPUTE_PET_PUBLIC_TOKEN,
      name: "Bruno",
      breed: "Beagle",
      color: "Tricolor",
      sex: "male",
      dateOfBirth: "2021-03-10",
      birthDateIsEstimated: false,
      // estimatedWeightKg intentionally null: the pet-cache re-derivation
      // fitness sweep (__tests__/pet-cache-rederivation.test.ts) checks this
      // column against replayed weight_recorded events — a hardcoded value
      // with no backing event would read as cache drift. Bruno's health
      // history isn't the point of this asset (the dispute is); leave the
      // weight cache genuinely empty rather than fake it.
      estimatedWeightKg: null,
      acquisitionMethod: "adopted",
      province: "CABA",
      locality: "Palermo",
      registeredAt: daysAgo(365),
      actorUserId: currentOwner.id,
    });
    if (!registeredId) return;
    petId = registeredId;

    log("OK", `Bruno creado (${DISPUTE_PET_PUBLIC_TOKEN}) — dueño: ${DISPUTE_CURRENT_OWNER_EMAIL}`);
  } else {
    log("SKIP", `Bruno (${DISPUTE_PET_PUBLIC_TOKEN}) ya existía — abriendo la disputa sobre él.`);
  }

  const resolvedPetId = petId as string;
  const reason =
    "Bruno es mío: se lo llevó mi ex pareja cuando nos separamos y nunca me lo devolvió.";

  let disputeToken = "";
  await db.transaction(async (tx) => {
    const disputeCase = await openCase(
      {
        kind: "custody_dispute",
        primarySubjectKind: "registered_pet",
        primaryPetId: resolvedPetId,
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "Palermo",
        openedByUserId: claimant.id,
        openedByOrganizationId: null,
        openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
      },
      tx,
    );

    const payload = validateEventPayload("custody_dispute_raised", {
      raised_by_role: "owner",
      raised_by_user_id: claimant.id,
      external_proceeding_reference: null,
      reason,
    });

    const [raisingEvent] = await tx
      .insert(schemas.petEvents)
      .values({
        petId: resolvedPetId,
        eventType: "custody_dispute_raised",
        occurredAt: daysAgo(3),
        recordedAt: daysAgo(3),
        recordedByUserId: claimant.id,
        authorRole: "owner",
        payload,
        caseId: disputeCase.id,
      })
      .returning({ id: schemas.petEvents.id });

    const { publicToken } = await openDisputeFromEvent(tx, {
      petId: resolvedPetId,
      raisingEventId: raisingEvent.id,
      raisedByUserId: claimant.id,
      raisedByOrgId: null,
      raisedByRole: "owner",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
      initialParties: [
        { userId: currentOwner.id, role: "current_owner" },
        { userId: claimant.id, role: "claimant_owner", positionSummary: reason },
      ],
      preCreatedCaseId: disputeCase.id,
    });
    disputeToken = publicToken;
  });

  log(
    "OK",
    `Disputa abierta (${disputeToken}) sobre Bruno — 2 partes (current_owner: ${DISPUTE_CURRENT_OWNER_EMAIL}, claimant_owner: ${DISPUTE_CLAIMANT_EMAIL}). Visible en /gob/casos?expediente=disputas.`,
  );
}

// ---------------------------------------------------------------------------
// 8b. Asset 6 — Adriana Sosa (adoptante) + Mora (check-in post-adopción, QA A9)
// ---------------------------------------------------------------------------
//
// The check-in page (mis-mascotas/[token]/eventos/nuevo/checkin) gates on
// THREE facts at once: owner-path access, the pet's LATEST adoption_finalized
// event carrying the CURRENT user's REAL auth uuid as adopter_user_id, and an
// OPEN post_adoption_checkin reminder. The anotar capture catalog gates its
// "Check-in post-adopción" entry on the same isPetAdoptedByUser predicate
// (lib/infra/adoption-checkin.ts). Nothing seeded satisfied all three, so the
// A9 positive path was only demonstrable by finalizing an adoption live.
//
// adopter_user_id MUST be the auth uuid — the Zod schema says z.string().uuid()
// and isPetAdoptedByUser compares === against user.id. Several older seeds
// wrongly stored display names in that field; do NOT copy that pattern.
//
// The write shape mirrors AdoptionRepository.insertAdoptionFinalized
// (src/modules/adoption/infrastructure/adoption-repository.ts): close the
// shelter_custody ownership, insert the owner row (transferred_from_id), keep
// the listing cache columns clear, insert the validated adoption_finalized
// event and the production-shaped check-in reminders, in one transaction.

const ADOPTANTE_EMAIL = "adoptante@dim.test";
const ADOPTANTE_DISPLAY_NAME = "Adriana Sosa";
// Synthetic DNI — hashed only (Wave 5 Item 25a), distinct from Carla's.
const ADOPTANTE_DNI = "27889314";
const MORA_PUBLIC_TOKEN = "DIM-MORA-DEMO";

async function seedAdoptanteMora(): Promise<void> {
  log("STEP", "Asset 6 — Adriana Sosa (adoptante) + Mora (check-in post-adopción)");

  const orgId = await findOrgByEmail(PATITAS_EMAIL);
  if (!orgId) {
    log("FAIL", `No se encontró org ${PATITAS_EMAIL}. ¿Corriste seed-demo.ts primero?`);
    return;
  }

  const operator = await findProfileByEmail(SHELTER_OPERATOR_EMAIL);
  if (!operator) {
    log("FAIL", `No se encontró ${SHELTER_OPERATOR_EMAIL}. ¿Corriste seed-demo.ts primero?`);
    return;
  }

  // 1) Auth user + profile (same pattern as Carla above).
  let adoptanteId = await findUserIdByEmail(ADOPTANTE_EMAIL);
  if (!adoptanteId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: ADOPTANTE_EMAIL,
      password: SHARED_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: ADOPTANTE_DISPLAY_NAME, user_role: "owner" },
    });
    if (error || !data.user) {
      log("FAIL", `No pude crear auth user para ${ADOPTANTE_EMAIL}: ${error?.message}`);
      return;
    }
    adoptanteId = data.user.id;
    log("OK", `Auth user creado para ${ADOPTANTE_EMAIL}`);
  } else {
    log("SKIP", `Auth user ${ADOPTANTE_EMAIL} ya existe`);
  }

  const [existingProfile] = await db
    .select({ id: schemas.profiles.id })
    .from(schemas.profiles)
    .where(eq(schemas.profiles.id, adoptanteId))
    .limit(1);

  if (!existingProfile) {
    await db.insert(schemas.profiles).values({
      id: adoptanteId,
      accountType: "personal",
      role: "owner",
      displayName: ADOPTANTE_DISPLAY_NAME,
      dniHash: hashDni(ADOPTANTE_DNI),
      dniLast4: dniLast4(ADOPTANTE_DNI),
      dniVerified: true,
    });
    log("OK", "Profile de Adriana creado con DNI verificado");
  } else {
    // Same self-healing backfill as Carla: repair a profile created before
    // this asset carried a DNI hash, instead of silently skipping.
    await db
      .update(schemas.profiles)
      .set({
        dniHash: hashDni(ADOPTANTE_DNI),
        dniLast4: dniLast4(ADOPTANTE_DNI),
        dniVerified: true,
      })
      .where(eq(schemas.profiles.id, adoptanteId));
    log("OK", "Profile de Adriana ya existía — DNI hash backfilled");
  }

  // 2) Mora — idempotent by existence, like Argo. To REGENERATE her (defects
  // included), delete first via scripts/reset-demo-pets.ts.
  const [existingPet] = await db
    .select({ id: schemas.pets.id })
    .from(schemas.pets)
    .where(eq(schemas.pets.publicToken, MORA_PUBLIC_TOKEN))
    .limit(1);

  if (existingPet) {
    log("SKIP", `Mora (${MORA_PUBLIC_TOKEN}) ya existe.`);
    // Still re-run the verification below so a partially-seeded Mora (pet
    // present, adoption or reminder missing) is reported loudly, not hidden
    // behind the skip.
    await verifyAdoptanteCheckinGates(existingPet.id, adoptanteId);
    return;
  }

  const intakeDate = daysAgo(75);
  const eligibilityDate = daysAgo(50);
  const adoptionDate = daysAgo(20);

  // Registered by the shelter operator the day she is taken in (same rationale
  // as Argo). estimatedWeightKg stays null — no weight_recorded events back a
  // cache value, and the re-derivation sweep would read one as drift.
  const petId = await registerSpinePet({
    token: MORA_PUBLIC_TOKEN,
    name: "Mora",
    breed: "Mestiza",
    color: "Negra con pecho blanco",
    sex: "female",
    dateOfBirth: "2024-02-10",
    birthDateIsEstimated: true,
    estimatedWeightKg: null,
    acquisitionMethod: "found_stray",
    province: "CABA",
    locality: "Palermo",
    registeredAt: intakeDate,
    actorUserId: operator.id,
  });
  if (!petId) return;

  // Shelter custody: same hand-off as Argo — registerPet always writes an
  // OWNER ownership, so the refuge takes her over on the spine.
  const handoffAt = await handSpinePetToShelter({
    petId,
    orgId,
    operatorId: operator.id,
    registeredAt: intakeDate,
  });

  // Intake asiento.
  await db.insert(schemas.petEvents).values({
    petId,
    eventType: "shelter_intake_recorded",
    occurredAt: handoffAt,
    authorRole: "shelter",
    authorOrganizationId: orgId,
    authorVerified: true,
    payload: {
      intake_kind: "stray",
      location_found: "Plaza Inmigrantes de Armenia, Palermo",
      condition_on_intake: "good",
      notes: "Perra joven, sociable. Sin chip. Se adapta bien al refugio.",
    },
  });

  // Apta para adopción — event + cache dual-write. replayPetAdoptionEligibility
  // derives eligibilitySetAt from the event's recordedAt (latest event wins),
  // so the cache mirrors the value the DB actually stored.
  const eligibilityPayload = validateEventPayload("adoption_eligibility_set", {
    eligible: true,
  });
  const [eligibilityEvent] = await db
    .insert(schemas.petEvents)
    .values({
      petId,
      eventType: "adoption_eligibility_set",
      occurredAt: eligibilityDate,
      recordedAt: eligibilityDate,
      authorRole: "shelter",
      authorOrganizationId: orgId,
      authorVerified: true,
      payload: eligibilityPayload,
    })
    .returning({ recordedAt: schemas.petEvents.recordedAt });
  await db
    .update(schemas.pets)
    .set({ adoptionEligible: true, adoptionEligibilitySetAt: eligibilityEvent.recordedAt })
    .where(eq(schemas.pets.id, petId));

  // 3) Adoption finalization — transactional, mirroring insertAdoptionFinalized.
  const adoptionPayload = validateEventPayload("adoption_finalized", {
    previous_owner_organization_id: orgId,
    adopter_user_id: adoptanteId,
    foster_user_id: null,
    contract_attachment_id: null,
    post_adoption_followup_months: 6,
    notes: "Adopción presencial en el refugio. Entrevista y visita al hogar completadas.",
    adopted_from_application_id: null,
  });

  await db.transaction(async (tx) => {
    const [custody] = await tx
      .select({ id: schemas.ownerships.id })
      .from(schemas.ownerships)
      .where(
        and(
          eq(schemas.ownerships.petId, petId),
          eq(schemas.ownerships.role, "shelter_custody"),
          isNull(schemas.ownerships.endedAt),
        ),
      )
      .limit(1);
    if (!custody) throw new Error("Mora sin fila de custodia activa — estado inesperado.");

    await tx
      .update(schemas.ownerships)
      .set({ endedAt: adoptionDate })
      .where(eq(schemas.ownerships.id, custody.id));

    await tx.insert(schemas.ownerships).values({
      petId,
      ownerUserId: adoptanteId,
      role: "owner",
      startedAt: adoptionDate,
      transferredFromId: custody.id,
    });

    const [adoptionEvent] = await tx
      .insert(schemas.petEvents)
      .values({
        petId,
        eventType: "adoption_finalized",
        occurredAt: adoptionDate,
        recordedAt: adoptionDate,
        recordedByUserId: operator.id,
        authorRole: "shelter",
        authorOrganizationId: orgId,
        authorVerified: true,
        payload: adoptionPayload,
      })
      .returning({ id: schemas.petEvents.id });

    // Post-adoption check-in reminders — same windows (≤ followup 6 months)
    // and copy as the production writer, so the 1-month reminder is OPEN and
    // ~10 days out from today's re-anchored daysAgo(20) adoption.
    const checkinWindows = [1, 3, 6] as const;
    await tx.insert(schemas.reminders).values(
      checkinWindows.map((m) => {
        const dueDate = new Date(adoptionDate);
        dueDate.setMonth(dueDate.getMonth() + m);
        return {
          petId,
          userId: adoptanteId as string,
          reminderType: "post_adoption_checkin" as const,
          dueAt: dueDate,
          title: `Seguimiento post-adopción a los ${m} ${m === 1 ? "mes" : "meses"}`,
          description:
            "Refugio Patitas del Norte pidió un check-in sobre Mora. Subí fotos y contanos cómo está.",
          sourceEventId: adoptionEvent.id,
        };
      }),
    );
  });

  log(
    "OK",
    `Mora creada (${MORA_PUBLIC_TOKEN}) — intake → apta → adoptada por ${ADOPTANTE_EMAIL}, 3 recordatorios de check-in`,
  );

  await verifyAdoptanteCheckinGates(petId, adoptanteId);
}

/**
 * Verifies the exact gates the check-in page enforces: the shared
 * isPetAdoptedByUser predicate (latest adoption_finalized names this user)
 * and an OPEN post_adoption_checkin reminder for the pair. Runs on every
 * spine execution — including the existence-skip path — so a half-seeded
 * Mora fails loudly instead of silently demoing a 404.
 */
async function verifyAdoptanteCheckinGates(petId: string, userId: string): Promise<void> {
  const adopted = await isPetAdoptedByUser(petId, userId);
  const [openReminder] = await db
    .select({ id: schemas.reminders.id, dueAt: schemas.reminders.dueAt })
    .from(schemas.reminders)
    .where(
      and(
        eq(schemas.reminders.petId, petId),
        eq(schemas.reminders.userId, userId),
        eq(schemas.reminders.reminderType, "post_adoption_checkin"),
        isNull(schemas.reminders.completedAt),
      ),
    )
    .orderBy(schemas.reminders.dueAt)
    .limit(1);

  if (!adopted) {
    log("FAIL", "Verificación A9: isPetAdoptedByUser=false — el check-in va a responder 404.");
    return;
  }
  if (!openReminder) {
    log(
      "FAIL",
      "Verificación A9: no hay reminder post_adoption_checkin abierto — la página va a mostrar 'Sin check-ins pendientes'.",
    );
    return;
  }
  log(
    "OK",
    `Verificación A9: isPetAdoptedByUser=true, reminder abierto (vence ${openReminder.dueAt.toISOString().slice(0, 10)}).`,
  );
}

// ---------------------------------------------------------------------------
// 9. Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("INFO", "DIM Demo Spine — comenzando.");
  log("INFO", `Supabase URL: ${SUPABASE_URL}`);

  try {
    await seedArgo();
    await seedCarlaVetUpgrade();
    await seedWelfareReports();
    await seedInScopeSubjectReport();
    await deriveWelfareToAuthority();
    await seedCustodyDisputeDemo();
    await seedAdoptanteMora();
    log("DONE", "Spine seeded. Cycles 1, 3, 4 y 5 listos.");
    log(
      "INFO",
      "Próximo paso: el guión de ensayo vive en la documentación interna (dim-interno:docs/demo/).",
    );
  } catch (e) {
    log("FAIL", `Error: ${(e as Error).message}`);
    console.error(e);
    process.exit(1);
  }
}

main().then(() => process.exit(0));
