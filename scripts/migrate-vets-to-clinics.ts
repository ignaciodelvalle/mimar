/**
 * STATUS: applied 2026-05-20 in the /pro → clinic org deprecation. Kept in
 * the tree because __tests__/migrate-vets-to-clinics.test.ts asserts the
 * idempotency contract — re-running this in any env (or against a fresh
 * seed) must be a no-op for vets that already have their clinic.
 *
 * Backfill: every matricula-verified vet with at least one orphan service
 * offering (providerUserId set, organizationId null) gets a clinic org
 * auto-created and their offerings re-anchored to it.
 *
 * Sprint 1A Phase A of docs/superpowers/plans/2026-05-20-deprecate-pro-portal.md.
 *
 * Idempotent — re-runs detect the auto-created clinic via
 * (createdByUserId, orgType='clinic') and skip.
 *
 * Three deviations from the plan text, forced by current schema:
 *   - status='active' + verified=true + verifiedAt=now()
 *     (the plan said status='verified', but orgStatusEnum is
 *     active|suspended|dissolved — no 'verified' value exists).
 *   - jurisdiction inherited from the vet's first offering with a
 *     non-null province, not from profiles (profiles has no jurisdiction
 *     columns).
 *   - serviceOfferings.providerUserId is NULLed after the move. The
 *     service_offerings provider_xor CHECK forbids both org + user being
 *     set simultaneously, so attribution preservation has to flow through
 *     other paths (audit_log, pet_events.recordedByUserId).
 *
 * Usage:
 *   pnpm tsx scripts/migrate-vets-to-clinics.ts           # apply
 *   pnpm tsx scripts/migrate-vets-to-clinics.ts --dry-run # preview, no writes
 *   pnpm tsx scripts/migrate-vets-to-clinics.ts --allow-remote
 *
 * Safety: refuses to run against a non-local DATABASE_URL unless
 * --allow-remote is passed (mirrors scripts/db-bootstrap.ts).
 *
 * Exit codes:
 *   0  success (zero errors)
 *   2  env or local-host guard failure
 *   3  partial — some vets failed; details in stderr
 */

import { fileURLToPath } from "node:url";

import { type SupabaseClient, createClient as createSdkClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const isLocalUrl = (u: string) => u.includes("127.0.0.1") || u.includes("localhost");

// Module is importable for tests; CLI invocation runs `main()` at the end of
// this file. The guards here protect both paths from misconfigured envs.
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

const cliArgs = new Set(process.argv.slice(2));
const CLI_DRY_RUN = cliArgs.has("--dry-run");
const ALLOW_REMOTE = cliArgs.has("--allow-remote");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !DATABASE_URL) {
  console.error(
    "Missing one of NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or DATABASE_URL.",
  );
  process.exit(2);
}

if (!ALLOW_REMOTE && (!isLocalUrl(SUPABASE_URL) || !isLocalUrl(DATABASE_URL))) {
  console.error(
    `Refusing to run: target is not local (SUPABASE_URL=${SUPABASE_URL}, DATABASE_URL host non-local). Use --allow-remote to override.`,
  );
  process.exit(2);
}

const { and, eq, isNull } = await import("drizzle-orm");
const { db, organizationMemberships, organizations, profiles, serviceOfferings } = await import(
  "../db"
);
const { generatePublicToken } = await import("@/lib/infra/publicToken");

const admin: SupabaseClient = createSdkClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export type VetRow = { id: string; displayName: string };

export type Outcome =
  | { kind: "migrated"; orgId: string; offeringsReanchored: number }
  | { kind: "skipped_existing"; orgId: string; stragglerOfferingsReanchored: number }
  | { kind: "skipped_no_offerings" }
  | { kind: "error"; reason: string };

async function fetchEmail(userId: string): Promise<string | null> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data?.user?.email) return null;
  return data.user.email;
}

