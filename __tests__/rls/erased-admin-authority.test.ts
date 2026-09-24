// RLS — an ERASED profile is not a platform administrator (migration 0215)
// and not a govt operator either (migration 0216).
//
// WHAT THIS DEFENDS
// -----------------
// `profiles` carries two lifecycle markers that mean different things: a
// deactivation sets `deactivated_at`; a Ley 25.326 art. 16 erasure
// (`erase_subject_data`) sets `deleted_at` and hashes every PII column. Every
// predicate that decided "is this caller a platform admin" tested
// `deactivated_at` — or nothing — and never `deleted_at`. An administrator who
// exercised their OWN erasure therefore kept administrative authority at the
// database layer: every admin-branch RLS policy still matched, `can_read_case`
// still returned true, and `pii.caller_is_admin` — the guard that lets a
// non-subject run export_subject_data / erase_subject_data on someone else —
// still said yes. The application layer bounces an erased SESSION off every
// page (requireLiveUser → ACCOUNT_ERASED), but a bearer token already issued
// keeps talking to PostgREST and to the RPCs directly until it expires.
//
// THE PROBE IS THE ATTACK. One ephemeral institutional admin, provisioned here
// through the admin SDK + the handle_new_user trigger and promoted over
// Drizzle (BYPASSRLS), signs in ONCE and keeps that session for the whole
// file. Three states, same token:
//   1. LIVE      — the control. Every read below must return the fixture row,
//                  and both functions must say true. Without this, a zero in
//                  state 2 would prove nothing (the matrix's anon row passed
//                  for months on exactly that vacuity — matrix.test.ts:704).
//   2. ERASED    — `deleted_at` set, `deactivated_at` still NULL, which is the
//                  state erase_subject_data leaves. Every read must return
//                  ZERO rows and both functions must say false.
//   3. RESTORED  — `deleted_at` cleared again. Everything comes back, which
//                  pins the refusal on the marker and not on the session.
//
// Four surfaces, chosen to cover both pre-0215 classes:
//   · cron_runs           policy that checked deactivated_at only
//   · audit_log           policy that checked NEITHER marker (actor NULL, so
//                         only the admin branch can serve the row)
//   · can_read_case       the function db/cases_rls.sql owns (:49)
//   · pii.caller_is_admin the subject-rights RPC guard
//
// THE GOVT TWIN (0216). The govt branches 0215 copied verbatim had the same
// hole, and it is narrower only in reach: deactivation revokes an operator's
// govt_assignments, erasure does not, so an erased govt kept a live token that
// still read every custody dispute, service-dog credential, chip/tattoo
// identification and approval request in its jurisdiction — and every case
// there through can_read_case. Same three states, one ephemeral govt with ONE
// assignment (Buenos Aires / La Plata) and fixtures placed in that
// jurisdiction, each built so the govt branch is the ONLY branch that can
// serve it (the govt is never owner, party or applicant). Two surfaces are
// probed in all three states:
//   · approval_requests        never read profiles — assignment alone
//   · can_read_case            govt branch, deactivated_at only
// The ERASED state also asserts the assignment is STILL unrevoked, so the
// refusal is pinned on the marker and not on a revocation nothing performed.
//
// FOUR SURFACES CANNOT BE PROBED, AND THE TEST SAYS SO (found 2026-09-09).
// A policy's subqueries run under the CALLER's row security, so a govt branch
// that reaches another table sees only what that table's own policies let a
// govt see. A control that cannot read in the LIVE state would make the
// ERASED refusal vacuous, so these are pinned on their cause, not asserted:
//   · pet_service_dog          checked deactivated_at only
//   · pet_identifications      checked deactivated_at only (0140 policy)
// Both govt branches go `FROM public.pets pt`, and pets has ONE select policy,
// "Pets readable by active owner" — no admin branch, no govt branch. For any
// caller who is not an active owner the subquery is empty before a marker is
// looked at, and any ownership that would reveal the pet also matches the
// owner branch of both policies, so no fixture can isolate the govt branch.
// Measured 2026-09-09 with the pre-0216 predicate restored on the local DB:
// still 0 rows — the branch has been dead through PostgREST since 0026/0140,
// 0216 did not narrow it. The app reads both tables over Drizzle (BYPASSRLS).
//   · custody_disputes         checked deactivated_at only
//   · custody_dispute_parties  checked NEITHER marker
// Both policies subquery organization_memberships in their party branch, and
// organization_memberships' own SELECT policy "Members can read peers in same
// org" (db/organizations_rls.sql, 0086/0137) is SELF-REFERENTIAL — so the
// rewriter raises `infinite recursion detected in policy for relation
// "organization_memberships"` for EVERY authenticated read of any of the three
// tables, before any row is looked at. Pre-existing, unrelated to 0216 (the
// party branches are byte-for-byte 0215's), invisible to the app (Drizzle,
// BYPASSRLS) and never probed by the RLS matrix.
// All four fixtures are still built here, and the LIVE block pins each CAUSE
// (no govt text in pets' select policies; the recursion error) rather than the
// zero it produces: the day a cause is fixed its pin goes red, and those
// probes move into govtReads().
//
// The catalog-level fence (every predicate carries both markers) lives in
// __tests__/rls/coverage.test.ts and scripts/check-rls-coverage.ts check 5;
// this file is the behavioural half.
//
// PRE-FLIGHT: local Supabase stack, .env.local loaded. Setup failures THROW —
// never a green skip.

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AUDIT_LOG_ACTIONS,
  approvalRequests,
  auditLog,
  cases,
  cronRuns,
  custodyDisputeParties,
  custodyDisputes,
  db,
  govtAssignments,
  notifications,
  petEvents,
  petIdentifications,
  petServiceDog,
  pets,
  profiles,
} from "@/db";
import { generateUniqueCasePublicCode } from "@/lib/infra/case-helpers";
import { elevateToAal2 } from "../_helpers/aal2-session";
import { setAuditMutationGucs, withMutationOverride } from "../_helpers/db-overrides";
import { createFreshTestUser } from "../_helpers/fresh-test-user";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const ADMIN_EMAIL = "erased-admin-probe@dim-test.local";
const ADMIN_PASSWORD = "ErasedAdminProbe_2026!";
const PET_TOKEN = "DIM-ERAD-0001";
const CRON_NAME = "erased-admin-probe";

