// Use-case: set canWritePetEvents on an org member (admin action).
//
// Migrated from app/actions/org-memberships.ts::setMemberEventWriteAction.
// Auth (requireCapability("member.invite", organizationId)) handled by caller.
//
// Rules (exact parity with original):
//   1. Load target membership.
//   2. Self-check.
//   3. Rank rule.
//   4. Grant or revoke the `event.write` CAPABILITY (authoritative enforcement path).
//      The legacy `canWritePetEvents` column is mirrored for backward compat
//      but is deprecated — enforcement reads the capability, not the column.
//   5. capability mutation + syncEventWriteMirror + audit_log (same tx).
//
// THE ONE WRITER OF THE LEGACY COLUMN (W6 / F-9). `can_write_pet_events` used
// to be written by five paths, each with its own idea of the value: the org
// creator set `true`, an invitation copied the inviter's checkbox (even for a
// vet_individual whose permission is implicit), and this toggle wrote the
// caller's INTENT. None of them read the grant table, which is what enforcement
// reads (authz-resolver → resolveGrantedCaps). So the column could say "yes"
// on a membership that is refused — exactly what the TN-10 rehearsal hit.
//
// `syncEventWriteMirror` below is now the only function that writes it, and it
// writes the DERIVED value: role baseline + approved grants, through the same
// `resolveGrantedCaps` the resolver uses. Every path that changes either input
// (this toggle, invitation accept, direct grant, grant decision, role change,
// org creation, the vet-approval practice) calls it inside its own transaction.
// The column is kept, not dropped: nothing enforces on it any more, and
// dropping it is a separate, migration-bearing decision.

import { resolveGrantedCaps } from "@/src/modules/organizations/domain/capabilities";
import { ROLE_RANK } from "@/src/modules/organizations/domain/role-rules";
import type {
  Exec,
  OrgRepository,
} from "@/src/modules/organizations/infrastructure/org-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// syncEventWriteMirror — the single writer of the legacy column
// ---------------------------------------------------------------------------

export type EventWriteMirrorRepo = Pick<OrgRepository, "readEventWriteState" | "setEventWrite">;

/**
 * Recompute whether `membershipId` effectively holds `event.write` and write
 * that into the legacy column. Returns the value written. Call it in the SAME
 * transaction as the role/grant change, after the change.
 */
export async function syncEventWriteMirror(
  repo: EventWriteMirrorRepo,
  membershipId: string,
  e: Exec,
): Promise<boolean> {
  const state = await repo.readEventWriteState(membershipId, e);
  if (!state) return false;
  const effective = resolveGrantedCaps(state.role, state.approvedCapabilities).has("event.write");
  await repo.setEventWrite(membershipId, effective, e);
  return effective;
}

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type SetMemberEventWriteInput = {
  organizationId: string;
  membershipId: string;
  canWrite: boolean;
  actor: {
    userId: string;
    role: string;
    membershipId: string;
  };
  organization: {
    publicToken: string;
  };
};

type RepoDeps = Pick<
  OrgRepository,
  | "findActiveMembership"
  | "readEventWriteState"
  | "setEventWrite"
  | "insertAuditLog"
  | "insertGrant"
  | "findApprovedGrant"
  | "setGrantStatus"
>;

type Deps = {
  repo: RepoDeps;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function setMemberEventWrite(
  input: SetMemberEventWriteInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, transaction } = deps;

  // 1. Load target.
  const target = await repo.findActiveMembership(input.organizationId, input.membershipId);
  if (!target) return { ok: false, error: "Membresía no encontrada o ya inactiva." };

  // 2. Self-check.
  if (target.userId === input.actor.userId) {
    return {
      ok: false,
      error: "No podés modificar tu propio permiso de escritura por esta vía.",
    };
  }

  // 3. Rank rule.
  const actorRank = ROLE_RANK[input.actor.role as keyof typeof ROLE_RANK] ?? 0;
  const targetRank = ROLE_RANK[target.role] ?? 0;
  if (targetRank > actorRank) {
    return { ok: false, error: "No podés gestionar a alguien con un rol mayor al tuyo." };
  }

  // 4 & 5. Grant/revoke `event.write` capability + mirror to legacy column + audit_log (one tx).
  //
  // Capability is the authoritative enforcement gate (authz-resolver reads
  // organizationCapabilityGrants, NOT the canWritePetEvents column).
  // The legacy column is kept for backward compat and marked deprecated.
  let revokedGrant: Awaited<ReturnType<OrgRepository["findApprovedGrant"]>> = null;
  let mirrored = input.canWrite;
  await transaction(async (tx) => {
    const e = tx as Exec;

    if (input.canWrite) {
      // Grant: idempotent — if an approved grant already exists, skip insert
      // to avoid hitting the partial unique index on (membershipId, capability)
      // WHERE status IN ('pending','approved').
      const existing = await repo.findApprovedGrant(input.membershipId, "event.write", e);
      if (!existing) {
        await repo.insertGrant(
          {
            membershipId: input.membershipId,
            organizationId: input.organizationId,
            capability: "event.write",
            status: "approved",
            requestedReason: null,
            decidedAt: new Date(),
            decidedByUserId: input.actor.userId,
            decisionReason: "toggle",
          },
          e,
        );
      }
    } else {
      // Revoke: find and revoke the existing approved grant (if any).
      // Lote B1 — status-only: the grant row keeps who originally granted it
      // (decidedBy/At/Reason); the revocation provenance rides the audit
      // payload below.
      const existing = await repo.findApprovedGrant(input.membershipId, "event.write", e);
      if (existing) {
        await repo.setGrantStatus(existing.id, "revoked", e);
        revokedGrant = existing;
      }
    }

    // Mirror to legacy column — DERIVED from the grant just written plus the
    // role baseline, never the caller's intent (see the header).
    mirrored = await syncEventWriteMirror(repo, input.membershipId, e);

    await repo.insertAuditLog(
      {
        actorUserId: input.actor.userId,
        action: "org_member_event_write_changed",
        targetUserId: target.userId,
        targetOrganizationId: input.organizationId,
        payload: {
          org_id: input.organizationId,
          member_user_id: target.userId,
          can_write_pet_events_before: target.canWritePetEvents,
          can_write_pet_events_after: mirrored,
          // Lote B1 — the revoked grant's provenance, now that the row itself
          // keeps the original approver instead of being overwritten.
          ...(revokedGrant
            ? {
                grant_id: revokedGrant.id,
                original_decided_by_user_id: revokedGrant.decidedByUserId,
                original_decided_at: revokedGrant.decidedAt?.toISOString() ?? null,
              }
            : {}),
        },
      },
      e,
    );
  });

  return { ok: true, value: undefined, notifications: [] };
}
