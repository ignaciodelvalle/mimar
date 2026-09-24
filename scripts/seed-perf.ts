/**
 * DIM Performance / Volume Seed — seed-perf.ts
 *
 * Creates ~2 000 synthetic pets attached to owner@dim.test for performance
 * and pagination testing. All perf pets are prefixed with "PERF-" so they
 * can be found and cleaned up reliably.
 *
 * ─── PERF- TAG CONTRACT ────────────────────────────────────────────────────
 *   Every pet's `name` starts with "PERF-" followed by a zero-padded
 *   six-digit index (e.g. "PERF-000042 Firulais"). Cleanup (--clean) keys
 *   off `name LIKE 'PERF-%'` on the `pets` table and cascades through FK-
 *   dependent tables in safe order: custody_disputes → pet_events → cases →
 *   ownerships → pets.
 *
 * ─── IDEMPOTENCY KEY ───────────────────────────────────────────────────────
 *   Deterministic publicToken: "PERF-<zero-padded-index>" (e.g. "PERF-000042").
 *   Re-running with the same --count skips pets whose token already exists.
 *   New runs with a higher --count add only the missing range.
 *
 * ─── SHOWCASE COHORT ───────────────────────────────────────────────────────
 *   The first SHOWCASE_COUNT pets (default 3) are "showcase" pets. Each one
 *   receives ONE event of EVERY type in EVENT_TYPES (all 46), with realistic
 *   es-AR payloads, so opening any showcase pet renders the full event catalog.
 *   Showcase pets are normal PERF-tagged pets, so --clean removes them too.
 *   Idempotency: showcase events use clientIdempotencyKey derived from
 *   (petIndex, eventType) so re-runs skip already-inserted events.
 *
 * ─── EXHAUSTIVENESS GUARANTEE ──────────────────────────────────────────────
 *   buildShowcasePayloads returns a Record<EventType, () => payload> asserted
 *   with `satisfies Record<EventType, () => Record<string, unknown>>` so
 *   TypeScript rejects any missing or extra event type at compile time.
 *
 * ─── STATE SHOWCASE ────────────────────────────────────────────────────────
 *   buildStateShowcase() creates one deterministic PERF-STATE-* pet per every
 *   possible pet state value so the product owner can see each state:
 *     - pets.status: active, lost, deceased
 *     - pets.pregnancyStatus: in_progress, completed_live_birth,
 *       completed_stillbirth, completed_miscarriage, completed_termination
 *     - pets.rabiesObservationStatus: in_progress, completed_negative,
 *       completed_positive_rabies, completed_dead, completed_lost_to_followup
 *     - ownerships.role: owner, co_owner, shelter_custody, foster, caretaker
 *     - adoption listed (adoptionListedAt set, adoptionListingPausedAt null)
 *     - adoption listing paused (both timestamps set)
 *     - pets.inCustodyDispute = true (+ custody_disputes row + event)
 *     - pets.potentiallyDangerousBreed = true (+ dangerous_breed_attested event)
 *   Idempotency: publicToken = "PERF-STATE-<slug>" — re-runs skip existing.
 *   --clean removes them along with all other PERF-tagged data.
 *
 * ─── CLI FLAGS ─────────────────────────────────────────────────────────────
 *   --count=N      Total pets to create (default 2000).
 *   --allow-remote Required to target a non-local DB (staging).
 *   --clean        Delete ALL perf-tagged data (FK-safe order) then exit.
 *   --dry-run      Print plan and exit without writing.
 *
 * ─── LOCAL-ONLY GUARD ──────────────────────────────────────────────────────
 *   Refuses to run against a non-local DATABASE_URL host unless --allow-remote
 *   is passed. ALWAYS refuses when NODE_ENV=production.
 *   Allowed local hosts: 127.0.0.1, localhost, host.docker.internal, ::1.
 *
 * ─── RUN COMMANDS ──────────────────────────────────────────────────────────
 *   # Local validation first (small count):
 *   pnpm seed:perf -- --count=20
 *
 *   # Full local run:
 *   pnpm seed:perf
 *
 *   # Staging (requires explicit opt-in):
 *   pnpm seed:perf -- --allow-remote --count=2000
 *
 *   # Cleanup (safe to run repeatedly):
 *   pnpm seed:perf -- --clean
 *   pnpm seed:perf -- --clean --allow-remote   # staging cleanup
 *
 * Validated against a local Supabase stack (--count=20): 46 distinct event
 * types confirmed in the showcase cohort. State showcase confirmed with all
 * 20 state values present. Idempotent re-run and --clean confirmed working.
 */

// ---------------------------------------------------------------------------
// 0. Type-only imports (compile-time only — no runtime cost)
// ---------------------------------------------------------------------------

import type { EventType } from "../db/schema";

// ---------------------------------------------------------------------------
// 1. Env bootstrap (must run before db/index.ts is imported)
// ---------------------------------------------------------------------------

import { config as loadEnv } from "dotenv";

