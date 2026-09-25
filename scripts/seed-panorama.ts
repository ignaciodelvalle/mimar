/**
 * DIM Panorama Demo Dataset Seed — seed-panorama.ts
 *
 * Generates a deterministic, idempotent synthetic dataset so the national
 * situational console (Centro de Situación Nacional) and government dashboards
 * render with realistic national density.
 *
 * ─── ENV KNOBS ─────────────────────────────────────────────────────────────
 *   PETS_PER_CAPITA       default 0.5    — fraction of people that own a pet
 *   SCALE                 default 0.002  — down-sample ratio (1:500 ≈ 46k pets)
 *   PANORAMA_WINDOW_DAYS  default 90     — event window in days back from anchor
 *   PANO_PROVINCE_BOOST   default none   — per-province allocation multiplier,
 *                         e.g. "Buenos Aires:3" (see the knob comment below)
 *
 * ─── DETERMINISM CONTRACT ──────────────────────────────────────────────────
 *   A fixed-seed mulberry32 PRNG drives ALL random choices. Re-running
 *   produces an identical dataset. The anchor date is a hardcoded ISO string
 *   (2026-06-20) — not `new Date()` — so the temporal distribution is stable.
 *
 * ─── PANO- TAG ─────────────────────────────────────────────────────────────
 *   Every synthetic pet's `public_token` starts with "PANO-" (PANO-NNNNNN /
 *   PANO-HIST-NNNNNN); the `name` column carries ONLY the human name — the
 *   old name prefix leaked into /perdidas cards (pre-demo polish 2026-07-03).
 *   Synthetic orgs use publicToken "PANO-ORG-<slug>". Welfare reports are
 *   tagged by the same provincial distribution. Cleanup keys off the
 *   public_token prefix.
 *
 * ─── LOCAL-ONLY GUARD ──────────────────────────────────────────────────────
 *   Refuses to run against a non-local DATABASE_URL host unless --allow-remote
 *   is passed. ALWAYS refuses when NODE_ENV=production.
 *   Allowed local hosts: 127.0.0.1, localhost, host.docker.internal, ::1.
 *   Exit code 4 on guard failure (mirrors db-bootstrap.ts).
 *
 * ─── IDEMPOTENCY ───────────────────────────────────────────────────────────
 *   Default run: delete all PANO-tagged rows (FK-safe order, same
 *   app.allow_event_mutation override as seed-perf), then re-insert fresh.
 *   --clean flag: delete only (no re-insert).
 *
 * ─── CLI FLAGS ─────────────────────────────────────────────────────────────
 *   --allow-remote   Target non-local DB (staging).
 *   --clean          Delete all PANO-tagged data then exit.
 *   --dry-run        Print plan and exit without writing.
 */

// ---------------------------------------------------------------------------
// 0. Type-only imports
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import type { EventType } from "../db/schema";

// Pure date/trend helpers for the multi-year history seed. Side-effect-free and
// db-free, so a static import here is safe (it does NOT trigger the deferred
// db/index.ts load that the env bootstrap below must precede).
import {
  dateInYear,
  makeMulberry32,
  makeRegisteredByPicker,
  monthlyEventCount,
  pickDateInMonth,
  pickRegisteredYear,
  provinceProfile,
  resolveHistoryLossOutcomes,
} from "./seed-history-utils";

// PANO_PROVINCE_BOOST parser — pure and db-free, same static-import rationale
// as seed-history-utils above. Colocated test: pano-province-boost.test.ts.
import { boostedProvinceCount, parseProvinceBoost } from "./pano-province-boost";

// CABA barrio reference data (names + centroids + weights). Pure data — safe to
// import statically (no db side-effect). Used to replace the whole-city
// "Ciudad Autónoma de Buenos Aires" placeholder locality with the 48 real
// barrios so CABA pets distribute across barrios instead of one blob.
import { CABA_BARRIOS, CABA_BARRIO_NAMES, CABA_PLACEHOLDER_LOCALITY } from "./caba-barrios-data";

// Realistic welfare-report description templates — pure data, no db
// side-effect, safe to import statically. Shared with seed-demo-polish.ts's
// repair path so both writers produce the same style of prose (C5).
import { WELFARE_DESCRIPTION_TEMPLATES } from "./welfare-description-templates";

// ---------------------------------------------------------------------------
// 1. Env bootstrap (must run before db/index.ts is imported)
// ---------------------------------------------------------------------------

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// 2. Parse CLI flags
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

const ALLOW_REMOTE = argv.includes("--allow-remote");
const CLEAN = argv.includes("--clean");
const DRY_RUN = argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// 3. Safety guards
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "::1"]);

function parsePgHost(url: string): string | null {
  const match = url.match(/^postgres(?:ql)?:\/\/[^@]+@([^:/]+)/);
  return match ? match[1] : null;
}

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env.local — aborting.");
  process.exit(2);
}

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed: NODE_ENV=production. Aborting.");
  process.exit(2);
}

const dbHost = parsePgHost(DATABASE_URL);
const isLocalDb = dbHost ? LOCAL_HOSTS.has(dbHost) : true;

if (!ALLOW_REMOTE && !isLocalDb) {
  console.error(
    [
      "",
      "==============================================================",
      "  ABORT: seed-panorama target is NOT a local Postgres.",
      "==============================================================",
      `  DATABASE_URL host : ${dbHost ?? "(not set)"}`,
      `  Allowed local hosts: ${[...LOCAL_HOSTS].join(", ")}`,
      "",
      "  This script inserts tens of thousands of rows. Running it",
      "  against a remote DB by mistake is a real incident.",
      "",
      "  If you meant to target this host, re-run with --allow-remote.",
      "  Otherwise edit .env.local to point at the local Postgres.",
      "==============================================================",
      "",
    ].join("\n"),
  );
  process.exit(4);
}

