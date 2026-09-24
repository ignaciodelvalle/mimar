// WHAT A DEVOLUCIÓN SCREEN MAY DO, decided on the server.
//
// The read behind `GET /api/v1/pets/{publicToken}/return`. It answers ONE
// discriminated state, and every arm of it is a thing the writers would actually
// accept — which is the whole reason it exists rather than a client working the
// state out from a pet payload.
//
// WHY A CLIENT MAY NOT DERIVE THIS
// ---------------------------------------------------------------------------
// The three writers this feature has do not agree about who they serve, and the
// disagreements are not visible from any payload a phone holds:
//
//   · `ownerAcceptReturnUseCase` / `ownerRejectReturnUseCase` require an ACTIVE
//     `role = 'owner'` row AND a pending proposal whose `to_user_id` is the
//     caller. A co-owner is refused; so is the owner of a pet whose pending
//     proposal is their OWN outgoing one.
//   · `ownerProposeReturnToOrgUseCase` accepts an `owner` OR a `foster`, and the
//     organisation it addresses comes from an `adoption_finalized` payload or
//     from a parallel custody row — neither of which is on the wire anywhere.
//
// THE WEB'S OWN PAGE GETS ONE OF THESE WRONG, AND THIS READ DELIBERATELY DOES
// NOT COPY IT. `app/(app)/mis-mascotas/{token}/devolucion/page.tsx` renders the
// acceptance card whenever `hasPendingProposal` is true, without checking that
// the proposal is ADDRESSED to the viewer. An owner whose own outgoing proposal
// to a shelter is in flight is therefore shown "Aceptar" and "Rechazar" on the
// browser, and `ownerAcceptReturnUseCase` refuses both with "Esta propuesta no
// está dirigida a vos." — a control that can only be refused. Here the two cases
// are different arms (`inbound_pending` vs `awaiting_org`), so the phone offers
// the button only where the writer would take it. Reported rather than fixed on
// the web: that page is a browser-facing surface with its own e2e gate.
//
// THE PERSON PATH ONLY, and that is copied rather than invented. The web page
// resolves access with `eq(ownerships.ownerUserId, user.id)` — an ORGANISATION
// member holding this animal through a membership 404s there, and does here. The
// org side of a return lives at `/org/{token}` behind `custody.transfer`, which
// this app has no surface for at all.
//
// ART. 16 IS THE CALLER'S. This function takes a pet the door already resolved
// through `resolvePetHolderAccess`, which filters `isNull(pets.deletedAt)` on
// both of its paths — so there is no second read of `pets` here to forget it in.

import { and, desc, eq } from "drizzle-orm";

import { type OwnershipRole, db, organizations, petEvents, profiles } from "@/db";

import { hasPendingProposal } from "./proposal-queries";
import { resolveReturnTargetOrg } from "./resolve-return-target-org";

/** Who this feature admits, on the person path. */
export type ReturnCallerRole = "owner" | "foster";

export type PetReturnState =
  /**
   * Somebody is holding this animal and wants to hand it back. The caller may
   * accept or reject.
   */
  | {
      kind: "inbound_pending";
      /** Who is proposing — a first name, or an organisation's display name. */
      actorName: string;
      proposedAt: string;
      notes: string | null;
    }
  /**
   * The caller's OWN outgoing proposal is in flight. Nothing to do but wait —
   * and specifically NOT an acceptance, which the writer would refuse.
   */
  | { kind: "awaiting_org" }
  /** The caller may propose handing this animal back. */
  | {
      kind: "can_propose";
      callerRole: ReturnCallerRole;
      /** `null` when the organisation id resolves to no row. */
      orgDisplayName: string | null;
    }
  /**
   * The caller holds this animal in a role this feature does not serve — a
   * co-owner or a cuidador temporal. The web answers with an explanatory page
   * rather than a 404 for exactly this population.
   */
  | { kind: "not_titular"; holderRole: string }
  /** Nothing names an organisation to return this animal to. */
  | { kind: "no_source_org"; callerRole: ReturnCallerRole }
  /**
   * An adoption is on record and it names somebody else. Its own arm because
   * the writer refuses it with its own sentence, and because it is the one
   * "no" here that is about WHO the caller is rather than about the animal.
   */
  | { kind: "not_the_adopter" };

