// Application-layer query helpers — proposal pending-state detection.
//
// ARCH-B cutoff: cancellations recorded after this moment ALWAYS emit a
// structured custody_transfer_cancelled event. Legacy note_added markers are
// only honoured for rows recorded before it (forgery guard). Set to the
// ARCH-B implementation moment; a legitimate marker can only predate it because
// every writer since emits the structured event.
export const LEGACY_CANCEL_MARKER_CUTOFF = new Date("2026-06-10T20:00:00Z");

import { and, desc, eq, gt, lt, sql } from "drizzle-orm";

import { type PetEvent, type db, petEvents } from "@/db";

// Accepts either the top-level db instance or a transaction handle.
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// hasPendingProposal
// ---------------------------------------------------------------------------
//
// Returns true if there is a pending custody_transfer_proposed event with no
// subsequent event that resolves it.
//
// Resolution checks (tri-check — ARCH-B):
//   1. custody_transferred after the proposal (happy path accepted).
//   2. custody_transfer_cancelled with payload->>'proposal_event_id' = proposal.id
//      (structured cancellation — new path since ARCH-B).
//   3. Legacy: note_added with marker text LIKE '%Proposal event_id=<id>%'
//      AND recordedAt before the ARCH-B cutoff. Historical owner-reject
//      markers were authored as 'owner', so a role filter would resurrect
//      old resolved proposals — the time fence is the correct forgery guard:
//      every cancellation since the cutoff emits the structured event, so a
//      marker note recorded after it can only be a crafted note.
export async function hasPendingProposal(petId: string, exec: DbOrTx): Promise<boolean> {
  const [latestProposal] = await exec
    .select({ id: petEvents.id, occurredAt: petEvents.occurredAt })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  if (!latestProposal) return false;

  // Check 1: subsequent custody_transferred.
  const [subsequentTransfer] = await exec
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "custody_transferred"),
        gt(petEvents.occurredAt, latestProposal.occurredAt),
      ),
    )
    .limit(1);

  if (subsequentTransfer) return false;

  // Check 2: structured cancellation referencing this proposal (ARCH-B).
  const [structuredCancel] = await exec
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "custody_transfer_cancelled"),
        gt(petEvents.occurredAt, latestProposal.occurredAt),
        sql`${petEvents.payload}->>'proposal_event_id' = ${latestProposal.id}`,
      ),
    )
    .limit(1);

  if (structuredCancel) return false;

  // Check 3: legacy marker note_added (historical rows only — pre-ARCH-B data).
  const proposalMarker = `Proposal event_id=${latestProposal.id}`;
  const [cancelNote] = await exec
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "note_added"),
        gt(petEvents.occurredAt, latestProposal.occurredAt),
        sql`${petEvents.payload}->>'text' LIKE ${`%${proposalMarker}%`}`,
        lt(petEvents.recordedAt, LEGACY_CANCEL_MARKER_CUTOFF),
      ),
    )
    .limit(1);

  if (cancelNote) return false;

  return true;
}

// ---------------------------------------------------------------------------
// fetchPendingOwnerReturnProposalForOrg
// ---------------------------------------------------------------------------
//
// Fetch the latest pending owner-initiated return proposal for a pet to a
// specific org.  Returns the proposal event and the owner user id when a pending
// proposal exists with from_user_id set (owner-initiated) and
// to_organization_id = orgId.
export async function fetchPendingOwnerReturnProposalForOrg(
  petId: string,
  orgId: string,
  exec: DbOrTx,
): Promise<{ proposal: PetEvent; ownerUserId: string } | null> {
  const [latestProposal] = (await exec
    .select()
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1)) as PetEvent[];

  if (!latestProposal) return null;

  const payload = latestProposal.payload as Record<string, unknown>;
  const fromUserId = (payload.from_user_id as string | null) ?? null;
  const fromOrgId = (payload.from_organization_id as string | null) ?? null;
  const toOrgId = (payload.to_organization_id as string | null) ?? null;

  // Must be owner-initiated and directed to this org.
  if (!fromUserId || fromOrgId !== null || toOrgId !== orgId) return null;

  // Must not have a subsequent transfer.
  const [subsequentTransfer] = await exec
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "custody_transferred"),
        gt(petEvents.occurredAt, latestProposal.occurredAt),
      ),
    )
    .limit(1);
  if (subsequentTransfer) return null;

  // Check 2: structured cancellation referencing this proposal (ARCH-B).
  const [structuredCancel] = await exec
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "custody_transfer_cancelled"),
        gt(petEvents.occurredAt, latestProposal.occurredAt),
        sql`${petEvents.payload}->>'proposal_event_id' = ${latestProposal.id}`,
      ),
    )
    .limit(1);
  if (structuredCancel) return null;

  // Check 3: legacy marker note_added (historical rows — pre-ARCH-B data).
  const proposalMarker = `Proposal event_id=${latestProposal.id}`;
  const [cancelNote] = await exec
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "note_added"),
        gt(petEvents.occurredAt, latestProposal.occurredAt),
        sql`${petEvents.payload}->>'text' LIKE ${`%${proposalMarker}%`}`,
        lt(petEvents.recordedAt, LEGACY_CANCEL_MARKER_CUTOFF),
      ),
    )
    .limit(1);
  if (cancelNote) return null;

  return { proposal: latestProposal, ownerUserId: fromUserId };
}

// ---------------------------------------------------------------------------
// fetchPendingReturnProposalForOwner
// ---------------------------------------------------------------------------
//
// Returns true when there is a pending return proposal for this pet ADDRESSED
// to the given owner. Callers must have pre-authorized the owner context —
// this is an internal query, never exported from a "use server" file.
export async function fetchPendingReturnProposalForOwner(
  petId: string,
  ownerUserId: string,
  exec: DbOrTx,
): Promise<boolean> {
  const pending = await hasPendingProposal(petId, exec);
  if (!pending) return false;

  const [latestProposal] = await exec
    .select({ payload: petEvents.payload })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  if (!latestProposal) return false;

  const payload = latestProposal.payload as Record<string, unknown>;
  const toUserId = (payload.to_user_id as string | null) ?? null;
  return toUserId === ownerUserId;
}

// ---------------------------------------------------------------------------
// autoCancelBody
// ---------------------------------------------------------------------------
export function autoCancelBody(reason: string, petName: string): string {
  const messages: Record<string, string> = {
    actor_no_longer_holds_custody: `La propuesta se canceló automáticamente porque quien la hizo ya no tiene custodia activa de ${petName}.`,
    pet_not_lost: `La propuesta se canceló automáticamente porque ${petName} ya no figura como perdida.`,
    pet_deceased: `La propuesta se canceló automáticamente porque ${petName} está registrada como fallecida.`,
  };
  return messages[reason] ?? `La propuesta se canceló automáticamente (${reason}).`;
}