if (ALLOW_REMOTE && !isLocalDb) {
  console.warn(
    [
      "",
      "==============================================================",
      "  WARNING: --allow-remote in effect.",
      `  DATABASE_URL host: ${dbHost}`,
      "  About to write synthetic data to a REMOTE database.",
      "==============================================================",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 4. Deferred imports (after env is populated)
// ---------------------------------------------------------------------------

const { and, eq, inArray, isNull, like, or, sql } = await import("drizzle-orm");
const {
  db,
  pets,
  ownerships,
  petEvents,
  organizations,
  welfareReports,
  arLocalities,
  jurisdictionsCensus,
  cases,
  caseEvents,
  custodyDisputes,
  enoProcessingQueue,
  eventNotificationOutbox,
  serviceOfferings,
  serviceScheduleRules,
  timeSlots,
  appointments,
} = await import("../db");
const { writePoint } = await import("@/lib/domain/location");
const { validateEventPayload } = await import("@/lib/events/event-schemas");
const { PROVINCES } = await import("@/lib/reference/ar-provincias");
const { generateReferenceCode } = await import("../src/modules/welfare/domain/reference-code");
const { generatePrefixedToken } = await import("@/lib/infra/publicToken");

// ─── Open-case guards ───────────────────────────────────────────────────────
// Deferred like everything else in this block because the module statically
// imports ../db. See scripts/seed-case-guards.ts for why a seed step that OPENS
// a case must not pick its pet with an unordered LIMIT.
const { findOpenCasesOfKind, selectPetsWithoutOpenCase, selectSeedPetsOrdered } = await import(
  "./seed-case-guards"
);

// ─── The real intake circuit ────────────────────────────────────────────────
// Panorama pets are created through the SAME use-case the alta wizard drives
// (registerPet), not through a direct db.insert(pets). See registerSeedPet
// below for why this matters and what the seed still has to do on top.
const { registerPet } = await import("@/src/modules/pets/application/register-pet");
const { PetsRepository } = await import("@/src/modules/pets/infrastructure/pets-repository");
const { resolveCanonicalJurisdiction } = await import("@/lib/infra/jurisdiction-validation");
type ParsedPetInput = import("@/src/modules/pets/domain/types").ParsedPet;

// ---------------------------------------------------------------------------
// 5. Constants + helpers
// ---------------------------------------------------------------------------

const PANO_TAG = "PANO-";

/** Hardcoded anchor date — NOT Date.now() so the window is reproducible. */
const ANCHOR_ISO = "2026-06-20T00:00:00.000Z";
const ANCHOR_MS = new Date(ANCHOR_ISO).getTime();

const WINDOW_DAYS = Number(process.env.PANORAMA_WINDOW_DAYS ?? "90");
const WINDOW_MS = WINDOW_DAYS * 24 * 3600 * 1000;

const PETS_PER_CAPITA = Number(process.env.PETS_PER_CAPITA ?? "0.5");

/**
 * Down-sample ratio for the per-province pet population.
 *
 * 0.0005 (≈11.5k province pets, ≈32k total with the history seed) replaced the
 * old 0.002 (≈46k province pets, ≈67k total) when this seed moved off bulk
 * insert and onto the real intake circuit (registerPet, one transaction per
 * pet). PO decision: fidelity of the intake path beats density of the fixture —
 * the 67k figure was chosen to make the map look dense, not because any real
 * jurisdiction has that many.
 *
 * MEASURED at the time of the change (local Supabase, k=5 suppression):
 *
 *   volume   run time   department cells visible / total
 *   67.7k    ~11 min*   1600 / 2111   (75.8%)
 *   32.4k     5m35s     1431 / 1973   (72.5%)
 *   (* extrapolated from the measured 108 registrations/sec)
 *
 * So the cut costs ~3 points of department-grain visibility on the three
 * high-volume metrics (rabies 466/667, sterilization 493/643, microchip
 * 469/559 — all healthy), and buys a seed that cannot drift from the code path
 * it is supposed to demonstrate.
 *
 * RESOLVED GAP (was: "the Mortalidad view shows 0 visible departments"). The
 * cause was the DEATH RATE, not this ratio — the old flat 0.3% deceased share
 * spread ~1.4 deaths per department, so every department cell sat under the k=5
 * floor and the view rendered 0 of 38. The share is now derived from a published
 * crude death rate scaled by per-pet exposure (see ANNUAL_DEATH_RATE_BY_SPECIES),
 * which lands the register near 3% deceased. Volume was never the lever: at the
 * old rate even 4× this population left ~5.6 deaths per department.
 */
const SCALE = Number(process.env.SCALE ?? "0.0005");

/**
 * Multiplier applied to the base monthly event rate inside
 * seedModelProvinceHistory. Default 1 keeps the seed fast while still
 * producing enough rows to populate every event dimension. Set to 2–5
 * for denser stress-test datasets or to 0.1 for quick CI runs.
 */
const HISTORY_SCALE = Number(process.env.HISTORY_SCALE ?? "1");

/**
 * PANO_PROVINCE_BOOST — per-province allocation multiplier, applied AFTER the
 * population-weighted split (base = population × PETS_PER_CAPITA × SCALE) and
 * ONLY to the provinces listed. Global SCALE stays untouched. Format is
 * comma-separated "Provincia:multiplier" entries:
 *
 *   PANO_PROVINCE_BOOST="Buenos Aires:3" HISTORY_SCALE=2
 *
 * is the intended STAGING use: Provincia de Buenos Aires gets 3× pets so its
 * partidos (Tigre, La Plata, Quilmes, Morón…) carry enough density for the
 * gov-pba@ demo tour, without inflating the other 23 provinces the way a
 * global SCALE bump would.
 *
 * Unknown province names FAIL FAST at startup (exit 2) — a typo must not
 * silently no-op through a full seed run. Determinism is preserved: the
 * multiplier reshapes the per-province counts BEFORE any RNG draw is spent,
 * so the same env in → the same dataset out (the fixed-seed mulberry32
 * contract). --dry-run reflects the boosted counts so the operator can
 * preview before writing.
 */
function resolveProvinceBoost(): Map<string, number> {
  try {
    return parseProvinceBoost(
      process.env.PANO_PROVINCE_BOOST,
      PROVINCES.map((p) => p.name),
    );
  } catch (err) {
    console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
const PROVINCE_BOOST = resolveProvinceBoost();

const BATCH_SIZE = 500;

// ─── Operational / derived family rates (env-tunable) ───────────────────────
// These drive the families that were structurally empty before this seed:
// sterilization, PPP attestation, adoption, reunification, dangerous-breed flag.
// All are fractions [0..1]; per-province spread is layered on top (see helpers).
const STERILIZATION_RATE = Number(process.env.PANO_STERILIZATION_RATE ?? "0.28");
const DANGEROUS_BREED_FLAG_RATE = Number(process.env.PANO_DANGEROUS_BREED_RATE ?? "0.04");
const PPP_ATTEST_RATE = Number(process.env.PANO_PPP_ATTEST_RATE ?? "0.45"); // of flagged pets
const ADOPTION_ACQUISITION_RATE = Number(process.env.PANO_ADOPTION_RATE ?? "0.12");
const REUNIFICATION_RATE = Number(process.env.PANO_REUNIFICATION_RATE ?? "0.45"); // of lost pets
// The per-province block dates its losses inside this trailing window and
// applies REUNIFICATION_RATE to them. The history block reuses BOTH numbers:
// an episode inside the window is "recent" and reunified at that rate; anything
// older is closed by construction (see resolveHistoryLossOutcomes).
const RECENT_LOSS_WINDOW_DAYS = 30;

// ─── Health campaign rates (env-tunable) — feeds /gob/campanas ──────────────
// A health campaign is a service_offering (vacunación / desparasitación /
// esterilización) hosted by a seeded org. Slots are booked at a per-province
// rate; each booking resolves to a mixed outcome so enrollment / completion /
// no-show / geographic-reach KPIs all populate with varied-by-jurisdiction data.
// CAMPAIGN_BOOKING_RATE is the baseline share of materialized slot capacity that
// gets booked; a per-province multiplier (see PROVINCE_CAMPAIGN_DEMAND) layers
// jurisdiction spread on top.
const CAMPAIGN_BOOKING_RATE = Number(process.env.PANO_CAMPAIGN_BOOKING_RATE ?? "0.62");

// ─── Mortality (sourced — see the citation below before changing) ───────────
const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

/**
 * Annual CRUDE DEATH RATE for owned companion animals, by species.
 *
 * This constant is an assertion about the world, so it is anchored to a
 * published source rather than chosen to make a dashboard look populated.
 *
 * SOURCE: New JC Jr, Salman MD, King M, Scarlett JM, Kass PH, Hutchison JM
 * (2004), "Birth and Death Rate Estimates of Cats and Dogs in U.S. Households
 * and Related Factors", Journal of Applied Animal Welfare Science 7(4):229-241.
 * Reported crude death rates: 7.9 dog deaths per 100 dogs per year and 8.3 cat
 * deaths per 100 cats per year in US households. It remains the most
 * comprehensive published crude death rate for OWNED companion animals; there
 * is no Argentine equivalent, and companion-animal mortality is not subject to
 * routine national monitoring anywhere.
 *
 * CORROBORATION (independent population, different method): O'Neill DG, Church
 * DB, McGreevy PD, Thomson PC, Brodbelt DC (2013), "Longevity and mortality of
 * owned dogs in England", The Veterinary Journal 198(3):638-643 — median
 * longevity 12.0 years across 102,609 dogs under primary veterinary care. In a
 * stationary population the crude death rate is the reciprocal of mean
 * lifespan, so 1/12.0 ≈ 8.3%/yr, the same order as New et al.'s 7.9%.
 *
 * NOT CALIBRATED TO THE SUPPRESSION THRESHOLD. Whether the resulting cells
 * clear the k=5 k-anonymity floor is an OUTCOME of these figures, never an
 * input to them. If a cell stays suppressed, that is an honest report of a
 * thin population — do not raise these numbers to light it up.
 */
const ANNUAL_DEATH_RATE_BY_SPECIES: Record<string, number> = {
  dog: 0.079,
  cat: 0.083,
};

/** Species with no published crude rate: the dog/cat midpoint, flagged as such. */
const ANNUAL_DEATH_RATE_DEFAULT = 0.081;

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "FAIL";
function log(tag: LogTag, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${tag.padEnd(4)}] ${msg}`);
}

// ---------------------------------------------------------------------------
// 5a. Seeded deterministic PRNG — mulberry32
// ---------------------------------------------------------------------------

const RNG_SEED = 0x4e415441; // "NATA" — fixed forever

// Single global RNG — all callers draw from this to keep the sequence stable.
// The generator itself lives in seed-history-utils.ts (one definition): the
// unit tests and this seed draw from the SAME algorithm, so they can never
// disagree about a sequence.
const rng = makeMulberry32(RNG_SEED);

function randInt(min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function pickWeighted<T extends { weight: number }>(dist: readonly T[]): T {
  const total = dist.reduce((s, d) => s + d.weight, 0);
  let r = rng() * total;
  for (const d of dist) {
    r -= d.weight;
    if (r <= 0) return d;
  }
  return dist[dist.length - 1];
}

/** Gaussian jitter using Box-Muller. Uses two RNG draws. */
function gaussianJitter(stdDev: number): number {
  const u1 = rng();
  const u2 = rng();
  return stdDev * Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
}

/** Random timestamp within the event window (before anchor). */
function randomWindowDate(maxDaysBack = WINDOW_DAYS): Date {
  const daysBack = rng() * maxDaysBack;
  return new Date(ANCHOR_MS - daysBack * 24 * 3600 * 1000);
}

/** Deterministic public token for a panorama pet by global index. */
function panoPublicToken(i: number): string {
  return `PANO-${String(i).padStart(6, "0")}`;
}

/**
 * Human pet name — NO tag prefix. The synthetic marker lives ONLY in
 * public_token (PANO-NNNNNN): prefixed names leaked into user-facing
 * surfaces (/perdidas showed "PANO-000213 Coco" — pre-demo polish
 * 2026-07-03). Cleanup keys off public_token, not name.
 */
function panoName(_i: number, baseName: string): string {
  return baseName;
}

// ---------------------------------------------------------------------------
// 5a-bis. The real intake circuit — registerSeedPet
// ---------------------------------------------------------------------------

/**
 * Seed provenance tags written to pets.seed_tag (migration 0160).
 *
 * public_token already carries a PANO- prefix, but that column is RENDERED
 * (public credential page, QR payload) — a product identifier, not an
 * infrastructure one. seed_tag is the internal channel, so a fence can exempt
 * or select synthetic rows without pattern-matching a user-facing string.
 */
const SEED_TAG_PANORAMA = "panorama";
const SEED_TAG_PANORAMA_HIST = "panorama-hist";

/**
 * Memoized (province, locality) → ar_localities.id resolution.
 *
 * Uses resolveCanonicalJurisdiction — the SAME resolver the write path uses via
 * normalizeLocationForWrite (the name-based scripts/backfill-locality-id.ts
 * that also used it was deleted in localidades-por-id B5: a homonym settles on
 * the alphabetically first department, see scripts/place-repair-homonym-ids.ts).
 * Resolving per DISTINCT pair rather than per pet keeps this to a few hundred
 * queries instead of one per pet.
 *
 * A miss caches `null`: the pet keeps its free-text jurisdiction columns and a
 * NULL FK, exactly like a real registration whose locality is not in the INDEC
 * catalog. That is the honest outcome — NOT a reason to invent an id.
 */
const localityIdCache = new Map<string, string | null>();

async function resolveLocalityId(
  provinceName: string,
  localityName: string | null,
): Promise<string | null> {
  if (!localityName) return null;
  const key = `${provinceName}||${localityName}`;
  const cached = localityIdCache.get(key);
  if (cached !== undefined) return cached;

  let resolved: string | null = null;
  try {
    const canonical = await resolveCanonicalJurisdiction({
      rawProvince: provinceName,
      rawLocality: localityName,
    });
    resolved = canonical.locality.id;
  } catch {
    // JurisdictionValidationError — the pair is not in the catalog. Leave the
    // FK NULL; the centroid fallback keeps the pet visible on the panorama.
    resolved = null;
  }
  localityIdCache.set(key, resolved);
  return resolved;
}

/** Everything the seed knows about a pet before it is registered. */
type SeedPetSpec = {
  /** Global pet index — drives the deterministic PANO- token. */
  index: number;
  name: string;
  species: string;
  sex: "male" | "female" | "unknown";
  provinceName: string;
  localityName: string | null;
  dangerousBreed: boolean;
  acquisitionMethod: string;
  /** Historical instant the registration is stamped with. */
  registeredAt: Date;
  seedTag: string;
};

/**
 * Register one synthetic pet through the REAL intake use-case.
 *
 * WHY THIS AND NOT db.insert(pets)
 * --------------------------------
 * The direct-insert seed wrote final state and skipped the application layer
 * entirely, so it silently diverged from what the alta wizard actually
 * produces: no pet_registered event on some paths, and — measured — 2 of 67.710
 * pets with a locality_id. Routing through registerPet means the seed cannot
 * drift from the real circuit, because it IS the real circuit: the pets row,
 * the ownership row, the pet_registered event and the microchip double-write
 * are all emitted by src/modules/pets, in one transaction, exactly as a real
 * registration emits them.
 *
 * THE TWO INJECTED DEPENDENCIES
 * -----------------------------
 * 1. `repo.generatePublicToken` is overridden to return the deterministic
 *    PANO-NNNNNN token. This is NOT a bypass — generatePublicToken is already
 *    an injected repo method, so overriding it is the seam working as designed.
 *    It has to be overridden: the seed's idempotent delete-and-reseed keys off
 *    the PANO- prefix (see the PANO- TAG header), and a random DIM- token would
 *    both break cleanup and flood the DIM-* fitness sweep with 20k synthetic
 *    pets.
 * 2. `now` supplies the historical registration instant. The panorama dataset's
 *    entire value is its temporal distribution; the default `new Date()` would
 *    collapse every registration onto one instant and flatten every trend chart
 *    in the national console.
 *
 * NOTIFICATIONS
 * -------------
 * registerPet COLLECTS notifications into its return value and does not write
 * them — flushNotifications is called by the action, post-transaction (see
 * src/modules/pets/actions.ts). Ignoring `result.notifications` here therefore
 * discards them at zero cost; no sink needs injecting. This matters: ~4% of
 * seeded dogs are PPP-flagged, which would otherwise mean hundreds of synthetic
 * ppp_registration_reminder rows landing on the demo owner's bell.
 *
 * WHAT THE SEED STILL WRITES ITSELF
 * ---------------------------------
 * ParsedPet has no `status`, `deceasedAt` or `jurisdictionCountry`, and
 * registerPet always writes an OWNER ownership. Lost/deceased status and
 * shelter custody are post-registration facts; the caller applies them as cache
 * updates backed by the status_changed / death_recorded events it emits, which
 * is the same dual-write discipline the production writers use.
 */
async function registerSeedPet(
  spec: SeedPetSpec,
  ownerUserId: string,
  /** Token override — the history seed uses its own PANO-HIST- namespace. */
  tokenOverride?: string,
): Promise<{ petId: string } | null> {
  const localityId = await resolveLocalityId(spec.provinceName, spec.localityName);

  const parsed: ParsedPetInput = {
    name: spec.name,
    species: spec.species,
    sex: spec.sex,
    breed: null,
    dateOfBirth: null,
    birthDateIsEstimated: false,
    color: null,
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
    jurisdictionProvince: spec.provinceName,
    jurisdictionLocality: spec.localityName,
    localityId,
    acquisitionMethod: spec.acquisitionMethod as ParsedPetInput["acquisitionMethod"],
    emergencyInfoVisible: false,
    permanentConditions: [],
    permanentConditionsOther: null,
    discloseConditionsPublicly: false,
    custodyKind: "owner",
  };

  const token = tokenOverride ?? panoPublicToken(spec.index);

  const result = await registerPet(
    {
      parsed,
      potentiallyDangerousBreed: spec.dangerousBreed,
      uploadedPath: null,
      uploadMimeType: null,
      uploadSize: null,
      // No idempotency key: the seed's idempotency is the PANO- delete-and-reseed,
      // and a null key skips the per-pet advisory lock + duplicate SELECT.
      clientIdempotencyKey: null,
    },
    {
      repo: { ...PetsRepository, generatePublicToken: async () => token },
      actor: { user: { id: ownerUserId } },
      transaction: async <T>(cb: (tx: unknown) => Promise<T>) =>
        db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
      now: () => spec.registeredAt,
    },
  );

  if (!result.ok) {
    log("WARN", `  registerPet failed for ${token}: ${result.error}`);
    return null;
  }
  // result.notifications is deliberately DROPPED — see the doc comment above.
  const value = result.value as NonNullable<typeof result.value>;
  return { petId: value.petId };
}

// ---------------------------------------------------------------------------
// 5b. Static data tables
// ---------------------------------------------------------------------------

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
  "Perla",
  "Fido",
  "Kiara",
  "Zeus",
  "Apolo",
] as const;

const SPECIES_DIST = [
  { species: "dog", weight: 55 },
  { species: "cat", weight: 38 },
  { species: "rabbit", weight: 4 },
  { species: "other", weight: 3 },
] as const;

const SEXES = ["male", "female", "unknown"] as const;

/**
 * Per-province vaccination (rabies) target coverage [0..1] and microchip rate.
 * Intentionally varied to produce spread in the choropleth.
 * Values represent % of pets in that province with a vaccination event.
 */
const PROVINCE_COVERAGE: Record<string, { vacc: number; chip: number; ster: number }> = {
  "Buenos Aires": { vacc: 0.45, chip: 0.18, ster: 0.4 },
  CABA: { vacc: 0.4, chip: 0.2, ster: 0.38 },
  Córdoba: { vacc: 0.35, chip: 0.13, ster: 0.34 },
  "Santa Fe": { vacc: 0.32, chip: 0.12, ster: 0.32 },
  Mendoza: { vacc: 0.28, chip: 0.1, ster: 0.28 },
  Tucumán: { vacc: 0.2, chip: 0.08, ster: 0.22 },
  Salta: { vacc: 0.15, chip: 0.06, ster: 0.18 },
  "Entre Ríos": { vacc: 0.25, chip: 0.09, ster: 0.26 },
  Misiones: { vacc: 0.18, chip: 0.07, ster: 0.2 },
  Chaco: { vacc: 0.12, chip: 0.05, ster: 0.16 },
  Corrientes: { vacc: 0.14, chip: 0.06, ster: 0.17 },
  Jujuy: { vacc: 0.1, chip: 0.05, ster: 0.15 },
  "Río Negro": { vacc: 0.22, chip: 0.09, ster: 0.27 },
  Neuquén: { vacc: 0.24, chip: 0.09, ster: 0.29 },
  Formosa: { vacc: 0.08, chip: 0.05, ster: 0.14 },
  "San Juan": { vacc: 0.18, chip: 0.07, ster: 0.21 },
  "San Luis": { vacc: 0.19, chip: 0.07, ster: 0.22 },
  Catamarca: { vacc: 0.11, chip: 0.05, ster: 0.16 },
  "La Pampa": { vacc: 0.21, chip: 0.08, ster: 0.25 },
  "La Rioja": { vacc: 0.1, chip: 0.05, ster: 0.15 },
  "Santiago del Estero": { vacc: 0.09, chip: 0.05, ster: 0.15 },
  Chubut: { vacc: 0.2, chip: 0.08, ster: 0.24 },
  "Santa Cruz": { vacc: 0.17, chip: 0.07, ster: 0.2 },
  "Tierra del Fuego": { vacc: 0.3, chip: 0.11, ster: 0.36 },
};

/**
 * ~30 curated metro anchors. Each absorbs a Zipf/Pareto share of
 * its province's pets (the "urban concentration" heuristic).
 * weight is relative within-province; first entries get more pets.
 */
interface MetroAnchor {
  readonly province: string;
  readonly locality: string;
  readonly weight: number; // relative intra-province weight
}

const METRO_ANCHORS: readonly MetroAnchor[] = [
  // Buenos Aires — spread across the province
  { province: "Buenos Aires", locality: "La Plata", weight: 18 },
  { province: "Buenos Aires", locality: "Mar del Plata", weight: 14 },
  { province: "Buenos Aires", locality: "Quilmes", weight: 12 },
  { province: "Buenos Aires", locality: "Lanús", weight: 11 },
  { province: "Buenos Aires", locality: "Lomas de Zamora", weight: 10 },
  { province: "Buenos Aires", locality: "Morón", weight: 9 },
  { province: "Buenos Aires", locality: "Tigre", weight: 8 },
  { province: "Buenos Aires", locality: "San Isidro", weight: 8 },
  { province: "Buenos Aires", locality: "Bahía Blanca", weight: 7 },
  { province: "Buenos Aires", locality: "San Justo", weight: 6 },
  // CABA
  { province: "CABA", locality: "Palermo", weight: 20 },
  { province: "CABA", locality: "Caballito", weight: 15 },
  { province: "CABA", locality: "Belgrano", weight: 14 },
  { province: "CABA", locality: "Recoleta", weight: 12 },
  { province: "CABA", locality: "Flores", weight: 10 },
  // Córdoba
  { province: "Córdoba", locality: "Córdoba", weight: 30 },
  { province: "Córdoba", locality: "Río Cuarto", weight: 10 },
  { province: "Córdoba", locality: "Villa Carlos Paz", weight: 8 },
  // Santa Fe
  { province: "Santa Fe", locality: "Rosario", weight: 30 },
  { province: "Santa Fe", locality: "Santa Fe", weight: 20 },
  // Mendoza
  { province: "Mendoza", locality: "Mendoza", weight: 30 },
  { province: "Mendoza", locality: "San Rafael", weight: 12 },
  // Tucumán
  { province: "Tucumán", locality: "San Miguel de Tucumán", weight: 40 },
  // Salta
  { province: "Salta", locality: "Salta", weight: 35 },
  { province: "Salta", locality: "Tartagal", weight: 10 },
  // Misiones
  { province: "Misiones", locality: "Posadas", weight: 35 },
  // Chaco
  { province: "Chaco", locality: "Resistencia", weight: 40 },
  // Corrientes
  { province: "Corrientes", locality: "Corrientes", weight: 40 },
  // Jujuy
  { province: "Jujuy", locality: "San Salvador de Jujuy", weight: 40 },
  // Entre Ríos
  { province: "Entre Ríos", locality: "Paraná", weight: 35 },
  // Río Negro
  { province: "Río Negro", locality: "Bariloche", weight: 25 },
  { province: "Río Negro", locality: "Viedma", weight: 15 },
  // Neuquén
  { province: "Neuquén", locality: "Neuquén", weight: 40 },
  // Chubut
  { province: "Chubut", locality: "Comodoro Rivadavia", weight: 30 },
  { province: "Chubut", locality: "Rawson", weight: 15 },
  // Tierra del Fuego
  { province: "Tierra del Fuego", locality: "Ushuaia", weight: 40 },
  // Formosa
  { province: "Formosa", locality: "Formosa", weight: 50 },
  // Santiago del Estero
  { province: "Santiago del Estero", locality: "Santiago del Estero", weight: 45 },
  // San Juan
  { province: "San Juan", locality: "San Juan", weight: 50 },
  // San Luis
  { province: "San Luis", locality: "San Luis", weight: 50 },
  // La Rioja
  { province: "La Rioja", locality: "La Rioja", weight: 55 },
  // Catamarca
  { province: "Catamarca", locality: "San Fernando del Valle de Catamarca", weight: 55 },
  // La Pampa
  { province: "La Pampa", locality: "Santa Rosa", weight: 55 },
  // Santa Cruz
  { province: "Santa Cruz", locality: "Río Gallegos", weight: 50 },
];

// Province → metro anchor weight total (for normalizing intra-province shares)
const METRO_WEIGHT_BY_PROVINCE = new Map<string, number>();
for (const anchor of METRO_ANCHORS) {
  METRO_WEIGHT_BY_PROVINCE.set(
    anchor.province,
    (METRO_WEIGHT_BY_PROVINCE.get(anchor.province) ?? 0) + anchor.weight,
  );
}

// Welfare report kinds with weights (mostly moderate, a few critical)
const WELFARE_KINDS = [
  { kind: "abandonment", weight: 30 },
  { kind: "neglect", weight: 28 },
  { kind: "physical_abuse", weight: 12 },
  { kind: "chained", weight: 10 },
  { kind: "no_shelter", weight: 9 },
  { kind: "hoarding", weight: 5 },
  { kind: "dog_fighting", weight: 3 },
  { kind: "trafficking", weight: 2 },
  { kind: "other", weight: 1 },
] as const;

const WELFARE_SEVERITIES = [
  { severity: "low", weight: 20 },
  { severity: "medium", weight: 45 },
  { severity: "high", weight: 25 },
  { severity: "critical", weight: 10 },
] as const;

// Old-open backlog exception (C5 fix, seedHistoryWelfareAndCases): a report
// that is >180 days old AND still open is the realistic-backlog EXCEPTION,
// not the rule — and it must not also scream "critical" (the pre-fix bug: a
// 930-day-old "critical open" case reads as a live SLA breach, not a stale
// backlog item). Skewed hard toward low/medium; almost no critical.
const WELFARE_SEVERITIES_BACKLOG = [
  { severity: "low", weight: 55 },
  { severity: "medium", weight: 35 },
  { severity: "high", weight: 8 },
  { severity: "critical", weight: 2 },
] as const;

// Realistic citizen-report prose, per welfare kind (C5 fix — descriptions
// used to be `PANO-welfare-00042 — denuncia sintética de demostración` /
// `PANO-HIST-WEL-001243 denuncia histórica`: a seed-correlation index baked
// straight into rendered text, the exact "looks like a fake" tell the C5
// audit called out. The index now lives in welfare_reports.seed_tag
// (migration 0155, NOT rendered). Templates live in
// scripts/welfare-description-templates.ts, shared with the
// seed-demo-polish.ts repair path so both writers stay in lockstep.
function pickWelfareDescription(kind: string): string {
  const templates = WELFARE_DESCRIPTION_TEMPLATES[kind] ?? WELFARE_DESCRIPTION_TEMPLATES.other;
  return pick(templates);
}

// ---------------------------------------------------------------------------
// 5c. Province → ISO code map (for ar_localities lookup)
// ---------------------------------------------------------------------------

const PROVINCE_TO_CODE = new Map<string, string>(PROVINCES.map((p) => [p.name, p.code]));

// ---------------------------------------------------------------------------
// 6. Load reference data from DB (localities + census)
// ---------------------------------------------------------------------------

interface LocalityRow {
  id: string;
  provinceCode: string;
  localityName: string;
  lat: number;
  lng: number;
}

async function loadLocalities(): Promise<Map<string, LocalityRow[]>> {
  log("STEP", "Loading ar_localities with coordinates…");

  const rows = await db
    .select({
      id: arLocalities.id,
      provinceCode: arLocalities.provinceCode,
      localityName: arLocalities.localityName,
      latitude: arLocalities.latitude,
      longitude: arLocalities.longitude,
    })
    .from(arLocalities)
    .where(
      sql`${arLocalities.removedAt} IS NULL
          AND ${arLocalities.latitude} IS NOT NULL
          AND ${arLocalities.longitude} IS NOT NULL`,
    );

  const byProvince = new Map<string, LocalityRow[]>();
  for (const row of rows) {
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!byProvince.has(row.provinceCode)) byProvince.set(row.provinceCode, []);
    byProvince.get(row.provinceCode)!.push({
      id: row.id,
      provinceCode: row.provinceCode,
      localityName: row.localityName,
      lat,
      lng,
    });
  }

  const total = [...byProvince.values()].reduce((s, arr) => s + arr.length, 0);
  log("INFO", `Loaded ${total} localities across ${byProvince.size} province codes`);
  return byProvince;
}

/**
 * Replace CABA's whole-city placeholder locality with the 48 real barrios.
 *
 * ar_localities imports the barrios (scripts/import-caba-barrios.ts) WITHOUT
 * coordinates, so loadLocalities() (which requires lat/lng) drops them and the
 * AR-C bucket contains only the INDEC "Ciudad Autónoma de Buenos Aires"
 * placeholder — which then catches every CABA pet, producing one undifferentiated
 * blob instead of a by-barrio distribution. Here we swap that placeholder for the
 * 48 barrios (with frozen centroids) so pickLocality + seedModelProvinceHistory
 * naturally spread CABA pets/events across barrios. The CABA METRO_ANCHORS
 * (Palermo, Caballito, Belgrano, Recoleta, Flores) now resolve to real barrio
 * rows, giving the big barrios the bulk while every barrio still gets some.
 *
 * IDEMPOTENT: import-caba-barrios.ts now ships the barrios WITH centroids, so
 * loadLocalities() can pick them up from the DB. To avoid double-adding, we
 * drop any AR-C row whose name is a real barrio (as well as the whole-city
 * placeholder) before appending the frozen 48 — whether the coords came from
 * the DB or not, the injected set is the single authoritative copy.
 */
function injectCabaBarrios(byProvince: Map<string, LocalityRow[]>): void {
  const existing = byProvince.get("AR-C") ?? [];
  // Keep only rows that are neither the whole-city blob nor a real barrio the
  // DB import already loaded — then append the frozen 48 so there are no dupes.
  const kept = existing.filter(
    (l) => l.localityName !== CABA_PLACEHOLDER_LOCALITY && !CABA_BARRIO_NAMES.has(l.localityName),
  );
  const barrioRows: LocalityRow[] = CABA_BARRIOS.map((b) => ({
    id: `caba-barrio-${b.slug}`,
    provinceCode: "AR-C",
    localityName: b.name,
    lat: b.lat,
    lng: b.lng,
  }));
  byProvince.set("AR-C", [...kept, ...barrioRows]);
  log(
    "INFO",
    `CABA: normalized AR-C to the 48 real barrios (dropped ${existing.length - kept.length} placeholder/duplicate row(s))`,
  );
}

interface CensusRow {
  provinceName: string;
  population: number;
}

async function loadCensus(): Promise<CensusRow[]> {
  log("STEP", "Loading jurisdictions_census…");
  const rows = await db
    .select({
      provinceName: jurisdictionsCensus.provinceName,
      population: jurisdictionsCensus.population,
    })
    .from(jurisdictionsCensus);
  log("INFO", `Loaded ${rows.length} census rows`);
  return rows;
}

// ---------------------------------------------------------------------------
// 7. Locality picker — Zipf/Pareto for metro anchors, uniform for the rest
// ---------------------------------------------------------------------------

/**
 * Pick a locality for a pet in `provinceName`.
 * Metro anchors absorb ~70% of the province's pets (by weight ratio).
 * The remaining ~30% spread uniformly over other localities.
 * Always returns a locality with valid coordinates.
 */
function pickLocality(
  provinceName: string,
  localitiesByCode: Map<string, LocalityRow[]>,
): LocalityRow | null {
  const code = PROVINCE_TO_CODE.get(provinceName);
  if (!code) return null;

  const allLocalities = localitiesByCode.get(code);
  if (!allLocalities || allLocalities.length === 0) return null;

  // Build a locality name → row map for fast metro anchor lookup
  const byName = new Map<string, LocalityRow>();
  for (const loc of allLocalities) {
    byName.set(loc.localityName.toLowerCase(), loc);
  }

  // Gather province metro anchors and their available localities
  const metroAnchors = METRO_ANCHORS.filter((a) => a.province === provinceName);
  const totalMetroWeight = metroAnchors.reduce((s, a) => s + a.weight, 0);

  // 70% metro, 30% rural
  if (metroAnchors.length > 0 && rng() < 0.7) {
    // Pick a metro anchor weighted by its share
    let r = rng() * totalMetroWeight;
    for (const anchor of metroAnchors) {
      r -= anchor.weight;
      if (r <= 0) {
        // Find closest locality name match
        const found = byName.get(anchor.locality.toLowerCase());
        if (found) return found;
        // Fallback: first locality in province
        break;
      }
    }
  }

  // Rural / spillover: uniform over all available localities
  return allLocalities[Math.floor(rng() * allLocalities.length)];
}

/**
 * Apply gaussian geo jitter to a coordinate (simulate per-pet location
 * variance from the locality centroid). Urban radius ≈ 0.02°, rural ≈ 0.08°.
 */
function jitteredCoord(
  lat: number,
  lng: number,
  radiusDeg = 0.03,
): {
  lat: number;
  lng: number;
} {
  return {
    lat: lat + gaussianJitter(radiusDeg),
    lng: lng + gaussianJitter(radiusDeg),
  };
}

// ---------------------------------------------------------------------------
// 8. Seed organizations (shelters)
// ---------------------------------------------------------------------------

interface PanoOrg {
  id: string;
  provinceName: string;
  locality: string;
  lat: number;
  lng: number;
}

const SEED_ORGS: ReadonlyArray<{
  readonly slug: string;
  readonly province: string;
  readonly locality: string;
  readonly legalName: string;
  readonly orgType: "shelter" | "clinic" | "rescue_network" | "sanitary_authority" | "other";
}> = [
  {
    slug: "refugio-ba-01",
    province: "Buenos Aires",
    locality: "La Plata",
    legalName: "Refugio Panorama La Plata (Seed)",
    orgType: "shelter",
  },
  {
    slug: "refugio-caba-01",
    province: "CABA",
    locality: "Caballito",
    legalName: "Refugio Panorama CABA (Seed)",
    orgType: "shelter",
  },
  {
    slug: "refugio-cordoba-01",
    province: "Córdoba",
    locality: "Córdoba",
    legalName: "Refugio Panorama Córdoba (Seed)",
    orgType: "shelter",
  },
  {
    slug: "refugio-salta-01",
    province: "Salta",
    locality: "Salta",
    legalName: "Refugio Panorama Salta (Seed)",
    orgType: "shelter",
  },
  {
    slug: "clinica-rosario-01",
    province: "Santa Fe",
    locality: "Rosario",
    legalName: "Clínica Panorama Rosario (Seed)",
    orgType: "clinic",
  },
  {
    slug: "autoridad-chaco-01",
    province: "Chaco",
    locality: "Resistencia",
    legalName: "Autoridad Sanitaria Panorama Chaco (Seed)",
    orgType: "sanitary_authority",
  },
];

async function seedOrganizations(localitiesByCode: Map<string, LocalityRow[]>): Promise<PanoOrg[]> {
  log("STEP", "Seeding PANO organizations…");

  const result: PanoOrg[] = [];

  for (const spec of SEED_ORGS) {
    const token = `PANO-ORG-${spec.slug}`;

    // Check if exists
    const existing = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(sql`${organizations.publicToken} = ${token}`)
      .limit(1);

    const code = PROVINCE_TO_CODE.get(spec.province);
    const locs = code ? (localitiesByCode.get(code) ?? []) : [];
    const loc =
      locs.find((l) => l.localityName.toLowerCase() === spec.locality.toLowerCase()) ?? locs[0];

    const lat = loc ? loc.lat + gaussianJitter(0.01) : -34.6;
    const lng = loc ? loc.lng + gaussianJitter(0.01) : -58.4;

    if (existing.length > 0) {
      log("SKIP", `  Org ${token} already exists`);
      result.push({
        id: existing[0].id,
        provinceName: spec.province,
        locality: spec.locality,
        lat,
        lng,
      });
      continue;
    }

    const [inserted] = await db
      .insert(organizations)
      .values({
        publicToken: token,
        legalName: spec.legalName,
        displayName: spec.legalName,
        orgType: spec.orgType,
        email: `${spec.slug}@pano.seed.local`,
        verified: false,
        jurisdictionCountry: "AR",
        jurisdictionProvince: spec.province,
        jurisdictionLocality: spec.locality,
        ...writePoint({ lat, lng }),
      })
      .returning({ id: organizations.id });

    log("OK", `  Created org ${token}`);
    result.push({
      id: inserted.id,
      provinceName: spec.province,
      locality: spec.locality,
      lat,
      lng,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// 9. Seed owner profile (synthetic — no auth.users entry needed for FK ownerships)
// ---------------------------------------------------------------------------
// ownerships.owner_user_id → profiles.id. We need a profile in the DB.
// Use the existing owner@dim.test profile if available, else create a synthetic
// profile row directly (no auth.users side-effect needed for INSERT on profiles).
//
// display_name is a RENDERABLE column — it surfaces on operator screens as a
// case's "Abrió:"/reporter attribution. It used to be the literal string
// "PANO-Seed-Owner" (C5 audit finding: an obvious seed marker on a screen a
// funcionario reads as real). Deterministic lookup is by `id` — a fixed UUID
// derived from the seed tag — NOT by name, so the display name is free to be
// a realistic es-AR name without breaking idempotent re-runs. Never used as
// a "the real owner@dim.test" stand-in for anything auth-related.
const PANO_SEED_OWNER_ID = "00000000-4e41-4154-b000-000000000001";
const PANO_SEED_OWNER_DISPLAY_NAME = "Marisa Funes";

async function findOrCreateSeedOwnerProfileId(): Promise<string> {
  const exists = (await db.execute(
    sql`SELECT id FROM profiles WHERE id = ${PANO_SEED_OWNER_ID} LIMIT 1`,
  )) as unknown as Array<{ id: string }>;

  if (exists.length > 0) return PANO_SEED_OWNER_ID;

  await db.execute(sql`
    INSERT INTO profiles (id, display_name, role, account_type, created_at, updated_at)
    VALUES (
      ${PANO_SEED_OWNER_ID}::uuid,
      ${PANO_SEED_OWNER_DISPLAY_NAME},
      'owner',
      'personal',
      now(),
      now()
    )
    ON CONFLICT (id) DO NOTHING
  `);

  log(
    "OK",
    `Created synthetic owner profile ${PANO_SEED_OWNER_ID} (${PANO_SEED_OWNER_DISPLAY_NAME})`,
  );
  return PANO_SEED_OWNER_ID;
}

// ---------------------------------------------------------------------------
// 10. --clean: delete all PANO-tagged data in FK-safe order
// ---------------------------------------------------------------------------

async function runClean(): Promise<void> {
  log("STEP", "--clean / pre-clean: removing all PANO-tagged data");

  // 10-pre. Health campaigns (service_offerings + slots + appointments).
  // FK-safe order is appointments → time_slots → service_schedule_rules →
  // service_offerings. appointments.slot_id is ON DELETE RESTRICT, so the
  // bookings MUST go before their slots. We MUST also run this BEFORE the pet
  // delete below: appointments.pet_id is ON DELETE CASCADE, so deleting PANO
  // pets first would silently remove the bookings and leave orphaned PANO slots
  // + offerings (which then never get cleaned, breaking idempotency). Keyed off
  // the deterministic PANO-SVO- offering token (offerings are the root of the
  // cascade) plus the PANO-APT- appointment token as a belt-and-suspenders.
  const panoOfferings = await db
    .select({ id: serviceOfferings.id })
    .from(serviceOfferings)
    .where(like(serviceOfferings.publicToken, "PANO-SVO-%"));

  if (panoOfferings.length > 0) {
    const offeringIds = panoOfferings.map((o) => o.id);

    const panoSlots = await db
      .select({ id: timeSlots.id })
      .from(timeSlots)
      .where(inArray(timeSlots.serviceOfferingId, offeringIds));
    const slotIds = panoSlots.map((s) => s.id);

    if (slotIds.length > 0) {
      await db.delete(appointments).where(inArray(appointments.slotId, slotIds));
    }
    // Belt-and-suspenders: any stray PANO-APT- appointments not covered above.
    await db.delete(appointments).where(like(appointments.publicToken, "PANO-APT-%"));
    if (slotIds.length > 0) {
      await db.delete(timeSlots).where(inArray(timeSlots.id, slotIds));
    }
    await db
      .delete(serviceScheduleRules)
      .where(inArray(serviceScheduleRules.serviceOfferingId, offeringIds));
    await db.delete(serviceOfferings).where(inArray(serviceOfferings.id, offeringIds));
    log(
      "OK",
      `  Deleted ${panoOfferings.length} PANO campaigns (offerings + ${slotIds.length} slots + appointments)`,
    );
  }

  // 10a. Pets tagged with PANO-
  const panoPets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(like(pets.publicToken, `${PANO_TAG}%`));

  log("INFO", `Found ${panoPets.length} PANO-tagged pets`);

  if (panoPets.length > 0) {
    const actorRows = (await db.execute(sql`SELECT id FROM profiles LIMIT 1`)) as unknown as Array<{
      id: string;
    }>;
    const actorId = actorRows[0]?.id ?? null;

    if (!actorId) {
      log("WARN", "No profile found — skipping pet_events deletion (no actor for override)");
    }

    const panoIds = panoPets.map((p) => p.id);
    const DEL_BATCH = 500;

    for (let start = 0; start < panoIds.length; start += DEL_BATCH) {
      const batch = panoIds.slice(start, start + DEL_BATCH);

      await db.transaction(async (tx) => {
        // FK-safe order for the derived families seeded by the vigilancia +
        // enforcement steps. These reference PANO pet_events / pets and MUST be
        // removed before the pet_events / pets deletes below:
        //   1. eno_processing_queue.pet_event_id — NO FK (just a unique idx), so
        //      it never cascades; delete explicitly by the PANO pet_event IDs.
        //   2. event_notification_outbox.source_event_id — ON DELETE CASCADE on
        //      pet_events (auto-cleans), but we delete explicitly for clarity.
        //   3. cases.primary_pet_id — ON DELETE CASCADE on pets (auto-cleans),
        //      BUT pet_events.case_id is ON DELETE RESTRICT and pre-2026-07
        //      seed versions DID set it (rabies-observation events) — staging
        //      still carries that dataset. So events must go before cases,
        //      and the event sweep must also cover events that reference this
        //      batch's cases from a pet OUTSIDE the batch (bite cases span
        //      two pets, which may land in different DEL_BATCH windows).
        const batchCaseIds = (
          await tx.select({ id: cases.id }).from(cases).where(inArray(cases.primaryPetId, batch))
        ).map((r) => r.id);

        const eventSweepWhere =
          batchCaseIds.length > 0
            ? or(inArray(petEvents.petId, batch), inArray(petEvents.caseId, batchCaseIds))
            : inArray(petEvents.petId, batch);

        const batchEventIds = (
          await tx.select({ id: petEvents.id }).from(petEvents).where(eventSweepWhere)
        ).map((r) => r.id);

        if (batchEventIds.length > 0) {
          await tx
            .delete(enoProcessingQueue)
            .where(inArray(enoProcessingQueue.petEventId, batchEventIds));
          await tx
            .delete(eventNotificationOutbox)
            .where(inArray(eventNotificationOutbox.sourceEventId, batchEventIds));
        }

        if (actorId) {
          await tx.execute(sql`SELECT set_config('app.allow_event_mutation', 'true', true)`);
          await tx.execute(
            sql`SELECT set_config('app.allow_event_mutation_actor', ${actorId}, true)`,
          );
          await tx.delete(petEvents).where(eventSweepWhere);
        }
        await tx.delete(cases).where(inArray(cases.primaryPetId, batch));
        await tx.delete(ownerships).where(inArray(ownerships.petId, batch));
        await tx.delete(pets).where(inArray(pets.id, batch));
      });

      log("OK", `  Deleted pet batch [${start}..${start + batch.length - 1}]`);
    }
  }

  // 10a-bis. Belt-and-suspenders: remove any PANO-tagged cases that, for
  // whatever reason, did not cascade with their primary pet (e.g. a case whose
  // pet was already gone). Two independent tags, since not all PANO cases
  // share a public_code prefix:
  //   - public_code LIKE 'PANO-CASE-%'  → RABOBS/DECOMISO/DISPUTE literal codes
  //   - opened_reason LIKE '%seed histórico%' → multi-year HIST decomiso/
  //     dispute cases, which use production-format CAS-XXXX-XXXX public
  //     codes (see seedHistoryWelfareAndCases) and so are NOT matched by the
  //     public_code pattern above; they have no primary_pet_id to cascade on
  //     either (primarySubjectKind='location'), so this is their only cleanup path.
  const deletedCases = await db.execute(
    sql`DELETE FROM cases WHERE public_code LIKE 'PANO-CASE-%' OR opened_reason LIKE '%seed histórico%'`,
  );
  log("OK", `  Deleted PANO cases (${JSON.stringify(deletedCases)})`);

  // 10b. PANO organizations
  const panoOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(like(organizations.publicToken, "PANO-ORG-%"));

  if (panoOrgs.length > 0) {
    await db.delete(organizations).where(
      inArray(
        organizations.id,
        panoOrgs.map((o) => o.id),
      ),
    );
    log("OK", `  Deleted ${panoOrgs.length} PANO organizations`);
  }

  // 10c. PANO welfare reports — keyed off the NON-RENDERED seed_tag column
  // (migration 0155) primarily, PLUS a belt-and-suspenders description-LIKE
  // match for rows seeded BEFORE that column existed (seed_tag IS NULL on
  // those). Without the second clause, a --clean/re-seed on a DB seeded pre-
  // C5 leaves the old age-incoherent-status rows in place forever — the
  // fresh insert only ADDS clean rows on top instead of replacing the dirty
  // ones (this is exactly how the pre-fix "930-day-old critical open" rows
  // were discovered surviving a re-seed). Description no longer carries a
  // seed marker for FRESH rows (C5 fix), so this LIKE clause only ever
  // matches leftover pre-fix data — it is a one-time bridge, not a permanent
  // reliance on rendered text.
  const deletedWelfare = await db.execute(sql`
    DELETE FROM welfare_reports
    WHERE (seed_tag IS NOT NULL AND seed_tag LIKE 'PANO%')
       OR description LIKE 'PANO-%'
       OR description LIKE '%HIST-WEL%'
  `);
  log("OK", `  Deleted PANO welfare reports (${JSON.stringify(deletedWelfare)})`);

  // 10d. PANO synthetic owner profile — keyed off the deterministic id, not
  // display_name (which is now a realistic name, not a seed marker).
  await db.execute(sql`DELETE FROM profiles WHERE id = ${PANO_SEED_OWNER_ID}`);

  // 10e. Reset the ENO outbreak-investigation pool.
  //
  // The manual "abrir investigación" flow (app/gob/vigilancia/investigaciones/
  // nuevo + the 05-gobierno recording) dedupes ONE open investigation per
  // (ENO disease, jurisdiction). The ENO catalog is LOCKED by spec at a
  // handful of diseases (ENO-D1 — src/modules/surveillance/domain/eno-catalog.ts,
  // "DO NOT add diseases here"), so the govt jurisdiction's openable pool is
  // tiny AND these cases are NOT PANO-tagged, so they persist across recording
  // runs. Once every disease already has an open investigation the flow can no
  // longer open a fresh one and the journey exhausts. Widening the catalog is
  // off the table (spec-locked, each disease is a legal ENO entry), so the
  // honest lever is to PURGE the manually-opened investigations on each reseed,
  // restoring the full openable pool. Scoped to opened_reason LIKE 'manual [%'
  // so only manual-apertura cases are touched (bite/rabies auto-cases carry
  // other reasons). case_events is append-only (case_events_mutation_override
  // trigger), so the GUC pair must be set before the cascade delete fires.
  const manualInvestigations = await db
    .select({ id: cases.id })
    .from(cases)
    .where(
      and(eq(cases.caseKind, "outbreak_investigation"), like(cases.openedReason, "manual [%")),
    );

  if (manualInvestigations.length > 0) {
    const actorRows = (await db.execute(sql`SELECT id FROM profiles LIMIT 1`)) as unknown as Array<{
      id: string;
    }>;
    const actorId = actorRows[0]?.id ?? null;

    if (!actorId) {
      log("WARN", "  No profile found — skipping outbreak-investigation pool reset");
    } else {
      const ids = manualInvestigations.map((r) => r.id);
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.allow_event_mutation', 'true', true)`);
        await tx.execute(
          sql`SELECT set_config('app.allow_event_mutation_actor', ${actorId}, true)`,
        );
        await tx.delete(caseEvents).where(inArray(caseEvents.caseId, ids));
        await tx.delete(cases).where(inArray(cases.id, ids));
      });
      log(
        "OK",
        `  Reset ${manualInvestigations.length} manual outbreak investigation(s) — ENO pool restored`,
      );
    }
  }

  log("DONE", "Clean complete");
}