/** Accepts either the top-level db instance or a transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function readPetReturnState(args: {
  pet: { id: string };
  userId: string;
  /** From `resolvePetHolderAccess`. `null` means the ORG path. */
  holderRole: OwnershipRole | string | null;
  exec?: DbOrTx;
}): Promise<PetReturnState> {
  const exec = args.exec ?? db;

  // The org path never reaches here — the door 404s it, as the web page does.
  // A `null` role arriving anyway is treated as "not this feature's caller"
  // rather than silently taken as an owner.
  if (args.holderRole !== "owner" && args.holderRole !== "foster") {
    return { kind: "not_titular", holderRole: String(args.holderRole ?? "unknown") };
  }
  const callerRole: ReturnCallerRole = args.holderRole;

  // THE PENDING CHECK COMES FIRST, and the ORDER is the writers'. Both propose
  // writers refuse when a proposal is already pending — so a screen that offered
  // "Devolver" beside a live proposal would be offering a refusal.
  if (await hasPendingProposal(args.pet.id, exec)) {
    return describePendingProposal(args.pet.id, args.userId, exec);
  }

  const target = await resolveReturnTargetOrg({
    petId: args.pet.id,
    userId: args.userId,
    callerRole,
    exec,
  });

  if (!target.ok) {
    return target.code === "not_the_adopter"
      ? { kind: "not_the_adopter" }
      : { kind: "no_source_org", callerRole };
  }

  return { kind: "can_propose", callerRole, orgDisplayName: target.target.displayName };
}

/**
 * The pending proposal, from the caller's side of it.
 *
 * `to_user_id === caller` is what separates "somebody wants to give you this
 * animal back" from "you asked a shelter to take it back and they have not
 * answered". `ownerAcceptReturnUseCase` makes exactly that comparison before it
 * will do anything, and a read that skipped it would reproduce the web page's
 * only real defect on a second surface.
 */
async function describePendingProposal(
  petId: string,
  userId: string,
  exec: DbOrTx,
): Promise<PetReturnState> {
  const [latest] = await exec
    .select({
      payload: petEvents.payload,
      occurredAt: petEvents.occurredAt,
    })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  // `hasPendingProposal` already found one; a missing row here means it moved
  // between the two reads. "Waiting" is the safe answer — it offers nothing.
  if (!latest) return { kind: "awaiting_org" };

  const payload = latest.payload as Record<string, unknown>;
  const toUserId = (payload.to_user_id as string | null) ?? null;
  if (toUserId !== userId) return { kind: "awaiting_org" };

  const fromUserId = (payload.from_user_id as string | null) ?? null;
  const fromOrgId = (payload.from_organization_id as string | null) ?? null;

  return {
    kind: "inbound_pending",
    actorName: await proposerName(fromUserId, fromOrgId, exec),
    proposedAt: (payload.proposed_at as string | null) ?? latest.occurredAt.toISOString(),
    notes: (payload.notes as string | null) ?? null,
  };
}

/**
 * WHO IS HOLDING THE ANIMAL, in as few words as the web uses.
 *
 * A PERSON IS NAMED BY THEIR FIRST NAME ONLY — `displayName.split(" ")[0]`,
 * byte-for-byte the web's own line on this page. It is not a privacy accident
 * either way: this is somebody who has the reader's animal and is asking to
 * return it, so the reader is entitled to know who; the surname is more than the
 * decision needs.
 *
 * "Alguien" is the fallback the web uses when neither id resolves, and it is
 * kept rather than improved: a blank where a name should be reads as a bug, and
 * inventing a longer sentence here would put copy in a query.
 */
async function proposerName(
  fromUserId: string | null,
  fromOrgId: string | null,
  exec: DbOrTx,
): Promise<string> {
  if (fromUserId) {
    const [profile] = await exec
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, fromUserId))
      .limit(1);
    if (profile) return profile.displayName.split(" ")[0];
    return "Alguien";
  }
  if (fromOrgId) {
    const [org] = await exec
      .select({ displayName: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, fromOrgId))
      .limit(1);
    if (org) return org.displayName;
  }
  return "Alguien";
}
