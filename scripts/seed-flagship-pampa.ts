/**
 * DIM Flagship Pet Seed — seed-flagship-pampa.ts
 *
 * Seeds "Pampa" (DIM-PAMP-0001) — the ONE flagship pet the public landing is
 * built around. The portada hero shows "Credencial de Pampa" and its scannable
 * QR points at /p/DIM-PAMP-0001, so portada name, QR target and public
 * credential must all resolve to the SAME real animal. This script makes Pampa
 * real and stable. Its facts live in scripts/flagship-pampa-data.ts, the same
 * pure module components/landing/landing-content.ts reads for the story.
 *
 * ─── IDENTITY ───────────────────────────────────────────────────────────────
 *   Token   : DIM-PAMP-0001  (fixed — survives re-seeds; same shape as the
 *             DIM-DEMO-000N demo tokens, valid against the DIM-XXXX-XXXX scheme)
 *   Species : dog, FEMALE, name "Pampa", ~4 años (DOB 2021-11), Caniche blanca
 *   Owner   : owner@dim.test  (the narrative "Martín"; created if missing)
 *   Photo   : public/landing/pampa-hero.jpg → pet-photos bucket → primary_photo_id
 *             (so /p/DIM-PAMP-0001 shows the SAME photo as the portada hero)
 *   State   : ALIVE, al día, RECOVERED — a healthy, current credential.
 *             Her latest vaccine is a VET-SIGNED antirrábica (author_role=vet,
 *             author_verified=true) with a future next_due_at, so the public
 *             credential reads "Verificado por veterinario matriculado" + vigente.
 *
 * ─── LIBRETA ────────────────────────────────────────────────────────────────
 *   The real system events matching LIBRETA_EVENTS (2022→2026), append-only,
 *   using the canonical payload shapes from lib/events/event-schemas.ts:
 *     pet_registered · microchip_implanted · vaccination_administered (vet) ·
 *     sterilization_performed · status_changed (→lost) · credential_scanned ·
 *     shelter_intake_recorded · status_changed (→recovered) ·
 *     clinical_info_logged · vaccination_administered (campaign rabies booster,
 *     vet-signed, the LATEST dose → drives "verificada" + al día).
 *   A canonical pet_identifications microchip row mirrors the implant event.
 *
 * ─── IDEMPOTENCY ────────────────────────────────────────────────────────────
 *   Re-running converges without duplicating rows: the pet is looked up by
 *   token; events are inserted only when the pet has none; the photo uploads to
 *   a fixed storage path (upsert) and re-points primary_photo_id; the microchip
 *   canonical row is guarded by NOT EXISTS.
 *
 * ─── LOCAL-ONLY GUARD ───────────────────────────────────────────────────────
 *   Refuses to run against a non-local DATABASE_URL / Supabase host unless
 *   --allow-remote. ALWAYS refuses when NODE_ENV=production.
 *
 * Usage (local):
 *   pnpm seed:flagship
 * Usage (staging — Ignacio only, .env points at staging):
 *   SEED_DEMO_PASSWORD=<a fresh password> pnpm seed:flagship -- --allow-remote
 *
 *   SEED_DEMO_PASSWORD is used ONLY for accounts this run creates. owner@ and
 *   lilian@ already exist on staging and KEEP their password — a remote seed
 *   never resets an existing account's password (R8/C4b review, 2026-09-23);
 *   both are among the 8 e2e accounts whose password is rotated by
 *   scripts/ops/rotate-staging-e2e-password.ts. For demos, use a personal
 *   account instead of owner@dim.test.
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
// Every Pampa fact lives in this pure data module (no DB, no env), which the
// landing also reads — so the story the landing tells and the pet its QR
// resolves to cannot drift apart.
import {
  OWNER_EMAIL,
  OWNER_NAME,
  PAMPA_CHIP,
  PAMPA_EVENTS,
  PAMPA_PET,
  PAMPA_TOKEN,
  VET_CLINIC,
  VET_EMAIL,
  VET_LICENSE,
  VET_LICENSE_JURISDICTION,
  VET_NAME,
  buildPampaLibreta,
} from "./flagship-pampa-data";

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
// Los guards de abajo colapsan tres estados en dos: `!isLocalDb || !isLocalSupabase`
// declara "remoto" con UNA sola URL remota, asi que con --allow-remote el entorno
// PARTIDO (una local, la otra remota) pasaba igual — que fue como un seed llego a
// escribir en staging leyendo auth de local. Esto lo corta antes; el aborto
// especifico de este script sigue siendo el que explica el caso remoto.
assertNotSplitEnv(SUPABASE_URL, DATABASE_URL, "seed:flagship");

// Parsed hostnames via the shared helper, never substrings, and an empty URL
// is NOT local: "local" is the answer that selects the published password
// (F7 of the R8/C4b security review, 2026-09-23).
const IS_LOCAL = isLocalTarget(SUPABASE_URL, DATABASE_URL);

if (!ALLOW_REMOTE && !IS_LOCAL) {
  console.error(
    [
      "",
      "==============================================================",
      "  ABORT: seed-flagship-pampa target is NOT a local Postgres.",
      "==============================================================",
      `  DATABASE_URL host : ${dbHost ?? "(not set)"}`,
      `  SUPABASE_URL      : ${SUPABASE_URL}`,
      "",
      "  This script writes flagship demo data. Running against a",
      "  remote DB by mistake is a real incident.",
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

const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { createClient: createSdkClient } = await import("@supabase/supabase-js");
const { and, eq, sql } = await import("drizzle-orm");
const { db, pets, ownerships, petEvents, attachments, petIdentifications, profiles } = await import(
  "../db"
);

// ---------------------------------------------------------------------------
// 4. Constants
// ---------------------------------------------------------------------------

// Local keeps the literal the test suite and local dev depend on. Any other
// target (staging, etc.) requires SEED_DEMO_PASSWORD from the environment —
// this repo is public and "Test1234!" is published in it (R8, 2026-09-23).
const SHARED_PASSWORD = resolveSeedPassword(IS_LOCAL, "seed:flagship");
const PET_PHOTOS_BUCKET = "pet-photos";

const HERO_PHOTO_PATH = join(process.cwd(), "public", "landing", "pampa-hero.jpg");

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "FAIL";
function log(tag: LogTag, msg: string): void {
  // eslint-disable-next-line no-console
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

/** owner@dim.test — the flagship pet's owner ("Martín"). Personal account. */
async function ensureOwner(): Promise<string> {
  log("STEP", `Ensuring owner ${OWNER_EMAIL}`);
  const { id, created } = await ensureAuthUser(OWNER_EMAIL, OWNER_NAME);
  await syncSeedPassword(id, created);
  await db
    .update(profiles)
    .set({ role: "owner", accountType: "personal", displayName: OWNER_NAME, updatedAt: new Date() })
    .where(eq(profiles.id, id));
  log(created ? "OK" : "SKIP", `${OWNER_EMAIL} → ${id.slice(0, 8)}…`);
  return id;
}