// ---------------------------------------------------------------------------
// 11. Welfare reports seeding
// ---------------------------------------------------------------------------

async function seedWelfareReports(
  localitiesByCode: Map<string, LocalityRow[]>,
  census: CensusRow[],
  totalWelfare: number,
): Promise<number> {
  log("STEP", `Seeding ~${totalWelfare} welfare reports…`);

  const WELFARE_BATCH = 100;
  let inserted = 0;

  const rows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < totalWelfare; i++) {
    // Pick province weighted by population
    const totalPop = census.reduce((s, c) => s + c.population, 0);
    let popR = rng() * totalPop;
    let prov = census[census.length - 1];
    for (const c of census) {
      popR -= c.population;
      if (popR <= 0) {
        prov = c;
        break;
      }
    }

    const loc = pickLocality(prov.provinceName, localitiesByCode);
    const { lat, lng } = loc
      ? jitteredCoord(loc.lat, loc.lng, 0.05)
      : { lat: -34.6 + gaussianJitter(2), lng: -58.4 + gaussianJitter(4) };

    const kindEntry = pickWeighted(
      WELFARE_KINDS as unknown as Array<{ kind: string; weight: number }>,
    );
    const severityEntry = pickWeighted(
      WELFARE_SEVERITIES as unknown as Array<{ severity: string; weight: number }>,
    );

    const referenceCode = generateReferenceCode();
    const occurredAt = randomWindowDate();

    rows.push({
      referenceCode,
      kind: kindEntry.kind,
      severity: severityEntry.severity,
      description: pickWelfareDescription(kindEntry.kind),
      // Internal-only cleanup marker — NEVER rendered (migration 0155).
      seedTag: "PANO",
      subjectKind: pick(["unowned_animal", "location", "general", "unowned_animal"] as const),
      status: "open" as const,
      flagReasons: [],
      jurisdictionProvince: prov.provinceName,
      jurisdictionLocality: loc?.localityName ?? null,
      // The structural FK (migration 0147), resolved exactly like the pets above
      // (L4·1 of the locality plan). This script used to leave it NULL on every
      // seeded report — 2.789 of 2.790 denuncias in the local panorama — so a
      // read that switched from the name to the FK would have zeroed the whole
      // denuncias detail, and a one-off backfill would break again on the next
      // seed. A miss stays NULL, like a real report outside the catalog.
      localityId: await resolveLocalityId(prov.provinceName, loc?.localityName ?? null),
      locationLat: lat.toFixed(7),
      locationLng: lng.toFixed(7),
      occurredAt,
    });
  }

  for (let b = 0; b < rows.length; b += WELFARE_BATCH) {
    const batch = rows.slice(b, b + WELFARE_BATCH);
    await db.insert(welfareReports).values(
      batch as Parameters<typeof db.insert<typeof welfareReports>>[0] extends {
        values: (v: infer V) => unknown;
      }
        ? V
        : never,
    );
    inserted += batch.length;
  }

  log("INFO", `  Inserted ${inserted} welfare reports`);
  return inserted;
}

// ---------------------------------------------------------------------------
// 12. Build per-pet event list
// ---------------------------------------------------------------------------

/**
 * Draw the acquisition method for a pet (D-adoption).
 *
 * /gob/analytics derives the adoption rate from the pet_registered payload
 * field (acquisition_method='adopted'), NOT from adoption_finalized — so the
 * KPI only moves when this is populated. Shelter-custody pets always count as
 * adopted; the rest pick up the baseline rate.
 *
 * Hoisted out of buildPetEvents because registerPet now owns the
 * pet_registered event, and it needs this value BEFORE the pet exists.
 */
function drawAcquisitionMethod(shelterOrgId: string | null): string {
  return shelterOrgId !== null || rng() < ADOPTION_ACQUISITION_RATE
    ? "adopted"
    : pick(["purchased", "found_stray", "gift", "born_in_litter", "other"] as const);
}

/**
 * Build the POST-REGISTRATION event list for a pet.
 *
 * pet_registered is NOT emitted here any more — registerSeedPet drives the real
 * registerPet use-case, which emits it inside the registration transaction with
 * the canonical payload shape. Emitting a second one here would duplicate the
 * spine's registration fact.
 */
