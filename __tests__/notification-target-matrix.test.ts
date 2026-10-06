// Notification destinations against a REAL database — the matrix behind
// notificaciones-destinos (2026-10).
//
// WHY THIS HITS POSTGRES (the `db` vitest project, serial)
// ---------------------------------------------------------------------------
// The unit test (`resolve-notification-target.test.ts`) pins the RULE over fake
// probes. The claim the PO made is about the real thing: a notification never
// sends its reader to a page they cannot open. That claim lives in four access
// functions reading memberships, ownerships and cases — `canReadCase`,
// `resolvePetHolderAccess`, `getFormerOwnerReadAccess`, the org membership read
// — and only real rows can show they agree with the resolver.
//
// THE MATRIX. One recipient per notification kind family, in the states that
// break stored links: OPEN, RESOLVED, TRANSFERRED (custody left the reader) and
// MEMBERSHIP REVOKED (the reader left the org). For every cell the resolver's
// destination is re-checked with the destination's own access function: a
// `case` outcome must be readable, a `pet` outcome must be held (or the
// former-owner read must grant it), an org `section` must belong to an active
// membership. `explain` is always openable by construction.
//
// THE SQL MIRROR (last describe) needs migration
// 0281_case_read_transfer_and_custody_parties.sql APPLIED to the local
// database: it asserts `public.can_read_case` agrees with the TypeScript rule
// for the two new org-party arms. Before 0281 is applied it fails on exactly
// those cells, which is the point of it.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  caseEvents,
  cases,
  db,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
} from "@/db";
import { type CaseViewer, canReadCase, isActiveOrgMember } from "@/lib/infra/case-access";
import { closeCase, openCase } from "@/lib/infra/case-helpers";
import { getCaseDetailByPublicCode } from "@/lib/infra/case-queries";
import { readCaseForViewer, withholdFreeText } from "@/lib/infra/case-read";
import { getFormerOwnerReadAccess, resolvePetHolderAccess } from "@/lib/infra/pet-access";
import type { ResolvedNotificationTarget } from "@/src/modules/notifications/application/read/resolve-notification-target";
import { resolveOwnNotificationTarget } from "@/src/modules/notifications/infrastructure/notification-target-probes";

import { notificationTargetPorts } from "@/app/_composition/notification-target-ports";

import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser, deleteTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const USERS = {
  titular: "notif-matrix-titular@dim-test.local",
  coOwner: "notif-matrix-coowner@dim-test.local",
  formerOwner: "notif-matrix-former@dim-test.local",
  sold: "notif-matrix-sold@dim-test.local",
  buyer: "notif-matrix-buyer@dim-test.local",
  sender: "notif-matrix-sender@dim-test.local",
  receiver: "notif-matrix-receiver@dim-test.local",
  receiverLeft: "notif-matrix-receiver-left@dim-test.local",
  oldReceiver: "notif-matrix-old-receiver@dim-test.local",
  stranger: "notif-matrix-stranger@dim-test.local",
  receiverCoordinator: "notif-matrix-receiver-coord@dim-test.local",
  receiverVolunteer: "notif-matrix-receiver-vol@dim-test.local",
  reporterOrg: "notif-matrix-reporter@dim-test.local",
  reporterCoordinator: "notif-matrix-reporter-coord@dim-test.local",
  reporterVolunteer: "notif-matrix-reporter-vol@dim-test.local",
} as const;
type UserKey = keyof typeof USERS;
const PASS = "NotifMatrix_2026!";

const ORG_TOKENS = {
  sender: "DIM-NTMX-0001",
  receiver: "DIM-NTMX-0002",
  oldReceiver: "DIM-NTMX-0003",
  authority: "DIM-NTMX-0004",
  reporter: "DIM-NTMX-0005",
  stranger: "DIM-NTMX-0006",
} as const;
type OrgKey = keyof typeof ORG_TOKENS;

const PET_TOKENS = {
  home: "DIM-NTMX-PET1", // titular + co_owner; a bite case and a denuncia
  seized: "DIM-NTMX-PET2", // decomiso: former owner, custody_episode open
  sold: "DIM-NTMX-PET3", // transferred from `sold` to `buyer`
  shelter: "DIM-NTMX-PET4", // held by the sender org, in a cross-org handshake
  returned: "DIM-NTMX-PET5", // decomiso episodes: one returned to its owner, one accepted
} as const;
type PetKey = keyof typeof PET_TOKENS;

