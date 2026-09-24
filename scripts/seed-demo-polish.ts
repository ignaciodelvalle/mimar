/**
 * Demo data polish — dev/QA tool.
 *
 * Run with:
 *   pnpm exec tsx scripts/seed-demo-polish.ts
 *
 * What this does (each step logged + idempotent, rerunnable):
 *   1. Curates owner@dim.test down to exactly 4 pets (Firulais, Michi, Atún,
 *      Rocco). Every other active ownership is reassigned round-robin to the
 *      seeded companion accounts (seed-level UPDATE, no transfer events).
 *   2. Renames placeholder pets (DIM-DEMO-*, Firulais dupes, QA leftovers)
 *      to culturally-appropriate es-AR names, and fills missing identity
 *      data (breed, color, sex, date_of_birth, estimated_weight_kg) with
 *      deterministic realistic values. Never overwrites non-null fields.
 *   3. Strips "PANO-NNNN " prefixes from PANO pet names and fills NULL
 *      breed/color/date_of_birth for PANO pets via bulk SQL (hashtext-based
 *      so reruns are stable no-ops).
 *   4. Generates species-aware placeholder photos (SVG → PNG via sharp) for
 *      video-visible pets (owner@'s 4, renamed pets, adoption listings,
 *      recent lost pets, org-portal pets — capped at 80). Same mechanism as
 *      scripts/seed-pet-photos.ts: `pet-photos` bucket + attachments row +
 *      pets.primary_photo_id. Pets that already have a photo are skipped.
 *   5. Enriches the libreta of owner@'s 4 pets: annual antirrábica,
 *      polivalente, deworming, 4 weight points over 12 months, and a vet
 *      visit — inserted only where missing (append-only invariant: existing
 *      events are never edited or deleted). The estimated_weight_kg cache is
 *      re-aligned to the latest weight_recorded event afterwards.
 *   6. Prints a summary report.
 *
 * Mirrors scripts/seed-pet-photos.ts conventions:
 *   - dotenv loaded BEFORE any heavy import that touches DATABASE_URL.
 *   - Local-only safety guard (refuses non-local Supabase / NODE_ENV=production).
 *   - log("STEP" | "OK" | "SKIP" | "WARN" | "FAIL", msg).
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap + safety guards (must run before db/index.ts imports)
// ---------------------------------------------------------------------------

import { config as loadEnv } from "dotenv";

import { assertNotSplitEnv } from "./_env-target";

import { rejectReservedAccounts } from "./seed-reserved-accounts";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// --allow-remote lets the full re-seed chain (panorama → scenario → polish)
// complete against a remote host. Local-only remains the default: remote must
// be requested EXPLICITLY, mirroring seed-panorama.ts / seed-demo-scenario.ts.
const ALLOW_REMOTE = process.argv.includes("--allow-remote");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const isLocalUrl = (u: string) => u.includes("127.0.0.1") || u.includes("localhost");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local — aborting.",
  );
  process.exit(2);
}
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed: NODE_ENV=production.");
  process.exit(2);
}
// Mismo agujero que en sus hermanos: la condicion de abajo declara "remoto" con
// UNA sola URL remota, asi que con --allow-remote el entorno PARTIDO pasaba.
assertNotSplitEnv(SUPABASE_URL, DATABASE_URL, "seed:demo-polish");

if (!ALLOW_REMOTE && (!isLocalUrl(SUPABASE_URL) || !isLocalUrl(DATABASE_URL))) {
  console.error(
    `Refusing to seed: NEXT_PUBLIC_SUPABASE_URL (${SUPABASE_URL}) or DATABASE_URL is not local.`,
    "\n  Re-run with --allow-remote to target a remote host explicitly.",
  );
  process.exit(2);
}

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "FAIL";
function log(tag: LogTag, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${tag.padEnd(4)}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PET_PHOTOS_BUCKET = "pet-photos";
const OWNER_EMAIL = "owner@dim.test";
const VET_USER_EMAIL = "lilian@dim.test"; // seeded vet account, used as recorded_by for vet events
const VET_SIGNATURE = "Vet. Alejo Gutiérrez — Clínica Recoleta";
const VET_NAME = "Vet. Alejo Gutiérrez";
const VET_CLINIC = "Clínica Veterinaria Recoleta";

/** owner@'s final 4 pets — everything else gets reassigned. */
const OWNER_KEEP_TOKENS = [
  "DIM-9HAK-D5Z4", // Firulais
  "DIM-4SUZ-U2HT", // Michi
  "DIM-VT3V-SEA3", // Atún
  "DIM-DEMO-0001", // Rocco (renamed in Step 2; amended-event beat pet)
] as const;

/**
 * Round-robin recipients for owner@'s surplus ownerships.
 *
 * This list is how carla@dim.test — documented in e2e/owner-ia-p6.spec.ts as
 * the ZERO-PET owner — silently acquired DIM-DEMO-0002 and DIM-DEMO-0008 on
 * 2026-07-26 and broke the owner empty-state test. Anything added here WILL be
 * given pets, so never add an account whose value is being empty. Reserved
 * accounts are filtered out below regardless (scripts/seed-reserved-accounts.ts)
 * — that filter is the fence, this comment is only the warning sign.
 */
const REASSIGN_EMAILS = [
  "carla@dim.test",
  "lucas@dim.test",
  "noeli@dim.test",
  "graciela@dim.test",
  "lilian@dim.test",
  "ignacio@dim.test",
  "owner2@dim.test",
] as const;

/** public_token → new es-AR name. Matching by token makes reruns no-ops. */
const RENAMES: Record<string, string> = {
  "DIM-DEMO-0001": "Rocco",
  "DIM-DEMO-0002": "Greta",
  "DIM-DEMO-0003": "Simón",
  "DIM-DEMO-0004": "Tango",
  "DIM-DEMO-0005": "Frida",
  "DIM-DEMO-0006": "Camilo",
  "DIM-DEMO-0007": "Renata",
  "DIM-DEMO-0008": "Bianca",
  "DIM-DEMO-0009": "Morocho",
  "DIM-DEMO-0010": "Pipa",
  "DIM-K6MK-GW65": "Bruno", // Firulais dupe
  "DIM-Y9AF-SRSB": "Canela",
  "DIM-CMDV-N5T4": "Ramón", // Firulais1
  "DIM-VYNQ-Z4AJ": "Sasha", // Firulais2
  "DIM-NNDZ-V79T": "Chicha", // Firulais3
  "DIM-XJS3-2YMP": "Maga", // Luna dupe (DIM-CP8S-DXVP stays Luna)
  "DIM-BAFX-B7VF": "Malbec", // was "QA Ronda2 Perro"
};