import { assertNotSplitEnv } from "./_env-target";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// 2. Parse CLI flags early (some drive the safety guard below)
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function getFlag(name: string): string | null {
  for (const arg of argv) {
    const prefix = `--${name}=`;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

const COUNT = Number(getFlag("count") ?? "2000");
const ALLOW_REMOTE = argv.includes("--allow-remote");
const CLEAN = argv.includes("--clean");
const DRY_RUN = argv.includes("--dry-run");

if (!Number.isInteger(COUNT) || COUNT < 1) {
  console.error(`[FAIL] --count must be a positive integer, got: ${getFlag("count")}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 3. Safety guards (mirrors db-bootstrap.ts and seed-test-users.ts patterns)
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "::1"]);

function parsePgHost(url: string): string | null {
  const match = url.match(/^postgres(?:ql)?:\/\/[^@]+@([^:/]+)/);
  return match ? match[1] : null;
}

if (!CLEAN && !DRY_RUN) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local — aborting.",
    );
    process.exit(2);
  }
  if (!DATABASE_URL) {
    console.error("Missing DATABASE_URL in .env.local — aborting.");
    process.exit(2);
  }
}

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed: NODE_ENV=production. Aborting.");
  process.exit(2);
}

const dbHost = DATABASE_URL ? parsePgHost(DATABASE_URL) : null;
// Los guards de abajo colapsan tres estados en dos: `!isLocalDb || !isLocalSupabase`
// declara "remoto" con UNA sola URL remota, asi que con --allow-remote el entorno
// PARTIDO (una local, la otra remota) pasaba igual — que fue como un seed llego a
// escribir en staging leyendo auth de local. Esto lo corta antes; el aborto
// especifico de este script sigue siendo el que explica el caso remoto.
assertNotSplitEnv(SUPABASE_URL, DATABASE_URL, "seed:perf");

const isLocalDb = dbHost ? LOCAL_HOSTS.has(dbHost) : true; // if no URL yet, let it fail at import
const isLocalSupabase =
  !SUPABASE_URL || SUPABASE_URL.includes("127.0.0.1") || SUPABASE_URL.includes("localhost");

if (!ALLOW_REMOTE && (!isLocalDb || !isLocalSupabase)) {
  console.error(
    [
      "",
      "==============================================================",
      "  ABORT: seed-perf target is NOT a local Postgres / Supabase.",
      "==============================================================",
      `  DATABASE_URL host : ${dbHost ?? "(not set)"}`,
      `  SUPABASE_URL      : ${SUPABASE_URL}`,
      `  Allowed local hosts: ${[...LOCAL_HOSTS].join(", ")}`,
      "",
      "  This script inserts thousands of rows. Running it against a",
      "  remote DB by mistake is a real incident.",
      "",
      "  If you meant to target this host, re-run with --allow-remote.",
      "  Otherwise edit .env.local to point at the local Postgres.",
      "==============================================================",
      "",
    ].join("\n"),
  );
  process.exit(4);
}

if (ALLOW_REMOTE && (!isLocalDb || !isLocalSupabase)) {
  console.warn(
    [
      "",
      "==============================================================",
      "  WARNING: --allow-remote in effect.",
      `  DATABASE_URL host: ${dbHost}`,
      `  SUPABASE_URL     : ${SUPABASE_URL}`,
      "  About to write synthetic data to a REMOTE database.",
      "==============================================================",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 4. Deferred imports (after env is populated)
// ---------------------------------------------------------------------------

const { createClient: createSdkClient } = await import("@supabase/supabase-js");
const { eq, like, inArray, isNull, sql } = await import("drizzle-orm");
const {
  db,
  pets,
  ownerships,
  petEvents,
  cases: casesTable,
  organizations,
  custodyDisputes,
  govtAssignments,
} = await import("../db");
const { writePoint } = await import("@/lib/domain/location");
const { EVENT_TYPES } = await import("../db/schema");

// ---------------------------------------------------------------------------
// 5. Constants + helpers
// ---------------------------------------------------------------------------

const OWNER_EMAIL = "owner@dim.test";
const PERF_TAG = "PERF-";
const BATCH_SIZE = 200;

/**
 * Seed-provenance marker written to pets.seed_tag (migration 0160).
 *
 * This seed DELIBERATELY bulk-inserts pets instead of driving the real intake
 * use-case (registerPet), because its entire purpose is VOLUME — it exists to
 * put enough rows in front of the query planner to expose slow paths, not to
 * exercise intake fidelity. One transaction per pet would make it useless for
 * that job.
 *
 * That trade is only defensible if it is VISIBLE. Stamping seed_tag='perf'
 * lets the spine-integrity fence exempt these rows by an explicit, greppable
 * predicate instead of silently pattern-matching the PERF- token prefix — so
 * "this fixture has no pet_registered event" is a recorded decision rather
 * than an accident nobody notices.
 */
const SEED_TAG_PERF = "perf";

/**
 * Number of "showcase" pets that each carry one event of every EVENT_TYPE.
 * These are the first SHOWCASE_COUNT pets by index (PERF-000000 …).
 * They are normal PERF-tagged pets so --clean removes them.
 */
const SHOWCASE_COUNT = 3;

// Valid (province, locality) pairs from canonical province list.
// Spread across diverse jurisdictions so govt dashboards light up.
const JURISDICTIONS: ReadonlyArray<{ readonly province: string; readonly locality: string }> = [
  { province: "Buenos Aires", locality: "La Plata" },
  { province: "Buenos Aires", locality: "Mar del Plata" },
  { province: "Buenos Aires", locality: "Bahía Blanca" },
  { province: "Buenos Aires", locality: "Quilmes" },
  { province: "Buenos Aires", locality: "Lanús" },
  { province: "Buenos Aires", locality: "San Justo" },
  { province: "Buenos Aires", locality: "Lomas de Zamora" },
  { province: "Buenos Aires", locality: "Morón" },
  { province: "Buenos Aires", locality: "Tigre" },
  { province: "Buenos Aires", locality: "San Isidro" },
  { province: "CABA", locality: "Palermo" },
  { province: "CABA", locality: "Recoleta" },
  { province: "CABA", locality: "San Telmo" },
  { province: "CABA", locality: "Caballito" },
  { province: "CABA", locality: "Boedo" },
  { province: "CABA", locality: "Saavedra" },
  { province: "CABA", locality: "Belgrano" },
  { province: "CABA", locality: "Puerto Madero" },
  { province: "CABA", locality: "Retiro" },
  { province: "CABA", locality: "Flores" },
  { province: "Córdoba", locality: "Córdoba" },
  { province: "Córdoba", locality: "Villa Carlos Paz" },
  { province: "Córdoba", locality: "Río Cuarto" },
  { province: "Córdoba", locality: "Falda del Carmen" },
  { province: "Santa Fe", locality: "Rosario" },
  { province: "Santa Fe", locality: "Santa Fe" },
  { province: "Santa Fe", locality: "Rafaela" },
  { province: "Mendoza", locality: "Mendoza" },
  { province: "Mendoza", locality: "San Rafael" },
  { province: "Tucumán", locality: "San Miguel de Tucumán" },
  { province: "Salta", locality: "Salta" },
  { province: "Salta", locality: "Tartagal" },
  { province: "Jujuy", locality: "San Salvador de Jujuy" },
  { province: "Río Negro", locality: "Bariloche" },
  { province: "Río Negro", locality: "Viedma" },
  { province: "Neuquén", locality: "Neuquén" },
  { province: "Chubut", locality: "Rawson" },
  { province: "Chubut", locality: "Comodoro Rivadavia" },
  { province: "Tierra del Fuego", locality: "Ushuaia" },
  { province: "Misiones", locality: "Posadas" },
  { province: "Corrientes", locality: "Corrientes" },
  { province: "Entre Ríos", locality: "Paraná" },
  { province: "Chaco", locality: "Resistencia" },
  { province: "Formosa", locality: "Formosa" },
  { province: "Santiago del Estero", locality: "Santiago del Estero" },
  { province: "San Juan", locality: "San Juan" },
  { province: "San Luis", locality: "San Luis" },
  { province: "La Rioja", locality: "La Rioja" },
  { province: "La Pampa", locality: "Santa Rosa" },
  { province: "Catamarca", locality: "San Fernando del Valle de Catamarca" },
] as const;

const DOG_BREEDS = [
  "Mestizo",
  "Labrador Retriever",
  "Golden Retriever",
  "Beagle",
  "Caniche",
  "Chihuahua",
  "Boxer",
  "Dogo Argentino",
  "Cocker Spaniel",
  "Border Collie",
  "Akita Inu",
  "Rough Collie",
  "Cairn Terrier",
  "Husky Siberiano",
  "Poodle",
  "Bulldog Francés",
] as const;

const CAT_BREEDS = [
  "Común europeo",
  "Siamés",
  "Persa",
  "Maine Coon",
  "Angora",
  "Ragdoll",
  "British Shorthair",
  "Bengalí",
  "Abisinio",
  "Sphynx",
] as const;

const OTHER_BREEDS = ["Común", "Enano", "Rex", "Angora", "Toy"] as const;

const PET_NAMES = [
  "Firulais",
  "Luna",
  "Max",
  "Michi",
  "Toto",
  "Bella",
  "Rocky",
  "Coco",
  "Nala",
  "Simba",
  "Atún",
  "Sushi",
  "Milo",
  "Lola",
  "Toby",
  "Nina",
  "Thor",
  "Kira",
  "Bruno",
  "Canela",
  "Pipo",
  "Mia",
  "Luca",
  "Duna",
  "Rex",
  "Laika",
  "Pancho",
  "Mora",
  "Gato",
  "Perla",
  "Fido",
  "Kiara",
  "Zeus",
  "Pinta",
  "Apolo",
] as const;

// Weighted species distribution
const SPECIES_DIST: ReadonlyArray<{ readonly species: string; readonly weight: number }> = [
  { species: "dog", weight: 55 },
  { species: "cat", weight: 38 },
  { species: "rabbit", weight: 4 },
  { species: "other", weight: 3 },
] as const;

const COMMON_EVENT_TYPES = [
  "pet_registered",
  "vaccination_administered",
  "deworming_administered",
  "vet_visit_logged",
  "weight_recorded",
  "note_added",
  "microchip_implanted",
  "sterilization_performed",
] as const;

const ACQUISITION_METHODS = ["adopted", "found_stray", "gift", "other"] as const;
const SEXES = ["male", "female", "unknown"] as const;

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "FAIL";
function log(tag: LogTag, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${tag.padEnd(4)}] ${msg}`);
}

/** Simple deterministic pseudo-random generator (LCG). */
function seededRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223;
    s >>>= 0;
    return s / 0x100000000;
  };
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

function pickWeighted(
  dist: ReadonlyArray<{ readonly species: string; readonly weight: number }>,
  rng: () => number,
): string {
  const total = dist.reduce((s, d) => s + d.weight, 0);
  let r = rng() * total;
  for (const d of dist) {
    r -= d.weight;
    if (r <= 0) return d.species;
  }
  return dist[dist.length - 1].species;
}

/** Deterministic public token — also serves as the idempotency key. */
function perfPublicToken(i: number): string {
  return `PERF-${String(i).padStart(6, "0")}`;
}

/** Name with the PERF- tag prefix (the cleanup key). */
function perfName(i: number, baseName: string): string {
  return `${PERF_TAG}${String(i).padStart(6, "0")} ${baseName}`;
}

/** Random AR coordinates: lat -22..-56, lng -53..-72. */
function randomCoords(rng: () => number): { lat: number; lng: number } {
  const lat = -(22 + rng() * 34);
  const lng = -(53 + rng() * 19);
  return { lat, lng };
}

// ---------------------------------------------------------------------------
// 6. findAuthUserIdByEmail (mirrors seed-test-users.ts exactly)
// ---------------------------------------------------------------------------

async function findAuthUserIdByEmail(supabase: any, email: string): Promise<string | null> {
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      throw new Error(`listUsers failed on page ${page}: ${error.message ?? "(no message)"}`);
    }
    const users = data.users as Array<{ email: string; id: string }>;
    const hit = users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (users.length < 200) return null;
    page++;
  }
}

// ---------------------------------------------------------------------------
// 7. Find the "Refugio Test (Seed)" org created by seed-test-users
// ---------------------------------------------------------------------------

async function findSeedOrgId(): Promise<string | null> {
  // createOrganizationForUser (app/actions/upgrade.ts) strips dashes from the
  // CUIT before storing, so seed-test-users' "30-99999999-9" lands as
  // "30999999999". Look it up in that normalized form.
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.cuit, "30999999999"))
    .limit(1);
  return org?.id ?? null;
}

// ---------------------------------------------------------------------------
// 8. --clean: delete all perf-tagged data in FK-safe order
// ---------------------------------------------------------------------------