const ids = {} as Record<UserKey, string>;
const orgIds = {} as Record<OrgKey, string>;
const petIds = {} as Record<PetKey, string>;
const caseIds = {} as Record<
  | "handshakeOpen"
  | "handshakeClosed"
  | "episode"
  | "episodeReturned"
  | "episodeAccepted"
  | "bite"
  | "denuncia",
  string
>;
const caseCodes = {} as Record<keyof typeof caseIds, string>;

const viewer = (key: UserKey): CaseViewer => ({
  userId: ids[key],
  role: "owner",
  jurisdictions: [],
});

async function purgeFixtures(): Promise<void> {
  const petRows = await db
    .select({ id: pets.id })
    .from(pets)
    .where(inArray(pets.publicToken, Object.values(PET_TOKENS)));
  const orgRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(inArray(organizations.publicToken, Object.values(ORG_TOKENS)));
  await withMutationOverride(async (tx) => {
    for (const { id } of petRows) {
      await tx.delete(notifications).where(eq(notifications.relatedPetId, id));
      const petCases = await tx
        .select({ id: cases.id })
        .from(cases)
        .where(eq(cases.primaryPetId, id));
      for (const c of petCases) await tx.delete(caseEvents).where(eq(caseEvents.caseId, c.id));
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(cases).where(eq(cases.primaryPetId, id));
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
    for (const { id } of orgRows) {
      await tx.delete(cases).where(eq(cases.openedByOrganizationId, id));
      await tx
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.organizationId, id));
      await tx.delete(organizations).where(eq(organizations.id, id));
    }
  });
}

async function purgeUsers(): Promise<void> {
  for (const email of Object.values(USERS)) {
    const rows = (await db.execute(
      sql`select id from auth.users where email = ${email}`,
    )) as unknown as Array<{ id: string }>;
    for (const row of rows) {
      await db.delete(notifications).where(eq(notifications.userId, row.id));
      await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, row.id));
    }
    await deleteTestUser(supabaseAdmin, db, email);
  }
}

async function insertOrg(key: OrgKey, displayName: string): Promise<void> {
  const token = ORG_TOKENS[key];
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
  orgIds[key] = org.id;
}

async function insertPet(key: PetKey, name: string): Promise<void> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKENS[key],
      name,
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      inCustodyDispute: false,
      rabiesObservationStatus: null,
    })
    .returning({ id: pets.id });
  petIds[key] = pet.id;
}

async function notify(
  user: UserKey,
  notificationType: string,
  extra: { ctaUrl?: string | null; pet?: PetKey; caseKey?: keyof typeof caseIds; body?: string },
): Promise<string> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId: ids[user],
      notificationType,
      title: `Matriz: ${notificationType}`,
      body: extra.body ?? null,
      severity: "info",
      ctaLabel: extra.ctaUrl ? "Ver" : null,
      ctaUrl: extra.ctaUrl ?? null,
      relatedPetId: extra.pet ? petIds[extra.pet] : null,
      relatedCaseId: extra.caseKey ? caseIds[extra.caseKey] : null,
    })
    .returning({ id: notifications.id });
  return row.id;
}

const HOUR = 60 * 60 * 1000;

/** The custody_transferred event an accept path writes on a hand-off case. */
async function insertAcceptance(
  petId: string,
  caseId: string,
  toOrganizationId: string,
  reason: string,
): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    caseId,
    eventType: "custody_transferred",
    occurredAt: new Date(),
    authorRole: "shelter",
    payload: {
      from_user_id: null,
      from_organization_id: null,
      to_user_id: null,
      to_organization_id: toOrganizationId,
      from_role: "shelter_custody",
      to_role: "shelter_custody",
      reason,
      matched_against_pet_id: null,
      foster_ended_event_id: null,
      notes: null,
    },
  });
}

