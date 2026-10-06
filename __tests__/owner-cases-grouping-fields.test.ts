// The owner's casos carry what the grouped inbox needs (PO decision 2026-10-06):
// the pet each row is about — public token, name, photo — and whose turn it is.
//
// Pinned against the real local DB, because the pet, its photo and the turn come
// from joins and predicates (`pets`, `attachments` through `pets.primary_photo_id`,
// a devolución's payload, its cancellation, a proposal's `expires_at`) that a
// mocked loader would never run. One owner, one refugio:
//
//   · Pampa is LOST and PPP without attestation → two rows about ONE pet, both
//     the owner's turn, both carrying her PUBLIC-bucket photo url;
//   · Toto is PPP without attestation and has no photo → photo `null`;
//   · a pending approval request → account-level: no pet, not the owner's turn;
//   · devoluciones in both directions: one ADDRESSED to the owner (their turn),
//     one the owner SENT to the refugio (waiting on it), and one cancelled
//     (gone — a refused proposal must not stay open forever);
//   · tránsito proposals: a live one (the owner's turn, with its deadline) and a
//     lapsed one (gone — never "Vence el <a date already past>");
//   · history: a declined tránsito about a pet the owner does NOT hold carries
//     no pet at all, one about a pet they DO hold keeps it.
//
// Isolation: fixed owner id, `TEST-CASOS-` tokens, a fictional locality, the
// refugio found by its own email; cleanup by those keys only, through the
// append-only escape hatch because some fixture pets carry events. Every
// deadline compared against `now()` is written from the database clock itself.
// The approval row is dated 2020 so it never sorts into another file's page.

import { eq, like, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildMyCasesV1 } from "@/app/api/v1/me/cases/payload";
import {
  approvalRequests,
  attachments,
  db,
  fosterProposals,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import {
  type WorkflowItem,
  fetchOpenWorkflows,
  fetchPreviousWorkflows,
} from "@/lib/analytics/owner-dashboard";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { petPhotoUrl } from "@/lib/infra/storage";
import { clusterCaseRowsByPet, splitOpenCaseRows } from "@dim/contract/api";
import { withMutationOverride } from "./_helpers/db-overrides";

const OWNER_ID = "00000000-0000-4000-8000-0000000ca5e5";
const ORG_EMAIL = "casos-agrupados-refugio@dim-test.local";
const ORG_NAME = "Refugio Casos Agrupados";
const PROVINCE = "Tierra del Fuego";
const LOCALITY = "ZZ Prueba Casos Agrupados";
const PHOTO_PATH = "test/casos-agrupados/pampa.jpg";
const APPROVAL_TOKEN = "CASOS-AGRUPADOS-AR-1";
const TOKEN_PREFIX = "TEST-CASOS-";

const stamp = Date.now();
const token = (suffix: string) => `${TOKEN_PREFIX}${stamp}-${suffix}`;
const PAMPA = token("PAMPA");
const TOTO = token("TOTO");
const COCO = token("COCO"); // devolución addressed to the owner
const DORA = token("DORA"); // devolución the owner sent to the refugio
const ECO = token("ECO"); // devolución cancelled
const FIDO = token("FIDO"); // live tránsito proposal
const GALA = token("GALA"); // lapsed tránsito proposal
const HUGO = token("HUGO"); // declined tránsito, pet not held
const IRIS = token("IRIS"); // declined tránsito, pet held

const petIds = new Map<string, string>();
let orgId: string;
let open: WorkflowItem[];
let previous: WorkflowItem[];

async function cleanup() {
  await db.delete(approvalRequests).where(eq(approvalRequests.publicToken, APPROVAL_TOKEN));
  await db.delete(fosterProposals).where(eq(fosterProposals.volunteerUserId, OWNER_ID));
  // Some fixture pets carry events, and pet_events is append-only: the delete
  // cascades into them only through the accountable escape hatch.
  await withMutationOverride(async (tx) => {
    await tx.delete(pets).where(like(pets.publicToken, `${TOKEN_PREFIX}%`));
  });
  await db.delete(organizations).where(eq(organizations.email, ORG_EMAIL));
}

async function insertPet(publicToken: string, values: Partial<typeof pets.$inferInsert> = {}) {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken,
      name: publicToken.split("-").at(-1) ?? publicToken,
      species: "dog",
      sex: "female",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
      ...values,
    })
    .returning({ id: pets.id });
  if (!row) throw new Error(`fixture pet ${publicToken} was not inserted`);
  petIds.set(publicToken, row.id);
  return row.id;
}

async function own(petId: string) {
  await db.insert(ownerships).values({ petId, ownerUserId: OWNER_ID, role: "owner" as const });
}

type Direction = { toUserId: string } | { fromUserId: string; toOrganizationId: string };

