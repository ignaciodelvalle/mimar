/**
 * Google Play reviewer account — seed-play-reviewer.ts
 *
 * Provisions the ONE account whose credentials go into the Play Console's
 * "App access" form, so Google's reviewers can get past the login screen.
 *
 * ─── WHY THIS ACCOUNT EXISTS AT ALL ─────────────────────────────────────────
 * Every screen in the Expo client except `/ingreso` and `/crear-cuenta` is
 * behind `useGate`. A reviewer who cannot sign in cannot evaluate the app, and
 * "we couldn't access it" is a rejection, not a request for more information.
 * Login is a PASSWORD GRANT (app/api/v1/auth/login/route.ts), so a fixed
 * password is enough and no email ever has to be delivered — which is what
 * makes a non-deliverable `@dim.test` address workable here.
 *
 * ─── WHY NOT owner@dim.test, WHICH ALREADY HAS PETS ─────────────────────────
 * Because other things assert on its exact contents. owner@dim.test is the
 * flagship narrative account ("Martín"), curated to exactly four pets, and it is
 * consumed by e2e/owner-ia-p6.spec.ts, the demo recordings, seed-demo-polish.ts
 * and seed-flagship-pampa.ts. A reviewer doing the obvious thing — registering a
 * pet to see the flow, or starting a transfer — would move that state, and the
 * damage would surface days later as an unrelated red spec that nobody connects
 * to a Play review. This is the same lesson scripts/seed-reserved-accounts.ts
 * was written for, arriving from the other direction: there, an account needed
 * to stay EMPTY and a general-purpose persona could not guarantee it.
 *
 * ─── WHY THIS ONE NEEDS NO RESERVATION MACHINERY ────────────────────────────
 * And that is worth being precise about, because the obvious move — add this
 * email to RESERVED_ACCOUNT_EMAILS — is wrong twice over. First, `reserved`
 * means "must own nothing", and check-seed-hygiene.ts FAILS when a reserved
 * account has a pet; this account's whole job is to have two. Second, it does
 * not need the protection. The property a reviewer account must hold is
 * "NOT EMPTY", and that property is MONOTONIC: another seed script handing it a
 * third pet does not break it, and a reviewer adding one does not either. The
 * accounts that need fencing are the ones whose property is an exact count
 * ("zero", "exactly four"), because those are the ones any write falsifies.
 *
 * ─── WHY A SCRIPT AND NOT A HAND-INSERTED ROW ───────────────────────────────
 * `pnpm db:bootstrap` and a `supabase db reset` both rebuild the target from
 * scripts. A reviewer account created by hand disappears on the first rebuild,
 * silently, and the next thing that notices is Google — mid-review, with the
 * app already submitted and no way to explain what changed. As a script, the
 * recovery is one command that anybody can run without knowing what the account
 * was supposed to contain.
 *
 * It is deliberately NOT a step inside `db:bootstrap`, which mirrors how
 * seed:flagship is treated. Bootstrap is the MINIMAL baseline — localities,
 * CABA barrios, test users — and this account matters on exactly one
 * environment: the one the Play listing points at. Adding it to bootstrap would
 * put a reviewer account in every developer's local database to protect a
 * property only staging has. Re-running it after a rebuild is the caller's
 * move, and it is in the recovery order for that reason.
 *
 * ─── IDENTITY ───────────────────────────────────────────────────────────────
 *   Account : play-review@dim.test  (pre-confirmed, role owner)
 *   Pets    : DIM-PLAY-0001 "Coco"  (dog,  full libreta — chip, rabia, castración)
 *             DIM-PLAY-0002 "Nube"  (cat,  lighter libreta — alta + vacuna)
 *
 * On the PASSWORD (R8, 2026-09-23): local runs use the same `Test1234!`
 * literal every seed account in this repo uses — harmless, because it never
 * leaves a local Postgres. Any run against a non-local target (staging via
 * `--allow-remote`, which is what actually backs the Play Console credential)
 * now REQUIRES `SEED_DEMO_PASSWORD` from the environment and refuses to run
 * without it — the literal is published in this public repo, so writing it to
 * a real account defeats the point. Whoever rotates this account's password
 * must update the Play Console "App access" form to match the new value in
 * the SAME step, or Google's reviewer login breaks silently.
 *
 * On the DISPLAY NAME: `Nadia Ferreyra`, a plausible person, NOT "Play
 * Reviewer". profiles.display_name is a renderable column (scripts/hygiene-
 * rules.ts) — it can appear to a funcionario or a citizen — and seed plumbing
 * must never surface there. The account is identified by its EMAIL, which is
 * not renderable. Same reasoning as ZERO_PET_OWNER_DISPLAY_NAME.
 *
 * ─── IDEMPOTENCY ────────────────────────────────────────────────────────────
 *   Re-running converges without duplicating rows: the auth user is looked up by
 *   email; each pet by its fixed token; events are inserted only when that pet
 *   has none (never appended twice — the spine is append-only, so a second run
 *   would be indistinguishable from a real double-vaccination).
 *
 * ─── LOCAL-ONLY GUARD ───────────────────────────────────────────────────────
 *   Refuses to run against a non-local DATABASE_URL / Supabase host unless
 *   --allow-remote. ALWAYS refuses when NODE_ENV=production.
 *
 * Usage (local):
 *   pnpm seed:play-reviewer
 * Usage (staging — Ignacio only, .env points at staging):
 *   SEED_DEMO_PASSWORD=<value to put in the Play Console "App access" form> \
 *     pnpm seed:play-reviewer -- --allow-remote
 *
 *   SEED_DEMO_PASSWORD is used ONLY when this run CREATES the reviewer
 *   account. If it already exists on the target, its password is left alone
 *   (a remote seed never resets an existing account's password — R8/C4b
 *   review, 2026-09-23) and the summary does not print it.
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap (must run before db/index.ts is imported)
// ---------------------------------------------------------------------------

import { config as loadEnv } from "dotenv";

import {
  assertNotSplitEnv,
  isLocalTarget,
  resolveSeedPassword,
  seedPasswordForDisplay,
  shouldResetSeedPassword,
} from "./_env-target";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// 2. Parse CLI flags + safety guards
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const ALLOW_REMOTE = argv.includes("--allow-remote");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

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

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed: NODE_ENV=production. Aborting.");
  process.exit(2);
}

function parsePgHost(url: string): string | null {
  const match = url.match(/^postgres(?:ql)?:\/\/[^@]+@([^:/]+)/);
  return match ? match[1] : null;
}

const dbHost = parsePgHost(DATABASE_URL);
// A SPLIT environment (auth local, DB remote, or the reverse) passes the
// two-state check below whenever --allow-remote is given, and that is how a
// seed once wrote to staging while reading auth from local. Cut it first.
assertNotSplitEnv(SUPABASE_URL, DATABASE_URL, "seed:play-reviewer");

// Parsed hostnames via the shared helper, never substrings, and an empty URL
// is NOT local: "local" is the answer that selects the published password
// (F7 of the R8/C4b security review, 2026-09-23).
const IS_LOCAL = isLocalTarget(SUPABASE_URL, DATABASE_URL);

if (!ALLOW_REMOTE && !IS_LOCAL) {
  console.error(
    [
      "",
      "==============================================================",
      "  ABORT: seed-play-reviewer target is NOT a local Postgres.",
      "==============================================================",
      `  DATABASE_URL host : ${dbHost ?? "(not set)"}`,
      `  SUPABASE_URL      : ${SUPABASE_URL}`,
      "",
      "  This script creates a real account with a fixed, publicly",
      "  documented password. Running it against the wrong remote DB",
      "  by mistake is a real incident.",
      "",
      "  Re-run with --allow-remote to target a remote host.",
      "==============================================================",
      "",
    ].join("\n"),
  );
  process.exit(4);
}

// ---------------------------------------------------------------------------
// 3. Deferred imports (after env is populated)
// ---------------------------------------------------------------------------

const { createClient: createSdkClient } = await import("@supabase/supabase-js");
const { and, eq, sql } = await import("drizzle-orm");
const { db, pets, ownerships, petEvents, petIdentifications, profiles } = await import("../db");

// ---------------------------------------------------------------------------
// 4. Constants
// ---------------------------------------------------------------------------

// The reviewer account. NOT exported: this module runs `main()` at import
// time, so anything that imported a constant from here would seed a database
// as a side effect of reading a string. If a consumer ever needs these
// literals, they move to a pure constants module the way
// scripts/seed-reserved-accounts.ts already is — that file has no `main()` for
// exactly this reason.
const PLAY_REVIEWER_EMAIL = "play-review@dim.test";
const PLAY_REVIEWER_DISPLAY_NAME = "Nadia Ferreyra";

// Local keeps the literal the test suite and local dev depend on. Any other
// target (staging, etc.) requires SEED_DEMO_PASSWORD from the environment —
// this repo is public and "Test1234!" is published in it (R8, 2026-09-23).
const SHARED_PASSWORD = resolveSeedPassword(IS_LOCAL, "seed:play-reviewer");

const VET_EMAIL = "lilian@dim.test";
const VET_NAME = "Dra. Lilian Marrone";

const COCO_TOKEN = "DIM-PLAY-0001";
const NUBE_TOKEN = "DIM-PLAY-0002";

// ISO 15-digit chips: 941 · manufacturer · national id. Distinct from Pampa's.
const COCO_CHIP = "941000100000021";

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "FAIL";
function log(tag: LogTag, msg: string): void {
  console.log(`[${tag.padEnd(4)}] ${msg}`);
}

function dateAtNoonUtc(d: string): Date {
  return new Date(`${d}T12:00:00Z`);
}

// ---------------------------------------------------------------------------
// 5. Supabase admin client + user provisioning
// ---------------------------------------------------------------------------

const supabase = createSdkClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message ?? "(no message)"}`);
    const hit = data.users.find((u: { email?: string }) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
    page++;
  }
}

/**
 * `email_confirm: true` is the load-bearing flag. A reviewer cannot click a
 * confirmation link sent to `@dim.test` — that domain accepts no mail — so an
 * unconfirmed account is an account nobody can ever sign into.
 */