const DOG_BREEDS = [
  "Mestizo",
  "Caniche toy",
  "Ovejero alemán",
  "Golden retriever",
  "Salchicha",
  "Beagle",
  "Border collie",
  "Boxer",
  "Galgo",
] as const;
const CAT_BREEDS = ["Común europeo", "Siamés"] as const;
const COLORS = [
  "marrón",
  "negro",
  "blanco y negro",
  "dorado",
  "tricolor",
  "gris atigrado",
  "canela",
] as const;

/** Realistic adult weight range (kg) per breed. */
const BREED_WEIGHT_RANGES: Record<string, [number, number]> = {
  Mestizo: [8, 25],
  "Caniche toy": [3, 5],
  "Ovejero alemán": [28, 38],
  "Golden retriever": [25, 34],
  Salchicha: [7, 11],
  Beagle: [9, 14],
  "Border collie": [14, 20],
  Boxer: [25, 32],
  Galgo: [20, 28],
  "Común europeo": [3.2, 5.5],
  Siamés: [3, 5],
};

/** 8 warm placeholder-photo background colors, rotated per pet. */
const PHOTO_PALETTE = [
  "#D97757", // terracotta
  "#E8A33D", // amber
  "#C15B4A", // coral
  "#A8763E", // ochre
  "#CC8B4E", // caramel
  "#B5543B", // brick
  "#D9A05B", // sand
  "#C46A50", // clay
] as const;

// ---------------------------------------------------------------------------
// Deterministic helpers (hash of token → stable values across reruns)
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit — deterministic, good enough spread for seed data. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(arr: readonly T[], seed: string): T {
  return arr[hashString(seed) % arr.length];
}

/** DOB between 1 and 12 years ago, deterministic per token. */
function deterministicDob(token: string): string {
  const days = 365 + (hashString(`${token}:dob`) % (11 * 365));
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function deterministicWeightKg(token: string, breed: string | null, species: string): string {
  const fallback: [number, number] = species === "cat" ? [3, 5.5] : [8, 25];
  const range: [number, number] = (breed ? BREED_WEIGHT_RANGES[breed] : undefined) ?? fallback;
  const [min, max] = range;
  const t = (hashString(`${token}:kg`) % 1000) / 1000;
  return (min + (max - min) * t).toFixed(1);
}

function deterministicBreed(token: string, species: string): string | null {
  if (species === "dog") {
    // ~55% Mestizo, rest varied — mirrors the PANO bulk distribution.
    const roll = hashString(`${token}:breed`) % 100;
    if (roll < 55) return "Mestizo";
    return DOG_BREEDS[1 + (roll % (DOG_BREEDS.length - 1))];
  }
  if (species === "cat") {
    return hashString(`${token}:breed`) % 100 < 70 ? "Común europeo" : pick(CAT_BREEDS, token);
  }
  return null;
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthsAgo(months: number, jitterDays = 0): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  d.setDate(d.getDate() - jitterDays);
  return d;
}

function addYears(d: Date, years: number): Date {
  const out = new Date(d);
  out.setFullYear(out.getFullYear() + years);
  return out;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + months);
  return out;
}

// ---------------------------------------------------------------------------
// Placeholder photo SVG (species-aware, flat, centered)
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function speciesGlyph(species: string, bgColor: string): string {
  if (species === "dog") {
    return `<g fill="#ffffff" opacity="0.95" transform="translate(320,215)">
      <ellipse cx="-88" cy="5" rx="30" ry="62"/>
      <ellipse cx="88" cy="5" rx="30" ry="62"/>
      <circle cx="0" cy="0" r="92"/>
      <ellipse cx="0" cy="52" rx="40" ry="28"/>
    </g>
    <g fill="${bgColor}" transform="translate(320,215)">
      <circle cx="-32" cy="-18" r="9"/>
      <circle cx="32" cy="-18" r="9"/>
      <ellipse cx="0" cy="44" rx="13" ry="9"/>
    </g>`;
  }
  if (species === "cat") {
    return `<g fill="#ffffff" opacity="0.95" transform="translate(320,215)">
      <path d="M -78 -48 L -96 -118 L -32 -80 Z"/>
      <path d="M 78 -48 L 96 -118 L 32 -80 Z"/>
      <circle cx="0" cy="0" r="88"/>
    </g>
    <g fill="${bgColor}" transform="translate(320,215)">
      <circle cx="-30" cy="-14" r="9"/>
      <circle cx="30" cy="-14" r="9"/>
      <path d="M -11 24 L 11 24 L 0 38 Z"/>
    </g>`;
  }
  // Other species → paw print.
  return `<g fill="#ffffff" opacity="0.95" transform="translate(320,225)">
    <ellipse cx="0" cy="32" rx="62" ry="50"/>
    <circle cx="-72" cy="-28" r="24"/>
    <circle cx="-26" cy="-58" r="24"/>
    <circle cx="26" cy="-58" r="24"/>
    <circle cx="72" cy="-28" r="24"/>
  </g>`;
}

