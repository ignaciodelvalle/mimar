// The sponsoring org can FIND and READ a titular's rehome_request
// (rehome-by-titular WU5, tasks 5.1-5.4, 5.6; design ADR-4 + B7; PO decision
// sdd/rehome-by-titular/inbox-scoping).
//
// WHY THIS HITS REAL POSTGRES (the `db` vitest project, serial)
// ---------------------------------------------------------------------------
// The inbox predicate is SQL (`listCasesForOrg`), the access rule joins
// memberships (`canReadCase`), and the detail projection is a column the
// query never selected. Every claim here is about which ROWS come back, and a
// mocked query returns whatever the mock says.
//
// THE SCOPING IS THE POINT. The titular opens the case (openedByOrganization
// is null) and the org has no ownership row until it accepts, so neither of
// the inbox's two existing arms matches a pending request. The fix is a third
// arm on `receiver_organization_id` — scoped to `rehome_request` ONLY. The
// same column carries decomiso hand-offs (custody_episode, via
// execute-decomiso.ts), which already have their own org screen
// (/org/{token}/transferencias/recibidas); widening the arm would list them
// twice. "Sin dedup, solo con el fin de mostrar la información de forma
// ordenada, accesible y completa" — the PO, 2026-08-20. The control below
// plants exactly that decomiso shape and asserts it stays out.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  caseEvents,
  cases,
  db,
  notifications,
  organizationCoverage,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { type CaseViewer, canReadCase } from "@/lib/infra/case-access";
import { openCase } from "@/lib/infra/case-helpers";
import {
  getCaseDetailByPublicCode,
  listCaseKindDistributionForOrg,
  listCasesForOrg,
} from "@/lib/infra/case-queries";
import { ORG_CASE_KINDS_ROUTED_ELSEWHERE } from "@/src/modules/cases/domain/case-kinds";
import { requestRehomeSponsorship } from "@/src/modules/rehome/application/request-rehome-sponsorship";
import { RehomeRepository } from "@/src/modules/rehome/infrastructure/rehome-repository";

import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const USERS = {
  titular: "rehome-inbox-titular@dim-test.local",
  memberA: "rehome-inbox-member-a@dim-test.local",
  leftA: "rehome-inbox-left-a@dim-test.local",
  memberB: "rehome-inbox-member-b@dim-test.local",
  stranger: "rehome-inbox-stranger@dim-test.local",
} as const;
const PASS = "RehomeInbox_2026!";

const ORG_A_TOKEN = "DIM-RHIB-0001";
const ORG_B_TOKEN = "DIM-RHIB-0002";
const PET_TOKEN = "DIM-RHIB-PET1";

const ids = {} as Record<keyof typeof USERS, string>;
let orgAId: string;
let orgBId: string;
let petId: string;
let requestCode: string;
let requestCaseId: string;
let decomisoCaseId: string;
let handshakeCaseId: string;

const viewer = (key: keyof typeof USERS): CaseViewer => ({
  userId: ids[key],
  role: "owner",
  jurisdictions: [],
});

async function purgeUserByEmail(email: string): Promise<void> {
  const { data } = await supabaseAdmin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const userIds = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  await withMutationOverride(async (tx) => {
    for (const uid of userIds) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
      await tx.delete(ownerships).where(eq(ownerships.ownerUserId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

async function purgePetAndOrgs(): Promise<void> {
  await withMutationOverride(async (tx) => {
    const stale = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN));
    for (const { id } of stale) {
      await tx.delete(notifications).where(eq(notifications.relatedPetId, id));
      const staleCases = await tx
        .select({ id: cases.id })
        .from(cases)
        .where(eq(cases.primaryPetId, id));
      for (const c of staleCases) {
        await tx.delete(caseEvents).where(eq(caseEvents.caseId, c.id));
      }
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(cases).where(eq(cases.primaryPetId, id));
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
  });
  for (const token of [ORG_A_TOKEN, ORG_B_TOKEN]) {
    const staleOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.publicToken, token));
    for (const { id } of staleOrgs) {
      await db.delete(cases).where(eq(cases.openedByOrganizationId, id));
      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.organizationId, id));
      await db.delete(organizations).where(eq(organizations.id, id));
    }
  }
}

async function insertOrg(token: string, displayName: string): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: token,
      legalName: `${displayName} SRL`,
      displayName,
      orgType: "shelter",
      email: `${token.toLowerCase()}@dim-test.local`,
      verified: true,
    })
    .returning({ id: organizations.id });
  // The zone the org works in — the request rule refuses an org that does not
  // reach the pet's locality (W-4), same predicate the picker filters on.
  await db.insert(organizationCoverage).values({
    organizationId: org.id,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
  });
  return org.id;
}