async function ensureAuthUser(
  email: string,
  displayName: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await findAuthUserIdByEmail(email);
  if (existing) return { id: existing, created: false };
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: SHARED_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: displayName, user_role: "owner" },
  });
  if (error || !data.user)
    throw new Error(`createUser(${email}) failed: ${error?.message ?? "no user"}`);
  return { id: data.user.id, created: true };
}

/**
 * Re-asserts the shared password on an account that already existed — LOCAL
 * ONLY. On a remote target an existing account keeps its password: a re-seed
 * must never silently overwrite a rotated secret (the 8 e2e staging accounts)
 * or a real person's password. See shouldResetSeedPassword in _env-target.ts.
 */
async function syncSeedPassword(id: string, created: boolean): Promise<void> {
  if (!shouldResetSeedPassword(IS_LOCAL, created)) return;
  const { error } = await supabase.auth.admin.updateUserById(id, { password: SHARED_PASSWORD });
  if (error) throw new Error(`updateUserById(${id}) failed: ${error.message}`);
}

async function ensureReviewer(): Promise<string> {
  log("STEP", `Ensuring reviewer ${PLAY_REVIEWER_EMAIL}`);
  const { id, created } = await ensureAuthUser(PLAY_REVIEWER_EMAIL, PLAY_REVIEWER_DISPLAY_NAME);
  // Locally the password is re-set on every run (a drifted local account is
  // the cheap cure). REMOTELY an existing reviewer account keeps its password:
  // changing the one the Play Console "App access" form holds is a deliberate
  // act (Supabase dashboard + Play Console in the same step), never a side
  // effect of re-running a seed (R8/C4b review, 2026-09-23).
  await syncSeedPassword(id, created);
  await db
    .update(profiles)
    .set({
      role: "owner",
      accountType: "personal",
      displayName: PLAY_REVIEWER_DISPLAY_NAME,
      updatedAt: new Date(),
    })
    .where(eq(profiles.id, id));
  log(created ? "OK" : "SKIP", `${PLAY_REVIEWER_EMAIL} → ${id.slice(0, 8)}…`);
  return id;
}

