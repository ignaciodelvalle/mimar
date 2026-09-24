// Integration tests for org-invitations server actions.
//
// Covers:
//  - invite happy path
//  - role-bounding: coordinator inviting admin → rejected; inviting a role ≤ rank → ok
//  - foster rejected as invitable role
//  - duplicate active invite rejected
//  - invite to an already-active member rejected (handled at accept time)
//  - accept happy path: membership row created, invitation marked accepted, inviter notified
//  - accept after expiry → rejected
//  - accept after revoke → rejected
//  - accept already-accepted → rejected
//  - accept with mismatched email → rejected
//  - accept when already a member → friendly / idempotent
//  - revoke happy path (idempotent)
//
// Runs against the local Supabase + Postgres stack (127.0.0.1:54321/54322).

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq, gte, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import {
  auditLog,
  db,
  notifications,
  organizationInvitations,
  organizationMemberships,
  organizations,
  profiles,
} from "@/db";
import { createClient } from "@/lib/supabase/server";
import {
  acceptInvitationAction,
  inviteMemberAction,
  revokeInvitationAction,
} from "@/src/modules/organizations/actions";
import { dbNow } from "./_helpers/db-now";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const PASS = "OrgInvite_2026!";
const ADMIN_EMAIL = "org-invite-admin@dim-test.local";
const COORD_EMAIL = "org-invite-coord@dim-test.local";
const INVITEE_EMAIL = "org-invite-invitee@dim-test.local";
const INVITEE2_EMAIL = "org-invite-invitee2@dim-test.local";

let adminUserId: string;
let coordUserId: string;
let inviteeUserId: string;
let invitee2UserId: string;
let orgId: string;
let orgPublicToken: string;

function mockSessionAs(userId: string, email: string) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: { id: userId, email } as unknown },
        error: null,
      }),
    },
  } as never);
}

function mockNoSession() {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: null },
        error: null,
      }),
    },
  } as never);
}

async function deleteUserByEmail(email: string) {
  const { data } = await supabaseAdmin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  for (const uid of ids) {
    await db.delete(notifications).where(eq(notifications.userId, uid));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
    await db.delete(profiles).where(eq(profiles.id, uid));
  }
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

async function createUserOrThrow(email: string): Promise<string> {
  const r = await createFreshTestUser(supabaseAdmin, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

beforeAll(async () => {
  // Clean up leftovers.
  for (const email of [ADMIN_EMAIL, COORD_EMAIL, INVITEE_EMAIL, INVITEE2_EMAIL]) {
    await deleteUserByEmail(email);
  }
  // Clean up stale org.
  const staleOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, "ORG-INVITE-TEST"));
  for (const { id } of staleOrgs) {
    await db.delete(organizationInvitations).where(eq(organizationInvitations.organizationId, id));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }

  // Create users.
  adminUserId = await createUserOrThrow(ADMIN_EMAIL);
  coordUserId = await createUserOrThrow(COORD_EMAIL);
  inviteeUserId = await createUserOrThrow(INVITEE_EMAIL);
  invitee2UserId = await createUserOrThrow(INVITEE2_EMAIL);

  // Set display names so deleteUserByEmail can find them by displayName too.
  await db
    .update(profiles)
    .set({ displayName: ADMIN_EMAIL.split("@")[0], role: "owner", accountType: "personal" })
    .where(eq(profiles.id, adminUserId));
  await db
    .update(profiles)
    .set({ displayName: COORD_EMAIL.split("@")[0], role: "owner", accountType: "personal" })
    .where(eq(profiles.id, coordUserId));
  await db
    .update(profiles)
    .set({ displayName: INVITEE_EMAIL.split("@")[0], role: "owner", accountType: "personal" })
    .where(eq(profiles.id, inviteeUserId));
  await db
    .update(profiles)
    .set({ displayName: INVITEE2_EMAIL.split("@")[0], role: "owner", accountType: "personal" })
    .where(eq(profiles.id, invitee2UserId));

  // Create org.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: "ORG-INVITE-TEST",
      legalName: "Invite Test Org SRL",
      displayName: "Invite Test Org",
      orgType: "shelter",
      email: "invite-test-org@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;
  orgPublicToken = org.publicToken;

  // Admin membership.
  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: adminUserId,
    role: "admin",
    canWritePetEvents: true,
  });

  // Coordinator membership.
  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: coordUserId,
    role: "coordinator",
    canWritePetEvents: false,
  });
});