function buildPetEvents(
  petId: string,
  ownerUserId: string,
  species: string,
  provinceName: string,
  lat: number,
  lng: number,
  petIndex: number,
  opts: { shelterOrgId: string | null; dangerousBreed: boolean },
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const coverage = PROVINCE_COVERAGE[provinceName] ?? { vacc: 0.15, chip: 0.05, ster: 0.18 };

  // Vaccination: per coverage rate
  if (rng() < coverage.vacc) {
    const vaccinatedAt = randomWindowDate();
    events.push({
      petId,
      eventType: "vaccination_administered" satisfies EventType,
      occurredAt: vaccinatedAt,
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      authorVerified: false,
      payload: {
        source: "seed-panorama",
        vaccine_name: "antirrábica",
        brand: pick(["Defensor 3", "Rabvac 3", "Nobivac Rabies"]),
        batch: `PANO-${String(petIndex % 9999).padStart(4, "0")}`,
        next_due_at: null,
      },
      ...writePoint(jitteredCoord(lat, lng, 0.02)),
    });
  }

  // Microchip: per coverage rate
  if (rng() < coverage.chip) {
    const chipBase = String(petIndex).padStart(9, "0");
    events.push({
      petId,
      eventType: "microchip_implanted" satisfies EventType,
      occurredAt: randomWindowDate(WINDOW_DAYS + 365),
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      authorVerified: false,
      payload: {
        source: "seed-panorama",
        chip_number: `858${chipBase}`,
        country_code: "858",
        implanted_by: null,
        location_on_body: "interscapular",
        implant_date_known: true,
      },
    });
  }

  // Sterilization: per-province rate × global multiplier. The KPI
  // (fetchSterilizationMetrics) compares the trailing 30 days against the
  // PRIOR 30 days (deltaPct). Dating every event within a strict 28-day
  // window (C5 audit finding) put ALL sterilizations in the "current" bucket
  // and left the "prior" bucket empty for every org — an unstable base that
  // produced wild, meaningless MoM swings the moment any one org's count
  // moved at all. Widened to 60 days so both windows get real data.
  //
  // That 60-day window is relative to ANCHOR_ISO (a frozen date), not to real
  // "today". Once real time moves past the anchor, the entire cohort ages
  // into the "31-60 days ago" bucket and the last-30-days bucket goes to ~0,
  // producing a false ~-100% MoM cliff on the /gob sterilization tile that
  // has nothing to do with an actual drop in sterilizations. Sterilization
  // dating is therefore deliberately CURRENT-relative (Date.now(), not
  // ANCHOR_MS) and spread over a wide ~180-day window straddling real today,
  // so both the trailing-30-days and prior-30-days buckets stay populated no
  // matter how much real time has passed since the anchor was frozen. This is
  // scoped to sterilization_performed only — ANCHOR_ISO stays untouched so
  // every other anchor-relative metric in this seed is unaffected, and the
  // guard/arithmetic in fetchSterilizationMetrics is untouched too.
  if (rng() < coverage.ster * (STERILIZATION_RATE / 0.28)) {
    const attributeToOrg = opts.shelterOrgId !== null || rng() < 0.35;
    events.push({
      petId,
      eventType: "sterilization_performed" satisfies EventType,
      occurredAt: new Date(Date.now() - rng() * 180 * 24 * 3600 * 1000),
      recordedByUserId: ownerUserId,
      authorRole: attributeToOrg ? "vet" : "owner",
      authorVerified: attributeToOrg,
      ...(opts.shelterOrgId !== null ? { authorOrganizationId: opts.shelterOrgId } : {}),
      payload: {
        source: "seed-panorama",
        procedure: species === "cat" || rng() < 0.5 ? "castration" : "spay",
        performed_by: attributeToOrg ? "Veterinaria municipal" : null,
        clinic: opts.shelterOrgId !== null ? "Red de esterilización" : null,
      },
      ...writePoint(jitteredCoord(lat, lng, 0.02)),
    });
  }

  // Dangerous-breed attestation (PPP / C7): only a fraction of flagged pets
  // are actually attested → Registro PPP coverage stays < 100% (the
  // compliance-gap story). attested_at is an ISO date string per the schema.
  if (opts.dangerousBreed && rng() < PPP_ATTEST_RATE) {
    const attestedAt = randomWindowDate(WINDOW_DAYS + 120);
    events.push({
      petId,
      eventType: "dangerous_breed_attested" satisfies EventType,
      occurredAt: attestedAt,
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      authorVerified: false,
      payload: {
        source: "seed-panorama",
        registry: pick(["caba_4078", "prov_14107", "other"] as const),
        registry_id: `PPP-${String(petIndex % 99999).padStart(5, "0")}`,
        attested_at: attestedAt.toISOString().slice(0, 10),
      },
      ...writePoint(jitteredCoord(lat, lng, 0.02)),
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// 13. Main seeding loop — pets by province
// ---------------------------------------------------------------------------

async function seedPets(
  localitiesByCode: Map<string, LocalityRow[]>,
  census: CensusRow[],
  ownerUserId: string,
  shelterOrgs: PanoOrg[],
): Promise<{
  totalPets: number;
  lostPets: number;
  deceasedPets: number;
  eventCounts: Record<string, number>;
  globalIndex: number;
}> {
  log("STEP", "Seeding pets by province…");

  let globalIndex = 0;
  let totalPets = 0;
  let lostPets = 0;
  let deceasedPets = 0;
  const eventCounts: Record<string, number> = {};

  for (const censusProv of census) {
    const provinceName = censusProv.provinceName;
    // Population-weighted base, then the per-province PANO_PROVINCE_BOOST
    // multiplier (identity for unlisted provinces) — see the knob comment.
    const baseCount = Math.max(1, Math.round(censusProv.population * PETS_PER_CAPITA * SCALE));
    const provinceCount = boostedProvinceCount(baseCount, provinceName, PROVINCE_BOOST);

    const boostNote =
      provinceCount !== baseCount
        ? ` — boost ×${PROVINCE_BOOST.get(provinceName)} (base ${baseCount})`
        : "";
    log(
      "INFO",
      `  ${provinceName}: ${provinceCount} pets (pop ${censusProv.population.toLocaleString()})${boostNote}`,
    );

    // Collect the per-pet plan for this province. Pets are no longer bulk
    // inserted — phase 2 below drives registerPet (the real intake use-case)
    // once per pet, so this phase only decides WHAT to register.
    const perPetMeta: Array<{
      index: number;
      status: "active" | "lost" | "deceased";
      /** Registration instant — also the start of this pet's mortality exposure. */
      registeredAt: Date;
      lat: number;
      lng: number;
      provinceName: string;
      localityName: string | null;
      species: string;
      name: string;
      sex: "male" | "female" | "unknown";
      dangerousBreed: boolean;
      reunified: boolean;
    }> = [];

    for (let i = 0; i < provinceCount; i++) {
      const idx = globalIndex + i;
      const speciesEntry = pickWeighted(
        SPECIES_DIST as unknown as Array<{ species: string; weight: number }>,
      );
      const species = speciesEntry.species;
      const name = pick(PET_NAMES);
      const sex = pick(SEXES);

      const loc = pickLocality(provinceName, localitiesByCode);
      const baseLat = loc ? loc.lat : -34.6 + gaussianJitter(4);
      const baseLng = loc ? loc.lng : -58.4 + gaussianJitter(6);
      const { lat, lng } = jitteredCoord(baseLat, baseLng, 0.03);

      // Historical registration instant — can be older than the event window.
      // Drawn HERE rather than at registration time in phase 2 because the
      // mortality draw immediately below needs this pet's EXPOSURE: how long it
      // has been on the register and therefore at risk.
      const registeredAt = randomWindowDate(WINDOW_DAYS + 180);
      const exposureYears = (ANCHOR_MS - registeredAt.getTime()) / MS_PER_YEAR;

      // Status. Two independent draws, because they answer different questions.
      //
      //   lost (0.4%)  — an operational prevalence of the "currently lost"
      //                  caseload. Unchanged.
      //
      //   deceased     — DERIVED, not chosen. Panorama's Mortalidad layer
      //                  counts pets CURRENTLY status='deceased'
      //                  (metricPredicate('mortality') in
      //                  repository-choropleth.ts) — a cumulative STOCK, not an
      //                  annual flow. So the per-pet probability is the
      //                  published annual crude rate scaled by that pet's own
      //                  exposure:  P(dead now) = annual_rate × exposureYears.
      //
      //                  Registrations spread uniformly over WINDOW_DAYS+180 =
      //                  270 days, so mean exposure is 135 d ≈ 0.37 yr and the
      //                  expected deceased share of the register is
      //                  ≈ 0.08 × 0.37 ≈ 3.0%. That replaces a flat 0.3% that
      //                  was neither sourced nor exposure-aware, and which left
      //                  the Mortalidad view suppressed in every department.
      //
      // DISTRIBUTION: the hazard is per-pet and independent of locality, so
      // deaths fall in proportion to the pet population — the map shows no
      // territorial pattern that this seed invented, only binomial noise.
      // Age-correlated mortality would be more faithful still, but every pet
      // this seed registers carries dateOfBirth: null (see registerSeedPet), so
      // there are no ages to correlate against. Adding synthetic ages is the
      // prerequisite for that upgrade, not a tweak to these rates.
      const lostDraw = rng();
      const deathDraw = rng();
      const annualDeathRate = ANNUAL_DEATH_RATE_BY_SPECIES[species] ?? ANNUAL_DEATH_RATE_DEFAULT;
      let status: "active" | "lost" | "deceased" = "active";
      if (lostDraw < 0.004) {
        status = "lost";
        lostPets++;
      } else if (deathDraw < annualDeathRate * exposureYears) {
        status = "deceased";
        deceasedPets++;
      }

      // PPP flag (potentially dangerous breed). Only dogs qualify (Ley CABA
      // 4078 / Prov 14.107). Drives the dangerous_breed_attested attestation
      // event later so the Registro PPP shows < 100% coverage.
      const dangerousBreed = species === "dog" && rng() < DANGEROUS_BREED_FLAG_RATE;

      // Reunification (D4): a fraction of lost pets are later found/returned.
      // The draw happens here so the per-pet RNG sequence stays stable; the
      // found event + status flip are emitted alongside the lost event below.
      const reunified = status === "lost" && rng() < REUNIFICATION_RATE;

      perPetMeta.push({
        index: idx,
        status,
        registeredAt,
        lat,
        lng,
        provinceName,
        localityName: loc?.localityName ?? null,
        species,
        name: panoName(idx, name),
        sex,
        dangerousBreed,
        reunified,
      });
    }

    // Phase 2: register each pet through the REAL intake circuit, then append
    // its post-registration events.
    //
    // The pets row + owner ownership + pet_registered event now come out of
    // registerPet (see registerSeedPet). What stays here is what the use-case
    // has no input for: shelter custody, lost/deceased status, and the
    // deceasedAt cache — each of them backed by an event this loop emits.
    const eventRows: Array<Record<string, unknown>> = [];
    // Cache-column corrections applied after registration, grouped so they cost
    // one UPDATE per distinct shape instead of one per pet.
    const shelterOwnerships: Array<{ petId: string; orgId: string }> = [];
    const lostPetIds: string[] = [];
    const deceasedPetIds: Array<{ petId: string; deceasedAt: Date }> = [];

    for (let i = 0; i < provinceCount; i++) {
      const meta = perPetMeta[i];

      // ~2% of pets belong to a shelter org (if available). C5 fix: the
      // fallback used to be the FIRST org unconditionally (`shelterOrgs[0]`,
      // always La Plata) whenever a pet's province had no matching seed org
      // — since only 6/24 provinces have one, La Plata absorbed every other
      // province's shelter-custody pets (and therefore its sterilization
      // authorship), leaving every other org with ~0 in the recent window.
      // A single reporting org is exactly the "−95.6% MoM cliff" symptom:
      // one org's small random dip reads as a national collapse. Falling
      // back to a random pick (still deterministic — the seeded `rng()`)
      // spreads shelter-custody assignment, and therefore sterilization
      // attribution, across all seeded orgs.
      const useShelterOrg = shelterOrgs.length > 0 && rng() < 0.02;
      const shelterOrg = useShelterOrg
        ? (shelterOrgs.find((o) => o.provinceName === meta.provinceName) ?? pick(shelterOrgs))
        : null;

      // Drawn BEFORE registration: it lands in the pet_registered payload that
      // registerPet writes, so it has to be known up front.
      const acquisitionMethod = drawAcquisitionMethod(shelterOrg?.id ?? null);
      // Drawn in phase 1 (the mortality hazard needs it to size this pet's
      // exposure), carried here so registerPet stamps the same instant.
      const registeredAt = meta.registeredAt;

      // ── The real intake circuit ──────────────────────────────────────────
      const registered = await registerSeedPet(
        {
          index: meta.index,
          name: meta.name,
          species: meta.species,
          sex: meta.sex,
          provinceName: meta.provinceName,
          localityName: meta.localityName,
          dangerousBreed: meta.dangerousBreed,
          acquisitionMethod,
          registeredAt,
          seedTag: SEED_TAG_PANORAMA,
        },
        ownerUserId,
      );
      if (!registered) continue;
      const petId = registered.petId;

      // Shelter custody: registerPet always writes an OWNER ownership (its
      // ParsedPet has no notion of an organization holding the animal), so the
      // ~2% shelter pets have that row re-pointed at the org afterwards.
      if (shelterOrg) {
        shelterOwnerships.push({ petId, orgId: shelterOrg.id });
      }

      // Build events
      const evts = buildPetEvents(
        petId,
        ownerUserId,
        meta.species,
        meta.provinceName,
        meta.lat,
        meta.lng,
        meta.index,
        { shelterOrgId: shelterOrg?.id ?? null, dangerousBreed: meta.dangerousBreed },
      );

      // Lost pet → status_changed event (active → lost).
      if (meta.status === "lost") {
        // A reunified pet ends back "active" — the status flip is captured by
        // the paired lost→found status_changed events on the timeline, so only
        // the still-lost ones need the cache column moved off registerPet's
        // default "active".
        if (!meta.reunified) lostPetIds.push(petId);
        const lostAt = randomWindowDate(RECENT_LOSS_WINDOW_DAYS); // recent
        evts.push({
          petId,
          eventType: "status_changed" satisfies EventType,
          occurredAt: lostAt,
          recordedByUserId: ownerUserId,
          authorRole: "owner",
          authorVerified: false,
          payload: {
            source: "seed-panorama",
            from_status: "active",
            to_status: "lost",
            // Honest last-seen text: the pet's OWN locality/province — a fixed
            // metro-area placeholder on pets across the country misdirects
            // searchers on /perdidas (clickthrough review 2026-07-09).
            location_description: meta.localityName
              ? `${meta.localityName}, ${meta.provinceName}`
              : meta.provinceName,
          },
          ...writePoint(jitteredCoord(meta.lat, meta.lng, 0.04)),
        });

        // Reunification (D4): a fraction are found/returned → a second
        // status_changed (lost → active) a few days after the loss. The pet
        // row was created back in "active" for these so the timeline + the
        // current status reconcile. Realistic reunification rate for /gob.
        if (meta.reunified) {
          evts.push({
            petId,
            eventType: "status_changed" satisfies EventType,
            occurredAt: new Date(lostAt.getTime() + randInt(1, 9) * 24 * 3600 * 1000),
            recordedByUserId: ownerUserId,
            authorRole: "owner",
            authorVerified: false,
            payload: {
              source: "seed-panorama",
              from_status: "lost",
              to_status: "active",
              location_description: "Reencuentro con la familia",
              reunified: true,
            },
            ...writePoint(jitteredCoord(meta.lat, meta.lng, 0.04)),
          });
        }
      }

      // Shelter-custody pet → adoption_finalized event (D-adoption). Models the
      // org→owner handoff so the adoption-event family is non-empty; the
      // analytics adoption RATE is separately driven by pet_registered
      // acquisition_method='adopted' (set in buildPetEvents).
      if (shelterOrg && rng() < 0.5) {
        evts.push({
          petId,
          eventType: "adoption_finalized" satisfies EventType,
          occurredAt: randomWindowDate(WINDOW_DAYS),
          recordedByUserId: ownerUserId,
          authorRole: "shelter",
          authorVerified: true,
          authorOrganizationId: shelterOrg.id,
          payload: {
            source: "seed-panorama",
            previous_owner_organization_id: shelterOrg.id,
            adopter_user_id: ownerUserId,
            foster_user_id: null,
            contract_attachment_id: null,
            post_adoption_followup_months: pick([6, 12]),
            notes: null,
          },
        });
      }

      // Deceased pet → death_recorded event
      if (meta.status === "deceased") {
        // Uniform INSIDE the pet's own exposure window [registeredAt, anchor],
        // not the flat trailing 90 days this replaced: registrations reach 270
        // days back, so a fixed 90-day draw produced pets whose recorded death
        // predated the registration that created the record.
        const diedAt = new Date(
          meta.registeredAt.getTime() + rng() * (ANCHOR_MS - meta.registeredAt.getTime()),
        );
        deceasedPetIds.push({ petId, deceasedAt: diedAt });
        evts.push({
          petId,
          eventType: "death_recorded" satisfies EventType,
          occurredAt: diedAt,
          recordedByUserId: ownerUserId,
          authorRole: "owner",
          authorVerified: false,
          payload: {
            source: "seed-panorama",
            // "disease" is the canonical DEATH_CAUSES value (deathCauseLabel maps
            // it to "Enfermedad"); "illness" rendered raw (dashboards D3).
            cause: pick(["natural", "accident", "disease", "euthanasia"]),
            cause_detail: null,
            confirmed_by_vet: rng() < 0.4,
            vet_name: null,
            disposition_method: pick([
              "owner_burial",
              "cremation_collective",
              "authorized_cemetery",
              "unknown",
            ]),
            // Institutional disposals carry a facility → traceable (B3). Without
            // any facilities the traceability KPI read a misleading 0% (D4).
            facility: rng() < 0.45 ? "Establecimiento habilitado" : null,
            death_at_clinic: false,
            vet_contacted_owner: "unknown",
            vet_decided_alone: null,
            is_reportable: false,
            during_rabies_observation: false,
          },
        });
      }

      for (const e of evts) eventRows.push(e);
      for (const e of evts) {
        const t = e.eventType as string;
        eventCounts[t] = (eventCounts[t] ?? 0) + 1;
      }
    }

    // ── Post-registration cache corrections ──────────────────────────────
    // Each of these mirrors a fact the loop above already wrote to the event
    // spine; none of them invents state the spine does not carry.

    // Shelter custody: re-point registerPet's owner ownership at the org.
    for (let b = 0; b < shelterOwnerships.length; b += BATCH_SIZE) {
      const batch = shelterOwnerships.slice(b, b + BATCH_SIZE);
      for (const { petId, orgId } of batch) {
        await db
          .update(ownerships)
          .set({ ownerUserId: null, ownerOrganizationId: orgId, role: "shelter_custody" })
          .where(eq(ownerships.petId, petId));
      }
    }

    // status='lost' — backed by the status_changed(active→lost) event above.
    for (let b = 0; b < lostPetIds.length; b += BATCH_SIZE) {
      const batch = lostPetIds.slice(b, b + BATCH_SIZE);
      await db.update(pets).set({ status: "lost" }).where(inArray(pets.id, batch));
    }

    // status='deceased' + deceasedAt — backed by the death_recorded event above.
    for (const { petId, deceasedAt } of deceasedPetIds) {
      await db.update(pets).set({ status: "deceased", deceasedAt }).where(eq(pets.id, petId));
    }

    // Seed provenance (migration 0160). registerPet has no input for it — it is
    // an infrastructure marker, not a fact about the animal — so the seed
    // stamps its own rows after the fact.
    const provinceTokens = perPetMeta.map((m) => panoPublicToken(m.index));
    for (let b = 0; b < provinceTokens.length; b += BATCH_SIZE) {
      const batch = provinceTokens.slice(b, b + BATCH_SIZE);
      await db
        .update(pets)
        .set({ seedTag: SEED_TAG_PANORAMA })
        .where(inArray(pets.publicToken, batch));
    }

    // Batch insert events
    for (let b = 0; b < eventRows.length; b += BATCH_SIZE) {
      const batch = eventRows.slice(b, b + BATCH_SIZE);
      await db.insert(petEvents).values(
        batch as Parameters<typeof db.insert<typeof petEvents>>[0] extends {
          values: (v: infer V) => unknown;
        }
          ? V
          : never,
      );
    }

    totalPets += provinceCount;
    globalIndex += provinceCount;
  }

  return { totalPets, lostPets, deceasedPets, eventCounts, globalIndex };
}

// ---------------------------------------------------------------------------
// 14. Set-pieces: rabies cluster (NOA), La Plata zoonosis cluster, k-anon localities
// ---------------------------------------------------------------------------

async function seedSetPieces(
  localitiesByCode: Map<string, LocalityRow[]>,
  ownerUserId: string,
  globalIndexStart: number,
): Promise<{ globalIndex: number; eventCounts: Record<string, number> }> {
  log("STEP", "Seeding set-pieces (clusters + k-anon localities)…");

  const eventCounts: Record<string, number> = {};
  let gIdx = globalIndexStart;

  // Helper to insert a single set-piece pet + ownership + events
  async function insertSetPiecePet(
    provinceName: string,
    localityName: string,
    lat: number,
    lng: number,
    extraEvents: Array<Record<string, unknown>>,
    status: "active" | "lost" | "deceased" = "active",
  ): Promise<string> {
    const index = gIdx;
    const petName = panoName(gIdx, pick(PET_NAMES));
    gIdx++;

    // Set-piece pets go through the SAME real intake circuit as the bulk ones —
    // registerPet emits their pets row, owner ownership and pet_registered
    // event. Only the status cache (these set-pieces stage lost/deceased
    // scenarios) is applied afterwards, backed by the extraEvents the caller
    // supplies.
    const registered = await registerSeedPet(
      {
        index,
        name: petName,
        species: "dog",
        sex: "unknown",
        provinceName,
        localityName,
        dangerousBreed: false,
        acquisitionMethod: "other",
        registeredAt: randomWindowDate(WINDOW_DAYS + 180),
        seedTag: SEED_TAG_PANORAMA,
      },
      ownerUserId,
    );
    if (!registered) throw new Error(`set-piece registration failed at index ${index}`);
    const petRow = { id: registered.petId };

    if (status !== "active") {
      await db
        .update(pets)
        .set({
          status,
          ...(status === "deceased" ? { deceasedAt: randomWindowDate(30) } : {}),
        })
        .where(eq(pets.id, petRow.id));
    }
    await db.update(pets).set({ seedTag: SEED_TAG_PANORAMA }).where(eq(pets.id, petRow.id));

    // Post-registration events (pet_registered already emitted by registerPet).
    const baseEvts: Array<Record<string, unknown>> = [
      ...extraEvents.map((e) => ({ ...e, petId: petRow.id })),
    ];

    if (baseEvts.length > 0) {
      await db.insert(petEvents).values(
        baseEvts as Parameters<typeof db.insert<typeof petEvents>>[0] extends {
          values: (v: infer V) => unknown;
        }
          ? V
          : never,
      );
    }

    for (const e of baseEvts) {
      const t = e.eventType as string;
      eventCounts[t] = (eventCounts[t] ?? 0) + 1;
    }

    return petRow.id;
  }

  // --- 14a. Rabies cluster: Salta — 4 bite events + 2 deaths within 12 days ---
  {
    const code = PROVINCE_TO_CODE.get("Salta");
    const locs = code ? (localitiesByCode.get(code) ?? []) : [];
    const saltaLoc = locs.find((l) => l.localityName.toLowerCase() === "salta") ?? locs[0];
    const baseLat = saltaLoc?.lat ?? -24.78;
    const baseLng = saltaLoc?.lng ?? -65.41;
    const clusterStart = ANCHOR_MS - 14 * 24 * 3600 * 1000; // 14 days ago

    log("INFO", "  Set-piece: rabies cluster (Salta)");

    for (let k = 0; k < 6; k++) {
      const dayOffset = k * 2; // spread over 12 days
      const occurredAt = new Date(clusterStart + dayOffset * 24 * 3600 * 1000);
      const isDeath = k >= 4;

      const extraEvents: Array<Record<string, unknown>> = [
        {
          eventType: "incident_reported" satisfies EventType,
          occurredAt,
          recordedByUserId: ownerUserId,
          authorRole: "vet",
          authorVerified: true,
          payload: {
            source: "seed-panorama-setpiece",
            incident_type: "bite_inflicted",
            severity: isDeath ? "severe" : "moderate",
            injuries_summary: `Mordedura NOA set-piece #${k + 1}`,
            vet_involved: true,
            location_description: "Salta capital",
            rabies_vaccine_valid_at_incident: false,
          },
          ...writePoint(jitteredCoord(baseLat, baseLng, 0.005)),
        },
        {
          // D2: /gob/vigilancia counts pet_events.eventType='outbreak_signal'
          // (scoped via payload jurisdiction). Without these the surveillance
          // surface read 0 signals despite the bite cluster. Emit one per pet so
          // the Salta rabies cluster is visible + queryable.
          eventType: "outbreak_signal" satisfies EventType,
          occurredAt,
          recordedByUserId: ownerUserId,
          authorRole: "govt",
          authorVerified: true,
          payload: {
            source: "seed-panorama-setpiece",
            disease_code: isDeath ? "rabies_confirmed" : "rabies_suspected",
            disease_label: isDeath ? "Rabia (confirmada)" : "Rabia (sospechada)",
            pet_jurisdiction_province: "Salta",
            pet_jurisdiction_locality: saltaLoc?.localityName ?? "Salta",
            status: "open",
          },
          ...writePoint(jitteredCoord(baseLat, baseLng, 0.005)),
        },
      ];

      if (isDeath) {
        extraEvents.push({
          eventType: "death_recorded" satisfies EventType,
          occurredAt: new Date(occurredAt.getTime() + 2 * 24 * 3600 * 1000),
          recordedByUserId: ownerUserId,
          authorRole: "vet",
          authorVerified: true,
          payload: {
            source: "seed-panorama-setpiece",
            cause: "disease",
            cause_detail: "sospecha de rabia — cluster NOA",
            confirmed_by_vet: true,
            vet_name: null,
            // "cremation" (pre-fix) was NOT a deathRecorded enum member — the
            // raw insert bypasses validation, and dashboards rendered it as
            // unrecognized/other. Guarded by seed-disposition-methods.test.ts.
            disposition_method: "cremation_collective",
            facility: "Crematorio Veterinario Salta",
            death_at_clinic: true,
            vet_contacted_owner: "yes",
            vet_decided_alone: null,
            is_reportable: true,
            during_rabies_observation: true,
          },
        });
      }

      await insertSetPiecePet(
        "Salta",
        saltaLoc?.localityName ?? "Salta",
        baseLat,
        baseLng,
        extraEvents,
        isDeath ? "deceased" : "active",
      );
    }

    // Set-piece #7 — the non-compliant disposal beat (surveillance-disposal
    // slice, S5): bite → observation → death DURING observation, owner chose
    // a home burial despite the warning. Full spine (incident + observation
    // started/ended + death) with explicit event ids so the events reference
    // each other the way the real death cascade writes them. This is the
    // pre-loaded fallback for the demo: /admin/observaciones shows the row
    // with its danger disposal chip without needing a live run-through.
    {
      const biteAt = new Date(clusterStart + 13 * 24 * 3600 * 1000);
      const observationUntil = new Date(biteAt.getTime() + 10 * 24 * 3600 * 1000);
      const diedAt = new Date(biteAt.getTime() + 6 * 24 * 3600 * 1000);
      const biteEventId = randomUUID();
      const startedEventId = randomUUID();
      const deathEventId = randomUUID();

      const nonCompliantPetId = await insertSetPiecePet(
        "Salta",
        saltaLoc?.localityName ?? "Salta",
        baseLat,
        baseLng,
        [
          {
            id: biteEventId,
            eventType: "incident_reported" satisfies EventType,
            occurredAt: biteAt,
            recordedByUserId: ownerUserId,
            authorRole: "vet",
            authorVerified: true,
            payload: {
              source: "seed-panorama-setpiece",
              incident_type: "bite_inflicted",
              severity: "severe",
              injuries_summary: "Mordedura NOA set-piece #7 — disposición no recomendada",
              vet_involved: true,
              location_description: "Salta capital",
              rabies_vaccine_valid_at_incident: false,
            },
            ...writePoint(jitteredCoord(baseLat, baseLng, 0.005)),
          },
          {
            id: startedEventId,
            eventType: "rabies_observation_started" satisfies EventType,
            occurredAt: biteAt,
            recordedByUserId: ownerUserId,
            authorRole: "govt",
            authorVerified: true,
            payload: {
              source: "seed-panorama-setpiece",
              bite_event_id: biteEventId,
              observation_until: observationUntil.toISOString().slice(0, 10),
              location: "in_situ",
              official_site_organization_id: null,
            },
          },
          {
            id: deathEventId,
            eventType: "death_recorded" satisfies EventType,
            occurredAt: diedAt,
            recordedByUserId: ownerUserId,
            authorRole: "owner",
            authorVerified: false,
            payload: {
              source: "seed-panorama-setpiece",
              cause: "disease",
              cause_detail: "sospecha de rabia — cluster NOA",
              confirmed_by_vet: null,
              vet_name: null,
              disposition_method: "owner_burial",
              facility: "patio del domicilio",
              death_at_clinic: null,
              clinic_name: null,
              vet_contacted_owner: null,
              vet_decided_alone: null,
              owner_to_private_crematorium: null,
              disease_code: null,
              confirmed_by_lab: null,
              is_reportable: false,
              during_rabies_observation: true,
            },
          },
          {
            eventType: "rabies_observation_ended" satisfies EventType,
            occurredAt: diedAt,
            recordedByUserId: null,
            authorRole: "system",
            authorVerified: false,
            payload: {
              source: "seed-panorama-setpiece",
              bite_event_id: biteEventId,
              observation_started_event_id: startedEventId,
              outcome: "dead",
              closed_by_role: "system",
              closure_notes: "Cierre automático por fallecimiento durante observación",
              death_event_id: deathEventId,
            },
          },
        ],
        "deceased",
      );

      // Cache mirror of the spine above — what updateRabiesObservationStatus
      // sets in the real cascade. The events carry the facts; this only makes
      // the pets projection agree with them.
      await db
        .update(pets)
        .set({ rabiesObservationStatus: "completed_dead" })
        .where(eq(pets.id, nonCompliantPetId));
    }
  }

  // --- 14b. La Plata zoonosis cluster — 3 disease_reported events ---
  {
    const code = PROVINCE_TO_CODE.get("Buenos Aires");
    const locs = code ? (localitiesByCode.get(code) ?? []) : [];
    const laPlataLoc = locs.find((l) => l.localityName.toLowerCase() === "la plata") ?? locs[0];
    const baseLat = laPlataLoc?.lat ?? -34.92;
    const baseLng = laPlataLoc?.lng ?? -57.95;

    log("INFO", "  Set-piece: La Plata zoonosis cluster");

    for (let k = 0; k < 3; k++) {
      const occurredAt = randomWindowDate(21);
      await insertSetPiecePet(
        "Buenos Aires",
        laPlataLoc?.localityName ?? "La Plata",
        baseLat,
        baseLng,
        [
          {
            eventType: "disease_reported" satisfies EventType,
            occurredAt,
            recordedByUserId: ownerUserId,
            authorRole: "vet",
            authorVerified: true,
            payload: {
              source: "seed-panorama-setpiece",
              disease: pick(["lepto", "hidatidosis", "other"]),
              confirmed_by_lab: k === 0,
              date_of_onset: new Date(occurredAt.getTime() - 3 * 24 * 3600 * 1000)
                .toISOString()
                .slice(0, 10),
              clinical_notes: `Zoonosis cluster La Plata #${k + 1} (seed-panorama)`,
            },
            ...writePoint(jitteredCoord(baseLat, baseLng, 0.01)),
          },
        ],
      );
    }
  }

  // --- 14c. AMBA lost hotspot — 8 additional lost pets in conurbano sur ---
  {
    const code = PROVINCE_TO_CODE.get("Buenos Aires");
    const locs = code ? (localitiesByCode.get(code) ?? []) : [];
    const hotspotLocalities = ["Quilmes", "Lanús", "Lomas de Zamora"];

    log("INFO", "  Set-piece: AMBA lost hotspot (conurbano sur)");

    for (let k = 0; k < 8; k++) {
      const locality = hotspotLocalities[k % hotspotLocalities.length];
      const loc =
        locs.find((l) => l.localityName.toLowerCase() === locality.toLowerCase()) ?? locs[0];
      const baseLat = loc?.lat ?? -34.72;
      const baseLng = loc?.lng ?? -58.26;

      await insertSetPiecePet(
        "Buenos Aires",
        loc?.localityName ?? "Quilmes",
        baseLat,
        baseLng,
        [
          {
            eventType: "status_changed" satisfies EventType,
            occurredAt: randomWindowDate(14),
            recordedByUserId: ownerUserId,
            authorRole: "owner",
            authorVerified: false,
            payload: {
              source: "seed-panorama-setpiece",
              from_status: "active",
              to_status: "lost",
              location_description: `${locality}, zona sur del conurbano bonaerense`,
            },
            ...writePoint(jitteredCoord(baseLat, baseLng, 0.02)),
          },
        ],
        "lost",
      );
    }
  }

  // --- 14d. Small localities (<5 pets) for k-anon suppression demo ---
  {
    const smallLocalities: Array<{ province: string; locality: string; lat: number; lng: number }> =
      [
        { province: "Tierra del Fuego", locality: "Tolhuin", lat: -54.5, lng: -67.19 },
        { province: "Santa Cruz", locality: "Caleta Olivia", lat: -46.44, lng: -67.52 },
        { province: "La Pampa", locality: "General Pico", lat: -35.66, lng: -63.75 },
        { province: "Catamarca", locality: "Andalgalá", lat: -27.59, lng: -66.3 },
      ];

    log("INFO", "  Set-piece: small localities for k-anon suppression");

    for (const sl of smallLocalities) {
      // Insert exactly 2-3 pets in each to land below k-anon threshold
      const count = randInt(2, 3);
      for (let k = 0; k < count; k++) {
        await insertSetPiecePet(sl.province, sl.locality, sl.lat, sl.lng, []);
      }
    }
  }

  return { globalIndex: gIdx, eventCounts };
}

// ---------------------------------------------------------------------------
// 15. Seed bite / incident events on random existing PANO pets
// ---------------------------------------------------------------------------

async function seedBiteEvents(
  ownerUserId: string,
  census: CensusRow[],
  localitiesByCode: Map<string, LocalityRow[]>,
  biteCount: number,
): Promise<number> {
  log("STEP", `Seeding ~${biteCount} additional bite/incident events…`);

  // Fetch a sample of PANO pet IDs to attach bite events to
  const sample = await db
    .select({ id: petEvents.petId, petId: petEvents.petId })
    .from(petEvents)
    .where(
      sql`${petEvents.eventType} = 'pet_registered' AND ${petEvents.payload}->>'source' = 'seed-panorama'`,
    )
    .limit(biteCount * 3);

  if (sample.length === 0) {
    log("WARN", "  No PANO pet_registered events found — skipping bite events");
    return 0;
  }

  const eventRows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < biteCount; i++) {
    // Pick a random pet from sample (weighted by population — approximate via index)
    const petRow = sample[Math.floor(rng() * sample.length)];
    const petId = petRow.id;

    // Pick a province weighted by population for geo
    const totalPop = census.reduce((s, c) => s + c.population, 0);
    let popR = rng() * totalPop;
    let prov = census[census.length - 1];
    for (const c of census) {
      popR -= c.population;
      if (popR <= 0) {
        prov = c;
        break;
      }
    }
    const loc = pickLocality(prov.provinceName, localitiesByCode);
    const { lat, lng } = loc
      ? jitteredCoord(loc.lat, loc.lng, 0.03)
      : { lat: -34.6 + gaussianJitter(2), lng: -58.4 + gaussianJitter(4) };

    eventRows.push({
      petId,
      eventType: "incident_reported" satisfies EventType,
      occurredAt: randomWindowDate(),
      recordedByUserId: ownerUserId,
      authorRole: "vet",
      authorVerified: false,
      payload: {
        source: "seed-panorama-bites",
        incident_type: "bite_inflicted",
        severity: pick(["minor", "moderate", "severe"] as const),
        injuries_summary: `Mordedura sintética #${i + 1} (seed-panorama)`,
        vet_involved: rng() < 0.6,
        location_description: `${loc?.localityName ?? prov.provinceName}`,
        rabies_vaccine_valid_at_incident: rng() < 0.5,
      },
      ...writePoint({ lat, lng }),
    });
  }

  for (let b = 0; b < eventRows.length; b += BATCH_SIZE) {
    const batch = eventRows.slice(b, b + BATCH_SIZE);
    await db.insert(petEvents).values(
      batch as Parameters<typeof db.insert<typeof petEvents>>[0] extends {
        values: (v: infer V) => unknown;
      }
        ? V
        : never,
    );
  }

  return eventRows.length;
}

// ---------------------------------------------------------------------------
// 15b. Vigilancia chain — rabies-observation lifecycle + ENO notification SLA
// ---------------------------------------------------------------------------
// Materializes the surveillance surface that bite EVENTS alone never light:
//   - rabies_observation_started / _ended pet_events (paired via
//     payload.observation_started_event_id) + pets.rabies_observation_status
//     in mixed states (in_progress / closed within 10d / overdue) → A8/A9
//     compliance + the "X rabia" KPI.
//   - open cases case_kind='rabies_observation' → fetchVigilanciaMetrics
//     rabiesActiveCount + the /gob/vigilancia map.
//   - eno_processing_queue rows (the worker queue) + event_notification_outbox
//     rows target_kind='eno_authority' (what fetchEnoSla A7 actually reads),
//     with mixed SLA (on-time delivered / overdue pending breach).
//
// NOTE (v2 fidelity): inserting these derived records directly is acceptable
// for the demo dataset. Running the real bite→observation use-case
// (reportBiteAction + the daily cron + eno-trigger) would be more faithful —
// it would also exercise the projection in lib/projections/pet-rabies-observation.ts.
async function seedVigilanceChain(
  ownerUserId: string,
  shelterOrgs: PanoOrg[],
): Promise<{ observations: number; cases: number; enoQueue: number; outbox: number }> {
  log("STEP", "Seeding vigilancia chain (rabies observations + ENO SLA)…");

  // Attach observations to a mix: the Salta rabies set-piece pets (the bite
  // cluster) + a thin national baseline of PANO pets. Fetch deceased/reportable
  // set-piece pets first, then top up with random PANO pets.
  const setpiecePets = await db
    .select({ petId: petEvents.petId })
    .from(petEvents)
    .where(
      sql`${petEvents.eventType} = 'incident_reported'
          AND ${petEvents.payload}->>'source' = 'seed-panorama-setpiece'
          AND ${petEvents.payload}->>'incident_type' = 'bite_inflicted'`,
    )
    .limit(20);

  const baselinePets = await db
    .select({ petId: petEvents.petId, province: pets.jurisdictionProvince })
    .from(petEvents)
    .innerJoin(pets, sql`${pets.id} = ${petEvents.petId}`)
    .where(
      sql`${petEvents.eventType} = 'pet_registered' AND ${petEvents.payload}->>'source' = 'seed-panorama'`,
    )
    .limit(30);

  // Dedup pet ids; cap the chain at a demo-friendly size.
  const seen = new Set<string>();
  const targets: Array<{ petId: string; province: string | null }> = [];
  for (const r of setpiecePets) {
    if (!seen.has(r.petId)) {
      seen.add(r.petId);
      targets.push({ petId: r.petId, province: "Salta" });
    }
  }
  for (const r of baselinePets) {
    if (targets.length >= 24) break;
    if (!seen.has(r.petId)) {
      seen.add(r.petId);
      targets.push({ petId: r.petId, province: r.province });
    }
  }

  if (targets.length === 0) {
    log("WARN", "  No PANO pets found for vigilancia chain — skipping");
    return { observations: 0, cases: 0, enoQueue: 0, outbox: 0 };
  }

  const sanitaryOrg = shelterOrgs.find((o) => o.provinceName === "Chaco") ?? shelterOrgs[0] ?? null;

  let observations = 0;
  let caseCount = 0;
  let enoQueueCount = 0;
  let outboxCount = 0;

  // Each target gets one observation in a deterministic mixed state:
  //   0 → in_progress (recent)         → "X rabia" KPI + open case
  //   1 → closed within 10 days        → A8 compliant
  //   2 → overdue open (started > 10d)  → A9 live breach
  //   3 → closed past 10 days          → A8 non-compliant
  for (let t = 0; t < targets.length; t++) {
    const { petId, province } = targets[t];
    const bucket = t % 4;

    // Start date: overdue/closed-late buckets start well before the 10d window.
    const startDaysBack = bucket === 2 || bucket === 3 ? randInt(13, 25) : randInt(2, 8);
    const startedAt = new Date(ANCHOR_MS - startDaysBack * 24 * 3600 * 1000);

    const [startedEvent] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "rabies_observation_started" satisfies EventType,
        occurredAt: startedAt,
        recordedByUserId: ownerUserId,
        authorRole: "vet",
        authorVerified: true,
        ...(sanitaryOrg ? { authorOrganizationId: sanitaryOrg.id } : {}),
        payload: {
          source: "seed-panorama-vigilancia",
          incident_type: "bite_inflicted",
          observation_days: 10,
        },
      } as Parameters<typeof db.insert<typeof petEvents>>[0] extends {
        values: (v: infer V) => unknown;
      }
        ? V
        : never)
      .returning({ id: petEvents.id });

    observations++;

    let rabiesStatus: string;
    if (bucket === 1 || bucket === 3) {
      // Closed: emit a paired ended event. Bucket 1 closes within 10d,
      // bucket 3 closes after 10d (compliance non-compliant).
      const elapsedDays = bucket === 1 ? randInt(6, 10) : randInt(12, 16);
      const endedAt = new Date(startedAt.getTime() + elapsedDays * 24 * 3600 * 1000);
      await db.insert(petEvents).values({
        petId,
        eventType: "rabies_observation_ended" satisfies EventType,
        occurredAt: endedAt,
        recordedByUserId: ownerUserId,
        authorRole: "vet",
        authorVerified: true,
        ...(sanitaryOrg ? { authorOrganizationId: sanitaryOrg.id } : {}),
        payload: {
          source: "seed-panorama-vigilancia",
          observation_started_event_id: startedEvent.id,
          outcome: "negative",
        },
      } as Parameters<typeof db.insert<typeof petEvents>>[0] extends {
        values: (v: infer V) => unknown;
      }
        ? V
        : never);
      rabiesStatus = "completed_negative";
    } else {
      // Open: in_progress (bucket 0 recent, bucket 2 overdue breach).
      rabiesStatus = "in_progress";
    }

    // Dual-write the denormalized status column on the pet (mirrors the cron).
    await db.execute(
      sql`UPDATE pets SET rabies_observation_status = ${rabiesStatus} WHERE id = ${petId}`,
    );

    // Open a case for in_progress observations so rabiesActiveCount + the map
    // light up.
    //
    // The kind is 'bite_incident' — NOT the invented 'rabies_observation' this
    // used to write. A rabies observation's expediente IS the bite_incident
    // case: bite-incident.ts declares `terminalEvents: ["rabies_observation_
    // ended"]` and `cronCloseRoute: "/api/cron/close-rabies-observations"`, and
    // all three closers (owner-close, professional-close, the cron) resolve
    // their case through `findOpenBiteCase`, hardcoded to case_kind=
    // 'bite_incident'. Seeding any other kind produced a case NOTHING could
    // ever close: measured on staging 2026-08-01, 12 'rabies_observation' rows
    // stuck open against 1 pet actually under observation, each one already
    // carrying its cron-written `rabies_observation_ended` event. `case_kind`
    // is unconstrained text in the DB, so only __tests__/seed-case-kinds.test.ts
    // stops that from happening again.
    //
    // Guarded against `cases_open_per_pet_kind_idx` (one open case per pet per
    // kind): a pet that already has an open bite_incident — from the setpiece
    // bite chain or a previous run — is skipped rather than crashing the seed.
    if (
      rabiesStatus === "in_progress" &&
      (await findOpenCasesOfKind(petId, "bite_incident")).length === 0
    ) {
      const prov = province ?? "Salta";
      await db.insert(cases).values({
        publicCode: `PANO-CASE-RABOBS-${String(t).padStart(4, "0")}`,
        caseKind: "bite_incident",
        status: "open",
        primarySubjectKind: "registered_pet",
        primaryPetId: petId,
        jurisdictionCountry: "AR",
        jurisdictionProvince: prov,
        // No "(seed-panorama)" tag: opened_reason is a USER-FACING field. The
        // tag rode through the generic `auto:` branch straight onto the operator's
        // screen. Same class as the lost-case reason fixed in daf2c26b.
        openedReason: "auto: observación rábica de 10 días",
        openedAt: startedAt,
      } as Parameters<typeof db.insert<typeof cases>>[0] extends {
        values: (v: infer V) => unknown;
      }
        ? V
        : never);
      caseCount++;
    }

    // ENO pipeline: enqueue a processing-queue row (the worker queue) AND an
    // event_notification_outbox row (target_kind='eno_authority' — what A7
    // reads). Mixed SLA: even buckets delivered on-time, odd buckets are an
    // overdue pending breach.
    const onTime = t % 2 === 0;
    const createdAt = new Date(ANCHOR_MS - randInt(1, 20) * 24 * 3600 * 1000);
    const slaHours = 48;
    const slaDueAt = new Date(createdAt.getTime() + slaHours * 3600 * 1000);

    await db.insert(enoProcessingQueue).values({
      petEventId: startedEvent.id,
      status: onTime ? "processed" : "pending",
      queuedAt: createdAt,
      ...(onTime ? { processedAt: new Date(createdAt.getTime() + 6 * 3600 * 1000) } : {}),
      retryCount: onTime ? 0 : 1,
    } as Parameters<typeof db.insert<typeof enoProcessingQueue>>[0] extends {
      values: (v: infer V) => unknown;
    }
      ? V
      : never);
    enoQueueCount++;

    await db.insert(eventNotificationOutbox).values({
      sourceEventId: startedEvent.id,
      targetKind: "eno_authority",
      targetJurisdictionProvince: province ?? "Salta",
      targetJurisdictionLocality: province === "Salta" || !province ? "Salta" : null,
      payloadSnapshot: { source: "seed-panorama-vigilancia" },
      slaDueAt,
      // onTime → delivered before the deadline; breach → still pending past it.
      status: onTime ? "delivered" : "pending",
      // attempts: the drainer only ever marks delivered WITH attempts+1
      // (app/api/cron/drain-outbox). A delivered row with the schema-default 0
      // renders "ENTREGADO / Sin intentos" — a state production cannot produce.
      ...(onTime
        ? {
            deliveredAt: new Date(createdAt.getTime() + (slaHours - 6) * 3600 * 1000),
            attempts: 1,
          }
        : {}),
      createdAt,
    } as Parameters<typeof db.insert<typeof eventNotificationOutbox>>[0] extends {
      values: (v: infer V) => unknown;
    }
      ? V
      : never);
    outboxCount++;
  }

  log(
    "INFO",
    `  Vigilancia chain: ${observations} observations, ${caseCount} rabies cases, ${enoQueueCount} ENO-queue, ${outboxCount} outbox`,
  );
  return {
    observations,
    cases: caseCount,
    enoQueue: enoQueueCount,
    outbox: outboxCount,
  };
}

// ---------------------------------------------------------------------------
// 15b. Lost-pet episodes — CAS-XXXX-XXXX cases for /gob/perdidas
// ---------------------------------------------------------------------------
// Pets with status='lost' must have an open lost_pet_episode case so
// fetchLostEpisodeCaseCodesForPets can link CAS codes in the perdidas table.
// Mirrors seed-owner-demo.ts seedLostPet and seed-perf volume path.
async function seedLostPetEpisodeCases(
  fallbackOwnerUserId: string,
): Promise<{ created: number; skipped: number }> {
  log("STEP", "Backfilling lost_pet_episode cases (CAS- codes) for status=lost pets…");

  const lostRows = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
    })
    .from(pets)
    .where(eq(pets.status, "lost"));

  if (lostRows.length === 0) {
    log("SKIP", "  no pets with status=lost");
    return { created: 0, skipped: 0 };
  }

  let created = 0;
  let skipped = 0;

  for (const pet of lostRows) {
    const [existingCase] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(
        and(
          eq(cases.primaryPetId, pet.id),
          eq(cases.caseKind, "lost_pet_episode"),
          sql`${cases.status} IN ('open', 'escalated')`,
        ),
      )
      .limit(1);

    if (existingCase) {
      skipped++;
      continue;
    }

    const [ownership] = await db
      .select({ ownerUserId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(eq(ownerships.petId, pet.id), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
      )
      .limit(1);

    let casePublicCode: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generatePrefixedToken("CAS");
      const [existingCode] = await db
        .select({ id: cases.id })
        .from(cases)
        .where(eq(cases.publicCode, candidate))
        .limit(1);
      if (!existingCode) {
        casePublicCode = candidate;
        break;
      }
    }

    if (!casePublicCode) {
      log("WARN", `  could not allocate CAS code for ${pet.publicToken} — skipping`);
      continue;
    }

    await db.insert(cases).values({
      publicCode: casePublicCode,
      caseKind: "lost_pet_episode",
      status: "open",
      primarySubjectKind: "registered_pet",
      primaryPetId: pet.id,
      jurisdictionCountry: "AR",
      jurisdictionProvince: pet.jurisdictionProvince ?? "Buenos Aires",
      jurisdictionLocality: pet.jurisdictionLocality,
      openedByUserId: ownership?.ownerUserId ?? fallbackOwnerUserId,
      // Visible "Motivo de apertura" — plain es-AR, no English and no seed tag
      // leaking into a user-facing field (Cowork B4). Idempotency is keyed on
      // primaryPetId + caseKind above, not on this reason, so it is safe to drop
      // the "seed-panorama" marker here.
      openedReason: "Mascota reportada como perdida por su responsable",
    });

    created++;
  }

  log("INFO", `  lost_pet_episode cases: +${created} created, ${skipped} already had open case`);
  return { created, skipped };
}