/**
 * A matriculated vet to sign Pampa's vaccinations. The public credential's
 * confidence tier (lib/events/event-confidence.ts) reads author_role +
 * author_verified off the event, so the signer must be a vet with
 * matricula_verified for the latest dose to read "Verificado por veterinario
 * matriculado". Reuses lilian@dim.test (the seed:demo vet) when present.
 */
async function ensureVet(): Promise<string> {
  log("STEP", `Ensuring vet ${VET_EMAIL} (matriculado)`);
  const { id, created } = await ensureAuthUser(VET_EMAIL, VET_NAME);
  await syncSeedPassword(id, created);
  await db
    .update(profiles)
    .set({
      role: "vet",
      accountType: "personal",
      displayName: VET_NAME,
      matriculaVerified: true,
      matriculaNumber: VET_LICENSE,
      matriculaJurisdiccion: VET_LICENSE_JURISDICTION,
      updatedAt: new Date(),
    })
    .where(eq(profiles.id, id));
  log(created ? "OK" : "SKIP", `${VET_EMAIL} → ${id.slice(0, 8)}…`);
  return id;
}

// ---------------------------------------------------------------------------
// 6. Pet + ownership
// ---------------------------------------------------------------------------

async function ensurePampa(ownerId: string): Promise<{ id: string; created: boolean }> {
  log("STEP", `Ensuring pet ${PAMPA_TOKEN} (Pampa)`);
  const [existing] = await db
    .select({ id: pets.id })
    .from(pets)
    .where(eq(pets.publicToken, PAMPA_TOKEN))
    .limit(1);

  if (existing) {
    // Keep the flagship invariants true even on re-runs: ALIVE + medical
    // summary public. (Never lost/deceased — the hero is a first impression.)
    await db
      .update(pets)
      .set({
        status: "active",
        deceasedAt: null,
        tier2PublicPermanent: true,
        updatedAt: new Date(),
      })
      .where(eq(pets.id, existing.id));
    log("SKIP", `${PAMPA_TOKEN} already exists → ${existing.id.slice(0, 8)}…`);
    return { id: existing.id, created: false };
  }

  const [pet] = await db
    .insert(pets)
    .values({
      ...PAMPA_PET,
      // Owner opted the public medical summary in permanently so /p renders the
      // rich "Resumen médico vigente" (vacunas vigentes, esterilización).
      tier2PublicPermanent: true,
    })
    .returning({ id: pets.id });

  // The owner row starts where the libreta's pet_registered says the
  // registration happened, not at seed time: the holder drift fence replays
  // that event and compares started_at (audit K3/W8).
  const registration = PAMPA_EVENTS.find((e) => e.eventType === "pet_registered");
  if (!registration) throw new Error("flagship-pampa-data has no pet_registered event");
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId: ownerId,
    role: "owner",
    startedAt: dateAtNoonUtc(registration.date),
  });
  log("OK", `${PAMPA_TOKEN} inserted → ${pet.id.slice(0, 8)}…`);
  return { id: pet.id, created: true };
}