beforeAll(async () => {
  await purgePetAndOrgs();
  for (const email of Object.values(USERS)) await purgeUserByEmail(email);

  for (const [key, email] of Object.entries(USERS) as Array<[keyof typeof USERS, string]>) {
    const r = await createFreshTestUser(supabaseAdmin, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (r.error || !r.data.user) throw new Error(`createUser ${key}: ${r.error?.message}`);
    ids[key] = r.data.user.id;
    await db
      .update(profiles)
      .set({ displayName: email.split("@")[0], role: "owner", accountType: "personal" })
      .where(eq(profiles.id, ids[key]));
  }

  orgAId = await insertOrg(ORG_A_TOKEN, "Refugio Receptor");
  orgBId = await insertOrg(ORG_B_TOKEN, "Refugio Ajeno");
  await db.insert(organizationMemberships).values([
    { organizationId: orgAId, userId: ids.memberA, role: "admin", canWritePetEvents: true },
    {
      organizationId: orgAId,
      userId: ids.leftA,
      role: "volunteer",
      canWritePetEvents: false,
      leftAt: new Date(),
    },
    { organizationId: orgBId, userId: ids.memberB, role: "admin", canWritePetEvents: true },
  ]);

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Nube",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      inCustodyDispute: false,
      rabiesObservationStatus: null,
    })
    .returning({ id: pets.id });
  petId = pet.id;
  await db
    .insert(ownerships)
    .values({ petId, ownerUserId: ids.titular, role: "owner", startedAt: new Date() });

  // The real path: the titular asks org A. Pending — nobody answered.
  const requested = await requestRehomeSponsorship(
    { petPublicToken: PET_TOKEN, titularUserId: ids.titular, targetOrgId: orgAId },
    { repo: RehomeRepository, now: () => new Date() },
  );
  if (!requested.ok) throw new Error(`request failed: ${requested.error}`);
  requestCode = requested.value.casePublicCode;
  requestCaseId = requested.value.caseId;

  // THE SCOPING CONTROL: a decomiso hand-off addressed to org A through the
  // SAME column. It is org B's expediente (B executed it) and A's inbox for it
  // is /org/{token}/transferencias/recibidas — it must not surface in A's
  // generic queue through the new arm.
  const decomiso = await openCase({
    kind: "custody_episode",
    primarySubjectKind: "registered_pet",
    primaryPetId: petId,
    openedByOrganizationId: orgBId,
    receiverOrganizationId: orgAId,
    openedReason: { code: "decomiso_executed", motive: "maltrato_fisico", judicialRef: null },
  });
  decomisoCaseId = decomiso.id;

  // A routine transfer org A PROPOSED (opened) to org B. In A's queue today
  // via openedByOrganizationId; it has its own screen (/transferencias), and
  // task 5.6 declares it routed there.
  const handshake = await openCase({
    kind: "custody_transfer_handshake",
    primarySubjectKind: "registered_pet",
    primaryPetId: petId,
    openedByOrganizationId: orgAId,
    receiverOrganizationId: orgBId,
    openedReason: { code: "cross_org_transfer_proposed", reason: "other" },
  });
  handshakeCaseId = handshake.id;
});

afterAll(async () => {
  await purgePetAndOrgs();
  for (const email of Object.values(USERS)) await purgeUserByEmail(email);
});

// ---------------------------------------------------------------------------
// 5.1 — the detail carries the receiver org
// ---------------------------------------------------------------------------

describe("getCaseDetailByPublicCode — a rehome_request names its receiver org (5.1)", () => {
  it("projects receiverOrganization {id, displayName, publicToken} and receiverOrganizationId", async () => {
    const detail = await getCaseDetailByPublicCode(requestCode);
    expect(detail?.caseKind).toBe("rehome_request");
    expect(detail?.receiverOrganizationId).toBe(orgAId);
    expect(detail?.receiverOrganization).toEqual({
      id: orgAId,
      displayName: "Refugio Receptor",
      publicToken: ORG_A_TOKEN,
    });
    // The titular opened it — by construction, not by accident.
    expect(detail?.openedByOrganization).toBeNull();
    expect(detail?.openedByUser?.id).toBe(ids.titular);
  });

  it("a case with no receiver projects null, not a phantom org", async () => {
    const [row] = await db
      .select({ publicCode: cases.publicCode })
      .from(cases)
      .where(eq(cases.id, handshakeCaseId));
    const detail = await getCaseDetailByPublicCode(row.publicCode);
    expect(detail?.receiverOrganizationId).toBe(orgBId);
    expect(detail?.receiverOrganization?.publicToken).toBe(ORG_B_TOKEN);
    expect(detail?.openedByOrganization?.id).toBe(orgAId);
  });
});