/**
 * A matriculated vet to sign the vaccinations, so the credential reads
 * "Verificado por veterinario matriculado" rather than owner-declared. Reuses
 * the seed:demo vet when present — this script creates no second one.
 */
async function ensureVet(): Promise<string> {
  log("STEP", `Ensuring vet ${VET_EMAIL} (matriculado)`);
  const { id, created } = await ensureAuthUser(VET_EMAIL, VET_NAME);
  await db
    .update(profiles)
    .set({
      role: "vet",
      accountType: "personal",
      displayName: VET_NAME,
      matriculaVerified: true,
      matriculaNumber: "V-99001-CABA",
      matriculaJurisdiccion: "CABA",
      updatedAt: new Date(),
    })
    .where(eq(profiles.id, id));
  log(created ? "OK" : "SKIP", `${VET_EMAIL} → ${id.slice(0, 8)}…`);
  return id;
}

// ---------------------------------------------------------------------------
// 6. Pets
// ---------------------------------------------------------------------------

type PetSpec = {
  token: string;
  name: string;
  species: "dog" | "cat";
  breed: string;
  sex: "male" | "female";
  dateOfBirth: string;
  color: string;
  locality: string;
};

const COCO: PetSpec = {
  token: COCO_TOKEN,
  name: "Coco",
  species: "dog",
  // The CANONICAL catalogue value, not the word a person would type. "Mestizo"
  // is only an ALIAS in lib/reference/breeds.ts (mestizo → "Mixto / Cruza"),
  // and `pnpm lint:catalogs` reads the live database rather than this file — it
  // caught the first draft of this script with `raza — "Mestizo" (1) fuera de
  // catálogo`. Aliases exist so a repair script can normalise what humans typed;
  // a seed writes the normalised form directly.
  breed: "Mixto / Cruza",
  sex: "male",
  dateOfBirth: "2020-09-08",
  color: "negro y fuego",
  locality: "Almagro",
};

