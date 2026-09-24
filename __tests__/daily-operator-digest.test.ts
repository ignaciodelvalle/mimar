// T2-N1 — recipient resolution, opt-out, and idempotency for the daily
// operator digest. Integration tests against the local Supabase/Postgres
// stack. Resend and the auth-admin email lookup are mocked (no real network,
// no dependency on fixture profiles having a matching auth.users row).
//
// Security review 2026-09-18 added: the deadline (M2), claim release on a
// failed send (M2), one mail per person (L3), the List-Unsubscribe headers and
// the unsubscribe route's GET-never-writes rule (M1). The route cases live here
// because they need the same real profiles row the digest writes.

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  approvalRequests,
  cases,
  db,
  govtAssignments,
  organizationMemberships,
  organizations,
  pets,
  profiles,
} from "@/db";
import { NextRequest } from "next/server";

import { GET as unsubscribeGET, POST as unsubscribePOST } from "@/app/api/digest/unsubscribe/route";
import { arCalendarDay, runDailyOperatorDigest } from "@/lib/infra/daily-operator-digest";
import { generateDigestUnsubscribeToken } from "@/lib/infra/digest-unsubscribe-token";

// vi.mock factories are hoisted above every import in this file, so anything
// they reference must be created via vi.hoisted (a plain top-level const
// would still be in the temporal dead zone when the factory runs).
type SendArgs = {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
};
const sendMock = vi.hoisted(() =>
  vi.fn(async (_args: SendArgs) => ({
    data: { id: "test-email-id" } as unknown,
    error: null as unknown,
  })),
);
const emailMapRef = vi.hoisted(() => ({ current: new Map<string, string>() }));
/** Called on every email lookup — lets a test move the clock mid-recipient. */
const lookupHook = vi.hoisted(() => ({ current: (_userId: string) => {} }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

// One targeted lookup per recipient (auth.admin.getUserById) — the digest no
// longer pages every auth user. A seed/demo profile has no entry here, so it is
// counted as skippedNoEmail and never claimed.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        getUserById: vi.fn(async (id: string) => {
          lookupHook.current(id);
          const email = emailMapRef.current.get(id);
          return { data: { user: email ? { id, email } : null }, error: null };
        }),
      },
    },
  })),
}));

const PROV = "Buenos Aires";
// A locality string unique to THIS run, not a real place name. govt_assignments
// only CHECK-constrains the province to the canonical list (jurisdiction_locality
// is free text) — using a run-unique value here (instead of a real locality like
// "La Plata") means this fixture's jurisdiction can never collide with a
// pre-existing seed/demo govt_assignments or approval_requests row, which a
// fixed real-place name did (measured: seed data already had pending vet
// requests in La Plata, so "govt with zero pending" was a false negative).
const LOCALITY = `Digest-Test-${randomUUID().slice(0, 8)}`;

const fixtureProfileIds: string[] = [];
const fixtureOrgIds: string[] = [];
const fixtureRequestIds: string[] = [];
const fixtureCaseIds: string[] = [];
const fixtureAssignmentIds: string[] = [];
const fixtureMembershipIds: string[] = [];
const fixturePetIds: string[] = [];