async function runClean(): Promise<void> {
  log("STEP", "--clean: removing all PERF-tagged data");

  const perfPets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(like(pets.name, `${PERF_TAG}%`));

  if (perfPets.length === 0) {
    log("INFO", "No PERF-tagged pets found — nothing to delete.");
    return;
  }
  log("INFO", `Found ${perfPets.length} PERF-tagged pets`);
  const perfPetIds = perfPets.map((p) => p.id);

  // pet_events is append-only (enforce_pet_events_append_only trigger). The
  // sanctioned override is to set app.allow_event_mutation=true +
  // app.allow_event_mutation_actor=<uuid> in the SAME transaction; the trigger
  // then permits the delete and writes an audit_log row per deleted event.
  // The actor MUST be a profiles.id — audit_log.actor_user_id FKs profiles,
  // and some auth.users rows have no profile (so select from profiles, not
  // auth.users, or the trigger's audit insert fails with a FK violation).
  const actorRows = (await db.execute(sql`select id from profiles limit 1`)) as unknown as Array<{
    id: string;
  }>;
  const actorId = actorRows[0]?.id ?? null;
  if (!actorId) {
    log("FAIL", "No profile found to act as event-mutation override actor — aborting clean.");
    return;
  }

  const DEL_BATCH = 500;
  for (let start = 0; start < perfPetIds.length; start += DEL_BATCH) {
    const batch = perfPetIds.slice(start, start + DEL_BATCH);

    // FK-safe order: custody_disputes → pet_events → cases → ownerships → pets,
    // inside one tx so the append-only override (set_config is_local=true)
    // covers the pet_event deletes.
    //
    // custody_disputes.raising_event_id → pet_events.id (ON DELETE CASCADE)
    // but custody_disputes is also the referencing side for petEvents via
    // raisingEventId — deleting custody_disputes first avoids ON DELETE RESTRICT
    // issues if the DB version has that constraint direction. Safe to delete
    // before petEvents regardless.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.allow_event_mutation', 'true', true)`);
      await tx.execute(sql`select set_config('app.allow_event_mutation_actor', ${actorId}, true)`);
      await tx.delete(custodyDisputes).where(inArray(custodyDisputes.petId, batch));
      await tx.delete(petEvents).where(inArray(petEvents.petId, batch));
      await tx.delete(casesTable).where(inArray(casesTable.primaryPetId, batch));
      await tx.delete(ownerships).where(inArray(ownerships.petId, batch));
      await tx.delete(pets).where(inArray(pets.id, batch));
    });

    log("OK", `  Deleted batch [${start}..${start + batch.length - 1}]`);
  }

  log("DONE", `Clean complete — ${perfPets.length} PERF pets removed`);
}

// ---------------------------------------------------------------------------
// 9. Build events for one pet
// ---------------------------------------------------------------------------

