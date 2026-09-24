/**
 * DIM realistic test-data seed.
 *
 * Drives signups + elevated grants through the SAME inner writer functions
 * that back the real server actions, so the seed exercises:
 *   - handle_new_user trigger (every auth.users insert)
 *   - Zod validation in each writer
 *   - approval_request lifecycle (vet matricula + org verification)
 *   - audit_log inserts
 *   - notification fanout via findAuthoritiesForJurisdiction
 *   - createInstitutionalAccountForAuthority for govt creation
 *
 * Flows that have NO extracted writer (pet creation, intake, pet events)
 * are inserted directly — clearly marked. Refactoring those into writer/
 * wrapper pairs is out of scope here.
 *
 * Accounts created (shared password "Test1234!" locally; SEED_DEMO_PASSWORD
 * from env is required for any --allow-remote target, and is used ONLY for
 * accounts the run creates — on a remote target an existing account keeps its
 * password and the value is never printed; R8/C4b review, 2026-09-23):
 *   admin@dim.test       → role=admin (bootstrap founder)
 *   owner@dim.test       → role=owner, 3 mascotas + 1 reminder
 *   vet@dim.test         → role=vet (via approval flow)
 *   orgadmin@dim.test    → admin de "Refugio Test (Seed)" (verified via flow)
 *   govt@dim.test        → role=govt, Ushuaia + El Calafate (remote)
 *   govt-local@dim.test  → role=govt, La Plata + CABA/Palermo (local)
 *   nacional@dim.test    → role=national, read-only, country-wide READ scope, no assignments
 *   ZERO_PET_OWNER_EMAIL → role=owner, GUARANTEED 0 mascotas, 0 org
 *                          memberships. The owner empty state depends on it.
 *                          The address lives in exactly one place on purpose —
 *                          scripts/seed-reserved-accounts.ts. Read that file
 *                          before giving this account anything.
 *
 * RE-RUN SAFETY — what is actually guaranteed, and what is not.
 *
 * This script is re-runnable, NOT idempotent. It does not converge on a fixed
 * state: each step owns its own guard, and a step only skips when ITS guard
 * recognises its own prior output. The header used to say "Idempotent — safe
 * to re-run" flatly, and that sentence cost real rows on staging (2026-08-21):
 * the shelter-pets step guarded on "does this org hold a LIVE shelter custody?"
 * while its actual collision surface was the FIXED microchip codes it writes.
 * An ended custody — an adoption, a transfer, both ordinary — cleared the guard
 * without clearing the chips, so the step re-ran, duplicated the pets, and then
 * died on pet_identifications_chip_unique partway through, leaving the halves
 * it had already committed behind.
 *
 * The rule that fell out of it, and the one to apply to any step added here:
 * GUARD ON THE CONSTRAINT THE STEP WILL ACTUALLY HIT, not on a fact the seed's
 * own data is allowed to invalidate later — and wrap a multi-row step in a
 * transaction so a guard that misses still cannot leave a half-written step.
 * See scripts/seed-shelter-pets-guard.ts for the worked example.
 *
 * Steps whose guard is only a proxy for their own output are still re-run
 * hazards. When in doubt on a database that has been live for a while, verify
 * before re-running rather than trusting this header.
 *
 * Usage:
 *   pnpm seed:test
 */

import { createHash } from "node:crypto";

import { type SupabaseClient, createClient as createSdkClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

import { composeMatriculaApprovalNotes } from "../app/gob/cola/_lib/matricula-verification";
import {
  resolveEnvTarget,
  resolveSeedPassword,
  seedPasswordForDisplay,
  shouldResetSeedPassword,
} from "./_env-target";
import { ZERO_PET_OWNER_DISPLAY_NAME, ZERO_PET_OWNER_EMAIL } from "./seed-reserved-accounts";

// IMPORTANT: load env BEFORE importing anything that reads process.env at
// module load time (db/index.ts throws if DATABASE_URL is missing). ESM
// resolves all `import` statements before this file's code runs, so the
// modules below are loaded dynamically *after* loadEnv has populated env.

// ---------------------------------------------------------------------------
// Bootstrap env + safety guard
// ---------------------------------------------------------------------------

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

// --allow-remote opts out of the local-only guard so the test accounts can be
// seeded into a remote (e.g. staging) project. NODE_ENV=production stays hard-
// blocked regardless. This script is idempotent (skips already-existing users).
const ALLOW_REMOTE = process.argv.slice(2).includes("--allow-remote");

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
// Un solo resolvedor para los tres estados posibles (local / remoto / PARTIDO).
// El guard anterior hacia `local(SUPABASE_URL) && local(DATABASE_URL)`, que con
// una sola URL remota ya se declaraba "remoto" y seguia: asi es como este script
// llego a escribir en staging leyendo auth de local. Ver scripts/_env-target.ts.
const ENV_TARGET = resolveEnvTarget(SUPABASE_URL, DATABASE_URL, ALLOW_REMOTE, "seed:test");

// ---------------------------------------------------------------------------
// Deferred imports (after env load)
// ---------------------------------------------------------------------------

const { and, eq, isNull, ne, or } = await import("drizzle-orm");
// Deferred like the rest: getPepper() reads DNI_HASH_PEPPER from the env this
// script loads above, and the seed must hash with the same helper the real
// writer uses — a second implementation here would drift from migration 0106.
const { hashDni, dniLast4 } = await import("@/lib/utils/dni-hash");
const { approveRequestForAuthority } = await import(
  "../src/modules/organizations/application/admin-decisions/approve-request"
);
const { createOrganizationForUser } = await import(
  "../src/modules/organizations/application/upgrade/create-organization"
);
const { requestVetUpgradeForUser } = await import(
  "../src/modules/organizations/application/upgrade/request-vet-upgrade"
);
// NOTE: we deliberately do NOT import `createInstitutionalAccountForAuthority`
// from `app/actions/admin-institutional.ts`. That writer transitively imports
// `lib/supabase/admin.ts`, which carries `import "server-only"` — a package
// that throws unconditionally outside the Next.js bundler. The govt creation
// is inlined below to mirror the same DB steps the writer performs (auth.users
// + profile + govt_assignments + audit_log + welcome notification).
const {
  approvalRequests,
  auditLog,
  cases,
  db,
  govtAssignments,
  notifications,
  organizationCoverage,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  petIdentifications,
  pets,
  profiles,
  reminders,
} = await import("../db");
const { generatePublicToken, generatePrefixedToken } = await import("@/lib/infra/publicToken");
// Safe to import: does NOT transitively pull in lib/supabase/admin.ts
// (server-only), unlike createInstitutionalAccountForAuthority. Used to
// canonicalize govt_assignments locations before this script inserts them
// directly (see provisionGovt below — issue #758).
const { JurisdictionValidationError, resolveCanonicalJurisdiction } = await import(
  "@/lib/infra/jurisdiction-validation"
);
// Dynamic like the rest: it imports ../db, which throws at module load when
// DATABASE_URL is not yet in process.env.
const { shelterPetsAlreadySeeded } = await import("./seed-shelter-pets-guard");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Local keeps the literal the test suite and local dev depend on. Any other
// target (staging, etc.) requires SEED_DEMO_PASSWORD from the environment —
// this repo is public and "Test1234!" is published in it (R8, 2026-09-23).
const SHARED_PASSWORD = resolveSeedPassword(ENV_TARGET.isLocal, "seed:test");

const EMAILS = {
  admin: "admin@dim.test",
  owner: "owner@dim.test",
  // Owner B — a second, separate tenant used as the cross-tenant isolation
  // target (e2e/cross-tenant-isolation.spec.ts). Owns its own pets.
  ownerB: "owner2@dim.test",
  vet: "vet@dim.test",
  orgAdmin: "orgadmin@dim.test",
  govt: "govt@dim.test",
  govtLocal: "govt-local@dim.test",
  // Read-only institutional role with country-wide READ scope (migration 0214):
  // enters /gob, sees what admin sees on the read surfaces, holds no
  // govt_assignments, is refused by every mutating action and by /admin.
  national: "nacional@dim.test",
} as const;

const DISPLAY = {
  // Brand: MiMAR is the user-facing name; the "DIM" codename must never surface
  // in operator UI (it leaked into Auditoría/Historial actor labels as "Admin DIM").
  admin: "Administración miMAR",
  owner: "Lucía Tester",
  ownerB: "Bruno Segundo",
  vet: "Dr. Juan Veterinario",
  orgAdmin: "Refugio Admin",
  govt: "Operador/a Gobierno (remoto)",
  govtLocal: "Operador/a Gobierno (local)",
  national: "Lectura nacional (solo lectura)",
} as const;

// Remote govt — keeps a govt user covering jurisdictions no test touches.
// Useful for "out of scope" / cross-jurisdiction testing.
const GOVT_REMOTE_LOCALITIES = [
  { province: "Tierra del Fuego", locality: "Ushuaia" },
  { province: "Santa Cruz", locality: "El Calafate" },
];

// Local govt — covers the same jurisdictions where the seed refugio + vet
// operate, so approval-request routing actually goes to this govt (not just
// to admin fallback). NOTE: these localities collide with vitest fixtures in
// `__tests__/profile-self-service.test.ts` — the 2 coverage tests there will
// fail after seeding. Documented tradeoff: user picked geographic realism
// over green test suite for the seed.
const GOVT_LOCAL_LOCALITIES = [
  { province: "Buenos Aires", locality: "La Plata" },
  { province: "CABA", locality: "Palermo" },
];

// Coverage zones for the seed refugio — required for Lost & Found Fase 6
// broadcast fanout to have any destinatarios.
const ORG_COVERAGE_ZONES: Array<{
  province: string;
  locality: string;
  isPrimary: boolean;
}> = [
  { province: "Buenos Aires", locality: "La Plata", isPrimary: true },
  { province: "CABA", locality: "Palermo", isPrimary: false },
];

// ---------------------------------------------------------------------------
// Supabase admin client
// ---------------------------------------------------------------------------

const supabase: SupabaseClient = createSdkClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "ERROR";
function log(tag: LogTag, msg: string) {
  console.log(`[${tag.padEnd(4)}] ${msg}`);
}

async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      throw new Error(
        `listUsers failed on page ${page}: ${error.message ?? "(no message)"} — full=${JSON.stringify(error)}`,
      );
    }
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
    page++;
  }
}