const GOVT_EMAIL = "erased-govt-probe@dim-test.local";
const GOVT_PASSWORD = "ErasedGovtProbe_2026!";
const GOVT_PET_TOKEN = "DIM-ERAG-0001";
const GOVT_DISPUTE_TOKEN = "DIS-ERAG-0001";
const GOVT_APPROVAL_TOKEN = "APR-ERAG-0001";
const GOVT_CASE_REASON = "erased-govt-authority fixture";
const JURISDICTION = { province: "Buenos Aires", locality: "La Plata" } as const;

let adminClient: SupabaseClient | null = null;
let adminUserId = "";
let petId = "";
let caseId = "";
let cronRunId = "";
let auditRowId = "";
let setupError: string | null = null;

let govtClient: SupabaseClient | null = null;
// Password-only twins of the two probes (migration 0231): the SAME accounts,
// signed in separately and never taken past the second factor.
let adminAal1Client: SupabaseClient | null = null;
let govtAal1Client: SupabaseClient | null = null;
let govtUserId = "";
let govtPetId = "";
let govtCaseId = "";
let disputeId = "";
let disputePartyId = "";
let serviceDogId = "";
let identificationId = "";
let approvalId = "";

function adminSdk(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function deleteFixture(): Promise<void> {
  await db.delete(cases).where(eq(cases.openedReason, "erased-admin-authority fixture"));
  await db.delete(pets).where(eq(pets.publicToken, PET_TOKEN));
  await db.delete(cronRuns).where(eq(cronRuns.cronName, CRON_NAME));

  const admin = adminSdk();
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === ADMIN_EMAIL);

  // The audit fixture row has a NULL actor on purpose; find it by payload.
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.execute(
      sql`DELETE FROM audit_log WHERE payload->>'fixture' = 'erased-admin-authority'`,
    );
    if (found) {
      await tx.delete(auditLog).where(eq(auditLog.actorUserId, found.id));
      await tx.delete(auditLog).where(eq(auditLog.targetUserId, found.id));
    }
  });
  if (!found) return;
  await db.delete(notifications).where(eq(notifications.userId, found.id));
  await db.delete(profiles).where(eq(profiles.id, found.id));
  await admin.auth.admin.deleteUser(found.id);
}