// ---------------------------------------------------------------------------
// 15c. Enforcement — decomiso (Ley 14.346) + custody-dispute cases
// ---------------------------------------------------------------------------
// The Panorama decomisos/disputas layers + drawer and /gob/analytics
// (custodyDisputes) read the `cases` table. There is no `decomiso` case_kind:
// app/actions/decomiso.ts materializes a decomiso as a `custody_episode` case
// with notes 'from_decomiso=true'. Disputes are case_kind='custody_dispute'
// (fetchAnalyticsMetrics counts the open ones).
//
// IMPORTANT: registered_pet cases must NOT set location_lat/lng — the
// cases_subject_location_consistency CHECK is a biconditional
// (primary_subject_kind='location') = (lat/lng NOT NULL). The Panorama
// decomisos/disputas layers + the /gob/vigilancia map read the case's
// jurisdiction (fetchCasesPerLocality groups by province/locality), not these
// coordinate columns, so location is correctly derived from the pet.
async function seedEnforcementCases(): Promise<{ decomisos: number; disputes: number }> {
  log("STEP", "Seeding enforcement cases (decomisos + custody disputes)…");

  // Attach to existing PANO pets (primary_pet_id ON DELETE CASCADE → auto-clean)
  // so the cases_subject_pet_consistency CHECK holds for registered_pet.
  //
  // Both pools are drawn through selectPetsWithoutOpenCase: token-ordered (an
  // unordered LIMIT returns physical heap order, which shifts under the seed's
  // own UPDATEs on pets) and NOT EXISTS-guarded against an already-open case of
  // the kind about to be opened, so `cases_open_per_pet_kind_idx` cannot fire.
  const decomisoPool = await selectPetsWithoutOpenCase({
    tokenPrefix: PANO_TAG,
    caseKind: "custody_episode",
    limit: 40,
  });
  const decomisoTargets = decomisoPool.slice(0, 6);
  const decomisoIds = new Set(decomisoTargets.map((p) => p.id));

  // custody_episode and custody_dispute are DIFFERENT kinds, so the index would
  // tolerate both open on one pet — the disjointness below is a realism choice
  // (a seizure and a custody fight are separate stories), not a constraint.
  const disputePool = await selectPetsWithoutOpenCase({
    tokenPrefix: PANO_TAG,
    caseKind: "custody_dispute",
    limit: 40,
  });
  const disputeTargets = disputePool.filter((p) => !decomisoIds.has(p.id)).slice(0, 5);

  if (decomisoTargets.length === 0 && disputeTargets.length === 0) {
    log("WARN", "  No eligible PANO pets found for enforcement cases — skipping");
    return { decomisos: 0, disputes: 0 };
  }
  if (decomisoTargets.length < 6 || disputeTargets.length < 5) {
    log(
      "WARN",
      `  Enforcement pool short: ${decomisoTargets.length}/6 decomiso pets, ` +
        `${disputeTargets.length}/5 dispute pets without an open case of that kind`,
    );
  }

  const SEIZURE_MOTIVES = ["maltrato", "abandono", "tenencia_ilegal", "orden_judicial"] as const;

  let decomisos = 0;
  let disputes = 0;

  // 6 decomisos (custody_episode, from_decomiso=true) spread across provinces.
  for (let k = 0; k < decomisoTargets.length; k++) {
    const pet = decomisoTargets[k];
    const prov = pet.province ?? "Buenos Aires";
    const motive = pick(SEIZURE_MOTIVES);
    await db.insert(cases).values({
      publicCode: `PANO-CASE-DECOMISO-${String(k).padStart(4, "0")}`,
      caseKind: "custody_episode",
      status: "open",
      primarySubjectKind: "registered_pet",
      primaryPetId: pet.id,
      jurisdictionCountry: "AR",
      jurisdictionProvince: prov,
      jurisdictionLocality: pet.locality,
      // Must match the decomiso writer's grammar EXACTLY — the display layer
      // recognizes `auto: decomiso motivo=(\S+) judicial_ref=(...)` and the
      // "(Ley 14.346)" this used to insert broke the `\S+`, so the row fell to
      // the generic `auto:` catch-all and rendered on the demo panorama as
      // "Apertura automática — decomiso motivo=maltrato_fisico (Ley 14.346)
      // judicial_ref=sin_ref": a raw enum and an internal grammar, on the
      // surface funcionarios are shown. The law reference belongs in the UI's
      // normativa block (which cites Ley 14.346 already), not smuggled into an
      // audit string that a parser has to survive.
      openedReason: `auto: decomiso motivo=${motive} judicial_ref=sin_ref`,
      openedAt: randomWindowDate(WINDOW_DAYS),
    } as Parameters<typeof db.insert<typeof cases>>[0] extends {
      values: (v: infer V) => unknown;
    }
      ? V
      : never);
    decomisos++;
  }

  // 5 custody disputes (open). A real dispute is created in lockstep with its
  // case (ARCH-E, app/actions/custody-disputes.ts): the case row, a
  // custody_dispute_raised pet_event, and the custody_disputes row the case
  // links back to via custody_dispute_id. /gob/analytics counts the open
  // `cases`; /gob/disputas lists the `custody_disputes` table — seeding only the
  // case half left the disputas list empty for everyone while analytics showed 5.
  for (let k = 0; k < disputeTargets.length; k++) {
    const pet = disputeTargets[k];
    const prov = pet.province ?? "Buenos Aires";
    // custody_disputes.jurisdiction_locality is NOT NULL; coalesce so a pet
    // without a locality still yields a valid dispute row.
    const locality = pet.locality ?? "Sin especificar";
    const raisedAt = randomWindowDate(WINDOW_DAYS);

    const [disputeCase] = await db
      .insert(cases)
      .values({
        publicCode: `PANO-CASE-DISPUTE-${String(k).padStart(4, "0")}`,
        caseKind: "custody_dispute",
        status: "open",
        primarySubjectKind: "registered_pet",
        primaryPetId: pet.id,
        jurisdictionCountry: "AR",
        jurisdictionProvince: prov,
        jurisdictionLocality: locality,
        openedReason: "auto: disputa de custodia entre partes",
        openedAt: raisedAt,
      } as Parameters<typeof db.insert<typeof cases>>[0] extends {
        values: (v: infer V) => unknown;
      }
        ? V
        : never)
      .returning({ id: cases.id });

    // Raising event — custody_disputes.raising_event_id is NOT NULL and FKs to
    // pet_events (ON DELETE CASCADE, so it cleans up with the pet).
    const [raisingEvent] = await db
      .insert(petEvents)
      .values({
        petId: pet.id,
        eventType: "custody_dispute_raised" satisfies EventType,
        occurredAt: raisedAt,
        authorRole: "govt",
        payload: { source: "seed-panorama-enforcement", motive: "disputa de custodia" },
      })
      .returning({ id: petEvents.id });

    const [dispute] = await db
      .insert(custodyDisputes)
      .values({
        publicToken: `DIS-PANO-${String(k).padStart(4, "0")}`,
        petId: pet.id,
        raisedByRole: "govt",
        raisingEventId: raisingEvent.id,
        jurisdictionCountry: "AR",
        jurisdictionProvince: prov,
        jurisdictionLocality: locality,
        status: "open",
      })
      .returning({ id: custodyDisputes.id });

    // Link the case to its dispute (the production lockstep invariant) and flip
    // the pet's in_custody_dispute flag, mirroring openDisputeFromEvent.
    await db
      .update(cases)
      .set({ custodyDisputeId: dispute.id, updatedAt: new Date() })
      .where(eq(cases.id, disputeCase.id));
    await db.update(pets).set({ inCustodyDispute: true }).where(eq(pets.id, pet.id));

    disputes++;
  }

  log("INFO", `  Enforcement: ${decomisos} decomisos, ${disputes} custody disputes`);
  return { decomisos, disputes };
}

// ---------------------------------------------------------------------------
// 15d. Health campaigns — service_offerings + time_slots + appointments
// ---------------------------------------------------------------------------
// Backs /gob/campanas (lib/campaign-metrics.ts → fetchCampaignDashboard). A
// "campaign" is a health-service offering (vacunación / desparasitación /
// esterilización) hosted by a seeded org. The projection aggregates:
//   enrollment  = appointments in {confirmed, attended, no_show}     (period)
//   completion  = appointments status='attended'
//   no_show     = appointments status='no_show'
//   geo_reach   = distinct service_offerings.jurisdiction_locality with ≥1
//                 attended appointment
// The hasData gate is simply offerings-in-scope > 0, but we book a mixed-outcome
// distribution so every KPI populates with non-trivial, varied-by-jurisdiction
// values. Dates are ANCHOR-relative (NOT new Date) and land within the last ~28
// days of the anchor so the 30d preset AND the 12m default window both catch
// them; a few older slots feed the 6-month enrollment sparkline.
//
// Per-province demand multiplier — layered on CAMPAIGN_BOOKING_RATE to spread
// enrollment/attendance across jurisdictions (mirrors PROVINCE_COVERAGE intent).
const PROVINCE_CAMPAIGN_DEMAND: Record<string, { demand: number; attend: number }> = {
  "Buenos Aires": { demand: 1.0, attend: 0.72 },
  CABA: { demand: 0.95, attend: 0.78 },
  Córdoba: { demand: 0.85, attend: 0.66 },
  "Santa Fe": { demand: 0.8, attend: 0.63 },
  Salta: { demand: 0.6, attend: 0.52 },
  Chaco: { demand: 0.5, attend: 0.45 },
};

// Campaign offering templates. serviceKind values are free text in the DB but
// align with lib/service-kinds (vaccination / deworming / sterilization) so the
// per-offering table renders a human label.
const CAMPAIGN_TEMPLATES: ReadonlyArray<{
  readonly kind: string;
  readonly label: string;
  readonly durationMinutes: number;
  readonly slotCapacity: number;
  readonly species: readonly string[];
}> = [
  {
    // Kinds must be catalog codes from lib/reference/service-kinds.ts —
    // /turnos/buscar filters by exact code, so invented kinds are unsearchable.
    kind: "vaccination_rabies",
    label: "Campaña de vacunación antirrábica",
    durationMinutes: 15,
    slotCapacity: 8,
    species: ["dog", "cat"],
  },
  {
    kind: "deworming",
    label: "Campaña de desparasitación",
    durationMinutes: 10,
    slotCapacity: 10,
    species: ["dog", "cat"],
  },
  {
    kind: "sterilization_dog_female",
    label: "Campaña de esterilización gratuita",
    durationMinutes: 45,
    slotCapacity: 4,
    species: ["dog", "cat"],
  },
];

