// T1-L12 — decideCapabilityAction decides on the org the admin OPENED.
//
// It used to resolve the organization as the session-default membership
// (`getActiveMemberships(user.id)` → last joined), ignoring the page. Its twin
// requestCapabilityAction was fixed the same way on 2026-08-10. An admin of two
// organizations, standing on /org/{A}/admin/permisos, then decided with B's
// context: every grant of A was refused as "pertenece a otra organización".
//
// This test runs the REAL action against the REAL database — only the session
// (requireLiveUser) and Next's revalidatePath are stubbed. The admin joins A
// first and B LAST, so the session default is B; the grant lives in A; the form
// names A. The approval must land in A, and the audit row and the requester's
// notification must both be bound to A.

import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireLiveUser = vi.fn();
vi.mock("@/lib/infra/live-user", () => ({
  requireLiveUser: (...args: unknown[]) => mockRequireLiveUser(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { withAuditMutationOverride } from "@/__tests__/_helpers/db-overrides";
import {
  auditLog,
  db,
  notifications,
  organizationCapabilityGrants,
  organizationMemberships,
  organizations,
  profiles,
} from "@/db";
import { decideCapabilityAction } from "@/src/modules/organizations/actions";

const ADMIN_ID = "7a1e0000-0000-4000-8000-00000000a012";
const REQUESTER_ID = "7a1e0000-0000-4000-8000-00000000b012";
const STAMP = Date.now().toString(36);
const TOKEN_A = `ORG-L12A-${STAMP}`;
const TOKEN_B = `ORG-L12B-${STAMP}`;

let orgA: string;
let orgB: string;
let grantId: string;

async function insertUser(id: string, label: string) {
  await db.execute(sql`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, aud, role)
    values (${id}::uuid, ${`${label}@dim-test.local`}, 'fake', now(),
      '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated')
    on conflict (id) do nothing
  `);
  await db
    .insert(profiles)
    .values({ id, role: "owner", accountType: "personal", displayName: label })
    .onConflictDoNothing();
}

async function insertOrg(token: string, name: string): Promise<string> {
  const [row] = await db
    .insert(organizations)
    .values({
      publicToken: token,
      legalName: name,
      displayName: name,
      orgType: "shelter",
      email: `${token.toLowerCase()}@dim-test.local`,
    })
    .returning({ id: organizations.id });
  return row.id;
}

async function cleanup() {
  const orgIds = (
    await db
      .select({ id: organizations.id })
      .from(organizations)
      // Prefix, not this run's two tokens: a run whose teardown died leaves
      // orgs behind that would otherwise leak into the next run's counts.
      .where(like(organizations.publicToken, "ORG-L12%"))
  ).map((r) => r.id);
  await db.delete(notifications).where(inArray(notifications.userId, [ADMIN_ID, REQUESTER_ID]));
  // audit_log is append-only; the test override GUCs let teardown remove the
  // rows this file wrote (actor = one of its two users).
  await withAuditMutationOverride(async (tx) => {
    await tx
      .delete(auditLog)
      .where(or(eq(auditLog.actorUserId, ADMIN_ID), eq(auditLog.actorUserId, REQUESTER_ID)));
  });
  if (orgIds.length > 0) {
    await db
      .delete(organizationCapabilityGrants)
      .where(inArray(organizationCapabilityGrants.organizationId, orgIds));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.organizationId, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }
}

beforeAll(async () => {
  await cleanup();
  await insertUser(ADMIN_ID, "l12-multi-org-admin");
  await insertUser(REQUESTER_ID, "l12-requester");

  orgA = await insertOrg(TOKEN_A, "Refugio L12 A");
  orgB = await insertOrg(TOKEN_B, "Refugio L12 B");

  const day = 24 * 60 * 60 * 1000;
  // A joined first, B joined LAST → the session-default membership is B.
  await db.insert(organizationMemberships).values([
    {
      organizationId: orgA,
      userId: ADMIN_ID,
      role: "admin",
      joinedAt: new Date(Date.now() - 2 * day),
    },
    {
      organizationId: orgB,
      userId: ADMIN_ID,
      role: "admin",
      joinedAt: new Date(Date.now() - day),
    },
  ]);
  const [requesterMembership] = await db
    .insert(organizationMemberships)
    .values({ organizationId: orgA, userId: REQUESTER_ID, role: "member" })
    .returning({ id: organizationMemberships.id });

  const [grant] = await db
    .insert(organizationCapabilityGrants)
    .values({
      membershipId: requesterMembership.id,
      organizationId: orgA,
      capability: "intake.create",
      status: "pending",
    })
    .returning({ id: organizationCapabilityGrants.id });
  grantId = grant.id;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await db.delete(profiles).where(inArray(profiles.id, [ADMIN_ID, REQUESTER_ID]));
  await db.execute(
    sql`delete from auth.users where id in (${ADMIN_ID}::uuid, ${REQUESTER_ID}::uuid)`,
  );
}, 60_000);

beforeEach(() => {
  mockRequireLiveUser.mockResolvedValue({
    ok: true,
    supabase: {},
    user: { id: ADMIN_ID, email: "l12-multi-org-admin@dim-test.local" },
    profile: {
      id: ADMIN_ID,
      role: "owner",
      accountType: "personal",
      deactivatedAt: null,
      deletedAt: null,
    },
    sessionStartedAt: new Date(),
  });
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("decideCapabilityAction — org resolved from the request (T1-L12)", () => {
  it("refuses a form that names no organization instead of guessing one", async () => {
    const result = await decideCapabilityAction(
      { error: null },
      form({ grantId, decision: "approved" }),
    );
    expect(result).toEqual({ error: "No pudimos determinar la organización." });

    const [grant] = await db
      .select({ status: organizationCapabilityGrants.status })
      .from(organizationCapabilityGrants)
      .where(eq(organizationCapabilityGrants.id, grantId));
    expect(grant.status).toBe("pending");
  });

  it("a multi-org admin decides on the org they opened, not the session default", async () => {
    const result = await decideCapabilityAction(
      { error: null },
      form({ orgToken: TOKEN_A, grantId, decision: "approved", reason: "Ok" }),
    );
    expect(result).toEqual({ error: null, ok: true });

    const [grant] = await db
      .select({
        status: organizationCapabilityGrants.status,
        decidedByUserId: organizationCapabilityGrants.decidedByUserId,
      })
      .from(organizationCapabilityGrants)
      .where(eq(organizationCapabilityGrants.id, grantId));
    expect(grant).toEqual({ status: "approved", decidedByUserId: ADMIN_ID });

    // Audit bound to A.
    const audits = await db
      .select({ targetOrganizationId: auditLog.targetOrganizationId, payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, ADMIN_ID), eq(auditLog.action, "capability_granted")));
    expect(audits).toHaveLength(1);
    expect(audits[0].targetOrganizationId).toBe(orgA);
    expect((audits[0].payload as Record<string, unknown>).org_id).toBe(orgA);

    // Notification bound to A: A's name in the copy, A's panel as the CTA.
    const notes = await db
      .select({ body: notifications.body, ctaUrl: notifications.ctaUrl })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, REQUESTER_ID),
          eq(notifications.notificationType, "capability_approved"),
        ),
      );
    expect(notes).toHaveLength(1);
    expect(notes[0].ctaUrl).toBe(`/org/${TOKEN_A}`);
    expect(notes[0].body).toContain("Refugio L12 A");
    expect(notes[0].body).not.toContain("Refugio L12 B");
  });
});