async function deleteGovtFixture(): Promise<void> {
  await db.delete(approvalRequests).where(eq(approvalRequests.publicToken, GOVT_APPROVAL_TOKEN));
  await db.delete(cases).where(eq(cases.openedReason, GOVT_CASE_REASON));
  const staleDisputes = await db
    .select({ id: custodyDisputes.id })
    .from(custodyDisputes)
    .where(eq(custodyDisputes.publicToken, GOVT_DISPUTE_TOKEN));
  for (const { id } of staleDisputes) {
    await db.delete(custodyDisputeParties).where(eq(custodyDisputeParties.disputeId, id));
    await db.delete(custodyDisputes).where(eq(custodyDisputes.id, id));
  }
  // The dispute's raising event lives in append-only pet_events; deleting the
  // pet cascades into it (and into pet_service_dog / pet_identifications), so
  // the trigger has to be told this is fixture teardown.
  await withMutationOverride(async (tx) => {
    const stalePets = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, GOVT_PET_TOKEN));
    for (const { id } of stalePets) {
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
  });

  const admin = adminSdk();
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === GOVT_EMAIL);
  if (!found) return;
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.delete(auditLog).where(eq(auditLog.actorUserId, found.id));
    await tx.delete(auditLog).where(eq(auditLog.targetUserId, found.id));
  });
  await db.delete(govtAssignments).where(eq(govtAssignments.userId, found.id));
  await db.delete(notifications).where(eq(notifications.userId, found.id));
  await db.delete(profiles).where(eq(profiles.id, found.id));
  await admin.auth.admin.deleteUser(found.id);
}

/**
 * A PostgREST credential that never reached a policy returns an empty result
 * too — and an empty result is exactly what the ERASED probes read as
 * "refused". Scoring a rejected key as a refusal is how the anon row of the
 * RLS matrix passed for months without evaluating a policy (matrix.test.ts:704).
 */
function assertCredentialReachedRls(error: { code?: string; message: string } | null): void {
  if (!error) return;
  const credentialRejected =
    error.code?.startsWith("PGRST30") || /JWT|API key/i.test(error.message);
  if (!credentialRejected) return;
  throw new Error(
    `The probe never reached a policy — PostgREST rejected the CREDENTIAL (${error.code ?? "no code"}: ${error.message}). This is NOT a refusal. Check NEXT_PUBLIC_SUPABASE_ANON_KEY against \`supabase status -o env\`.`,
  );
}

function client(): SupabaseClient {
  if (setupError) throw new Error(setupError);
  if (!adminClient) throw new Error("admin client not provisioned");
  return adminClient;
}

function govt(): SupabaseClient {
  if (setupError) throw new Error(setupError);
  if (!govtClient) throw new Error("govt client not provisioned");
  return govtClient;
}

type ProbeTable =
  | "cron_runs"
  | "audit_log"
  | "cases"
  | "pets"
  | "custody_disputes"
  | "custody_dispute_parties"
  | "pet_service_dog"
  | "pet_identifications"
  | "approval_requests";

async function rowsVisibleAs(
  session: SupabaseClient,
  table: ProbeTable,
  id: string,
): Promise<number> {
  const { data, error } = await session.from(table).select("id").eq("id", id);
  assertCredentialReachedRls(error);
  if (error) throw new Error(`${table} probe errored: ${error.message}`);
  return (data ?? []).length;
}

async function rowsVisible(table: "cron_runs" | "audit_log", id: string): Promise<number> {
  return rowsVisibleAs(client(), table, id);
}

async function canReadCaseAs(userId: string, targetCaseId: string): Promise<boolean> {
  const rows = (await db.execute(
    sql`select public.can_read_case(${targetCaseId}::uuid, ${userId}::uuid) as ok`,
  )) as unknown as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
}

async function canReadCase(): Promise<boolean> {
  return canReadCaseAs(adminUserId, caseId);
}

/** The two probe-able govt surfaces (see the header), read in one go. */
async function govtReads(): Promise<Record<string, number | boolean>> {
  return {
    approval_requests: await rowsVisibleAs(govt(), "approval_requests", approvalId),
    can_read_case: await canReadCaseAs(govtUserId, govtCaseId),
  };
}

const GOVT_ALL_VISIBLE = {
  approval_requests: 1,
  can_read_case: true,
};