beforeAll(async () => {
  await purgeFixtures();
  await purgeUsers();

  for (const [key, email] of Object.entries(USERS) as Array<[UserKey, string]>) {
    const r = await createFreshTestUser(supabaseAdmin, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (r.error || !r.data.user) throw new Error(`createUser ${key}: ${r.error?.message}`);
    ids[key] = r.data.user.id;
  }

  await insertOrg("sender", "Refugio Emisor");
  await insertOrg("receiver", "Refugio Receptor");
  await insertOrg("oldReceiver", "Refugio Anterior");
  await insertOrg("authority", "Municipio de Prueba");
  await insertOrg("reporter", "Proteccionista Denunciante");
  await insertOrg("stranger", "Refugio Ajeno");
  await db.insert(organizationMemberships).values([
    { organizationId: orgIds.sender, userId: ids.sender, role: "admin", canWritePetEvents: true },
    {
      organizationId: orgIds.receiver,
      userId: ids.receiver,
      role: "admin",
      canWritePetEvents: true,
    },
    {
      organizationId: orgIds.receiver,
      userId: ids.receiverLeft,
      role: "volunteer",
      canWritePetEvents: false,
      leftAt: new Date(),
    },
    // S2: the hand-off arms admit admins and coordinators — the roles notified.
    {
      organizationId: orgIds.receiver,
      userId: ids.receiverCoordinator,
      role: "coordinator",
      canWritePetEvents: true,
    },
    {
      organizationId: orgIds.receiver,
      userId: ids.receiverVolunteer,
      role: "volunteer",
      canWritePetEvents: false,
    },
    {
      organizationId: orgIds.oldReceiver,
      userId: ids.oldReceiver,
      role: "admin",
      canWritePetEvents: true,
    },
    {
      organizationId: orgIds.reporter,
      userId: ids.reporterOrg,
      role: "admin",
      canWritePetEvents: true,
    },
    // PO 2026-10-06: the filing org's admins and coordinators read its denuncia.
    {
      organizationId: orgIds.reporter,
      userId: ids.reporterCoordinator,
      role: "coordinator",
      canWritePetEvents: true,
    },
    {
      organizationId: orgIds.reporter,
      userId: ids.reporterVolunteer,
      role: "volunteer",
      canWritePetEvents: false,
    },
    {
      organizationId: orgIds.stranger,
      userId: ids.stranger,
      role: "admin",
      canWritePetEvents: true,
    },
  ]);

  await insertPet("home", "Luna");
  await insertPet("seized", "Toto");
  await insertPet("sold", "Kira");
  await insertPet("shelter", "Bruno");
  await insertPet("returned", "Coco");
  const longAgo = new Date(Date.now() - 48 * HOUR);
  const anHourAgo = new Date(Date.now() - HOUR);
  await db.insert(ownerships).values([
    { petId: petIds.home, ownerUserId: ids.titular, role: "owner", startedAt: longAgo },
    { petId: petIds.home, ownerUserId: ids.coOwner, role: "co_owner", startedAt: longAgo },
    // The decomiso ended the titular's row; the episode below is still open.
    {
      petId: petIds.seized,
      ownerUserId: ids.formerOwner,
      role: "owner",
      startedAt: longAgo,
      endedAt: anHourAgo,
    },
    // Transferred: `sold` handed Kira to `buyer`.
    {
      petId: petIds.sold,
      ownerUserId: ids.sold,
      role: "owner",
      startedAt: longAgo,
      endedAt: anHourAgo,
    },
    { petId: petIds.sold, ownerUserId: ids.buyer, role: "owner", startedAt: anHourAgo },
    // Bruno lives at the sender org.
    {
      petId: petIds.shelter,
      ownerOrganizationId: orgIds.sender,
      role: "shelter_custody",
      startedAt: longAgo,
    },
  ]);

  const handshakeReason = { code: "cross_org_transfer_proposed", reason: "other" } as const;
  // RESOLVED first: the open-per-pet-kind index admits one open handshake.
  const closed = await openCase({
    kind: "custody_transfer_handshake",
    primarySubjectKind: "registered_pet",
    primaryPetId: petIds.shelter,
    openedByOrganizationId: orgIds.sender,
    receiverOrganizationId: orgIds.receiver,
    openedReason: handshakeReason,
  });
  // ACCEPTED: the event accept-cross-org-transfer writes on the case (F1 — a
  // 'resolved' close alone is not acceptance), then the close.
  await insertAcceptance(petIds.shelter, closed.id, orgIds.receiver, "other");
  await closeCase({ caseId: closed.id, reason: "resolved" });
  const open = await openCase({
    kind: "custody_transfer_handshake",
    primarySubjectKind: "registered_pet",
    primaryPetId: petIds.shelter,
    openedByOrganizationId: orgIds.sender,
    receiverOrganizationId: orgIds.receiver,
    openedReason: handshakeReason,
  });
  // The decomiso, REASSIGNED: oldReceiver was proposed first, receiver now.
  const episode = await openCase({
    kind: "custody_episode",
    primarySubjectKind: "registered_pet",
    primaryPetId: petIds.seized,
    openedByOrganizationId: orgIds.authority,
    receiverOrganizationId: orgIds.receiver,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    openedReason: { code: "decomiso_executed", motive: "maltrato_fisico", judicialRef: null },
  });
  const bite = await openCase({
    kind: "bite_incident",
    primarySubjectKind: "registered_pet",
    primaryPetId: petIds.home,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "minor" },
  });
  const denuncia = await openCase({
    kind: "welfare_denuncia",
    primarySubjectKind: "registered_pet",
    primaryPetId: petIds.home,
    openedByOrganizationId: orgIds.reporter,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    openedReason: {
      code: "welfare_report_org",
      referenceCode: "DEN-NTMX-0001",
      orgDisplayName: "Proteccionista Denunciante",
    },
  });
  caseIds.handshakeClosed = closed.id;
  caseIds.handshakeOpen = open.id;
  caseIds.episode = episode.id;
  caseIds.bite = bite.id;
  caseIds.denuncia = denuncia.id;

  // F1 — two decomiso episodes addressed to the receiver org on one pet. The
  // first is RETURNED to its owner: closed 'resolved' with no acceptance (what
  // return-custody-to-owner does). The second is ACCEPTED, then closed.
  const decomisoReason = {
    code: "decomiso_executed",
    motive: "maltrato_fisico",
    judicialRef: null,
  } as const;
  const returned = await openCase({
    kind: "custody_episode",
    primarySubjectKind: "registered_pet",
    primaryPetId: petIds.returned,
    openedByOrganizationId: orgIds.authority,
    receiverOrganizationId: orgIds.receiver,
    openedReason: decomisoReason,
  });
  await closeCase({ caseId: returned.id, reason: "resolved" });
  const accepted = await openCase({
    kind: "custody_episode",
    primarySubjectKind: "registered_pet",
    primaryPetId: petIds.returned,
    openedByOrganizationId: orgIds.authority,
    receiverOrganizationId: orgIds.receiver,
    openedReason: decomisoReason,
  });
  await insertAcceptance(petIds.returned, accepted.id, orgIds.receiver, "org_to_org_handoff");
  await closeCase({ caseId: accepted.id, reason: "resolved" });
  caseIds.episodeReturned = returned.id;
  caseIds.episodeAccepted = accepted.id;
  for (const [key, id] of Object.entries(caseIds) as Array<[keyof typeof caseIds, string]>) {
    const [row] = await db.select({ code: cases.publicCode }).from(cases).where(eq(cases.id, id));
    caseCodes[key] = row.code;
  }
  // S2: a free-form note on the open and on the accepted (closed) hand-off.
  await db.insert(caseEvents).values([
    {
      caseId: caseIds.handshakeOpen,
      entryType: "org_intervention_note",
      notes: NOTE_OPEN,
      payload: { note: PAYLOAD_OPEN },
    },
    { caseId: caseIds.handshakeClosed, entryType: "org_intervention_note", notes: NOTE_CLOSED },
    { caseId: caseIds.episodeReturned, entryType: "org_intervention_note", notes: NOTE_RETURNED },
    { caseId: caseIds.episodeAccepted, entryType: "org_intervention_note", notes: NOTE_ACCEPTED },
    // Third-party data on the denuncia: an investigator's note naming the
    // subject owner and a place. The filing org must never read it.
    {
      caseId: caseIds.denuncia,
      entryType: "org_intervention_note",
      notes: DENUNCIA_NOTE,
      payload: { note: DENUNCIA_NOTE, lat: -34.9, lng: -57.95 },
    },
  ]);
}, 120_000);

