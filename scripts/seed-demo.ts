/**
 * DIM Demo Seed — Loader (the entry point).
 *
 * Run with:
 *   pnpm tsx scripts/seed-demo.ts            # full seed against local Supabase
 *   pnpm tsx scripts/seed-demo.ts --stats    # print coverage stats (no DB)
 *
 * What this file does:
 *   1. Bootstraps 8 demo users (shared password "Test1234!" locally;
 *      SEED_DEMO_PASSWORD from env is required for any --allow-remote target,
 *      used only for users this run creates, and never printed there).
 *   2. Creates 5 organizations, Lucas's govt assignment (whole CABA —
 *      see provisionGovtAssignments below; C5 fix, 2026-07-22) and the
 *      gov-pba@ Provincia de Buenos Aires assignments (Tigre + 3 partidos —
 *      see provisionPbaGovtAssignments).
 *   3. Wires memberships (Alejo as multi-org coordinator, Lilian as vet,
 *      Noelí + Graciela as foster volunteers).
 *   4. Creates the `seed-photos` Supabase Storage bucket and uploads pet
 *      avatars from `scripts/assets/pet-photos/`.
 *   5. Inserts every Storyline registered in STORYLINES — currently the
 *      7 iconic-pet timelines from `seed-storylines-iconic.ts`. As additional
 *      storyline modules land (original-10 rewrite, Cujo, Roco, supporting
 *      cast), they get appended to STORYLINES and loaded here without
 *      changing this file.
 *
 * Rules / conventions:
 *   - Refuses to run against non-local Supabase or NODE_ENV=production.
 *   - Idempotent end-to-end — every entity (auth user, profile, org,
 *     membership, govt_assignment, pet, ownership, attachment, pet_event)
 *     is upserted on `(stable key)` so re-running converges to the same
 *     state.
 *   - Historical pets retain their closed-cycle status; replacement pets
 *     register as separate rows under the SAME owner per the canon-friend
 *     rule (Hachiko Ni Sei to Ignacio; Hanako to whoever holds Kabosu).
 *
 * Mirrors the patterns established in `scripts/seed-test-users.ts`:
 *   - dotenv loaded BEFORE any heavy import that touches DATABASE_URL.
 *   - Local-URL safety check.
 *   - log("STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "FAIL", msg).
 *   - syncDniVerified bypass for the Mi Argentina OAuth (not wired yet).
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap + safety guards (must run before db/index.ts imports)
// ---------------------------------------------------------------------------

import path from "node:path";
import { config as loadEnv } from "dotenv";

import type { EnvTarget } from "./_env-target";
import { resolveEnvTarget, resolveSeedPassword, seedPasswordForDisplay } from "./_env-target";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const STATS_ONLY = process.argv.includes("--stats");
// --allow-remote opts out of the local-only guard so the demo storylines can be
// seeded into a remote (e.g. staging) project. NODE_ENV=production stays hard-
// blocked. The seed is idempotent (every entity upserts on a stable key).
const ALLOW_REMOTE = process.argv.includes("--allow-remote");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

let envTarget: EnvTarget | null = null;
if (!STATS_ONLY) {
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
  // Tres estados, no dos — incluido el PARTIDO. Ver scripts/_env-target.ts.
  envTarget = resolveEnvTarget(SUPABASE_URL, DATABASE_URL, ALLOW_REMOTE, "seed:demo");
}

// ---------------------------------------------------------------------------
// 2. Imports — EVENT_TYPES and Storyline data load eagerly (data-only files),
// DB-touching modules load lazily via loadDbDeps() after env is set.
// ---------------------------------------------------------------------------

import { EVENT_TYPES, type EventType } from "../db/schema";
import { WHOLE_PROVINCE_LOCALITY } from "../lib/domain/jurisdiction-canonical";
import { chipImplantSiteFromLocation } from "../lib/domain/microchip-implant-site";
import { DANGEROUS_STORYLINES } from "./seed-storylines-dangerous";
import { STORYLINES as ICONIC_STORYLINES } from "./seed-storylines-iconic";
import { LEGEND_STORYLINES } from "./seed-storylines-legends";
import { ORIGINAL_10_STORYLINES } from "./seed-storylines-original10";
import { SUPPORTING_STORYLINES } from "./seed-storylines-supporting";

// Aggregated registry — single source of truth for the loader.
// Modules: iconic (7), original10 (11), dangerous (2), supporting (14), legends (3).
export const STORYLINES = [
  ...ICONIC_STORYLINES,
  ...ORIGINAL_10_STORYLINES,
  ...DANGEROUS_STORYLINES,
  ...SUPPORTING_STORYLINES,
  ...LEGEND_STORYLINES,
];

type DbDeps = {
  db: any;
  drizzle: { and: any; eq: any; ne: any; or: any; isNull: any; inArray: any; sql: any };
  supabase: any;
  schemas: {
    profiles: any;
    pets: any;
    ownerships: any;
    petEvents: any;
    petIdentifications: any;
    organizations: any;
    organizationMemberships: any;
    organizationCoverage: any;
    govtAssignments: any;
    arLocalities: any;
    attachments: any;
    petServiceDog: any;
    reminders: any;
    notifications: any;
    auditLog: any;
  };
  publicTokenLib: { generatePublicToken: () => string };
};

async function loadDbDeps(): Promise<DbDeps> {
  const { createClient: createSdkClient } = await import("@supabase/supabase-js");
  const drizzle = await import("drizzle-orm");
  const db = (await import("../db")) as any;
  const publicTokenLib = await import("@/lib/infra/publicToken");

  const supabase = createSdkClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return {
    db: db.db,
    drizzle: {
      and: drizzle.and,
      eq: drizzle.eq,
      ne: drizzle.ne,
      or: drizzle.or,
      isNull: drizzle.isNull,
      inArray: drizzle.inArray,
      sql: drizzle.sql,
    },
    supabase,
    schemas: {
      profiles: db.profiles,
      pets: db.pets,
      ownerships: db.ownerships,
      petEvents: db.petEvents,
      petIdentifications: db.petIdentifications,
      organizations: db.organizations,
      organizationMemberships: db.organizationMemberships,
      organizationCoverage: db.organizationCoverage,
      govtAssignments: db.govtAssignments,
      arLocalities: db.arLocalities,
      attachments: db.attachments,
      petServiceDog: db.petServiceDog,
      reminders: db.reminders,
      notifications: db.notifications,
      auditLog: db.auditLog,
    },
    publicTokenLib,
  };
}

// ---------------------------------------------------------------------------
// 3. Constants — users, orgs, locations, photo manifest
// ---------------------------------------------------------------------------

// Local keeps the literal the test suite and local dev depend on. Any other
// target (staging, etc.) requires SEED_DEMO_PASSWORD from the environment —
// this repo is public and "Test1234!" is published in it (R8, 2026-09-23).
// STATS_ONLY never writes, so the literal is inert there.
const SHARED_PASSWORD = STATS_ONLY
  ? "Test1234!"
  : resolveSeedPassword(envTarget?.isLocal ?? false, "seed:demo");

export const USERS = {
  ignacio: {
    email: "ignacio@dim.test",
    displayName: "Ignacio del Valle",
    role: "owner" as const,
    phone: "+54 9 11 5555-2001",
  },
  noeli: {
    email: "noeli@dim.test",
    displayName: "Noelí Assandri",
    role: "owner" as const,
    phone: "+54 9 11 5555-2002",
  },
  graciela: {
    email: "graciela@dim.test",
    displayName: "Graciela Saavedra",
    role: "owner" as const,
    phone: "+54 9 11 5555-2003",
  },
  lilian: {
    email: "lilian@dim.test",
    displayName: "Dra. Lilian Marrone",
    role: "vet" as const,
    phone: "+54 9 11 5555-2004",
  },
  alejo: {
    email: "alejo@dim.test",
    displayName: "Alejo Caride",
    role: "owner" as const,
    phone: "+54 9 11 5555-2005",
  },
  lucas: {
    email: "lucas@dim.test",
    displayName: "Lucas Etcheverry",
    role: "govt" as const,
    phone: "+54 9 11 5555-2006",
  },
  // Provincia de Buenos Aires funcionaria — the second govt persona (demo tour
  // 8). Her jurisdictions include Tigre on purpose: the PANO custody disputes
  // and panorama data concentrate in PBA partidos (Tigre ×2 among the open
  // disputes), so this account sees real data on day one, while Lucas stays
  // CABA-scoped (his empty /gob/disputas is coverage, not a bug).
  govPba: {
    email: "gov-pba@dim.test",
    displayName: "Valeria Ocampo",
    role: "govt" as const,
    phone: "+54 9 221 5555-2007",
  },
  admin: {
    email: "admin@dim.test",
    displayName: "Administración miMAR",
    role: "admin" as const,
    phone: null,
  },
} as const;

export type UserKey = keyof typeof USERS;

export const ORGS = {
  "patitas-del-norte": {
    name: "Refugio Patitas del Norte",
    legalName: "Asociación Civil Patitas del Norte",
    orgType: "shelter" as const,
    cuit: "30-71000001-1",
    email: "contacto@patitasdelnorte.test",
    phone: "+54 9 11 5555-3001",
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Palermo",
    coverage: [
      { province: "CABA", locality: "Palermo", isPrimary: true },
      { province: "CABA", locality: "Recoleta", isPrimary: false },
    ],
    verified: true,
  },
  "clinica-recoleta": {
    name: "Clínica Veterinaria Recoleta",
    legalName: "Clínica Veterinaria Recoleta S.A.",
    orgType: "clinic" as const,
    cuit: "30-71000002-2",
    email: "turnos@clinicarecoleta.test",
    phone: "+54 9 11 5555-3002",
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Recoleta",
    coverage: [{ province: "CABA", locality: "Recoleta", isPrimary: true }],
    verified: true,
  },
  "rescate-puerto-madero": {
    name: "Red de Rescate Puerto Madero",
    legalName: "Red de Rescate Puerto Madero Asoc. Civil",
    orgType: "rescue_network" as const,
    cuit: "30-71000003-3",
    email: "rescate@puertomadero.test",
    phone: "+54 9 11 5555-3003",
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Puerto Madero",
    coverage: [
      { province: "CABA", locality: "Puerto Madero", isPrimary: true },
      { province: "CABA", locality: "Retiro", isPrimary: false },
      { province: "CABA", locality: "San Nicolás", isPrimary: false },
    ],
    verified: true,
  },
  "mascotas-ba-centro": {
    name: "Mascotas BA Centro",
    legalName: "Mascotas BA — Comuna 1 (placeholder)",
    orgType: "sanitary_authority" as const,
    cuit: "30-71000004-4",
    email: "centro@mascotasba.test",
    phone: "+54 9 11 5555-3004",
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Retiro",
    coverage: [
      { province: "CABA", locality: "Retiro", isPrimary: true },
      { province: "CABA", locality: "Puerto Madero", isPrimary: false },
      { province: "CABA", locality: "San Nicolás", isPrimary: false },
    ],
    verified: true,
  },
  "refugio-pendiente": {
    name: "Refugio Pendiente Verificación",
    legalName: "Refugio Pendiente Verificación Asoc. Civil",
    orgType: "shelter" as const,
    cuit: "30-71000005-5",
    email: "pendiente@refugio.test",
    phone: "+54 9 11 5555-3005",
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Recoleta",
    coverage: [{ province: "CABA", locality: "Recoleta", isPrimary: true }],
    verified: false, // pending in /admin queue
  },
} as const;

export type OrgKey = keyof typeof ORGS;

// Lucas's govt scope — WHOLE CABA (C5 fix, 2026-07-22, plan-maestro-integridad).
//
// He used to be assigned every individual locality across 8 provinces
// (~1.8k rows: CABA + Buenos Aires + the litoral up to Formosa) as a
// deliberate "scale case" — the operator whose every scoped query fans out
// nationwide. That is not a shape any real funcionario holds: SEED_ORGS'
// coordinators, the govt@/govt-local@ test accounts, and every other seeded
// government account hold ONE jurisdiction. A funcionario with 1774
// localities reads as broken data, not as a realistic power-user — a
// reviewer flagged the literal number ("1774 LOCALIDADES") as a symptom, not
// a feature. Whole-province assignment DOES exist for CABA
// (lib/domain/jurisdiction-canonical.ts WHOLE_PROVINCE_LOCALITY —
// `isWholeProvinceLocality`), so this is also the canonical form, not a
// downgrade: one row, subsumption resolves every CABA barrio underneath it,
// and it exercises the SAME census-denominator + subsumption code paths the
// old enumeration existed to stress. National-scale query fan-out is better
// tested by a dedicated load-test seed (scripts/seed-perf.ts) than by
// misrepresenting what a single official's jurisdiction looks like.

const PHOTO_DIR_ABS = path.join(process.cwd(), "scripts", "assets", "pet-photos");

// Map storyline acquisition_method strings (rescued, bred, unknown, etc.) to
// the canonical DB enum values (adopted, purchased, found_stray, gift,
// born_in_litter, other). Storylines were authored before the enum was
// finalised; this adapter keeps the storyline data readable while satisfying
// the DB constraint.
function toDbAcquisition(
  raw: string | undefined,
): "adopted" | "purchased" | "found_stray" | "gift" | "born_in_litter" | "other" | null {
  if (!raw) return null;
  switch (raw) {
    case "adopted":
    case "purchased":
    case "found_stray":
    case "gift":
    case "born_in_litter":
    case "other":
      return raw;
    case "rescued":
      return "found_stray";
    case "bred":
      return "born_in_litter";
    case "unknown":
      return "other";
    default:
      return "other";
  }
}
const SEED_STORAGE_BUCKET = "seed-photos";

// ---------------------------------------------------------------------------
// 4. Owner-key resolution glue for the existing Storyline shape
//
// The Storyline objects in seed-storylines-iconic.ts use string keys to point
// at owners (e.g. owner_of_record: "Vladimir Yazdovsky (INVAP-Bariloche)").
// For demo seeding we collapse these to the seed users — Ignacio is the
// curatorial owner of every historical pet. This adapter maps token → UserKey.
// ---------------------------------------------------------------------------

/**
 * Resolves a storyline's owner field to a concrete user or org. Storylines in
 * the new modules (original10, dangerous, supporting) set `pet.owner` directly
 * as either a UserKey or an "org:..." string. The historical iconic file's
 * Storyline shape uses `pet.owner_of_record` instead — we fall back to a
 * token-prefix table for that subset.
 */