const GOVT_ALL_REFUSED = {
  approval_requests: 0,
  can_read_case: false,
};

/** SELECT policies on pets whose text mentions govt — the header says why this must stay empty. */
async function petsSelectPoliciesMentioningGovt(): Promise<string[]> {
  const rows = (await db.execute(sql`
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'pets'
      and cmd = 'SELECT'
      and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%govt%'
    order by policyname
  `)) as unknown as Array<{ policyname: string }>;
  return rows.map((r) => r.policyname);
}

/** The PostgREST error a read produced, or null when it returned rows. */
async function probeError(table: ProbeTable, id: string): Promise<string | null> {
  const { error } = await govt().from(table).select("id").eq("id", id);
  assertCredentialReachedRls(error);
  return error?.message ?? null;
}

const ORG_MEMBERSHIPS_RECURSION =
  /infinite recursion detected in policy for relation "organization_memberships"/;

/**
 * pii.caller_is_admin as the RPCs call it: inside a request whose verified
 * claims name the admin probe. Since migration 0231 the guard also reads the
 * token's `aal`, so the claim is part of the question — aal2 by default, the
 * state a legitimate admin session is in.
 */
async function callerIsAdmin(aal: "aal1" | "aal2" = "aal2"): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: adminUserId, role: "authenticated", aal });
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    const rows = (await tx.execute(
      sql`select pii.caller_is_admin(${adminUserId}::uuid) as ok`,
    )) as unknown as Array<{ ok: boolean }>;
    return rows[0]?.ok === true;
  });
}

const ROLLBACK = new Error("rollback — subject-rights probe never commits");

/**
 * Run a subject-rights RPC as the admin probe at the given assurance level, on
 * SOMEONE ELSE's id (the govt probe), and always roll back — an erase that
 * wrongly succeeded must not survive the test that caught it. Returns the
 * error text, or null when the call succeeded.
 */
async function subjectRightsRpcAs(
  aal: "aal1" | "aal2",
  call: "export" | "erase",
): Promise<string | null> {
  let outcome: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const claims = JSON.stringify({ sub: adminUserId, role: "authenticated", aal });
      await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
      await tx.execute(sql`savepoint probe`);
      try {
        if (call === "export") {
          await tx.execute(sql`select public.export_subject_data(${govtUserId}::uuid)`);
        } else {
          await tx.execute(
            sql`select public.erase_subject_data(${govtUserId}::uuid, 'aal probe — rolled back')`,
          );
        }
        outcome = null;
      } catch (err) {
        const e = err as { message?: string; cause?: { message?: string } };
        outcome = e.cause?.message ?? e.message ?? "error";
        await tx.execute(sql`rollback to savepoint probe`);
      }
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return outcome;
}

async function setDeletedAt(value: Date | null, userId = adminUserId): Promise<void> {
  await db.update(profiles).set({ deletedAt: value }).where(eq(profiles.id, userId));
}

