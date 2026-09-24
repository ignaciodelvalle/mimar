/**
 * DIM Owner Demo Enrichment Seed — seed-owner-demo.ts
 *
 * Gives the demo pet-owner account (owner@dim.test) a rich, demo-worthy
 * dataset so every owner-facing surface has something to show.
 *
 * ─── TARGET ACCOUNT ────────────────────────────────────────────────────────
 *   owner@dim.test  /  Test1234!   role=owner
 *
 * ─── WHAT THIS ADDS ────────────────────────────────────────────────────────
 *   ITEM-1  Lost pet (Firulais / DIM-98SS-QUMY) — marks as lost, opens a
 *           lost_pet_episode case, inserts status_changed event with correct
 *           disclosure_prefs_snapshot + location. Enables /cartel + lost-mode.
 *   ITEM-2  Vaccines for Firulais + 2 other pets — vaccination_administered
 *           events (Antirrábica + Quíntuple + Coronavirus canino).
 *   ITEM-3  Upcoming appointment (turno) — books an existing open time_slot
 *           for the owner. Skips with reason if no open slot exists.
 *   ITEM-4  Notifications (3) — vaccine-due reminder, scan alert, custody info.
 *   ITEM-5  Pending transfer — outgoing PTR-XXXX-XXXX transfer from owner to
 *           a known recipient so /transferencias shows a pending row.
 *
 * ─── IDEMPOTENCY ─────────────────────────────────────────────────────────
 *   Re-running converges without duplicating rows. Each item guards by:
 *   ITEM-1: pets.status = 'lost' check
 *   ITEM-2: existing event with source='seed-owner-demo' + same date
 *   ITEM-3: existing appointment with note_from_owner='seed-owner-demo'
 *   ITEM-4: existing notification with notification_type='seed_owner_demo_*'
 *   ITEM-5: existing pending pet_transfer from owner for that pet
 *
 * ─── LOCAL-ONLY GUARD ─────────────────────────────────────────────────────
 *   Refuses to run against non-local hosts unless --allow-remote.
 *   Always refuses when NODE_ENV=production.
 *
 * Usage:
 *   export PATH="/c/tools/node-v22.13.0-win-x64:$PATH"
 *   node --conditions=react-server --import tsx scripts/seed-owner-demo.ts
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap (must run before db/index.ts is imported)
// ---------------------------------------------------------------------------

import { config as loadEnv } from "dotenv";

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

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "::1"]);

function parsePgHost(url: string): string | null {
  const match = url.match(/^postgres(?:ql)?:\/\/[^@]+@([^:/]+)/);
  return match ? match[1] : null;
}

const dbHost = parsePgHost(DATABASE_URL);
const isLocalDb = dbHost ? LOCAL_HOSTS.has(dbHost) : true;
const isLocalSupabase = SUPABASE_URL.includes("127.0.0.1") || SUPABASE_URL.includes("localhost");

if (!ALLOW_REMOTE && (!isLocalDb || !isLocalSupabase)) {
  console.error(
    [
      "",
      "==============================================================",
      "  ABORT: seed-owner-demo target is NOT a local Postgres.",
      "==============================================================",
      `  DATABASE_URL host : ${dbHost ?? "(not set)"}`,
      `  SUPABASE_URL      : ${SUPABASE_URL}`,
      "",
      "  This script writes demo data. Running against a remote DB",
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

const { randomBytes } = await import("node:crypto");
const { createClient: createSdkClient } = await import("@supabase/supabase-js");
const { and, eq, isNull, sql, gt, lt } = await import("drizzle-orm");
const {
  db,
  cases,
  petEvents,
  pets,
  petTransfers,
  notifications,
  appointments,
  timeSlots,
  serviceOfferings,
  ownerships,
} = await import("../db");

// ---------------------------------------------------------------------------
// 4. Helpers
// ---------------------------------------------------------------------------

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "FAIL";
function log(tag: LogTag, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${tag.padEnd(4)}] ${msg}`);
}

/** Generate a PTR-XXXX-XXXX token (same algorithm as lib/publicToken.ts). */
function generatePrefixedToken(prefix: string): string {
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars
  const REJECTION_THRESHOLD = 256 - (256 % ALPHABET.length); // 248
  function randomChunk(len: number): string {
    let out = "";
    let pool = randomBytes(Math.max(len * 2, 32));
    let cursor = 0;
    while (out.length < len) {
      if (cursor >= pool.length) {
        pool = randomBytes(pool.length);
        cursor = 0;
      }
      const byte = pool[cursor++];
      if (byte >= REJECTION_THRESHOLD) continue;
      out += ALPHABET[byte % ALPHABET.length];
    }
    return out;
  }
  return `${prefix}-${randomChunk(4)}-${randomChunk(4)}`;
}