function resolveOwnerForStoryline(pet: any): { user?: UserKey; org?: OrgKey } {
  // Preferred: explicit pet.owner field (new storyline modules)
  if (typeof pet?.owner === "string") {
    const owner = pet.owner as string;
    if (owner.startsWith("org:")) {
      return { org: owner.slice(4) as OrgKey };
    }
    return { user: owner as UserKey };
  }

  // Legacy fallback for the iconic storyline file: map by public_token prefix.
  const publicToken: string = pet?.public_token ?? "";
  if (publicToken.startsWith("DIM-LAIK")) return { user: "ignacio" };
  if (publicToken.startsWith("DIM-HACH")) return { user: "ignacio" };
  if (publicToken.startsWith("DIM-HCN2")) return { user: "ignacio" };
  if (publicToken.startsWith("DIM-PAL2")) return { user: "ignacio" };
  if (publicToken.startsWith("DIM-TRRY")) return { user: "ignacio" };
  if (publicToken.startsWith("DIM-KABO")) return { user: "noeli" };
  if (publicToken.startsWith("DIM-HNKO")) return { user: "noeli" };
  // Legends batch (2026-06)
  if (publicToken.startsWith("DIM-BOBB")) return { user: "graciela" };
  if (publicToken.startsWith("DIM-FRID")) return { org: "mascotas-ba-centro" };
  if (publicToken.startsWith("DIM-OWNY")) return { org: "rescate-puerto-madero" };
  return { user: "ignacio" };
}

// Map any author_role we see on storylines to a concrete user from USERS.
// Storyline events carry author_role only; we pick the closest seed user.
// For org-owned pets (shelter custody), owner-attributed events fall back to
// Alejo, since he's the personal-account human authoring on behalf of the org.
function pickAuthorFromRole(
  authorRole: string | undefined,
  petOwnerUserKey: UserKey | null,
  userIds: Record<UserKey, string>,
): string | null {
  switch (authorRole) {
    case "vet":
      return userIds.lilian;
    case "govt":
      return userIds.lucas;
    case "admin":
      return userIds.admin;
    case "system":
      return null;
    case "shelter":
      return userIds.alejo;
    default:
      return petOwnerUserKey ? userIds[petOwnerUserKey] : userIds.alejo;
  }
}