async function provisionGovt(): Promise<void> {
  await deleteGovtFixture();

  const created = await createFreshTestUser(adminSdk(), {
    email: GOVT_EMAIL,
    password: GOVT_PASSWORD,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    setupError = `createUser(${GOVT_EMAIL}) failed: ${created.error?.message ?? "no user"}`;
    throw new Error(setupError);
  }
  govtUserId = created.data.user.id;

  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional", displayName: "Erased govt probe" })
    .where(eq(profiles.id, govtUserId));

  // ONE active assignment. It is never revoked by this file: the ERASED state
  // must be refused with the assignment still live, which is exactly what
  // erase_subject_data leaves behind.
  await db.insert(govtAssignments).values({
    userId: govtUserId,
    jurisdictionProvince: JURISDICTION.province,
    jurisdictionLocality: JURISDICTION.locality,
  });

  // A pet IN the jurisdiction with no ownership: the govt is not its owner, so
  // the owner branches of pet_service_dog / can_read_case cannot serve it.
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: GOVT_PET_TOKEN,
      name: "Erased-govt probe pet",
      species: "dog",
      jurisdictionProvince: JURISDICTION.province,
      jurisdictionLocality: JURISDICTION.locality,
    })
    .returning({ id: pets.id });
  govtPetId = pet.id;

  const [sd] = await db
    .insert(petServiceDog)
    .values({ petId: govtPetId, serviceType: "guia", trainingCenter: "Erased-govt probe" })
    .returning({ id: petServiceDog.id });
  serviceDogId = sd.id;

  const [ident] = await db
    .insert(petIdentifications)
    .values({
      petId: govtPetId,
      kind: "collar_tag",
      code: "ERAG-PROBE-TAG",
      status: "active",
      recordedAt: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: petIdentifications.id });
  identificationId = ident.id;

  // The dispute is raised by the ADMIN probe and its only party is the admin
  // probe: the govt is neither raiser nor party, so only the govt branch of
  // both custody policies can say yes.
  const [raisingEvent] = await db
    .insert(petEvents)
    .values({
      petId: govtPetId,
      eventType: "custody_dispute_raised",
      occurredAt: new Date(),
      recordedByUserId: adminUserId,
      authorRole: "owner",
    })
    .returning({ id: petEvents.id });
  const [dispute] = await db
    .insert(custodyDisputes)
    .values({
      publicToken: GOVT_DISPUTE_TOKEN,
      petId: govtPetId,
      raisedByUserId: adminUserId,
      raisedByRole: "admin",
      raisingEventId: raisingEvent.id,
      jurisdictionProvince: JURISDICTION.province,
      jurisdictionLocality: JURISDICTION.locality,
    })
    .returning({ id: custodyDisputes.id });
  disputeId = dispute.id;
  const [party] = await db
    .insert(custodyDisputeParties)
    .values({ disputeId, partyUserId: adminUserId, partyRole: "current_owner" })
    .returning({ id: custodyDisputeParties.id });
  disputePartyId = party.id;

  // Applicant is the admin probe, so the applicant branch cannot serve the
  // govt; before 0216 the assignment alone did.
  const [approval] = await db
    .insert(approvalRequests)
    .values({
      publicToken: GOVT_APPROVAL_TOKEN,
      type: "role_upgrade_vet",
      applicantUserId: adminUserId,
      targetUserId: adminUserId,
      jurisdictionProvince: JURISDICTION.province,
      jurisdictionLocality: JURISDICTION.locality,
    })
    .returning({ id: approvalRequests.id });
  approvalId = approval.id;

  // A case in the jurisdiction on the un-owned pet: the govt branch is the
  // only branch of can_read_case that can say yes for this caller.
  const [row] = await db
    .insert(cases)
    .values({
      publicCode: await generateUniqueCasePublicCode(),
      caseKind: "bite_incident",
      status: "open",
      primarySubjectKind: "registered_pet",
      primaryPetId: govtPetId,
      jurisdictionProvince: JURISDICTION.province,
      jurisdictionLocality: JURISDICTION.locality,
      openedReason: GOVT_CASE_REASON,
    })
    .returning({ id: cases.id });
  govtCaseId = row.id;

  govtClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authErr } = await govtClient.auth.signInWithPassword({
    email: GOVT_EMAIL,
    password: GOVT_PASSWORD,
  });
  if (authErr || !auth.user) {
    setupError = `sign-in failed for ${GOVT_EMAIL}: ${authErr?.message ?? "no user"}`;
    throw new Error(setupError);
  }
  govtAal1Client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await govtAal1Client.auth.signInWithPassword({ email: GOVT_EMAIL, password: GOVT_PASSWORD });
  await elevateToAal2(govtClient);
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    setupError =
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing — no PostgREST to probe.";
    throw new Error(setupError);
  }

  await deleteFixture();

  const created = await createFreshTestUser(adminSdk(), {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    setupError = `createUser(${ADMIN_EMAIL}) failed: ${created.error?.message ?? "no user"}`;
    throw new Error(setupError);
  }
  adminUserId = created.data.user.id;

  // handle_new_user creates (owner, personal). Promote over Drizzle — the only
  // legitimate writer of these columns (migration 0211). deactivated_at stays
  // NULL throughout: the state under test is erased-but-not-deactivated.
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional", displayName: "Erased admin probe" })
    .where(eq(profiles.id, adminUserId));

  const [cron] = await db
    .insert(cronRuns)
    .values({ cronName: CRON_NAME, status: "ok", details: { fixture: "erased-admin-authority" } })
    .returning({ id: cronRuns.id });
  cronRunId = cron.id;

  // actor NULL: the "actor_user_id = auth.uid()" branch can never match this
  // row, so a read can only come from the admin branch under test.
  const [audit] = await db
    .insert(auditLog)
    .values({
      actorUserId: null,
      action: AUDIT_LOG_ACTIONS[0],
      payload: { fixture: "erased-admin-authority" },
    })
    .returning({ id: auditLog.id });
  auditRowId = audit.id;

  const [pet] = await db
    .insert(pets)
    .values({ publicToken: PET_TOKEN, name: "Erased-admin probe pet", species: "dog" })
    .returning({ id: pets.id });
  petId = pet.id;

  // No ownership, no jurisdiction on purpose: the admin branch is the ONLY
  // branch of can_read_case that can say yes for this caller.
  const [row] = await db
    .insert(cases)
    .values({
      publicCode: await generateUniqueCasePublicCode(),
      caseKind: "bite_incident",
      status: "open",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: "erased-admin-authority fixture",
    })
    .returning({ id: cases.id });
  caseId = row.id;

  adminClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authErr } = await adminClient.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (authErr || !auth.user) {
    setupError = `sign-in failed for ${ADMIN_EMAIL}: ${authErr?.message ?? "no user"}`;
    throw new Error(setupError);
  }
  adminAal1Client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await adminAal1Client.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  // Every control and refusal in the erased/restored blocks is about the
  // LIFECYCLE marker, so it must be measured on a session that already has
  // everything else: since T2-S6 that is password + second factor.
  await elevateToAal2(adminClient);

  // The govt fixtures reference the admin probe (raiser, party, applicant),
  // so they are built after it.
  await provisionGovt();
}, 60_000);