/**
 * Creates an auth.users row via service-role admin SDK with email_confirm:true.
 * This fires the same `handle_new_user` trigger as a real /signup submission;
 * it just bypasses email confirmation + rate limits (necessary for local seed).
 *
 * `userRole` is read by the trigger from raw_app_meta_data.user_role (NOT
 * user_metadata, which is client-writable — see migration 0133). The service
 * role CAN write app_metadata, so we pass it there. display_name stays in
 * user_metadata (non-privileged). Pass 'owner' (default) for normal users;
 * 'admin' is used only for the bootstrap founder.
 */
async function ensureAuthUser(
  email: string,
  displayName: string,
  userRole: "owner" | "admin" = "owner",
): Promise<{ id: string; created: boolean }> {
  const existingId = await findAuthUserIdByEmail(email);
  if (existingId) return { id: existingId, created: false };

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: SHARED_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: displayName },
    app_metadata: { user_role: userRole },
  });
  if (error || !data.user) {
    throw new Error(`createUser(${email}) failed: ${error?.message ?? "no user"}`);
  }
  return { id: data.user.id, created: true };
}

/**
 * Re-asserts the shared password on an account that already existed — LOCAL
 * ONLY. On a remote target an existing account keeps its password: a re-seed
 * must never silently overwrite a rotated secret (the 8 e2e staging accounts,
 * scripts/ops/rotate-staging-e2e-password.ts) or a real person's password
 * (R8/C4b security review, 2026-09-23). See shouldResetSeedPassword.
 */
async function syncSeedPassword(userId: string, created: boolean): Promise<void> {
  if (!shouldResetSeedPassword(ENV_TARGET.isLocal, created)) return;
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    password: SHARED_PASSWORD,
  });
  if (error) throw new Error(`updateUserById(${userId}) failed: ${error.message}`);
}

/**
 * Seed-only shortcut: marks a user's DNI as verified without going through the
 * real Mi Argentina flow (which doesn't exist yet). Idempotent — only updates
 * when dni_verified is currently false.
 *
 * For a PERSONAL account it writes dni_hash + dni_last4 ALONGSIDE the flag,
 * exactly as the real writer (verifyDniForUser) does in one transaction. It used
 * to set only the flag and leave the DNI columns NULL, which left a personal
 * profile "verified" with no DNI on file — a state the product's own screens
 * cannot represent. Every seeded persona was in it, and it cost two findings in
 * the master test CIU: the "Declarar ahora" button opened nothing (N2b, the
 * run's only hard blocker), and the tránsito pool let a user enrol with an
 * undeclared DNI (N3-b). The pool gate was never broken — it asked `dniVerified`,
 * as docs/patterns/petition-prerequisites.md specifies, and the seed had lied.
 *
 * INSTITUTIONAL accounts are left flag-only, and that is not an oversight: the
 * `profiles_institutional_no_pii` CHECK forbids dni_hash on a non-personal
 * profile outright. An institution has no DNI, so "verified with no DNI" is its
 * CORRECT shape — the incoherent state was only ever the personal one.
 *
 * The synthetic DNI is derived from the user id so it is stable across re-runs
 * and distinct per account — profiles_dni_hash_unique (migration 0106) is a
 * partial unique index over dni_hash, so two seeded accounts must never collide.
 *
 * TODO(mi-argentina): remove this once the real OAuth callback is wired; the
 * seed should instead exercise the real verifyDniForUser writer.
 */
