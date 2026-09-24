// Use-case: lookupTransferTargetUseCase
//
// Quick existence + active-state check. The ResolveDisputeForm calls this
// before submitting so the operator sees a human-readable confirmation rather
// than a raw UUID.
//
// Tenant isolation (review 24): the lookup is bound to an in-scope dispute.
// Without a dispute binding, any admin/govt caller could resolve an arbitrary
// user/org UUID → displayName + active-state, turning this into an identity
// enumeration oracle. We load the dispute first, enforce the same govt
// jurisdiction gate as resolve/escalate/withdraw, and only then look up.

import { eq } from "drizzle-orm";

import { custodyDisputes, db, organizations, profiles } from "@/db";
import type { CustodyDispute } from "@/db";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";

import type { LookupTransferTargetInput, LookupTransferTargetResult } from "../domain/types";

type Session = {
  profile: { role: string };
  jurisdictions: { province: string; locality: string }[];
};

function isGovtInScope(
  jurisdictions: { province: string; locality: string }[],
  dispute: Pick<CustodyDispute, "jurisdictionProvince" | "jurisdictionLocality">,
): boolean {
  // Subsumption-aware: a whole-province assignment (e.g. whole-CABA) governs
  // every barrio in it; barrio assignments stay exact (never widens security).
  return jurisdictionScopeContains(
    jurisdictions,
    dispute.jurisdictionProvince,
    dispute.jurisdictionLocality,
  );
}

export async function lookupTransferTargetUseCase(
  session: Session,
  input: LookupTransferTargetInput,
): Promise<LookupTransferTargetResult> {
  const id = input.id.trim();
  if (!id) return { found: false, error: "ID vacío." };

  const disputeToken = input.disputeToken.trim();
  if (!disputeToken) return { found: false, error: "Falta la disputa." };

  // Scope gate: bind the lookup to a dispute the caller may act on.
  if (session.profile.role !== "admin" && session.profile.role !== "govt") {
    return { found: false, error: "No tenés permiso para esta acción." };
  }
  const [dispute] = await db
    .select({
      jurisdictionProvince: custodyDisputes.jurisdictionProvince,
      jurisdictionLocality: custodyDisputes.jurisdictionLocality,
    })
    .from(custodyDisputes)
    .where(eq(custodyDisputes.publicToken, disputeToken))
    .limit(1);
  if (!dispute) return { found: false, error: "Disputa no encontrada." };
  if (session.profile.role === "govt" && !isGovtInScope(session.jurisdictions, dispute)) {
    return { found: false, error: "Esta disputa está fuera de tu jurisdicción." };
  }

  try {
    if (input.kind === "user") {
      const [row] = await db
        .select({ displayName: profiles.displayName, deactivatedAt: profiles.deactivatedAt })
        .from(profiles)
        .where(eq(profiles.id, id))
        .limit(1);
      if (!row) return { found: false, error: "Usuario no encontrado." };
      return {
        found: true,
        displayName: row.displayName ?? id,
        active: row.deactivatedAt === null,
      };
    }
    const [row] = await db
      .select({ displayName: organizations.displayName, status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    if (!row) return { found: false, error: "Organización no encontrada." };
    return {
      found: true,
      displayName: row.displayName,
      active: row.status === "active",
    };
  } catch {
    return { found: false, error: "Error al verificar el destino." };
  }
}