async function propose(petId: string, direction: Direction) {
  const toOwner = "toUserId" in direction;
  const payload = validateEventPayload("custody_transfer_proposed", {
    from_user_id: toOwner ? null : direction.fromUserId,
    from_organization_id: toOwner ? orgId : null,
    to_user_id: toOwner ? direction.toUserId : null,
    to_organization_id: toOwner ? null : direction.toOrganizationId,
    reason: "return_to_original_owner",
    notes: null,
    matched_against_pet_id: null,
    proposed_at: new Date().toISOString(),
  });
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "custody_transfer_proposed",
      occurredAt: sql`now()`,
      recordedAt: sql`now()`,
      recordedByUserId: OWNER_ID,
      authorRole: "owner",
      payload,
    })
    .returning({ id: petEvents.id });
  if (!row) throw new Error("proposal was not inserted");
  return row.id;
}

function transito(
  petId: string,
  extra: Partial<PgInsertValue<typeof fosterProposals>> = {},
): PgInsertValue<typeof fosterProposals> {
  return {
    publicToken: `TP-${stamp}-${petId.slice(0, 8)}`,
    organizationId: orgId,
    volunteerUserId: OWNER_ID,
    petId,
    proposedByUserId: OWNER_ID,
    // From the DATABASE clock, the one `expires_at > now()` is evaluated on.
    expiresAt: sql`now() + interval '7 days'`,
    ...extra,
  };
}

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, aud, role)
    values (${OWNER_ID}::uuid, 'casos-agrupados@dim-test.local',
      'fake', now(), '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated')
    on conflict (id) do nothing
  `);
  await db
    .insert(profiles)
    .values({ id: OWNER_ID, displayName: "Casos Agrupados Owner" })
    .onConflictDoNothing({ target: profiles.id });
  // Self-healing: a previous run that died before its teardown left its rows.
  await cleanup();

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: token("ORG"),
      displayName: ORG_NAME,
      legalName: ORG_NAME,
      orgType: "shelter",
      email: ORG_EMAIL,
    })
    .returning({ id: organizations.id });
  if (!org) throw new Error("fixture refugio was not inserted");
  orgId = org.id;

  // Pampa — two rows about one pet, with a photo.
  const pampaId = await insertPet(PAMPA, { status: "lost", potentiallyDangerousBreed: true });
  await own(pampaId);
  const [photo] = await db
    .insert(attachments)
    .values({ petId: pampaId, storagePath: PHOTO_PATH, mimeType: "image/jpeg" })
    .returning({ id: attachments.id });
  await db.update(pets).set({ primaryPhotoId: photo?.id }).where(eq(pets.id, pampaId));

  // Toto — one row, no photo.
  await own(await insertPet(TOTO, { sex: "male", potentiallyDangerousBreed: true }));

  // Devoluciones.
  const cocoId = await insertPet(COCO);
  await own(cocoId);
  await propose(cocoId, { toUserId: OWNER_ID });

  const doraId = await insertPet(DORA);
  await own(doraId);
  await propose(doraId, { fromUserId: OWNER_ID, toOrganizationId: orgId });

  const ecoId = await insertPet(ECO);
  await own(ecoId);
  const ecoProposal = await propose(ecoId, { toUserId: OWNER_ID });
  await db.insert(petEvents).values({
    petId: ecoId,
    eventType: "custody_transfer_cancelled",
    occurredAt: sql`now()`,
    recordedAt: sql`now()`,
    recordedByUserId: OWNER_ID,
    authorRole: "owner",
    payload: validateEventPayload("custody_transfer_cancelled", {
      proposal_event_id: ecoProposal,
      cancelled_by: "owner_reject",
      reason: null,
    }),
  });

  // Tránsito proposals.
  const irisId = await insertPet(IRIS);
  await own(irisId);
  await db
    .insert(fosterProposals)
    .values([
      transito(await insertPet(FIDO)),
      transito(await insertPet(GALA), { expiresAt: sql`now() - interval '1 day'` }),
      transito(await insertPet(HUGO), { status: "rejected", respondedAt: sql`now()` }),
      transito(irisId, { status: "rejected", respondedAt: sql`now()` }),
    ]);

  await db.insert(approvalRequests).values({
    publicToken: APPROVAL_TOKEN,
    type: "role_upgrade_vet",
    status: "pending",
    applicantUserId: OWNER_ID,
    targetUserId: OWNER_ID,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    payload: { payload_version: 1, matricula_number: "MN-CASOS", matricula_jurisdiccion: "BA" },
    createdAt: new Date("2020-01-01T12:00:00.000Z"),
  });

  [open, previous] = await Promise.all([
    fetchOpenWorkflows(OWNER_ID),
    fetchPreviousWorkflows(OWNER_ID),
  ]);
}, 60_000);

afterAll(async () => {
  await cleanup();
  await db.delete(profiles).where(eq(profiles.id, OWNER_ID));
  await db.execute(sql`delete from auth.users where id = ${OWNER_ID}::uuid`);
}, 60_000);

const about = (rows: WorkflowItem[], publicToken: string) =>
  rows.filter((w) => w.pet?.publicToken === publicToken);

describe("fetchOpenWorkflows — the pet and the turn on every row", () => {
  it("carries Pampa's public token, name and photo url on BOTH of her rows", () => {
    const hers = about(open, PAMPA);
    expect(hers.map((w) => w.kind).sort()).toEqual(
      ["dangerous_breed_pending_attestation", "pet_lost"].sort(),
    );
    for (const w of hers) {
      expect(w.pet).toEqual({
        publicToken: PAMPA,
        name: "PAMPA",
        photoUrl: petPhotoUrl(PHOTO_PATH),
      });
      expect(w.needsAction).toBe(true);
      expect(w.dueAt).toBe(null);
    }
  });

  it("points the photo at the PUBLIC bucket, never at a signed url", () => {
    const url = about(open, PAMPA)[0]?.pet?.photoUrl ?? "";
    expect(url).toContain("/object/public/pet-photos/");
    expect(url).not.toMatch(/\/object\/sign\/|[?&]token=/);
  });

  it("says a pet with no photo has none, instead of inventing a url", () => {
    const his = about(open, TOTO);
    expect(his).toHaveLength(1);
    expect(his[0]?.pet).toEqual({ publicToken: TOTO, name: "TOTO", photoUrl: null });
  });

  it("leaves the approval request account-level and off the owner's turn", () => {
    const approval = open.find((w) => w.kind === "approval_request_pending");
    expect(approval).toMatchObject({ pet: null, needsAction: false, dueAt: null });
  });
});

describe("a devolución — the direction decides whose turn it is", () => {
  it("puts a proposal ADDRESSED to the owner on their turn", () => {
    const [row] = about(open, COCO);
    expect(row).toMatchObject({ kind: "custody_transfer_pending", needsAction: true });
    expect(row?.subtitle).toMatch(/confirmá la transferencia/);
  });

  it("puts a proposal the owner SENT to a refugio in 'En curso', waiting on the refugio", () => {
    const [row] = about(open, DORA);
    expect(row).toMatchObject({ kind: "custody_transfer_pending", needsAction: false });
    expect(row?.subtitle).toBe(`Esperando que ${ORG_NAME} responda`);
  });

  it("drops a cancelled proposal instead of keeping it open forever", () => {
    expect(about(open, ECO)).toEqual([]);
  });
});

describe("a tránsito proposal — only while it can still be answered", () => {
  it("lists a live proposal with its deadline", () => {
    const [row] = about(open, FIDO);
    expect(row).toMatchObject({ kind: "foster_proposal_pending", needsAction: true });
    expect(row?.dueAt).toBeInstanceOf(Date);
  });

  it("never lists a lapsed one", () => {
    expect(about(open, GALA)).toEqual([]);
    expect(open.filter((w) => w.title.includes("GALA"))).toEqual([]);
  });
});

describe("history — a pet the viewer no longer holds carries no pet", () => {
  it("strips the token and photo from a declined tránsito about somebody else's animal", () => {
    const row = previous.find((w) => w.title.includes("HUGO"));
    expect(row?.kind).toBe("foster_proposal_resolved");
    expect(row?.pet).toBe(null);
  });

  it("keeps the pet on a history row about an animal the viewer holds", () => {
    const row = previous.find((w) => w.title.includes("IRIS"));
    expect(row?.pet).toEqual({ publicToken: IRIS, name: "IRIS", photoUrl: null });
  });
});

describe("the wire, grouped the way both surfaces draw it", () => {
  it("collapses Pampa's two rows into one cluster and never ships a pet uuid", () => {
    const payload = buildMyCasesV1({ open, previous, now: new Date() });
    const wire = JSON.stringify(payload);
    for (const id of petIds.values()) expect(wire).not.toContain(id);

    const { yourTurn, inProgress } = splitOpenCaseRows(payload.open);
    const clusters = clusterCaseRowsByPet(yourTurn);
    const pampa = clusters.find((c) => c.petId === PAMPA);
    expect(pampa?.rows).toHaveLength(2);
    expect(pampa?.petPhotoUrl).toBe(petPhotoUrl(PHOTO_PATH));
    expect(clusters.find((c) => c.petId === TOTO)?.rows).toHaveLength(1);
    expect(inProgress.find((r) => r.petId === DORA)?.needsAction).toBe(false);
    expect(inProgress.find((r) => r.kind === "approval_request_pending")).toMatchObject({
      petId: null,
      petName: null,
      petPhotoUrl: null,
    });
  });
});