async function syncDniVerified(userId: string): Promise<void> {
  // 8 digits, deterministic per user id, never colliding across seed accounts.
  const digits = createHash("sha256").update(userId).digest("hex");
  const syntheticDni = String(10_000_000 + (Number.parseInt(digits.slice(0, 12), 16) % 90_000_000));

  // Institutional profiles: flag only — writing a DNI here trips
  // profiles_institutional_no_pii and aborts the whole seed.
  await db
    .update(profiles)
    .set({ dniVerified: true, dniVerifiedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(profiles.id, userId),
        eq(profiles.dniVerified, false),
        ne(profiles.accountType, "personal"),
      ),
    );

  await db
    .update(profiles)
    .set({
      dniVerified: true,
      dniHash: hashDni(syntheticDni),
      dniLast4: dniLast4(syntheticDni),
      dniVerifiedAt: new Date(),
      updatedAt: new Date(),
    })
    // Self-healing, not merely idempotent: it also fires on an ALREADY-verified
    // profile whose dni_last4 is NULL. Gating on `dniVerified = false` alone
    // would have left every account seeded before this fix stranded in the
    // half-state forever — re-running the seed is how an existing environment
    // (local or staging) gets repaired.
    .where(
      and(
        eq(profiles.id, userId),
        eq(profiles.accountType, "personal"),
        or(eq(profiles.dniVerified, false), isNull(profiles.dniLast4)),
      ),
    );
}

async function readProfileRole(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return row?.role ?? null;
}

// ---------------------------------------------------------------------------
// Step 1 — bootstrap founder admin
//
// The schema comment in db/schema.ts says "bootstrap is a manual SQL seed of
// the founder" — this is the script-equivalent: create auth user, set
// profiles.role='admin', profiles.account_type='institutional'.
// ---------------------------------------------------------------------------

async function bootstrapAdmin(): Promise<string> {
  log("STEP", "1/9 — bootstrap admin");
  const { id, created } = await ensureAuthUser(EMAILS.admin, DISPLAY.admin, "admin");
  log(created ? "OK" : "SKIP", `auth.users ${EMAILS.admin} (admin)`);

  // The trigger set role='admin' via app_metadata. We still need account_type
  // and a known password (it was set on create, but be idempotent if re-running).
  await db
    .update(profiles)
    .set({
      role: "admin",
      accountType: "institutional",
      displayName: DISPLAY.admin,
      // Una institución no tiene DNI: el CHECK profiles_institutional_no_pii lo
      // prohíbe. Limpiarlo acá hace la operación INDEPENDIENTE DEL ORDEN y además
      // repara una fila que ya haya quedado mal — sin esto, un perfil personal con
      // DNI no puede volverse institucional nunca más y el seed muere en el paso 1.
      dniHash: null,
      dniLast4: null,
      updatedAt: new Date(),
    })
    .where(eq(profiles.id, id));
  log("OK", "profile role=admin accountType=institutional");

  // DESPUES de fijar account_type, nunca antes. El trigger crea el perfil como
  // 'personal', asi que llamar a esto arriba le escribia un DNI a una cuenta que
  // una linea despues pasa a institucional — y el CHECK
  // profiles_institutional_no_pii aborta el seed entero (2026-08-12). El guard
  // de syncDniVerified mira el estado ACTUAL; el orden es lo que lo hace cierto.
  await syncDniVerified(id);
  return id;
}

// ---------------------------------------------------------------------------
// Step 2 — owner signup (the default self-serve path)
// ---------------------------------------------------------------------------

async function signupOwner(): Promise<string> {
  log("STEP", "2/9 — owner signup (owner@dim.test)");
  const { id, created } = await ensureAuthUser(EMAILS.owner, DISPLAY.owner);
  log(created ? "OK" : "SKIP", `auth.users ${EMAILS.owner} (owner)`);
  await syncDniVerified(id);
  // Trigger already set role=owner + displayName from metadata; nothing else to patch.
  await db
    .update(profiles)
    .set({ phone: "+54 9 11 5555-1001", updatedAt: new Date() })
    .where(eq(profiles.id, id));
  return id;
}

// ---------------------------------------------------------------------------
// Step 3 — vet upgrade flow (owner → vet via approval)
// ---------------------------------------------------------------------------

async function provisionVet(adminId: string): Promise<string> {
  log("STEP", "3/9 — vet matricula approval flow (vet@dim.test)");
  const { id, created } = await ensureAuthUser(EMAILS.vet, DISPLAY.vet);
  log(created ? "OK" : "SKIP", `auth.users ${EMAILS.vet} (signed up as owner)`);
  await syncDniVerified(id);

  const currentRole = await readProfileRole(id);
  if (currentRole === "vet") {
    log("SKIP", "vet already approved — no action");
    return id;
  }

  // Check if there's already a pending request (idempotency for partial re-runs).
  const [pending] = await db
    .select({ publicToken: approvalRequests.publicToken })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.applicantUserId, id),
        eq(approvalRequests.type, "role_upgrade_vet"),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .limit(1);

  let requestToken: string;
  if (pending) {
    requestToken = pending.publicToken;
    log("SKIP", `pending vet upgrade request exists (${requestToken})`);
  } else {
    const upgradeResult = await requestVetUpgradeForUser(id, {
      matriculaNumber: "V-12345-BA",
      matriculaJurisdiccion: "Buenos Aires",
      operationalProvince: "Buenos Aires",
      operationalLocality: "La Plata",
      especialidad: "Clínica general — pequeños animales",
      anosExperiencia: 8,
    });
    if (upgradeResult.error) {
      throw new Error(`requestVetUpgradeForUser failed: ${upgradeResult.error}`);
    }
    const [fresh] = await db
      .select({ publicToken: approvalRequests.publicToken })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.applicantUserId, id),
          eq(approvalRequests.type, "role_upgrade_vet"),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (!fresh) throw new Error("vet upgrade request not found after create");
    requestToken = fresh.publicToken;
    log("OK", `submitted vet upgrade request ${requestToken}`);
  }

  // The matrícula approval path refuses any note that does not carry the
  // checklist prefix — a deliberate "verification, not rubber stamp" guard
  // (app/gob/cola/_lib/matricula-verification.ts, UI/UX audit 2026-07). A seed
  // has no real matrícula to verify, so it satisfies the guard's SHAPE and then
  // says so in the free text: the prefix lands verbatim in audit_log and in the
  // applicant's notification, and anyone reading either must be able to tell
  // seeded data from a decision a human actually made.
  const decision = await approveRequestForAuthority(
    adminId,
    requestToken,
    composeMatriculaApprovalNotes(
      "Alta por script de datos de prueba — ningún registro oficial fue consultado.",
    ),
  );
  if ("error" in decision) {
    throw new Error(`approveRequestForAuthority(vet) failed: ${decision.error}`);
  }
  log("OK", "admin approved vet upgrade → profiles.role=vet, matriculaVerified=true");
  return id;
}

// ---------------------------------------------------------------------------
// Step 4 — org creation + verification flow
// ---------------------------------------------------------------------------