function buildPetEvents(
  petId: string,
  ownerUserId: string,
  species: string,
  eventCount: number,
  rng: () => number,
): Array<Record<string, unknown>> {
  const baseDate = new Date(Date.now() - rng() * 3 * 365 * 24 * 3600 * 1000);
  const events: Array<Record<string, unknown>> = [];

  // Always first: pet_registered
  events.push({
    petId,
    eventType: "pet_registered",
    occurredAt: baseDate,
    recordedByUserId: ownerUserId,
    authorRole: "owner",
    authorVerified: false,
    payload: { source: "seed-perf", species },
  });

  // Shuffle extra event types deterministically
  const extras = Math.min(eventCount - 1, COMMON_EVENT_TYPES.length - 1);
  const typesPool = [...COMMON_EVENT_TYPES].filter((t) => t !== "pet_registered");
  for (let i = typesPool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = typesPool[i];
    typesPool[i] = typesPool[j];
    typesPool[j] = tmp;
  }

  for (let e = 0; e < extras; e++) {
    const evtType = typesPool[e];
    const occurredAt = new Date(baseDate.getTime() + (e + 1) * 7 * 24 * 3600 * 1000);
    let payload: Record<string, unknown> = { source: "seed-perf" };

    if (evtType === "vaccination_administered") {
      payload = { source: "seed-perf", vaccine_name: "antirrábica", brand: "Defensor 3" };
    } else if (evtType === "deworming_administered") {
      payload = { source: "seed-perf", product: "ivermectina", type: "internal" };
    } else if (evtType === "vet_visit_logged") {
      payload = { source: "seed-perf", reason: "wellness" };
    } else if (evtType === "weight_recorded") {
      payload = { source: "seed-perf", kg: 3 + Math.floor(rng() * 30) };
    } else if (evtType === "note_added") {
      payload = {
        source: "seed-perf",
        category: "observación",
        text: "Mascota de prueba de carga — seed-perf",
      };
    } else if (evtType === "microchip_implanted") {
      // Deterministic chip number to avoid duplicate chip collision on idempotent re-runs
      const chipSuffix = String(Math.floor(rng() * 1e9)).padStart(9, "0");
      payload = {
        source: "seed-perf",
        chip_number: `858000${chipSuffix}`,
        country_code: "858",
        implanted_by: null,
        location_on_body: null,
        implant_date_known: false,
      };
    } else if (evtType === "sterilization_performed") {
      payload = { source: "seed-perf", procedure: "castración", performed_by: null };
    }

    events.push({
      petId,
      eventType: evtType,
      occurredAt,
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      authorVerified: false,
      payload,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// 10. Showcase cohort — one event of every type, exhaustiveness-checked
// ---------------------------------------------------------------------------

/**
 * Returns one event row per EVENT_TYPES entry for a showcase pet.
 *
 * Exhaustiveness: the inner payload map is declared as
 *   satisfies Record<EventType, () => Record<string, unknown>>
 * so TypeScript rejects any missing entry at compile time.
 *
 * Chronology: events are spread over a 46-week span so the timeline
 * renders with visible chronological spacing.
 *
 * Idempotency: each row carries a deterministic clientIdempotencyKey
 * built from (petIndex * 1000 + eventIndex). If the key already exists
 * for (petId, eventType), the insert is a no-op (ON CONFLICT DO NOTHING
 * via the pet_events_idempotency_idx partial unique index).
 */
function buildShowcaseEvents(
  petId: string,
  ownerUserId: string,
  petIndex: number,
): Array<Record<string, unknown>> {
  // Base date: 3 years ago, pet-specific offset for variety
  const BASE_MS = Date.now() - (3 * 365 + petIndex * 7) * 24 * 3600 * 1000;
  // Chip numbers are deterministic per pet to avoid unique-constraint conflicts
  const chipBase = `858${String(petIndex + 1).padStart(3, "0")}`;

  /**
   * Payload factory per event type.
   * All types in EVENT_TYPES must appear here — TypeScript will error otherwise.
   */
  const payloadFactory = {
    // ── Lifecycle ──────────────────────────────────────────────────────────
    pet_registered: () => ({
      source: "seed-perf",
      acquisition_method: "adopted",
      has_microchip: true,
      has_photo: false,
    }),
    pet_profile_updated: () => ({
      source: "seed-perf",
      changes: [{ field: "color", old: "desconocido", new: "marrón" }],
    }),
    status_changed: () => ({
      source: "seed-perf",
      from_status: "active",
      to_status: "active",
      reason: "showcase_demo",
    }),
    death_recorded: () => ({
      source: "seed-perf",
      cause: "natural",
      cause_detail: "vejez (showcase demo — no pet was harmed)",
      confirmed_by_vet: false,
      vet_name: null,
      disposition_method: "owner_burial",
      facility: null,
      death_at_clinic: false,
      vet_contacted_owner: "yes",
      vet_decided_alone: null,
      is_reportable: false,
      during_rabies_observation: false,
    }),
    // ── Preventive medicine ────────────────────────────────────────────────
    vaccination_administered: () => ({
      source: "seed-perf",
      vaccine_name: "antirrábica",
      brand: "Defensor 3",
      batch: "RABA-2024-0042",
      administered_by: "Dra. García",
      next_due_at: "2025-07-01",
    }),
    deworming_administered: () => ({
      source: "seed-perf",
      product: "ivermectina",
      type: "internal",
      administered_by: "Dra. García",
      next_due_at: null,
    }),
    sterilization_performed: () => ({
      source: "seed-perf",
      procedure: "castración",
      performed_by: "Dr. Pérez",
    }),
    // ── Medication ─────────────────────────────────────────────────────────
    medication_started: () => ({
      source: "seed-perf",
      drug_name: "prednisona",
      dose: "1 mg/kg",
      frequency: "SID",
      first_dose_at: new Date(BASE_MS + 15 * 7 * 24 * 3600 * 1000).toISOString(),
      schedule_count: 30,
    }),
    medication_stopped: () => ({
      source: "seed-perf",
      reason: "tratamiento completado",
    }),
    // ── Clinical encounters ────────────────────────────────────────────────
    vet_visit_logged: () => ({
      source: "seed-perf",
      reason: "wellness",
      diagnosis: "sano, BCS 5/9",
      vet_name: "Dra. García",
    }),
    // ── Body metrics ───────────────────────────────────────────────────────
    weight_recorded: () => ({
      source: "seed-perf",
      kg: 12 + petIndex,
    }),
    // ── Identification & legal ─────────────────────────────────────────────
    microchip_implanted: () => ({
      source: "seed-perf",
      chip_number: `${chipBase}000001`,
      country_code: "858",
      implanted_by: "Dr. Rodríguez",
      location_on_body: "interscapular",
      implant_date_known: true,
    }),
    microchip_replaced: () => ({
      source: "seed-perf",
      previous_chip_number: `${chipBase}000001`,
      new_chip_number: `${chipBase}000002`,
      reason: "damaged",
      replaced_by: "Dr. Rodríguez",
      replaced_at: new Date(BASE_MS + 20 * 7 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      actor_role: "vet",
    }),
    tattoo_recorded: () => ({
      source: "seed-perf",
      tattoo_code: `PERF-${String(petIndex).padStart(3, "0")}-TAT`,
      location_on_body: "inner_ear_left",
      description: "Tatuaje de identificación (showcase seed-perf)",
      recorded_by: "Dr. Rodríguez",
      tattoo_date_known: true,
    }),
    tattoo_updated: () => ({
      source: "seed-perf",
      previous_tattoo_code: `PERF-${String(petIndex).padStart(3, "0")}-TAT`,
      new_tattoo_code: `PERF-${String(petIndex).padStart(3, "0")}-TAT`,
      reason: "Re-tatuaje preventivo por fading (showcase)",
    }),
    dangerous_breed_attested: () => ({
      source: "seed-perf",
      registry: "caba_4078",
      registry_id: `PPP-CABA-PERF-${String(petIndex).padStart(4, "0")}`,
      attested_at: new Date(BASE_MS + 3 * 7 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      attestor_dni_verified: true,
    }),
    // ── Free-form ──────────────────────────────────────────────────────────
    note_added: () => ({
      source: "seed-perf",
      category: "observación",
      text: `Mascota showcase #${petIndex} — nota de prueba integral del catálogo de eventos.`,
    }),
    // ── System / observed ──────────────────────────────────────────────────
    credential_scanned: () => ({
      source: "seed-perf",
      is_self_scan: false,
      viewer_authenticated: false,
      viewer_name: "vecino (showcase)",
    }),
    incident_reported: () => ({
      source: "seed-perf",
      incident_type: "fall",
      severity: "minor",
      injuries_summary: "Caída de silla — sin heridas (showcase demo)",
      vet_involved: false,
      location_description: null,
      rabies_vaccine_valid_at_incident: true,
    }),
    rabies_observation_started: () => ({
      source: "seed-perf",
      incident_reported_event_id: `evt-showcase-${petIndex}-incident`,
      expected_end_at: new Date(BASE_MS + 30 * 7 * 24 * 3600 * 1000 + 10 * 86400 * 1000)
        .toISOString()
        .slice(0, 10),
      isolation_facility: "Clínica local (showcase)",
      protocol: "Observación 10 días Ley 22.953",
    }),
    rabies_observation_ended: () => ({
      source: "seed-perf",
      outcome: "negative",
      lab_result: "negativo (showcase demo)",
      closed_by_vet: true,
    }),
    medication_dose_taken: () => ({
      source: "seed-perf",
      medication_started_event_id: `evt-showcase-${petIndex}-med`,
      scheduled_for: new Date(BASE_MS + 16 * 7 * 24 * 3600 * 1000).toISOString(),
      reminder_id: null,
    }),
    // ── UI-deferred / non-owner flows ──────────────────────────────────────
    symptom_observed: () => ({
      source: "libreta",
      welfare_report_id: null,
      reporter_role: "owner",
      free_text: "Tos leve ocasional post-ejercicio (showcase demo)",
      matched_symptom_codes: ["cough"],
      alerted_disease_codes: [],
      severity_self_assessed: "mild",
      onset_at: new Date(BASE_MS + 24 * 7 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    }),
    abandonment_reported: () => ({
      source: "seed-perf",
      welfare_report_id: "00000000-0000-0000-0000-000000000099",
      reporter_role: "owner",
      description: "Reporte de abandono temporal (showcase demo — no hubo abandono real)",
    }),
    maltreatment_reported: () => ({
      source: "seed-perf",
      welfare_report_id: "00000000-0000-0000-0000-000000000098",
      reporter_role: "witness",
      description: "Reporte de maltrato (showcase demo — fictional)",
      severity: "low",
      kind: "neglect",
    }),
    // ── Unified clinical ───────────────────────────────────────────────────
    clinical_info_logged: () => ({
      source: "seed-perf",
      sub_kind: "lab_work",
      title: "Hemograma completo de control",
      details: "Valores dentro de rango normal (showcase demo)",
    }),
    // ── Custody & adoption ─────────────────────────────────────────────────
    shelter_intake_recorded: () => ({
      source: "seed-perf",
      intake_reason: "stray_found",
      intake_condition: "healthy",
      rescue_jurisdiction: null,
    }),
    foster_assigned: () => ({
      source: "seed-perf",
      foster_user_id: "showcase-foster-user",
      expected_weeks: 6,
    }),
    foster_ended: () => ({
      source: "seed-perf",
      foster_user_id: "showcase-foster-user",
      ended_by: "shelter",
    }),
    adoption_application_submitted: () => ({
      source: "seed-perf",
      applicant_user_id: "showcase-adopter",
      related_organization_id: "showcase-org",
      housing_type: "casa con patio",
    }),
    adoption_application_resolved: () => ({
      source: "seed-perf",
      application_event_id: `evt-showcase-${petIndex}-app`,
      reviewer_user_id: "showcase-reviewer",
      outcome: "approved",
    }),
    adoption_finalized: () => ({
      source: "seed-perf",
      previous_owner_organization_id: "showcase-org",
      adopter_user_id: "showcase-adopter",
      post_adoption_followup_months: 6,
    }),
    post_adoption_checkin: () => ({
      source: "seed-perf",
      related_organization_id: "showcase-org",
      photo_attachment_ids: [],
      notes: "Primer check-in post-adopción (showcase demo)",
    }),
    adoption_reversed: () => ({
      source: "seed-perf",
      actor: "shelter",
      reason: "Devolución de showcase (demo — no real reversal)",
    }),
    custody_transferred: () => ({
      source: "seed-perf",
      from_user_id: "showcase-prev-owner",
      to_user_id: "showcase-new-owner",
      from_role: "owner",
      to_role: "owner",
      reason: "demostración showcase",
    }),
    ownership_claimed: () => ({
      source: "seed-perf",
      claimed_by_user_id: "00000000-0000-0000-0000-000000000001",
      identifier_kind: "microchip",
    }),
    custody_transfer_proposed: () => ({
      source: "seed-perf",
      from_user_id: "showcase-prev-owner",
      to_user_id: "showcase-new-owner",
      reason: "showcase demo transfer proposal",
      proposed_at: new Date(BASE_MS + 35 * 7 * 24 * 3600 * 1000).toISOString(),
    }),
    custody_transfer_cancelled: () => ({
      source: "seed-perf",
      proposal_event_id: `evt-showcase-${petIndex}-transfer-prop`,
      cancelled_by: "auto_cancel",
      reason: "showcase demo — cancelación de prueba",
    }),
    custody_dispute_raised: () => ({
      source: "seed-perf",
      raised_by_role: "govt",
      reason: "showcase demo — litigio ficticio",
    }),
    custody_dispute_resolved: () => ({
      source: "seed-perf",
      raised_event_id: `evt-showcase-${petIndex}-dispute`,
      resolved_by_role: "govt",
      outcome: "ownership_transferred",
    }),
    // ── Foster volunteers pool ─────────────────────────────────────────────
    foster_proposed: () => ({
      source: "seed-perf",
      foster_user_id: "showcase-foster-user",
      expected_weeks: 4,
    }),
    foster_proposal_resolved: () => ({
      source: "seed-perf",
      proposal_public_token: `prop-showcase-${petIndex}`,
      outcome: "accepted",
    }),
    foster_co_foster_allowed: () => ({
      source: "seed-perf",
      primary_foster_user_id: "showcase-foster-user",
      co_foster_user_id: "showcase-cofoster-user",
      reason: "ayuda durante viaje del foster principal (showcase)",
    }),
    adoption_eligibility_set: () => ({
      source: "seed-perf",
      adoption_eligible: true,
      set_by_user_id: "showcase-org-admin",
      reason: "evaluación temperamento completa — apta (showcase demo)",
    }),
    // ── Surveillance ───────────────────────────────────────────────────────
    outbreak_signal: () => ({
      source: "seed-perf",
      source_symptom_event_id: `evt-showcase-${petIndex}-symptom`,
      triggered_by: "matcher",
      disease_code: "distemper",
      disease_label: "Moquillo canino (showcase demo)",
      match_strength: {
        high_count: 1,
        medium_count: 0,
        low_count: 1,
        matched_symptom_codes: ["cough", "lethargy"],
      },
      pet_jurisdiction_country: "AR",
      pet_jurisdiction_province: "Buenos Aires",
      pet_jurisdiction_locality: "La Plata",
      pet_species: "dog",
    }),
    disease_reported: () => ({
      source: "seed-perf",
      disease: "other",
      confirmed_by_lab: false,
      date_of_onset: new Date(BASE_MS + 24 * 7 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      clinical_notes: "Zoonosis reportable (showcase demo — no enfermedad real)",
    }),
    // movement_recorded — showcase a jurisdiction change (movilidad Fase 1).
    movement_recorded: () => ({
      sub_kind: "jurisdiction_changed",
      from_country: "AR",
      from_province: "Ciudad Autónoma de Buenos Aires",
      from_locality: null,
      to_country: "AR",
      to_province: "Buenos Aires",
      to_locality: "La Plata",
      effective_date: new Date(BASE_MS + 25 * 7 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      reason: "Mudanza (showcase demo)",
    }),
    // event_amended — seed a correction of the first event (vaccination_administered).
    // Uses a deterministic placeholder target_event_id for the seed script.
    event_amended: () => ({
      target_event_id: "00000000-0000-0000-0000-000000000001",
      reason: "Corrección de demostración (seed-perf)",
      changes: [
        { field: "vaccine_name", old: "Antirrábica (demo)", new: "Antirrábica corregida (demo)" },
      ],
      actor_role: "owner",
    }),
    // Physical tag lifecycle (migration 0169). Payloads NEVER carry the
    // activation code; tag_revoked uses `revoke_reason` (not `reason`).
    tag_activated: () => ({
      serial: "TAG-SEED-DEMO",
      lote_id: "LOTE-SEED-PERF",
      source: "self",
    }),
    tag_revoked: () => ({
      serial: "TAG-SEED-DEMO",
      revoke_reason: "owner_request",
      replacement_serial: null,
    }),
    // Temporary caretaker (migration 0189). `caretaker_ended` uses `outcome`,
    // NOT `reason` — erase_subject_data sentinel-redacts the key `reason`
    // across every event type and would destroy the enum fact.
    caretaker_designated: () => ({
      grant_id: "00000000-0000-0000-0000-000000000002",
      grant_public_token: "CGT-SEED-PERF",
      caretaker_user_id: "00000000-0000-0000-0000-000000000003",
      ends_at: "2026-12-31T00:00:00.000Z",
      note: null,
    }),
    caretaker_ended: () => ({
      grant_id: "00000000-0000-0000-0000-000000000002",
      outcome: "expired",
      ends_at: "2026-12-31T00:00:00.000Z",
    }),
    // Rehome sponsorship (rehome-by-titular). `rehome_sponsorship_ended` uses
    // `outcome`, NOT `reason`, for the same erase_subject_data reason as the
    // caretaker pair above.
    rehome_sponsorship_started: () => ({
      ownership_id: "00000000-0000-0000-0000-000000000004",
      sponsoring_organization_id: "00000000-0000-0000-0000-000000000005",
      consented_by_user_id: "00000000-0000-0000-0000-000000000006",
      request_case_public_code: "CAS-SEED-PERF",
      listing_case_id: null,
      note: null,
    }),
    rehome_sponsorship_ended: () => ({
      ownership_id: "00000000-0000-0000-0000-000000000004",
      outcome: "withdrawn_by_titular",
      ended_at: "2026-12-31T00:00:00.000Z",
    }),
    // Content moderation. `target_event_id` deliberately names an id no row
    // holds: the showcase pet's feed items are seeded in the same loop and no
    // ordering here could make it point at a real one. A report that hides
    // nothing is the right seed — the alternative would be a showcase pet whose
    // feed silently loses a row.
    content_reported: () => ({
      surface: "lost_feed",
      target_event_id: "00000000-0000-0000-0000-000000000007",
      target_kind: "sighting",
      category: "other",
      reason: "Seed de performance — no corresponde a un reporte real.",
    }),
  } satisfies Record<EventType, () => Record<string, unknown>>;

  const events: Array<Record<string, unknown>> = [];

  for (let evtIdx = 0; evtIdx < EVENT_TYPES.length; evtIdx++) {
    const eventType = EVENT_TYPES[evtIdx];
    // Spread events over 46 weeks for chronological timeline
    const occurredAt = new Date(BASE_MS + evtIdx * 7 * 24 * 3600 * 1000);

    // Deterministic idempotency key: valid UUID format
    // xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (8-4-4-4-12 hex chars).
    // Encode petIndex in first 4 hex + evtIdx in next 4 hex of first segment.
    // Never collides across pets or event types within the showcase cohort.
    const p = String(petIndex).padStart(4, "0");
    const e = String(evtIdx).padStart(4, "0");
    const keyHex = `${p}${e}-0000-4000-8000-000000000001`;

    events.push({
      petId,
      eventType,
      occurredAt,
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      authorVerified: false,
      payload: payloadFactory[eventType](),
      clientIdempotencyKey: keyHex,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// 11. State showcase — one pet per every possible pet state value
// ---------------------------------------------------------------------------

/**
 * Descriptor for a single state-showcase pet.
 * `token` is the publicToken (PERF-STATE-<slug>) used for idempotency.
 * `label` is the human-readable name shown to the PO.
 */
interface StateSpec {
  readonly token: string;
  readonly label: string;
  readonly petOverrides?: Partial<Record<string, unknown>>;
  readonly ownershipOverride?: {
    readonly ownerUserId?: string | null;
    readonly ownerOrganizationId?: string | null;
    readonly role: string;
  };
  /** Extra ownership rows beyond the primary one (e.g. co_owner secondary row). */
  readonly extraOwnerships?: ReadonlyArray<{
    readonly ownerUserId?: string | null;
    readonly ownerOrganizationId?: string | null;
    readonly role: string;
  }>;
  /** Extra events to emit after pet_registered. */
  readonly extraEvents?: ReadonlyArray<{
    readonly eventType: string;
    readonly payload: Record<string, unknown>;
  }>;
  /** Whether to create a custody_disputes row for this pet. */
  readonly withCustodyDispute?: boolean;
}

/**
 * Build a "PERF-STATE-<slug>" publicToken from a slug string.
 * Deterministic, URL-safe — re-runs skip existing tokens.
 */
function stateToken(slug: string): string {
  return `PERF-STATE-${slug}`;
}

/**
 * Insert a single pet_registered event and return the event id (needed by
 * custody_dispute rows that require a raisingEventId FK).
 */
async function insertStateRegistered(
  petId: string,
  ownerUserId: string,
  slug: string,
): Promise<string> {
  const [evt] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "pet_registered",
      occurredAt: new Date(Date.now() - 365 * 24 * 3600 * 1000),
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      authorVerified: false,
      payload: { source: "seed-perf-state", slug },
    })
    .returning({ id: petEvents.id });
  return evt.id;
}

/**
 * Creates one deterministic PERF-STATE-* pet per possible state value.
 * Idempotent: pets with matching publicToken are skipped.
 * Runs once regardless of --count (state catalog is independent of volume).
 *
 * org-held roles (shelter_custody, foster) require seedOrgId to be present.
 * When absent they are WARN-logged and skipped — the rest of the showcase runs.
 */
async function buildStateShowcase(ownerUserId: string, seedOrgId: string | null): Promise<void> {
  log("STEP", "State showcase — creating one pet per state value");

  const jur = { province: "CABA", locality: "Palermo" };
  const now = new Date();
  const past = (daysAgo: number) => new Date(now.getTime() - daysAgo * 24 * 3600 * 1000);

  // ── Helper: insert a pet row with PERF-STATE-<slug> token ──────────────────
  async function insertStatePet(
    slug: string,
    name: string,
    overrides: Partial<Record<string, unknown>> = {},
  ): Promise<{ id: string; isNew: boolean }> {
    const token = stateToken(slug);

    const [existing] = await db
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, token))
      .limit(1);

    if (existing) {
      log("SKIP", `  ${token} already exists`);
      return { id: existing.id, isNew: false };
    }

    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: token,
        species: "dog",
        breed: "Mestizo",
        name,
        sex: "unknown",
        dateOfBirth: past(365 * 3)
          .toISOString()
          .slice(0, 10),
        birthDateIsEstimated: false,
        status: "active",
        jurisdictionCountry: "AR",
        jurisdictionProvince: jur.province,
        jurisdictionLocality: jur.locality,
        acquisitionMethod: "adopted",
        potentiallyDangerousBreed: false,
        emergencyInfoVisible: false,
        // Provenance: bulk volume fixture, exempt from the spine-integrity fence.
        seedTag: SEED_TAG_PERF,
        ...(overrides as object),
      } as Parameters<typeof db.insert>[0] extends { values: (v: infer V) => unknown } ? V : never)
      .returning({ id: pets.id });

    return { id: pet.id, isNew: true };
  }

  // ── 1. pets.status values ───────────────────────────────────────────────────

  // status = active (baseline — already covered by volume pets but we make one explicit)
  {
    const slug = "status-active";
    const { id, isNew } = await insertStatePet(slug, "PERF-STATE status (active)");
    if (isNew) {
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      await insertStateRegistered(id, ownerUserId, slug);
      log("OK", `  ${stateToken(slug)}: status=active`);
    }
  }

  // status = lost → case row + status_changed event (mirrors volume path but no case coords)
  {
    const slug = "status-lost";
    const { id, isNew } = await insertStatePet(slug, "PERF-STATE status (lost)", {
      status: "lost",
    });
    if (isNew) {
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      await insertStateRegistered(id, ownerUserId, slug);
      const caseCode = "PERF-STATE-CASE-LOST";
      const [existingCase] = await db
        .select({ id: casesTable.id })
        .from(casesTable)
        .where(eq(casesTable.publicCode, caseCode))
        .limit(1);
      if (!existingCase) {
        await db.insert(casesTable).values({
          publicCode: caseCode,
          caseKind: "lost_pet_episode",
          status: "open",
          primarySubjectKind: "registered_pet",
          primaryPetId: id,
          jurisdictionCountry: "AR",
          jurisdictionProvince: jur.province,
          jurisdictionLocality: jur.locality,
          openedByUserId: ownerUserId,
          openedReason: "auto: mascota reportada como perdida",
        });
      }
      await db.insert(petEvents).values({
        petId: id,
        eventType: "status_changed",
        occurredAt: past(30),
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        authorVerified: false,
        payload: {
          from_status: "active",
          to_status: "lost",
          source: "seed-perf-state",
          location_description: `${jur.locality}, ${jur.province}`,
        },
      });
      log("OK", `  ${stateToken(slug)}: status=lost`);
    }
  }

  // status = deceased → death_recorded event
  {
    const slug = "status-deceased";
    const { id, isNew } = await insertStatePet(slug, "PERF-STATE status (deceased)", {
      status: "deceased",
      deceasedAt: past(10),
    });
    if (isNew) {
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      await insertStateRegistered(id, ownerUserId, slug);
      await db.insert(petEvents).values({
        petId: id,
        eventType: "death_recorded",
        occurredAt: past(10),
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        authorVerified: false,
        payload: {
          source: "seed-perf-state",
          cause: "natural",
          cause_detail: "vejez (showcase state demo)",
          confirmed_by_vet: false,
          vet_name: null,
          disposition_method: "owner_burial",
          facility: null,
          death_at_clinic: false,
          vet_contacted_owner: "yes",
          vet_decided_alone: null,
          is_reportable: false,
          during_rabies_observation: false,
        },
      });
      log("OK", `  ${stateToken(slug)}: status=deceased`);
    }
  }

  // ── 2. pregnancyStatus values ───────────────────────────────────────────────
  const pregnancyValues = [
    "in_progress",
    "completed_live_birth",
    "completed_stillbirth",
    "completed_miscarriage",
    "completed_termination",
  ] as const;

  for (const pv of pregnancyValues) {
    const slug = `pregnancy-${pv.replace(/_/g, "-")}`;
    const { id, isNew } = await insertStatePet(slug, `PERF-STATE pregnant (${pv})`, {
      pregnancyStatus: pv,
    });
    if (isNew) {
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      await insertStateRegistered(id, ownerUserId, slug);
      log("OK", `  ${stateToken(slug)}: pregnancyStatus=${pv}`);
    }
  }

  // ── 3. rabiesObservationStatus values ───────────────────────────────────────
  const rabiesValues = [
    "in_progress",
    "completed_negative",
    "completed_positive_rabies",
    "completed_dead",
    "completed_lost_to_followup",
  ] as const;

  for (const rv of rabiesValues) {
    const slug = `rabies-${rv.replace(/_/g, "-")}`;
    const { id, isNew } = await insertStatePet(slug, `PERF-STATE rabies (${rv})`, {
      rabiesObservationStatus: rv,
    });
    if (isNew) {
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      await insertStateRegistered(id, ownerUserId, slug);
      await db.insert(petEvents).values({
        petId: id,
        eventType: "rabies_observation_started",
        occurredAt: past(15),
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        authorVerified: false,
        payload: {
          source: "seed-perf-state",
          expected_end_at: past(5).toISOString().slice(0, 10),
          isolation_facility: "Clínica estado showcase",
          protocol: "Observación 10 días Ley 22.953",
        },
      });
      log("OK", `  ${stateToken(slug)}: rabiesObservationStatus=${rv}`);
    }
  }

  // ── 4. ownerships.role values ───────────────────────────────────────────────
  // owner — straightforward personal ownership
  {
    const slug = "custody-owner";
    const { id, isNew } = await insertStatePet(slug, "PERF-STATE custody (owner)");
    if (isNew) {
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      await insertStateRegistered(id, ownerUserId, slug);
      log("OK", `  ${stateToken(slug)}: ownership role=owner`);
    }
  }

  // co_owner — primary owner row + co_owner secondary row (same user for seed simplicity)
  {
    const slug = "custody-co-owner";
    const { id, isNew } = await insertStatePet(slug, "PERF-STATE custody (co_owner)");
    if (isNew) {
      // Primary owner row (required by ownerships_one_active_owner_per_pet)
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      // Secondary co_owner row — same user is acceptable for seed purposes
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "co_owner" });
      await insertStateRegistered(id, ownerUserId, slug);
      log("OK", `  ${stateToken(slug)}: ownership role=co_owner`);
    }
  }

  // caretaker — primary owner row + caretaker secondary row
  {
    const slug = "custody-caretaker";
    const { id, isNew } = await insertStatePet(slug, "PERF-STATE custody (caretaker)");
    if (isNew) {
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "caretaker" });
      await insertStateRegistered(id, ownerUserId, slug);
      log("OK", `  ${stateToken(slug)}: ownership role=caretaker`);
    }
  }

  // shelter_custody — org-held; skip with WARN if org absent
  {
    const slug = "custody-shelter";
    if (!seedOrgId) {
      log("WARN", `  SKIP ${stateToken(slug)}: seedOrgId absent — run pnpm seed:test first`);
    } else {
      const { id, isNew } = await insertStatePet(slug, "PERF-STATE custody (shelter_custody)");
      if (isNew) {
        await db.insert(ownerships).values({
          petId: id,
          ownerOrganizationId: seedOrgId,
          role: "shelter_custody",
        });
        await insertStateRegistered(id, ownerUserId, slug);
        log(
          "OK",
          `  ${stateToken(slug)}: ownership role=shelter_custody (org ${seedOrgId.slice(0, 8)}…)`,
        );
      }
    }
  }

  // foster — org-held shelter_custody row + individual foster row
  {
    const slug = "custody-foster";
    if (!seedOrgId) {
      log("WARN", `  SKIP ${stateToken(slug)}: seedOrgId absent — run pnpm seed:test first`);
    } else {
      const { id, isNew } = await insertStatePet(slug, "PERF-STATE custody (foster)");
      if (isNew) {
        // Shelter custody held by org (the umbrella)
        await db.insert(ownerships).values({
          petId: id,
          ownerOrganizationId: seedOrgId,
          role: "shelter_custody",
        });
        // Foster row held by the individual user under the org umbrella
        await db.insert(ownerships).values({ petId: id, ownerUserId, role: "foster" });
        await insertStateRegistered(id, ownerUserId, slug);
        log("OK", `  ${stateToken(slug)}: ownership role=foster`);
      }
    }
  }

  // ── 5. Adoption listing ─────────────────────────────────────────────────────
  // The adoptionEligibilityConsistent CHECK requires: either both adoptionEligible
  // and adoptionEligibilitySetAt are non-null, or both are null.
  // The adoptionEligibilitySetByUserId is a FK to profiles.id; use ownerUserId.

  // adoption listed (adoptionListedAt set, adoptionListingPausedAt null, adoptionEligible=true)
  {
    const slug = "adoption-listed";
    const { id, isNew } = await insertStatePet(slug, "PERF-STATE adoption listed", {
      adoptionEligible: true,
      adoptionEligibilitySetAt: past(60),
      adoptionEligibilitySetByUserId: ownerUserId,
      adoptionListedAt: past(30),
      adoptionListingPausedAt: null,
      adoptionStory: "Perro de showcase — listado para adopción (estado demo)",
    });
    if (isNew) {
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      await insertStateRegistered(id, ownerUserId, slug);
      await db.insert(petEvents).values({
        petId: id,
        eventType: "adoption_eligibility_set",
        occurredAt: past(60),
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        authorVerified: false,
        payload: {
          source: "seed-perf-state",
          adoption_eligible: true,
          set_by_user_id: ownerUserId,
          reason: "evaluación completa — apta (showcase state demo)",
        },
      });
      log("OK", `  ${stateToken(slug)}: adoptionListedAt set, paused=null`);
    }
  }

  // adoption listing paused (both timestamps set)
  {
    const slug = "adoption-paused";
    const { id, isNew } = await insertStatePet(slug, "PERF-STATE adoption listing paused", {
      adoptionEligible: true,
      adoptionEligibilitySetAt: past(90),
      adoptionEligibilitySetByUserId: ownerUserId,
      adoptionListedAt: past(60),
      adoptionListingPausedAt: past(5),
      adoptionStory: "Perro de showcase — listado pausado (estado demo)",
    });
    if (isNew) {
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      await insertStateRegistered(id, ownerUserId, slug);
      log("OK", `  ${stateToken(slug)}: adoptionListedAt + adoptionListingPausedAt set`);
    }
  }

  // ── 6. Custody dispute ──────────────────────────────────────────────────────
  // custody_disputes requires:
  //   - publicToken (unique)
  //   - petId, raisedByUserId (nullable), raisedByRole (text CHECK owner|org|govt|admin)
  //   - raisingEventId (FK → pet_events.id — NOT nullable)
  //   - jurisdictionProvince, jurisdictionLocality (NOT NULL)
  //   - status = 'open'
  // The partial unique index custody_disputes_one_open_per_pet prevents > 1 open
  // dispute per pet — we create exactly one.
  {
    const slug = "custody-dispute";
    const { id, isNew } = await insertStatePet(slug, "PERF-STATE custody dispute", {
      inCustodyDispute: true,
    });
    if (isNew) {
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      const registeredEvtId = await insertStateRegistered(id, ownerUserId, slug);

      // custody_dispute_raised event
      const [disputeEvt] = await db
        .insert(petEvents)
        .values({
          petId: id,
          eventType: "custody_dispute_raised",
          occurredAt: past(7),
          recordedByUserId: ownerUserId,
          authorRole: "govt",
          authorVerified: false,
          payload: {
            source: "seed-perf-state",
            raised_by_role: "govt",
            reason: "litigio ficticio (showcase state demo)",
          },
        })
        .returning({ id: petEvents.id });

      // custody_disputes row
      try {
        await db.insert(custodyDisputes).values({
          publicToken: `${stateToken(slug)}-DISPUTE`,
          petId: id,
          raisedByUserId: ownerUserId,
          raisedByRole: "govt",
          raisingEventId: disputeEvt.id,
          jurisdictionCountry: "AR",
          jurisdictionProvince: jur.province,
          jurisdictionLocality: jur.locality,
          status: "open",
        });
        log("OK", `  ${stateToken(slug)}: inCustodyDispute=true + custody_disputes row`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(
          "WARN",
          `  ${stateToken(slug)}: custody_disputes insert failed (${msg}) — flag + event only`,
        );
      }
      // Suppress unused variable warning for registeredEvtId
      void registeredEvtId;
    }
  }

  // ── 7. Dangerous breed ──────────────────────────────────────────────────────
  {
    const slug = "dangerous-breed";
    const { id, isNew } = await insertStatePet(slug, "PERF-STATE dangerous breed", {
      potentiallyDangerousBreed: true,
    });
    if (isNew) {
      await db.insert(ownerships).values({ petId: id, ownerUserId, role: "owner" });
      await insertStateRegistered(id, ownerUserId, slug);
      await db.insert(petEvents).values({
        petId: id,
        eventType: "dangerous_breed_attested",
        occurredAt: past(20),
        recordedByUserId: ownerUserId,
        authorRole: "govt",
        authorVerified: true,
        payload: {
          source: "seed-perf-state",
          registry: "caba_4078",
          registry_id: "PPP-CABA-STATE-SHOWCASE-001",
          attested_at: past(20).toISOString().slice(0, 10),
          attestor_dni_verified: true,
        },
      });
      log("OK", `  ${stateToken(slug)}: potentiallyDangerousBreed=true`);
    }
  }

  log("DONE", "State showcase complete");
}

// ---------------------------------------------------------------------------
// 12. Outbreak clusters — open + recent outbreak_signal events per govt scope
// ---------------------------------------------------------------------------
//
// For each seeded govt account (lucas@, govt@, govt-local@) resolves the live
// govt_assignments rows (revoked_at IS NULL) and seeds a cluster of
// outbreak_signal pet_events in those jurisdictions so the /gob/vigilancia
// "señales de brote" counter is > 0.
//
// Disease clusters per account:
//   - lucas@dim.test     : distemper cluster in Retiro + parvo cluster in Recoleta
//   - govt@dim.test      : distemper cluster in Ushuaia
//   - govt-local@dim.test: distemper cluster in La Plata
//
// Each cluster = 5 outbreak_signal events on 5 PERF-OUTBREAK-* pets.
// Events are spread within the last 14 days (well within the 30-day window).
// Payload mirrors the existing outbreak_signal shape + status:"open" for future
// compatibility (the current query does NOT filter on status, but it's good data).
//
// Idempotency: PERF-OUTBREAK-<slug>-<n> publicToken on the pet.
// Cleanup: keyed off pets.name LIKE 'PERF-%' — the existing --clean removes them.

interface OutbreakClusterDef {
  /** Slug used for pet publicToken: PERF-OUTBREAK-<slug>-<n> */
  slug: string;
  province: string;
  locality: string;
  diseaseCode: string;
  diseaseLabel: string;
  petSpecies: string;
  /** Number of outbreak_signal events to emit (cluster size). */
  size: number;
}

async function buildOutbreakClusters(ownerUserId: string): Promise<void> {
  log("STEP", "Outbreak clusters — seeding open + recent outbreak_signal events per govt");

  const supabase = createSdkClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // The three govt emails to cover.
  const GOVT_EMAILS = ["lucas@dim.test", "govt@dim.test", "govt-local@dim.test"] as const;

  // Disease configs we use for clusters.
  const DISTEMPER = {
    diseaseCode: "distemper",
    diseaseLabel: "Moquillo canino",
    petSpecies: "dog",
  } as const;
  const PARVO = {
    diseaseCode: "parvovirus",
    diseaseLabel: "Parvovirus canino",
    petSpecies: "dog",
  } as const;

  // For each govt, resolve their live jurisdictions then pick cluster targets.
  for (const email of GOVT_EMAILS) {
    const govtUserId = await findAuthUserIdByEmail(supabase, email);
    if (!govtUserId) {
      log("WARN", `  ${email} not found in auth.users — skipping outbreak clusters`);
      continue;
    }

    // Resolve live govt_assignments (revoked_at IS NULL) from profiles.id.
    // govtAssignments.userId references profiles.id, not auth.users.id, so we
    // use the Supabase-provided user id which is the same UUID in both tables.
    const assignments = await db
      .select({
        province: govtAssignments.jurisdictionProvince,
        locality: govtAssignments.jurisdictionLocality,
      })
      .from(govtAssignments)
      .where(
        sql`${govtAssignments.userId} = ${govtUserId}::uuid AND ${govtAssignments.revokedAt} IS NULL`,
      );

    if (assignments.length === 0) {
      log("WARN", `  ${email} has no active govt_assignments — skipping`);
      continue;
    }

    log("INFO", `  ${email}: ${assignments.length} jurisdictions`);

    // Pick cluster targets from this govt's jurisdictions.
    // We always emit at least one cluster (first locality); if there are 2+ we add a second.
    const clusters: OutbreakClusterDef[] = [];

    const first = assignments[0];
    clusters.push({
      slug: `${first.locality
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")}`,
      province: first.province,
      locality: first.locality,
      ...DISTEMPER,
      size: 5,
    });

    // Second cluster if there's another distinct locality.
    if (assignments.length > 1) {
      const second = assignments.find((a) => a.locality !== first.locality) ?? assignments[1];
      clusters.push({
        slug: `${second.locality
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "")}-parvo`,
        province: second.province,
        locality: second.locality,
        ...PARVO,
        size: 4,
      });
    }

    // Seed each cluster.
    for (const cluster of clusters) {
      await seedOutbreakCluster(cluster, ownerUserId, email);
    }
  }

  log("DONE", "Outbreak clusters complete");
}

/**
 * Seeds one outbreak cluster: creates PERF-OUTBREAK-* pets in the given
 * jurisdiction and attaches outbreak_signal events within the last 14 days.
 * Idempotent: skips pets whose publicToken already exists.
 */
async function seedOutbreakCluster(
  cluster: OutbreakClusterDef,
  ownerUserId: string,
  govtEmail: string,
): Promise<void> {
  const now = Date.now();
  // Spread events evenly across the last 14 days.
  const WINDOW_MS = 14 * 24 * 3600 * 1000;

  for (let n = 1; n <= cluster.size; n++) {
    const token = `PERF-OUTBREAK-${cluster.slug}-${n}`;
    const petName = `PERF-OUTBREAK ${cluster.locality} ${n}`;

    // Idempotency: skip if pet already exists.
    const [existing] = await db
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, token))
      .limit(1);

    if (existing) {
      log("SKIP", `  ${token} already exists`);
      // Still verify the outbreak_signal event exists on it.
      const [existingEvt] = await db
        .select({ id: petEvents.id })
        .from(petEvents)
        .where(
          sql`${petEvents.petId} = ${existing.id} AND ${petEvents.eventType} = 'outbreak_signal'`,
        )
        .limit(1);
      if (!existingEvt) {
        // Pet exists but event was cleaned — re-insert the event.
        const occurredAt = new Date(now - ((n - 1) / cluster.size) * WINDOW_MS);
        await insertOutbreakEvent(existing.id, ownerUserId, cluster, occurredAt);
        log("OK", `  ${token}: re-inserted missing outbreak_signal event`);
      }
      continue;
    }

    // Create the PERF-tagged pet in the target jurisdiction.
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: token,
        species: cluster.petSpecies,
        breed: cluster.petSpecies === "dog" ? "Mestizo" : null,
        name: petName,
        sex: "unknown",
        dateOfBirth: new Date(now - 3 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10),
        birthDateIsEstimated: true,
        status: "active" as const,
        jurisdictionCountry: "AR",
        jurisdictionProvince: cluster.province,
        jurisdictionLocality: cluster.locality,
        acquisitionMethod: "other",
        potentiallyDangerousBreed: false,
        emergencyInfoVisible: false,
        // Provenance: bulk volume fixture, exempt from the spine-integrity fence.
        seedTag: SEED_TAG_PERF,
      })
      .returning({ id: pets.id });

    // Ownership.
    await db.insert(ownerships).values({
      petId: pet.id,
      ownerUserId,
      role: "owner",
    });

    // pet_registered event (required before other events by convention).
    await db.insert(petEvents).values({
      petId: pet.id,
      eventType: "pet_registered",
      occurredAt: new Date(now - WINDOW_MS - 24 * 3600 * 1000),
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      authorVerified: false,
      payload: {
        source: "seed-perf",
        species: cluster.petSpecies,
        govt_cluster: `${cluster.diseaseCode}/${cluster.locality}`,
      },
    });

    // outbreak_signal event — recent, in this govt's jurisdiction.
    // Spread evenly so signals arrive at different timestamps (looks like a real cluster).
    const occurredAt = new Date(now - ((n - 1) / cluster.size) * WINDOW_MS);
    await insertOutbreakEvent(pet.id, ownerUserId, cluster, occurredAt);

    log(
      "OK",
      `  ${token} (${govtEmail}): ${cluster.diseaseCode} in ${cluster.locality}, ${cluster.province} — occurredAt ${occurredAt.toISOString().slice(0, 10)}`,
    );
  }
}