// ---------------------------------------------------------------------------
// 5. Logging
// ---------------------------------------------------------------------------

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "FAIL";
function log(tag: LogTag, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${tag.padEnd(4)}] ${msg}`);
}

// ---------------------------------------------------------------------------
// 6. User + profile provisioning
// ---------------------------------------------------------------------------

async function findAuthUserIdByEmail(supabase: any, email: string): Promise<string | null> {
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

async function ensureAuthUser(
  deps: DbDeps,
  email: string,
  displayName: string,
  userRole: "owner" | "admin" = "owner",
): Promise<{ id: string; created: boolean }> {
  const existing = await findAuthUserIdByEmail(deps.supabase, email);
  if (existing) return { id: existing, created: false };
  const { data, error } = await deps.supabase.auth.admin.createUser({
    email,
    password: SHARED_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: displayName, user_role: userRole },
  });
  if (error || !data.user)
    throw new Error(`createUser(${email}) failed: ${error?.message ?? "no user"}`);
  return { id: data.user.id, created: true };
}

/**
 * Twin of `syncDniVerified` in scripts/seed-test-users.ts — keep the two in
 * step. Both are the "seed bypass" of docs/patterns/petition-prerequisites.md,
 * and both used to set the flag alone, leaving a PERSONAL profile marked
 * verified with no DNI on file. That state is one the product's own screens
 * cannot represent, and it is what the demo personas were in: it produced the
 * dead "Declarar ahora" button (master test CIU, N2b) and let the tránsito pool
 * accept an enrolment with an undeclared DNI (N3-b).
 *
 * Institutional profiles stay flag-only — `profiles_institutional_no_pii`
 * forbids dni_hash on them, and an institution has no DNI to declare.
 *
 * Self-healing: it also fires on an already-verified personal profile whose
 * dni_last4 is NULL, so re-seeding repairs an environment rather than skipping.
 */
async function syncDniVerified(deps: DbDeps, userId: string): Promise<void> {
  const { db, drizzle, schemas } = deps;
  const { createHash } = await import("node:crypto");
  const { hashDni, dniLast4 } = await import("@/lib/utils/dni-hash");

  // Deterministic per user id (stable across re-runs) and distinct per account —
  // profiles_dni_hash_unique is a partial unique index over dni_hash.
  const digits = createHash("sha256").update(userId).digest("hex");
  const syntheticDni = String(10_000_000 + (Number.parseInt(digits.slice(0, 12), 16) % 90_000_000));

  await db
    .update(schemas.profiles)
    .set({ dniVerified: true, dniVerifiedAt: new Date(), updatedAt: new Date() })
    .where(
      drizzle.and(
        drizzle.eq(schemas.profiles.id, userId),
        drizzle.eq(schemas.profiles.dniVerified, false),
        drizzle.ne(schemas.profiles.accountType, "personal"),
      ),
    );

  await db
    .update(schemas.profiles)
    .set({
      dniVerified: true,
      dniHash: hashDni(syntheticDni),
      dniLast4: dniLast4(syntheticDni),
      dniVerifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      drizzle.and(
        drizzle.eq(schemas.profiles.id, userId),
        drizzle.eq(schemas.profiles.accountType, "personal"),
        drizzle.or(
          drizzle.eq(schemas.profiles.dniVerified, false),
          drizzle.isNull(schemas.profiles.dniLast4),
        ),
      ),
    );
}

async function setProfileFields(
  deps: DbDeps,
  userId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const { db, drizzle, schemas } = deps;
  await db
    .update(schemas.profiles)
    .set({ ...fields, updatedAt: new Date() })
    .where(drizzle.eq(schemas.profiles.id, userId));
}

async function provisionUsers(deps: DbDeps): Promise<Record<UserKey, string>> {
  log("STEP", `Provisioning ${Object.keys(USERS).length} users`);
  const ids: Partial<Record<UserKey, string>> = {};
  for (const [key, u] of Object.entries(USERS) as Array<[UserKey, (typeof USERS)[UserKey]]>) {
    const initialRole = u.role === "admin" ? "admin" : "owner";
    const { id, created } = await ensureAuthUser(deps, u.email, u.displayName, initialRole);
    log(created ? "OK" : "SKIP", `${u.email.padEnd(24)} (${u.displayName})`);

    if (u.role === "admin") {
      await setProfileFields(deps, id, {
        role: "admin",
        accountType: "institutional",
        displayName: u.displayName,
        // Una institución no tiene DNI — profiles_institutional_no_pii lo prohíbe.
        // Limpiarlo acá hace el paso independiente del orden Y repara una fila que
        // ya haya quedado mal (gemelo del fix en seed-test-users.ts).
        dniHash: null,
        dniLast4: null,
      });
    } else if (u.role === "govt") {
      await setProfileFields(deps, id, {
        role: "govt",
        accountType: "institutional",
        displayName: u.displayName,
        dniHash: null,
        dniLast4: null,
      });
    } else if (u.role === "vet") {
      await setProfileFields(deps, id, {
        role: "vet",
        accountType: "personal",
        displayName: u.displayName,
        phone: u.phone,
        matriculaVerified: true,
        matriculaNumber: "V-99001-CABA",
        matriculaJurisdiccion: "CABA",
      });
    } else {
      await setProfileFields(deps, id, {
        role: "owner",
        accountType: "personal",
        displayName: u.displayName,
        phone: u.phone,
      });
    }
    // DESPUES de fijar account_type: syncDniVerified mira el estado ACTUAL y el
    // trigger crea todo perfil como 'personal'. Llamarlo antes le escribia un DNI
    // a las cuentas institucionales y el CHECK abortaba el seed (2026-08-12).
    await syncDniVerified(deps, id);
    ids[key] = id;
  }
  return ids as Record<UserKey, string>;
}

/**
 * Lucas's govt scope — whole CABA, one row (C5 fix). Revokes any OTHER live
 * assignment he holds first (idempotent repair path for a DB seeded before
 * this fix, which left him with ~1774 individual-locality rows), then
 * upserts the canonical whole-province row.
 */
async function provisionGovtAssignments(
  deps: DbDeps,
  lucasId: string,
  adminId: string,
): Promise<void> {
  const { db, drizzle, schemas } = deps;
  const province = "CABA";
  const locality = WHOLE_PROVINCE_LOCALITY.CABA;

  log("STEP", `Lucas govt assignment — whole ${province} (${locality})`);

  // Revoke every OTHER live assignment (repairs a pre-fix over-scoped Lucas
  // without touching the canonical row itself, so this stays a no-op once
  // clean).
  const stale = await db
    .select({ id: schemas.govtAssignments.id })
    .from(schemas.govtAssignments)
    .where(
      drizzle.and(
        drizzle.eq(schemas.govtAssignments.userId, lucasId),
        drizzle.isNull(schemas.govtAssignments.revokedAt),
        drizzle.or(
          drizzle.ne(schemas.govtAssignments.jurisdictionProvince, province),
          drizzle.ne(schemas.govtAssignments.jurisdictionLocality, locality),
        ),
      ),
    );
  if (stale.length > 0) {
    await db
      .update(schemas.govtAssignments)
      .set({ revokedAt: new Date(), revokedByUserId: adminId })
      .where(
        drizzle.inArray(
          schemas.govtAssignments.id,
          stale.map((r: { id: string }) => r.id),
        ),
      );
    log("OK", `Revoked ${stale.length} stale/over-scoped assignment(s) for Lucas.`);
  }

  const [existing] = await db
    .select({ id: schemas.govtAssignments.id })
    .from(schemas.govtAssignments)
    .where(
      drizzle.and(
        drizzle.eq(schemas.govtAssignments.userId, lucasId),
        drizzle.eq(schemas.govtAssignments.jurisdictionProvince, province),
        drizzle.eq(schemas.govtAssignments.jurisdictionLocality, locality),
        drizzle.isNull(schemas.govtAssignments.revokedAt),
      ),
    )
    .limit(1);

  if (existing) {
    log("SKIP", `${province} / ${locality} (already assigned)`);
    return;
  }

  await db.insert(schemas.govtAssignments).values({
    userId: lucasId,
    jurisdictionProvince: province,
    jurisdictionLocality: locality,
    grantedByUserId: adminId,
  });
  log("OK", `${province} / ${locality}`);
}

// Valeria's PBA scope — Tigre FIRST (the partido where the seeded PANO custody
// disputes live, so /gob/disputas is populated for her from day one), plus
// three of the most populous METRO_ANCHORS partidos (seed-panorama.ts) so the
// panorama choropleth and dashboards carry density inside her jurisdiction.
const GOV_PBA_PROVINCE = "Buenos Aires";
const GOV_PBA_LOCALITIES = ["Tigre", "La Plata", "Quilmes", "Morón"] as const;

/**
 * gov-pba@'s govt scope — individual PBA partidos, same mechanism as Lucas's
 * assignment above (one govt_assignments row per jurisdiction, granted by
 * admin). Each locality is canonicalized through resolveCanonicalJurisdiction
 * — the SAME resolver the real writers use — and FAILS LOUD on a name the
 * catalog does not know (mirrors seed-test-users.ts provisionGovt, issue
 * #758): silently inserting an unresolvable locality would scope her queries
 * to nothing at read time.
 */
async function provisionPbaGovtAssignments(
  deps: DbDeps,
  govPbaId: string,
  adminId: string,
): Promise<void> {
  const { db, drizzle, schemas } = deps;
  log("STEP", `gov-pba govt assignments — ${GOV_PBA_PROVINCE} (${GOV_PBA_LOCALITIES.join(", ")})`);

  const { JurisdictionValidationError, resolveCanonicalJurisdiction } = await import(
    "@/lib/infra/jurisdiction-validation"
  );

  for (const locality of GOV_PBA_LOCALITIES) {
    let canonicalProvince: string;
    let canonicalLocality: string;
    try {
      const resolved = await resolveCanonicalJurisdiction({
        rawProvince: GOV_PBA_PROVINCE,
        rawLocality: locality,
      });
      canonicalProvince = resolved.province.name;
      canonicalLocality = resolved.locality.localityName;
    } catch (err) {
      if (err instanceof JurisdictionValidationError) {
        log(
          "FAIL",
          `gov-pba: jurisdicción inválida (${GOV_PBA_PROVINCE} / ${locality}) — ${err.message}`,
        );
        process.exit(2);
      }
      throw err;
    }

    const [existing] = await db
      .select({ id: schemas.govtAssignments.id })
      .from(schemas.govtAssignments)
      .where(
        drizzle.and(
          drizzle.eq(schemas.govtAssignments.userId, govPbaId),
          drizzle.eq(schemas.govtAssignments.jurisdictionProvince, canonicalProvince),
          drizzle.eq(schemas.govtAssignments.jurisdictionLocality, canonicalLocality),
          drizzle.isNull(schemas.govtAssignments.revokedAt),
        ),
      )
      .limit(1);
    if (existing) {
      log("SKIP", `${canonicalProvince} / ${canonicalLocality} (already assigned)`);
      continue;
    }

    await db.insert(schemas.govtAssignments).values({
      userId: govPbaId,
      jurisdictionProvince: canonicalProvince,
      jurisdictionLocality: canonicalLocality,
      grantedByUserId: adminId,
    });
    log("OK", `${canonicalProvince} / ${canonicalLocality}`);
  }
}

// ---------------------------------------------------------------------------
// 7. Org provisioning + memberships
// ---------------------------------------------------------------------------

async function provisionOrgs(deps: DbDeps, alejoId: string): Promise<Record<OrgKey, string>> {
  log("STEP", "Provisioning 5 organizations");
  const { db, drizzle, schemas, publicTokenLib } = deps;
  const orgIds: Partial<Record<OrgKey, string>> = {};
  for (const [key, org] of Object.entries(ORGS) as Array<[OrgKey, (typeof ORGS)[OrgKey]]>) {
    const [existing] = await db
      .select({ id: schemas.organizations.id })
      .from(schemas.organizations)
      .where(drizzle.eq(schemas.organizations.cuit, org.cuit))
      .limit(1);
    let id: string;
    if (existing) {
      id = existing.id;
      log("SKIP", `${org.name}`);
    } else {
      const token = publicTokenLib.generatePublicToken();
      const [row] = await db
        .insert(schemas.organizations)
        .values({
          publicToken: token,
          displayName: org.name,
          legalName: org.legalName,
          orgType: org.orgType,
          cuit: org.cuit,
          email: org.email,
          phone: org.phone,
          jurisdictionCountry: "AR",
          jurisdictionProvince: org.jurisdictionProvince,
          jurisdictionLocality: org.jurisdictionLocality,
          verified: org.verified,
          createdByUserId: alejoId,
        })
        .returning({ id: schemas.organizations.id });
      id = row.id;
      log("OK", `${org.name} ${org.verified ? "(verified)" : "(PENDING admin review)"}`);
    }
    orgIds[key] = id;

    for (const zone of org.coverage) {
      const [existingZone] = await db
        .select({ id: schemas.organizationCoverage.id })
        .from(schemas.organizationCoverage)
        .where(
          drizzle.and(
            drizzle.eq(schemas.organizationCoverage.organizationId, id),
            drizzle.eq(schemas.organizationCoverage.jurisdictionProvince, zone.province),
            drizzle.eq(schemas.organizationCoverage.jurisdictionLocality, zone.locality),
          ),
        )
        .limit(1);
      if (!existingZone) {
        await db.insert(schemas.organizationCoverage).values({
          organizationId: id,
          jurisdictionProvince: zone.province,
          jurisdictionLocality: zone.locality,
          isPrimary: zone.isPrimary,
        });
      }
    }
  }
  return orgIds as Record<OrgKey, string>;
}

async function provisionMemberships(
  deps: DbDeps,
  userIds: Record<UserKey, string>,
  orgIds: Record<OrgKey, string>,
): Promise<void> {
  log("STEP", "Memberships — Alejo / Lilian / Noelí / Graciela");
  const { db, drizzle, schemas } = deps;
  const memberships: Array<{
    org: OrgKey;
    user: UserKey;
    role: string;
    title: string;
    canWritePetEvents: boolean;
  }> = [
    {
      org: "patitas-del-norte",
      user: "alejo",
      role: "admin",
      title: "Coordinador general",
      canWritePetEvents: true,
    },
    {
      org: "clinica-recoleta",
      user: "alejo",
      role: "admin",
      title: "Director administrativo",
      canWritePetEvents: false,
    },
    {
      org: "rescate-puerto-madero",
      user: "alejo",
      role: "admin",
      title: "Coordinador",
      canWritePetEvents: true,
    },
    {
      org: "mascotas-ba-centro",
      user: "alejo",
      role: "admin",
      title: "Operador",
      canWritePetEvents: false,
    },
    {
      org: "clinica-recoleta",
      user: "lilian",
      role: "vet_individual",
      title: "Vet de planta",
      canWritePetEvents: true,
    },
    {
      org: "patitas-del-norte",
      user: "noeli",
      role: "foster",
      title: "Voluntaria de tránsito",
      canWritePetEvents: true,
    },
    {
      org: "patitas-del-norte",
      user: "graciela",
      role: "foster",
      title: "Voluntaria de tránsito",
      canWritePetEvents: true,
    },
  ];
  for (const m of memberships) {
    const [existing] = await db
      .select({ id: schemas.organizationMemberships.id })
      .from(schemas.organizationMemberships)
      .where(
        drizzle.and(
          drizzle.eq(schemas.organizationMemberships.organizationId, orgIds[m.org]),
          drizzle.eq(schemas.organizationMemberships.userId, userIds[m.user]),
          drizzle.isNull(schemas.organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    if (existing) {
      log("SKIP", `${m.user} @ ${m.org}`);
      continue;
    }
    await db.insert(schemas.organizationMemberships).values({
      organizationId: orgIds[m.org],
      userId: userIds[m.user],
      role: m.role,
      title: m.title,
      canWritePetEvents: m.canWritePetEvents,
    });
    log("OK", `${m.user} @ ${m.org} (${m.role})`);
  }
}

// ---------------------------------------------------------------------------
// 8. Photo upload — Supabase Storage
// ---------------------------------------------------------------------------

async function ensureStorageBucket(deps: DbDeps): Promise<void> {
  log("STEP", `Storage bucket '${SEED_STORAGE_BUCKET}'`);
  const { data: list, error: listErr } = await deps.supabase.storage.listBuckets();
  if (listErr) throw new Error(`listBuckets failed: ${listErr.message}`);
  const exists = list?.some((b: any) => b.name === SEED_STORAGE_BUCKET);
  if (exists) {
    log("SKIP", `bucket ${SEED_STORAGE_BUCKET} already exists`);
    return;
  }
  const { error } = await deps.supabase.storage.createBucket(SEED_STORAGE_BUCKET, { public: true });
  if (error) throw new Error(`createBucket failed: ${error.message}`);
  log("OK", `created bucket ${SEED_STORAGE_BUCKET}`);
}

/**
 * Photos. New storyline modules carry photo_file directly on each pet bio
 * (read at load time). The iconic storyline file predates that convention,
 * so we maintain a fallback manifest keyed by public_token for those entries.
 */
const ICONIC_PHOTO_MANIFEST: Record<string, string> = {
  "DIM-LAIK-0015": "russian dog.jpg",
  "DIM-HACH-0016": "hachi.jpg",
  "DIM-PAL2-0017": "totito.webp",
  "DIM-TRRY-0018": "toto.jpg",
  "DIM-KABO-0019": "Doge1.jpg",
};

function resolvePhotoFile(pet: any): string | null {
  if (typeof pet?.photo_file === "string") return pet.photo_file;
  const token: string = pet?.public_token ?? "";
  return ICONIC_PHOTO_MANIFEST[token] ?? null;
}

async function uploadPetPhoto(
  deps: DbDeps,
  petId: string,
  ownerUserId: string | null,
  filename: string,
): Promise<string | null> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const localPath = path.join(PHOTO_DIR_ABS, filename);
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(localPath);
  } catch {
    log("WARN", `photo not found: ${filename}`);
    return null;
  }

  const ext = path.extname(filename).slice(1).toLowerCase() || "jpg";
  const storageKey = `pets/${petId}/avatar.${ext}`;
  const contentType = `image/${ext === "jpg" ? "jpeg" : ext}`;
  const { error: upErr } = await deps.supabase.storage
    .from(SEED_STORAGE_BUCKET)
    .upload(storageKey, bytes, { upsert: true, contentType });
  if (upErr) {
    log("WARN", `upload failed for ${filename}: ${upErr.message}`);
    return null;
  }

  const { data: pub } = deps.supabase.storage.from(SEED_STORAGE_BUCKET).getPublicUrl(storageKey);
  const publicUrl = pub?.publicUrl ?? null;

  const { db, drizzle, schemas } = deps;
  const [attachment] = await db
    .insert(schemas.attachments)
    .values({
      petId,
      uploadedByUserId: ownerUserId,
      storagePath: storageKey,
      storageBucket: SEED_STORAGE_BUCKET,
      mimeType: contentType,
      filename,
      publicUrl,
    })
    .returning({ id: schemas.attachments.id });

  await db
    .update(schemas.pets)
    .set({ primaryPhotoId: attachment.id })
    .where(drizzle.eq(schemas.pets.id, petId));

  return attachment.id;
}

// ---------------------------------------------------------------------------
// 9. Storyline loader
// ---------------------------------------------------------------------------

function dateAtNoonUtc(d: string): Date {
  return new Date(`${d}T12:00:00Z`);
}

async function loadStoryline(
  deps: DbDeps,
  story: any,
  userIds: Record<UserKey, string>,
  orgIds: Record<OrgKey, string>,
): Promise<void> {
  const { db, drizzle, schemas } = deps;
  const publicToken: string = story.pet.public_token;

  const [existing] = await db
    .select({ id: schemas.pets.id })
    .from(schemas.pets)
    .where(drizzle.eq(schemas.pets.publicToken, publicToken))
    .limit(1);
  if (existing) {
    log("SKIP", `${publicToken} (${story.pet.display_name}) — pet already seeded`);
    return;
  }

  const ownerResolved = resolveOwnerForStoryline(story.pet);
  const ownerUserId = ownerResolved.user ? userIds[ownerResolved.user] : null;
  const ownerOrgId = ownerResolved.org ? orgIds[ownerResolved.org] : null;

  if (!ownerUserId && !ownerOrgId) {
    log("FAIL", `${publicToken} — owner not resolved, skipping`);
    return;
  }

  const deceasedAt: Date | null = (() => {
    if (story.pet.status !== "deceased") return null;
    const deathEvent = story.events.find((e: any) => e.event_type === "death_recorded");
    return deathEvent ? dateAtNoonUtc(deathEvent.date) : null;
  })();

  const [pet] = await db
    .insert(schemas.pets)
    .values({
      publicToken: story.pet.public_token,
      species: story.pet.species,
      breed: story.pet.breed ?? null,
      name: story.pet.display_name,
      sex: story.pet.sex,
      dateOfBirth: story.pet.date_of_birth ?? null,
      birthDateIsEstimated: story.pet.birth_date_is_estimated ?? false,
      color: story.pet.color ?? null,
      distinguishingFeatures: story.pet.distinguishing_features ?? null,
      // Legacy chip columns omitted — ARCH-R; canonical row written to
      // pet_identifications below if the storyline carries a microchip_id.
      estimatedWeightKg: story.pet.estimated_weight_kg
        ? String(story.pet.estimated_weight_kg)
        : null,
      favouriteFoods: story.pet.favourite_foods ?? null,
      knownAllergies: story.pet.known_allergies ?? null,
      trainingLevel: story.pet.training_level ?? null,
      potentiallyDangerousBreed: story.pet.potentially_dangerous_breed ?? false,
      insuranceCompany: story.pet.insurance_company ?? null,
      insurancePolicyNumber: story.pet.insurance_policy_number ?? null,
      jurisdictionCountry: story.pet.jurisdiction_country ?? "AR",
      jurisdictionProvince: story.pet.jurisdiction_province ?? null,
      jurisdictionLocality: story.pet.jurisdiction_locality ?? null,
      acquisitionMethod: toDbAcquisition(story.pet.acquisition_method),
      emergencyInfoVisible: story.pet.emergency_info_visible ?? false,
      status: story.pet.status,
      deceasedAt,
    })
    .returning({ id: schemas.pets.id });

  await db.insert(schemas.ownerships).values({
    petId: pet.id,
    ownerUserId,
    ownerOrganizationId: ownerOrgId,
    role: ownerOrgId ? "shelter_custody" : "owner",
  });

  // Upload photo if the storyline / manifest carries one
  const photoFile = resolvePhotoFile(story.pet);
  if (photoFile) {
    await uploadPetPhoto(deps, pet.id, ownerUserId, photoFile);
  }

  // Insert events
  let eventCount = 0;
  // Track the LATEST adoption_eligibility_set event so the cache dual-write
  // below can mirror replayPetAdoptionEligibility (latest-wins). We capture the
  // DB-assigned recordedAt so adoptionEligibilitySetAt matches the event instant.
  let lastAdoptionEligibility: { recordedAt: Date; payload: Record<string, unknown> } | null = null;
  // Pairing invariant (cursor UX G1, 2026-07-23): every production close path
  // stamps rabies_observation_ended with observation_started_event_id; the A9
  // breach query pairs strictly on it, so a storyline that omits the key
  // leaves a PHANTOM open observation — the panel then shows a legal-breach
  // alert beside a KPI reading 0. The runner (not each storyline author)
  // guarantees the pairing: track the last started id and inject it into a
  // keyless ended payload.
  let lastRabiesObservationStartedId: string | null = null;
  for (const e of story.events) {
    const author = pickAuthorFromRole(e.author_role, ownerResolved.user ?? null, userIds);
    // If the event author_role is 'shelter' or the pet is org-owned, attribute
    // the event to that organization for the audit trail.
    const authorOrgId =
      e.author_role === "shelter" && ownerOrgId
        ? ownerOrgId
        : ownerOrgId && e.author_role === "owner"
          ? ownerOrgId
          : null;
    let payload: Record<string, unknown> = (e.payload ?? {}) as Record<string, unknown>;
    if (
      e.event_type === "rabies_observation_ended" &&
      lastRabiesObservationStartedId &&
      payload.observation_started_event_id === undefined
    ) {
      payload = { ...payload, observation_started_event_id: lastRabiesObservationStartedId };
    }
    const [inserted] = await db
      .insert(schemas.petEvents)
      .values({
        petId: pet.id,
        eventType: e.event_type,
        occurredAt: dateAtNoonUtc(e.date),
        recordedByUserId: author,
        authorRole: e.author_role ?? "system",
        authorOrganizationId: authorOrgId,
        authorVerified: true,
        payload,
      })
      .returning({ id: schemas.petEvents.id, recordedAt: schemas.petEvents.recordedAt });
    if (e.event_type === "rabies_observation_started") {
      lastRabiesObservationStartedId = inserted.id;
    }
    if (e.event_type === "adoption_eligibility_set") {
      lastAdoptionEligibility = {
        recordedAt: inserted.recordedAt,
        payload: (e.payload ?? {}) as Record<string, unknown>,
      };
    }
    eventCount++;
  }

  // Canonical microchip row — legacy pets.* columns not written (ARCH-R).
  //
  // Cache contract: the canonical row's recordedAt / recordedByLabel /
  // implantationSite must agree with what the re-derivation projection
  // (replayPetMicrochip) would compute from the microchip_implanted event.
  // The projection uses implant_date_known to decide whether to surface a
  // real date (true) or null (false/absent), and implanted_by for the label.
  // We derive from the microchip_implanted event in the story so the two
  // sources stay in sync instead of copying the (potentially different) bio
  // static fields.
  // Prefer bio.microchip_id; fall back to the chip_number in the microchip_implanted
  // event so storylines that omit the static field still get a canonical row.
  const chipEvent = (story.events as any[]).find((e) => e.event_type === "microchip_implanted");
  const chipCodeFromBio = (story.pet as any).microchip_id as string | null | undefined;
  const chipCodeFromEvent =
    typeof chipEvent?.payload?.chip_number === "string"
      ? (chipEvent.payload.chip_number as string)
      : null;
  const chipCode = chipCodeFromBio ?? chipCodeFromEvent;
  if (chipCode) {
    // Find the microchip_implanted event whose chip_number matches chipCode.
    const chipEventMatched = (story.events as any[]).find(
      (e) =>
        e.event_type === "microchip_implanted" &&
        (e.payload?.chip_number === chipCode || e.payload?.chip_number == null),
    );
    const chipPayload = (chipEventMatched?.payload ?? {}) as Record<string, unknown>;

    // recordedAt: only set when implant_date_known is explicitly true (mirrors
    // replayPetMicrochip which returns null when the flag is absent/false).
    const implantDateKnown = chipPayload.implant_date_known === true;
    const implantedAt = implantDateKnown
      ? ((chipEventMatched?.date as string | undefined) ??
        ((story.pet as any).microchip_implanted_at as string | undefined) ??
        null)
      : null;

    // recordedByLabel: from event payload.implanted_by (mirrors projection).
    const implantedBy =
      typeof chipPayload.implanted_by === "string" && chipPayload.implanted_by.length > 0
        ? chipPayload.implanted_by
        : null;

    // implantationSite: normalize event payload.location_on_body through the
    // same chipImplantSiteFromLocation() the canonical writers use.
    const locationOnBody =
      typeof chipPayload.location_on_body === "string" ? chipPayload.location_on_body : null;
    // Map the form-field alias to the canonical DB enum (delegates to shared domain rule).
    const implantationSite = chipImplantSiteFromLocation(locationOnBody);

    await db.insert(schemas.petIdentifications).values({
      petId: pet.id,
      kind: "microchip_iso",
      code: chipCode,
      recordedAt: implantedAt ?? story.events[0].date,
      recordedByLabel: implantedBy,
      implantationSite,
      isoCountryCode: chipCode.slice(0, 3),
      isoManufacturerCode: chipCode.slice(3, 7),
      isoNationalId: chipCode.slice(7, 15),
      isoCompliant: true,
    });
  }

  // Canonical dual-write for microchip_replaced — mirror replaceMicrochipForUser
  // (src/modules/pets/application/microchip/replace-microchip.ts).
  //
  // WHY: the block above only writes the INITIAL implant row. A storyline whose
  // timeline carries a microchip_replaced event (replacement OR pure revocation)
  // must fold that lifecycle into pet_identifications too, otherwise the canonical
  // row keeps the ORIGINAL chip code while replayPetMicrochip(events) reflects the
  // replacement/revocation — cache<->events drift the pet-cache fitness sweep
  // (__tests__/pet-cache-rederivation.test.ts) rightly rejects. Fold each replace
  // event chronologically: flip the current active microchip_iso row to
  // 'replaced', then (unless new_chip_number is null → pure revocation) insert the
  // successor as the new active row, mirroring the real writer's field mapping.
  const replaceEvents = (story.events as any[])
    .filter((e) => e.event_type === "microchip_replaced")
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const re of replaceEvents) {
    const rp = (re.payload ?? {}) as Record<string, unknown>;
    const newChip =
      typeof rp.new_chip_number === "string" && rp.new_chip_number.length > 0
        ? rp.new_chip_number
        : null;

    // Flip the currently-active microchip_iso row to 'replaced'.
    await db
      .update(schemas.petIdentifications)
      .set({ status: "replaced", updatedAt: new Date() })
      .where(
        drizzle.and(
          drizzle.eq(schemas.petIdentifications.petId, pet.id),
          drizzle.eq(schemas.petIdentifications.kind, "microchip_iso"),
          drizzle.eq(schemas.petIdentifications.status, "active"),
        ),
      );

    // Replacement (not a pure revocation) → insert the successor active row.
    // Fields mirror both the writer's insert and replayPetMicrochip's fold:
    // recordedAt = the replace date, recordedByLabel = replaced_by, ISO subfields
    // sliced from the new code, implantationSite unset (null).
    if (newChip) {
      const replacedBy =
        typeof rp.replaced_by === "string" && rp.replaced_by.length > 0 ? rp.replaced_by : null;
      await db.insert(schemas.petIdentifications).values({
        petId: pet.id,
        kind: "microchip_iso",
        code: newChip,
        recordedAt: typeof re.date === "string" ? re.date : story.events[0].date,
        recordedByLabel: replacedBy,
        isoCountryCode: newChip.slice(0, 3),
        isoManufacturerCode: newChip.slice(3, 7),
        isoNationalId: newChip.slice(7, 15),
        isoCompliant: true,
      });
    }
  }

  // Canonical tattoo row — written when the storyline carries a tattoo_recorded event.
  // Uses the FIRST tattoo_recorded event's payload as the canonical identifier.
  // If a subsequent tattoo_updated event changes the code, the original row is
  // NOT mutated (append-only events); the canonical row records the initial tattoo.
  const tattooEvent = (story.events as any[]).find((e) => e.event_type === "tattoo_recorded");
  if (tattooEvent) {
    const tp = (tattooEvent.payload ?? {}) as Record<string, unknown>;
    const tattooCode = typeof tp.tattoo_code === "string" ? tp.tattoo_code : null;
    const tattooLocation = typeof tp.location_on_body === "string" ? tp.location_on_body : null;
    const tattooDescription = typeof tp.description === "string" ? tp.description : null;
    const tattooRecordedBy = typeof tp.recorded_by === "string" ? tp.recorded_by : null;
    // MIRRORS THE PROJECTION, and must keep doing so.
    //
    // `recordedAt` on the identification row means "when the TATTOO was made",
    // not "when we wrote this down". The tattoo_recorded payload says which of
    // those it knows: `tattoo_date_known: false` with `recorded_at: null` is an
    // event explicitly declining to state the date.
    //
    // This used to fall back to `tattooEvent.date` — the day the event was
    // recorded — so the cache carried a tattoo date the event had refused to
    // give, and the pet's credential showed it as fact. lib/projections/
    // pet-tattoo.ts derives `dateKnown ? recorded_at : null`, so the fitness
    // sweep (__tests__/pet-cache-rederivation.test.ts) caught the drift on
    // DIM-JUF5-ZW5J: stored "2026-07-26", derived null.
    //
    // The projection is right. Unknown stays unknown.
    const tattooDateKnown = tp.tattoo_date_known === true;
    const tattooRecordedAt =
      tattooDateKnown && typeof tp.recorded_at === "string" ? tp.recorded_at : null;
    if (tattooCode) {
      const [existingTattoo] = await db
        .select({ id: schemas.petIdentifications.id })
        .from(schemas.petIdentifications)
        .where(
          drizzle.and(
            drizzle.eq(schemas.petIdentifications.petId, pet.id),
            drizzle.eq(schemas.petIdentifications.kind, "tattoo"),
          ),
        )
        .limit(1);
      if (!existingTattoo) {
        await db.insert(schemas.petIdentifications).values({
          petId: pet.id,
          kind: "tattoo",
          code: tattooCode,
          recordedAt: tattooRecordedAt,
          recordedByLabel: tattooRecordedBy,
          tattooLocation: tattooLocation,
          tattooDescription: tattooDescription,
        });
        log("OK", `  tattoo row → ${publicToken}`);
      } else {
        log("SKIP", `  tattoo already exists → ${publicToken}`);
      }
    }
  }

  // pet_service_dog row — written when the storyline pet bio carries a
  // service_dog field. Idempotent upsert mirrors the existing pattern.
  const serviceDogSpec = (story.pet as any).service_dog as
    | {
        service_type: string;
        credential_status: string;
        training_center: string;
        training_cert_date?: string;
        in_service?: boolean;
        notes?: string;
      }
    | undefined;
  if (serviceDogSpec) {
    const [existingSd] = await db
      .select({ id: schemas.petServiceDog.id })
      .from(schemas.petServiceDog)
      .where(drizzle.eq(schemas.petServiceDog.petId, pet.id))
      .limit(1);
    if (!existingSd) {
      await db.insert(schemas.petServiceDog).values({
        petId: pet.id,
        serviceType: serviceDogSpec.service_type,
        credentialStatus: serviceDogSpec.credential_status,
        trainingCenter: serviceDogSpec.training_center,
        trainingCertDate: serviceDogSpec.training_cert_date ?? null,
        inService: serviceDogSpec.in_service ?? false,
        notes: serviceDogSpec.notes ?? null,
      });
      log("OK", `  service_dog row → ${publicToken}`);
    } else {
      log("SKIP", `  service_dog already exists → ${publicToken}`);
    }
  }

  // Cache: estimatedWeightKg must equal the last weight_recorded event's kg
  // value (replayPetWeight picks the chronologically-last event).  The bio
  // static field is documentation/fallback only; the DB column must mirror the
  // event spine to pass the fitness sweep.
  const lastWeightEvent = [...(story.events as any[])]
    .reverse()
    .find((e) => e.event_type === "weight_recorded");
  if (lastWeightEvent) {
    const kg = lastWeightEvent.payload?.kg;
    const kgStr =
      typeof kg === "number" && Number.isFinite(kg)
        ? String(kg)
        : typeof kg === "string" && kg.length > 0
          ? kg
          : null;
    if (kgStr !== null) {
      await db
        .update(schemas.pets)
        .set({ estimatedWeightKg: kgStr, updatedAt: new Date() })
        .where(drizzle.eq(schemas.pets.id, pet.id));
    }
  } else {
    // No weight events — clear any static bio value written at insert time so
    // the stored column is null (matching the projection's null).
    await db
      .update(schemas.pets)
      .set({ estimatedWeightKg: null, updatedAt: new Date() })
      .where(drizzle.eq(schemas.pets.id, pet.id));
  }

  // Cache: rabiesObservationStatus must mirror the re-derivation projection.
  // Scan events chronologically from the end; last observation event wins.
  const VALID_RABIES_OUTCOMES = ["negative", "positive_rabies", "dead", "lost_to_followup"];
  const OUTCOME_TO_STATUS: Record<string, string> = {
    negative: "completed_negative",
    positive_rabies: "completed_positive_rabies",
    dead: "completed_dead",
    lost_to_followup: "completed_lost_to_followup",
  };
  let rabiesStatus: string | null = null;
  const eventsDesc = [...(story.events as any[])].reverse();
  for (const e of eventsDesc) {
    if (e.event_type === "rabies_observation_started") {
      rabiesStatus = "in_progress";
      break;
    }
    if (e.event_type === "rabies_observation_ended") {
      const outcome = e.payload?.outcome;
      if (typeof outcome === "string" && VALID_RABIES_OUTCOMES.includes(outcome)) {
        rabiesStatus = OUTCOME_TO_STATUS[outcome] ?? null;
        break;
      }
      // Invalid/missing outcome — keep scanning backwards (mirrors projection).
    }
  }
  await db
    .update(schemas.pets)
    .set({ rabiesObservationStatus: rabiesStatus, updatedAt: new Date() })
    .where(drizzle.eq(schemas.pets.id, pet.id));

  // Cache: adoptionEligible / adoptionEligibilitySetAt must mirror the
  // re-derivation projection (replayPetAdoptionEligibility). A storyline that
  // emits an adoption_eligibility_set event but leaves the pets row at its
  // default null drifts the pet-cache fitness sweep (stored=null vs
  // derived=<event>). Fold the LATEST event's payload into the cache, dual-
  // writing all five columns the projection derives. The CHECK constraints
  // require both eligible+setAt non-null together, and a reason when eligible
  // is false — both satisfied here.
  if (lastAdoptionEligibility) {
    const p = lastAdoptionEligibility.payload;
    const eligible = typeof p.eligible === "boolean" ? p.eligible : null;
    if (eligible !== null) {
      const untilRaw = p.ineligible_until;
      await db
        .update(schemas.pets)
        .set({
          adoptionEligible: eligible,
          adoptionEligibilitySetAt: lastAdoptionEligibility.recordedAt,
          adoptionIneligibleReason:
            eligible || typeof p.ineligible_reason !== "string" ? null : p.ineligible_reason,
          adoptionIneligibleReasonNotes:
            eligible || typeof p.ineligible_reason_notes !== "string"
              ? null
              : p.ineligible_reason_notes,
          adoptionIneligibleUntil:
            eligible || typeof untilRaw !== "string" ? null : new Date(untilRaw),
          updatedAt: new Date(),
        })
        .where(drizzle.eq(schemas.pets.id, pet.id));
    }
  }

  log("OK", `${publicToken} (${story.pet.display_name}) — ${eventCount} events`);
}

// ---------------------------------------------------------------------------
// 9b. Adoption listing publish — makes /adoptar populate
// ---------------------------------------------------------------------------

type ListingContent = {
  story: string;
  requirements: string;
  ageBucket: "puppy" | "junior" | "young" | "adult" | "senior";
  sizeEstimate: "small" | "medium" | "large" | "xl";
  energyLevel: "low" | "medium" | "high";
  goodWithKids: boolean | null;
  goodWithDogs: boolean | null;
  goodWithCats: boolean | null;
  needsYard: boolean | null;
  feeArs: number | null;
};

// Storyline pets that Patitas del Norte (verified shelter) publishes as ACTIVE
// adoption listings. All three are adoption-eligible under shelter_custody, so
// they satisfy the /adoptar query guards (D18–D21) once listed.
const ADOPTION_LISTINGS: Array<{ token: string; content: ListingContent }> = [
  {
    token: "DIM-S009-PLRM", // Lola — mestiza, Palermo
    content: {
      story:
        "Lola llegó al refugio como perra callejera en noviembre de 2024. Está castrada, vacunada y al día con todo. Es cariñosa, sociable con otros perros y muy buena con chicos. Busca una familia tranquila que le dé el hogar que se merece.",
      requirements:
        "Casa o departamento con red de protección en balcones y ventanas. Compromiso de tenencia responsable. Aceptamos una entrevista previa y seguimiento post-adopción durante los primeros meses.",
      ageBucket: "adult",
      sizeEstimate: "medium",
      energyLevel: "medium",
      goodWithKids: true,
      goodWithDogs: true,
      goodWithCats: null,
      needsYard: false,
      feeArs: 0,
    },
  },
  {
    token: "DIM-S012-RECO", // Negro — mestizo, Recoleta
    content: {
      story:
        "Negro es un perro joven, mestizo, de pelaje negro con pecho blanco. Rescatado y bajo cuidado del refugio. Tiene una postulación en revisión, pero sigue disponible para conocer nuevas familias. Es enérgico, leal y muy compañero.",
      requirements:
        "Familia activa que pueda darle paseos diarios y contención. Ambiente seguro. Entrevista previa y seguimiento post-adopción.",
      ageBucket: "young",
      sizeEstimate: "medium",
      energyLevel: "high",
      goodWithKids: true,
      goodWithDogs: null,
      goodWithCats: null,
      needsYard: false,
      feeArs: 0,
    },
  },
  {
    token: "DIM-S016-PLRM", // Milanesa — gata joven, Palermo
    content: {
      story:
        "Milanesa llegó al refugio en septiembre de 2025, rescatada de la calle en Palermo. Está castrada, vacunada y con chip. Es sociable, tranquila y se adapta bien a departamento. Convive sin problemas con otros gatos y busca una casa donde le hagan lugar en la ventana.",
      requirements:
        "Departamento o casa con red de protección en balcones y ventanas — es innegociable para un gato. Entrevista previa y seguimiento durante los primeros meses.",
      ageBucket: "young",
      sizeEstimate: "small",
      energyLevel: "medium",
      goodWithKids: true,
      goodWithDogs: null,
      goodWithCats: true,
      needsYard: false,
      feeArs: 0,
    },
  },
  {
    token: "DIM-S017-PLRM", // Pochoclo — gatito, Palermo
    content: {
      story:
        "Pochoclo es un gatito negro con pecho blanco, rescatado de una camada en julio de 2026. Tiene la triple felina y el chip puestos. Todavía no está castrado por edad: el refugio coordina la castración cuando corresponda y hace el seguimiento.",
      requirements:
        "Red de protección en balcones y ventanas. Compromiso de castrarlo cuando el veterinario lo indique — el refugio acompaña el trámite. Preferentemente con presencia diaria en casa durante los primeros meses.",
      ageBucket: "puppy",
      sizeEstimate: "small",
      energyLevel: "high",
      goodWithKids: true,
      goodWithDogs: null,
      goodWithCats: true,
      needsYard: false,
      feeArs: 0,
    },
  },
  {
    token: "DIM-S013-PLRM", // Bichita — cobaya, Palermo
    content: {
      story:
        "Bichita es una cobaya tricolor rescatada, sana y sociable. Ideal para una familia que quiera sumar una mascota pequeña y de bajo mantenimiento. Busca un hogar con espacio adecuado y compañía diaria.",
      requirements:
        "Jaula amplia y dieta adecuada (heno y verduras frescas). Preferentemente con otra cobaya para compañía. Sin exposición a corrientes de aire.",
      ageBucket: "young",
      sizeEstimate: "small",
      energyLevel: "low",
      goodWithKids: true,
      goodWithDogs: null,
      goodWithCats: null,
      needsYard: null,
      feeArs: 0,
    },
  },
];

/**
 * Publishes a few ACTIVE adoption listings so /adoptar is not empty and
 * /adoptar/[token] resolves — owner2 can then apply through the real
 * event-first flow (adoption_application_submitted). Uses the SAME writer the
 * production publish flow uses (AdoptionRepository.updateListingContent +
 * setListingStatus) rather than a raw column poke. Publishing emits no
 * pet_event by design (listing status is shelf-curated metadata, per the
 * repository contract), so calling the real writer is the faithful path — there
 * is no event to bypass. Idempotent: reruns re-publish with the existing
 * adoptionListedAt so the listed-at timestamp stays stable.
 */
async function publishAdoptionListings(deps: DbDeps): Promise<void> {
  log("STEP", "Publishing adoption listings (Lola, Negro, Bichita)");
  const { db, drizzle, schemas } = deps;
  const { AdoptionRepository } = await import(
    "@/src/modules/adoption/infrastructure/adoption-repository"
  );

  for (const { token, content } of ADOPTION_LISTINGS) {
    const [pet] = await db
      .select({
        id: schemas.pets.id,
        adoptionListedAt: schemas.pets.adoptionListedAt,
        adoptionEligible: schemas.pets.adoptionEligible,
      })
      .from(schemas.pets)
      .where(drizzle.eq(schemas.pets.publicToken, token))
      .limit(1);

    if (!pet) {
      log("WARN", `${token} not found — skipping listing publish.`);
      continue;
    }
    if (!pet.adoptionEligible) {
      log("WARN", `${token} not adoption-eligible — skipping listing publish.`);
      continue;
    }

    const now = new Date();
    await AdoptionRepository.updateListingContent({ petId: pet.id, ...content }, undefined);
    await AdoptionRepository.setListingStatus(
      { petId: pet.id, action: "publish", currentListedAt: pet.adoptionListedAt, now },
      undefined,
    );
    log("OK", `${token} published as active adoption listing.`);
  }
}

// ---------------------------------------------------------------------------
// 10. Stats helper — runs without DB access
// ---------------------------------------------------------------------------

function printStats(): void {
  const counts = new Map<EventType, number>();
  for (const t of EVENT_TYPES) counts.set(t, 0);
  for (const s of STORYLINES) {
    for (const e of s.events as Array<{ event_type: EventType }>) {
      counts.set(e.event_type, (counts.get(e.event_type) ?? 0) + 1);
    }
  }
  // eslint-disable-next-line no-console
  console.log("\n=== Per-pet event counts ===");
  for (const s of STORYLINES) {
    const uncommon = (s.events as Array<{ uncommon?: boolean }>).filter((e) => e.uncommon).length;
    console.log(
      `  ${(s.pet as any).public_token.padEnd(20)} ${(s.pet as any).display_name.padEnd(20)} events=${String(s.events.length).padStart(3)}  ⚑=${uncommon}`,
    );
  }
  console.log("\n=== Per-event_type hits ===");
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, n] of sorted) console.log(`  ${String(n).padStart(3)}  ${t}`);
  const missing = [...counts.entries()].filter(([, n]) => n === 0).map(([t]) => t);
  if (missing.length === 0) console.log("\nAll EVENT_TYPES exercised at least once. ✓");
  else console.log(`\nMissing (${missing.length}): ${missing.join(", ")}`);
}

// ---------------------------------------------------------------------------
// 11. Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (STATS_ONLY) {
    printStats();
    return;
  }

  log("INFO", `Seeding against ${SUPABASE_URL}`);
  log(
    "INFO",
    `Shared password: ${seedPasswordForDisplay(envTarget?.isLocal ?? false, SHARED_PASSWORD)}`,
  );
  log("INFO", `${STORYLINES.length} storylines registered`);

  const deps = await loadDbDeps();

  const userIds = await provisionUsers(deps);
  await provisionGovtAssignments(deps, userIds.lucas, userIds.admin);
  await provisionPbaGovtAssignments(deps, userIds.govPba, userIds.admin);
  const orgIds = await provisionOrgs(deps, userIds.alejo);
  await provisionMemberships(deps, userIds, orgIds);
  await ensureStorageBucket(deps);

  log("STEP", `Loading ${STORYLINES.length} storylines`);
  for (const story of STORYLINES) {
    await loadStoryline(deps, story, userIds, orgIds);
  }

  await publishAdoptionListings(deps);

  log("DONE", "seed complete");
  // eslint-disable-next-line no-console
  console.log("\n=== Access summary ===");
  console.log(
    `Shared password: ${seedPasswordForDisplay(envTarget?.isLocal ?? false, SHARED_PASSWORD)}\n`,
  );
  for (const [, u] of Object.entries(USERS)) {
    console.log(`  ${u.email.padEnd(24)}  role=${u.role}`);
  }
  console.log("\nLogin at /login and visit:");
  console.log("  /admin           — DIM Admin");
  console.log("  /gob             — Lucas (govt CABA)");
  console.log("  /cuenta          — Lilian (vet, resolves to /org/[token] if clinic exists)");
  console.log("  /mis-mascotas    — Ignacio / Noelí (owners)");
}

// ESM-safe entrypoint detection. tsx + Node 24 default to ESM, where
// CommonJS `require.main === module` would always be falsy. The script
// is always run directly via `pnpm tsx scripts/seed-demo.ts`, so we just
// call main() unconditionally.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("\n[FATAL]", err);
    process.exit(1);
  });