const NOTE_OPEN = "Nota interna: la familia vive en Calle Falsa 123.";
const PAYLOAD_OPEN = "Texto libre en el payload: Calle Falsa 123, timbre B.";
const NOTE_CLOSED = "Nota interna posterior a la aceptación.";
const NOTE_RETURNED = "Nota del decomiso devuelto a su dueño, nunca aceptado.";
const NOTE_ACCEPTED = "Nota del decomiso aceptado por el refugio.";
const DENUNCIA_NOTE = "El titular Juan Pérez, DNI terminado en 1234, vive en Calle 7 n.º 900.";

afterAll(async () => {
  await purgeFixtures();
  await purgeUsers();
}, 120_000);

/** Resolve the row for its own recipient — the path both front doors run. */
async function resolveFor(
  user: UserKey,
  notificationId: string,
): Promise<ResolvedNotificationTarget> {
  const target = await resolveOwnNotificationTarget(
    notificationId,
    viewer(user),
    notificationTargetPorts,
  );
  if (target === null) throw new Error(`no target for ${notificationId}`);
  return target;
}

/**
 * The invariant, checked with each destination's OWN access function: the
 * resolver never hands a reader somewhere that would refuse them.
 */
async function assertOpenable(user: UserKey, target: ResolvedNotificationTarget): Promise<void> {
  const segments = target.webHref.split("?")[0].split("/");
  if (target.outcome === "case") {
    const detail = await getCaseDetailByPublicCode(decodeURIComponent(segments[2]));
    expect(detail, target.webHref).not.toBeNull();
    if (detail) expect(await canReadCase(detail, viewer(user)), target.webHref).toBe(true);
  } else if (target.outcome === "pet") {
    const token = decodeURIComponent(segments[2]);
    const held = (await resolvePetHolderAccess(token, ids[user])).kind !== "none";
    const former = (await getFormerOwnerReadAccess(token, ids[user])).ok;
    expect(held || former, target.webHref).toBe(true);
  } else if (target.outcome === "section" && segments[1] === "org") {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.publicToken, decodeURIComponent(segments[2])));
    expect(await isActiveOrgMember(org.id, ids[user]), target.webHref).toBe(true);
  } else if (target.outcome === "explain") {
    expect(target.webHref).toBe(`/notificaciones/${target.notificationId}`);
    expect(target.reasonCopy).toBeTruthy();
  }
}