async function provisionOrg(
  adminId: string,
): Promise<{ orgAdminUserId: string; orgId: string; orgToken: string }> {
  log("STEP", "4/9 — org creation + verification (orgadmin@dim.test → Refugio Test)");
  const { id: orgAdminId, created } = await ensureAuthUser(EMAILS.orgAdmin, DISPLAY.orgAdmin);
  log(created ? "OK" : "SKIP", `auth.users ${EMAILS.orgAdmin} (signed up as owner)`);
  await syncDniVerified(orgAdminId);

  // Does this user already admin an org?
  const [existingMembership] = await db
    .select({
      orgId: organizationMemberships.organizationId,
    })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.userId, orgAdminId),
        eq(organizationMemberships.role, "admin"),
        isNull(organizationMemberships.leftAt),
      ),
    )
    .limit(1);

  let orgId: string;
  if (existingMembership) {
    orgId = existingMembership.orgId;
    log("SKIP", `orgadmin already manages org ${orgId.slice(0, 8)}`);
  } else {
    const createRes = await createOrganizationForUser(orgAdminId, {
      name: "Refugio Test",
      legalName: "Refugio Test (Seed)",
      orgType: "shelter",
      // Unique CUIT chosen to avoid colliding with the canonical test CUIT
      // (30-71234567-8) used in __tests__/role-upgrade.test.ts.
      cuit: "30-99999999-9",
      email: "refugio@dim.test",
      phone: "+54 9 221 555-0001",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      personeriaJuridicaNumber: "PJ-12345",
    });
    if (createRes.error || !createRes.organizationId) {
      throw new Error(`createOrganizationForUser failed: ${createRes.error}`);
    }
    orgId = createRes.organizationId;
    log("OK", `org created (id=${orgId.slice(0, 8)}) — pending verification`);
  }

  const [orgRow] = await db
    .select({
      verified: organizations.verified,
      publicToken: organizations.publicToken,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!orgRow) throw new Error("organization not found after create");

  if (orgRow.verified) {
    log("SKIP", "org already verified");
  } else {
    const [pending] = await db
      .select({ publicToken: approvalRequests.publicToken })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.targetOrganizationId, orgId),
          eq(approvalRequests.type, "organization_verification"),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (!pending) throw new Error("pending verification request not found");

    const decision = await approveRequestForAuthority(
      adminId,
      pending.publicToken,
      "Documentación validada — seed script.",
    );
    if ("error" in decision) {
      throw new Error(`approveRequestForAuthority(org) failed: ${decision.error}`);
    }
    log("OK", "admin approved org verification → organizations.verified=true");
  }

  return { orgAdminUserId: orgAdminId, orgId, orgToken: orgRow.publicToken };
}

// ---------------------------------------------------------------------------
// Step 5 — govt institutional account (via real writer)
// ---------------------------------------------------------------------------

async function provisionGovt(
  adminId: string,
  config: {
    stepLabel: string;
    email: string;
    displayName: string;
    localities: Array<{ province: string; locality: string }>;
  },
): Promise<string> {
  log("STEP", `${config.stepLabel} — govt institutional account (${config.email})`);

  // Inlined to avoid pulling in lib/supabase/admin.ts (server-only). The DB
  // steps mirror createInstitutionalAccountForAuthority exactly: handle_new_user
  // creates the profile row → we patch institutional fields → insert assignments
  // → audit_log → welcome notification. Same code paths a real admin UI hits.
  const { id, created } = await ensureAuthUser(config.email, config.displayName, "owner");
  if (created) {
    log("OK", `auth.users ${config.email} (created via admin SDK)`);
  } else {
    log("SKIP", `auth.users ${config.email} already exists`);
  }
  const currentRole = await readProfileRole(id);
  if (currentRole !== "govt") {
    await db.transaction(async (tx) => {
      await tx
        .update(profiles)
        .set({
          role: "govt",
          accountType: "institutional",
          displayName: config.displayName,
          // Idem admin: sin DNI, y limpiándolo por si la fila ya venía mal.
          dniHash: null,
          dniLast4: null,
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, id));

      // Insert any govt_assignments that don't already exist (idempotent).
      // Each loc is resolved through the SAME canonical catalog the real
      // writers use (resolveCanonicalJurisdiction) before it ever touches
      // govt_assignments — this script bypasses createInstitutionalAccountForAuthority
      // (server-only import, see note above), so it must not bypass its
      // canonicalization guarantee too. Fail loud on garbage input rather
      // than silently insert a locality that will never resolve at read
      // time (issue #758).
      for (const loc of config.localities) {
        let canonicalProvince: string;
        let canonicalLocality: string;
        try {
          const resolved = await resolveCanonicalJurisdiction({
            rawProvince: loc.province,
            rawLocality: loc.locality,
          });
          canonicalProvince = resolved.province.name;
          canonicalLocality = resolved.locality.localityName;
        } catch (err) {
          if (err instanceof JurisdictionValidationError) {
            log(
              "ERROR",
              `${config.email}: jurisdicción inválida (${loc.province} / ${loc.locality}) — ${err.message}`,
            );
            process.exit(2);
          }
          throw err;
        }

        const [existing] = await tx
          .select({ id: govtAssignments.id })
          .from(govtAssignments)
          .where(
            and(
              eq(govtAssignments.userId, id),
              eq(govtAssignments.jurisdictionProvince, canonicalProvince),
              eq(govtAssignments.jurisdictionLocality, canonicalLocality),
              isNull(govtAssignments.revokedAt),
            ),
          )
          .limit(1);
        if (existing) continue;
        await tx.insert(govtAssignments).values({
          userId: id,
          jurisdictionProvince: canonicalProvince,
          jurisdictionLocality: canonicalLocality,
          grantedByUserId: adminId,
        });
      }

      await tx.insert(auditLog).values({
        actorUserId: adminId,
        action: "institutional_govt_created",
        targetUserId: id,
        payload: {
          role: "govt",
          display_name: config.displayName,
          email: config.email,
          initial_localities: config.localities,
          method: "seed_script",
        },
      });

      await tx.insert(notifications).values({
        userId: id,
        notificationType: "institutional_account_created",
        title: "Tu cuenta institucional fue creada",
        body: "Un administrador te creó una cuenta. Iniciá sesión con tus credenciales.",
        severity: "info",
        ctaLabel: "Acceder",
        ctaUrl: "/login",
      });
    });
    log("OK", `govt profile institutional + ${config.localities.length} jurisdicciones`);
  } else {
    log("SKIP", "govt profile already provisioned");
  }

  // Re-assert the shared password so LOCAL re-runs leave a known login.
  await syncSeedPassword(id, created);
  return id;
}

// ---------------------------------------------------------------------------
// Step 6d — national read-only institutional account (nacional@dim.test)
//
// Migration 0214. Same provisioning shape as a govt account MINUS the
// assignments: role='national', account_type='institutional', no
// govt_assignments (its read scope is universal by ROLE, never by an empty
// list — lib/domain/jurisdiction-canonical.ts hasNationalReadScope), an audit
// row and the welcome notification. Every mutating /gob action refuses it
// (requireAdminOrGovtOrRedirect admits admin | govt only), /admin refuses it.
// ---------------------------------------------------------------------------