const NUBE: PetSpec = {
  token: NUBE_TOKEN,
  name: "Nube",
  species: "cat",
  breed: "Siamés",
  sex: "female",
  dateOfBirth: "2023-05-02",
  color: "crema",
  locality: "Almagro",
};

async function ensurePet(spec: PetSpec, ownerId: string): Promise<string> {
  log("STEP", `Ensuring pet ${spec.token} (${spec.name})`);
  const [existing] = await db
    .select({ id: pets.id })
    .from(pets)
    .where(eq(pets.publicToken, spec.token))
    .limit(1);

  if (existing) {
    // Keep the reviewer's view healthy on re-runs. Never lost, never deceased:
    // a reviewer's first screen should show the app working, not a crisis.
    await db
      .update(pets)
      .set({ status: "active", deceasedAt: null, deletedAt: null, updatedAt: new Date() })
      .where(eq(pets.id, existing.id));
    log("SKIP", `${spec.token} already exists → ${existing.id.slice(0, 8)}…`);
    return existing.id;
  }

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: spec.token,
      species: spec.species,
      breed: spec.breed,
      name: spec.name,
      sex: spec.sex,
      dateOfBirth: spec.dateOfBirth,
      birthDateIsEstimated: true,
      color: spec.color,
      status: "active",
      acquisitionMethod: "adopted",
      jurisdictionCountry: "AR",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: spec.locality,
    })
    .returning({ id: pets.id });

  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: ownerId, role: "owner" });
  log("OK", `${spec.token} inserted → ${pet.id.slice(0, 8)}…`);
  return pet.id;
}

// ---------------------------------------------------------------------------
// 7. Libreta — enough history that the app does not look empty
// ---------------------------------------------------------------------------

type SeedEvent = {
  date: string;
  eventType: string;
  authorRole: "owner" | "vet";
  authorVerified: boolean;
  payload: Record<string, unknown>;
};

/**
 * Coco's history: the full shape of a well-kept libreta — registration, chip,
 * two rabies doses a year apart, a sterilization and a clinical note. The
 * LATEST dose is vet-signed with a future `next_due_at`, so both the app's
 * credential screen and the public page read "vigente" and "verificada". A
 * reviewer opening this pet sees every kind of row the product has.
 */
function cocoLibreta(): SeedEvent[] {
  return [
    {
      date: "2021-02-11",
      eventType: "pet_registered",
      authorRole: "owner",
      authorVerified: false,
      payload: {
        name: COCO.name,
        species: COCO.species,
        sex: COCO.sex,
        breed: COCO.breed,
        date_of_birth: COCO.dateOfBirth,
        birth_date_is_estimated: true,
        color: COCO.color,
        acquisition_method: "adopted",
        has_photo: false,
        has_microchip: false,
      },
    },
    {
      date: "2021-03-02",
      eventType: "microchip_implanted",
      authorRole: "vet",
      authorVerified: true,
      payload: {
        chip_number: COCO_CHIP,
        country_code: "941",
        implanted_by: "Veterinaria Almagro",
        location_on_body: "interescapular",
        implant_date_known: true,
      },
    },
    {
      date: "2021-03-02",
      eventType: "vaccination_administered",
      authorRole: "vet",
      authorVerified: true,
      payload: {
        vaccine_name: "Antirrábica",
        brand: "Rabisin",
        batch: "AR-2103",
        administered_by: "Veterinaria Almagro",
        next_due_at: "2022-03-02",
      },
    },
    {
      date: "2021-09-14",
      eventType: "sterilization_performed",
      authorRole: "vet",
      authorVerified: true,
      payload: {
        procedure: "castration",
        performed_by: "Veterinaria Almagro",
        clinic: "Veterinaria Almagro",
      },
    },
    {
      date: "2025-11-19",
      eventType: "clinical_info_logged",
      authorRole: "vet",
      authorVerified: true,
      payload: {
        sub_kind: "other",
        title: "Control anual",
        details: "Peso estable, sin hallazgos. Se indica control en un año.",
        performed_by: "Veterinaria Almagro",
      },
    },
    {
      date: "2026-05-20",
      eventType: "vaccination_administered",
      authorRole: "vet",
      authorVerified: true,
      payload: {
        vaccine_name: "Antirrábica",
        brand: "Nobivac Rabies",
        batch: "AR-2605",
        administered_by: "Veterinaria Almagro",
        next_due_at: "2027-05-20",
      },
    },
  ];
}