type Cell = {
  name: string;
  user: UserKey;
  type: string;
  cta?: () => string | null;
  pet?: PetKey;
  caseKey?: keyof typeof caseIds;
  body?: string;
  expect: Partial<ResolvedNotificationTarget>;
  actor?: RegExp;
};

const caseUrl = (key: keyof typeof caseIds) => () => `/casos/${caseCodes[key]}`;

const MATRIX: Cell[] = [
  // ---- cross-org transfer (custody_transfer_handshake) --------------------
  {
    name: "OPEN · receiver org member reads the proposal's case",
    user: "receiver",
    type: "cross_org_transfer_proposed_receiver",
    cta: caseUrl("handshakeOpen"),
    expect: { outcome: "case" },
    actor: /^Te toca a vos: aceptá o rechazá el traspaso\.$/,
  },
  {
    name: "OPEN · sender org member reads it and is told the receiver must act",
    user: "sender",
    type: "cross_org_transfer_proposed_sender",
    cta: caseUrl("handshakeOpen"),
    expect: { outcome: "case" },
    actor: /^Falta que Refugio Receptor acepte el traspaso\./,
  },
  {
    name: "RESOLVED · the sender reads the closed case and is told it is resolved",
    user: "sender",
    type: "cross_org_transfer_accepted_sender",
    cta: caseUrl("handshakeClosed"),
    expect: { outcome: "case" },
    actor: /^Esto ya se resolvió/,
  },
  {
    name: "MEMBERSHIP REVOKED · a receiver member who left gets the explanation",
    user: "receiverLeft",
    type: "cross_org_transfer_proposed_receiver",
    cta: caseUrl("handshakeOpen"),
    expect: { outcome: "explain", reason: "membership_ended" },
  },
  {
    name: "a member of an unrelated org gets the explanation, never the case",
    user: "stranger",
    type: "cross_org_transfer_proposed_receiver",
    cta: caseUrl("handshakeOpen"),
    expect: { outcome: "explain", reason: "case_not_available" },
  },
  {
    name: "cancelled receiver notice opens the org's received list for a member",
    user: "receiver",
    type: "cross_org_transfer_cancelled_receiver",
    cta: () => `/org/${ORG_TOKENS.receiver}/transferencias/recibidas`,
    expect: { outcome: "section", webOnly: true },
  },
  {
    name: "MEMBERSHIP REVOKED · the same list for an ex-member explains",
    user: "receiverLeft",
    type: "cross_org_transfer_cancelled_receiver",
    cta: () => `/org/${ORG_TOKENS.receiver}/transferencias/recibidas`,
    expect: { outcome: "explain", reason: "membership_ended" },
  },
  // ---- decomiso (custody_episode) -----------------------------------------
  {
    name: "OPEN · the receiving shelter reads the handoff case",
    user: "receiver",
    type: "decomiso_handoff_proposed_receiver",
    cta: caseUrl("episode"),
    expect: { outcome: "case" },
    actor: /^Te toca a vos: aceptá o rechazá recibir al animal\.$/,
  },
  {
    name: "REASSIGNED · the previous receiver is no longer a party, and is told to do nothing",
    user: "oldReceiver",
    type: "decomiso_handoff_proposed_receiver",
    cta: caseUrl("episode"),
    // R4: a refused case names nobody to act.
    expect: { outcome: "explain", reason: "case_not_available", actorCopy: null },
  },
  {
    name: "S2 · a coordinator of the receiving org reads the hand-off case",
    user: "receiverCoordinator",
    type: "decomiso_handoff_proposed_receiver",
    cta: caseUrl("episode"),
    expect: { outcome: "case" },
  },
  {
    name: "S2 · a volunteer of the receiving org is not a party to the hand-off",
    user: "receiverVolunteer",
    type: "cross_org_transfer_proposed_receiver",
    cta: caseUrl("handshakeOpen"),
    expect: { outcome: "explain", reason: "case_not_available", actorCopy: null },
  },
  {
    name: "TRANSFERRED (seized) · the former owner keeps the read-only pet face",
    user: "formerOwner",
    type: "decomiso_owner_lost_custody",
    cta: () => `/mis-mascotas/${PET_TOKENS.seized}`,
    pet: "seized",
    expect: { outcome: "pet", webHref: `/mis-mascotas/${PET_TOKENS.seized}` },
    actor: /^Lo decide la autoridad/,
  },
  // ---- citizen transfer ----------------------------------------------------
  {
    name: "TRANSFERRED · the seller is told the pet left them, with what happened",
    user: "sold",
    type: "pet_transfer_accepted",
    cta: () => "/mis-mascotas",
    pet: "sold",
    body: "La transferencia de Kira fue aceptada.",
    expect: { outcome: "explain", reason: "pet_no_longer_held" },
  },
  {
    name: "the buyer's pet notice opens the pet",
    user: "buyer",
    type: "first_stranger_scan",
    cta: () => `/mis-mascotas/${PET_TOKENS.sold}`,
    pet: "sold",
    expect: { outcome: "pet", appRoute: `/mascotas/${PET_TOKENS.sold}` },
  },
  // ---- cases on a co-held pet ---------------------------------------------
  {
    name: "the titular reads a case about their pet",
    user: "titular",
    type: "custody_dispute_raised_against_you",
    cta: caseUrl("bite"),
    pet: "home",
    caseKey: "bite",
    expect: { outcome: "case" },
  },
  {
    name: "a co_owner is told cases are titular-only (PO/legal pending), not 404",
    user: "coOwner",
    type: "custody_dispute_raised_against_you",
    cta: caseUrl("bite"),
    pet: "home",
    expect: { outcome: "explain", reason: "case_titular_only" },
  },
  {
    name: "the co_owner's pet-scoped notice opens the pet",
    user: "coOwner",
    type: "vaccine_due",
    cta: () => `/mis-mascotas/${PET_TOKENS.home}/eventos/nuevo/vacuna?reminderId=x`,
    pet: "home",
    expect: { outcome: "pet", appRoute: `/mascotas/${PET_TOKENS.home}/asentar?kind=vaccination` },
  },
  // ---- welfare denuncia opened by an org -----------------------------------
  {
    // PO 2026-10-06: no longer "reserved" — the filing org reads its denuncia.
    name: "the reporting org opens its own denuncia",
    user: "reporterCoordinator",
    type: "welfare_org_side_confirmed_reporter",
    cta: caseUrl("denuncia"),
    expect: { outcome: "case" },
    actor: /^Lo decide la autoridad de La Plata\./,
  },
  {
    name: "a volunteer of the reporting org is refused, plainly",
    user: "reporterVolunteer",
    type: "welfare_org_side_confirmed_reporter",
    cta: caseUrl("denuncia"),
    expect: { outcome: "explain", reason: "case_not_available", actorCopy: null },
  },
  {
    // Artificial (no writer sends this kind to the titular): it pins that the
    // subject's owner falls back to their OWN pet, never to the denuncia.
    name: "the titular of the denounced pet lands on their pet, never on the denuncia",
    user: "titular",
    type: "welfare_org_side_confirmed_reporter",
    cta: caseUrl("denuncia"),
    expect: { outcome: "pet", webHref: `/mis-mascotas/${PET_TOKENS.home}` },
  },
  // ---- informational -------------------------------------------------------
  {
    name: "an informational kind explains itself",
    user: "buyer",
    type: "pet_transfer_cancelled",
    pet: "sold",
    expect: { outcome: "explain", reason: "informational" },
  },
];