async function provisionNational(adminId: string): Promise<string> {
  log("STEP", `6d/9 — national read-only institutional account (${EMAILS.national})`);

  const { id, created } = await ensureAuthUser(EMAILS.national, DISPLAY.national, "owner");
  log(
    created ? "OK" : "SKIP",
    `auth.users ${EMAILS.national}${created ? " (created)" : " already exists"}`,
  );

  const currentRole = await readProfileRole(id);
  if (currentRole !== "national") {
    await db.transaction(async (tx) => {
      await tx
        .update(profiles)
        .set({
          role: "national",
          accountType: "institutional",
          displayName: DISPLAY.national,
          // Idem admin/govt: an institution has no DNI (profiles_institutional_no_pii).
          dniHash: null,
          dniLast4: null,
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, id));

      // The audit action list is the source of a DB CHECK (db/schema.ts) and
      // of the declared-actions fence; a dedicated action is a migration of
      // its own. The seed is the only creator of this role today, so it logs
      // the institutional-creation action that exists and names the role in
      // the payload — the same row shape createInstitutionalAccountForAuthority
      // writes for a govt.
      await tx.insert(auditLog).values({
        actorUserId: adminId,
        action: "institutional_govt_created",
        targetUserId: id,
        payload: {
          role: "national",
          display_name: DISPLAY.national,
          email: EMAILS.national,
          method: "seed_script",
        },
      });

      await tx.insert(notifications).values({
        userId: id,
        notificationType: "institutional_account_created",
        title: "Tu cuenta institucional fue creada",
        body: "Un administrador te creó una cuenta de lectura nacional. Iniciá sesión con tus credenciales.",
        severity: "info",
        ctaLabel: "Acceder",
        ctaUrl: "/login",
      });
    });
    log("OK", "national profile institutional, no jurisdictions (universal READ scope by role)");
  } else {
    log("SKIP", "national profile already provisioned");
  }

  await syncSeedPassword(id, created);
  return id;
}

