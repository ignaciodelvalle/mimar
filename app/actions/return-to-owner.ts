"use server";

// return-to-owner.ts — Lost & Found Fase 5 (thin controller).
//
// Business logic lives in src/modules/return-to-owner/application/.
// This file: auth guard → delegate to use-case → return result.
//
// Strangler migration: 1928 lines → thin controllers.
// Writer-pattern preserved: each action has a public wrapper (handles auth /
// session) and an inner writer (imported from application/writers.ts for
// direct test access, no session required). The inner writers are NOT
// re-exported from this "use server" file — each accepts a caller-supplied
// userId/orgId and would otherwise be an independently-addressable server
// action (authz triage 2026-07-04, residual close-out).

import { and, eq, isNull } from "drizzle-orm";

import { db, ownerships, pets } from "@/db";
import { requireOrgAccessByToken, requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

// Writer-pattern inner functions are NOT re-exported from this "use server"
// file — each accepts a caller-supplied userId/orgId, which would make it an
// independently-addressable server action (authz triage 2026-07-04, residual
// close-out). They live in application/writers.ts, a plain module.
import {
  actorCancelProposalWriter,
  orgAcceptOwnerReturnWriter,
  orgRejectOwnerReturnWriter,
  ownerAcceptReturnWriter,
  ownerProposeReturnToOrgWriter,
  ownerRejectReturnWriter,
  proposeReturnAsRefugioWriter,
  proposeReturnAsVecinoWriter,
} from "@/src/modules/return-to-owner/application/writers";

// ---------------------------------------------------------------------------
// Re-export public types (callers must not change)
// ---------------------------------------------------------------------------

export type {
  AcceptReturnResult,
  CancelProposalResult,
  OrgAcceptOwnerReturnResult,
  OrgRejectOwnerReturnResult,
  OwnerProposeReturnToOrgResult,
  ProposeReturnResult,
  RejectReturnResult,
} from "@/src/modules/return-to-owner/domain/types";

// ---------------------------------------------------------------------------
// Public action — proposeReturnToOwnerAction
// ---------------------------------------------------------------------------

export async function proposeReturnToOwnerAction({
  petPublicToken,
  actorMode,
  orgToken,
  notes,
}: {
  petPublicToken: string;
  actorMode: "refugio" | "vecino";
  orgToken?: string;
  notes?: string | null;
}) {
  if (actorMode === "refugio") {
    if (!orgToken) return { error: "orgToken requerido para actorMode='refugio'." };
    const { organization, membership, user } = await requireOrgAccessByToken(orgToken);
    const granted = await getGrantedCapabilities(membership);
    if (!granted.has("custody.transfer")) {
      return { error: "Se necesita el permiso custody.transfer para proponer una devolución." };
    }
    return proposeReturnAsRefugioWriter({
      userId: user.id,
      organization: { id: organization.id, displayName: organization.displayName },
      petPublicToken,
      notes: notes ?? null,
    });
  }

  if (actorMode === "vecino") {
    const { user } = await requireUserOrRedirect();
    return proposeReturnAsVecinoWriter({ userId: user.id, petPublicToken, notes: notes ?? null });
  }

  return { error: "actorMode inválido. Debe ser 'refugio' o 'vecino'." };
}

// Inner writers proposeReturnAsRefugioWriter / proposeReturnAsVecinoWriter
// moved to application/writers.ts (authz triage 2026-07-04, residual
// close-out) — not re-exported from this "use server" file.

// ---------------------------------------------------------------------------
// Public action — ownerAcceptReturnAction
// ---------------------------------------------------------------------------

export async function ownerAcceptReturnAction({ petPublicToken }: { petPublicToken: string }) {
  const { user } = await requireUserOrRedirect();
  return ownerAcceptReturnWriter({ userId: user.id, petPublicToken });
}

// Inner writer ownerAcceptReturnWriter moved to application/writers.ts
// (authz triage 2026-07-04, residual close-out) — not re-exported here.

// ---------------------------------------------------------------------------
// Public action — ownerRejectReturnAction
// ---------------------------------------------------------------------------

export async function ownerRejectReturnAction({
  petPublicToken,
  reason,
}: {
  petPublicToken: string;
  reason: string;
}) {
  const { user } = await requireUserOrRedirect();
  return ownerRejectReturnWriter({ userId: user.id, petPublicToken, reason });
}

// Inner writer ownerRejectReturnWriter moved to application/writers.ts
// (authz triage 2026-07-04, residual close-out) — not re-exported here.

// ---------------------------------------------------------------------------
// Public action — actorCancelProposalAction
// ---------------------------------------------------------------------------

export async function actorCancelProposalAction({
  petPublicToken,
  reason,
  orgToken,
}: {
  petPublicToken: string;
  reason: string;
  orgToken?: string;
}) {
  const { user } = await requireUserOrRedirect();
  let actorOrgId: string | undefined;
  if (orgToken) {
    const { organization } = await requireOrgAccessByToken(orgToken);
    actorOrgId = organization.id;
  }
  return actorCancelProposalWriter({ userId: user.id, petPublicToken, reason, actorOrgId });
}

// Inner writer actorCancelProposalWriter moved to application/writers.ts
// (authz triage 2026-07-04, residual close-out) — not re-exported here.

// ---------------------------------------------------------------------------
// Read helpers — intentionally NOT exported from this "use server" file.
// fetchPendingReturnProposalForOwner / fetchPendingOwnerReturnProposalForOrg /
// loadProposalContext are unguarded projection queries; exporting them here
// made each an independently-addressable server action (read leak — authz
// triage 2026-07-04). Server components import them from
// src/modules/return-to-owner/application/{proposal-queries,load-proposal-context}.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public action — ownerProposeReturnToOrgAction
// ---------------------------------------------------------------------------

export async function ownerProposeReturnToOrgAction({
  petPublicToken,
  reason,
  notes,
  proposedAt,
}: {
  petPublicToken: string;
  reason: string;
  notes: string | null;
  proposedAt: string;
}) {
  const { user } = await requireUserOrRedirect();

  const [petRow] = await db
    .select({ id: pets.id })
    .from(pets)
    // Art. 16: defense in depth — the writer re-resolves through the same
    // guard, but this pre-resolution must not see the erased pet either.
    .where(unerasedPetByToken(petPublicToken))
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada." };

  const [callerOwnership] = await db
    .select({ role: ownerships.role })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petRow.id),
        eq(ownerships.ownerUserId, user.id),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);

  const callerRole: "owner" | "foster" = callerOwnership?.role === "foster" ? "foster" : "owner";

  return ownerProposeReturnToOrgWriter({
    userId: user.id,
    petPublicToken,
    reason,
    notes,
    proposedAt,
    callerRole,
  });
}