async function seedHealthCampaigns(
  ownerUserId: string,
  shelterOrgs: PanoOrg[],
): Promise<{
  offerings: number;
  slots: number;
  appointments: number;
  attended: number;
  noShow: number;
  confirmed: number;
}> {
  log("STEP", "Seeding health campaigns (service_offerings + slots + appointments)…");

  if (shelterOrgs.length === 0) {
    log("WARN", "  No PANO orgs available — skipping campaigns");
    return { offerings: 0, slots: 0, appointments: 0, attended: 0, noShow: 0, confirmed: 0 };
  }

  // Pre-fetch a pool of PANO pet IDs per province (appointments.pet_id NOT NULL,
  // FK → pets, ON DELETE CASCADE). Reuse existing PANO pets so the cleanup
  // cascade stays consistent.
  const petPoolRows = await db
    .select({ id: pets.id, province: pets.jurisdictionProvince })
    .from(pets)
    .where(like(pets.publicToken, `${PANO_TAG}%`));

  const petsByProvince = new Map<string, string[]>();
  for (const r of petPoolRows) {
    const key = r.province ?? "Buenos Aires";
    if (!petsByProvince.has(key)) petsByProvince.set(key, []);
    petsByProvince.get(key)!.push(r.id);
  }
  const allPetIds = petPoolRows.map((r) => r.id);
  if (allPetIds.length === 0) {
    log("WARN", "  No PANO pets found — skipping campaigns");
    return { offerings: 0, slots: 0, appointments: 0, attended: 0, noShow: 0, confirmed: 0 };
  }

  let svoIdx = 0;
  let aptIdx = 0;
  let totalSlots = 0;
  let totalAppointments = 0;
  let attendedCount = 0;
  let noShowCount = 0;
  let confirmedCount = 0;

  for (const org of shelterOrgs) {
    const demand = PROVINCE_CAMPAIGN_DEMAND[org.provinceName] ?? { demand: 0.5, attend: 0.5 };

    // Each org hosts 1–2 campaign offerings (the larger metros host both
    // vaccination + one rotating second kind) so we get several offerings
    // spread across jurisdictions without flooding the dataset.
    const offeringCount = demand.demand >= 0.8 ? 2 : 1;

    for (let t = 0; t < offeringCount; t++) {
      const template = CAMPAIGN_TEMPLATES[(svoIdx + t) % CAMPAIGN_TEMPLATES.length];
      const svoToken = `PANO-SVO-${String(svoIdx).padStart(4, "0")}`;
      svoIdx++;

      const [offeringRow] = await db
        .insert(serviceOfferings)
        .values({
          publicToken: svoToken,
          organizationId: org.id,
          jurisdictionCountry: "AR",
          jurisdictionProvince: org.provinceName,
          jurisdictionLocality: org.locality,
          serviceKind: template.kind,
          // NO "PANO —" prefix — this is user-facing (renders in /inicio's
          // "Próximos turnos" as `${pet.name} · ${offering.displayName}`).
          // Same fix pattern as panoName() above: synthetic marker stays in
          // publicToken only, never in the human-readable label.
          displayName: `${template.label} (${org.locality})`,
          description: "Campaña sanitaria sintética de demostración (seed-panorama)",
          durationMinutes: template.durationMinutes,
          slotCapacity: template.slotCapacity,
          eligibilitySpecies: [...template.species],
          status: "approved",
          isPublic: false,
        } as Parameters<typeof db.insert<typeof serviceOfferings>>[0] extends {
          values: (v: infer V) => unknown;
        }
          ? V
          : never)
        .returning({ id: serviceOfferings.id });

      // One weekly schedule rule (Mon/Wed/Fri mornings). effective_* are date
      // strings; anchor the window around ANCHOR so it reads as a live campaign.
      const effFrom = new Date(ANCHOR_MS - 45 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const effUntil = new Date(ANCHOR_MS + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const [ruleRow] = await db
        .insert(serviceScheduleRules)
        .values({
          serviceOfferingId: offeringRow.id,
          daysOfWeek: [1, 3, 5],
          startTimeLocal: "09:00:00",
          endTimeLocal: "12:00:00",
          effectiveFrom: effFrom,
          effectiveUntil: effUntil,
          status: "active",
        } as Parameters<typeof db.insert<typeof serviceScheduleRules>>[0] extends {
          values: (v: infer V) => unknown;
        }
          ? V
          : never)
        .returning({ id: serviceScheduleRules.id });

      // Materialize slots. Most land within the last 28 days of the anchor (so
      // the 30d window catches them); a handful are placed 35–150 days back to
      // populate the 6-month enrollment sparkline; a couple are future-dated for
      // the "confirmed (booked)" enrollment bucket.
      const slotPlan: Array<{ daysFromAnchor: number; future: boolean }> = [];
      // 8 recent slots within the 28d window (past).
      for (let s = 0; s < 8; s++) slotPlan.push({ daysFromAnchor: randInt(1, 27), future: false });
      // 3 older slots for the sparkline (35–150 days back).
      for (let s = 0; s < 3; s++)
        slotPlan.push({ daysFromAnchor: randInt(35, 150), future: false });
      // 2 future slots (1–14 days ahead) for confirmed/booked-future bookings.
      for (let s = 0; s < 2; s++) slotPlan.push({ daysFromAnchor: randInt(1, 14), future: true });

      // Each slot gets a distinct hour offset (the morning campaign block runs
      // 09:00–12:00 → 12:00–15:00Z), so two slots that draw the same day still
      // produce a unique starts_at and never collide on the
      // time_slots_unique_starts (service_offering_id, starts_at) constraint.

      // Province pet pool (fallback to national pool when the province is sparse).
      const provincePets = petsByProvince.get(org.provinceName) ?? [];
      const pool = provincePets.length >= 4 ? provincePets : allPetIds;

      // Per-offering booking probability, layered with the province demand.
      const bookingProb = Math.min(0.95, CAMPAIGN_BOOKING_RATE * demand.demand + 0.1);

      // Pets already holding a CONFIRMED (future) appointment anywhere in THIS
      // offering. Future slots always seed 'confirmed', and migration 0181
      // allows only ONE live appointment per (pet, offering) — the same
      // campaign-level invariant 0177 enforced per slot. Without this set the
      // per-slot dedupe below could still draw the same pet for two future
      // slots of one campaign, and db:bootstrap would die on the index (the
      // 0177 rollout failed on exactly that shape, seeded per slot).
      const confirmedPetsInOffering = new Set<string>();

      for (let slotSeq = 0; slotSeq < slotPlan.length; slotSeq++) {
        const plan = slotPlan[slotSeq];
        const offsetMs = plan.daysFromAnchor * 24 * 3600 * 1000;
        const slotStartMs = plan.future ? ANCHOR_MS + offsetMs : ANCHOR_MS - offsetMs;
        // 12:00Z base (~09:00 local) + a per-slot hour offset (0–12h) so every
        // slot in an offering has a unique starts_at even on a colliding day.
        const hourOffset = (slotSeq % 13) * 3600 * 1000;
        const startsAt = new Date(slotStartMs + 12 * 3600 * 1000 + hourOffset);
        const endsAt = new Date(startsAt.getTime() + template.durationMinutes * 60 * 1000);
        const capacity = template.slotCapacity;

        // How many of the slot's capacity get booked.
        let bookings = 0;
        for (let c = 0; c < capacity; c++) {
          if (rng() < bookingProb) bookings++;
        }
        // Guarantee at least one booking on recent past slots so every offering
        // shows enrollment (and the within-capacity CHECK still holds).
        if (bookings === 0 && !plan.future && plan.daysFromAnchor <= 27) bookings = 1;

        // Pick the DISTINCT pets for this slot BEFORE inserting it, so
        // bookings_count always equals the number of appointments actually
        // created. The pool is sampled WITH replacement, so two draws could
        // land on the same pet and write two live appointments for the same
        // (pet, slot) — not a plausible history (nobody books the same slot
        // twice) and a violation of the partial unique index from migration
        // 0177, which would make `pnpm db:bootstrap` fail for everyone.
        // Bounded redraws: a tiny pool must not spin forever.
        const slotPets: string[] = [];
        const usedPets = new Set<string>();
        for (let b = 0; b < bookings && usedPets.size < pool.length; b++) {
          for (let attempt = 0; attempt < 8; attempt++) {
            const candidate = pool[Math.floor(rng() * pool.length)];
            if (usedPets.has(candidate)) continue;
            // Future slots write 'confirmed' rows — a pet that already holds a
            // confirmed booking in this offering must not be drawn again
            // (campaign-level unique index, migration 0181). Past slots write
            // terminal statuses, which the partial index ignores.
            if (plan.future && confirmedPetsInOffering.has(candidate)) continue;
            usedPets.add(candidate);
            slotPets.push(candidate);
            break;
          }
        }
        bookings = slotPets.length;
        if (plan.future) for (const p of slotPets) confirmedPetsInOffering.add(p);

        const slotStatus = bookings >= capacity ? "full" : "open";
        const [slotRow] = await db
          .insert(timeSlots)
          .values({
            serviceOfferingId: offeringRow.id,
            ruleId: ruleRow.id,
            startsAt,
            endsAt,
            capacity,
            bookingsCount: bookings,
            status: slotStatus,
          } as Parameters<typeof db.insert<typeof timeSlots>>[0] extends {
            values: (v: infer V) => unknown;
          }
            ? V
            : never)
          .returning({ id: timeSlots.id });
        totalSlots++;

        if (bookings === 0) continue;

        const apptRows: Array<Record<string, unknown>> = [];
        for (const petId of slotPets) {
          const aptToken = `PANO-APT-${String(aptIdx).padStart(5, "0")}`;
          aptIdx++;

          // Outcome resolution:
          //   future slot          → always "confirmed" (booked, not yet held)
          //   past slot            → attended (per-province attend rate) /
          //                          no_show (the rest) — mixed by jurisdiction
          let status: "confirmed" | "attended" | "no_show";
          let attendedAt: Date | null = null;
          let noShowMarkedAt: Date | null = null;
          if (plan.future) {
            status = "confirmed";
            confirmedCount++;
          } else if (rng() < demand.attend) {
            status = "attended";
            attendedAt = new Date(startsAt.getTime() + template.durationMinutes * 60 * 1000);
            attendedCount++;
          } else {
            status = "no_show";
            noShowMarkedAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
            noShowCount++;
          }

          // createdAt drives the projection window: book a few days before the
          // slot start, but never in the future relative to the anchor (so the
          // 30d/12m windows that end at "now" still include them).
          const leadDays = randInt(2, 10);
          let createdMs = startsAt.getTime() - leadDays * 24 * 3600 * 1000;
          if (createdMs > ANCHOR_MS) createdMs = ANCHOR_MS - randInt(1, 5) * 24 * 3600 * 1000;
          const createdAt = new Date(createdMs);

          apptRows.push({
            publicToken: aptToken,
            slotId: slotRow.id,
            petId,
            ownerUserId,
            serviceOfferingId: offeringRow.id,
            organizationId: org.id,
            status,
            ...(attendedAt ? { attendedAt, attendedByUserId: ownerUserId } : {}),
            ...(noShowMarkedAt ? { noShowMarkedAt } : {}),
            createdAt,
            updatedAt: createdAt,
          });
          totalAppointments++;
        }

        if (apptRows.length > 0) {
          await db.insert(appointments).values(
            apptRows as Parameters<typeof db.insert<typeof appointments>>[0] extends {
              values: (v: infer V) => unknown;
            }
              ? V
              : never,
          );
        }
      }
    }
  }

  log(
    "INFO",
    `  Campaigns: ${svoIdx} offerings, ${totalSlots} slots, ${totalAppointments} appointments ` +
      `(${attendedCount} attended / ${noShowCount} no-show / ${confirmedCount} confirmed)`,
  );
  return {
    offerings: svoIdx,
    slots: totalSlots,
    appointments: totalAppointments,
    attended: attendedCount,
    noShow: noShowCount,
    confirmed: confirmedCount,
  };
}

// ---------------------------------------------------------------------------
// 15b. Multi-year, locality-level synthetic history (model provinces)
// ---------------------------------------------------------------------------

/**
 * Calendar years covered by the multi-year history seed. Used for both the
 * per-pet coverage draw and the per-province monthly event generation.
 */
const HISTORY_YEARS = [2024, 2025, 2026] as const;
type HistoryYear = (typeof HISTORY_YEARS)[number];

// Target ~a few hundred history pets per province. Pets-per-locality is
// derived per province so the per-locality count stays sane across all locality
// counts (Córdoba has 532 coord'd localities; Salta has 163).
const HISTORY_TARGET_PETS_PER_PROVINCE = 300;
const HISTORY_MIN_PETS_PER_LOCALITY = 5;
const HISTORY_MAX_PETS_PER_LOCALITY = 300;

/** Pets per locality so the province total lands near the target, within sane bounds. */
function historyPetsPerLocality(localityCount: number): number {
  if (localityCount <= 0) return 0;
  const ideal = Math.ceil(HISTORY_TARGET_PETS_PER_PROVINCE / localityCount);
  return Math.min(HISTORY_MAX_PETS_PER_LOCALITY, Math.max(HISTORY_MIN_PETS_PER_LOCALITY, ideal));
}

/**
 * Seed multi-year locality-level history for ALL 24 Argentine provinces.
 * ADDITIVE — does not touch the main per-province seed. All pets use the
 * `PANO-HIST-` token prefix so `runClean()`'s `name LIKE 'PANO-%'` filter
 * removes them automatically (no runClean change needed).
 *
 * Coverage and zoonosis trends come from `provinceProfile()` in
 * seed-history-utils.ts:
 *   - Córdoba: improving (vacc/ster rise, zoonosis declines)
 *   - Salta:   worsening (vacc/ster fall, zoonosis rises)
 *   - other:   uniform (mild upward trend, flat-ish zoonosis)
 *
 * New vs. existing dimensions added by this function:
 *   existing  → pet_registered, vaccination_administered, sterilization_performed,
 *               outbreak_signal, disease_reported
 *   new       → death_recorded, incident_reported (bite), status_changed
 *               (to_status='lost' = pet lost), note_added (kind='sighting' =
 *               avistaje), shelter_intake_recorded, foster_assigned,
 *               adoption_finalized
 *
 * Payload keys mirror the base-seed generators so dashboard/map loaders read
 * the same JSONB paths.
 */
async function seedModelProvinceHistory(
  localitiesByCode: Map<string, LocalityRow[]>,
  ownerUserId: string,
): Promise<{
  pets: number;
  eventCounts: Record<string, number>;
  localitiesCovered: Record<string, number>;
}> {
  log("STEP", "Seeding multi-year locality-level history (all provinces)…");

  const eventCounts: Record<string, number> = {};
  const localitiesCovered: Record<string, number> = {};
  let totalHistoryPets = 0;
  let histIdx = 0;

  const ANCHOR = new Date(ANCHOR_ISO);

  // Deterministic, collision-free token + name for history rows. Distinct from
  // the numeric PANO-NNNNNN tokens used by the main seed.
  const histToken = (i: number): string => `PANO-HIST-${String(i).padStart(6, "0")}`;
  // Human name only — the synthetic marker lives in the token (see panoName).
  const histName = (_i: number, base: string): string => base;

  for (const province of PROVINCES) {
    const provinceName = province.name;
    const code = PROVINCE_TO_CODE.get(provinceName);
    const localities = code ? (localitiesByCode.get(code) ?? []) : [];

    if (localities.length === 0) {
      log("WARN", `  ${provinceName}: no localities with coordinates — skipping`);
      continue;
    }

    localitiesCovered[provinceName] = localities.length;
    const petsPerLocality = historyPetsPerLocality(localities.length);

    // Coverage and zoonosis trends for this province.
    const { archetype, coverageByYear, zoonosisByYear } = provinceProfile(provinceName);

    // Per-province / per-year tallies for the validation summary lines.
    const perYear: Record<HistoryYear, { pets: number; vacc: number; ster: number; zoon: number }> =
      {
        2024: { pets: 0, vacc: 0, ster: 0, zoon: 0 },
        2025: { pets: 0, vacc: 0, ster: 0, zoon: 0 },
        2026: { pets: 0, vacc: 0, ster: 0, zoon: 0 },
      };

    const perPetMeta: Array<{
      token: string;
      index: number;
      registeredYear: HistoryYear;
      species: string;
      name: string;
      sex: "male" | "female" | "unknown";
      localityName: string;
      lat: number;
      lng: number;
    }> = [];

    // 1. Build pet rows: a fixed number per locality, registration year spread
    //    across 2024–2026.
    for (const loc of localities) {
      for (let p = 0; p < petsPerLocality; p++) {
        const speciesEntry = pickWeighted(
          SPECIES_DIST as unknown as Array<{ species: string; weight: number }>,
        );
        const species = speciesEntry.species;
        const baseName = pick(PET_NAMES);
        const sex = pick(SEXES);
        const registeredYear = pickRegisteredYear(rng, HISTORY_YEARS);
        const { lat, lng } = jitteredCoord(loc.lat, loc.lng, 0.02);

        const token = histToken(histIdx);
        perPetMeta.push({
          token,
          index: histIdx,
          registeredYear,
          species,
          name: histName(histIdx, baseName),
          sex,
          localityName: loc.localityName,
          lat,
          lng,
        });
        perYear[registeredYear].pets++;
        histIdx++;
      }
    }

    // 2. Build per-pet, per-year coverage events. Each pet is created through
    //    the REAL intake circuit (registerPet) rather than bulk inserted, so a
    //    history pet is indistinguishable from a real registration except for
    //    its seed_tag and PANO-HIST- token.
    const eventRows: Array<Record<string, unknown>> = [];
    // Pets whose latest lost episode stays open (step 7b) — the only ones whose
    // status cache moves to 'lost' after the events are inserted.
    const historyStillLostPetIds: string[] = [];
    // token → pet id, populated as each pet clears the real intake circuit.
    // Downstream steps (zoonosis attachment, per-locality event spraying) key
    // off this instead of a post-insert SELECT.
    const tokenToId = new Map<string, string>();
    // pet id → registration instant (ms). Every event this function attaches to
    // a pet must fall at or after it: the pooled event loops below draw a pet at
    // random from a whole province/locality, which without this map produces
    // deaths, bites and outbreaks dated before the pet was ever registered.
    const registeredAtMs = new Map<string, number>();

    const bump = (type: string): void => {
      eventCounts[type] = (eventCounts[type] ?? 0) + 1;
    };

    for (const meta of perPetMeta) {
      // Drawn before registration: both land in the pet_registered event that
      // registerPet writes.
      const registeredAt = dateInYear(meta.registeredYear, rng);
      const acquisitionMethod = pick([
        "purchased",
        "found_stray",
        "gift",
        "born_in_litter",
        "other",
      ] as const);

      const registered = await registerSeedPet(
        {
          index: meta.index,
          name: meta.name,
          species: meta.species,
          sex: meta.sex,
          provinceName,
          localityName: meta.localityName,
          dangerousBreed: false,
          acquisitionMethod,
          registeredAt,
          seedTag: SEED_TAG_PANORAMA_HIST,
        },
        ownerUserId,
        // History rows carry their own token namespace (PANO-HIST-NNNNNN).
        meta.token,
      );
      if (!registered) continue;
      const petId = registered.petId;
      tokenToId.set(meta.token, petId);
      registeredAtMs.set(petId, registeredAt.getTime());
      bump("pet_registered");

      // Per year ≥ registeredYear: emit vaccination / sterilization per that
      // province-year's coverage rate. This makes the measured coverage rate
      // climb (Córdoba) or stagnate (Salta) as `asOf` advances.
      for (const year of HISTORY_YEARS) {
        if (year < meta.registeredYear) continue;
        const cov = coverageByYear[year];

        if (rng() < cov.vacc) {
          eventRows.push({
            petId,
            eventType: "vaccination_administered" satisfies EventType,
            // notBefore=registeredAt: in the pet's own registration year an
            // unbounded draw lands before the registration about half the time.
            occurredAt: dateInYear(year, rng, 0, 11, registeredAt),
            recordedByUserId: ownerUserId,
            authorRole: "owner",
            authorVerified: false,
            payload: {
              source: "seed-panorama-history",
              vaccine_name: "antirrábica",
              brand: pick(["Defensor 3", "Rabvac 3", "Nobivac Rabies"]),
              batch: `PANO-HIST-${String(histIdx % 9999).padStart(4, "0")}`,
              next_due_at: null,
            },
            ...writePoint(jitteredCoord(meta.lat, meta.lng, 0.01)),
          });
          bump("vaccination_administered");
          perYear[year].vacc++;
        }

        if (rng() < cov.ster) {
          eventRows.push({
            petId,
            eventType: "sterilization_performed" satisfies EventType,
            occurredAt: dateInYear(year, rng, 0, 11, registeredAt),
            recordedByUserId: ownerUserId,
            authorRole: "owner",
            authorVerified: false,
            payload: {
              source: "seed-panorama-history",
              procedure: meta.species === "cat" || rng() < 0.5 ? "castration" : "spay",
              performed_by: null,
              clinic: null,
            },
            ...writePoint(jitteredCoord(meta.lat, meta.lng, 0.01)),
          });
          bump("sterilization_performed");
          perYear[year].ster++;
        }
      }
    }

    // 4. Build petsByLocality map for zoonosis and per-province event attachment.
    const petsByLocality = new Map<string, string[]>();
    for (let i = 0; i < perPetMeta.length; i++) {
      const meta = perPetMeta[i];
      const petId = tokenToId.get(meta.token);
      if (!petId) continue;
      // Recover the locality from the row order: pets were generated locality by
      // locality in petsPerLocality-sized contiguous blocks.
      const localityIndex = Math.floor(i / petsPerLocality);
      const loc = localities[localityIndex];
      if (!loc) continue;
      if (!petsByLocality.has(loc.localityName)) petsByLocality.set(loc.localityName, []);
      petsByLocality.get(loc.localityName)!.push(petId);
    }

    // 4b. Eligible-pet picker — the fix for "events before the pet exists".
    //
    // The pooled loops below (zoonosis, death, bite, lost, shelter intake) pick
    // a pet uniformly from a whole province or locality and date the event from
    // a year/month trend curve. Those two draws were independent, so an event
    // routinely landed before its own pet's pet_registered: 45% of all history
    // events did, including 1623 of 3579 death_recorded — pets dying before
    // they existed.
    //
    // The province seed fixed its equivalent by drawing the death date inside
    // [registeredAt, anchor]. That shape does NOT transfer here: these dates
    // come from monthlyEventCount/pickDateInMonth, which is the whole point of
    // the history seed — it encodes the per-province trend and seasonality that
    // the panorama history charts render. Re-drawing dates from each pet's
    // window would preserve the invariant but destroy the curve.
    //
    // So the date is kept and the POOL is narrowed instead: pick only among
    // pets already registered at that instant. The monthly histogram is
    // therefore bit-for-bit unchanged, except in the earliest months where no
    // pet exists yet and the event is correctly skipped.
    //
    // The picker itself lives in seed-history-utils.ts (pure, db-free) so the
    // invariant is unit-tested rather than only observable by re-seeding 32k
    // pets — see __tests__/seed-history-eligible-pet.test.ts.
    const makeEligiblePicker = (petIds: readonly string[]) =>
      makeRegisteredByPicker(petIds, registeredAtMs);

    // 5. Per-locality, per-year zoonosis events per the trend intensity. Attach
    //    each to one of that locality's history pets (in that province) so the
    //    event has a valid pet_id and inherits the locality's jurisdiction.
    for (const loc of localities) {
      const carrierPets = petsByLocality.get(loc.localityName) ?? [];
      if (carrierPets.length === 0) continue;
      const pickCarrier = makeEligiblePicker(carrierPets);

      for (const year of HISTORY_YEARS) {
        const intensity = zoonosisByYear[year];
        // floor guaranteed events + one Bernoulli draw on the fractional part.
        const guaranteed = Math.floor(intensity);
        const remainder = intensity - guaranteed;
        const count = guaranteed + (rng() < remainder ? 1 : 0);

        for (let z = 0; z < count; z++) {
          // The rng draw stays in its original position so the deterministic
          // stream is unchanged; only what it INDEXES INTO moves (see 4b).
          const petDraw = rng();
          const useOutbreak = rng() < 0.5;
          const occurredAt = dateInYear(year, rng);
          const petId = pickCarrier(occurredAt, petDraw);
          if (!petId) continue;
          const { lat, lng } = jitteredCoord(loc.lat, loc.lng, 0.01);

          if (useOutbreak) {
            eventRows.push({
              petId,
              eventType: "outbreak_signal" satisfies EventType,
              occurredAt,
              recordedByUserId: ownerUserId,
              authorRole: "govt",
              authorVerified: true,
              payload: {
                source: "seed-panorama-history",
                disease_code: "rabies_suspected",
                disease_label: "Rabia (sospechada)",
                // outbreak_signal is the ONE event type that legitimately snapshots
                // the pet's jurisdiction into pet_jurisdiction_* (schema-valid) — read
                // by BOTH petEventsScopeClause (metrics scope) AND the zoonosis panorama
                // aggregation loader (loadZoonosisByUnit / loadUnitHistory). The old flat
                // province/locality keys no outbreak_signal writer emits were removed;
                // real signals now render because the loader keys on the snapshot.
                pet_jurisdiction_province: provinceName,
                pet_jurisdiction_locality: loc.localityName,
                status: "open",
              },
              ...writePoint({ lat, lng }),
            });
            bump("outbreak_signal");
          } else {
            eventRows.push({
              petId,
              eventType: "disease_reported" satisfies EventType,
              occurredAt,
              recordedByUserId: ownerUserId,
              authorRole: "vet",
              authorVerified: true,
              payload: {
                source: "seed-panorama-history",
                disease: pick(["lepto", "hidatidosis", "other"] as const),
                confirmed_by_lab: rng() < 0.5,
                date_of_onset: new Date(occurredAt.getTime() - 3 * 24 * 3600 * 1000)
                  .toISOString()
                  .slice(0, 10),
                clinical_notes: `Zoonosis history ${provinceName} ${year} (seed-panorama-history)`,
                // No jurisdiction in the payload: disease_reported never carries it
                // (only outbreak_signal snapshots pet_jurisdiction_*). fetchActiveZoonosis
                // scopes via the JOIN to pets. The demo pet_jurisdiction_* keys were removed.
              },
              ...writePoint({ lat, lng }),
            });
            bump("disease_reported");
          }
          perYear[year].zoon++;
        }
      }
    }

    // 6. Per-province, per-month additional event dimensions.
    // Uses monthlyEventCount (trend + seasonal) + pickDateInMonth (deterministic
    // dates). Base rate is scaled by locality count so bigger provinces generate
    // more events proportionally. HISTORY_SCALE (env knob, default 1) multiplies
    // all base rates so the caller can tune volume without touching code.
    //
    // Payload keys MIRROR the base-seed generators so dashboard/map loaders read
    // the correct JSONB paths (pet_jurisdiction_province for the metrics scope
    // clause; province/locality/kind for the perdidas and per-unit panorama
    // loaders).
    const allProvincePetIds = [...petsByLocality.values()].flat();
    const pickProvincePet = makeEligiblePicker(allProvincePetIds);
    if (allProvincePetIds.length > 0) {
      // Monthly base count for the province (scales with its locality footprint).
      const monthlyBase = HISTORY_SCALE * Math.max(1, Math.round(localities.length / 50));

      // Lost events collected within this province for the subsequent found-sighting pass.
      const lostEvents: Array<{
        petId: string;
        lostAt: Date;
        localityName: string;
        lat: number;
        lng: number;
      }> = [];
      // Pets that die in this block. death_recorded is terminal in the
      // projection, so these must never be cached as 'lost' (step 7b).
      const historyDeceasedPetIds = new Set<string>();

      for (const year of HISTORY_YEARS) {
        for (let month = 0; month < 12; month++) {
          // --- death_recorded (mirrors base-seed payload exactly) ---
          const deathCount = monthlyEventCount(monthlyBase, archetype, year, month, rng);
          for (let d = 0; d < deathCount; d++) {
            // rng draw kept in place (deterministic stream unchanged); it now
            // indexes the pets already registered at occurredAt — see 4b.
            const petDraw = rng();
            const loc = localities[Math.floor(rng() * localities.length)];
            const { lat, lng } = jitteredCoord(loc.lat, loc.lng, 0.02);
            const occurredAt = pickDateInMonth(year, month, rng, ANCHOR);
            const petId = pickProvincePet(occurredAt, petDraw);
            if (!petId) continue;
            historyDeceasedPetIds.add(petId);
            eventRows.push({
              petId,
              eventType: "death_recorded" satisfies EventType,
              occurredAt,
              recordedByUserId: ownerUserId,
              authorRole: "owner",
              authorVerified: false,
              payload: {
                source: "seed-panorama-history",
                cause: pick(["natural", "accident", "disease", "euthanasia"] as const),
                cause_detail: null,
                confirmed_by_vet: rng() < 0.4,
                vet_name: null,
                disposition_method: pick([
                  "owner_burial",
                  "cremation_collective",
                  "authorized_cemetery",
                  "unknown",
                ] as const),
                facility: rng() < 0.45 ? "Establecimiento habilitado" : null,
                death_at_clinic: false,
                vet_contacted_owner: "unknown",
                vet_decided_alone: null,
                is_reportable: false,
                during_rabies_observation: false,
                pet_jurisdiction_province: provinceName,
                pet_jurisdiction_locality: loc.localityName,
              },
              ...writePoint({ lat, lng }),
            });
            bump("death_recorded");
          }

          // --- incident_reported / bite (mirrors base-seed payload exactly) ---
          const biteCount = monthlyEventCount(monthlyBase, archetype, year, month, rng);
          for (let b = 0; b < biteCount; b++) {
            const petDraw = rng();
            const loc = localities[Math.floor(rng() * localities.length)];
            const { lat, lng } = jitteredCoord(loc.lat, loc.lng, 0.02);
            const occurredAt = pickDateInMonth(year, month, rng, ANCHOR);
            const petId = pickProvincePet(occurredAt, petDraw);
            if (!petId) continue;
            eventRows.push({
              petId,
              eventType: "incident_reported" satisfies EventType,
              occurredAt,
              recordedByUserId: ownerUserId,
              authorRole: "vet",
              authorVerified: false,
              payload: {
                source: "seed-panorama-history",
                incident_type:
                  rng() < 0.7 ? ("bite_inflicted" as const) : ("bite_suffered" as const),
                severity: pick(["minor", "moderate", "severe"] as const),
                injuries_summary: `Mordedura ${provinceName} history (seed-panorama-history)`,
                vet_involved: rng() < 0.6,
                location_description: `${loc.localityName}, ${provinceName}`,
                rabies_vaccine_valid_at_incident: rng() < 0.5,
                // No jurisdiction in the payload: incident_reported never carries it.
                // The bite panorama loaders (loadBiteEvents / loadMordedurassByUnit /
                // loadUnitHistory('mordeduras')) and the metrics fetchers (fetchBitesTrend
                // / fetchBitesPer10k) attribute + scope via the JOIN to pets. The old flat
                // province/locality (no writer emits) and pet_jurisdiction_* (rejected by
                // the strict incident_reported schema) demo keys were removed.
              },
              ...writePoint({ lat, lng }),
            });
            bump("incident_reported");
          }

          // --- status_changed / pet_lost (mirrors perdidas loader: kind + province) ---
          const lostCount = monthlyEventCount(
            Math.max(1, Math.round(monthlyBase * 0.8)),
            archetype,
            year,
            month,
            rng,
          );
          for (let l = 0; l < lostCount; l++) {
            const petDraw = rng();
            const loc = localities[Math.floor(rng() * localities.length)];
            const { lat, lng } = jitteredCoord(loc.lat, loc.lng, 0.02);
            const lostAt = pickDateInMonth(year, month, rng, ANCHOR);
            const petId = pickProvincePet(lostAt, petDraw);
            if (!petId) continue;
            eventRows.push({
              petId,
              eventType: "status_changed" satisfies EventType,
              occurredAt: lostAt,
              recordedByUserId: ownerUserId,
              authorRole: "owner",
              authorVerified: false,
              payload: {
                source: "seed-panorama-history",
                from_status: "active",
                to_status: "lost",
                // A pet marked lost is status_changed(to_status='lost') — the perdidas
                // panorama loader keys on that real shape and attributes the unit via the
                // JOIN to pets. The old demo 'kind'/'province'/'locality'/'pet_jurisdiction_*'
                // keys (no writer emits them; the strict schema rejects them) were removed.
              },
              ...writePoint({ lat, lng }),
            });
            bump("status_changed");
            lostEvents.push({
              petId,
              lostAt,
              localityName: loc.localityName,
              lat: loc.lat,
              lng: loc.lng,
            });
          }

          // --- adoption funnel: shelter_intake_recorded + foster_assigned + adoption_finalized ---
          // Each "chain" models one pet moving through the full custody pipeline.
          // The custody funnel counts them independently via JOIN to pets, so
          // emitting the events (without changing ownerships) is sufficient.
          const adoptCount = monthlyEventCount(
            Math.max(1, Math.round(monthlyBase * 0.6)),
            archetype,
            year,
            month,
            rng,
          );
          for (let a = 0; a < adoptCount; a++) {
            const petDraw = rng();
            const loc = localities[Math.floor(rng() * localities.length)];
            const intakeAt = pickDateInMonth(year, month, rng, ANCHOR);
            const petId = pickProvincePet(intakeAt, petDraw);
            if (!petId) continue;
            const fosterAt = new Date(
              Math.min(intakeAt.getTime() + randInt(7, 21) * 86_400_000, ANCHOR.getTime()),
            );
            const adoptionAt = new Date(
              Math.min(intakeAt.getTime() + randInt(21, 60) * 86_400_000, ANCHOR.getTime()),
            );

            eventRows.push({
              petId,
              eventType: "shelter_intake_recorded" satisfies EventType,
              occurredAt: intakeAt,
              recordedByUserId: ownerUserId,
              authorRole: "shelter",
              authorVerified: true,
              payload: {
                source: "seed-panorama-history",
                intake_reason: pick(["stray", "surrender", "transfer"] as const),
                pet_jurisdiction_province: provinceName,
                pet_jurisdiction_locality: loc.localityName,
              },
            });
            bump("shelter_intake_recorded");

            eventRows.push({
              petId,
              eventType: "foster_assigned" satisfies EventType,
              occurredAt: fosterAt,
              recordedByUserId: ownerUserId,
              authorRole: "shelter",
              authorVerified: true,
              payload: {
                source: "seed-panorama-history",
                foster_user_id: ownerUserId,
                pet_jurisdiction_province: provinceName,
                pet_jurisdiction_locality: loc.localityName,
              },
            });
            bump("foster_assigned");

            eventRows.push({
              petId,
              eventType: "adoption_finalized" satisfies EventType,
              occurredAt: adoptionAt,
              recordedByUserId: ownerUserId,
              authorRole: "shelter",
              authorVerified: true,
              payload: {
                source: "seed-panorama-history",
                previous_owner_organization_id: null,
                adopter_user_id: ownerUserId,
                foster_user_id: null,
                contract_attachment_id: null,
                post_adoption_followup_months: pick([6, 12] as const),
                notes: null,
                pet_jurisdiction_province: provinceName,
                pet_jurisdiction_locality: loc.localityName,
              },
            });
            bump("adoption_finalized");
          }
        }
      }

      // 7. Sighting ("Avistaje"): ~40 % of lost pets get a sighting some days
      //    later. Production writes this as note_added(kind='sighting') during
      //    the open lost episode (app/actions/pet-sighting.ts / updateLostLastSeen)
      //    — NOT a status_changed with a payload 'kind' (no writer emits that;
      //    the note_added zod enum never had a 'pet_found_sighting' value). The
      //    perdidas panorama loader keys on this real shape and attributes the
      //    unit via the JOIN to pets, so no payload jurisdiction is needed.
      //    Routed through validateEventPayload so the seed no longer bypasses zod.
      for (const lost of lostEvents) {
        if (rng() < 0.4) {
          const daysLater = 7 + Math.floor(rng() * 30);
          const foundAt = new Date(
            Math.min(lost.lostAt.getTime() + daysLater * 86_400_000, ANCHOR.getTime()),
          );
          const { lat, lng } = jitteredCoord(lost.lat, lost.lng, 0.02);
          eventRows.push({
            petId: lost.petId,
            eventType: "note_added" satisfies EventType,
            occurredAt: foundAt,
            recordedByUserId: ownerUserId,
            authorRole: "owner",
            authorVerified: false,
            payload: validateEventPayload("note_added", {
              category: "otro",
              text: "Avistaje reportado durante episodio de búsqueda (seed-panorama-history)",
              kind: "sighting",
            }),
            ...writePoint({ lat, lng }),
          });
          bump("note_added");
        }
      }

      // 7b. Close the lost episodes so the spine and the cache agree BY
      //     CONSTRUCTION — the same shape the per-province block uses (its
      //     paired lost→active status_changed + `lostPetIds` cache write).
      //     Before this, every history loss stayed open in the spine and the
      //     cache never moved: 5741 lost events, zero reunions, 2705 pets
      //     whose latest status_changed said 'lost' over status='active'
      //     (staging, 2026-09). The nightly reconcile cron flagged it every
      //     night and /perdidas — which filters on the cache — showed ~70
      //     lost pets to officials while the spine said 2775.
      //     The decision is per PET (one pet can be lost several times) and
      //     lives in seed-history-utils.ts so it is unit-tested against the
      //     real projection instead of only observable by re-seeding.
      const lossOutcome = resolveHistoryLossOutcomes(lostEvents, {
        anchor: ANCHOR,
        deceasedPetIds: historyDeceasedPetIds,
        reunificationRate: REUNIFICATION_RATE,
        recentWindowDays: RECENT_LOSS_WINDOW_DAYS,
        rng,
      });
      for (const { episode, reunifiedAt } of lossOutcome.reunifications) {
        const { lat, lng } = jitteredCoord(episode.lat, episode.lng, 0.02);
        eventRows.push({
          petId: episode.petId,
          eventType: "status_changed" satisfies EventType,
          occurredAt: reunifiedAt,
          recordedByUserId: ownerUserId,
          authorRole: "owner",
          authorVerified: false,
          payload: {
            source: "seed-panorama-history",
            from_status: "lost",
            to_status: "active",
            location_description: "Reencuentro con la familia",
            reunified: true,
          },
          ...writePoint({ lat, lng }),
        });
        bump("status_changed");
      }
      historyStillLostPetIds.push(...lossOutcome.stillLostPetIds);
      log(
        "INFO",
        `  ${provinceName} lost episodes: ${lostEvents.length} → ` +
          `${lossOutcome.reunifications.length} reunified, ` +
          `${lossOutcome.stillLostPetIds.length} pet(s) still lost`,
      );
    }

    // 8. Stamp seed provenance, then batch insert the post-registration events.
    //    Ownerships are no longer inserted here — registerPet wrote an owner
    //    ownership for every history pet inside its registration transaction.
    const histTokens = perPetMeta.map((m) => m.token);
    for (let b = 0; b < histTokens.length; b += BATCH_SIZE) {
      const batch = histTokens.slice(b, b + BATCH_SIZE);
      await db
        .update(pets)
        .set({ seedTag: SEED_TAG_PANORAMA_HIST })
        .where(inArray(pets.publicToken, batch));
    }
    for (let b = 0; b < eventRows.length; b += BATCH_SIZE) {
      const batch = eventRows.slice(b, b + BATCH_SIZE);
      await db.insert(petEvents).values(
        batch as Parameters<typeof db.insert<typeof petEvents>>[0] extends {
          values: (v: infer V) => unknown;
        }
          ? V
          : never,
      );
    }

    // status='lost' — backed by the still-open status_changed(active→lost)
    // above (step 7b). Same cache write as the per-province block's lostPetIds
    // loop; pets with a death_recorded were excluded by construction.
    for (let b = 0; b < historyStillLostPetIds.length; b += BATCH_SIZE) {
      const batch = historyStillLostPetIds.slice(b, b + BATCH_SIZE);
      await db.update(pets).set({ status: "lost" }).where(inArray(pets.id, batch));
    }

    const provincePets = perPetMeta.length;
    totalHistoryPets += provincePets;

    // 9. Validation evidence — per-province / per-year summary lines.
    log(
      "INFO",
      `  ${provinceName} (${archetype}): ${provincePets} pets across ${localities.length} localities`,
    );
    for (const year of HISTORY_YEARS) {
      const y = perYear[year];
      log(
        "INFO",
        `    ${provinceName} ${year}: pets=${y.pets} vacc=${y.vacc} ster=${y.ster} zoonosis=${y.zoon}`,
      );
    }
  }

  log("INFO", `  History total: ${totalHistoryPets} pets (all provinces)`);
  return { pets: totalHistoryPets, eventCounts, localitiesCovered };
}

// ---------------------------------------------------------------------------
// 17. Historical welfare_reports + enforcement cases — 2024-2026 all provinces
// ---------------------------------------------------------------------------
// All rows are PANO-tagged so runClean()'s existing patterns remove them:
//   welfare_reports: seed_tag LIKE 'PANO%' (migration 0155) ← the internal
//     marker moved OUT of `description` (C5 fix — description now reads like
//     a real citizen report; the seed-tag lives in a column no query renders).
//   cases:           opened_reason LIKE '%seed histórico%' ← both the
//     decomiso and dispute openedReason strings below end in that marker.
//     NOTE: these cases' public_code is production-format CAS-XXXX-XXXX
//     (allocateCasePublicCode(), same generator as CasesRepository), on
//     purpose — a demo /gob/casos list mixing CAS-XXXX-XXXX with literal
//     PANO-CASE-HIST-* codes read as an obvious fake. That means the
//     public_code LIKE 'PANO-CASE-%' cleanup pattern does NOT catch them —
//     the opened_reason marker is their only cleanup path (no primary_pet_id
//     to cascade on either, since primarySubjectKind='location').
//
// Jurisdiction scoped by COLUMN (jurisdictionProvince/jurisdictionLocality),
// matching jurisdictionColumnsScope() in the panorama repository consumers:
//   loadDenunciaCentroids, loadDenunciasByUnit, loadUnitHistory('denuncias')
//   loadDecomisos (custody_episode), fetchAnalyticsMetrics custodyDisputes
//
// custody_episode (decomiso) + custody_dispute cases use
//   primarySubjectKind = 'location'
// which satisfies the cases_subject_location_consistency biconditional by
// providing locationLat/Lng.  No registered pet FK required.
//
// Welfare-report createdAt is set explicitly to a past date (not defaultNow)
// so the consumer's gte(welfareReports.createdAt, since) temporal filter
// correctly returns rows from 2024 and 2025.

/**
 * Allocate a unique CAS-XXXX-XXXX case public_code — same generator
 * (generatePrefixedToken) and retry-on-collision idiom as the production
 * path (CasesRepository.generateUniqueCasePublicCode in
 * cases-repository.ts). Used so seeded HIST cases are indistinguishable in
 * format from real operator-created cases in the /gob/casos list.
 */
async function allocateCasePublicCode(): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generatePrefixedToken("CAS");
    const [existing] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(eq(cases.publicCode, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  return undefined;
}

/**
 * Age-correlated status for a historical welfare report (C5 fix).
 *
 * Before this, status was a flat roll independent of age: ~60% open no
 * matter how old the row was. That produced 930-day-old "critical open"
 * cases — a backlog item that LOOKS like a live SLA breach, when in reality
 * a report that old should almost always have been resolved one way or
 * another. closedProb ramps from ~10% (very recent — still being triaged)
 * to ~90% (>180d — should be terminal), with a SMALL realistic-backlog
 * exception (~7% of the >180d cohort stays open) rather than none at all.
 */
/**
 * The lifecycle instants implied by a seeded welfare report's status.
 *
 * A status is a CONCLUSION; the timestamp is the fact that supports it. Seeding
 * one without the other produced 1.887 reports that read as closed to the list
 * and as never-resolved to every SLA consumer. Triage lands early in the report
 * s life, closure somewhere after it — both bounded by the row's own age so a
 * 200-day-old report cannot be closed tomorrow.
 */
function welfareLifecycleStamps(
  status: "open" | "closed" | "triaged" | "in_progress",
  createdAt: Date,
  ageDays: number,
  rng: () => number,
): { triagedAt?: Date; closedAt?: Date } {
  if (status === "open") return {};
  const day = 24 * 3600 * 1000;
  // Triage: within the first ~20% of the report's life, capped at 7 days.
  const triageDays = Math.min(7, Math.max(0.25, ageDays * 0.2 * rng()));
  const triagedAt = new Date(createdAt.getTime() + triageDays * day);
  if (status === "triaged" || status === "in_progress") return { triagedAt };
  // Closure: after triage, inside the remaining age.
  const closeDays = triageDays + Math.max(0.5, (ageDays - triageDays) * rng());
  return {
    triagedAt,
    closedAt: new Date(createdAt.getTime() + Math.min(ageDays, closeDays) * day),
  };
}

function pickHistoricalWelfareStatus(
  ageDays: number,
): "open" | "closed" | "triaged" | "in_progress" {
  let closedProb: number;
  if (ageDays <= 30) {
    closedProb = 0.1 + (ageDays / 30) * 0.2; // 10% → 30%
  } else if (ageDays <= 180) {
    closedProb = 0.3 + ((ageDays - 30) / 150) * 0.55; // 30% → 85%
  } else {
    closedProb = 0.9; // old rows: 90% terminal — the remaining 10% is the backlog exception
  }
  if (rng() < closedProb) return "closed";
  const rest = rng();
  if (rest < 0.7) return "open";
  if (rest < 0.9) return "triaged";
  return "in_progress";
}

async function seedHistoryWelfareAndCases(
  localitiesByCode: Map<string, LocalityRow[]>,
): Promise<{ welfare: number; decomisos: number; disputes: number }> {
  log("STEP", "Seeding multi-year welfare_reports + cases history (all provinces)…");

  const ANCHOR = new Date(ANCHOR_ISO);
  const WEL_BATCH = 200;

  const SEIZURE_MOTIVES_HIST = [
    "maltrato",
    "abandono",
    "tenencia_ilegal",
    "orden_judicial",
  ] as const;

  let welIdx = 0;
  let totalWelfare = 0;
  let totalDecomisos = 0;
  let totalDisputes = 0;

  for (const province of PROVINCES) {
    const provinceName = province.name;
    const code = PROVINCE_TO_CODE.get(provinceName);
    const localities = code ? (localitiesByCode.get(code) ?? []) : [];

    if (localities.length === 0) {
      log("WARN", `  [HIST-WEL] ${provinceName}: no localities — skipping`);
      continue;
    }

    const { archetype } = provinceProfile(provinceName);

    // Per-province monthly base rate: minimum 2, grows with locality count so
    // provinces with more localities (Buenos Aires ~2000, Córdoba ~532) produce
    // proportionally more welfare events than smaller provinces.
    const monthlyBase = HISTORY_SCALE * Math.max(2, Math.round(localities.length / 80));

    // ---- welfare_reports ----
    const welRows: Array<Record<string, unknown>> = [];

    for (const year of HISTORY_YEARS) {
      for (let month = 0; month < 12; month++) {
        const n = monthlyEventCount(monthlyBase, archetype, year, month, rng);
        for (let w = 0; w < n; w++) {
          const loc = localities[Math.floor(rng() * localities.length)];
          const { lat, lng } = jitteredCoord(loc.lat, loc.lng, 0.05);
          // createdAt must be set explicitly so the consumer's
          // gte(welfareReports.createdAt, since) filter returns these history rows.
          const createdAt = pickDateInMonth(year, month, rng, ANCHOR);
          const ageDays = Math.max(0, (ANCHOR_MS - createdAt.getTime()) / (24 * 3600 * 1000));
          const kindEntry = pickWeighted(
            WELFARE_KINDS as unknown as Array<{ kind: string; weight: number }>,
          );
          const status = pickHistoricalWelfareStatus(ageDays);
          // Old-open is the realistic-backlog EXCEPTION (see
          // pickHistoricalWelfareStatus) — it must not ALSO skew critical
          // (the pre-fix "930-day-old critical open" symptom), so it draws
          // from the low/medium-skewed backlog severity table instead of the
          // normal distribution.
          const isOldOpenBacklog = status === "open" && ageDays > 180;
          const sevEntry = pickWeighted(
            (isOldOpenBacklog
              ? WELFARE_SEVERITIES_BACKLOG
              : WELFARE_SEVERITIES) as unknown as Array<{ severity: string; weight: number }>,
          );

          welRows.push({
            referenceCode: generateReferenceCode(),
            kind: kindEntry.kind,
            severity: sevEntry.severity,
            description: pickWelfareDescription(kindEntry.kind),
            // Internal-only cleanup marker — NEVER rendered (migration 0155).
            // welIdx is retained purely for correlation/debugging inside this
            // column, never in the description text.
            seedTag: `PANO-HIST-${String(welIdx).padStart(6, "0")}`,
            subjectKind: pick(["unowned_animal", "location", "general", "unowned_animal"] as const),
            status,
            flagReasons: [],
            jurisdictionProvince: provinceName,
            jurisdictionLocality: loc.localityName,
            // Same FK as the live seed above (L4·1). NOT `loc.id`: the CABA
            // barrios injected by injectCabaBarrios carry a synthetic
            // "caba-barrio-<slug>" id, so the catalog resolver is the only
            // honest source — and it is memoized per (province, locality).
            localityId: await resolveLocalityId(provinceName, loc.localityName),
            locationLat: lat.toFixed(7),
            locationLng: lng.toFixed(7),
            occurredAt: createdAt,
            createdAt,
            // The C5 fix correlated STATUS with age but never wrote the
            // matching timestamps, so all 1.887 seeded "closed" reports had
            // closed_at = NULL. That is not cosmetic: SlaBadge and every
            // response-time metric read those columns, so a resolved report
            // presented as breached-forever (adversarial review 2026-07-25).
            // A terminal status without its instant is a lie about the spine.
            ...welfareLifecycleStamps(status, createdAt, ageDays, rng),
          });
          welIdx++;
        }
      }
    }

    for (let b = 0; b < welRows.length; b += WEL_BATCH) {
      const batch = welRows.slice(b, b + WEL_BATCH);
      await db.insert(welfareReports).values(
        batch as Parameters<typeof db.insert<typeof welfareReports>>[0] extends {
          values: (v: infer V) => unknown;
        }
          ? V
          : never,
      );
    }
    totalWelfare += welRows.length;

    // ---- cases: custody_episode (decomiso) + custody_dispute per quarter ----
    // One location is drawn per quarter-slot so all cases in that slot share a
    // single locality (realistic — a seizure event clusters geographically).
    let provDecomisos = 0;
    let provDisputes = 0;

    for (const year of HISTORY_YEARS) {
      for (const quarterMonth of [0, 3, 6, 9] as const) {
        const loc = localities[Math.floor(rng() * localities.length)];
        const { lat, lng } = jitteredCoord(loc.lat, loc.lng, 0.05);
        const openedAt = pickDateInMonth(year, quarterMonth, rng, ANCHOR);

        // 1–2 decomisos (custody_episode) per quarter per province.
        // Panorama's loadDecomisos queries case_kind='custody_episode'.
        const deciCount = 1 + (rng() < 0.4 ? 1 : 0);
        for (let d = 0; d < deciCount; d++) {
          const motive = pick(SEIZURE_MOTIVES_HIST);
          const isClosed = rng() < 0.45;
          // cases_closed_consistency: (status IN ('closed','merged')) = (closedAt IS NOT NULL)
          const closedAt = isClosed
            ? new Date(
                Math.min(
                  openedAt.getTime() + (1 + Math.floor(rng() * 89)) * 86_400_000,
                  ANCHOR.getTime(),
                ),
              )
            : null;
          const decCode = await allocateCasePublicCode();
          if (!decCode) {
            log("WARN", "  could not allocate CAS code for HIST decomiso — skipping");
            continue;
          }
          await db.insert(cases).values({
            publicCode: decCode,
            caseKind: "custody_episode",
            status: isClosed ? "closed" : "open",
            // 'location' subject: satisfies cases_subject_location_consistency by
            // providing locationLat/Lng; primaryPetId stays null.
            primarySubjectKind: "location",
            locationLat: lat.toFixed(7),
            locationLng: lng.toFixed(7),
            jurisdictionCountry: "AR",
            jurisdictionProvince: provinceName,
            jurisdictionLocality: loc.localityName,
            // Matches the real decomiso writer's grammar exactly (see :2325) so
            // the display layer translates it. The "(Ley 14.346) seed histórico"
            // this carried broke the regex twice over and surfaced raw.
            openedReason: `auto: decomiso motivo=${motive} judicial_ref=sin_ref`,
            openedAt,
            ...(isClosed && closedAt ? { closedAt, closedReason: "resolved" as const } : {}),
          } as Parameters<typeof db.insert<typeof cases>>[0] extends {
            values: (v: infer V) => unknown;
          }
            ? V
            : never);
          provDecomisos++;
        }

        // 1 custody_dispute per quarter (mix open/closed; open ones surface in
        // fetchAnalyticsMetrics custodyDisputes count).
        const disIsClosed = rng() < 0.5;
        const disClosedAt = disIsClosed
          ? new Date(
              Math.min(
                openedAt.getTime() + (1 + Math.floor(rng() * 89)) * 86_400_000,
                ANCHOR.getTime(),
              ),
            )
          : null;
        const disCode = await allocateCasePublicCode();
        if (!disCode) {
          log("WARN", "  could not allocate CAS code for HIST dispute — skipping");
          continue;
        }
        await db.insert(cases).values({
          publicCode: disCode,
          caseKind: "custody_dispute",
          status: disIsClosed ? "closed" : "open",
          primarySubjectKind: "location",
          locationLat: lat.toFixed(7),
          locationLng: lng.toFixed(7),
          jurisdictionCountry: "AR",
          jurisdictionProvince: provinceName,
          jurisdictionLocality: loc.localityName,
          openedReason: "auto: disputa de custodia entre partes",
          openedAt,
          ...(disIsClosed && disClosedAt
            ? { closedAt: disClosedAt, closedReason: "resolved" as const }
            : {}),
        } as Parameters<typeof db.insert<typeof cases>>[0] extends {
          values: (v: infer V) => unknown;
        }
          ? V
          : never);
        provDisputes++;
      }
    }

    totalDecomisos += provDecomisos;
    totalDisputes += provDisputes;

    log(
      "INFO",
      `  [HIST-WEL] ${provinceName} (${archetype}): ${welRows.length} welfare, ` +
        `${provDecomisos} decomisos, ${provDisputes} disputes`,
    );
  }

  log(
    "INFO",
    `  History welfare+cases: ${totalWelfare} welfare_reports, ` +
      `${totalDecomisos} decomisos, ${totalDisputes} disputes`,
  );
  return { welfare: totalWelfare, decomisos: totalDecomisos, disputes: totalDisputes };
}

// ---------------------------------------------------------------------------
// 15f. Historical campaigns 2024-2026 — service_offerings + time_slots + appointments
// ---------------------------------------------------------------------------
// Backs /gob/campanas year-over-year trend: fetchCampaignDashboard filters
// appointments by appointments.createdAt within the period window. Adding
// historical offerings + appointments with createdAt in 2024/2025/2026 gives
// the dashboard real multi-year enrollment data.
//
// One offering per org × year × quarter (10 per org: 4+4+2 for 2024/2025/2026).
// Three slots per offering (one per month in the quarter, fixed to the 15th).
// Appointments createdAt is set explicitly to the booking year so the period
// filter returns non-empty for any 12-month window anchored to that year.
//
// Idempotency:
//   PANO-SVO-HIST-* → caught by existing runClean() `PANO-SVO-%` LIKE pattern
//   PANO-APT-HIST-* → caught by existing runClean() `PANO-APT-%` LIKE pattern
// No runClean() change required.

async function seedHistoryCampaigns(
  ownerUserId: string,
  shelterOrgs: PanoOrg[],
): Promise<{ offerings: number; slots: number; appointments: number }> {
  log("STEP", "Seeding historical campaigns 2024-2026 (service_offerings + appointments)…");

  if (shelterOrgs.length === 0) {
    log("WARN", "  No PANO orgs available — skipping historical campaigns");
    return { offerings: 0, slots: 0, appointments: 0 };
  }

  // Pre-fetch PANO pet IDs per province. Appointments need a valid pet_id FK.
  const petPoolRows = await db
    .select({ id: pets.id, province: pets.jurisdictionProvince })
    .from(pets)
    .where(like(pets.publicToken, `${PANO_TAG}%`));

  const petsByProvince = new Map<string, string[]>();
  for (const r of petPoolRows) {
    const key = r.province ?? "Buenos Aires";
    if (!petsByProvince.has(key)) petsByProvince.set(key, []);
    petsByProvince.get(key)!.push(r.id);
  }
  const allPetIds = petPoolRows.map((r) => r.id);

  if (allPetIds.length === 0) {
    log("WARN", "  No PANO pets found — skipping historical campaigns");
    return { offerings: 0, slots: 0, appointments: 0 };
  }

  // Q0=Jan-Mar, Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec (0-indexed month triplets)
  const QUARTERS: ReadonlyArray<readonly [number, number, number]> = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [9, 10, 11],
  ];

  // For 2026 only emit Q0 (Jan-Mar) and Q1 (Apr-Jun): the anchor is 2026-06-20,
  // so Q2/Q3 start dates are in the future. Fixed slot date is the 15th, which
  // gives Jun-15 < Jun-20 for Q1 month 5 — safely in the past.
  const YEAR_QUARTERS: ReadonlyArray<{ year: HistoryYear; quarters: readonly number[] }> = [
    { year: 2024, quarters: [0, 1, 2, 3] },
    { year: 2025, quarters: [0, 1, 2, 3] },
    { year: 2026, quarters: [0, 1] },
  ];

  let histSvoIdx = 0;
  let histAptIdx = 0;
  let totalSlots = 0;
  let totalAppointments = 0;

  for (const org of shelterOrgs) {
    const demand = PROVINCE_CAMPAIGN_DEMAND[org.provinceName] ?? { demand: 0.5, attend: 0.55 };
    const provincePets = petsByProvince.get(org.provinceName) ?? [];
    const pool = provincePets.length >= 4 ? provincePets : allPetIds;
    const bookingProb = Math.min(0.95, CAMPAIGN_BOOKING_RATE * demand.demand + 0.05);

    for (const { year, quarters } of YEAR_QUARTERS) {
      for (const qIdx of quarters) {
        const qMonths = QUARTERS[qIdx];
        if (!qMonths) continue; // safety guard — qIdx is always 0-3
        const template = CAMPAIGN_TEMPLATES[histSvoIdx % CAMPAIGN_TEMPLATES.length];
        const svoToken = `PANO-SVO-HIST-${String(histSvoIdx).padStart(5, "0")}`;
        histSvoIdx++;

        const effFrom = new Date(Date.UTC(year, qMonths[0], 1)).toISOString().slice(0, 10);
        // Last day of quarter: month after last quarter month, day 0 = last day of prev month
        const effUntil = new Date(Date.UTC(year, qMonths[2] + 1, 0)).toISOString().slice(0, 10);

        const [offeringRow] = await db
          .insert(serviceOfferings)
          .values({
            publicToken: svoToken,
            organizationId: org.id,
            jurisdictionCountry: "AR",
            jurisdictionProvince: org.provinceName,
            jurisdictionLocality: org.locality,
            serviceKind: template.kind,
            // NO "PANO —" prefix — see rationale above (panoName() comment,
            // ~line 277) applied here to campaign offerings.
            displayName: `${template.label} ${year} Q${qIdx + 1} (${org.locality})`,
            description: "Campaña histórica sintética de demostración (seed-panorama)",
            durationMinutes: template.durationMinutes,
            slotCapacity: template.slotCapacity,
            eligibilitySpecies: [...template.species],
            status: "approved",
            isPublic: false,
          } as Parameters<typeof db.insert<typeof serviceOfferings>>[0] extends {
            values: (v: infer V) => unknown;
          }
            ? V
            : never)
          .returning({ id: serviceOfferings.id });

        // One weekly schedule rule covering the quarter.
        const [ruleRow] = await db
          .insert(serviceScheduleRules)
          .values({
            serviceOfferingId: offeringRow.id,
            daysOfWeek: [1, 3, 5],
            startTimeLocal: "09:00:00",
            endTimeLocal: "12:00:00",
            effectiveFrom: effFrom,
            effectiveUntil: effUntil,
            status: "active",
          } as Parameters<typeof db.insert<typeof serviceScheduleRules>>[0] extends {
            values: (v: infer V) => unknown;
          }
            ? V
            : never)
          .returning({ id: serviceScheduleRules.id });

        // Three slots: one per month in the quarter, pinned to the 15th at
        // staggered hours (9, 11, 13 UTC) to satisfy the
        // time_slots_unique_starts (serviceOfferingId, startsAt) constraint
        // even if two months accidentally share a calendar day.
        for (let mIdx = 0; mIdx < 3; mIdx++) {
          const month = qMonths[mIdx];
          // Fixed day-of-month (15) keeps the date predictable and always < 28,
          // safe for all months. Hour stagger ensures uniqueness within offering.
          const startsAt = new Date(Date.UTC(year, month, 15, 9 + mIdx * 2, 0, 0, 0));
          const endsAt = new Date(startsAt.getTime() + template.durationMinutes * 60 * 1000);
          const capacity = template.slotCapacity;

          // Guarantee at least one booking so every offering shows enrollment.
          let bookings = 0;
          for (let c = 0; c < capacity; c++) {
            if (rng() < bookingProb) bookings++;
          }
          if (bookings === 0) bookings = 1;

          // Distinct pets per slot — same reason as the forward-looking block
          // above: sampling with replacement wrote two appointments for one
          // (pet, slot). These are all terminal (attended/no_show) so they do
          // not trip migration 0177's partial index, but "the same animal
          // no-showed the same appointment twice" is not history anyone should
          // read off a national dashboard.
          const slotPets: string[] = [];
          const usedPets = new Set<string>();
          for (let b = 0; b < bookings && usedPets.size < pool.length; b++) {
            for (let attempt = 0; attempt < 8; attempt++) {
              const candidate = pool[Math.floor(rng() * pool.length)];
              if (usedPets.has(candidate)) continue;
              usedPets.add(candidate);
              slotPets.push(candidate);
              break;
            }
          }
          bookings = slotPets.length;

          const [slotRow] = await db
            .insert(timeSlots)
            .values({
              serviceOfferingId: offeringRow.id,
              ruleId: ruleRow.id,
              startsAt,
              endsAt,
              capacity,
              bookingsCount: bookings,
              status: bookings >= capacity ? "full" : "open",
            } as Parameters<typeof db.insert<typeof timeSlots>>[0] extends {
              values: (v: infer V) => unknown;
            }
              ? V
              : never)
            .returning({ id: timeSlots.id });
          totalSlots++;

          // Appointments — all historical slots are in the past: attended / no_show.
          // createdAt is set explicitly to a few days before the slot start so the
          // fetchCampaignDashboard period filter (gte/lt on createdAt) returns these
          // rows when the window is scoped to `year`.
          const apptRows: Array<Record<string, unknown>> = [];
          for (const petId of slotPets) {
            const aptToken = `PANO-APT-HIST-${String(histAptIdx).padStart(6, "0")}`;
            histAptIdx++;

            const attended = rng() < demand.attend;
            const status = attended ? "attended" : ("no_show" as const);
            const attendedAt = attended
              ? new Date(startsAt.getTime() + template.durationMinutes * 60 * 1000)
              : null;
            const noShowMarkedAt = !attended ? new Date(startsAt.getTime() + 30 * 60 * 1000) : null;

            // Book 2–10 days before the slot, floored at Jan 1 of the year.
            const leadDays = randInt(2, 10);
            const createdAt = new Date(
              Math.max(startsAt.getTime() - leadDays * 24 * 3600 * 1000, Date.UTC(year, 0, 1)),
            );

            apptRows.push({
              publicToken: aptToken,
              slotId: slotRow.id,
              petId,
              ownerUserId,
              serviceOfferingId: offeringRow.id,
              organizationId: org.id,
              status,
              ...(attendedAt ? { attendedAt, attendedByUserId: ownerUserId } : {}),
              ...(noShowMarkedAt ? { noShowMarkedAt } : {}),
              createdAt,
              updatedAt: createdAt,
            });
            totalAppointments++;
          }

          if (apptRows.length > 0) {
            await db.insert(appointments).values(
              apptRows as Parameters<typeof db.insert<typeof appointments>>[0] extends {
                values: (v: infer V) => unknown;
              }
                ? V
                : never,
            );
          }
        }
      }
    }
  }

  log(
    "INFO",
    `  Historical campaigns: ${histSvoIdx} offerings, ${totalSlots} slots, ${totalAppointments} appointments`,
  );
  return { offerings: histSvoIdx, slots: totalSlots, appointments: totalAppointments };
}

// ---------------------------------------------------------------------------
// 15g. Novedades-feed variety tail (C5 fix)
// ---------------------------------------------------------------------------
// The "Novedades" operator-orientation feed (lib/metrics/novedades-feed.ts)
// orders by pet_events.recorded_at DESC — TRANSACTION time, which every
// insert above defaults to `now()` at actual script-run time (none of them
// set recorded_at explicitly). Its 5 feed types are outbreak_signal,
// disease_reported, rabies_observation_started, incident_reported, and
// custody_dispute_raised (novedades-feed-links.ts FEED_EVENT_TYPES). The bulk
// historical loop above (seedModelProvinceHistory) emits incident_reported
// at FAR higher volume than the other 4 types, so once every row shares
// approximately the same recorded_at instant, ties resolve arbitrarily and
// the feed reads as a monotonous incident_reported wall (C5 audit finding).
//
// This runs LAST, after every other pet_events-writing step in main() —
// its rows get the newest recorded_at of the whole script run and therefore
// deterministically win the DESC ordering, guaranteeing the feed's top shows
// a genuine mix of all 5 types across a few different localities, regardless
// of the bulk-volume asymmetry elsewhere.
async function seedFeedVarietyTail(ownerUserId: string, shelterOrgs: PanoOrg[]): Promise<number> {
  log("STEP", "Seeding novedades-feed variety tail (5 feed types, distinct localities)…");

  // ORDER BY public_token, not "whatever the heap hands back": an unordered
  // LIMIT returns physical order, and by the time this step runs the seed has
  // UPDATEd pets rows repeatedly (status='lost', cache columns,
  // in_custody_dispute), so the same script produced a DIFFERENT slice on
  // different runs. That variance is what made the custody_dispute insert below
  // collide with seedEnforcementCases's disputes only *sometimes*.
  //
  // Four of the five feed types write pet_events only, so the pool itself needs
  // no case guard — the dispute target gets its own guarded pool below.
  const candidates = await selectSeedPetsOrdered({ tokenPrefix: PANO_TAG, limit: 60 });

  if (candidates.length === 0) {
    log("WARN", "  No PANO pets found — skipping feed variety tail");
    return 0;
  }

  // De-dup to distinct localities, cap at 5 — one pet per type/locality pair.
  const seenLocalities = new Set<string>();
  const targets: typeof candidates = [];
  for (const c of candidates) {
    const key = `${c.province ?? ""}|${c.locality ?? ""}`;
    if (seenLocalities.has(key)) continue;
    seenLocalities.add(key);
    targets.push(c);
    if (targets.length >= 5) break;
  }
  // Fall back to repeating the first candidate if fewer than 5 distinct
  // localities exist (tiny local dev DBs) — variety of TYPE still holds.
  while (targets.length < 5 && candidates.length > 0) {
    targets.push(candidates[targets.length % candidates.length]);
  }

  const now = new Date();
  let inserted = 0;

  // 1) incident_reported (bite) — also the anchor for the chained
  // rabies_observation_started below.
  const [biteTarget] = targets;
  const [biteEvent] = await db
    .insert(petEvents)
    .values({
      petId: biteTarget.id,
      eventType: "incident_reported" satisfies EventType,
      occurredAt: now,
      recordedByUserId: ownerUserId,
      authorRole: "vet",
      authorVerified: true,
      payload: {
        source: "seed-panorama-feed-variety",
        incident_type: "bite_inflicted",
        severity: "moderate",
        injuries_summary: "Mordedura reportada esta semana (seed-panorama variety tail)",
        vet_involved: true,
        location_description: biteTarget.locality ?? biteTarget.province ?? "",
        rabies_vaccine_valid_at_incident: true,
      },
    })
    .returning({ id: petEvents.id });
  inserted++;

  // 2) rabies_observation_started — chained off the bite event above.
  await db.insert(petEvents).values({
    petId: biteTarget.id,
    eventType: "rabies_observation_started" satisfies EventType,
    occurredAt: now,
    recordedByUserId: ownerUserId,
    authorRole: "vet",
    authorVerified: true,
    payload: {
      source: "seed-panorama-feed-variety",
      bite_event_id: biteEvent.id,
      observation_until: new Date(now.getTime() + 10 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      location: "in_situ",
      official_site_organization_id: null,
    },
  });
  inserted++;

  // 3) outbreak_signal.
  const outbreakTarget = targets[1] ?? targets[0];
  await db.insert(petEvents).values({
    petId: outbreakTarget.id,
    eventType: "outbreak_signal" satisfies EventType,
    occurredAt: now,
    recordedByUserId: ownerUserId,
    authorRole: "govt",
    authorVerified: true,
    payload: {
      source: "seed-panorama-feed-variety",
      disease_code: "rabies_suspected",
      disease_label: "Rabia (sospechada)",
      pet_jurisdiction_province: outbreakTarget.province,
      pet_jurisdiction_locality: outbreakTarget.locality,
      status: "open",
    },
  });
  inserted++;

  // 4) disease_reported.
  const diseaseTarget = targets[2] ?? targets[0];
  await db.insert(petEvents).values({
    petId: diseaseTarget.id,
    eventType: "disease_reported" satisfies EventType,
    occurredAt: now,
    recordedByUserId: ownerUserId,
    authorRole: "vet",
    authorVerified: true,
    payload: {
      source: "seed-panorama-feed-variety",
      disease: "lepto",
      confirmed_by_lab: false,
      date_of_onset: new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      clinical_notes:
        "Caso reciente reportado por veterinario tratante (seed-panorama variety tail)",
    },
  });
  inserted++;

  // 5) custody_dispute_raised — needs its case + custody_disputes rows,
  // mirroring seedEnforcementCases's lockstep (case ↔ pet_event ↔ dispute).
  //
  // This is the only one of the five that OPENS a case, so it is the only one
  // `cases_open_per_pet_kind_idx` can reject. targets[3] came from the ordered
  // pool above with no regard for existing cases, and seedEnforcementCases has
  // already opened five custody_dispute cases on PANO pets by the time this
  // runs — pick from a NOT EXISTS-guarded pool instead, keeping targets[3]
  // whenever it is legal so the locality spread is unchanged in the common case.
  const disputeCandidates = await selectPetsWithoutOpenCase({
    tokenPrefix: PANO_TAG,
    caseKind: "custody_dispute",
    limit: 200,
  });
  const intendedDisputeTarget = targets[3] ?? targets[0];
  // Localities already spoken for by the four event-only items (targets[0..2];
  // targets[4] is the spare the de-dup loop collects but nothing writes to).
  const localityKey = (t: { province: string | null; locality: string | null }): string =>
    `${t.province ?? ""}|${t.locality ?? ""}`;
  const otherLocalities = new Set(targets.slice(0, 3).map(localityKey));
  const disputeTarget =
    disputeCandidates.find((c) => c.id === intendedDisputeTarget.id) ??
    disputeCandidates.find((c) => !otherLocalities.has(localityKey(c))) ??
    disputeCandidates[0];

  if (!disputeTarget) {
    const localities = new Set(targets.slice(0, 3).map(localityKey)).size;
    log(
      "WARN",
      "  Every PANO pet already has an open custody_dispute — skipping the " +
        "custody_dispute_raised item. The feed tail carries 4 of its 5 types this run.",
    );
    log(
      "OK",
      `  Feed variety tail: incident_reported, rabies_observation_started, outbreak_signal, disease_reported (${inserted} events, ${localities} distinct localities)`,
    );
    void shelterOrgs;
    return inserted;
  }

  if (disputeTarget.id !== intendedDisputeTarget.id) {
    log(
      "INFO",
      `  Dispute target moved to ${disputeTarget.publicToken} — the locality-spread pick already had an open custody_dispute (one open case per pet per kind).`,
    );
  }

  // Unreachable by construction — the pool above is NOT EXISTS-guarded on the
  // same predicate as the index. Kept as a tripwire: if someone later swaps the
  // guarded pool for a plain LIMIT, this fails with the reason instead of with
  // a bare `duplicate key value violates unique constraint` from Postgres.
  const conflicting = await findOpenCasesOfKind(disputeTarget.id, "custody_dispute");
  if (conflicting.length > 0) {
    throw new Error(
      `seedFeedVarietyTail: pet ${disputeTarget.publicToken} already has an open custody_dispute (${conflicting.map((c) => c.publicCode).join(", ")}). The open-case guard was bypassed — see scripts/seed-case-guards.ts.`,
    );
  }

  const disputeProv = disputeTarget.province ?? "Buenos Aires";
  const disputeLocality = disputeTarget.locality ?? "Sin especificar";

  const [disputeCase] = await db
    .insert(cases)
    .values({
      publicCode: `PANO-CASE-VARIETY-${String(Date.now()).slice(-6)}`,
      caseKind: "custody_dispute",
      status: "open",
      primarySubjectKind: "registered_pet",
      primaryPetId: disputeTarget.id,
      jurisdictionCountry: "AR",
      jurisdictionProvince: disputeProv,
      jurisdictionLocality: disputeLocality,
      openedReason: "auto: disputa de custodia entre partes",
      openedAt: now,
    } as Parameters<typeof db.insert<typeof cases>>[0] extends {
      values: (v: infer V) => unknown;
    }
      ? V
      : never)
    .returning({ id: cases.id });

  const [raisingEvent] = await db
    .insert(petEvents)
    .values({
      petId: disputeTarget.id,
      eventType: "custody_dispute_raised" satisfies EventType,
      occurredAt: now,
      authorRole: "govt",
      payload: { source: "seed-panorama-feed-variety", motive: "disputa de custodia" },
    })
    .returning({ id: petEvents.id });
  inserted++;

  const [dispute] = await db
    .insert(custodyDisputes)
    .values({
      publicToken: `DIS-PANO-VARIETY-${String(Date.now()).slice(-6)}`,
      petId: disputeTarget.id,
      raisedByRole: "govt",
      raisingEventId: raisingEvent.id,
      jurisdictionCountry: "AR",
      jurisdictionProvince: disputeProv,
      jurisdictionLocality: disputeLocality,
      status: "open",
    })
    .returning({ id: custodyDisputes.id });

  await db
    .update(cases)
    .set({ custodyDisputeId: dispute.id, updatedAt: new Date() })
    .where(eq(cases.id, disputeCase.id));
  await db.update(pets).set({ inCustodyDispute: true }).where(eq(pets.id, disputeTarget.id));

  // `inserted` is the true pet_events count — the old log said `inserted + 1`
  // and reported 6 events for the 5 this step writes. The locality count is
  // likewise the localities actually WRITTEN TO, not the size of the candidate
  // shortlist (targets[4] is collected by the de-dup loop and never used).
  const localitiesTouched = new Set([...targets.slice(0, 3), disputeTarget].map(localityKey)).size;
  log(
    "OK",
    `  Feed variety tail: incident_reported, rabies_observation_started, outbreak_signal, disease_reported, custody_dispute_raised (${inserted} events, ${localitiesTouched} distinct localities)`,
  );

  // Note: intentionally NOT using shelterOrgs here — the variety tail's
  // authorship is deliberately owner/vet/govt-mixed, matching the "current"
  // set-piece style above rather than org attribution.
  void shelterOrgs;

  return inserted;
}

// ---------------------------------------------------------------------------
// 16. Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("STEP", "=== seed-panorama: Panorama demo dataset ===");
  log("INFO", `PETS_PER_CAPITA=${PETS_PER_CAPITA}  SCALE=${SCALE}  WINDOW_DAYS=${WINDOW_DAYS}`);
  log("INFO", `DRY_RUN=${DRY_RUN}  CLEAN=${CLEAN}  ALLOW_REMOTE=${ALLOW_REMOTE}`);
  log("INFO", `ANCHOR_DATE=${ANCHOR_ISO}`);

  if (DRY_RUN) {
    log("INFO", "DRY RUN — no writes. Estimating counts:");
    // Prefer the REAL census (same source the seed uses) so the preview shows
    // the counts an actual run would produce — that is the whole point of
    // previewing PANO_PROVINCE_BOOST before writing. Fall back to a mock
    // uniform population when the DB is unreachable (the historical behavior).
    let censusRows: CensusRow[];
    let censusSource = "jurisdictions_census";
    try {
      censusRows = await loadCensus();
      if (censusRows.length === 0) throw new Error("jurisdictions_census is empty");
    } catch {
      censusRows = PROVINCES.map((p) => ({ provinceName: p.name, population: 1_000_000 }));
      censusSource = "mock 1M pop each province (DB unreachable)";
    }
    let baseTotal = 0;
    let boostedTotal = 0;
    for (const c of censusRows) {
      const base = Math.max(1, Math.round(c.population * PETS_PER_CAPITA * SCALE));
      const boosted = boostedProvinceCount(base, c.provinceName, PROVINCE_BOOST);
      baseTotal += base;
      boostedTotal += boosted;
      if (boosted !== base) {
        log(
          "INFO",
          `  ${c.provinceName}: ${base} → ${boosted} pets (boost ×${PROVINCE_BOOST.get(c.provinceName)})`,
        );
      }
    }
    if (PROVINCE_BOOST.size > 0) {
      log(
        "INFO",
        `  Would insert ~${boostedTotal} pets total (~${baseTotal} without boost; ${censusSource})`,
      );
    } else {
      log("INFO", `  Would insert ~${baseTotal} pets (${censusSource})`);
    }
    process.exit(0);
  }

  // Always clean PANO data before re-inserting (idempotent)
  await runClean();

  if (CLEAN) {
    log("DONE", "Clean-only mode — exiting.");
    process.exit(0);
  }

  // Load reference data
  const [localitiesByCode, census] = await Promise.all([loadLocalities(), loadCensus()]);

  // Swap CABA's whole-city placeholder locality for the 48 real barrios so CABA
  // pets/events distribute across barrios instead of one undifferentiated blob.
  injectCabaBarrios(localitiesByCode);

  if (census.length === 0) {
    log("FAIL", "jurisdictions_census is empty — run db:bootstrap first.");
    process.exit(1);
  }

  // Seed organizations
  const shelterOrgs = await seedOrganizations(localitiesByCode);

  // Seed owner profile
  const ownerUserId = await findOrCreateSeedOwnerProfileId();
  log("INFO", `Using owner profile: ${ownerUserId}`);

  // Seed pets
  const { totalPets, lostPets, deceasedPets, eventCounts, globalIndex } = await seedPets(
    localitiesByCode,
    census,
    ownerUserId,
    shelterOrgs,
  );

  // Seed set-pieces
  const { globalIndex: finalIndex, eventCounts: setPieceEventCounts } = await seedSetPieces(
    localitiesByCode,
    ownerUserId,
    globalIndex,
  );

  for (const [k, v] of Object.entries(setPieceEventCounts)) {
    eventCounts[k] = (eventCounts[k] ?? 0) + v;
  }

  // Backfill CAS- cases for every pet currently status=lost (includes demo
  // storyline pets seeded before panorama and PANO set-pieces above).
  const lostEpisodes = await seedLostPetEpisodeCases(ownerUserId);

  // Seed bite/incident events (~200 national)
  const biteCount = Math.round(totalPets * 0.004);
  const insertedBites = await seedBiteEvents(ownerUserId, census, localitiesByCode, biteCount);
  eventCounts.incident_reported = (eventCounts.incident_reported ?? 0) + insertedBites;

  // Seed welfare reports (~300 national)
  const welfareCount = Math.round(totalPets * 0.006);
  const insertedWelfare = await seedWelfareReports(localitiesByCode, census, welfareCount);

  // Seed vigilancia chain (rabies observations + ENO SLA surfaces).
  const vigilance = await seedVigilanceChain(ownerUserId, shelterOrgs);
  eventCounts.rabies_observation_started =
    (eventCounts.rabies_observation_started ?? 0) + vigilance.observations;

  // Seed enforcement cases (decomisos + custody disputes).
  const enforcement = await seedEnforcementCases();

  // Seed health campaigns (service_offerings + slots + appointments) → /gob/campanas.
  const campaigns = await seedHealthCampaigns(ownerUserId, shelterOrgs);

  // Seed multi-year, locality-level history for ALL provinces. Additive —
  // uses PANO-HIST- names so runClean cleans it. Runs LAST so it does not
  // perturb the main seed's RNG-dependent counts above.
  const history = await seedModelProvinceHistory(localitiesByCode, ownerUserId);
  for (const [k, v] of Object.entries(history.eventCounts)) {
    eventCounts[k] = (eventCounts[k] ?? 0) + v;
  }

  // Seed multi-year welfare_reports + enforcement cases (denuncias + decomisos
  // + custody disputes) history across 2024-2026 for ALL provinces.
  // Runs after seedModelProvinceHistory to preserve RNG sequence for pet events.
  const historyWelfCases = await seedHistoryWelfareAndCases(localitiesByCode);

  // Seed multi-year historical campaigns (2024-2026). Runs last so pet pool
  // is fully populated when appointments FK into pets.
  const historyCampaigns = await seedHistoryCampaigns(ownerUserId, shelterOrgs);

  // Demo compliance coverage (demo-blocker B2): the microchip-penetration metric
  // reads pet_identifications (not events) and the rabies metric scopes by the
  // payload's pet_jurisdiction_province/locality keys — both were empty, so they
  // read 0% across every jurisdiction. Backfill microchip identifications +
  // province-keyed rabies events (varied per province) so no panel shows a
  // universal-0 outlier. Idempotent.
  const { seedDemoComplianceCoverage } = await import("./seed-demo-compliance-coverage");
  const demoCoverage = await seedDemoComplianceCoverage(db);

  // Novedades-feed variety tail — MUST run last among pet_events writers (see
  // the function's header comment): its recorded_at wins every DESC ordering.
  const feedVariety = await seedFeedVarietyTail(ownerUserId, shelterOrgs);

  // Final summary
  const totalEvents = Object.values(eventCounts).reduce((s, v) => s + v, 0);

  log("DONE", "=== seed-panorama complete ===");
  log("INFO", `Total pets inserted     : ${totalPets + (finalIndex - globalIndex) + history.pets}`);
  log("INFO", `  Lost                  : ${lostPets}`);
  log(
    "INFO",
    `  Lost CAS cases        : +${lostEpisodes.created} (${lostEpisodes.skipped} skipped)`,
  );
  log("INFO", `  Deceased              : ${deceasedPets}`);
  log("INFO", `Total events            : ${totalEvents}`);
  log("INFO", `Total welfare reports   : ${insertedWelfare}`);
  log("INFO", `Total orgs created      : ${shelterOrgs.length}`);
  log("INFO", `Rabies observations     : ${vigilance.observations}`);
  log("INFO", `Rabies-obs cases        : ${vigilance.cases}`);
  log("INFO", `ENO queue rows          : ${vigilance.enoQueue}`);
  log("INFO", `ENO outbox rows         : ${vigilance.outbox}`);
  log("INFO", `Decomisos (cases)       : ${enforcement.decomisos}`);
  log("INFO", `Custody disputes (cases): ${enforcement.disputes}`);
  log("INFO", `Campaign offerings      : ${campaigns.offerings}`);
  log("INFO", `Campaign time slots     : ${campaigns.slots}`);
  log(
    "INFO",
    `Campaign appointments   : ${campaigns.appointments} ` +
      `(${campaigns.attended} attended / ${campaigns.noShow} no-show / ${campaigns.confirmed} confirmed)`,
  );
  log(
    "INFO",
    `History pets (all prov) : ${history.pets} ` +
      `(${Object.keys(history.localitiesCovered).length} provinces covered)`,
  );
  log("INFO", `Hist welfare reports    : ${historyWelfCases.welfare}`);
  log("INFO", `Hist decomisos (cases)  : ${historyWelfCases.decomisos}`);
  log("INFO", `Hist disputes (cases)   : ${historyWelfCases.disputes}`);
  log("INFO", `Hist campaign offerings : ${historyCampaigns.offerings}`);
  log("INFO", `Hist campaign slots     : ${historyCampaigns.slots}`);
  log("INFO", `Hist campaign appts     : ${historyCampaigns.appointments}`);
  log(
    "INFO",
    `Demo coverage           : ${demoCoverage.chipsInserted} microchip ids + ` +
      `${demoCoverage.rabiesBackfilled} rabies events`,
  );
  log("INFO", `Feed variety tail       : ${feedVariety} events (5 feed types)`);
  log("INFO", "Event breakdown:");
  for (const [k, v] of Object.entries(eventCounts).sort((a, b) => b[1] - a[1])) {
    log("INFO", `  ${k.padEnd(35)}: ${v}`);
  }

  // Death-cache reconciliation — run BEFORE the hygiene gate, at the end of the
  // seed flow.
  //
  // WHY THIS EXISTS (2026-08-10). The main population path dual-writes
  // `pets.status = 'deceased'` alongside its `death_recorded` events (see the
  // `deceasedPetIds` loop above). The two SETPIECE paths do not — they push a
  // `death_recorded` into `extraEvents` and never touch the cache. Result,
  // measured on the local DB: 2.733 pets (8,4% of the padrón) with the event in
  // the append-only spine and `status='active'` in the cache.
  //
  // That is not a cosmetic mismatch. `repository-choropleth.ts` counts mortality
  // as `status='deceased'` while `repository-history.ts` counts
  // `death_recorded` events, so the SAME government screen showed 352 on the map
  // and 3.946 in the timeline below it — a factor of ten under one label.
  //
  // Reconciling here rather than patching each setpiece is deliberate: a THIRD
  // setpiece added later would reintroduce the drift, and this pass covers it by
  // construction. `death_recorded` is terminal per lib/projections/pet-status.ts,
  // so deriving from the spine is the correct direction — the log is the fact,
  // the column is the cache.
  log("STEP", "Reconciling deceased cache against the spine…");
  const reconciled = await db.execute(sql`
    update pets p
       set status = 'deceased',
           deceased_at = coalesce(p.deceased_at, e.occurred_at)
      from (
        select pet_id, min(occurred_at) as occurred_at
          from pet_events
         where event_type = 'death_recorded'
         group by pet_id
      ) e
     where e.pet_id = p.id
       and p.status <> 'deceased'
  `);
  log("OK", `Deceased cache reconciled — ${reconciled.length ?? 0} row(s) aligned to the spine.`);

  // Seed-hygiene gate (C5) — run at the END of the seed flow, in-process
  // (same DB connection semantics as the CLI/test), so a re-seed that
  // regresses a generator is caught right here, not just later in CI.
  // Non-fatal to the seed itself (data is already committed either way) —
  // logged loudly so whoever ran this script sees it immediately.
  log("STEP", "Running seed-hygiene gate…");
  const { findSeedHygieneOffenders } = await import("./check-seed-hygiene");
  const postgres = (await import("postgres")).default;
  const hygieneClient = postgres(DATABASE_URL, { max: 1, connect_timeout: 5 });
  const offenders = await findSeedHygieneOffenders(hygieneClient);
  await hygieneClient.end({ timeout: 1 }).catch(() => {});
  if (offenders.length > 0) {
    log(
      "FAIL",
      `Seed-hygiene gate: ${offenders.length} offender(s) — a renderable column carries a seed marker.`,
    );
    for (const o of offenders.slice(0, 20)) {
      log("FAIL", `  ${o.table}.${o.column} id=${o.id}: "${o.sample}" (${o.matchedPattern})`);
    }
  } else {
    log("OK", "Seed-hygiene gate clean — 0 seed-marker hits.");
  }
}

// postgres-js keeps idle pool connections open, so the process does NOT exit
// on its own once main() resolves — without this it hangs indefinitely AFTER a
// fully successful seed (looks like a stall but the data is already committed).
// Force a clean exit, mirroring the explicit process.exit calls above.
await main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("[FAIL]", err);
    process.exit(1);
  });