async function seedOrgCoverage(orgId: string): Promise<void> {
  log("STEP", "5/9 — coverage zones del refugio (Lost & Found Fase 6 fanout)");
  for (const zone of ORG_COVERAGE_ZONES) {
    const [existing] = await db
      .select({ id: organizationCoverage.id })
      .from(organizationCoverage)
      .where(
        and(
          eq(organizationCoverage.organizationId, orgId),
          eq(organizationCoverage.jurisdictionProvince, zone.province),
          eq(organizationCoverage.jurisdictionLocality, zone.locality),
        ),
      )
      .limit(1);
    if (existing) {
      log("SKIP", `coverage ${zone.province} / ${zone.locality}`);
      continue;
    }
    await db.insert(organizationCoverage).values({
      organizationId: orgId,
      jurisdictionProvince: zone.province,
      jurisdictionLocality: zone.locality,
      isPrimary: zone.isPrimary,
    });
    log("OK", `coverage ${zone.province} / ${zone.locality}${zone.isPrimary ? " (primary)" : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Step 5c — sanitary authority + govt memberships (DIRECT INSERT — no writer)
// ---------------------------------------------------------------------------
//
// Decomiso execution is anchored on a REAL sanitary_authority organization:
// executeDecomisoAction resolves the principal's active membership in one
// (resolve-govt-org.ts) and rejects without it, for every role. Until
// 2026-08-18 the seeded govt accounts had jurisdiction assignments but no
// authority membership, so /gob/decomisos/nuevo rendered a wizard whose
// submit could never succeed — and once the page started saying so up front,
// the e2e specs that walk the wizard (mobile-390, review-readiness) landed on
// the explanation instead. The seed models the real requirement.

async function attachGovtToSanitaryAuthority(govtUserIds: string[]): Promise<void> {
  log("STEP", "6c/9 — autoridad sanitaria + memberships de las cuentas govt");
  const AUTHORITY_TOKEN = "DIM-AUTH-SEED1";

  let [authority] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, AUTHORITY_TOKEN))
    .limit(1);

  if (authority) {
    log("SKIP", "autoridad sanitaria seed ya existe");
  } else {
    [authority] = await db
      .insert(organizations)
      .values({
        publicToken: AUTHORITY_TOKEN,
        displayName: "Autoridad Sanitaria Test",
        legalName: "Autoridad Sanitaria Test (Seed)",
        orgType: "sanitary_authority",
        email: "autoridad@dim.test",
        verified: true,
        status: "active",
        // A province is a hard execute-time requirement
        // (executeDecomisoAction rejects an authority without one).
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      })
      .returning({ id: organizations.id });
    log("OK", `autoridad sanitaria creada (${AUTHORITY_TOKEN})`);
  }

  for (const userId of govtUserIds) {
    const [existing] = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, authority.id),
          eq(organizationMemberships.userId, userId),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    if (existing) {
      log("SKIP", `membership govt ${userId.slice(0, 8)} ya presente`);
      continue;
    }
    await db.insert(organizationMemberships).values({
      organizationId: authority.id,
      userId,
      role: "admin",
      title: "Operador/a de autoridad sanitaria",
    });
    log("OK", `govt ${userId.slice(0, 8)} asociado a la autoridad sanitaria`);
  }
}

// ---------------------------------------------------------------------------
// Step 6 — vet membership at the refugio (DIRECT INSERT — no writer)
// ---------------------------------------------------------------------------

async function attachVetToOrg(orgId: string, vetUserId: string): Promise<void> {
  log("STEP", "7/9 — vet membership at refugio (direct INSERT — no writer extracted)");
  const [existing] = await db
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, orgId),
        eq(organizationMemberships.userId, vetUserId),
        isNull(organizationMemberships.leftAt),
      ),
    )
    .limit(1);
  if (existing) {
    log("SKIP", "vet membership already present");
    return;
  }
  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: vetUserId,
    role: "vet_individual",
    title: "Vet de planta",
    canWritePetEvents: true,
  });
  log("OK", "vet attached to refugio as vet_individual with write capability");
}

// ---------------------------------------------------------------------------
// Step 7 — owner pets (DIRECT INSERT — no writer extracted from createPetAction)
// ---------------------------------------------------------------------------

async function seedOwnerPets(ownerUserId: string): Promise<void> {
  log("STEP", "8/9 — owner mascotas (direct INSERT — pets.ts is a `use server` action)");
  const [hasPet] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.ownerUserId, ownerUserId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (hasPet) {
    log("SKIP", "owner already has pets");
    return;
  }

  const ownerPetSeed = [
    {
      name: "Firulais",
      species: "dog",
      breed: "Caniche",
      sex: "male" as const,
      color: "marrón",
      microchipId: "858000000000001",
      withVaccine: true,
    },
    {
      name: "Michi",
      species: "cat",
      breed: "Común europeo",
      sex: "female" as const,
      color: "blanco y negro",
      microchipId: null,
      withVaccine: false,
    },
    {
      name: "Atún",
      species: "cat",
      breed: "Siamés",
      sex: "male" as const,
      color: "crema",
      microchipId: "858000000000002",
      withVaccine: false,
    },
  ];

  for (const seed of ownerPetSeed) {
    const publicToken = generatePublicToken();
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken,
        species: seed.species,
        breed: seed.breed,
        name: seed.name,
        sex: seed.sex,
        color: seed.color,
        // Legacy chip columns omitted — ARCH-R; canonical row written to
        // pet_identifications below.
        status: "active",
        jurisdictionProvince: "CABA",
        // Real barrio — "CABA" is a province, not a locality; /turnos/buscar
        // prefills the locality filter from the owner's first pet.
        jurisdictionLocality: "Palermo",
        acquisitionMethod: "adopted",
      })
      .returning({ id: pets.id, publicToken: pets.publicToken });

    await db.insert(ownerships).values({
      petId: pet.id,
      ownerUserId,
      role: "owner",
    });

    await db.insert(petEvents).values({
      petId: pet.id,
      eventType: "pet_registered",
      occurredAt: new Date(),
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      payload: { source: "seed-script" },
    });

    // Microchip: emit event + canonical pet_identifications row so the seed
    // data stays re-derivable and the pet-cache drift harness sees zero drift.
    // Legacy pets.* chip columns not written — ARCH-R.
    if (seed.microchipId) {
      const chip = seed.microchipId;
      const chipNow = new Date();
      await db.insert(petEvents).values({
        petId: pet.id,
        eventType: "microchip_implanted",
        occurredAt: chipNow,
        recordedAt: chipNow,
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        payload: {
          chip_number: chip,
          country_code: "858",
          implanted_by: null,
          location_on_body: null,
          implant_date_known: true,
        },
      });
      await db.insert(petIdentifications).values({
        petId: pet.id,
        kind: "microchip_iso",
        code: chip,
        recordedAt: chipNow.toISOString().slice(0, 10),
        isoCountryCode: chip.slice(0, 3),
        isoManufacturerCode: chip.slice(3, 7),
        isoNationalId: chip.slice(7, 15),
        isoCompliant: true,
      });
    }

    if (seed.withVaccine) {
      const dueAt = new Date(Date.now() + 365 * 24 * 3600 * 1000);
      const [vaccineEvent] = await db
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "vaccination_administered",
          occurredAt: new Date(),
          recordedByUserId: ownerUserId,
          authorRole: "owner",
          payload: {
            vaccine: "Antirrábica",
            brand: "Defensor 3",
            lot_number: "AB123",
            next_due_at: dueAt.toISOString(),
          },
        })
        .returning({ id: petEvents.id });

      await db.insert(reminders).values({
        petId: pet.id,
        userId: ownerUserId,
        reminderType: "vaccine",
        dueAt,
        title: "Antirrábica anual",
        description: "Refuerzo anual de antirrábica",
        sourceEventId: vaccineEvent.id,
      });
    }

    log("OK", `pet ${seed.name} (${pet.publicToken})`);
  }
}

// ---------------------------------------------------------------------------
// Step 8 — shelter custody pets (DIRECT INSERT — no writer extracted)
// ---------------------------------------------------------------------------

async function seedShelterPets(orgId: string, intakeActorId: string): Promise<void> {
  log("STEP", "9/9 — shelter custody mascotas (direct INSERT — intake.ts is `use server`)");

  const shelterPetSeed = [
    {
      name: "Lola",
      species: "dog",
      breed: "Mixto / Cruza",
      sex: "female" as const,
      color: "negro",
      distinguishingFeatures: "Mancha blanca en el pecho",
      microchipId: null,
    },
    {
      name: "Toby",
      species: "dog",
      breed: "Mixto / Cruza",
      sex: "male" as const,
      color: "marrón claro",
      distinguishingFeatures: null,
      microchipId: "858000000000101",
    },
    {
      name: "Rocco",
      species: "cat",
      breed: "Común europeo",
      sex: "male" as const,
      color: "atigrado",
      distinguishingFeatures: "Oreja izquierda con muesca (esterilización comunitaria)",
      microchipId: null,
    },
  ];

  // The re-run guard reads the CODES this step is about to write, derived from
  // the array above so a fourth seed pet with a chip is covered the day it is
  // added. See scripts/seed-shelter-pets-guard.ts for why the old live-custody
  // check was not a re-run guard at all.
  const chipCodes = shelterPetSeed
    .map((s) => s.microchipId)
    .filter((code): code is string => code !== null);
  const state = await shelterPetsAlreadySeeded({ orgId, chipCodes });
  if (state.alreadySeeded) {
    log("SKIP", `shelter pets already seeded — ${state.detail}`);
    return;
  }

  // ALL OR NOTHING. What actually happened on staging was a PARTIAL run: the
  // pets and their spine events committed one by one, the chip row that would
  // have collided was never written, and nothing rolled back — so the database
  // ended up holding pets whose `microchip_implanted` event claims a chip that
  // has no canonical pet_identifications row. The guard above decides WHETHER
  // to run; this transaction is what guarantees that when a DIFFERENT
  // constraint fires next time, the step leaves the database exactly as it
  // found it instead of half a shelter.
  await db.transaction(async (tx) => {
    for (const seed of shelterPetSeed) {
      const publicToken = generatePublicToken();
      const [pet] = await tx
        .insert(pets)
        .values({
          publicToken,
          species: seed.species,
          breed: seed.breed,
          name: seed.name,
          sex: seed.sex,
          color: seed.color,
          distinguishingFeatures: seed.distinguishingFeatures,
          // Legacy chip columns omitted — ARCH-R; canonical row written to
          // pet_identifications below.
          status: "active",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "La Plata",
          acquisitionMethod: "found_stray",
        })
        .returning({ id: pets.id, publicToken: pets.publicToken });

      await tx.insert(ownerships).values({
        petId: pet.id,
        ownerOrganizationId: orgId,
        role: "shelter_custody",
      });

      // The pet's birth certificate in the spine. Without it these three rows
      // are pets that, as far as the append-only log is concerned, were never
      // registered — a cache row outranking the spine, which is what invariant
      // #3 forbids. lint:spine caught exactly this the first time CI ran the
      // fence against a database built by db:bootstrap (2026-07-28): three
      // orphans, Lola / Toby / Rocco, straight out of this loop.
      //
      // It is dated one second before the intake so the spine reads in the
      // order the events actually happened: registered, then taken in.
      const registeredAt = new Date(Date.now() - 1000);
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "pet_registered",
        occurredAt: registeredAt,
        recordedByUserId: intakeActorId,
        authorRole: "shelter",
        authorOrganizationId: orgId,
        authorVerified: true,
        payload: { source: "seed-script" },
      });

      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "shelter_intake_recorded",
        occurredAt: new Date(),
        recordedByUserId: intakeActorId,
        authorRole: "shelter",
        authorOrganizationId: orgId,
        authorVerified: true,
        payload: {
          source: "seed-script",
          intake_kind: "stray",
          location_description: "Vía pública — La Plata",
        },
      });

      // Microchip: emit event + canonical pet_identifications row.
      // Legacy pets.* chip columns not written — ARCH-R.
      // implant_date_known: true so the projection's microchipImplantedAt
      // (formatDate(occurredAt)) matches the canonical row's recordedAt —
      // both resolve to the same date and the pet-cache drift harness sees
      // zero drift (ARCH-I).
      if (seed.microchipId) {
        const chip = seed.microchipId;
        const chipNow = new Date();
        await tx.insert(petEvents).values({
          petId: pet.id,
          eventType: "microchip_implanted",
          occurredAt: chipNow,
          recordedAt: chipNow,
          recordedByUserId: intakeActorId,
          authorRole: "shelter",
          authorOrganizationId: orgId,
          authorVerified: true,
          payload: {
            chip_number: chip,
            country_code: "858",
            implanted_by: null,
            location_on_body: null,
            implant_date_known: true,
          },
        });
        await tx.insert(petIdentifications).values({
          petId: pet.id,
          kind: "microchip_iso",
          code: chip,
          recordedAt: chipNow.toISOString().slice(0, 10),
          isoCountryCode: chip.slice(0, 3),
          isoManufacturerCode: chip.slice(3, 7),
          isoNationalId: chip.slice(7, 15),
          isoCompliant: true,
        });
      }

      log("OK", `shelter pet ${seed.name} (${pet.publicToken})`);
    }
  });
}

// ---------------------------------------------------------------------------
// Step 10 — the two PUBLIC fixtures the bootstrap seed never had
// ---------------------------------------------------------------------------
//
// e2e/_seed-profile.ts said it out loud: "pnpm db:bootstrap: reference data +
// seed-test-users and STOPS. No cases, no lost pets, no adoption listings."
// Two axe gates in e2e/public-smoke.spec.ts resolve their fixture off the
// RENDERED /perdidas and /adoptar pages, so with nothing lost and nothing
// listed they SKIPPED on every CI run — including the audit of the lost-mode
// credential, which is the Ley 26.653 hero surface. A gate that can only skip
// is not a gate.
//
// These two steps close that, minimally and deterministically: one lost pet off
// the owner's existing pets, one adoption listing off the shelter's. No new
// pets, no randomness beyond the tokens the pets already carry.

/** Mark the owner's first pet lost — spine event + open case + projection. */
async function seedLostPet(ownerUserId: string): Promise<void> {
  log("STEP", "10/11 — lost pet (e2e fixture: /perdidas + the lost-mode credential)");

  const [existingLost] = await db
    .select({ id: pets.id })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(ownerships.ownerUserId, ownerUserId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
        eq(pets.status, "lost"),
      ),
    )
    .limit(1);
  if (existingLost) {
    log("SKIP", "owner already has a lost pet");
    return;
  }

  const [pet] = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      name: pets.name,
      status: pets.status,
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(ownerships.ownerUserId, ownerUserId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
        eq(pets.status, "active"),
      ),
    )
    .orderBy(pets.createdAt)
    .limit(1);
  if (!pet) {
    log("SKIP", "owner has no active pet to mark lost");
    return;
  }

  // The episode case, exactly as setPetLostWriter opens it. Not optional
  // decoration: a status='lost' pet with no open lost_pet_episode is the stale
  // state the profile renders as a banner, and the spine fence counts it.
  const casePublicCode = generatePrefixedToken("CAS");
  const [caseRow] = await db
    .insert(cases)
    .values({
      publicCode: casePublicCode,
      caseKind: "lost_pet_episode",
      status: "open",
      primarySubjectKind: "registered_pet",
      primaryPetId: pet.id,
      jurisdictionCountry: "AR",
      jurisdictionProvince: pet.province,
      jurisdictionLocality: pet.locality,
      openedByUserId: ownerUserId,
      openedReason: `Pet ${pet.publicToken} marked as lost by owner — se escapó por el portón`,
    })
    .returning({ id: cases.id });

  const now = new Date();
  await db.insert(petEvents).values({
    petId: pet.id,
    eventType: "status_changed",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: ownerUserId,
    authorRole: "owner",
    caseId: caseRow.id,
    payload: {
      payload_version: 1,
      from_status: pet.status,
      to_status: "lost",
      location_description: "Palermo, CABA (última vez visto en Av. Santa Fe al 3200)",
      reason: null,
      // Affirmative consent, stated explicitly (migration 0158 made the column
      // defaults fail-closed): this fixture DOES disclose, because the surface
      // under audit is the disclosing credential.
      disclosure_prefs_snapshot: {
        first_name: true,
        phone: true,
        email: false,
        last_location: true,
        finder_form: true,
      },
    },
  });

  // Projection: status + the 5 disclosure columns, same set the writer updates.
  await db
    .update(pets)
    .set({
      status: "lost",
      discloseFirstNameWhenLost: true,
      disclosePhoneWhenLost: true,
      discloseEmailWhenLost: false,
      discloseLastLocationWhenLost: true,
      allowFinderFormWhenLost: true,
      updatedAt: now,
    })
    .where(eq(pets.id, pet.id));

  log("OK", `lost pet ${pet.name} (${pet.publicToken}) · caso ${casePublicCode}`);
}

/** List the shelter's first pet for adoption — the /adoptar public fixture. */
async function seedAdoptionListing(orgId: string, actorUserId: string): Promise<void> {
  log("STEP", "11/11 — adoption listing (e2e fixture: /adoptar + the public pet detail)");

  const [pet] = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      name: pets.name,
      adoptionListedAt: pets.adoptionListedAt,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(ownerships.ownerOrganizationId, orgId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
        eq(pets.status, "active"),
      ),
    )
    .orderBy(pets.createdAt)
    .limit(1);
  if (!pet) {
    log("SKIP", "org holds no active pet in custody");
    return;
  }
  if (pet.adoptionListedAt) {
    log("SKIP", `${pet.name} already listed for adoption`);
    return;
  }

  const now = new Date();

  // The ELIGIBILITY half is a pet FACT, so it belongs in the spine before it
  // belongs in the cache: `adoptionEligible` + `adoptionEligibilitySetAt` are
  // both in rederivePetCache's CHECKED_COLUMNS, and writing them without their
  // `adoption_eligibility_set` event is exactly the drift invariant #3 forbids
  // (the pet-cache harness caught this seed doing it). Mirrors
  // AdoptionRepository.setEligibility: open the adoption_listing case, then
  // insert the event carrying its id.
  const casePublicCode = generatePrefixedToken("CAS");
  const [listingCase] = await db
    .insert(cases)
    .values({
      publicCode: casePublicCode,
      caseKind: "adoption_listing",
      status: "open",
      primarySubjectKind: "registered_pet",
      primaryPetId: pet.id,
      jurisdictionCountry: "AR",
      openedByUserId: actorUserId,
      openedByOrganizationId: orgId,
      openedReason: "Mascota publicada en adopción por el refugio",
    })
    .returning({ id: cases.id });

  await db.insert(petEvents).values({
    petId: pet.id,
    eventType: "adoption_eligibility_set",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: actorUserId,
    authorRole: "shelter",
    authorOrganizationId: orgId,
    authorVerified: true,
    caseId: listingCase.id,
    payload: {
      payload_version: 1,
      eligible: true,
      ineligible_reason: null,
      ineligible_reason_notes: null,
      ineligible_until: null,
      previous_state: null,
    },
  });

  // The LISTING half is curated shelf metadata — no event, by design
  // (AdoptionRepository.setListingStatus emits none) and none of these columns
  // is in CHECKED_COLUMNS.
  // The full gate queryAdoptionListing checks: eligible + listed + not paused,
  // on an active shelter_custody row of a VERIFIED shelter org (provisionOrg
  // already verifies it). Anything less and the listing exists in the table
  // while the public page stays empty — which is exactly the failure mode this
  // fixture is here to prevent.
  await db
    .update(pets)
    .set({
      adoptionEligible: true,
      adoptionEligibilitySetAt: now,
      adoptionEligibilitySetByUserId: actorUserId,
      adoptionListedAt: now,
      adoptionListingPausedAt: null,
      adoptionStory: "Llegó al refugio como callejera y se recuperó muy bien. Busca familia.",
      adoptionRequirements: "Casa con patio cerrado. Visita previa.",
      adoptionEnergyLevel: "medium",
      adoptionSizeEstimate: "medium",
      adoptionAgeBucket: "adult",
      adoptionGoodWithKids: true,
      adoptionGoodWithDogs: true,
      updatedAt: now,
    })
    .where(eq(pets.id, pet.id));

  log("OK", `adoption listing ${pet.name} (${pet.publicToken})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Owner B — cross-tenant isolation target (owner2@dim.test).
// Minimal owner: auth user (role via metadata trigger) + DNI-verified + pets.
// Idempotent, like every other step.
// ---------------------------------------------------------------------------

async function ensureOwnerB(): Promise<string> {
  log("STEP", "2b/9 — owner B (owner2@dim.test, cross-tenant target)");
  const { id, created } = await ensureAuthUser(EMAILS.ownerB, DISPLAY.ownerB, "owner");
  log(created ? "OK" : "SKIP", `auth.users ${EMAILS.ownerB} (owner)`);
  await syncSeedPassword(id, created);
  await syncDniVerified(id);
  return id;
}

// ---------------------------------------------------------------------------
// Zero-pet owner — the GUARANTEED owner empty state.
//
// Same minimal shape as owner B (auth user + DNI-verified profile) and then
// NOTHING ELSE, forever. No pet step follows it, and no seed script may add
// one: scripts/seed-reserved-accounts.ts holds the contract, and
// scripts/check-seed-hygiene.ts fails `pnpm test` the moment this account owns
// a pet or joins an organization.
//
// It lives here rather than in a demo seed on purpose. This script is what
// `pnpm db:bootstrap` runs, so a fresh CI database has the account — the empty
// state is baseline, not demo furniture (see
// __tests__/seed-precondition-contract.test.ts on that distinction).
// ---------------------------------------------------------------------------

async function ensureZeroPetOwner(): Promise<string> {
  log("STEP", `2c/9 — zero-pet owner (${ZERO_PET_OWNER_EMAIL}, owner empty state)`);
  const { id, created } = await ensureAuthUser(
    ZERO_PET_OWNER_EMAIL,
    ZERO_PET_OWNER_DISPLAY_NAME,
    "owner",
  );
  log(created ? "OK" : "SKIP", `auth.users ${ZERO_PET_OWNER_EMAIL} (owner)`);
  await syncSeedPassword(id, created);
  await syncDniVerified(id);
  return id;
}

// Owner B's pet — a minimal real pet (no microchip, so no unique-chip clash
// with Owner A's seeded identifications) giving the cross-tenant e2e a real
// pet_id + pet_registered event to probe. Idempotent.
async function seedOwnerBPet(ownerBId: string): Promise<void> {
  log("STEP", "8b/9 — owner B mascota (cross-tenant target)");
  const [hasPet] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.ownerUserId, ownerBId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (hasPet) {
    log("SKIP", "owner B already has a pet");
    return;
  }
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      species: "dog",
      breed: "Mixto / Cruza",
      name: "Rocco",
      sex: "male",
      color: "marrón",
      status: "active",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo", // real barrio — "CABA" is not a locality
      acquisitionMethod: "adopted",
    })
    .returning({ id: pets.id, publicToken: pets.publicToken });
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: ownerBId, role: "owner" });
  await db.insert(petEvents).values({
    petId: pet.id,
    eventType: "pet_registered",
    occurredAt: new Date(),
    recordedByUserId: ownerBId,
    authorRole: "owner",
    payload: { source: "seed-script" },
  });
  log("OK", `owner B pet Rocco (${pet.publicToken})`);
}