/** Inserts a single outbreak_signal pet_event with the full payload shape. */
async function insertOutbreakEvent(
  petId: string,
  ownerUserId: string,
  cluster: OutbreakClusterDef,
  occurredAt: Date,
): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType: "outbreak_signal",
    occurredAt,
    recordedByUserId: ownerUserId,
    authorRole: "owner",
    authorVerified: false,
    payload: {
      source: "seed-perf",
      triggered_by: "seed-outbreak-clusters",
      disease_code: cluster.diseaseCode,
      disease_label: cluster.diseaseLabel,
      pet_species: cluster.petSpecies,
      match_strength: {
        high_count: 2,
        medium_count: 1,
        low_count: 0,
        matched_symptom_codes: ["cough", "lethargy", "fever"],
      },
      pet_jurisdiction_country: "AR",
      pet_jurisdiction_province: cluster.province,
      pet_jurisdiction_locality: cluster.locality,
      // Included for forward-compatibility — the current fetchVigilanciaMetrics
      // query does NOT filter on status, but having it here is correct data hygiene.
      status: "open",
    },
  });
}

// ---------------------------------------------------------------------------
// 13. Main seed loop
// ---------------------------------------------------------------------------

async function runSeed(ownerUserId: string, seedOrgId: string | null): Promise<void> {
  const lostCount = Math.floor(COUNT * 0.1);
  const withCoordsCount = Math.floor(COUNT * 0.5);
  const orgCasesCount = seedOrgId ? Math.floor(lostCount * 0.2) : 0;

  log("INFO", `Owner   : ${OWNER_EMAIL} (${ownerUserId.slice(0, 8)}…)`);
  log(
    "INFO",
    `Seed org: ${seedOrgId ? `${seedOrgId.slice(0, 8)}… (first ${orgCasesCount} lost cases tied to org)` : "NOT FOUND — org case-linking skipped"}`,
  );
  log(
    "INFO",
    `Pets    : ${COUNT} total (first ${SHOWCASE_COUNT} are showcase — all ${EVENT_TYPES.length} event types)`,
  );
  log("INFO", `Lost    : ~${lostCount} (10%) → each gets a cases row`);
  log("INFO", `Coords  : ~${withCoordsCount} (50%) have lat/lng`);
  log("INFO", `Batches : ${Math.ceil(COUNT / BATCH_SIZE)} × ${BATCH_SIZE}`);

  // State showcase runs once per seed run, regardless of --count.
  // It creates deterministic PERF-STATE-* pets covering every state value.
  await buildStateShowcase(ownerUserId, seedOrgId);

  // Outbreak clusters: seed open + recent outbreak_signal events per govt scope
  // so /gob/vigilancia shows señales de brote > 0 for each seeded govt account.
  await buildOutbreakClusters(ownerUserId);

  let created = 0;
  let skipped = 0;

  for (let batchStart = 0; batchStart < COUNT; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, COUNT);
    log("STEP", `Batch ${batchStart}–${batchEnd - 1}`);

    for (let i = batchStart; i < batchEnd; i++) {
      const token = perfPublicToken(i);
      const rng = seededRng(i * 31337 + 7);

      // Idempotency: skip if already exists
      const [existing] = await db
        .select({ id: pets.id })
        .from(pets)
        .where(eq(pets.publicToken, token))
        .limit(1);

      if (existing) {
        skipped++;
        continue;
      }

      // Deterministic attributes
      const species = pickWeighted(SPECIES_DIST, rng);
      const sex = pick(SEXES, rng);
      const baseName = pick(PET_NAMES, rng);
      const name = perfName(i, baseName);
      const jur = JURISDICTIONS[i % JURISDICTIONS.length];

      let breed: string | null = null;
      if (species === "dog") breed = pick(DOG_BREEDS, rng);
      else if (species === "cat") breed = pick(CAT_BREEDS, rng);
      else if (species !== "other") breed = pick(OTHER_BREEDS, rng);

      const isLost = i < lostCount;
      const status = isLost ? ("lost" as const) : ("active" as const);

      // Coordinates for ~50% of pets
      const hasCoords = i < withCoordsCount;
      const coords = hasCoords ? randomCoords(rng) : null;
      const coordFields = writePoint(coords);

      // Age: 1–12 years
      const ageYears = 1 + Math.floor(rng() * 12);
      const dob = new Date();
      dob.setFullYear(dob.getFullYear() - ageYears);
      const dateOfBirth = dob.toISOString().slice(0, 10);

      // Events: 1–5 per pet
      const eventCount = 1 + Math.floor(rng() * 5);

      try {
        const [pet] = await db
          .insert(pets)
          .values({
            publicToken: token,
            species,
            breed,
            name,
            sex,
            dateOfBirth,
            birthDateIsEstimated: false,
            status,
            jurisdictionCountry: "AR",
            jurisdictionProvince: jur.province,
            jurisdictionLocality: jur.locality,
            acquisitionMethod: pick(ACQUISITION_METHODS, rng),
            potentiallyDangerousBreed: false,
            emergencyInfoVisible: false,
            // Provenance: bulk volume fixture, exempt from the spine-integrity fence.
            seedTag: SEED_TAG_PERF,
          })
          .returning({ id: pets.id });

        // Ownership row
        await db.insert(ownerships).values({
          petId: pet.id,
          ownerUserId,
          role: "owner",
        });

        // Events
        const isShowcase = i < SHOWCASE_COUNT;
        const evtRows = isShowcase
          ? buildShowcaseEvents(pet.id, ownerUserId, i)
          : buildPetEvents(pet.id, ownerUserId, species, eventCount, seededRng(i * 99991 + 3));

        for (const evtRow of evtRows) {
          // Coord-bearing pets get coords on their events so the map views
          // (lost-pets map, sightings, govt geo) have realistic volume to
          // render. pet_events.location_lat/lng is where the app reads them;
          // pets has no coordinate column.
          //
          // Showcase events must NOT get coords on every row — some event types
          // (e.g. credential_scanned, status_changed showcase) do not semantically
          // carry a location, and the pair-check constraint fires if only one
          // coord column is set. We omit coords on showcase pets entirely and let
          // the volume cohort carry the geo load.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await db.insert(petEvents).values({
            ...(evtRow as Record<string, unknown>),
            ...(!isShowcase && hasCoords ? coordFields : {}),
          } as any);
        }

        if (isShowcase) {
          log(
            "INFO",
            `  Showcase pet #${i} (${token}): inserted ${evtRows.length} events (all types)`,
          );
        }

        // Lost pets → case row + status_changed event
        if (isLost) {
          const casePublicCode = `PERF-CASE-${String(i).padStart(6, "0")}`;

          const [existingCase] = await db
            .select({ id: casesTable.id })
            .from(casesTable)
            .where(eq(casesTable.publicCode, casePublicCode))
            .limit(1);

          if (!existingCase) {
            const tieToOrg = seedOrgId !== null && i < orgCasesCount;

            // A registered_pet case must NOT set primary_location_* — the
            // cases_subject_location_consistency CHECK ties primary_location_*
            // to primary_subject_kind='location' only (those columns are for
            // location-subject cases). The lost coordinates live on the pet and
            // on the status_changed event below, not on the case row.
            await db.insert(casesTable).values({
              publicCode: casePublicCode,
              caseKind: "lost_pet_episode",
              status: "open",
              primarySubjectKind: "registered_pet",
              primaryPetId: pet.id,
              jurisdictionCountry: "AR",
              jurisdictionProvince: jur.province,
              jurisdictionLocality: jur.locality,
              openedByUserId: ownerUserId,
              openedByOrganizationId: tieToOrg ? seedOrgId : null,
              openedReason: "auto: mascota reportada como perdida",
            });

            // Emit the corresponding status_changed event
            await db.insert(petEvents).values({
              petId: pet.id,
              eventType: "status_changed",
              occurredAt: new Date(),
              recordedByUserId: ownerUserId,
              authorRole: "owner",
              authorVerified: false,
              payload: {
                from_status: "active",
                to_status: "lost",
                source: "seed-perf",
                location_description: `${jur.locality}, ${jur.province}`,
              },
              ...coordFields,
            });
          }
        }

        created++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log("WARN", `  pet ${i} (${token}) failed — skipping: ${msg}`);
      }
    }

    log("OK", `  batch done — created so far: ${created}, skipped: ${skipped}`);
  }

  log("DONE", `Seed complete — created: ${created}, skipped (already existed): ${skipped}`);
  log("INFO", `Total PERF pets in DB: ~${created + skipped}`);
}