export async function migrateOne(vet: VetRow, opts: { dryRun?: boolean } = {}): Promise<Outcome> {
  const dryRun = opts.dryRun ?? false;
  const orphanOfferings = await db
    .select({
      id: serviceOfferings.id,
      jurisdictionProvince: serviceOfferings.jurisdictionProvince,
      jurisdictionLocality: serviceOfferings.jurisdictionLocality,
    })
    .from(serviceOfferings)
    .where(
      and(eq(serviceOfferings.providerUserId, vet.id), isNull(serviceOfferings.organizationId)),
    );

  const [existingOrg] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.createdByUserId, vet.id), eq(organizations.orgType, "clinic")))
    .limit(1);

  if (existingOrg) {
    if (orphanOfferings.length === 0) {
      return { kind: "skipped_existing", orgId: existingOrg.id, stragglerOfferingsReanchored: 0 };
    }
    if (dryRun) {
      return {
        kind: "skipped_existing",
        orgId: existingOrg.id,
        stragglerOfferingsReanchored: orphanOfferings.length,
      };
    }
    for (const o of orphanOfferings) {
      await db
        .update(serviceOfferings)
        .set({ organizationId: existingOrg.id, providerUserId: null })
        .where(eq(serviceOfferings.id, o.id));
    }
    return {
      kind: "skipped_existing",
      orgId: existingOrg.id,
      stragglerOfferingsReanchored: orphanOfferings.length,
    };
  }

  if (orphanOfferings.length === 0) return { kind: "skipped_no_offerings" };

  const offWithJurisdiction = orphanOfferings.find((o) => o.jurisdictionProvince);
  const jurisdictionProvince = offWithJurisdiction?.jurisdictionProvince ?? null;
  const jurisdictionLocality = offWithJurisdiction?.jurisdictionLocality ?? null;

  const email = await fetchEmail(vet.id);
  if (!email) return { kind: "error", reason: `no email in auth.users for vet ${vet.id}` };

  if (dryRun) {
    return { kind: "migrated", orgId: "(dry-run)", offeringsReanchored: orphanOfferings.length };
  }

  const newOrgId = await db.transaction(async (tx) => {
    const [newOrg] = await tx
      .insert(organizations)
      .values({
        publicToken: generatePublicToken(),
        displayName: `Consultorio ${vet.displayName}`,
        legalName: `Consultorio ${vet.displayName}`,
        orgType: "clinic",
        email,
        status: "active",
        verified: true,
        verifiedAt: new Date(),
        jurisdictionCountry: "AR",
        jurisdictionProvince,
        jurisdictionLocality,
        createdByUserId: vet.id,
      })
      .returning({ id: organizations.id });

    await tx.insert(organizationMemberships).values({
      organizationId: newOrg.id,
      userId: vet.id,
      role: "admin",
      canWritePetEvents: true,
    });

    for (const o of orphanOfferings) {
      await tx
        .update(serviceOfferings)
        .set({ organizationId: newOrg.id, providerUserId: null })
        .where(eq(serviceOfferings.id, o.id));
    }

    return newOrg.id;
  });

  return { kind: "migrated", orgId: newOrgId, offeringsReanchored: orphanOfferings.length };
}

export async function migrateAll(opts: { dryRun?: boolean } = {}): Promise<{
  migrated: number;
  skippedExisting: number;
  skippedNoOfferings: number;
  errors: Array<{ vetId: string; reason: string }>;
}> {
  const dryRun = opts.dryRun ?? false;
  console.log(`Backfill vets → clinics. ${dryRun ? "DRY RUN (no writes)" : "LIVE"}.`);

  const vets = (await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .where(and(eq(profiles.role, "vet"), eq(profiles.matriculaVerified, true)))) as VetRow[];

  console.log(`Found ${vets.length} matricula-verified vet(s).`);

  let migrated = 0;
  let skippedExisting = 0;
  let skippedNoOfferings = 0;
  const errors: Array<{ vetId: string; reason: string }> = [];

  for (const vet of vets) {
    try {
      const r = await migrateOne(vet, { dryRun });
      switch (r.kind) {
        case "migrated":
          migrated += 1;
          console.log(
            `  [OK ] vet ${vet.id} (${vet.displayName}) → org ${r.orgId} · ${r.offeringsReanchored} offering(s) re-anchored`,
          );
          break;
        case "skipped_existing":
          skippedExisting += 1;
          console.log(
            `  [SKIP] vet ${vet.id} (${vet.displayName}) → clinic ${r.orgId} already exists${
              r.stragglerOfferingsReanchored > 0
                ? ` (re-anchored ${r.stragglerOfferingsReanchored} straggler offering(s))`
                : ""
            }`,
          );
          break;
        case "skipped_no_offerings":
          skippedNoOfferings += 1;
          console.log(`  [SKIP] vet ${vet.id} (${vet.displayName}) — no orphan offerings`);
          break;
        case "error":
          errors.push({ vetId: vet.id, reason: r.reason });
          console.error(`  [ERR ] vet ${vet.id} → ${r.reason}`);
          break;
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      errors.push({ vetId: vet.id, reason });
      console.error(`  [ERR ] vet ${vet.id} → ${reason}`);
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Migrated:            ${migrated}`);
  console.log(`Skipped (existing):  ${skippedExisting}`);
  console.log(`Skipped (no offers): ${skippedNoOfferings}`);
  console.log(`Errors:              ${errors.length}`);

  return { migrated, skippedExisting, skippedNoOfferings, errors };
}

if (isMainModule) {
  const result = await migrateAll({ dryRun: CLI_DRY_RUN });
  if (result.errors.length > 0) process.exit(3);
}
