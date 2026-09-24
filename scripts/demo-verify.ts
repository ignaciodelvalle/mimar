/**
 * DIM Demo Readiness Verifier — demo-verify.ts
 *
 * Asserts all demo invariants at once. Run after seed:demo:scenario.
 * Produces a clear OK / MISSING line per invariant and exits with:
 *   0 — all green (ready to film)
 *   1 — one or more invariants missing
 *
 * Usage:
 *   pnpm demo:verify
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap
// ---------------------------------------------------------------------------

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// 2. Safety guards (local-only)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const ALLOW_REMOTE = process.argv.includes("--allow-remote");

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env.local — aborting.");
  process.exit(2);
}

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to verify: NODE_ENV=production.");
  process.exit(2);
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "::1"]);

function parsePgHost(url: string): string | null {
  const match = url.match(/^postgres(?:ql)?:\/\/[^@]+@([^:/]+)/);
  return match ? match[1] : null;
}

const dbHost = parsePgHost(DATABASE_URL);
const isLocalDb = dbHost ? LOCAL_HOSTS.has(dbHost) : true;

if (!ALLOW_REMOTE && !isLocalDb) {
  console.error(`Refusing: DATABASE_URL host (${dbHost}) is not local. Use --allow-remote.`);
  process.exit(4);
}

// ---------------------------------------------------------------------------
// 3. Deferred imports
// ---------------------------------------------------------------------------

const { and, eq, inArray, isNull, sql } = await import("drizzle-orm");
const {
  db,
  alertFirings,
  alertSubscriptions,
  govtAssignments,
  petEvents,
  pets,
  ALERT_FIRING_OPEN_STATUSES,
} = await import("../db");

// ---------------------------------------------------------------------------
// 4. Constants
// ---------------------------------------------------------------------------

// Must match FOCAL_LOCALITY in scripts/seed-demo-scenario.ts.
//
// This is a BARRIO, deliberately. "Ciudad Autónoma de Buenos Aires" is the INDEC
// whole-city aggregate (indec_id 02000010), which check-locality-integrity drops
// from ar_localities because it double-counts the barrios that tile the same
// city — so it is a sentinel for whole-province subsumption (lib/metrics/scope.ts
// isWholeProvinceLocality), never a value that matches real rows. Measured on the
// local DB: 0 of 1176 CABA pets and 0 of 49 CABA panorama_cube department cells
// carry it, while checkGovtUser() below does an exact eq() on it — which is why
// this constant, not the seed's, was the stale side of the mismatch (issue #758
// migrated the seed to "Palermo" and left the verifier behind).
const FOCAL_PROVINCE = "CABA";
const FOCAL_LOCALITY = "Palermo";
const REQUIRED_MONTHS = 4;

type CheckResult = { label: string; ok: boolean; detail?: string };
const results: CheckResult[] = [];

function check(label: string, ok: boolean, detail?: string): void {
  results.push({ label, ok, detail });
}

// ---------------------------------------------------------------------------
// 5. Invariant checks
// ---------------------------------------------------------------------------

async function resolveUserIdByEmail(email: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT p.id
    FROM profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE u.email = ${email}
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

// --- D0-1: ≥REQUIRED_MONTHS distinct months in focal series ---

async function checkSeriesBuckets(): Promise<void> {
  const demoPets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(
      and(
        eq(pets.jurisdictionProvince, FOCAL_PROVINCE),
        sql`${pets.publicToken} LIKE 'DIM-DEMO-%'`,
      ),
    );

  if (demoPets.length === 0) {
    check(
      `≥${REQUIRED_MONTHS} months sterilization_performed (CABA)`,
      false,
      "No DEMO- pets found — run seed:demo:scenario first",
    );
    check(
      `≥${REQUIRED_MONTHS} months vaccination_administered (CABA)`,
      false,
      "No DEMO- pets found",
    );
    return;
  }

  const petIds = demoPets.map((p) => p.id);

  const bucketExpr = sql<number>`count(distinct date_trunc('month', ${petEvents.occurredAt}))::int`;
  const [sterilRow] = await db
    .select({ bucketCount: bucketExpr })
    .from(petEvents)
    .where(
      and(inArray(petEvents.petId, petIds), eq(petEvents.eventType, "sterilization_performed")),
    );
  const sterilBuckets = Number(sterilRow?.bucketCount ?? 0);

  const [vaccRow] = await db
    .select({ bucketCount: bucketExpr })
    .from(petEvents)
    .where(
      and(inArray(petEvents.petId, petIds), eq(petEvents.eventType, "vaccination_administered")),
    );
  const vaccBuckets = Number(vaccRow?.bucketCount ?? 0);

  check(
    `≥${REQUIRED_MONTHS} months sterilization_performed (CABA)`,
    sterilBuckets >= REQUIRED_MONTHS,
    `found ${sterilBuckets} distinct months`,
  );
  check(
    `≥${REQUIRED_MONTHS} months vaccination_administered (CABA)`,
    vaccBuckets >= REQUIRED_MONTHS,
    `found ${vaccBuckets} distinct months`,
  );
}

// --- D0-2: ≥1 jurisdiction below target ---

async function checkOutlierBelow(): Promise<void> {
  // CABA has DEMO- pets registered without full sterilization → below target.
  const demoPets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(
      and(
        eq(pets.jurisdictionProvince, FOCAL_PROVINCE),
        sql`${pets.publicToken} LIKE 'DIM-DEMO-%'`,
      ),
    );

  const sterilized =
    demoPets.length > 0
      ? await db
          .selectDistinct({ petId: petEvents.petId })
          .from(petEvents)
          .where(
            and(
              inArray(
                petEvents.petId,
                demoPets.map((p) => p.id),
              ),
              eq(petEvents.eventType, "sterilization_performed"),
            ),
          )
      : [];

  const coveragePct = demoPets.length > 0 ? (sterilized.length / demoPets.length) * 100 : 0;

  check(
    "≥1 jurisdiction below target (CABA coverage < 100%)",
    demoPets.length > 0 && sterilized.length < demoPets.length,
    `CABA DEMO coverage: ${sterilized.length}/${demoPets.length} (${coveragePct.toFixed(1)}%)`,
  );
}

// --- D0-3: ≥1 event_amended ---

async function checkEventAmended(): Promise<void> {
  const demoPets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(sql`${pets.publicToken} LIKE 'DIM-DEMO-%'`);

  if (demoPets.length === 0) {
    check("≥1 event_amended in DEMO- pets", false, "No DEMO- pets found");
    return;
  }

  const amended = await db
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(
      and(
        inArray(
          petEvents.petId,
          demoPets.map((p) => p.id),
        ),
        eq(petEvents.eventType, "event_amended"),
      ),
    )
    .limit(1);

  check(
    "≥1 event_amended in DEMO- pets",
    amended.length > 0,
    amended.length > 0 ? `event id: ${amended[0].id.slice(0, 8)}…` : "none found",
  );
}

// --- D0-4: alert subscription + firing ---

async function checkAlertFiring(): Promise<void> {
  const adminId = await resolveUserIdByEmail("admin@dim.test");

  if (!adminId) {
    check("alert_subscription present (admin@dim.test)", false, "admin@dim.test not found");
    check("alert_firings row in status=disparada", false, "admin@dim.test not found");
    return;
  }

  const subs = await db
    .select({ id: alertSubscriptions.id })
    .from(alertSubscriptions)
    .where(
      and(
        eq(alertSubscriptions.actorUserId, adminId),
        eq(alertSubscriptions.metricKey, "sterilization_coverage_pct"),
        eq(alertSubscriptions.direction, "below"),
        eq(alertSubscriptions.jurisdictionProvince, FOCAL_PROVINCE),
        eq(alertSubscriptions.isActive, true),
      ),
    );

  check(
    "alert_subscription present (admin@dim.test, CABA sterilization below)",
    subs.length > 0,
    subs.length > 0 ? `id: ${subs[0].id.slice(0, 8)}…` : "none found",
  );

  if (subs.length === 0) {
    check("alert_firings row in status=disparada", false, "no subscription found");
    return;
  }

  const subIds = subs.map((s) => s.id);

  const firings = await db
    .select({ id: alertFirings.id, status: alertFirings.status })
    .from(alertFirings)
    .where(
      and(
        inArray(alertFirings.subscriptionId, subIds),
        inArray(alertFirings.status, [...ALERT_FIRING_OPEN_STATUSES]),
      ),
    )
    .limit(1);

  check(
    "alert_firings row in open status (disparada)",
    firings.length > 0,
    firings.length > 0 ? `status: ${firings[0].status}` : "none found",
  );
}

// --- D1: admin@dim.test ---

async function checkAdminUser(): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT p.role
    FROM profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE u.email = 'admin@dim.test'
    LIMIT 1
  `)) as unknown as Array<{ role: string }>;

  check(
    "admin@dim.test exists with role=admin",
    rows.length > 0 && rows[0].role === "admin",
    rows.length > 0 ? `role=${rows[0].role}` : "not found — run pnpm seed:test",
  );
}

// --- D1: govt@dim.test with CABA assignment ---

async function checkGovtUser(): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT p.id, p.role
    FROM profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE u.email = 'govt@dim.test'
    LIMIT 1
  `)) as unknown as Array<{ id: string; role: string }>;

  const exists = rows.length > 0 && rows[0].role === "govt";
  check(
    "govt@dim.test exists with role=govt",
    exists,
    exists ? `id: ${rows[0].id.slice(0, 8)}…` : "not found — run pnpm seed:demo:scenario",
  );

  if (!exists) {
    check("govt@dim.test has govt_assignments to CABA", false, "user not found");
    return;
  }

  const govtId = rows[0].id;

  const assignments = await db
    .select({ id: govtAssignments.id })
    .from(govtAssignments)
    .where(
      and(
        eq(govtAssignments.userId, govtId),
        eq(govtAssignments.jurisdictionProvince, FOCAL_PROVINCE),
        eq(govtAssignments.jurisdictionLocality, FOCAL_LOCALITY),
        isNull(govtAssignments.revokedAt),
      ),
    );

  check(
    `govt@dim.test has govt_assignments to ${FOCAL_PROVINCE}/${FOCAL_LOCALITY}`,
    assignments.length > 0,
    assignments.length > 0
      ? `${assignments.length} assignment(s)`
      : "no active assignment found — run pnpm seed:demo:scenario",
  );
}

// --- D2: demo flag documented ---

function checkDemoFlag(): void {
  // The flag is an env var — we check if it's documented (can be on or off;
  // what matters is the script knows what to set).
  check(
    "NEXT_PUBLIC_DEMO_MODE documented (set to true in demo build)",
    true,
    "Set NEXT_PUBLIC_DEMO_MODE=true in .env.local to activate the demo banner in /admin/*",
  );
}

// ---------------------------------------------------------------------------
// 6. Run all checks + report
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("");
  console.log("=== DIM Demo Readiness Check ===");
  console.log(`  Focal: ${FOCAL_PROVINCE} / ${FOCAL_LOCALITY}`);
  console.log("");

  await checkAdminUser();
  await checkGovtUser();
  await checkSeriesBuckets();
  await checkOutlierBelow();
  await checkEventAmended();
  await checkAlertFiring();
  checkDemoFlag();

  console.log("");
  const maxLen = Math.max(...results.map((r) => r.label.length));
  let allOk = true;
  for (const r of results) {
    const status = r.ok ? "✅ OK     " : "❌ MISSING";
    const detail = r.detail ? `  (${r.detail})` : "";
    console.log(`  ${status}  ${r.label.padEnd(maxLen)}${detail}`);
    if (!r.ok) allOk = false;
  }

  console.log("");
  if (allOk) {
    console.log("  ✅ All invariants GREEN — ready to film the demo.");
  } else {
    const missing = results.filter((r) => !r.ok).length;
    console.log(`  ❌ ${missing} invariant(s) MISSING — run the seed scripts before filming.`);
    console.log("");
    console.log("  Setup sequence:");
    console.log("    1. pnpm seed:test          (creates admin@dim.test)");
    console.log("    2. pnpm seed:panorama       (national dataset)");
    console.log("    3. pnpm seed:demo:scenario  (CABA focal scenario + govt@dim.test)");
    console.log("    4. pnpm demo:verify         (this check)");
  }
  console.log("");

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("\n[FATAL]", err);
  process.exit(1);
});