function next(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function makeGovtProfile(opts: { optOut?: boolean; deactivated?: boolean } = {}) {
  const id = randomUUID();
  await db.insert(profiles).values({
    id,
    role: "govt",
    accountType: "institutional",
    displayName: `Digest Govt ${id.slice(0, 8)}`,
    dailyDigestOptOut: opts.optOut ?? false,
    deactivatedAt: opts.deactivated ? new Date() : null,
  });
  fixtureProfileIds.push(id);
  emailMapRef.current.set(id, `${id}@dim-test.local`);
  return id;
}

async function assignJurisdiction(userId: string, locality: string = LOCALITY) {
  const [row] = await db
    .insert(govtAssignments)
    .values({ userId, jurisdictionProvince: PROV, jurisdictionLocality: locality })
    .returning({ id: govtAssignments.id });
  fixtureAssignmentIds.push(row.id);
}

// visibleRequestsClause scopes by JURISDICTION TUPLE, not by which govt is the
// applicant — a govt sees every pending request in their assigned (province,
// locality), regardless of who filed it. Two govt fixtures assigned to the
// SAME locality would therefore always see each other's pending requests too,
// which is why every caller below gives each govt fixture its OWN locality.
async function seedPendingVetRequest(applicantId: string, locality: string = LOCALITY) {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      publicToken: next("APR"),
      type: "role_upgrade_vet",
      status: "pending",
      applicantUserId: applicantId,
      initiatedBy: "self",
      targetUserId: applicantId,
      jurisdictionProvince: PROV,
      jurisdictionLocality: locality,
      payload: {},
    })
    .returning({ id: approvalRequests.id });
  fixtureRequestIds.push(row.id);
}

async function makeOrgWithOpenCase(memberOptOut = false, existingUserId?: string) {
  const orgId = randomUUID();
  const userId = existingUserId ?? randomUUID();
  if (!existingUserId) {
    await db.insert(profiles).values({
      id: userId,
      role: "owner",
      accountType: "personal",
      displayName: `Digest Org Member ${userId.slice(0, 8)}`,
      dailyDigestOptOut: memberOptOut,
    });
    fixtureProfileIds.push(userId);
    emailMapRef.current.set(userId, `${userId}@dim-test.local`);
  }

  const [org] = await db
    .insert(organizations)
    .values({
      id: orgId,
      publicToken: next("ORG"),
      legalName: "Digest Test Org",
      displayName: "Digest Test Org",
      orgType: "shelter",
      email: `${next("org")}@dim-test.local`,
      status: "active",
    })
    .returning({ id: organizations.id });
  fixtureOrgIds.push(org.id);

  const [membership] = await db
    .insert(organizationMemberships)
    .values({ organizationId: org.id, userId, role: "admin" })
    .returning({ id: organizationMemberships.id });
  fixtureMembershipIds.push(membership.id);

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: next("DIM"),
      name: "Digest Test Pet",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning({ id: pets.id });
  fixturePetIds.push(pet.id);

  const [caseRow] = await db
    .insert(cases)
    .values({
      publicCode: next("CASE"),
      caseKind: "welfare_derived",
      primarySubjectKind: "registered_pet",
      primaryPetId: pet.id,
      openedByOrganizationId: org.id,
    })
    .returning({ id: cases.id });
  fixtureCaseIds.push(caseRow.id);

  return userId;
}

async function cleanup() {
  for (const id of fixtureCaseIds.splice(0)) {
    await db
      .delete(cases)
      .where(eq(cases.id, id))
      .catch(() => {});
  }
  for (const id of fixturePetIds.splice(0)) {
    await db
      .delete(pets)
      .where(eq(pets.id, id))
      .catch(() => {});
  }
  for (const id of fixtureMembershipIds.splice(0)) {
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.id, id))
      .catch(() => {});
  }
  for (const id of fixtureOrgIds.splice(0)) {
    await db
      .delete(organizations)
      .where(eq(organizations.id, id))
      .catch(() => {});
  }
  for (const id of fixtureRequestIds.splice(0)) {
    await db
      .delete(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .catch(() => {});
  }
  for (const id of fixtureAssignmentIds.splice(0)) {
    await db
      .delete(govtAssignments)
      .where(eq(govtAssignments.id, id))
      .catch(() => {});
  }
  for (const id of fixtureProfileIds.splice(0)) {
    await db
      .delete(profiles)
      .where(eq(profiles.id, id))
      .catch(() => {});
  }
  emailMapRef.current = new Map();
  lookupHook.current = () => {};
}

async function lastSentOn(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ lastSent: profiles.dailyDigestLastSentOn })
    .from(profiles)
    .where(eq(profiles.id, userId));
  return row?.lastSent ?? null;
}