/**
 * Nube's history is deliberately THINNER, and the contrast is the point. A
 * reviewer with two identical pets learns nothing about how the app renders a
 * partial record; with one complete and one still missing its chip, the empty
 * states and the "falta" affordances are visible without anybody having to go
 * looking for them.
 */
function nubeLibreta(): SeedEvent[] {
  return [
    {
      date: "2023-07-01",
      eventType: "pet_registered",
      authorRole: "owner",
      authorVerified: false,
      payload: {
        name: NUBE.name,
        species: NUBE.species,
        sex: NUBE.sex,
        breed: NUBE.breed,
        date_of_birth: NUBE.dateOfBirth,
        birth_date_is_estimated: true,
        color: NUBE.color,
        acquisition_method: "adopted",
        has_photo: false,
        has_microchip: false,
      },
    },
    {
      date: "2026-04-08",
      eventType: "vaccination_administered",
      authorRole: "vet",
      authorVerified: true,
      payload: {
        vaccine_name: "Triple felina",
        brand: "Feligen",
        batch: "FE-2604",
        administered_by: "Veterinaria Almagro",
        next_due_at: "2027-04-08",
      },
    },
  ];
}

async function ensureLibreta(
  petId: string,
  label: string,
  events: SeedEvent[],
  ownerId: string,
  vetId: string,
): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(petEvents)
    .where(eq(petEvents.petId, petId));

  if (count > 0) {
    log("SKIP", `${label} already has ${count} events — leaving the append-only spine intact`);
    return;
  }

  const recordedBy: Record<SeedEvent["authorRole"], string> = { owner: ownerId, vet: vetId };
  for (const e of events) {
    await db.insert(petEvents).values({
      petId,
      eventType: e.eventType as never,
      occurredAt: dateAtNoonUtc(e.date),
      recordedByUserId: recordedBy[e.authorRole],
      authorRole: e.authorRole,
      authorVerified: e.authorVerified,
      payload: e.payload,
    });
  }
  log("OK", `${label}: ${events.length} events inserted`);
}

/** Canonical microchip row, mirroring Coco's `microchip_implanted` event. */
async function ensureMicrochip(petId: string): Promise<void> {
  const [existing] = await db
    .select({ id: petIdentifications.id })
    .from(petIdentifications)
    .where(and(eq(petIdentifications.petId, petId), eq(petIdentifications.kind, "microchip_iso")))
    .limit(1);
  if (existing) {
    log("SKIP", "microchip canonical row already present");
    return;
  }
  await db.insert(petIdentifications).values({
    petId,
    kind: "microchip_iso",
    code: COCO_CHIP,
    recordedAt: "2021-03-02",
    recordedByLabel: "Veterinaria Almagro",
    implantationSite: "interescapular",
    isoCountryCode: COCO_CHIP.slice(0, 3),
    isoManufacturerCode: COCO_CHIP.slice(3, 7),
    isoNationalId: COCO_CHIP.slice(7, 15),
    isoCompliant: true,
  });
  log("OK", `microchip canonical row → ${COCO_CHIP}`);
}

// ---------------------------------------------------------------------------
// 8. Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("INFO", `Seeding the Play reviewer account against ${SUPABASE_URL}`);

  const reviewerId = await ensureReviewer();
  const vetId = await ensureVet();

  const cocoId = await ensurePet(COCO, reviewerId);
  await ensureLibreta(cocoId, COCO.name, cocoLibreta(), reviewerId, vetId);
  await ensureMicrochip(cocoId);

  const nubeId = await ensurePet(NUBE, reviewerId);
  await ensureLibreta(nubeId, NUBE.name, nubeLibreta(), reviewerId, vetId);

  log("DONE", "Play reviewer seed complete");
  console.log("");
  console.log("=== Play Console → App access ===");
  console.log(`  Usuario    : ${PLAY_REVIEWER_EMAIL}`);
  console.log(`  Contraseña : ${seedPasswordForDisplay(IS_LOCAL, SHARED_PASSWORD)}`);
  console.log(`  Mascotas   : ${COCO_TOKEN} (${COCO.name}) · ${NUBE_TOKEN} (${NUBE.name})`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[FATAL]", err);
    process.exit(1);
  });