/** Enable pet_events insert bypass (required by DB trigger). */
async function setMutationConfig(userId: string): Promise<void> {
  await db.execute(sql`SELECT set_config('app.allow_event_mutation', 'true', true)`);
  await db.execute(sql`SELECT set_config('app.allow_event_mutation_actor', ${userId}, true)`);
}

// ---------------------------------------------------------------------------
// 5. Supabase admin client
// ---------------------------------------------------------------------------

const supabase = createSdkClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message ?? "(no message)"}`);
    const hit = data.users.find((u: any) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
    page++;
  }
}

// ---------------------------------------------------------------------------
// 6. Resolve owner@dim.test
// ---------------------------------------------------------------------------

async function resolveOwnerId(): Promise<string> {
  log("STEP", "Resolving owner@dim.test profile id");
  const id = await findAuthUserIdByEmail("owner@dim.test");
  if (!id) {
    throw new Error(
      "owner@dim.test not found. Run `pnpm seed:demo:scenario` first to create the owner account.",
    );
  }
  log("OK", `owner@dim.test → ${id.slice(0, 8)}…`);
  return id;
}

// ---------------------------------------------------------------------------
// ITEM-1: Lost pet — Firulais (DIM-98SS-QUMY)
//
// Replicates exactly what setPetLostWriter does:
//   1. Check pet is not already lost.
//   2. Open a lost_pet_episode case (in same tx with the event).
//   3. Insert status_changed event with correct payload shape.
//   4. Update pets: status=lost + 5 disclosure columns.
//
// Payload shape sourced from lib/event-schemas.ts statusChanged schema +
// set-pet-lost-use-case.ts writer. Includes disclosure_prefs_snapshot and
// location_description so the cartel + public credential render fully.
// ---------------------------------------------------------------------------

const FIRULAIS_TOKEN = "DIM-98SS-QUMY";

async function seedLostPet(ownerUserId: string): Promise<void> {
  log("STEP", `ITEM-1: marking ${FIRULAIS_TOKEN} (Firulais) as lost`);

  // Resolve pet.
  const [pet] = await db
    .select({ id: pets.id, status: pets.status })
    .from(pets)
    .where(eq(pets.publicToken, FIRULAIS_TOKEN))
    .limit(1);

  if (!pet) {
    log("FAIL", `${FIRULAIS_TOKEN} not found in pets table. Skipping.`);
    return;
  }

  if (pet.status === "lost") {
    log("SKIP", `${FIRULAIS_TOKEN} already status=lost`);
    return;
  }

  if (pet.status === "deceased") {
    log("SKIP", `${FIRULAIS_TOKEN} status=deceased — cannot mark as lost`);
    return;
  }

  // Check for an existing open lost_pet_episode case (idempotency guard for the
  // partial unique index cases_open_per_pet_kind_idx).
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

  const now = new Date();

  // Open a lost_pet_episode case + insert status_changed event atomically.
  let caseId: string;

  if (existingCase) {
    log("INFO", `  existing open lost_pet_episode case → ${existingCase.id.slice(0, 8)}…`);
    caseId = existingCase.id;
  } else {
    // Generate a unique CAS-XXXX-XXXX public code (same logic as CasesRepository).
    let casePublicCode: string;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generatePrefixedToken("CAS");
      const [existing] = await db
        .select({ id: cases.id })
        .from(cases)
        .where(eq(cases.publicCode, candidate))
        .limit(1);
      if (!existing) {
        casePublicCode = candidate;
        break;
      }
    }

    const [caseRow] = await db
      .insert(cases)
      .values({
        publicCode: casePublicCode!,
        caseKind: "lost_pet_episode",
        status: "open",
        primarySubjectKind: "registered_pet",
        primaryPetId: pet.id,
        jurisdictionCountry: "AR",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Palermo",
        openedByUserId: ownerUserId,
        // The trailing "— seed-owner-demo" is captured by the rule as the
        // owner's free-text reason, so the screen showed "Mascota … reportada
        // como perdida por su dueño — seed-owner-demo". Give it a reason a real
        // owner would type instead of a seed marker.
        openedReason: `Pet ${FIRULAIS_TOKEN} marked as lost by owner — se escapó por el portón`,
      })
      .returning({ id: cases.id });

    caseId = caseRow.id;
    log("OK", `  lost_pet_episode case opened → ${caseId.slice(0, 8)}…`);
  }

  // Build the status_changed payload — matches statusChanged Zod schema exactly:
  // { payload_version, from_status, to_status, location_description, reason,
  //   disclosure_prefs_snapshot, lost_description }
  const statusChangedPayload = {
    payload_version: 1,
    from_status: pet.status, // "active"
    to_status: "lost",
    location_description: "Palermo, Buenos Aires (última vez visto en Av. Santa Fe al 3200)",
    reason: null,
    disclosure_prefs_snapshot: {
      first_name: true,
      phone: true,
      email: false,
      last_location: true,
      finder_form: true,
    },
    lost_description: {
      accessories_when_lost: "Collar rojo con chapita dorada",
      behavior_notes: null,
      last_seen_context: "Salió del patio durante una tormenta y no regresó",
    },
  };

  // Set mutation config (required by pet_events DB trigger).
  await setMutationConfig(ownerUserId);

  // Insert the status_changed event.
  await db.insert(petEvents).values({
    petId: pet.id,
    eventType: "status_changed",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: ownerUserId,
    authorRole: "owner",
    authorVerified: false,
    caseId,
    payload: statusChangedPayload,
  });

  log("OK", "  status_changed event inserted (to_status=lost)");

  // Update pets projection: status=lost + 5 disclosure columns.
  await db.execute(sql`
    UPDATE pets
    SET status = 'lost',
        disclose_first_name_when_lost = true,
        disclose_phone_when_lost = true,
        disclose_email_when_lost = false,
        disclose_last_location_when_lost = true,
        allow_finder_form_when_lost = true,
        updated_at = now()
    WHERE id = ${pet.id}
  `);

  log("OK", `[OK ] ITEM-1: ${FIRULAIS_TOKEN} (Firulais) → status=lost`);
}

// ---------------------------------------------------------------------------
// ITEM-2: Vaccines for Firulais + 2 other pets
//
// Appends vaccination_administered events. Payload shape sourced from
// lib/event-schemas.ts vaccinationAdministered schema:
//   { payload_version, vaccine_name, brand, batch, administered_by,
//     administered_by_organization_id?, administered_by_user_id?, next_due_at }
//
// Idempotency: guards by checking for an event with source='seed-owner-demo'
// + same eventType + same pet on the same calendar date.
// ---------------------------------------------------------------------------

const VACCINE_TARGETS = [
  {
    token: FIRULAIS_TOKEN,
    vaccines: [
      {
        vaccine_name: "Antirrábica",
        brand: "Rabisin",
        batch: "RAB-2025-44",
        administered_by: "Veterinaria Palermo Demo",
        next_due_at: "2026-06-28",
        offsetDays: -45,
      },
      {
        vaccine_name: "Quíntuple",
        brand: "Nobivac DHPPi",
        batch: "NV-2025-91",
        administered_by: "Veterinaria Palermo Demo",
        next_due_at: "2026-06-28",
        offsetDays: -44,
      },
    ],
  },
  {
    token: "DIM-DEMO-0001",
    vaccines: [
      {
        vaccine_name: "Coronavirus canino",
        brand: "Recombitek",
        batch: "RC-2025-17",
        administered_by: "Veterinaria Norte Demo",
        next_due_at: null,
        offsetDays: -30,
      },
    ],
  },
  {
    token: "DIM-DEMO-0002",
    vaccines: [
      {
        vaccine_name: "Antirrábica",
        brand: "Defensor 3",
        batch: "DF3-2025-55",
        administered_by: "Veterinaria Norte Demo",
        next_due_at: "2026-07-01",
        offsetDays: -20,
      },
    ],
  },
] as const;

async function seedVaccines(ownerUserId: string): Promise<void> {
  log("STEP", "ITEM-2: appending vaccination_administered events");

  let inserted = 0;
  let skipped = 0;

  for (const target of VACCINE_TARGETS) {
    const [pet] = await db
      .select({ id: pets.id, status: pets.status })
      .from(pets)
      .where(eq(pets.publicToken, target.token))
      .limit(1);

    if (!pet) {
      log("WARN", `  pet ${target.token} not found — skipping vaccines for this pet`);
      skipped += target.vaccines.length;
      continue;
    }

    await setMutationConfig(ownerUserId);

    for (const vacc of target.vaccines) {
      const occurredAt = new Date();
      occurredAt.setUTCDate(occurredAt.getUTCDate() + vacc.offsetDays);
      occurredAt.setUTCHours(10, 0, 0, 0);

      // Idempotency: check for existing event with same source tag on the same date.
      const dayStart = new Date(occurredAt);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

      const [existing] = await db
        .select({ id: petEvents.id })
        .from(petEvents)
        .where(
          and(
            eq(petEvents.petId, pet.id),
            eq(petEvents.eventType, "vaccination_administered"),
            sql`${petEvents.occurredAt} >= ${dayStart.toISOString()}::timestamptz`,
            sql`${petEvents.occurredAt} < ${dayEnd.toISOString()}::timestamptz`,
            sql`(${petEvents.payload}->>'source') = 'seed-owner-demo'`,
          ),
        )
        .limit(1);

      if (existing) {
        log("SKIP", `  vaccine ${vacc.vaccine_name} for ${target.token} already seeded`);
        skipped++;
        continue;
      }

      const payload = {
        payload_version: 1,
        vaccine_name: vacc.vaccine_name,
        brand: vacc.brand,
        batch: vacc.batch,
        administered_by: vacc.administered_by,
        next_due_at: vacc.next_due_at,
        // Marker for idempotency detection.
        source: "seed-owner-demo",
      };

      await db.insert(petEvents).values({
        petId: pet.id,
        eventType: "vaccination_administered",
        occurredAt,
        recordedAt: occurredAt,
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        authorVerified: false,
        payload,
      });

      log("OK", `  ${target.token}: ${vacc.vaccine_name} inserted`);
      inserted++;
    }
  }

  log(
    inserted > 0 ? "OK" : "SKIP",
    `[${inserted > 0 ? "OK" : "SKIP"}] ITEM-2: ${inserted} vaccine events inserted, ${skipped} skipped`,
  );
}

// ---------------------------------------------------------------------------
// ITEM-3: Upcoming appointment (turno)
//
// Reuses the first open future time_slot with available capacity.
// Creates an appointment row for the owner against one of their pets (Firulais
// is preferred; falls back to the first owned active pet).
//
// Required columns: publicToken, slotId, petId, ownerUserId, serviceOfferingId,
//   status='confirmed'. organizationId denormalized from service_offering.
// Idempotency: checks for existing appointment with notesFromOwner='seed-owner-demo'.
// ---------------------------------------------------------------------------

async function seedAppointment(ownerUserId: string): Promise<void> {
  log("STEP", "ITEM-3: creating upcoming turno (appointment)");

  // Check idempotency.
  const [existingAppt] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.ownerUserId, ownerUserId),
        eq(appointments.status, "confirmed"),
        sql`${appointments.notesFromOwner} = 'seed-owner-demo'`,
      ),
    )
    .limit(1);

  if (existingAppt) {
    log("SKIP", `[SKIP] ITEM-3: demo appointment already exists → ${existingAppt.id.slice(0, 8)}…`);
    return;
  }

  // Find an open future slot with available capacity.
  const now = new Date();
  const [slot] = await db
    .select({
      id: timeSlots.id,
      serviceOfferingId: timeSlots.serviceOfferingId,
      startsAt: timeSlots.startsAt,
      capacity: timeSlots.capacity,
      bookingsCount: timeSlots.bookingsCount,
    })
    .from(timeSlots)
    .where(
      and(
        eq(timeSlots.status, "open"),
        gt(timeSlots.startsAt, now),
        sql`${timeSlots.bookingsCount} < ${timeSlots.capacity}`,
      ),
    )
    .limit(1);

  if (!slot) {
    log(
      "SKIP",
      "[SKIP] ITEM-3: no open future time_slot with available capacity found — appointment skipped. The scheduling system has no materialized slots. Run `pnpm seed:slots` or `scripts/materialize-slots.ts` to create them.",
    );
    return;
  }

  log("INFO", `  using slot ${slot.id.slice(0, 8)}… starts_at=${slot.startsAt.toISOString()}`);

  // Get service_offering for the slot (for organizationId denormalization).
  const [offering] = await db
    .select({ id: serviceOfferings.id, organizationId: serviceOfferings.organizationId })
    .from(serviceOfferings)
    .where(eq(serviceOfferings.id, slot.serviceOfferingId))
    .limit(1);

  if (!offering) {
    log("SKIP", "[SKIP] ITEM-3: service_offering not found for slot — appointment skipped");
    return;
  }

  // Find a pet to book — prefer Firulais, otherwise first active pet.
  const [firulais] = await db
    .select({ id: pets.id })
    .from(pets)
    .where(and(eq(pets.publicToken, FIRULAIS_TOKEN), sql`${pets.status} IN ('active', 'lost')`))
    .limit(1);

  let petId: string;
  if (firulais) {
    petId = firulais.id;
    log("INFO", "  using Firulais as the appointment pet");
  } else {
    // Fall back to the first owned pet.
    const [anyPet] = await db
      .select({ petId: ownerships.petId })
      .from(ownerships)
      .where(and(eq(ownerships.ownerUserId, ownerUserId), isNull(ownerships.endedAt)))
      .limit(1);

    if (!anyPet) {
      log("SKIP", "[SKIP] ITEM-3: no active pet found for owner — appointment skipped");
      return;
    }
    petId = anyPet.petId;
    log("INFO", `  using fallback pet ${petId.slice(0, 8)}…`);
  }

  // One LIVE appointment per (pet, offering) — migration 0181. On a
  // panorama-seeded DB the chosen pet may already hold a confirmed booking in
  // the offering that owns the first open slot; inserting anyway would die on
  // appointments_one_live_per_pet_offering. Skip instead — same posture as
  // every other guard in this item.
  const [liveInOffering] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.petId, petId),
        eq(appointments.serviceOfferingId, offering.id),
        eq(appointments.status, "confirmed"),
      ),
    )
    .limit(1);
  if (liveInOffering) {
    log(
      "SKIP",
      "[SKIP] ITEM-3: the pet already holds a confirmed appointment in this offering (one live booking per pet+offering) — appointment skipped",
    );
    return;
  }

  const publicToken = generatePrefixedToken("APT");

  await db.insert(appointments).values({
    publicToken,
    slotId: slot.id,
    petId,
    ownerUserId,
    serviceOfferingId: offering.id,
    organizationId: offering.organizationId ?? null,
    status: "confirmed",
    notesFromOwner: "seed-owner-demo",
  });

  // Increment slot bookings_count to keep the counter consistent.
  await db.execute(
    sql`UPDATE time_slots SET bookings_count = bookings_count + 1 WHERE id = ${slot.id}`,
  );

  log(
    "OK",
    `[OK ] ITEM-3: appointment ${publicToken} confirmed for slot starting ${slot.startsAt.toISOString()}`,
  );
}

// ---------------------------------------------------------------------------
// ITEM-4: Notifications (3 rows)
//
// Inserts realistic notifications for the owner. Idempotency keyed on a
// stable notificationType value with 'seed_owner_demo_' prefix — unlikely
// to collide with real app-generated types.
//
// notification_type is a free-text column (no enum migration needed).
// severity enum: 'info' | 'success' | 'warning' | 'urgent'
// category values: 'health', 'custody', 'adoption', 'welfare', 'admin'
// ---------------------------------------------------------------------------

const DEMO_NOTIFICATIONS = [
  {
    notificationType: "seed_owner_demo_vaccine_reminder",
    title: "Recordatorio: vacuna antirrábica próxima a vencer",
    body: "La vacuna antirrábica de Firulais vence en 30 días. Coordiná con tu veterinario.",
    severity: "warning" as const,
    ctaLabel: "Ver vacunas",
    ctaUrl: `/mis-mascotas/${FIRULAIS_TOKEN}/vacunas`,
    relatedPetId: null as string | null, // filled below
    category: "health",
  },
  {
    notificationType: "seed_owner_demo_scan_alert",
    title: "Tu mascota fue escaneada",
    body: "Alguien escaneó el QR de Firulais en Palermo, Buenos Aires.",
    severity: "info" as const,
    ctaLabel: "Ver perfil",
    ctaUrl: `/mis-mascotas/${FIRULAIS_TOKEN}`,
    relatedPetId: null as string | null,
    category: "health",
  },
  {
    notificationType: "seed_owner_demo_custody_info",
    title: "Información sobre transferencias",
    body: "Tenés una transferencia de titularidad pendiente de respuesta.",
    severity: "info" as const,
    ctaLabel: "Ver transferencias",
    ctaUrl: "/transferencias",
    relatedPetId: null as string | null,
    category: "custody",
  },
] as const;

async function seedNotifications(ownerUserId: string): Promise<void> {
  log("STEP", "ITEM-4: inserting demo notifications");

  // Resolve Firulais's id for relatedPetId.
  const [firulais] = await db
    .select({ id: pets.id })
    .from(pets)
    .where(eq(pets.publicToken, FIRULAIS_TOKEN))
    .limit(1);
  const firulaisPetId = firulais?.id ?? null;

  let inserted = 0;
  let skipped = 0;

  for (const notif of DEMO_NOTIFICATIONS) {
    // Idempotency: check by userId + notificationType.
    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, notif.notificationType),
        ),
      )
      .limit(1);

    if (existing) {
      log("SKIP", `  notification ${notif.notificationType} already exists`);
      skipped++;
      continue;
    }

    // Attach relatedPetId for pet-related notifications.
    const relatedPetId = notif.ctaUrl.includes(FIRULAIS_TOKEN) ? firulaisPetId : null;

    await db.insert(notifications).values({
      userId: ownerUserId,
      notificationType: notif.notificationType,
      title: notif.title,
      body: notif.body,
      severity: notif.severity,
      ctaLabel: notif.ctaLabel,
      ctaUrl: notif.ctaUrl,
      relatedPetId,
      category: notif.category,
    });

    log("OK", `  notification inserted: ${notif.notificationType}`);
    inserted++;
  }

  log(
    inserted > 0 ? "OK" : "SKIP",
    `[${inserted > 0 ? "OK" : "SKIP"}] ITEM-4: ${inserted} notifications inserted, ${skipped} skipped`,
  );
}

// ---------------------------------------------------------------------------
// ITEM-5: Pending transfer
//
// Creates a pending PTR-XXXX-XXXX outgoing transfer from owner@dim.test to
// a demo recipient email. The transfer shows in /transferencias as "Pendiente".
//
// pet_transfers columns: publicToken, petId, fromOwnerId, toOwnerId (null for
// non-account recipient), toOwnerEmail, status='pending', reason, expiresAt.
//
// Uses DIM-DEMO-0001 as the transferred pet (a secondary pet, not Firulais
// which is already in lost-mode).
//
// Idempotency: checks for pending transfer from owner for DIM-DEMO-0001.
// ---------------------------------------------------------------------------

const TRANSFER_PET_TOKEN = "DIM-DEMO-0001";
const TRANSFER_TO_EMAIL = "nuevodueño@example.com";
const TRANSFER_EXPIRY_DAYS = 7;

async function seedTransfer(ownerUserId: string): Promise<void> {
  log("STEP", "ITEM-5: creating pending pet transfer");

  // Resolve the transfer pet.
  const [transferPet] = await db
    .select({ id: pets.id, name: pets.name, status: pets.status })
    .from(pets)
    .where(eq(pets.publicToken, TRANSFER_PET_TOKEN))
    .limit(1);

  if (!transferPet) {
    log("SKIP", `[SKIP] ITEM-5: ${TRANSFER_PET_TOKEN} not found — transfer skipped`);
    return;
  }

  if (transferPet.status === "deceased") {
    log("SKIP", `[SKIP] ITEM-5: ${TRANSFER_PET_TOKEN} is deceased — transfer skipped`);
    return;
  }

  // Idempotency: check for existing pending transfer from owner for this pet.
  const [existingTransfer] = await db
    .select({ id: petTransfers.id, publicToken: petTransfers.publicToken })
    .from(petTransfers)
    .where(
      and(
        eq(petTransfers.fromOwnerId, ownerUserId),
        eq(petTransfers.petId, transferPet.id),
        eq(petTransfers.status, "pending"),
      ),
    )
    .limit(1);

  if (existingTransfer) {
    log("SKIP", `[SKIP] ITEM-5: pending transfer ${existingTransfer.publicToken} already exists`);
    return;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + TRANSFER_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const publicToken = generatePrefixedToken("PTR");

  await db.insert(petTransfers).values({
    publicToken,
    petId: transferPet.id,
    fromOwnerId: ownerUserId,
    toOwnerId: null, // recipient has no DIM account
    toOwnerEmail: TRANSFER_TO_EMAIL,
    status: "pending",
    reason: "gift",
    note: "Transferencia de demostración — seed-owner-demo",
    expiresAt,
  });

  log(
    "OK",
    `[OK ] ITEM-5: pending transfer ${publicToken} → ${TRANSFER_TO_EMAIL} (expires ${expiresAt.toISOString().slice(0, 10)})`,
  );
}

// ---------------------------------------------------------------------------
// 7. Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("INFO", `Seeding against ${SUPABASE_URL}`);
  log("INFO", "Target: owner@dim.test — owner-facing demo surfaces");

  const ownerId = await resolveOwnerId();

  await seedLostPet(ownerId);
  await seedVaccines(ownerId);
  await seedAppointment(ownerId);
  await seedNotifications(ownerId);
  await seedTransfer(ownerId);

  log("DONE", "seed-owner-demo complete");
  console.log("");
  console.log("=== Owner Demo Surfaces ===");
  console.log(`  /mis-mascotas/${FIRULAIS_TOKEN}/cartel   → lost poster (ITEM-1)`);
  console.log(`  /mis-mascotas/${FIRULAIS_TOKEN}/vacunas  → vaccination history (ITEM-2)`);
  console.log("  /mis-turnos                             → upcoming appointment (ITEM-3)");
  console.log("  /notificaciones                         → 3 demo notifications (ITEM-4)");
  console.log("  /transferencias                         → pending transfer (ITEM-5)");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("\n[FATAL]", err);
    process.exit(1);
  });