describe("notification destinations — every cell lands somewhere the reader can open", () => {
  for (const cell of MATRIX) {
    it(cell.name, async () => {
      const id = await notify(cell.user, cell.type, {
        ctaUrl: cell.cta ? cell.cta() : null,
        pet: cell.pet,
        caseKey: cell.caseKey,
        body: cell.body,
      });
      const target = await resolveFor(cell.user, id);
      expect(target).toMatchObject(cell.expect);
      if (cell.actor) expect(target.actorCopy ?? "").toMatch(cell.actor);
      await assertOpenable(cell.user, target);
    });
  }

  it("answers null — not somebody else's destination — for a row the caller does not own", async () => {
    const id = await notify("receiver", "cross_org_transfer_proposed_receiver", {
      ctaUrl: `/casos/${caseCodes.handshakeOpen}`,
    });
    expect(
      await resolveOwnNotificationTarget(id, viewer("stranger"), notificationTargetPorts),
    ).toBeNull();
  });
});

// S2 — an org party admitted by the 0281 arms reads the timeline WITHOUT the
// free-form notes until the hand-off is accepted (the case closed 'resolved').
// PO 2026-10-06 — the org that filed a welfare_denuncia reads it WITHOUT
// third-party data; the subject owner, other orgs and volunteers do not read it.
describe("a welfare denuncia read by the org that filed it", () => {
  it("the filing org's coordinator reads it, with no third-party data", async () => {
    const read = await readCaseForViewer(caseCodes.denuncia, viewer("reporterCoordinator"));
    expect(read.kind).toBe("readable");
    if (read.kind !== "readable") return;
    expect(read.detail.status).toBe("open");
    expect(read.timelineEvents.length).toBeGreaterThan(0);
    expect(read.detail.primaryLocationLat).toBeNull();
    expect(read.detail.closedByUser).toBeNull();
    const everything = JSON.stringify(read);
    expect(everything).not.toContain("Juan Pérez");
    expect(everything).not.toContain("Calle 7");
    expect(everything).not.toContain("-57.95");
    // The subject owner's identity never rides on this read.
    expect(everything).not.toContain(ids.titular);
  });

  it.each(["reporterVolunteer", "titular", "stranger", "coOwner"] as const)(
    "%s does not read it",
    async (user) => {
      const read = await readCaseForViewer(caseCodes.denuncia, viewer(user));
      expect(read.kind).not.toBe("readable");
    },
  );

  it("anonymous does not read it", async () => {
    const detail = await getCaseDetailByPublicCode(caseCodes.denuncia);
    expect(detail).not.toBeNull();
    if (detail) expect(await canReadCase(detail, null)).toBe(false);
  });
});