function petPhotoSvg(name: string, species: string, bgColor: string): string {
  const initial = escapeXml(name.charAt(0).toUpperCase());
  const label = escapeXml(name);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
    <rect width="640" height="640" fill="${bgColor}"/>
    ${speciesGlyph(species, bgColor)}
    <text x="320" y="483" font-family="Georgia, 'Times New Roman', serif" font-size="140"
      font-weight="600" fill="#ffffff" text-anchor="middle">${initial}</text>
    <text x="320" y="578" font-family="Georgia, 'Times New Roman', serif" font-size="44"
      fill="#ffffff" opacity="0.85" text-anchor="middle">${label}</text>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { createClient: createSdkClient } = await import("@supabase/supabase-js");
  const { and, desc, eq, inArray, isNotNull, isNull, ne, or, notInArray, sql } = await import(
    "drizzle-orm"
  );
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const sharp = (await import("sharp")).default;
  const { randomUUID } = await import("node:crypto");
  // Import the schema directly (relative path) instead of "@/db" — the "@/db"
  // barrel pulls in the `server-only` sentinel, which has no meaning for a
  // standalone script (same rationale as scripts/seed-pet-photos.ts).
  const schema = await import("../db/schema");
  const { pets, ownerships, petEvents, attachments, profiles, govtAssignments } = schema;
  const { WHOLE_PROVINCE_LOCALITY } = await import("../lib/domain/jurisdiction-canonical");
  const { pickWelfareDescriptionDeterministic } = await import("./welfare-description-templates");

  const supabase = createSdkClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const client = postgres(DATABASE_URL, { prepare: false });
  const db = drizzle(client, { schema });

  // Summary counters (Step 9).
  const summary = {
    petsRenamed: 0,
    identityFieldsFilled: 0,
    ownershipsMoved: 0,
    panoNamesCleaned: 0,
    panoFieldsFilled: 0,
    photosCreated: 0,
    eventsInserted: 0,
    seedProfileNamesRepaired: 0,
    lucasAssignmentsRevoked: 0,
    lucasAssignmentEnsured: false,
    welfareDescriptionsRepaired: 0,
  };

  // -------------------------------------------------------------------------
  // Resolve auth users once (email → id map).
  // -------------------------------------------------------------------------
  log("STEP", "Resolving seeded auth users");
  const usersByEmail = new Map<string, string>();
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message ?? "(no message)"}`);
    for (const u of data.users) {
      if (u.email) usersByEmail.set(u.email, u.id);
    }
    if (data.users.length < 200) break;
    page += 1;
  }
  const ownerUserId = usersByEmail.get(OWNER_EMAIL);
  if (!ownerUserId) {
    log("FAIL", `No auth user found for ${OWNER_EMAIL} — aborting.`);
    process.exit(1);
  }
  log("OK", `${OWNER_EMAIL} → ${ownerUserId}`);

  // -------------------------------------------------------------------------
  // Step 1 — Curate owner@dim.test down to exactly 4 pets
  // -------------------------------------------------------------------------
  log("STEP", "Step 1 — Curating owner@dim.test ownerships");

  const keepPets = await db
    .select({ id: pets.id, publicToken: pets.publicToken })
    .from(pets)
    .where(inArray(pets.publicToken, [...OWNER_KEEP_TOKENS]));
  for (const token of OWNER_KEEP_TOKENS) {
    if (!keepPets.some((p) => p.publicToken === token)) {
      log("WARN", `keep pet ${token} not found in pets table.`);
    }
  }
  const keepPetIds = keepPets.map((p) => p.id);

  // Institutional accounts (govt, admin) cannot own pets — the DB trigger
  // enforce_institutional_no_pets() rejects the reassignment (first run
  // aborted here: lucas@dim.test is seeded as govt). Filter by profile role.
  const candidateIds: string[] = [];
  // Reserved accounts exist to stay empty — drop them before anything can hand
  // them a pet. Applied to the LIST, not to a hardcoded email, so widening
  // REASSIGN_EMAILS can never reach one.
  for (const email of rejectReservedAccounts(REASSIGN_EMAILS, "seed-demo-polish reassignment")) {
    const id = usersByEmail.get(email);
    if (id) {
      candidateIds.push(id);
    } else {
      log("WARN", `reassign account ${email} not found — skipping it.`);
    }
  }
  const eligibleRows =
    candidateIds.length > 0
      ? await db
          .select({ id: schema.profiles.id, role: schema.profiles.role })
          .from(schema.profiles)
          .where(inArray(schema.profiles.id, candidateIds))
      : [];
  const reassignTargets: string[] = [];
  for (const id of candidateIds) {
    const row = eligibleRows.find((r) => r.id === id);
    if (row && (row.role === "govt" || row.role === "admin")) {
      log("SKIP", `reassign account with role=${row.role} cannot own pets — skipping it.`);
      continue;
    }
    reassignTargets.push(id);
  }

  if (reassignTargets.length === 0) {
    log("WARN", "No reassign accounts found — leaving owner@ ownerships untouched.");
  } else {
    const surplus = await db
      .select({ id: ownerships.id, petId: ownerships.petId })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.ownerUserId, ownerUserId),
          isNull(ownerships.endedAt),
          keepPetIds.length > 0 ? notInArray(ownerships.petId, keepPetIds) : undefined,
        ),
      )
      .orderBy(ownerships.startedAt, ownerships.id);

    if (surplus.length === 0) {
      log("SKIP", "owner@ has no surplus active ownerships (already curated).");
    } else {
      for (let i = 0; i < surplus.length; i++) {
        const row = surplus[i];
        const newOwnerId = reassignTargets[i % reassignTargets.length];
        // Seed-level reassignment: plain UPDATE, no transfer events.
        await db
          .update(ownerships)
          .set({ ownerUserId: newOwnerId })
          .where(eq(ownerships.id, row.id));
        summary.ownershipsMoved += 1;
      }
      log("OK", `reassigned ${surplus.length} active ownerships round-robin.`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 2 — Real names + identity data
  // -------------------------------------------------------------------------
  log("STEP", "Step 2 — Renaming pets + filling identity data");

  for (const [token, newName] of Object.entries(RENAMES)) {
    const [pet] = await db
      .select({ id: pets.id, name: pets.name })
      .from(pets)
      .where(eq(pets.publicToken, token))
      .limit(1);
    if (!pet) {
      log("WARN", `pet ${token} not found — skipping rename.`);
      continue;
    }
    if (pet.name === newName) {
      log("SKIP", `${token} already named "${newName}".`);
      continue;
    }
    await db.update(pets).set({ name: newName }).where(eq(pets.id, pet.id));
    summary.petsRenamed += 1;
    log("OK", `${token}: "${pet.name}" → "${newName}"`);
  }

  // Species coherence — the DIM-DEMO-* cohort is created exclusively as dogs
  // (scripts/seed-demo-scenario.ts `ensureDemoPet` hardcodes species='dog' and
  // every DEMO_PET_IDENTITY entry is a dog breed). A raw DB edit that flipped
  // one to 'cat' leaves its stored species contradicting its dog-sized weights,
  // canine vaccines, and the `pet_species` baked into its `outbreak_signal`
  // payload — an incoherence the fleet/surveillance demo views surface. Force
  // the cohort back to 'dog' idempotently (no-op once every row is coherent).
  const demoDogTokens = Object.keys(RENAMES).filter((t) => t.startsWith("DIM-DEMO-"));
  const speciesFixed = await db
    .update(pets)
    .set({ species: "dog" })
    .where(and(inArray(pets.publicToken, demoDogTokens), sql`${pets.species} <> 'dog'`))
    .returning({ publicToken: pets.publicToken });
  if (speciesFixed.length > 0) {
    log("OK", `species → dog for ${speciesFixed.map((r) => r.publicToken).join(", ")}`);
  } else {
    log("SKIP", "DIM-DEMO-* species already coherent (dog).");
  }

  // E2E leftovers → "Turrón" (matched by name pattern, so RETURNING captures
  // the tokens for the identity-fill pass below; reruns find them by name).
  const e2eRenamed = (await db.execute(
    sql`UPDATE pets SET name = 'Turrón' WHERE name ~ '^E2EPet-' RETURNING public_token`,
  )) as unknown as Array<{ public_token: string }>;
  if (e2eRenamed.length > 0) {
    summary.petsRenamed += e2eRenamed.length;
    log("OK", `renamed ${e2eRenamed.length} E2EPet-* pets to "Turrón".`);
  } else {
    log("SKIP", "no E2EPet-* pets left to rename.");
  }
  const turronTokens = (
    await db.select({ publicToken: pets.publicToken }).from(pets).where(eq(pets.name, "Turrón"))
  ).map((r) => r.publicToken);

  // Identity fill: renamed pets + owner@'s 4 (dedup). Only NULL/unknown
  // fields are filled — non-null values are never overwritten.
  const fillTokens = [...new Set([...Object.keys(RENAMES), ...OWNER_KEEP_TOKENS, ...turronTokens])];
  const fillPets = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      name: pets.name,
      species: pets.species,
      breed: pets.breed,
      color: pets.color,
      sex: pets.sex,
      dateOfBirth: pets.dateOfBirth,
      estimatedWeightKg: pets.estimatedWeightKg,
    })
    .from(pets)
    .where(inArray(pets.publicToken, fillTokens));

  for (const pet of fillPets) {
    const patch: Partial<typeof pets.$inferInsert> = {};
    if (!pet.breed) {
      const breed = deterministicBreed(pet.publicToken, pet.species);
      if (breed) patch.breed = breed;
    }
    if (!pet.color) patch.color = pick(COLORS, `${pet.publicToken}:color`);
    if (pet.sex === "unknown") {
      patch.sex = hashString(`${pet.publicToken}:sex`) % 2 === 0 ? "male" : "female";
    }
    if (!pet.dateOfBirth) patch.dateOfBirth = deterministicDob(pet.publicToken);
    if (!pet.estimatedWeightKg) {
      patch.estimatedWeightKg = deterministicWeightKg(
        pet.publicToken,
        patch.breed ?? pet.breed,
        pet.species,
      );
    }
    const filled = Object.keys(patch).length;
    if (filled === 0) {
      log("SKIP", `${pet.name} (${pet.publicToken}) identity already complete.`);
      continue;
    }
    await db.update(pets).set(patch).where(eq(pets.id, pet.id));
    summary.identityFieldsFilled += filled;
    log("OK", `${pet.name} (${pet.publicToken}): filled ${Object.keys(patch).join(", ")}`);
  }

  // A cache weight without a backing event is exactly the drift the
  // pet-cache fitness sweep exists to catch (invariant #3) — the first run
  // of this script created it. Emit one weight_recorded per pet whose
  // estimated_weight_kg is set but whose log has no weight event.
  //
  // SEED SCOPE: `LIKE 'DIM-%'` matched EVERY real user pet (live tokens are
  // DIM-XXXX-XXXX), so this would have injected a synthetic weight_recorded
  // event into any real pet carrying an estimated_weight_kg — a mutation of a
  // user's append-only event log. Scope strictly to the exact set this script
  // filled weights on (fillTokens = RENAMES + owner@'s kept pets + E2E→Turrón).
  await db.execute(sql`
    INSERT INTO pet_events (pet_id, event_type, occurred_at, recorded_at, author_role, payload)
    SELECT p.id, 'weight_recorded', now() - interval '30 days', now() - interval '30 days', 'owner',
           jsonb_build_object('payload_version', 1, 'kg', p.estimated_weight_kg::text, 'source', 'demo-polish')
    FROM pets p
    WHERE p.public_token IN (${sql.join(
      fillTokens.map((t) => sql`${t}`),
      sql`, `,
    )}) AND p.estimated_weight_kg IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM pet_events e WHERE e.pet_id = p.id AND e.event_type = 'weight_recorded'
      )
  `);

  // -------------------------------------------------------------------------
  // Step 3 — PANO name cleanup + bulk identity fill
  // -------------------------------------------------------------------------
  log("STEP", "Step 3 — PANO name cleanup + bulk fills");

  const panoNames = (await db.execute(
    sql`UPDATE pets SET name = regexp_replace(name, '^PANO-[0-9]+ ', '') WHERE name ~ '^PANO-[0-9]+ '`,
  )) as unknown as { count?: number };
  summary.panoNamesCleaned = panoNames.count ?? 0;
  log("OK", `stripped PANO- prefixes from ${summary.panoNamesCleaned} pet names.`);

  const panoHistNames = (await db.execute(
    sql`UPDATE pets SET name = regexp_replace(name, '^PANO-HIST-[0-9]+ ', '') WHERE name ~ '^PANO-HIST-[0-9]+ '`,
  )) as unknown as { count?: number };
  summary.panoNamesCleaned += panoHistNames.count ?? 0;
  log("OK", `stripped PANO-HIST- prefixes from ${panoHistNames.count ?? 0} pet names.`);

  // hashtext(public_token) instead of random() so reruns are deterministic
  // (the WHERE clause already makes reruns no-ops, but determinism keeps any
  // partially-failed run consistent too). Dogs: 55% Mestizo, rest varied;
  // cats: mostly Común europeo. DOB: 1-12 years ago.
  const panoFills = (await db.execute(sql`
    UPDATE pets SET
      breed = COALESCE(breed, CASE
        WHEN species = 'dog' THEN CASE
          WHEN abs(hashtext(public_token)) % 100 < 55 THEN 'Mestizo'
          WHEN abs(hashtext(public_token)) % 100 < 62 THEN 'Caniche toy'
          WHEN abs(hashtext(public_token)) % 100 < 68 THEN 'Ovejero alemán'
          WHEN abs(hashtext(public_token)) % 100 < 74 THEN 'Golden retriever'
          WHEN abs(hashtext(public_token)) % 100 < 80 THEN 'Salchicha'
          WHEN abs(hashtext(public_token)) % 100 < 86 THEN 'Beagle'
          WHEN abs(hashtext(public_token)) % 100 < 91 THEN 'Border collie'
          WHEN abs(hashtext(public_token)) % 100 < 96 THEN 'Boxer'
          ELSE 'Galgo'
        END
        WHEN species = 'cat' THEN CASE
          WHEN abs(hashtext(public_token || 'x')) % 100 < 70 THEN 'Común europeo'
          WHEN abs(hashtext(public_token || 'x')) % 100 < 85 THEN 'Siamés'
          ELSE 'Mestizo'
        END
      END),
      color = COALESCE(color, CASE abs(hashtext(public_token || 'c')) % 7
        WHEN 0 THEN 'marrón'
        WHEN 1 THEN 'negro'
        WHEN 2 THEN 'blanco y negro'
        WHEN 3 THEN 'dorado'
        WHEN 4 THEN 'tricolor'
        WHEN 5 THEN 'gris atigrado'
        ELSE 'canela'
      END),
      date_of_birth = COALESCE(
        date_of_birth,
        (now() - make_interval(days => 365 + abs(hashtext(public_token || 'd')) % 4015))::date
      )
    WHERE public_token LIKE 'PANO-%'
      AND (breed IS NULL OR color IS NULL OR date_of_birth IS NULL)
  `)) as unknown as { count?: number };
  summary.panoFieldsFilled = panoFills.count ?? 0;
  log("OK", `filled breed/color/DOB on ${summary.panoFieldsFilled} PANO pets.`);

  // -------------------------------------------------------------------------
  // Step 4 — Photos for video-visible pets
  // -------------------------------------------------------------------------
  log("STEP", "Step 4 — Generating placeholder photos");

  type PhotoTarget = {
    id: string;
    publicToken: string;
    name: string;
    species: string;
    primaryPhotoId: string | null;
  };
  const photoCols = {
    id: pets.id,
    publicToken: pets.publicToken,
    name: pets.name,
    species: pets.species,
    primaryPhotoId: pets.primaryPhotoId,
  };

  // a) owner@'s 4 pets + b) all renamed pets from Step 2.
  const namedTargets: PhotoTarget[] = await db
    .select(photoCols)
    .from(pets)
    .where(inArray(pets.publicToken, fillTokens));

  // SEED SCOPE: photos may only touch the seed's own pets. Selecting adoption /
  // lost / org pets by a global status predicate would attach placeholder
  // photos to REAL user pets — a mutation of user data. Restrict to the seed's
  // own universe (PANO-* + DIM-DEMO-*). In the demo DB every adoption/lost/org
  // pet is already seed-owned, so this is behavior-preserving there.
  const seedOwnedPet = sql`(${pets.publicToken} LIKE 'PANO-%' OR ${pets.publicToken} LIKE 'DIM-DEMO-%')`;

  // c) active adoption listings (newest 20).
  const adoptionTargets: PhotoTarget[] = await db
    .select(photoCols)
    .from(pets)
    .where(
      and(seedOwnedPet, isNotNull(pets.adoptionListedAt), isNull(pets.adoptionListingPausedAt)),
    )
    .orderBy(desc(pets.adoptionListedAt))
    .limit(20);

  // d) 20 most recent lost pets (updated_at approximates when they went lost;
  // pets has no dedicated lost_at column).
  const lostTargets: PhotoTarget[] = await db
    .select(photoCols)
    .from(pets)
    .where(and(seedOwnedPet, eq(pets.status, "lost")))
    .orderBy(desc(pets.updatedAt))
    .limit(20);

  // e) pets visible in org portals (active org-held ownership, newest 20).
  const orgTargets: PhotoTarget[] = await db
    .select(photoCols)
    .from(ownerships)
    .innerJoin(pets, eq(ownerships.petId, pets.id))
    .where(and(seedOwnedPet, isNotNull(ownerships.ownerOrganizationId), isNull(ownerships.endedAt)))
    .orderBy(desc(ownerships.startedAt))
    .limit(20);

  const photoTargets = [
    ...new Map(
      [...namedTargets, ...adoptionTargets, ...lostTargets, ...orgTargets].map((p) => [p.id, p]),
    ).values(),
  ].slice(0, 80);

  log("OK", `${photoTargets.length} photo candidates after dedup/cap.`);

  for (const pet of photoTargets) {
    if (pet.primaryPhotoId) {
      log("SKIP", `${pet.name} (${pet.publicToken}) already has a primary photo.`);
      continue;
    }
    const bgColor = PHOTO_PALETTE[hashString(pet.publicToken) % PHOTO_PALETTE.length];
    const svg = petPhotoSvg(pet.name, pet.species, bgColor);
    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

    const storagePath = `${randomUUID()}.png`;
    const { error: uploadError } = await supabase.storage
      .from(PET_PHOTOS_BUCKET)
      .upload(storagePath, pngBuffer, { contentType: "image/png" });
    if (uploadError) {
      log("FAIL", `upload failed for ${pet.name}: ${uploadError.message}`);
      continue;
    }

    const [attachment] = await db
      .insert(attachments)
      .values({
        petId: pet.id,
        uploadedByUserId: ownerUserId,
        storagePath,
        mimeType: "image/png",
        fileSize: pngBuffer.length,
      })
      .returning({ id: attachments.id });

    await db.update(pets).set({ primaryPhotoId: attachment.id }).where(eq(pets.id, pet.id));
    summary.photosCreated += 1;
    log("OK", `${pet.name} (${pet.publicToken}) → ${storagePath}`);
  }

  // -------------------------------------------------------------------------
  // Step 5 — Libreta enrichment for owner@'s 4 pets
  // -------------------------------------------------------------------------
  log("STEP", "Step 5 — Enriching libretas of owner@'s 4 pets");

  // pet_events has author_verified (checked in db/schema.ts) — clinical rows
  // get author_role='vet' + author_verified=true. recorded_by is the seeded
  // vet account when available.
  const vetUserId = usersByEmail.get(VET_USER_EMAIL) ?? null;
  if (!vetUserId) log("WARN", `${VET_USER_EMAIL} not found — vet events get recorded_by=NULL.`);

  const CLINICAL_TYPES = [
    "vaccination_administered",
    "deworming_administered",
    "vet_visit_logged",
    "weight_recorded",
  ] as const;

  const libretaPets = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      name: pets.name,
      species: pets.species,
      breed: pets.breed,
      estimatedWeightKg: pets.estimatedWeightKg,
    })
    .from(pets)
    .where(inArray(pets.publicToken, [...OWNER_KEEP_TOKENS]));

  for (const pet of libretaPets) {
    const h = hashString(pet.publicToken);
    const jitter = h % 20; // per-pet day offset so timelines don't align suspiciously
    const existing = await db
      .select({
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        payload: petEvents.payload,
      })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), inArray(petEvents.eventType, [...CLINICAL_TYPES])));

    const cutoff18mo = monthsAgo(18);
    const recentOf = (type: string) =>
      existing.filter((e) => e.eventType === type && e.occurredAt >= cutoff18mo);
    const vaccineNameOf = (e: { payload: unknown }) =>
      String((e.payload as { vaccine_name?: unknown })?.vaccine_name ?? "");

    type NewEvent = typeof petEvents.$inferInsert;
    const toInsert: NewEvent[] = [];
    const vetEventBase = {
      petId: pet.id,
      recordedByUserId: vetUserId,
      authorRole: "vet" as const,
      authorVerified: true,
    };

    // 1) Annual antirrábica. "anual" generic entries from older seeds count as
    // the annual shot — inserting another would look like a duplicate.
    const recentVaccinations = recentOf("vaccination_administered");
    const hasAntirrabica = recentVaccinations.some((e) => /rr[aá]b|anual/i.test(vaccineNameOf(e)));
    if (!hasAntirrabica) {
      const occurred = monthsAgo(4, jitter);
      toInsert.push({
        ...vetEventBase,
        eventType: "vaccination_administered",
        occurredAt: occurred,
        payload: {
          payload_version: 1,
          vaccine_name: "Antirrábica",
          brand: "Nobivac Rabia",
          batch: `NR-2026-${(h % 90) + 10}`,
          administered_by: VET_SIGNATURE,
          next_due_at: dateOnly(addYears(occurred, 1)),
        },
      });
    }

    // 2) One polivalente (species-specific).
    const hasPolivalente = recentVaccinations.some((e) =>
      /s[eé]xtuple|qu[ií]ntuple|triple|polivalente|dhpp|fvrcp|vanguard|felocell/i.test(
        vaccineNameOf(e),
      ),
    );
    if (!hasPolivalente) {
      const isCat = pet.species === "cat";
      const occurred = monthsAgo(10, jitter);
      toInsert.push({
        ...vetEventBase,
        eventType: "vaccination_administered",
        occurredAt: occurred,
        payload: {
          payload_version: 1,
          // CATALOG NAMES, verbatim. These used to read "Triple felina" /
          // "Séxtuple" — close enough for a human, invisible to
          // findVaccineByName, which is exact equality. The seed writes events
          // DIRECTLY, so it bypasses the hard catalog gate the real vet action
          // enforces (app/org/[orgToken]/atender/actions.ts: an uncatalogued
          // name cannot commit unless explicitly flagged), and the demo ended up
          // carrying doses no production path could have created.
          //
          // Cost, measured on the live demo 2026-07-28: a matrícula-signed dose
          // filed as "1 vacuna fuera del calendario" while the core entry
          // reported missing — the libreta told the owner "2 vacunas del
          // calendario recomendado sin aplicar" centimetres above the signed
          // record. The libreta no longer asserts that absence (see
          // lib/domain/libreta-health-status.ts `unconfirmed`), but the demo
          // should not have been manufacturing the ambiguity in the first place.
          vaccine_name: isCat ? "Triple felina (FVRCP)" : "Séxtuple (DHPPi-L)",
          brand: isCat ? "Felocell" : "Vanguard Plus 5",
          batch: `${isCat ? "FC" : "VG"}-2026-${(h % 90) + 10}`,
          administered_by: VET_SIGNATURE,
          next_due_at: dateOnly(addYears(occurred, 1)),
        },
      });
    }

    // 3) Deworming. Schema (lib/events/event-schemas.ts) is strict — no dose
    // field in the payload — so the per-weight dose lands in `notes`.
    if (recentOf("deworming_administered").length === 0) {
      const occurred = monthsAgo(2, jitter);
      const kg =
        pet.estimatedWeightKg ?? deterministicWeightKg(pet.publicToken, pet.breed, pet.species);
      toInsert.push({
        ...vetEventBase,
        eventType: "deworming_administered",
        occurredAt: occurred,
        payload: {
          payload_version: 1,
          product: "Total Full",
          type: "both",
          administered_by: VET_SIGNATURE,
          next_due_at: dateOnly(addMonths(occurred, 3)),
        },
        notes: `Dosis según peso: ${kg} kg`,
      });
    }

    // 4) 4 weight points over the last 12 months trending toward the current
    // cached weight. Insert only enough to reach 4 recent points.
    const cutoff12mo = monthsAgo(12);
    const recentWeights = existing.filter(
      (e) => e.eventType === "weight_recorded" && e.occurredAt >= cutoff12mo,
    );
    const weightsNeeded = Math.max(0, 4 - recentWeights.length);
    if (weightsNeeded > 0) {
      const targetKg = Number(
        pet.estimatedWeightKg ?? deterministicWeightKg(pet.publicToken, pet.breed, pet.species),
      );
      // Oldest → newest: slight upward trend ending at the target weight.
      const slots: Array<[number, number]> = [
        [11.5, 0.93],
        [8, 0.96],
        [4, 0.98],
        [0.5, 1],
      ];
      for (const [months, factor] of slots.slice(4 - weightsNeeded)) {
        toInsert.push({
          ...vetEventBase,
          eventType: "weight_recorded",
          occurredAt: monthsAgo(months, jitter % 10),
          payload: { payload_version: 1, kg: (targetKg * factor).toFixed(1) },
        });
      }
    }

    // 5) One vet visit.
    if (recentOf("vet_visit_logged").length === 0) {
      toInsert.push({
        ...vetEventBase,
        eventType: "vet_visit_logged",
        occurredAt: monthsAgo(3, jitter),
        payload: {
          payload_version: 1,
          reason: "Control anual",
          diagnosis: null,
          vet_name: VET_NAME,
          clinic: VET_CLINIC,
        },
      });
    }

    if (toInsert.length === 0) {
      log("SKIP", `${pet.name} (${pet.publicToken}) libreta already complete.`);
    } else {
      await db.insert(petEvents).values(toInsert);
      summary.eventsInserted += toInsert.length;
      log(
        "OK",
        `${pet.name} (${pet.publicToken}): inserted ${toInsert.length} events (${[
          ...new Set(toInsert.map((e) => e.eventType)),
        ].join(", ")})`,
      );
    }

    // Re-align the estimated_weight_kg cache with the latest weight_recorded
    // event so the pet-cache fitness sweep stays green.
    const [latestWeight] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "weight_recorded")))
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);
    const latestKg = latestWeight
      ? String((latestWeight.payload as { kg?: unknown })?.kg ?? "")
      : "";
    if (latestKg && latestKg !== pet.estimatedWeightKg) {
      await db.update(pets).set({ estimatedWeightKg: latestKg }).where(eq(pets.id, pet.id));
      log("OK", `${pet.name}: estimated_weight_kg cache aligned to ${latestKg} kg.`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 7 — Repair seed-marker profile display names (C5)
  // -------------------------------------------------------------------------
  // The panorama seed's synthetic owner profile used to have
  // display_name='PANO-Seed-Owner' — a renderable column (it surfaces as a
  // case's "Abrió:"/reporter attribution) carrying an obvious seed marker.
  // The generator now writes a realistic name at creation time
  // (scripts/seed-panorama.ts); this step heals a DB seeded before that fix,
  // by the SAME deterministic id, WITHOUT a full re-seed.
  log("STEP", "Step 7 — Repairing seed-marker profile display names");

  const PANO_SEED_OWNER_ID = "00000000-4e41-4154-b000-000000000001";
  const PANO_SEED_OWNER_DISPLAY_NAME = "Marisa Funes"; // MUST match seed-panorama.ts

  const ownerRepaired = await db
    .update(profiles)
    .set({ displayName: PANO_SEED_OWNER_DISPLAY_NAME })
    .where(
      and(
        eq(profiles.id, PANO_SEED_OWNER_ID),
        ne(profiles.displayName, PANO_SEED_OWNER_DISPLAY_NAME),
      ),
    )
    .returning({ id: profiles.id });
  if (ownerRepaired.length > 0) {
    summary.seedProfileNamesRepaired += ownerRepaired.length;
    log(
      "OK",
      `Repaired display_name for the PANO seed-owner profile → "${PANO_SEED_OWNER_DISPLAY_NAME}".`,
    );
  } else {
    log("SKIP", "PANO seed-owner profile display_name already realistic.");
  }

  // Defensive catch-all: any OTHER profile whose display_name still carries a
  // seed marker (drift from an older/unknown seed path). We do NOT know a
  // safe realistic replacement for an unforeseen row, so this only WARNS —
  // silently mass-renaming unknown rows to a shared literal would just trade
  // one fake-looking pattern for another (duplicate names).
  const otherSeedMarked = (await db.execute(sql`
    SELECT id, display_name FROM profiles
    WHERE id <> ${PANO_SEED_OWNER_ID}
      AND (display_name LIKE '%PANO-%' OR display_name LIKE '%-Seed-%' OR display_name LIKE '%HIST-WEL%')
  `)) as unknown as Array<{ id: string; display_name: string }>;
  for (const row of otherSeedMarked) {
    log(
      "WARN",
      `profiles.id=${row.id} display_name="${row.display_name}" still carries a seed marker — repair manually (no known-safe automatic replacement).`,
    );
  }

  // -------------------------------------------------------------------------
  // Step 8 — Repair lucas@ govt scope to whole CABA (C5)
  // -------------------------------------------------------------------------
  // A pre-fix DB has lucas@dim.test assigned ~1774 individual localities
  // across 8 provinces (scripts/seed-demo.ts's old EAST_REGION model). The
  // canonical scope is now ONE row: whole CABA
  // (lib/domain/jurisdiction-canonical.ts WHOLE_PROVINCE_LOCALITY). This
  // revokes every other live assignment and ensures the canonical row exists
  // — a re-seed of seed-demo.ts is NOT required to heal this.
  log("STEP", "Step 8 — Repairing lucas@ govt scope to whole CABA");

  const lucasAuthId = usersByEmail.get("lucas@dim.test");
  const adminAuthId = usersByEmail.get("admin@dim.test");

  if (!lucasAuthId) {
    log("WARN", "lucas@dim.test not found — skipping govt-scope repair.");
  } else {
    const province = "CABA";
    const locality = WHOLE_PROVINCE_LOCALITY.CABA;

    const stale = await db
      .select({ id: govtAssignments.id })
      .from(govtAssignments)
      .where(
        and(
          eq(govtAssignments.userId, lucasAuthId),
          isNull(govtAssignments.revokedAt),
          or(
            ne(govtAssignments.jurisdictionProvince, province),
            ne(govtAssignments.jurisdictionLocality, locality),
          ),
        ),
      );

    if (stale.length > 0) {
      await db
        .update(govtAssignments)
        .set({ revokedAt: new Date(), revokedByUserId: adminAuthId ?? null })
        .where(
          inArray(
            govtAssignments.id,
            stale.map((r) => r.id),
          ),
        );
      summary.lucasAssignmentsRevoked = stale.length;
      log("OK", `Revoked ${stale.length} over-scoped govt_assignments row(s) for lucas@.`);
    } else {
      log("SKIP", "lucas@ has no over-scoped assignments.");
    }

    const [existing] = await db
      .select({ id: govtAssignments.id })
      .from(govtAssignments)
      .where(
        and(
          eq(govtAssignments.userId, lucasAuthId),
          eq(govtAssignments.jurisdictionProvince, province),
          eq(govtAssignments.jurisdictionLocality, locality),
          isNull(govtAssignments.revokedAt),
        ),
      )
      .limit(1);

    if (!existing) {
      await db.insert(govtAssignments).values({
        userId: lucasAuthId,
        jurisdictionProvince: province,
        jurisdictionLocality: locality,
        grantedByUserId: adminAuthId ?? null,
      });
      log("OK", `Assigned lucas@ → ${province} / ${locality}.`);
    } else {
      log("SKIP", `lucas@ already assigned to ${province} / ${locality}.`);
    }
    summary.lucasAssignmentEnsured = true;
  }

  // -------------------------------------------------------------------------
  // Step 9 — Strip seed codes from welfare_reports.description (C5)
  // -------------------------------------------------------------------------
  // Existing rows seeded before the C5 generator fix carry
  // "PANO-welfare-00042 — denuncia sintética de demostración" or
  // "PANO-HIST-WEL-001243 denuncia histórica" verbatim in a RENDERED column.
  // Rewrite each to a realistic citizen-report sentence from the SAME
  // template pool the fixed generator draws from (shared module — both
  // writers stay in lockstep), and backfill seed_tag (migration 0155, never
  // rendered) so the row stays identifiable for future --clean runs without
  // depending on description text. Deterministic pick by row id, so
  // reruns against an already-repaired row are stable no-ops.
  log("STEP", "Step 9 — Repairing welfare_reports.description (strip seed codes)");

  const seedMarkedWelfare = (await db.execute(sql`
    SELECT id, kind, description, seed_tag
    FROM welfare_reports
    WHERE description LIKE 'PANO-%'
       OR description LIKE '%PANO-HIST-WEL-%'
       OR description LIKE '%HIST-WEL%'
  `)) as unknown as Array<{
    id: string;
    kind: string;
    description: string;
    seed_tag: string | null;
  }>;

  for (const row of seedMarkedWelfare) {
    const isHistoric = row.description.includes("HIST-WEL");
    const newDescription = pickWelfareDescriptionDeterministic(row.kind, row.id);
    const seedTag = row.seed_tag ?? (isHistoric ? `PANO-HIST-${row.id.slice(0, 8)}` : "PANO");
    await db.execute(sql`
      UPDATE welfare_reports
      SET description = ${newDescription}, seed_tag = ${seedTag}
      WHERE id = ${row.id}::uuid
    `);
  }
  summary.welfareDescriptionsRepaired = seedMarkedWelfare.length;
  if (seedMarkedWelfare.length > 0) {
    log("OK", `Repaired ${seedMarkedWelfare.length} welfare_reports.description row(s).`);
  } else {
    log("SKIP", "No welfare_reports.description rows carry a seed code.");
  }

  // -------------------------------------------------------------------------
  // Step 10 — Final report
  // -------------------------------------------------------------------------
  log("STEP", "Step 10 — Summary");
  // eslint-disable-next-line no-console
  console.table([
    { metric: "Pets renamed", value: summary.petsRenamed },
    { metric: "Identity fields filled", value: summary.identityFieldsFilled },
    { metric: "Ownerships moved off owner@", value: summary.ownershipsMoved },
    { metric: "PANO names cleaned", value: summary.panoNamesCleaned },
    { metric: "PANO identity rows filled", value: summary.panoFieldsFilled },
    { metric: "Photos created", value: summary.photosCreated },
    { metric: "Libreta events inserted", value: summary.eventsInserted },
    { metric: "Seed profile names repaired", value: summary.seedProfileNamesRepaired },
    { metric: "lucas@ over-scoped assignments revoked", value: summary.lucasAssignmentsRevoked },
    { metric: "Welfare descriptions repaired", value: summary.welfareDescriptionsRepaired },
  ]);
  log("OK", "Done. Now run `pnpm demo:verify` to confirm the demo DB is consistent.");

  // Seed-hygiene gate (C5) — run at the end of the repair flow too, so a
  // polish run reports whether the DB is actually clean afterward.
  log("STEP", "Running seed-hygiene gate…");
  const { findSeedHygieneOffenders } = await import("./check-seed-hygiene");
  const offenders = await findSeedHygieneOffenders(client);
  if (offenders.length > 0) {
    log("FAIL", `Seed-hygiene gate: ${offenders.length} offender(s) remain.`);
    for (const o of offenders.slice(0, 20)) {
      log("FAIL", `  ${o.table}.${o.column} id=${o.id}: "${o.sample}" (${o.matchedPattern})`);
    }
  } else {
    log("OK", "Seed-hygiene gate clean — 0 seed-marker hits.");
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