// Inner writer ownerProposeReturnToOrgWriter moved to application/writers.ts
// (authz triage 2026-07-04, residual close-out) — not re-exported here.

// ---------------------------------------------------------------------------
// Public action — orgAcceptOwnerReturnAction
// ---------------------------------------------------------------------------

export async function orgAcceptOwnerReturnAction({
  petPublicToken,
  orgToken,
}: {
  petPublicToken: string;
  orgToken: string;
}) {
  const { organization, membership, user } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);
  if (!granted.has("custody.transfer")) {
    return { error: "Se necesita el permiso custody.transfer para aceptar la devolución." };
  }
  return orgAcceptOwnerReturnWriter({
    orgId: organization.id,
    orgDisplayName: organization.displayName,
    actingUserId: user.id,
    petPublicToken,
  });
}

// Inner writer orgAcceptOwnerReturnWriter moved to application/writers.ts
// (authz triage 2026-07-04, residual close-out) — not re-exported here.

// ---------------------------------------------------------------------------
// Public action — orgRejectOwnerReturnAction
// ---------------------------------------------------------------------------

export async function orgRejectOwnerReturnAction({
  petPublicToken,
  orgToken,
  reason,
}: {
  petPublicToken: string;
  orgToken: string;
  reason: string;
}) {
  const { organization, membership, user } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);
  if (!granted.has("custody.transfer")) {
    return { error: "Se necesita el permiso custody.transfer para rechazar la devolución." };
  }
  return orgRejectOwnerReturnWriter({
    orgId: organization.id,
    orgDisplayName: organization.displayName,
    actingUserId: user.id,
    petPublicToken,
    reason,
  });
}

// Inner writer orgRejectOwnerReturnWriter moved to application/writers.ts
// (authz triage 2026-07-04, residual close-out) — not re-exported here.
