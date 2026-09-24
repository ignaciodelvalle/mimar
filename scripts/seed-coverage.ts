/**
 * DIM Feature-Coverage Seed — seed-coverage.ts
 *
 * Populates every feature table that the other seeds leave empty so that each
 * has ≥1 row available for testing and development.
 *
 * ─── TABLES COVERED ────────────────────────────────────────────────────────
 *   welfare_reports              welfare_report_attachments
 *   service_offerings            service_schedule_rules
 *   time_slots                   appointments
 *   foster_volunteers            foster_proposals
 *   pet_transfers                organization_invitations
 *   organization_capability_grants  org_contact_messages
 *   govt_business_rules          case_events
 *   custody_dispute_parties      libreta_share_tokens
 *
 * ─── PREREQUISITES ─────────────────────────────────────────────────────────
 *   seed-test (users + "Refugio Test" org) and seed-perf (PERF-* pets including
 *   PERF-STATE-custody-dispute, PERF-STATE-status-lost cases) must have run
 *   first. Missing prerequisites are WARN-logged; that table is skipped.
 *
 * ─── TAGGING + IDEMPOTENCY ─────────────────────────────────────────────────
 *   Rows are tagged with the string "PERF-COV" wherever a free-text field
 *   exists (titles, messages, notes, names). For tables without a text tag,
 *   cleanup keys off the tie to PERF-* pets / the seed org. Stable keys
 *   (publicToken, invitationToken, shareToken) are deterministic so re-runs
 *   skip already-existing rows.
 *
 * ─── CLI FLAGS ──────────────────────────────────────────────────────────────
 *   --allow-remote   Required to target a non-local DB (staging).
 *   --clean          Delete everything this script created (FK-safe order).
 *   --dry-run        Print plan and exit without writing.
 *
 * ─── LOCAL-ONLY GUARD ───────────────────────────────────────────────────────
 *   Refuses to run against a non-local DATABASE_URL host unless --allow-remote
 *   is passed. ALWAYS refuses when NODE_ENV=production.
 *
 * ─── RUN COMMANDS ───────────────────────────────────────────────────────────
 *   pnpm seed:coverage
 *   pnpm seed:coverage -- --clean
 *   pnpm seed:coverage -- --allow-remote          # staging opt-in
 *   pnpm seed:coverage -- --dry-run
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap (must run before db/index.ts is imported)
// ---------------------------------------------------------------------------

import { config as loadEnv } from "dotenv";

import { assertNotSplitEnv } from "./_env-target";
import { pickWelfareDescriptionDeterministic } from "./welfare-description-templates";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// 2. Parse CLI flags early (some drive the safety guard below)
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const ALLOW_REMOTE = argv.includes("--allow-remote");
const CLEAN = argv.includes("--clean");
const DRY_RUN = argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// 3. Safety guards
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
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — aborting.");
    process.exit(2);
  }
  if (!DATABASE_URL) {
    console.error("Missing DATABASE_URL — aborting.");
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
assertNotSplitEnv(SUPABASE_URL, DATABASE_URL, "seed:coverage");

const isLocalDb = dbHost ? LOCAL_HOSTS.has(dbHost) : true;
const isLocalSupabase =
  !SUPABASE_URL || SUPABASE_URL.includes("127.0.0.1") || SUPABASE_URL.includes("localhost");

if (!ALLOW_REMOTE && (!isLocalDb || !isLocalSupabase)) {
  console.error(
    [
      "",
      "==============================================================",
      "  ABORT: seed-coverage target is NOT a local Postgres / Supabase.",
      "==============================================================",
      `  DATABASE_URL host : ${dbHost ?? "(not set)"}`,
      `  SUPABASE_URL      : ${SUPABASE_URL}`,
      "",
      "  Re-run with --allow-remote to target this host intentionally.",
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
      "  About to write coverage data to a REMOTE database.",
      "==============================================================",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 4. Deferred imports (after env is populated)
// ---------------------------------------------------------------------------

const { createClient: createSdkClient } = await import("@supabase/supabase-js");
const { eq, like, or, sql, inArray } = await import("drizzle-orm");
const {
  db,
  pets,
  ownerships,
  organizations,
  organizationMemberships,
  organizationCapabilityGrants,
  organizationInvitations,
  orgContactMessages,
  cases: casesTable,
  custodyDisputes,
  custodyDisputeParties,
  welfareReports,
  welfareReportAttachments,
  libretaShareTokens,
  govtAssignments,
  govtBusinessRules,
  fosterVolunteers,
  fosterProposals,
  petTransfers,
  serviceOfferings,
  serviceScheduleRules,
  timeSlots,
  appointments,
  caseEvents,
} = await import("../db");

// ---------------------------------------------------------------------------
// 5. Helpers
// ---------------------------------------------------------------------------

const COV_TAG = "PERF-COV";

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "FAIL";
function log(tag: LogTag, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${tag.padEnd(4)}] ${msg}`);
}

// Minimal valid 1x1 PNG — a placeholder evidence object so the welfare-evidence
// signed URL actually resolves in demo data. Cowork M3: the attachment ROW was
// seeded but no object was ever uploaded to the bucket, so `createSignedUrl`
// failed and the moderation UI showed "(no disponible)".
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// Upload a placeholder evidence object for a welfare report and return its
// canonical storage path. The path is `${reportId}/<name>` with NO bucket
// prefix — matching lib/infra/welfare-uploads.ts. Deterministic path + upsert,
// so re-running the seed is idempotent and never orphans objects.
async function uploadWelfarePlaceholder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  reportId: string,
): Promise<string> {
  const storagePath = `${reportId}/evidencia-demo.png`;
  const { error } = await supabase.storage
    .from("welfare-evidence")
    .upload(storagePath, PLACEHOLDER_PNG, { contentType: "image/png", upsert: true });
  if (error) log("WARN", `  welfare placeholder upload failed: ${error.message}`);
  return storagePath;
}

// ---------------------------------------------------------------------------
// 6. Lookup helpers — find seeded prerequisite entities
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findAuthUserIdByEmail(supabase: any, email: string): Promise<string | null> {
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers page ${page}: ${error.message}`);
    const users = data.users as Array<{ email: string; id: string }>;
    const hit = users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (users.length < 200) return null;
    page++;
  }
}

async function findSeedOrgId(): Promise<string | null> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.cuit, "30999999999"))
    .limit(1);
  return org?.id ?? null;
}

async function findPerfPetByToken(
  publicToken: string,
): Promise<{ id: string; name: string } | null> {
  const [pet] = await db
    .select({ id: pets.id, name: pets.name })
    .from(pets)
    .where(eq(pets.publicToken, publicToken))
    .limit(1);
  return pet ?? null;
}

/** Find any PERF-* pet (not PERF-STATE) for use as generic FK target */
async function findAnyPerfPet(): Promise<{ id: string } | null> {
  const [pet] = await db
    .select({ id: pets.id })
    .from(pets)
    .where(like(pets.name, "PERF-0%"))
    .limit(1);
  return pet ?? null;
}