afterAll(async () => {
  await adminClient?.auth.signOut().catch(() => {});
  await govtClient?.auth.signOut().catch(() => {});
  await adminAal1Client?.auth.signOut().catch(() => {});
  await govtAal1Client?.auth.signOut().catch(() => {});
  // Govt first: its fixtures point at the admin probe.
  await deleteGovtFixture();
  await deleteFixture();
});

describe("erased admin — LIVE control: the session and the fixtures really reach the admin branch", () => {
  it("reads the cron_runs fixture through PostgREST (deactivated_at-only policy class)", async () => {
    expect(
      await rowsVisible("cron_runs", cronRunId),
      "a LIVE institutional admin cannot read cron_runs — every refusal below would be vacuous",
    ).toBe(1);
  });

  it("reads the actor-less audit_log fixture through PostgREST (neither-marker policy class)", async () => {
    expect(
      await rowsVisible("audit_log", auditRowId),
      "a LIVE admin cannot read an actor-less audit row — the admin branch is not what is being measured",
    ).toBe(1);
  });

  it("can_read_case says yes for the case it has no other relation to", async () => {
    expect(await canReadCase()).toBe(true);
  });

  it("pii.caller_is_admin says yes", async () => {
    expect(await callerIsAdmin()).toBe(true);
  });
});

describe("erased admin — deleted_at set, deactivated_at NULL (what erase_subject_data leaves)", () => {
  beforeAll(async () => {
    await setDeletedAt(new Date());
    // Ground truth, so a passing refusal below cannot be an unset marker.
    const [row] = await db
      .select({ deletedAt: profiles.deletedAt, deactivatedAt: profiles.deactivatedAt })
      .from(profiles)
      .where(eq(profiles.id, adminUserId));
    if (!row?.deletedAt || row.deactivatedAt !== null) {
      throw new Error("fixture is not in the erased-but-not-deactivated state");
    }
  });

  it("is refused the cron_runs fixture — the same session that just read it", async () => {
    expect(
      await rowsVisible("cron_runs", cronRunId),
      "an ERASED admin still reads cron_runs — the policy checks deactivated_at but not deleted_at",
    ).toBe(0);
  });

  it("is refused the audit_log fixture", async () => {
    expect(
      await rowsVisible("audit_log", auditRowId),
      "an ERASED admin still reads the audit log — the policy checks neither marker",
    ).toBe(0);
  });

  it("can_read_case says no", async () => {
    expect(
      await canReadCase(),
      "can_read_case still grants universal scope to an erased admin (db/cases_rls.sql:49)",
    ).toBe(false);
  });

  it("pii.caller_is_admin says no — the erasure RPCs no longer accept it as a non-subject caller", async () => {
    expect(
      await callerIsAdmin(),
      "an erased admin can still run export_subject_data / erase_subject_data on every other person",
    ).toBe(false);
  });
});