describe("case notes for a hand-off org party (S2)", () => {
  it("withholds the notes before acceptance", async () => {
    const read = await readCaseForViewer(caseCodes.handshakeOpen, viewer("receiverCoordinator"));
    expect(read.kind).toBe("readable");
    if (read.kind !== "readable") return;
    expect(read.timelineEvents.some((e) => e.notes === NOTE_OPEN)).toBe(false);
    expect(read.timelineEvents.length).toBeGreaterThan(0);
    // Re-review item 3: free-text PAYLOAD fields go with the notes — the
    // timeline summary, the API and the app all render from this result.
    const everything = JSON.stringify(read);
    expect(everything).not.toContain(PAYLOAD_OPEN);
    expect(everything).not.toContain("Calle Falsa");
  });

  // F1 — a 'resolved' close is not acceptance: an episode returned to its
  // owner keeps the notes from the shelter that was only proposed.
  it("withholds them on an episode returned to its owner without acceptance", async () => {
    const read = await readCaseForViewer(caseCodes.episodeReturned, viewer("receiver"));
    expect(read.kind).toBe("readable");
    if (read.kind !== "readable") return;
    expect(JSON.stringify(read)).not.toContain(NOTE_RETURNED);
  });

  it("shows them on an episode the shelter accepted", async () => {
    const read = await readCaseForViewer(caseCodes.episodeAccepted, viewer("receiver"));
    expect(read.kind).toBe("readable");
    if (read.kind !== "readable") return;
    expect(read.timelineEvents.some((e) => e.notes === NOTE_ACCEPTED)).toBe(true);
  });

  // F2 — a judicial reference is free text; everything after the key goes.
  it("strips the whole judicial reference from the opened-reason prose", () => {
    const detail = {
      openedReason:
        "auto: decomiso motivo=maltrato_fisico judicial_ref=Causa 123/2026 Juzgado N.º 4",
      openedReasonParams: { judicialRef: "Causa 123/2026 Juzgado N.º 4" },
      events: [],
    } as unknown as Parameters<typeof withholdFreeText>[0];
    const safe = withholdFreeText(detail);
    expect(safe.openedReason).toBe("auto: decomiso motivo=maltrato_fisico judicial_ref=sin_ref");
    expect(JSON.stringify(safe)).not.toContain("Juzgado");
  });

  it("shows them once the hand-off was accepted", async () => {
    const read = await readCaseForViewer(caseCodes.handshakeClosed, viewer("receiverCoordinator"));
    expect(read.kind).toBe("readable");
    if (read.kind !== "readable") return;
    expect(read.timelineEvents.some((e) => e.notes === NOTE_CLOSED)).toBe(true);
  });

  it("denies a volunteer the case outright", async () => {
    const read = await readCaseForViewer(caseCodes.handshakeOpen, viewer("receiverVolunteer"));
    expect(read.kind).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// The SQL mirror — REQUIRES migration 0281 applied to the local database.
// ---------------------------------------------------------------------------

async function sqlCanReadCase(caseId: string, userId: string): Promise<boolean> {
  const rows = (await db.execute(
    sql`select public.can_read_case(${caseId}::uuid, ${userId}::uuid) as ok`,
  )) as unknown as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
}

describe("public.can_read_case agrees with canReadCase on the 0281 arms", () => {
  // R7: not a regression when the migration is simply not applied — say so.
  beforeAll(async () => {
    const rows = (await db.execute(sql`
      select count(*)::int as n from pg_proc
      where proname = 'can_read_case'
        and prosrc like '%custody_transfer_handshake%'
        and prosrc like '%m.role in (''admin'', ''coordinator'')%'
        and prosrc like '%pe.payload->>''reason'' = ''org_to_org_handoff''%'
    `)) as unknown as Array<{ n: number }>;
    if ((rows[0]?.n ?? 0) === 0) {
      throw new Error("0282 no está aplicada en esta base (pnpm db:migrate)");
    }
  });

  // [case, reader, TypeScript canReadCase, SQL can_read_case]. The two differ
  // ON PURPOSE for an org party of an UNACCEPTED hand-off: TS admits it (the app
  // shows the case with notes and payloads withheld), SQL does not (pet_events /
  // attachments RLS delegates to it, and a party's JWT would read raw notes over
  // PostgREST). After acceptance both admit it. See the 0281 header.
  const cells: Array<[keyof typeof caseIds, UserKey, boolean, boolean]> = [
    ["handshakeOpen", "receiverCoordinator", true, false],
    ["handshakeOpen", "sender", true, false],
    ["handshakeOpen", "receiver", true, false],
    ["episode", "receiver", true, false],
    ["handshakeClosed", "receiver", true, true],
    ["handshakeClosed", "sender", true, true],
    // F1: returned to its owner without acceptance — SQL denies; TS reads it
    // with the notes withheld. Accepted, then closed — both admit it.
    ["episodeReturned", "receiver", true, false],
    ["episodeAccepted", "receiver", true, true],
    ["episodeAccepted", "receiverVolunteer", false, false],
    ["handshakeOpen", "receiverVolunteer", false, false],
    ["episode", "receiverVolunteer", false, false],
    ["handshakeOpen", "receiverLeft", false, false],
    ["handshakeOpen", "stranger", false, false],
    ["episode", "oldReceiver", false, false],
    ["episode", "formerOwner", false, false],
    // PO 2026-10-06: TS admits the filing org (redacted read); SQL does not —
    // RLS cannot redact raw pet_events / attachments. See the 0281 header.
    ["denuncia", "reporterOrg", true, false],
    ["denuncia", "reporterCoordinator", true, false],
    ["denuncia", "reporterVolunteer", false, false],
    ["denuncia", "titular", false, false],
    ["denuncia", "stranger", false, false],
    ["bite", "coOwner", false, false],
    ["bite", "titular", true, true],
  ];
  for (const [caseKey, user, ts, sqlVerdict] of cells) {
    it(`${caseKey} × ${user} → TS ${ts}, SQL ${sqlVerdict}`, async () => {
      const detail = await getCaseDetailByPublicCode(caseCodes[caseKey]);
      expect(detail).not.toBeNull();
      if (!detail) return;
      expect(await canReadCase(detail, viewer(user))).toBe(ts);
      expect(await sqlCanReadCase(caseIds[caseKey], ids[user])).toBe(sqlVerdict);
    });
  }
});