async function optedOut(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ optOut: profiles.dailyDigestOptOut })
    .from(profiles)
    .where(eq(profiles.id, userId));
  return row?.optOut ?? false;
}

/** A govt fixture with one pending request in its OWN locality. */
async function govtWithPending(): Promise<string> {
  const id = await makeGovtProfile();
  const locality = `${LOCALITY}-${id.slice(0, 6)}`;
  await assignJurisdiction(id, locality);
  await seedPendingVetRequest(id, locality);
  return id;
}

const RESEND_ENV = {
  RESEND_API_KEY: "test-key",
  RESEND_FROM: "miMAR <digest-test@mimar.com.ar>",
  NEXT_PUBLIC_SITE_URL: "https://mimar.com.ar",
};

describe("runDailyOperatorDigest", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    sendMock.mockClear();
    Object.assign(process.env, RESEND_ENV);
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await cleanup();
  });

  /** Every `to` address the mock was called with, across the whole run. */
  function sentToAddresses(): string[] {
    return sendMock.mock.calls.map(([arg]) => (arg as { to: string }).to);
  }

  it("sends to a govt with a pending queue, skips one with zero pending, and never sends to an opted-out account", async () => {
    const govtWithPending = await makeGovtProfile();
    const localityA = `${LOCALITY}-A`;
    await assignJurisdiction(govtWithPending, localityA);
    await seedPendingVetRequest(govtWithPending, localityA);

    const govtWithNoPending = await makeGovtProfile();
    await assignJurisdiction(govtWithNoPending, `${LOCALITY}-B`);

    const govtOptedOut = await makeGovtProfile({ optOut: true });
    const localityC = `${LOCALITY}-C`;
    await assignJurisdiction(govtOptedOut, localityC);
    await seedPendingVetRequest(govtOptedOut, localityC);

    const result = await runDailyOperatorDigest();

    // The DB is shared with pre-existing seed/demo accounts that may ALSO be
    // eligible govt recipients today, so this asserts our three fixtures'
    // presence/absence specifically — never a total call count, which the
    // seed data would make flaky.
    expect(result.mailChannel).toBe("configured");
    const addresses = sentToAddresses();
    expect(addresses).toContain(`${govtWithPending}@dim-test.local`);
    expect(addresses).not.toContain(`${govtWithNoPending}@dim-test.local`);
    expect(addresses).not.toContain(`${govtOptedOut}@dim-test.local`);

    const [row] = await db
      .select({ lastSent: profiles.dailyDigestLastSentOn })
      .from(profiles)
      .where(eq(profiles.id, govtWithPending));
    expect(row?.lastSent).toBe(arCalendarDay());
  });

  it("never sends to a deactivated govt account, even with a pending queue", async () => {
    const deactivated = await makeGovtProfile({ deactivated: true });
    await assignJurisdiction(deactivated);
    await seedPendingVetRequest(deactivated);

    await runDailyOperatorDigest();

    expect(sentToAddresses()).not.toContain(`${deactivated}@dim-test.local`);
  });

  it("is idempotent — a second run the same day does not send twice to the same recipient", async () => {
    const govt = await makeGovtProfile();
    await assignJurisdiction(govt);
    await seedPendingVetRequest(govt);

    await runDailyOperatorDigest();
    const callsAfterFirst = sentToAddresses().filter((a) => a === `${govt}@dim-test.local`);
    expect(callsAfterFirst).toHaveLength(1);

    sendMock.mockClear();
    const second = await runDailyOperatorDigest();
    const callsAfterSecond = sentToAddresses().filter((a) => a === `${govt}@dim-test.local`);
    expect(callsAfterSecond).toHaveLength(0);
    expect(second.alreadySentToday).toBeGreaterThanOrEqual(1);
  });

  it("sends to an org member with an open case in their org's queue", async () => {
    const orgMember = await makeOrgWithOpenCase();

    await runDailyOperatorDigest();

    const call = sendMock.mock.calls.find(
      ([arg]) => (arg as { to: string }).to === `${orgMember}@dim-test.local`,
    )?.[0] as { to: string; html: string } | undefined;
    expect(call).toBeDefined();
    expect(call?.html).toContain("organización");
  });

  it("respects an org member's opt-out", async () => {
    const orgMember = await makeOrgWithOpenCase(true);

    await runDailyOperatorDigest();

    expect(sentToAddresses()).not.toContain(`${orgMember}@dim-test.local`);
  });

  it("degrades to a logged skip (never crashes) when the mail channel is unconfigured", async () => {
    // process.env is string-keyed — assigning `undefined` coerces to the
    // STRING "undefined" in Node, which would make deriveOutboundChannels'
    // `present()` check see a truthy key. delete is the only way to make
    // RESEND_API_KEY genuinely absent here.
    // biome-ignore lint/performance/noDelete: see above.
    delete process.env.RESEND_API_KEY;
    const govt = await makeGovtProfile();
    await assignJurisdiction(govt);
    await seedPendingVetRequest(govt);

    const result = await runDailyOperatorDigest();

    expect(result.mailChannel).not.toBe("configured");
    expect(result.sent).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();

    // And the send was never claimed — tomorrow (once mail is configured
    // again) this user is still eligible.
    const [row] = await db
      .select({ lastSent: profiles.dailyDigestLastSentOn })
      .from(profiles)
      .where(eq(profiles.id, govt));
    expect(row?.lastSent ?? null).toBeNull();
  });
});