// ---------------------------------------------------------------------------
// 14. Main entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const hostLabel = DATABASE_URL ? (parsePgHost(DATABASE_URL) ?? "(parse error)") : "(not set)";
  log("INFO", `seed-perf starting — host: ${hostLabel}`);
  log(
    "INFO",
    `Flags: count=${COUNT} allow-remote=${ALLOW_REMOTE} clean=${CLEAN} dry-run=${DRY_RUN}`,
  );

  if (DRY_RUN) {
    const lostCount = Math.floor(COUNT * 0.1);
    const withCoords = Math.floor(COUNT * 0.5);
    log("INFO", "=== DRY RUN — no writes will be made ===");
    log("INFO", `Would create        : ${COUNT} pets`);
    log(
      "INFO",
      `Showcase cohort     : first ${SHOWCASE_COUNT} → all ${EVENT_TYPES.length} event types each`,
    );
    log("INFO", `Lost + cases (~10%) : ${lostCount}`);
    log("INFO", `With coords (~50%)  : ${withCoords}`);
    log(
      "INFO",
      `Jurisdictions       : ${JURISDICTIONS.length} distinct (province, locality) pairs`,
    );
    log("INFO", `Batch size          : ${BATCH_SIZE}`);
    log("INFO", `Batches             : ${Math.ceil(COUNT / BATCH_SIZE)}`);
    log("INFO", "Events per pet      : 1–5");
    log("INFO", `Cleanup key         : pets.name LIKE 'PERF-%'`);
    log(
      "INFO",
      `Idempotency key     : pets.publicToken IN PERF-000000..PERF-${String(COUNT - 1).padStart(6, "0")}`,
    );
    log("DONE", "Dry run complete — nothing written");
    return;
  }

  const supabase = createSdkClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (CLEAN) {
    await runClean();
    return;
  }

  log("STEP", `Resolving ${OWNER_EMAIL} via admin SDK`);
  const ownerUserId = await findAuthUserIdByEmail(supabase, OWNER_EMAIL);
  if (!ownerUserId) {
    log("FAIL", `${OWNER_EMAIL} not found in auth.users. Run pnpm seed:test first.`);
    process.exit(1);
  }
  log("OK", `${OWNER_EMAIL} → ${ownerUserId.slice(0, 8)}…`);

  const seedOrgId = await findSeedOrgId();
  if (!seedOrgId) {
    log(
      "WARN",
      "Refugio Test (Seed) org (cuit 30-99999999-9) not found — org case-linking skipped",
    );
  } else {
    log("INFO", `Refugio Test (Seed) → ${seedOrgId.slice(0, 8)}…`);
  }

  await runSeed(ownerUserId, seedOrgId);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("\n[FATAL]", err);
    process.exit(1);
  });
