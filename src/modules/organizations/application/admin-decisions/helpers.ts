// Shared helpers for admin-decisions use-cases.
//
// loadActorAuthority: shared by approveRequestForAuthority and rejectRequestForAuthority.
// ctaForApplicant: shared by approveRequestForAuthority and rejectRequestForAuthority.

import { and, eq, isNull } from "drizzle-orm";

import { type ApprovalRequest, db, govtAssignments, profiles } from "@/db";

// ---------------------------------------------------------------------------
// loadActorAuthority
// ---------------------------------------------------------------------------

type AuthorityLoad =
  | {
      ok: true;
      profile: { id: string; role: "admin" | "govt" };
      jurisdictions: { province: string; locality: string }[];
    }
  | { ok: false; error: string };

export async function loadActorAuthority(actorUserId: string): Promise<AuthorityLoad> {
  const [profile] = await db
    .select({ id: profiles.id, role: profiles.role })
    .from(profiles)
    .where(eq(profiles.id, actorUserId))
    .limit(1);
  if (!profile || (profile.role !== "admin" && profile.role !== "govt")) {
    return { ok: false, error: "Solo govt o admin pueden decidir solicitudes." };
  }
  let jurisdictions: { province: string; locality: string }[] = [];
  if (profile.role === "govt") {
    jurisdictions = await db
      .select({
        province: govtAssignments.jurisdictionProvince,
        locality: govtAssignments.jurisdictionLocality,
      })
      .from(govtAssignments)
      .where(and(eq(govtAssignments.userId, profile.id), isNull(govtAssignments.revokedAt)));
  }
  return { ok: true, profile: { id: profile.id, role: profile.role }, jurisdictions };
}

// ---------------------------------------------------------------------------
// ctaForApplicant
// ---------------------------------------------------------------------------

export function ctaForApplicant(request: ApprovalRequest): string {
  if (request.type === "service_dog_credential_verification") {
    const payload = (request.payload ?? {}) as { pet_public_token?: string };
    if (payload.pet_public_token) {
      return `/mis-mascotas/${payload.pet_public_token}/asistencia`;
    }
    return "/mis-mascotas";
  }
  if (request.targetOrganizationId) return "/org";
  return "/cuenta/upgrade";
}