async function main() {
  log("INFO", `Seeding against ${SUPABASE_URL}`);
  log("INFO", `Shared password: ${seedPasswordForDisplay(ENV_TARGET.isLocal, SHARED_PASSWORD)}`);

  const adminId = await bootstrapAdmin();
  const ownerId = await signupOwner();
  const ownerBId = await ensureOwnerB();
  await ensureZeroPetOwner();
  const vetId = await provisionVet(adminId);
  const { orgAdminUserId, orgId, orgToken } = await provisionOrg(adminId);
  await seedOrgCoverage(orgId);
  const govtId = await provisionGovt(adminId, {
    stepLabel: "6a/9",
    email: EMAILS.govt,
    displayName: DISPLAY.govt,
    localities: GOVT_REMOTE_LOCALITIES,
  });
  const govtLocalId = await provisionGovt(adminId, {
    stepLabel: "6b/9",
    email: EMAILS.govtLocal,
    displayName: DISPLAY.govtLocal,
    localities: GOVT_LOCAL_LOCALITIES,
  });
  await attachGovtToSanitaryAuthority([govtId, govtLocalId]);
  await provisionNational(adminId);
  await attachVetToOrg(orgId, vetId);
  await seedOwnerPets(ownerId);
  await seedOwnerBPet(ownerBId);
  await seedShelterPets(orgId, orgAdminUserId);
  await seedLostPet(ownerId);
  await seedAdoptionListing(orgId, orgAdminUserId);

  log("DONE", "seed complete");
  console.log("\n=== Access summary ===");
  console.log(`Shared password: ${seedPasswordForDisplay(ENV_TARGET.isLocal, SHARED_PASSWORD)}\n`);
  console.log(`  ${EMAILS.admin.padEnd(24)}  role=admin   → /admin  /gob`);
  console.log(`  ${EMAILS.owner.padEnd(24)}  role=owner   → /mis-mascotas`);
  console.log(
    `  ${EMAILS.vet.padEnd(24)}  role=vet     → /cuenta (matrícula verificada, no org yet)`,
  );
  console.log(`  ${EMAILS.orgAdmin.padEnd(24)}  role=owner   → /org/${orgToken}`);
  console.log(`  ${EMAILS.govt.padEnd(24)}  role=govt    → /gob (Ushuaia + El Calafate)`);
  console.log(`  ${EMAILS.govtLocal.padEnd(24)}  role=govt    → /gob (La Plata + CABA/Palermo)`);
  console.log(
    `  ${EMAILS.national.padEnd(24)}  role=national → /gob (lectura nacional, sin escritura)`,
  );
  console.log(
    `  ${ZERO_PET_OWNER_EMAIL.padEnd(24)}  role=owner   → /mis-mascotas (RESERVED: 0 mascotas, never give it any)`,
  );
  console.log(`\n  Refugio portal:   /org/${orgToken}`);
  console.log("  Administración miMAR:  /admin");
  console.log("  Gobierno:         /gob");
  console.log("  Mis mascotas:     /mis-mascotas");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[FATAL]", err);
    process.exit(1);
  });