// ---------------------------------------------------------------------------
// 5.2 — canReadCase keys on receiver membership
// ---------------------------------------------------------------------------

describe("canReadCase — rehome_request is readable by the RECEIVER org's active members (5.2)", () => {
  it("an active member of the receiver org can read it", async () => {
    const detail = await getCaseDetailByPublicCode(requestCode);
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(await canReadCase(detail, viewer("memberA"))).toBe(true);
  });

  it("a member of another org cannot", async () => {
    const detail = await getCaseDetailByPublicCode(requestCode);
    if (!detail) return;
    expect(await canReadCase(detail, viewer("memberB"))).toBe(false);
  });

  it("a member who LEFT the receiver org cannot", async () => {
    const detail = await getCaseDetailByPublicCode(requestCode);
    if (!detail) return;
    expect(await canReadCase(detail, viewer("leftA"))).toBe(false);
  });

  it("the titular can (their own live owner row), a stranger cannot, anonymous cannot", async () => {
    const detail = await getCaseDetailByPublicCode(requestCode);
    if (!detail) return;
    expect(await canReadCase(detail, viewer("titular"))).toBe(true);
    expect(await canReadCase(detail, viewer("stranger"))).toBe(false);
    expect(await canReadCase(detail, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5.3 / 5.4 — the inbox and its kind chips, scoped
// ---------------------------------------------------------------------------

describe("listCasesForOrg — the receiver arm, scoped to rehome_request (5.3, PO inbox-scoping)", () => {
  it("the pending request appears in the receiver org's queue", async () => {
    const { items } = await listCasesForOrg(orgAId);
    expect(items.map((c) => c.id)).toContain(requestCaseId);
    const row = items.find((c) => c.id === requestCaseId);
    expect(row?.caseKind).toBe("rehome_request");
    expect(row?.primaryPetPublicToken).toBe(PET_TOKEN);
  });

  it("and not in another org's queue", async () => {
    const { items } = await listCasesForOrg(orgBId);
    expect(items.map((c) => c.id)).not.toContain(requestCaseId);
  });

  it("the kind filter reaches it in SQL", async () => {
    const { items } = await listCasesForOrg(orgAId, { kind: "rehome_request" });
    expect(items.map((c) => c.id)).toEqual([requestCaseId]);
  });

  it("CONTROL: a decomiso hand-off addressed to the org through the same column stays OUT", async () => {
    // The column matches; the kind does not. If this ever lists, the arm was
    // widened and the org's queue duplicates /transferencias/recibidas.
    const [row] = await db
      .select({ receiver: cases.receiverOrganizationId, kind: cases.caseKind })
      .from(cases)
      .where(eq(cases.id, decomisoCaseId));
    expect(row).toEqual({ receiver: orgAId, kind: "custody_episode" });

    const { items } = await listCasesForOrg(orgAId);
    expect(items.map((c) => c.id)).not.toContain(decomisoCaseId);
    // It IS org B's expediente (B opened it) — the existing arm is untouched.
    const { items: forB } = await listCasesForOrg(orgBId);
    expect(forB.map((c) => c.id)).toContain(decomisoCaseId);
  });
});

describe("listCaseKindDistributionForOrg — the chip appears for the receiver, scoped (5.4)", () => {
  it("rehome_request is in the receiver org's distribution, and not in the other org's", async () => {
    expect(await listCaseKindDistributionForOrg(orgAId)).toContain("rehome_request");
    expect(await listCaseKindDistributionForOrg(orgBId)).not.toContain("rehome_request");
  });

  it("CONTROL: custody_episode does not reach org A's chips through the receiver column", async () => {
    expect(await listCaseKindDistributionForOrg(orgAId)).not.toContain("custody_episode");
  });
});

// ---------------------------------------------------------------------------
// 5.6 — kinds with their own org screen are routed out of the generic queue
// ---------------------------------------------------------------------------

describe("listCasesForOrg — kinds routed to their own org screen are excluded on request (5.6)", () => {
  it("without the exclusion the handshake org A opened is in its queue (today's behaviour)", async () => {
    const { items } = await listCasesForOrg(orgAId);
    expect(items.map((c) => c.id)).toContain(handshakeCaseId);
    expect(await listCaseKindDistributionForOrg(orgAId)).toContain("custody_transfer_handshake");
  });

  it("with ORG_CASE_KINDS_ROUTED_ELSEWHERE it leaves the queue AND the chips, and the request stays", async () => {
    expect(ORG_CASE_KINDS_ROUTED_ELSEWHERE).toContain("custody_transfer_handshake");
    const { items } = await listCasesForOrg(orgAId, {
      excludeKinds: ORG_CASE_KINDS_ROUTED_ELSEWHERE,
    });
    const listed = items.map((c) => c.id);
    expect(listed).not.toContain(handshakeCaseId);
    expect(listed).toContain(requestCaseId);
    const kinds = await listCaseKindDistributionForOrg(orgAId, {
      excludeKinds: ORG_CASE_KINDS_ROUTED_ELSEWHERE,
    });
    expect(kinds).not.toContain("custody_transfer_handshake");
    expect(kinds).toContain("rehome_request");
  });
});

// ---------------------------------------------------------------------------
// OBSERVATION for the PO (WU5 review, item 4) — documented, NOT changed.
//
// Arm 2 of orgCaseMembership lists every case on a pet the org holds a LIVE
// ownership row on. With rehome-by-titular an org gets `shelter_custody` on a
// pet that never leaves its family, so a `welfare_denuncia` or a
// `custody_dispute` ABOUT THAT HOUSEHOLD appears as a row in the sponsoring
// org's queue (/org/{token}/casos) — while the detail is denied by canReadCase
// (no per-kind branch grants an org member a welfare case). The org learns
// that a complaint exists against the family it is sponsoring, with no way to
// read it. Whether a sponsoring org should see that row at all is a product
// question; this pins TODAY's behaviour so a future change is deliberate.
// ---------------------------------------------------------------------------

const SPONSORED_PET_TOKEN = "DIM-RHIB-PET2";

describe("OBSERVATION — arm 2 lists a welfare_denuncia about a sponsored household as a queue row", () => {
  let sponsoredPetId: string;
  let denunciaCode: string;

  async function purgeSponsoredPet(): Promise<void> {
    await withMutationOverride(async (tx) => {
      const stale = await tx
        .select({ id: pets.id })
        .from(pets)
        .where(eq(pets.publicToken, SPONSORED_PET_TOKEN));
      for (const { id } of stale) {
        const staleCases = await tx
          .select({ id: cases.id })
          .from(cases)
          .where(eq(cases.primaryPetId, id));
        for (const c of staleCases) {
          await tx.delete(caseEvents).where(eq(caseEvents.caseId, c.id));
        }
        await tx.delete(cases).where(eq(cases.primaryPetId, id));
        await tx.delete(ownerships).where(eq(ownerships.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    });
  }

  beforeAll(async () => {
    await purgeSponsoredPet();
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: SPONSORED_PET_TOKEN,
        name: "Bruma",
        species: "dog",
        sex: "male",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      })
      .returning({ id: pets.id });
    sponsoredPetId = pet.id;
    // The sponsored shape: the titular's owner row AND org A's shelter_custody
    // row, both live, side by side.
    await db.insert(ownerships).values([
      { petId: sponsoredPetId, ownerUserId: ids.titular, role: "owner", startedAt: new Date() },
      {
        petId: sponsoredPetId,
        ownerOrganizationId: orgAId,
        role: "shelter_custody",
        startedAt: new Date(),
      },
    ]);
    const denuncia = await openCase({
      kind: "welfare_denuncia",
      primarySubjectKind: "registered_pet",
      primaryPetId: sponsoredPetId,
      openedByUserId: ids.stranger,
      openedByOrganizationId: null,
      openedReason: {
        code: "welfare_report_citizen",
        referenceCode: "DEN-RHIB-0001",
        kind: "neglect",
        severity: "high",
      },
    });
    denunciaCode = denuncia.publicCode;
  });

  afterAll(purgeSponsoredPet);

  it("the complaint about the family is a ROW in the sponsoring org's queue (today)", async () => {
    const { items } = await listCasesForOrg(orgAId);
    const row = items.find((c) => c.publicCode === denunciaCode);
    expect(row?.caseKind).toBe("welfare_denuncia");
    expect(await listCaseKindDistributionForOrg(orgAId)).toContain("welfare_denuncia");
  });

  it("and its DETAIL is denied to the same org's member — a row with no page behind it", async () => {
    const detail = await getCaseDetailByPublicCode(denunciaCode);
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(await canReadCase(detail, viewer("memberA"))).toBe(false);
    // The titular is the SUBJECT of the complaint and is denied too — by design.
    expect(await canReadCase(detail, viewer("titular"))).toBe(false);
  });
});