afterAll(async () => {
  // Clean invitations and memberships first.
  await db.delete(organizationInvitations).where(eq(organizationInvitations.organizationId, orgId));
  await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const email of [ADMIN_EMAIL, COORD_EMAIL, INVITEE_EMAIL, INVITEE2_EMAIL]) {
    await deleteUserByEmail(email);
  }
});

// Helper to clean all invitations for the org between tests.
async function clearInvitations() {
  await db.delete(organizationInvitations).where(eq(organizationInvitations.organizationId, orgId));
}

// Helper to remove a specific invitee's membership from the org.
async function removeMembership(userId: string) {
  await db
    .delete(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, orgId),
        eq(organizationMemberships.userId, userId),
      ),
    );
}

describe("inviteMemberAction", () => {
  it("admin: happy path — creates invite and returns inviteUrl", async () => {
    await clearInvitations();
    mockSessionAs(adminUserId, ADMIN_EMAIL);

    const result = await inviteMemberAction({
      organizationId: orgId,
      email: "fresh-member@example.com",
      invitedRole: "member",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect(result.inviteUrl).toContain("/r/invite/INV-");

    // Verify DB row.
    const [row] = await db
      .select()
      .from(organizationInvitations)
      .where(
        and(
          eq(organizationInvitations.organizationId, orgId),
          eq(organizationInvitations.email, "fresh-member@example.com"),
        ),
      )
      .limit(1);
    expect(row).toBeDefined();
    expect(row.invitedRole).toBe("member");
    expect(row.acceptedAt).toBeNull();
    expect(row.revokedAt).toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("coordinator: gets member.invite implicitly — can invite a member", async () => {
    await clearInvitations();
    mockSessionAs(coordUserId, COORD_EMAIL);

    const result = await inviteMemberAction({
      organizationId: orgId,
      email: "coord-invites@example.com",
      invitedRole: "member",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect(result.inviteUrl).toContain("/r/invite/INV-");
  });

  it("coordinator (rank=4): cannot invite admin (rank=5)", async () => {
    await clearInvitations();
    mockSessionAs(coordUserId, COORD_EMAIL);

    const result = await inviteMemberAction({
      organizationId: orgId,
      email: "attempt-admin@example.com",
      invitedRole: "admin",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toContain("mayor al tuyo");
  });

  it("coordinator (rank=4): can invite coordinator (same rank)", async () => {
    await clearInvitations();
    mockSessionAs(coordUserId, COORD_EMAIL);

    const result = await inviteMemberAction({
      organizationId: orgId,
      email: "same-rank-coord@example.com",
      invitedRole: "coordinator",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect(result.inviteUrl).toContain("/r/invite/");
  });

  it("foster is not an invitable role", async () => {
    await clearInvitations();
    mockSessionAs(adminUserId, ADMIN_EMAIL);

    const result = await inviteMemberAction({
      organizationId: orgId,
      email: "foster-attempt@example.com",
      invitedRole: "foster",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toContain("inválido");
  });

  it("duplicate active invite for same (org, email) is rejected", async () => {
    await clearInvitations();
    mockSessionAs(adminUserId, ADMIN_EMAIL);

    // First invite.
    const first = await inviteMemberAction({
      organizationId: orgId,
      email: "dupe-test@example.com",
      invitedRole: "volunteer",
    });
    expect("error" in first).toBe(false);

    // Second invite — same email, same org.
    const second = await inviteMemberAction({
      organizationId: orgId,
      email: "dupe-test@example.com",
      invitedRole: "member",
    });
    expect("error" in second).toBe(true);
    if (!("error" in second)) throw new Error("Expected error");
    expect(second.error).toContain("activa");
  });

  it("email is normalized (case-insensitive) before duplicate check", async () => {
    await clearInvitations();
    mockSessionAs(adminUserId, ADMIN_EMAIL);

    const first = await inviteMemberAction({
      organizationId: orgId,
      email: "CaseSensitive@EXAMPLE.COM",
      invitedRole: "volunteer",
    });
    expect("error" in first).toBe(false);

    const second = await inviteMemberAction({
      organizationId: orgId,
      email: "casesensitive@example.com",
      invitedRole: "member",
    });
    expect("error" in second).toBe(true);
  });

  it("re-invite is allowed after revoke", async () => {
    await clearInvitations();
    mockSessionAs(adminUserId, ADMIN_EMAIL);

    // Invite.
    const invite = await inviteMemberAction({
      organizationId: orgId,
      email: "revoke-reinvite@example.com",
      invitedRole: "volunteer",
    });
    expect("error" in invite).toBe(false);

    // Get the token from the URL.
    if ("error" in invite) throw new Error(invite.error);
    const token = invite.inviteUrl.split("/r/invite/")[1];

    // Revoke it.
    const revoke = await revokeInvitationAction({
      organizationId: orgId,
      invitationToken: token,
    });
    expect("error" in revoke).toBe(false);

    // Re-invite.
    const reinvite = await inviteMemberAction({
      organizationId: orgId,
      email: "revoke-reinvite@example.com",
      invitedRole: "member",
    });
    expect("error" in reinvite).toBe(false);
  });

  it("re-invite is allowed after natural expiry (auto-revokes stale invite)", async () => {
    await clearInvitations();
    mockSessionAs(adminUserId, ADMIN_EMAIL);

    // Insert an already-expired invite directly, simulating a naturally expired one.
    const expiredEmail = "expired-reinvite@example.com";
    await db.insert(organizationInvitations).values({
      organizationId: orgId,
      email: expiredEmail,
      invitedRole: "volunteer",
      invitedByUserId: adminUserId,
      invitationToken: "INV-EXPR-STALE1",
      expiresAt: new Date(Date.now() - 1000), // already expired, not revoked
    });

    // Verify it exists and is expired but not revoked (it would block re-invite
    // if not treated as replaceable).
    const [stale] = await db
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.invitationToken, "INV-EXPR-STALE1"))
      .limit(1);
    expect(stale.revokedAt).toBeNull();
    expect(stale.expiresAt.getTime()).toBeLessThan(Date.now());

    // Re-invite — should succeed and auto-revoke the stale expired invite.
    const reinvite = await inviteMemberAction({
      organizationId: orgId,
      email: expiredEmail,
      invitedRole: "member",
    });
    expect("error" in reinvite).toBe(false);
    if ("error" in reinvite) throw new Error(reinvite.error);
    expect(reinvite.inviteUrl).toContain("/r/invite/INV-");

    // The stale invite should now be revoked.
    const [staleAfter] = await db
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.invitationToken, "INV-EXPR-STALE1"))
      .limit(1);
    expect(staleAfter.revokedAt).not.toBeNull();

    // A new active invite should exist.
    const newInvites = await db
      .select()
      .from(organizationInvitations)
      .where(
        and(
          eq(organizationInvitations.organizationId, orgId),
          eq(organizationInvitations.email, expiredEmail),
          isNull(organizationInvitations.acceptedAt),
          isNull(organizationInvitations.revokedAt),
        ),
      );
    expect(newInvites.length).toBe(1);
    expect(newInvites[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("acceptInvitationAction", () => {
  it("happy path: creates membership, marks invitation accepted, notifies inviter", async () => {
    await clearInvitations();
    await removeMembership(inviteeUserId);

    // Admin creates invite.
    mockSessionAs(adminUserId, ADMIN_EMAIL);
    const invite = await inviteMemberAction({
      organizationId: orgId,
      email: INVITEE_EMAIL,
      invitedRole: "volunteer",
    });
    expect("error" in invite).toBe(false);
    if ("error" in invite) throw new Error(invite.error);
    const token = invite.inviteUrl.split("/r/invite/")[1];

    // Capture timestamp immediately before accept so we can scope the audit
    // query. From POSTGRES, not `new Date()`: `performed_at` is defaulted from
    // the database's own clock inside a container, and comparing it against the
    // host's made this exact assertion shape flake an integration gate — see
    // __tests__/_helpers/db-now.ts.
    const acceptStart = await dbNow();

    // Invitee accepts.
    mockSessionAs(inviteeUserId, INVITEE_EMAIL);
    const result = await acceptInvitationAction({ invitationToken: token });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect(result.orgToken).toBe(orgPublicToken);

    // Verify membership row.
    const [membership] = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, orgId),
          eq(organizationMemberships.userId, inviteeUserId),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    expect(membership).toBeDefined();
    expect(membership.role).toBe("volunteer");
    expect(membership.invitedByUserId).toBe(adminUserId);

    // Verify invitation marked accepted.
    const [inv] = await db
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.invitationToken, token))
      .limit(1);
    expect(inv.acceptedAt).not.toBeNull();
    expect(inv.acceptedByUserId).toBe(inviteeUserId);

    // Verify inviter notification.
    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, adminUserId),
          eq(notifications.notificationType, "org_invitation_accepted"),
        ),
      );
    expect(notifs.length).toBeGreaterThan(0);

    // Verify audit_log row: org_member_added via invitation_accept.
    // audit_log is append-only; scope by timestamp to avoid cross-test bleed.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetOrganizationId, orgId),
          eq(auditLog.targetUserId, inviteeUserId),
          eq(auditLog.action, "org_member_added"),
          gte(auditLog.performedAt, acceptStart),
        ),
      );
    expect(auditRows.length).toBe(1);
    const auditRow = auditRows[0];
    expect(auditRow.actorUserId).toBe(inviteeUserId);
    const auditPayload = auditRow.payload as Record<string, unknown>;
    expect(auditPayload.org_id).toBe(orgId);
    expect(auditPayload.member_user_id).toBe(inviteeUserId);
    expect(auditPayload.role).toBe("volunteer");
    expect(auditPayload.how).toBe("invitation_accept");
    expect(typeof auditPayload.invitation_id).toBe("string");

    // Cleanup.
    await removeMembership(inviteeUserId);
  });

  it("accept after expiry → rejected", async () => {
    await clearInvitations();

    // Insert an expired invitation directly.
    const expiredToken = "INV-EXPI-RED1";
    await db.insert(organizationInvitations).values({
      organizationId: orgId,
      email: INVITEE_EMAIL,
      invitedRole: "volunteer",
      invitedByUserId: adminUserId,
      invitationToken: expiredToken,
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    mockSessionAs(inviteeUserId, INVITEE_EMAIL);
    const result = await acceptInvitationAction({ invitationToken: expiredToken });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toContain("expiró");
  });

  it("accept after revoke → rejected", async () => {
    await clearInvitations();

    // Insert a revoked invitation.
    const revokedToken = "INV-REVK-ED01";
    await db.insert(organizationInvitations).values({
      organizationId: orgId,
      email: INVITEE_EMAIL,
      invitedRole: "volunteer",
      invitedByUserId: adminUserId,
      invitationToken: revokedToken,
      revokedAt: new Date(),
    });

    mockSessionAs(inviteeUserId, INVITEE_EMAIL);
    const result = await acceptInvitationAction({ invitationToken: revokedToken });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toContain("revocada");
  });

  it("accept already-accepted → rejected", async () => {
    await clearInvitations();

    const alreadyToken = "INV-ALRD-Y001";
    await db.insert(organizationInvitations).values({
      organizationId: orgId,
      email: INVITEE_EMAIL,
      invitedRole: "volunteer",
      invitedByUserId: adminUserId,
      invitationToken: alreadyToken,
      acceptedAt: new Date(),
      acceptedByUserId: inviteeUserId,
    });

    mockSessionAs(inviteeUserId, INVITEE_EMAIL);
    const result = await acceptInvitationAction({ invitationToken: alreadyToken });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toContain("ya fue aceptada");
  });

  it("accept with mismatched email → rejected", async () => {
    await clearInvitations();

    mockSessionAs(adminUserId, ADMIN_EMAIL);
    const invite = await inviteMemberAction({
      organizationId: orgId,
      email: INVITEE_EMAIL,
      invitedRole: "member",
    });
    expect("error" in invite).toBe(false);
    if ("error" in invite) throw new Error(invite.error);
    const token = invite.inviteUrl.split("/r/invite/")[1];

    // invitee2 tries to accept an invite meant for invitee.
    mockSessionAs(invitee2UserId, INVITEE2_EMAIL);
    const result = await acceptInvitationAction({ invitationToken: token });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toContain("no es para tu cuenta");
  });

  it("accept when no session → rejected", async () => {
    await clearInvitations();

    mockSessionAs(adminUserId, ADMIN_EMAIL);
    const invite = await inviteMemberAction({
      organizationId: orgId,
      email: INVITEE_EMAIL,
      invitedRole: "member",
    });
    expect("error" in invite).toBe(false);
    if ("error" in invite) throw new Error(invite.error);
    const token = invite.inviteUrl.split("/r/invite/")[1];

    mockNoSession();
    const result = await acceptInvitationAction({ invitationToken: token });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toContain("Sesión");
  });

  it("accept when already a member → idempotent success", async () => {
    await clearInvitations();

    // invitee is already a member from a previous test; re-add explicitly.
    await removeMembership(inviteeUserId);
    await db.insert(organizationMemberships).values({
      organizationId: orgId,
      userId: inviteeUserId,
      role: "member",
      canWritePetEvents: false,
    });

    mockSessionAs(adminUserId, ADMIN_EMAIL);
    const invite = await inviteMemberAction({
      organizationId: orgId,
      email: INVITEE_EMAIL,
      invitedRole: "volunteer",
    });
    expect("error" in invite).toBe(false);
    if ("error" in invite) throw new Error(invite.error);
    const token = invite.inviteUrl.split("/r/invite/")[1];

    mockSessionAs(inviteeUserId, INVITEE_EMAIL);
    const result = await acceptInvitationAction({ invitationToken: token });

    // Should return ok (idempotent) with the org token.
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect(result.orgToken).toBe(orgPublicToken);

    // Cleanup.
    await removeMembership(inviteeUserId);
  });
});

describe("revokeInvitationAction", () => {
  it("happy path: sets revoked_at", async () => {
    await clearInvitations();

    mockSessionAs(adminUserId, ADMIN_EMAIL);
    const invite = await inviteMemberAction({
      organizationId: orgId,
      email: "to-revoke@example.com",
      invitedRole: "member",
    });
    expect("error" in invite).toBe(false);
    if ("error" in invite) throw new Error(invite.error);
    const token = invite.inviteUrl.split("/r/invite/")[1];

    const revoke = await revokeInvitationAction({
      organizationId: orgId,
      invitationToken: token,
    });
    expect("error" in revoke).toBe(false);
    if ("error" in revoke) throw new Error(revoke.error);
    expect(revoke.ok).toBe(true);

    const [row] = await db
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.invitationToken, token))
      .limit(1);
    expect(row.revokedAt).not.toBeNull();
  });

  it("revoke is idempotent (already-revoked returns ok)", async () => {
    await clearInvitations();

    mockSessionAs(adminUserId, ADMIN_EMAIL);
    const invite = await inviteMemberAction({
      organizationId: orgId,
      email: "idempotent-revoke@example.com",
      invitedRole: "volunteer",
    });
    expect("error" in invite).toBe(false);
    if ("error" in invite) throw new Error(invite.error);
    const token = invite.inviteUrl.split("/r/invite/")[1];

    await revokeInvitationAction({ organizationId: orgId, invitationToken: token });
    const second = await revokeInvitationAction({
      organizationId: orgId,
      invitationToken: token,
    });
    expect("error" in second).toBe(false);
  });

  it("coordinator can revoke invitations they created", async () => {
    await clearInvitations();

    mockSessionAs(coordUserId, COORD_EMAIL);
    const invite = await inviteMemberAction({
      organizationId: orgId,
      email: "coord-revoke@example.com",
      invitedRole: "member",
    });
    expect("error" in invite).toBe(false);
    if ("error" in invite) throw new Error(invite.error);
    const token = invite.inviteUrl.split("/r/invite/")[1];

    const revoke = await revokeInvitationAction({
      organizationId: orgId,
      invitationToken: token,
    });
    expect("error" in revoke).toBe(false);
  });
});