describe("erased admin — RESTORED: the refusal was the marker, not the session", () => {
  beforeAll(async () => {
    await setDeletedAt(null);
  });

  it("reads both fixtures again and both functions say yes again", async () => {
    expect(await rowsVisible("cron_runs", cronRunId)).toBe(1);
    expect(await rowsVisible("audit_log", auditRowId)).toBe(1);
    expect(await canReadCase()).toBe(true);
    expect(await callerIsAdmin()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Govt (migration 0216)
// ---------------------------------------------------------------------------

describe("erased govt — LIVE control: the session, the assignment and the fixtures really reach the govt branch", () => {
  it("reads the approval request in its jurisdiction through PostgREST and can_read_case says yes", async () => {
    expect(
      await govtReads(),
      "a LIVE govt with an active assignment cannot read its own jurisdiction — every refusal below would be vacuous",
    ).toEqual(GOVT_ALL_VISIBLE);
  });

  it("PINS a pre-existing condition: the govt branch of pet_service_dog and pet_identifications is unreachable through PostgREST — pets has no govt select policy", async () => {
    // See the header. When the first assertion goes red pets has gained a
    // govt select branch: move both probes into govtReads() / GOVT_ALL_VISIBLE /
    // GOVT_ALL_REFUSED and delete this test — the fixtures are already in place.
    expect(
      await petsSelectPoliciesMentioningGovt(),
      "pets now has a select policy that names govt — the two probes below can move into govtReads()",
    ).toEqual([]);
    expect(
      await rowsVisibleAs(govt(), "pets", govtPetId),
      "the govt can read the un-owned fixture pet through PostgREST — the pets catalog pin above is out of date",
    ).toBe(0);
    // The consequence, kept next to its cause: both branches' `FROM pets pt`
    // subquery is empty for this caller, so the LIVE read is 0 — which is why
    // they cannot serve as a control and are not asserted in the ERASED state.
    expect(await rowsVisibleAs(govt(), "pet_service_dog", serviceDogId)).toBe(0);
    expect(await rowsVisibleAs(govt(), "pet_identifications", identificationId)).toBe(0);
  });

  it("PINS a pre-existing defect: custody_disputes and custody_dispute_parties cannot be read through PostgREST by anyone — organization_memberships' peer policy recurses", async () => {
    // See the header. When this goes red the recursion has been fixed: move
    // both probes into govtReads() / GOVT_ALL_VISIBLE / GOVT_ALL_REFUSED and
    // delete this test — the fixtures are already in place.
    expect(await probeError("custody_disputes", disputeId)).toMatch(ORG_MEMBERSHIPS_RECURSION);
    expect(await probeError("custody_dispute_parties", disputePartyId)).toMatch(
      ORG_MEMBERSHIPS_RECURSION,
    );
  });
});

describe("erased govt — deleted_at set, deactivated_at NULL, assignment still active (what erase_subject_data leaves)", () => {
  beforeAll(async () => {
    await setDeletedAt(new Date(), govtUserId);
    // Ground truth on BOTH tables: the marker is set, nothing else moved. If
    // the assignment were revoked the refusals below would be measuring the
    // revocation, not the erasure.
    const [row] = await db
      .select({ deletedAt: profiles.deletedAt, deactivatedAt: profiles.deactivatedAt })
      .from(profiles)
      .where(eq(profiles.id, govtUserId));
    if (!row?.deletedAt || row.deactivatedAt !== null) {
      throw new Error("govt fixture is not in the erased-but-not-deactivated state");
    }
    const [assignment] = await db
      .select({ revokedAt: govtAssignments.revokedAt })
      .from(govtAssignments)
      .where(eq(govtAssignments.userId, govtUserId));
    if (!assignment || assignment.revokedAt !== null) {
      throw new Error(
        "govt fixture's assignment is missing or revoked — the probe would not isolate the erasure",
      );
    }
  });

  it("is refused every surface it just read, on the same session, with the assignment still live", async () => {
    expect(
      await govtReads(),
      "an ERASED govt still reads its jurisdiction — a govt branch checks deactivated_at (or nothing) but not deleted_at",
    ).toEqual(GOVT_ALL_REFUSED);
  });
});

describe("erased govt — RESTORED: the refusal was the marker, not the session or the assignment", () => {
  beforeAll(async () => {
    await setDeletedAt(null, govtUserId);
  });

  it("reads everything again", async () => {
    expect(await govtReads()).toEqual(GOVT_ALL_VISIBLE);
  });
});

// ---------------------------------------------------------------------------
// The second factor at the database layer (migration 0231)
// ---------------------------------------------------------------------------
//
// THE PROBE IS THE ATTACK, again: the same two live accounts, each also signed
// in with the password alone — what anyone holding a stolen password gets by
// posting straight to GoTrue, never touching the app. Both profiles are LIVE
// here (the RESTORED blocks above ran), so every refusal is the assurance
// level and nothing else; the aal2 twin reading the same row in the same test
// is the control.

function aal1(which: "admin" | "govt"): SupabaseClient {
  const c = which === "admin" ? adminAal1Client : govtAal1Client;
  if (!c) throw new Error(`${which} aal1 client not provisioned`);
  return c;
}

async function tokenAal(c: SupabaseClient): Promise<string | undefined> {
  const { data } = await c.auth.getSession();
  const token = data.session?.access_token ?? "";
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")).aal;
}

describe("password-only institutional sessions (aal1) — refused at the database layer (0231)", () => {
  it("the twins really are aal1 and the probes aal2 — otherwise nothing below measures the claim", async () => {
    expect(await tokenAal(aal1("admin"))).toBe("aal1");
    expect(await tokenAal(aal1("govt"))).toBe("aal1");
    expect(await tokenAal(client())).toBe("aal2");
    expect(await tokenAal(govt())).toBe("aal2");
  });

  it("aal1 admin reads nothing on the admin-branch tables the aal2 admin reads", async () => {
    expect(await rowsVisibleAs(client(), "cron_runs", cronRunId)).toBe(1);
    expect(await rowsVisibleAs(client(), "audit_log", auditRowId)).toBe(1);
    expect(await rowsVisibleAs(client(), "cases", caseId)).toBe(1);
    expect(
      await rowsVisibleAs(aal1("admin"), "cron_runs", cronRunId),
      "a password-only admin token still reads cron_runs through PostgREST",
    ).toBe(0);
    expect(
      await rowsVisibleAs(aal1("admin"), "audit_log", auditRowId),
      "a password-only admin token still reads the audit log through PostgREST",
    ).toBe(0);
    expect(
      await rowsVisibleAs(aal1("admin"), "cases", caseId),
      "a password-only admin token still reads cases through PostgREST (can_read_case admin branch)",
    ).toBe(0);
  });

  it("aal1 govt reads neither the case nor the approval request in its own jurisdiction", async () => {
    expect(await rowsVisibleAs(govt(), "cases", govtCaseId)).toBe(1);
    expect(await rowsVisibleAs(govt(), "approval_requests", approvalId)).toBe(1);
    expect(
      await rowsVisibleAs(aal1("govt"), "cases", govtCaseId),
      "a password-only govt token still reads cases in its jurisdiction",
    ).toBe(0);
    expect(
      await rowsVisibleAs(aal1("govt"), "approval_requests", approvalId),
      "a password-only govt token still reads approval requests in its jurisdiction",
    ).toBe(0);
    expect(await rowsVisibleAs(aal1("govt"), "audit_log", auditRowId)).toBe(0);
  });

  it("pii.caller_is_admin says no at aal1 and yes at aal2", async () => {
    expect(await callerIsAdmin("aal1")).toBe(false);
    expect(await callerIsAdmin("aal2")).toBe(true);
  });

  it("export_subject_data on another person: refused at aal1, served at aal2 (control)", async () => {
    expect(
      await subjectRightsRpcAs("aal1", "export"),
      "a password-only admin token can still dump another person's data (Ley 25.326 art. 14)",
    ).toMatch(/forbidden/i);
    expect(await subjectRightsRpcAs("aal2", "export")).toBeNull();
  });

  it("erase_subject_data on another person: refused at aal1", async () => {
    expect(
      await subjectRightsRpcAs("aal1", "erase"),
      "a password-only admin token can still erase another person (Ley 25.326 art. 16)",
    ).toMatch(/forbidden/i);
  });
});