async function findOrgMembershipId(orgId: string, userId: string): Promise<string | null> {
  const [m] = await db
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.organizationId, orgId))
    .limit(1);
  return m?.id ?? null;
}

async function findGovtUserId(): Promise<string | null> {
  const [row] = await db.select({ userId: govtAssignments.userId }).from(govtAssignments).limit(1);
  return row?.userId ?? null;
}

async function findLostPerfCaseId(): Promise<string | null> {
  const [row] = await db
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(eq(casesTable.publicCode, "PERF-STATE-CASE-LOST"))
    .limit(1);
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// 7. --clean: delete coverage rows in FK-safe order
// ---------------------------------------------------------------------------

async function runClean(): Promise<void> {
  log("STEP", "--clean: removing all PERF-COV coverage rows");

  // Find the seed org
  const seedOrgId = await findSeedOrgId();

  // Find PERF pets (for FK-keyed tables)
  const perfPetRows = await db.select({ id: pets.id }).from(pets).where(like(pets.name, "PERF-%"));
  const perfPetIds = perfPetRows.map((p) => p.id);

  // Deletion order: most-dependent tables first (FK-safe)

  // appointments → time_slots → service_schedule_rules → service_offerings
  // (appointments has ON DELETE CASCADE from slots via RESTRICT — delete appointments first)
  const covSlots = await db
    .select({ id: timeSlots.id })
    .from(timeSlots)
    // time_slots don't have a text tag — key off the service_offerings
    // We'll delete by joining through service_offerings with COV_TAG in displayName
    .where(
      sql`${timeSlots.serviceOfferingId} IN (
        SELECT id FROM service_offerings WHERE display_name LIKE ${`%${COV_TAG}%`}
      )`,
    );
  if (covSlots.length > 0) {
    const slotIds = covSlots.map((s) => s.id);
    await db.delete(appointments).where(inArray(appointments.slotId, slotIds));
    log("OK", `  Deleted appointments tied to ${COV_TAG} slots`);
    await db.delete(timeSlots).where(inArray(timeSlots.id, slotIds));
    log("OK", `  Deleted ${covSlots.length} ${COV_TAG} time_slots`);
  }
  await db.delete(serviceScheduleRules).where(
    sql`${serviceScheduleRules.serviceOfferingId} IN (
        SELECT id FROM service_offerings WHERE display_name LIKE ${`%${COV_TAG}%`}
      )`,
  );
  await db.delete(serviceOfferings).where(like(serviceOfferings.displayName, `%${COV_TAG}%`));
  log("OK", "  Deleted service_offerings + schedule_rules (CASCADE cleans up via SK)");

  // foster_proposals (CASCADE removes via org FK)
  await db.delete(fosterProposals).where(like(fosterProposals.proposedNotes, `%${COV_TAG}%`));
  log("OK", "  Deleted foster_proposals");

  // foster_volunteers: tied to owner user — delete by notes tag
  await db.delete(fosterVolunteers).where(like(fosterVolunteers.notes, `%${COV_TAG}%`));
  log("OK", "  Deleted foster_volunteers");

  // pet_transfers
  await db.delete(petTransfers).where(like(petTransfers.publicToken, `${COV_TAG}-%`));
  log("OK", "  Deleted pet_transfers");

  // organization_invitations
  await db
    .delete(organizationInvitations)
    .where(like(organizationInvitations.invitationToken, `${COV_TAG}-%`));
  log("OK", "  Deleted organization_invitations");

  // organization_capability_grants: key off requestedReason
  await db
    .delete(organizationCapabilityGrants)
    .where(like(organizationCapabilityGrants.requestedReason, `%${COV_TAG}%`));
  log("OK", "  Deleted organization_capability_grants");

  // org_contact_messages
  if (seedOrgId) {
    await db.delete(orgContactMessages).where(like(orgContactMessages.message, `%${COV_TAG}%`));
    log("OK", "  Deleted org_contact_messages");
  }

  // govt_business_rules
  await db.delete(govtBusinessRules).where(like(govtBusinessRules.notes, `%${COV_TAG}%`));
  log("OK", "  Deleted govt_business_rules");

  // case_events
  await db.delete(caseEvents).where(like(caseEvents.notes, `%${COV_TAG}%`));
  log("OK", "  Deleted case_events");

  // custody_dispute_parties
  await db
    .delete(custodyDisputeParties)
    .where(like(custodyDisputeParties.partyPositionSummary, `%${COV_TAG}%`));
  log("OK", "  Deleted custody_dispute_parties");

  // libreta_share_tokens
  await db.delete(libretaShareTokens).where(like(libretaShareTokens.shareToken, `${COV_TAG}-%`));
  log("OK", "  Deleted libreta_share_tokens");

  // welfare_report_attachments + welfare_reports
  // Matched by referenceCode (all COV rows are "${COV_TAG}-DEN-*") rather than
  // description — the k-anon coverage rows (DEN-0002..0005) use realistic
  // prose with no seed tag in `description` per the seed-hygiene gate, so
  // description-based matching alone would miss them and leak on --clean.
  await db.delete(welfareReportAttachments).where(
    sql`${welfareReportAttachments.welfareReportId} IN (
        SELECT id FROM welfare_reports
        WHERE reference_code LIKE ${`${COV_TAG}-%`} OR description LIKE ${`%${COV_TAG}%`}
      )`,
  );
  await db
    .delete(welfareReports)
    .where(
      or(
        like(welfareReports.referenceCode, `${COV_TAG}-%`),
        like(welfareReports.description, `%${COV_TAG}%`),
      ),
    );
  log("OK", "  Deleted welfare_reports + welfare_report_attachments");

  log("DONE", "Clean complete");
}

// ---------------------------------------------------------------------------
// 8. Main seed run
// ---------------------------------------------------------------------------

async function runSeed(): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — aborting.");
    process.exit(2);
  }

  const supabase = createSdkClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Resolve prerequisite entities ─────────────────────────────────────────

  log("STEP", "Resolving prerequisite entities");

  const ownerUserId = await findAuthUserIdByEmail(supabase, "owner@dim.test");
  if (!ownerUserId) {
    log("FAIL", "owner@dim.test not found — run pnpm seed:test first");
    process.exit(1);
  }
  log("INFO", `  owner@dim.test id: ${ownerUserId.slice(0, 8)}…`);

  const orgAdminUserId = await findAuthUserIdByEmail(supabase, "orgadmin@dim.test");
  log("INFO", `  orgadmin@dim.test id: ${orgAdminUserId?.slice(0, 8) ?? "NOT FOUND"}…`);

  const seedOrgId = await findSeedOrgId();
  if (!seedOrgId) {
    log("WARN", "Refugio Test org (cuit=30999999999) not found — run pnpm seed:test first");
  } else {
    log("INFO", `  Refugio Test org id: ${seedOrgId.slice(0, 8)}…`);
  }

  const custodyPet = await findPerfPetByToken("PERF-STATE-custody-dispute");
  if (!custodyPet) {
    log("WARN", "PERF-STATE-custody-dispute pet not found — run seed-perf first");
  } else {
    log("INFO", `  Custody pet: ${custodyPet.name} (${custodyPet.id.slice(0, 8)}…)`);
  }

  const lostCaseId = await findLostPerfCaseId();
  if (!lostCaseId) {
    log("WARN", "PERF-STATE-CASE-LOST case not found — run seed-perf first");
  } else {
    log("INFO", `  Lost case id: ${lostCaseId.slice(0, 8)}…`);
  }

  // Find any PERF-STATE pet for generic FK use (foster proposal needs a pet)
  const statePet = await findPerfPetByToken("PERF-STATE-status-active");
  const genericPet = statePet ?? (await findAnyPerfPet());
  if (!genericPet) {
    log("WARN", "No PERF-* pets found — some tables will be skipped");
  } else {
    log("INFO", `  Generic PERF pet: ${genericPet.id.slice(0, 8)}…`);
  }

  const govtUserId = await findGovtUserId();
  if (!govtUserId) {
    log("WARN", "No govt user found — govt_business_rules will use owner");
  }
  const ruleAuthorId = govtUserId ?? ownerUserId;

  // ── 1. welfare_reports ────────────────────────────────────────────────────
  log("STEP", "1/16 welfare_reports");
  {
    const REF_CODE = `${COV_TAG}-DEN-0001`;
    const [existing] = await db
      .select({ id: welfareReports.id })
      .from(welfareReports)
      .where(eq(welfareReports.referenceCode, REF_CODE))
      .limit(1);

    if (existing) {
      log("SKIP", "  welfare_report already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert welfare_report");
    } else {
      const [row] = await db
        .insert(welfareReports)
        .values({
          referenceCode: REF_CODE,
          reporterUserId: ownerUserId,
          reporterContactEmail: "owner@dim.test",
          kind: "neglect",
          severity: "medium",
          description: `${COV_TAG} — cobertura de prueba: descuido de animal`,
          subjectKind: "unowned_animal",
          subjectDescription: "Perro callejero sin atención visible",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Palermo",
          status: "open",
        })
        .returning({ id: welfareReports.id });
      log("OK", `  Inserted welfare_report id=${row.id.slice(0, 8)}…`);

      // ── 2. welfare_report_attachments ──────────────────────────────────
      log("STEP", "2/16 welfare_report_attachments");
      const attachmentPath = await uploadWelfarePlaceholder(supabase, row.id);
      await db.insert(welfareReportAttachments).values({
        welfareReportId: row.id,
        uploadedByUserId: ownerUserId,
        storagePath: attachmentPath,
        mimeType: "image/png",
        fileSize: PLACEHOLDER_PNG.length,
        originalFilename: "evidencia-demo.png",
      });
      log("OK", "  Inserted welfare_report_attachment");
    }
  }

  // ── 1b. welfare_reports — k-anon coverage (≥5 in Palermo, CABA) ───────────
  // Demo maps suppress any cell with <5 reports (k-anonymity). DEN-0001 alone
  // trips that suppression on the Palermo/CABA cell — add 4 more so the cell
  // clears k=5 and renders on /gob and /panorama demo maps.
  log("STEP", "1b/16 welfare_reports (k-anon coverage, DEN-0002..0005)");
  {
    const KANON_COVERAGE_REPORTS = [
      {
        suffix: "0002",
        kind: "abandonment" as const,
        severity: "high" as const,
        subjectDescription: "Perro atado en la puerta de un local cerrado, sin agua ni sombra",
      },
      {
        suffix: "0003",
        kind: "physical_abuse" as const,
        severity: "critical" as const,
        subjectDescription: "Perro con heridas visibles, cojea al caminar",
      },
      {
        suffix: "0004",
        kind: "chained" as const,
        severity: "medium" as const,
        subjectDescription: "Perro encadenado en el fondo de una vivienda, sin refugio",
      },
      {
        suffix: "0005",
        kind: "hoarding" as const,
        severity: "medium" as const,
        subjectDescription: "Varios animales en mal estado en el mismo departamento",
      },
    ];

    for (const entry of KANON_COVERAGE_REPORTS) {
      const REF_CODE = `${COV_TAG}-DEN-${entry.suffix}`;
      const [existing] = await db
        .select({ id: welfareReports.id })
        .from(welfareReports)
        .where(eq(welfareReports.referenceCode, REF_CODE))
        .limit(1);

      if (existing) {
        log("SKIP", `  welfare_report ${REF_CODE} already exists`);
      } else if (DRY_RUN) {
        log("INFO", `  [dry-run] would insert welfare_report ${REF_CODE}`);
      } else {
        const [row] = await db
          .insert(welfareReports)
          .values({
            referenceCode: REF_CODE,
            reporterUserId: ownerUserId,
            reporterContactEmail: "owner@dim.test",
            kind: entry.kind,
            severity: entry.severity,
            description: pickWelfareDescriptionDeterministic(entry.kind, REF_CODE),
            subjectKind: "unowned_animal",
            subjectDescription: entry.subjectDescription,
            jurisdictionProvince: "CABA",
            jurisdictionLocality: "Palermo",
            status: "open",
            seedTag: COV_TAG,
          })
          .returning({ id: welfareReports.id });
        log("OK", `  Inserted welfare_report ${REF_CODE} id=${row.id.slice(0, 8)}…`);
      }
    }
  }

  // ── 2 (already handled above if welfare_report was new) ──────────────────
  {
    // Guard: if welfare_report existed from a previous run, check if attachment exists
    const [report] = await db
      .select({ id: welfareReports.id })
      .from(welfareReports)
      .where(eq(welfareReports.referenceCode, `${COV_TAG}-DEN-0001`))
      .limit(1);
    if (report) {
      const [existingAtt] = await db
        .select({ id: welfareReportAttachments.id })
        .from(welfareReportAttachments)
        .where(eq(welfareReportAttachments.welfareReportId, report.id))
        .limit(1);
      if (!existingAtt && !DRY_RUN) {
        log("STEP", "2/16 welfare_report_attachments (standalone)");
        const attachmentPath = await uploadWelfarePlaceholder(supabase, report.id);
        await db.insert(welfareReportAttachments).values({
          welfareReportId: report.id,
          uploadedByUserId: ownerUserId,
          storagePath: attachmentPath,
          mimeType: "image/png",
          fileSize: PLACEHOLDER_PNG.length,
          originalFilename: "evidencia-demo.png",
        });
        log("OK", "  Inserted welfare_report_attachment (idempotency pass)");
      } else if (existingAtt) {
        log("SKIP", "  welfare_report_attachment already exists");
      }
    }
  }

  // ── 3. service_offerings ──────────────────────────────────────────────────
  log("STEP", "3/16 service_offerings");
  let serviceOfferingId: string | null = null;
  if (!seedOrgId) {
    log("WARN", "  SKIP — no seed org available");
  } else {
    const SVO_TOKEN = `${COV_TAG}-SVO-0001`;
    const [existing] = await db
      .select({ id: serviceOfferings.id })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, SVO_TOKEN))
      .limit(1);

    if (existing) {
      serviceOfferingId = existing.id;
      log("SKIP", "  service_offering already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert service_offering");
    } else {
      const [row] = await db
        .insert(serviceOfferings)
        .values({
          publicToken: SVO_TOKEN,
          organizationId: seedOrgId,
          jurisdictionCountry: "AR",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Palermo",
          serviceKind: "sterilization_dog_male", // catalog code (lib/reference/service-kinds.ts)
          displayName: `${COV_TAG} — Campaña de castración gratuita`,
          description: "Servicio de cobertura de prueba para testing",
          durationMinutes: 60,
          slotCapacity: 5,
          status: "approved",
          isPublic: false,
        })
        .returning({ id: serviceOfferings.id });
      serviceOfferingId = row.id;
      log("OK", `  Inserted service_offering id=${row.id.slice(0, 8)}…`);
    }
  }

  // ── 4. service_schedule_rules ─────────────────────────────────────────────
  log("STEP", "4/16 service_schedule_rules");
  let scheduleRuleId: string | null = null;
  if (!serviceOfferingId) {
    log("WARN", "  SKIP — no service_offering available");
  } else {
    const [existing] = await db
      .select({ id: serviceScheduleRules.id })
      .from(serviceScheduleRules)
      .where(eq(serviceScheduleRules.serviceOfferingId, serviceOfferingId))
      .limit(1);

    if (existing) {
      scheduleRuleId = existing.id;
      log("SKIP", "  service_schedule_rule already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert service_schedule_rule");
    } else {
      const [row] = await db
        .insert(serviceScheduleRules)
        .values({
          serviceOfferingId,
          daysOfWeek: [1, 3, 5], // Mon, Wed, Fri (ISO 8601)
          startTimeLocal: "09:00:00",
          endTimeLocal: "17:00:00",
          effectiveFrom: "2026-07-01",
          effectiveUntil: "2026-12-31",
          timezone: "America/Argentina/Buenos_Aires",
          status: "active",
        })
        .returning({ id: serviceScheduleRules.id });
      scheduleRuleId = row.id;
      log("OK", `  Inserted service_schedule_rule id=${row.id.slice(0, 8)}…`);
    }
  }

  // ── 5. time_slots ─────────────────────────────────────────────────────────
  log("STEP", "5/16 time_slots");
  let slotId: string | null = null;
  if (!serviceOfferingId) {
    log("WARN", "  SKIP — no service_offering available");
  } else {
    const [existing] = await db
      .select({ id: timeSlots.id })
      .from(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, serviceOfferingId))
      .limit(1);

    if (existing) {
      slotId = existing.id;
      log("SKIP", "  time_slot already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert time_slot");
    } else {
      const startsAt = new Date("2026-07-07T09:00:00-03:00");
      const endsAt = new Date("2026-07-07T10:00:00-03:00");
      const [row] = await db
        .insert(timeSlots)
        .values({
          serviceOfferingId,
          ruleId: scheduleRuleId,
          startsAt,
          endsAt,
          capacity: 5,
          bookingsCount: 0,
          status: "open",
        })
        .returning({ id: timeSlots.id });
      slotId = row.id;
      log("OK", `  Inserted time_slot id=${row.id.slice(0, 8)}…`);
    }
  }

  // ── 6. appointments ───────────────────────────────────────────────────────
  log("STEP", "6/16 appointments");
  if (!slotId || !genericPet || !serviceOfferingId || !seedOrgId) {
    log("WARN", "  SKIP — missing slot, pet, offering, or org");
  } else {
    const APT_TOKEN = `${COV_TAG}-APT-0001`;
    const [existing] = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.publicToken, APT_TOKEN))
      .limit(1);

    if (existing) {
      log("SKIP", "  appointment already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert appointment");
    } else {
      const [row] = await db
        .insert(appointments)
        .values({
          publicToken: APT_TOKEN,
          slotId,
          petId: genericPet.id,
          ownerUserId,
          serviceOfferingId,
          organizationId: seedOrgId,
          status: "confirmed",
        })
        .returning({ id: appointments.id });
      log("OK", `  Inserted appointment id=${row.id.slice(0, 8)}…`);
    }
  }

  // ── 7. foster_volunteers ──────────────────────────────────────────────────
  log("STEP", "7/16 foster_volunteers");
  {
    const [existing] = await db
      .select({ id: fosterVolunteers.id })
      .from(fosterVolunteers)
      .where(eq(fosterVolunteers.userId, ownerUserId))
      .limit(1);

    if (existing) {
      log("SKIP", "  foster_volunteer already exists for owner");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert foster_volunteer");
    } else {
      const [row] = await db
        .insert(fosterVolunteers)
        .values({
          userId: ownerUserId,
          status: "active",
          availableSlots: 2,
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Palermo",
          acceptsDogs: true,
          acceptsCats: true,
          acceptsOtherSpecies: false,
          acceptsSizeSmall: true,
          acceptsSizeMedium: true,
          acceptsSizeLarge: false,
          acceptsPuppies: false,
          acceptsSeniors: true,
          acceptsChronicConditions: false,
          acceptsDangerousBreeds: false,
          maxDurationWeeks: 4,
          householdOtherPets: false,
          householdKids: false,
          notes: `${COV_TAG} — voluntario tránsito de cobertura`,
        })
        .returning({ id: fosterVolunteers.id });
      log("OK", `  Inserted foster_volunteer id=${row.id.slice(0, 8)}…`);
    }
  }

  // ── 8. foster_proposals ───────────────────────────────────────────────────
  log("STEP", "8/16 foster_proposals");
  if (!seedOrgId || !genericPet) {
    log("WARN", "  SKIP — no seed org or pet available");
  } else {
    const FP_TOKEN = `${COV_TAG}-FP-0001`;
    const [existing] = await db
      .select({ id: fosterProposals.id })
      .from(fosterProposals)
      .where(eq(fosterProposals.publicToken, FP_TOKEN))
      .limit(1);

    if (existing) {
      log("SKIP", "  foster_proposal already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert foster_proposal");
    } else {
      // fosterProposals.response_consistent CHECK requires:
      // status='pending' → respondedAt IS NULL AND cancelledAt IS NULL
      const expiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000);
      const [row] = await db
        .insert(fosterProposals)
        .values({
          publicToken: FP_TOKEN,
          organizationId: seedOrgId,
          volunteerUserId: ownerUserId,
          petId: genericPet.id,
          proposedByUserId: orgAdminUserId ?? ownerUserId,
          proposedDurationWeeks: 4,
          proposedNotes: `${COV_TAG} — propuesta tránsito de cobertura`,
          matchWarnings: [],
          expiresAt,
          status: "pending",
        })
        .returning({ id: fosterProposals.id });
      log("OK", `  Inserted foster_proposal id=${row.id.slice(0, 8)}…`);
    }
  }

  // ── 9. pet_transfers ──────────────────────────────────────────────────────
  log("STEP", "9/16 pet_transfers");
  if (!genericPet) {
    log("WARN", "  SKIP — no PERF pet available");
  } else {
    const PT_TOKEN = `${COV_TAG}-PT-0001`;
    const [existing] = await db
      .select({ id: petTransfers.id })
      .from(petTransfers)
      .where(eq(petTransfers.publicToken, PT_TOKEN))
      .limit(1);

    if (existing) {
      log("SKIP", "  pet_transfer already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert pet_transfer");
    } else {
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      const [row] = await db
        .insert(petTransfers)
        .values({
          publicToken: PT_TOKEN,
          petId: genericPet.id,
          fromOwnerId: ownerUserId,
          toOwnerEmail: "orgadmin@dim.test",
          status: "pending",
          reason: "gift",
          note: `${COV_TAG} — transferencia de cobertura`,
          expiresAt,
        })
        .returning({ id: petTransfers.id });
      log("OK", `  Inserted pet_transfer id=${row.id.slice(0, 8)}…`);
    }
  }

  // ── 10. organization_invitations ──────────────────────────────────────────
  log("STEP", "10/16 organization_invitations");
  if (!seedOrgId) {
    log("WARN", "  SKIP — no seed org available");
  } else {
    const INV_TOKEN = `${COV_TAG}-INV-0001`;
    const INV_EMAIL = "coverage-invitee@dim.test";
    const [existing] = await db
      .select({ id: organizationInvitations.id })
      .from(organizationInvitations)
      .where(eq(organizationInvitations.invitationToken, INV_TOKEN))
      .limit(1);

    if (existing) {
      log("SKIP", "  organization_invitation already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert organization_invitation");
    } else {
      const [row] = await db
        .insert(organizationInvitations)
        .values({
          organizationId: seedOrgId,
          email: INV_EMAIL,
          invitedRole: "member",
          canWritePetEvents: false,
          invitedByUserId: orgAdminUserId ?? ownerUserId,
          invitationToken: INV_TOKEN,
          // expiresAt defaults to now() + 14 days
        })
        .returning({ id: organizationInvitations.id });
      log("OK", `  Inserted organization_invitation id=${row.id.slice(0, 8)}…`);
    }
  }

  // ── 11. organization_capability_grants ────────────────────────────────────
  log("STEP", "11/16 organization_capability_grants");
  if (!seedOrgId) {
    log("WARN", "  SKIP — no seed org available");
  } else {
    // Find a non-admin membership to grant a capability to
    const [membership] = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, seedOrgId))
      .limit(1);

    if (!membership) {
      log("WARN", "  SKIP — no membership found in seed org");
    } else {
      // Check for existing grant with COV_TAG in reason
      const [existing] = await db
        .select({ id: organizationCapabilityGrants.id })
        .from(organizationCapabilityGrants)
        .where(
          sql`${organizationCapabilityGrants.membershipId} = ${membership.id}
              AND ${organizationCapabilityGrants.capability} = ${"event.write"}`,
        )
        .limit(1);

      if (existing) {
        log("SKIP", "  organization_capability_grant already exists");
      } else if (DRY_RUN) {
        log("INFO", "  [dry-run] would insert organization_capability_grant");
      } else {
        const [row] = await db
          .insert(organizationCapabilityGrants)
          .values({
            membershipId: membership.id,
            organizationId: seedOrgId,
            capability: "event.write",
            status: "approved",
            requestedReason: `${COV_TAG} — grant de cobertura para testing`,
            decidedAt: new Date(),
            decidedByUserId: orgAdminUserId ?? ownerUserId,
            decisionReason: `${COV_TAG} — aprobado automáticamente por seed-coverage`,
          })
          .returning({ id: organizationCapabilityGrants.id });
        log("OK", `  Inserted organization_capability_grant id=${row.id.slice(0, 8)}…`);
      }
    }
  }

  // ── 12. org_contact_messages ──────────────────────────────────────────────
  log("STEP", "12/16 org_contact_messages");
  if (!seedOrgId) {
    log("WARN", "  SKIP — no seed org available");
  } else {
    const [existing] = await db
      .select({ id: orgContactMessages.id })
      .from(orgContactMessages)
      .where(
        sql`${orgContactMessages.organizationId} = ${seedOrgId}
            AND ${orgContactMessages.message} LIKE ${`%${COV_TAG}%`}`,
      )
      .limit(1);

    if (existing) {
      log("SKIP", "  org_contact_message already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert org_contact_message");
    } else {
      const [row] = await db
        .insert(orgContactMessages)
        .values({
          organizationId: seedOrgId,
          kind: "contact",
          inquirerName: "Cobertura Test",
          inquirerEmail: "coverage@dim.test",
          message: `${COV_TAG} — mensaje de contacto generado por seed-coverage para testing`,
          submitterIp: "127.0.0.1",
        })
        .returning({ id: orgContactMessages.id });
      log("OK", `  Inserted org_contact_message id=${row.id.slice(0, 8)}…`);
    }
  }

  // ── 13. govt_business_rules ───────────────────────────────────────────────
  log("STEP", "13/16 govt_business_rules");
  {
    const [existing] = await db
      .select({ id: govtBusinessRules.id })
      .from(govtBusinessRules)
      .where(sql`${govtBusinessRules.notes} LIKE ${`%${COV_TAG}%`}`)
      .limit(1);

    if (existing) {
      log("SKIP", "  govt_business_rule already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert govt_business_rule");
    } else {
      const [row] = await db
        .insert(govtBusinessRules)
        .values({
          jurisdictionCountry: "AR",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Palermo",
          ruleType: "ppp_breed_list",
          rulePayload: {
            breeds: ["Dogo Argentino", "Pit Bull", "Rottweiler"],
            source: COV_TAG,
          },
          notes: `${COV_TAG} — regla de negocio de cobertura para testing`,
          createdByUserId: ruleAuthorId,
          updatedByUserId: ruleAuthorId,
        })
        .returning({ id: govtBusinessRules.id });
      log("OK", `  Inserted govt_business_rule id=${row.id.slice(0, 8)}…`);
    }
  }

  // ── 14. case_events ───────────────────────────────────────────────────────
  log("STEP", "14/16 case_events");
  if (!lostCaseId) {
    log("WARN", "  SKIP — no PERF-STATE-CASE-LOST case found");
  } else {
    const [existing] = await db
      .select({ id: caseEvents.id })
      .from(caseEvents)
      .where(
        sql`${caseEvents.caseId} = ${lostCaseId}
            AND ${caseEvents.notes} LIKE ${`%${COV_TAG}%`}`,
      )
      .limit(1);

    if (existing) {
      log("SKIP", "  case_event already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert case_event");
    } else {
      const [row] = await db
        .insert(caseEvents)
        .values({
          caseId: lostCaseId,
          entryType: "reporter_comment",
          payload: { text: `${COV_TAG} — comentario de cobertura`, source: "seed-coverage" },
          notes: `${COV_TAG} — evento de caso de cobertura para testing`,
          recordedByUserId: ownerUserId,
        })
        .returning({ id: caseEvents.id });
      log("OK", `  Inserted case_event id=${row.id.slice(0, 8)}…`);
    }
  }

  // ── 15. custody_dispute_parties ───────────────────────────────────────────
  log("STEP", "15/16 custody_dispute_parties");
  if (!custodyPet) {
    log("WARN", "  SKIP — PERF-STATE-custody-dispute pet not found");
  } else {
    // Find the custody_dispute for this pet
    const [dispute] = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.petId, custodyPet.id))
      .limit(1);

    if (!dispute) {
      log("WARN", "  SKIP — no custody_dispute row found for custody pet");
    } else {
      const [existing] = await db
        .select({ id: custodyDisputeParties.id })
        .from(custodyDisputeParties)
        .where(
          sql`${custodyDisputeParties.disputeId} = ${dispute.id}
              AND ${custodyDisputeParties.partyPositionSummary} LIKE ${`%${COV_TAG}%`}`,
        )
        .limit(1);

      if (existing) {
        log("SKIP", "  custody_dispute_parties already exist");
      } else if (DRY_RUN) {
        log("INFO", "  [dry-run] would insert custody_dispute_parties");
      } else {
        // Insert claimant (owner) party
        const [r1] = await db
          .insert(custodyDisputeParties)
          .values({
            disputeId: dispute.id,
            partyUserId: ownerUserId,
            partyRole: "claimant_owner",
            partyPositionSummary: `${COV_TAG} — parte reclamante (cobertura seed)`,
            addedByUserId: ownerUserId,
          })
          .returning({ id: custodyDisputeParties.id });
        log("OK", `  Inserted claimant party id=${r1.id.slice(0, 8)}…`);

        // Insert current_owner party (use orgadmin if available, otherwise use owner again
        // with different role — but exactly_one_subject CHECK needs party_user_id XOR org_id)
        // We'll use the org as the current_org_custody party to satisfy the XOR
        if (seedOrgId) {
          const [r2] = await db
            .insert(custodyDisputeParties)
            .values({
              disputeId: dispute.id,
              partyOrganizationId: seedOrgId,
              partyRole: "current_org_custody",
              partyPositionSummary: `${COV_TAG} — org en custodia (cobertura seed)`,
              addedByUserId: ownerUserId,
            })
            .returning({ id: custodyDisputeParties.id });
          log("OK", `  Inserted current_org_custody party id=${r2.id.slice(0, 8)}…`);
        }
      }
    }
  }

  // ── 16. libreta_share_tokens ──────────────────────────────────────────────
  log("STEP", "16/16 libreta_share_tokens");
  if (!genericPet) {
    log("WARN", "  SKIP — no PERF pet available");
  } else {
    const SHARE_TOKEN = `${COV_TAG}-SHARE-0001`;
    const [existing] = await db
      .select({ id: libretaShareTokens.id })
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.shareToken, SHARE_TOKEN))
      .limit(1);

    if (existing) {
      log("SKIP", "  libreta_share_token already exists");
    } else if (DRY_RUN) {
      log("INFO", "  [dry-run] would insert libreta_share_token");
    } else {
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
      const [row] = await db
        .insert(libretaShareTokens)
        .values({
          shareToken: SHARE_TOKEN,
          petId: genericPet.id,
          createdByUserId: ownerUserId,
          label: `${COV_TAG} — token compartir libreta`,
          expiresAt,
        })
        .returning({ id: libretaShareTokens.id });
      log("OK", `  Inserted libreta_share_token id=${row.id.slice(0, 8)}…`);
    }
  }

  log("DONE", "seed-coverage complete");
}

// ---------------------------------------------------------------------------
// 9. Entry point
// ---------------------------------------------------------------------------

if (DRY_RUN) {
  log("INFO", "DRY-RUN mode — no writes will occur");
}

if (CLEAN) {
  await runClean();
} else {
  await runSeed();
}