describe("runDailyOperatorDigest — security review 2026-09-18", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    sendMock.mockClear();
    Object.assign(process.env, RESEND_ENV);
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await cleanup();
  });

  const sentTo = (userId: string) =>
    sendMock.mock.calls
      .map(([arg]) => arg as SendArgs)
      .filter((arg) => arg.to === `${userId}@dim-test.local`);

  it("M2: stops at the deadline — the next recipient is neither claimed nor sent", async () => {
    const a = await govtWithPending();
    const b = await govtWithPending();

    // A fake clock that jumps past the deadline the moment the first mail goes.
    // Only fixtures have an email, so the first send is always one of ours.
    let clock = 0;
    sendMock.mockImplementationOnce(async () => {
      clock = 10_000;
      return { data: { id: "first" }, error: null };
    });

    const result = await runDailyOperatorDigest({ budgetMs: 1_000, now: () => clock });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
    expect(result.deferredByDeadline).toBeGreaterThanOrEqual(1);
    // Exactly one of the two got today's digest; the other is untouched and
    // stays first in line for the next run.
    const stamps = [await lastSentOn(a), await lastSentOn(b)];
    expect(stamps.filter((s) => s === arCalendarDay())).toHaveLength(1);
    expect(stamps.filter((s) => s === null)).toHaveLength(1);
  });

  it("M2: a deadline hit mid-recipient stops BEFORE the claim — never claimed-but-unsent", async () => {
    const govt = await govtWithPending();
    let clock = 0;
    // The clock runs out while this recipient's email is being looked up —
    // after its counts, before its claim.
    lookupHook.current = (id) => {
      if (id === govt) clock = 10_000;
    };

    const result = await runDailyOperatorDigest({ budgetMs: 1_000, now: () => clock });

    expect(sentTo(govt)).toHaveLength(0);
    expect(await lastSentOn(govt)).toBeNull();
    expect(result.deferredByDeadline).toBeGreaterThanOrEqual(1);
  });

  it("M2: a failed send RELEASES the claim, so a retry the same day sends", async () => {
    const govt = await govtWithPending();
    sendMock.mockImplementationOnce(async () => ({
      data: null,
      error: { name: "application_error", message: "resend is down" },
    }));

    const failed = await runDailyOperatorDigest();
    expect(failed.errors).toBeGreaterThanOrEqual(1);
    expect(await lastSentOn(govt)).toBeNull();

    const retried = await runDailyOperatorDigest();
    expect(retried.sent).toBeGreaterThanOrEqual(1);
    expect(sentTo(govt)).toHaveLength(2);
    expect(await lastSentOn(govt)).toBe(arCalendarDay());
  });

  it("M2: a THROWING send releases the claim too", async () => {
    const govt = await govtWithPending();
    sendMock.mockImplementationOnce(async () => {
      throw new Error("socket hang up");
    });

    await runDailyOperatorDigest();

    expect(await lastSentOn(govt)).toBeNull();
  });

  it("L3: a govt operator who is also an org member gets ONE mail with both panels", async () => {
    const govt = await govtWithPending();
    await makeOrgWithOpenCase(false, govt);

    await runDailyOperatorDigest();

    const mails = sentTo(govt);
    expect(mails).toHaveLength(1);
    expect(mails[0].html).toContain("Tu panel de gobierno");
    expect(mails[0].html).toContain("Tu panel de organización");
  });

  it("M1: every digest carries RFC 2369 / RFC 8058 one-click unsubscribe headers", async () => {
    const govt = await govtWithPending();

    await runDailyOperatorDigest();

    const [mail] = sentTo(govt);
    expect(mail?.headers?.["List-Unsubscribe"]).toBe(
      `<https://mimar.com.ar/api/digest/unsubscribe?u=${govt}&t=${generateDigestUnsubscribeToken(govt)}>`,
    );
    expect(mail?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

describe("/api/digest/unsubscribe — GET never writes (security review 2026-09-18, M1)", () => {
  afterEach(cleanup);

  const BASE = "https://mimar.com.ar/api/digest/unsubscribe";
  const linkFor = (userId: string, token = generateDigestUnsubscribeToken(userId)) =>
    `${BASE}?u=${userId}&t=${token}`;
  const formPost = (url: string, fields: Record<string, string>) =>
    new NextRequest(url, {
      method: "POST",
      body: new URLSearchParams(fields).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

  it("GET with a valid link renders a confirm form and does NOT opt the user out", async () => {
    const user = await makeGovtProfile();

    const res = await unsubscribeGET(new NextRequest(linkFor(user)));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<form method="post"');
    expect(html).toContain(`name="u" value="${user}"`);
    // THE POINT: a mail scanner fetching this link changes nothing.
    expect(await optedOut(user)).toBe(false);
  });

  it("POST from the confirm form opts the user out", async () => {
    const user = await makeGovtProfile();
    const t = generateDigestUnsubscribeToken(user);

    const res = await unsubscribePOST(formPost(BASE, { u: user, t }));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Listo");
    expect(await optedOut(user)).toBe(true);
  });

  it("RFC 8058 one-click POST (u, t in the URL) opts the user out", async () => {
    const user = await makeGovtProfile();

    const res = await unsubscribePOST(formPost(linkFor(user), { "List-Unsubscribe": "One-Click" }));

    expect(res.status).toBe(200);
    expect(await optedOut(user)).toBe(true);
  });

  it("a forged token changes nothing, on either verb", async () => {
    const user = await makeGovtProfile();
    const other = await makeGovtProfile();
    const stolen = generateDigestUnsubscribeToken(other);

    const get = await unsubscribeGET(new NextRequest(linkFor(user, stolen)));
    expect(await get.text()).toContain("Enlace inválido");
    const oneClick = await unsubscribePOST(
      formPost(linkFor(user, stolen), { "List-Unsubscribe": "One-Click" }),
    );
    expect(oneClick.status).toBe(400);
    await unsubscribePOST(formPost(BASE, { u: user, t: stolen }));

    expect(await optedOut(user)).toBe(false);
  });

  it("never reflects request input into the page (XSS)", async () => {
    const payload = '"><script>alert(1)</script>';
    const res = await unsubscribeGET(
      new NextRequest(`${BASE}?u=${encodeURIComponent(payload)}&t=${encodeURIComponent(payload)}`),
    );
    const html = await res.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("Enlace inválido");
  });
});