// ---------------------------------------------------------------------------
// 7. Photo — public/landing/pampa-hero.jpg → pet-photos bucket
// ---------------------------------------------------------------------------

async function ensureBucket(): Promise<void> {
  const { data: list, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) throw new Error(`listBuckets failed: ${listErr.message}`);
  if (list?.some((b: { name: string }) => b.name === PET_PHOTOS_BUCKET)) return;
  const { error } = await supabase.storage.createBucket(PET_PHOTOS_BUCKET, { public: true });
  if (error) throw new Error(`createBucket failed: ${error.message}`);
  log("OK", `created bucket ${PET_PHOTOS_BUCKET}`);
}

async function ensurePhoto(petId: string): Promise<void> {
  log("STEP", "Uploading pampa-hero.jpg → pet-photos + primary_photo_id");
  await ensureBucket();

  // Fixed storage path → re-runs upsert the SAME object (idempotent).
  const storagePath = `${petId}/flagship-pampa.jpg`;

  const sharp = (await import("sharp")).default;
  const raw = readFileSync(HERO_PHOTO_PATH);
  const jpeg = await sharp(raw)
    .rotate()
    .resize(1024, 1024, { fit: "cover", position: "attention" })
    .jpeg({ quality: 85 })
    .toBuffer();

  const { error: upErr } = await supabase.storage
    .from(PET_PHOTOS_BUCKET)
    .upload(storagePath, jpeg, { contentType: "image/jpeg", upsert: true });
  if (upErr) throw new Error(`upload failed: ${upErr.message}`);

  // Reuse an existing attachment row for this path so re-runs don't pile up.
  const [existingAtt] = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.petId, petId), eq(attachments.storagePath, storagePath)))
    .limit(1);

  let attachmentId: string;
  if (existingAtt) {
    attachmentId = existingAtt.id;
    log("SKIP", "attachment row already present — re-pointing primary_photo_id");
  } else {
    const [att] = await db
      .insert(attachments)
      .values({
        petId,
        storagePath,
        mimeType: "image/jpeg",
        fileSize: jpeg.byteLength,
      })
      .returning({ id: attachments.id });
    attachmentId = att.id;
    log("OK", `attachment row → ${storagePath}`);
  }

  await db.update(pets).set({ primaryPhotoId: attachmentId }).where(eq(pets.id, petId));
  log("OK", "primary_photo_id set");
}

// ---------------------------------------------------------------------------
// 8. Libreta — the events of scripts/flagship-pampa-data.ts (2022→2026)
// ---------------------------------------------------------------------------

async function ensureLibreta(petId: string, ownerId: string, vetId: string): Promise<void> {
  log("STEP", "Seeding Pampa's libreta (append-only events)");

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(petEvents)
    .where(eq(petEvents.petId, petId));

  if (count > 0) {
    log("SKIP", `pet already has ${count} events — leaving the append-only spine intact`);
    return;
  }

  const { events, recordedBy } = buildPampaLibreta(ownerId, vetId);
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
  log("OK", `${events.length} events inserted`);
}

// ---------------------------------------------------------------------------
// 9. Canonical microchip row (mirrors the microchip_implanted event)
// ---------------------------------------------------------------------------

/** The canonical row mirrors the microchip_implanted event's date. */
function chipImplantDate(): string {
  const implant = PAMPA_EVENTS.find((e) => e.eventType === "microchip_implanted");
  if (!implant) throw new Error("flagship-pampa-data has no microchip_implanted event");
  return implant.date;
}

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
    code: PAMPA_CHIP,
    recordedAt: chipImplantDate(),
    recordedByLabel: VET_CLINIC,
    implantationSite: "interescapular",
    isoCountryCode: PAMPA_CHIP.slice(0, 3),
    isoManufacturerCode: PAMPA_CHIP.slice(3, 7),
    isoNationalId: PAMPA_CHIP.slice(7, 15),
    isoCompliant: true,
  });
  log("OK", `microchip canonical row → ${PAMPA_CHIP}`);
}

// ---------------------------------------------------------------------------
// 10. Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("INFO", `Seeding flagship Pampa against ${SUPABASE_URL}`);

  const ownerId = await ensureOwner();
  const vetId = await ensureVet();
  const { id: petId } = await ensurePampa(ownerId);
  await ensurePhoto(petId);
  await ensureLibreta(petId, ownerId, vetId);
  await ensureMicrochip(petId);

  log("DONE", "flagship Pampa seed complete");
  console.log("");
  console.log("=== Flagship pet ===");
  console.log(`  Public credential : /p/${PAMPA_TOKEN}`);
  console.log(
    `  Owner             : ${OWNER_EMAIL} / ${seedPasswordForDisplay(IS_LOCAL, SHARED_PASSWORD)}`,
  );
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("\n[FATAL]", err);
    process.exit(1);
  });
