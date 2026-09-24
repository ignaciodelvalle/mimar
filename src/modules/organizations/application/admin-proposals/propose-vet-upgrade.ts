// Use-case: proposeVetUpgradeForUser
//
// Validates actor authority, canonicalizes the operational jurisdiction and
// requires it inside a govt actor's mandate, checks for pending duplicates,
// then inside a
// db.transaction: inserts the approval_request and collects the target
// notification.
//
// Post-tx: flushes pendingNotifications (§2.2 — NOT inside the tx).
//
// Returns { ok: true; publicToken: string } on success or { error: string }
// on any failure.

import { and, eq } from "drizzle-orm";

import { approvalRequests, db, notifications, profiles } from "@/db";
import {
  CoordError,
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";
import { validateApprovalPayload } from "@/lib/infra/approval-payloads";
import { generateApprovalRequestToken } from "@/lib/infra/publicToken";
import { generateUniqueToken } from "@/lib/infra/unique-token";

import {
  OUT_OF_JURISDICTION_PROPOSAL_ERROR,
  canProposeInJurisdiction,
  loadActorAuthority,
} from "./helpers";
import type { ProposalResult } from "./types";

async function hasPendingOfType(
  applicantUserId: string,
  type: Parameters<typeof validateApprovalPayload>[0],
): Promise<boolean> {
  const [row] = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.applicantUserId, applicantUserId),
        eq(approvalRequests.type, type),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function proposeVetUpgradeForUser(
  actorUserId: string,
  input: {
    targetUserId: string;
    matriculaNumber: string;
    matriculaJurisdiccion: string;
    operationalProvince: string;
    operationalLocality: string;
    especialidad?: string | null;
    anosExperiencia?: number | null;
  },
): Promise<ProposalResult> {
  const auth = await loadActorAuthority(actorUserId);
  if ("error" in auth) return { error: auth.error };

  // Canonicalize the operational jurisdiction strictly against the INDEC
  // catalog (same path as the self-service requestVetUpgradeForUser). The
  // stored pair decides which govt queue sees the request and whether
  // canDecideRequest admits a decider, so it must be the canonical spelling —
  // and the scope check below compares canonical against canonical.
  let opProvince: string;
  let opLocality: string;
  try {
    const normalizedOp = await normalizeLocationForWrite(
      {
        province: input.operationalProvince,
        provinceCode: null,
        locality: input.operationalLocality,
        localityIndecId: null,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "strict" },
    );
    if (!normalizedOp.province || !normalizedOp.locality) {
      return { error: "La jurisdicción donde ejerce no es válida." };
    }
    opProvince = normalizedOp.province;
    opLocality = normalizedOp.locality;
  } catch (err) {
    if (err instanceof JurisdictionValidationError || err instanceof CoordError) {
      return { error: err.message };
    }
    throw err;
  }

  // Admin proposes anywhere; a govt only inside its own active assignments
  // (A10-2). Fail closed: a govt with no assignment proposes nowhere.
  if (!canProposeInJurisdiction(auth, opProvince, opLocality)) {
    return { error: OUT_OF_JURISDICTION_PROPOSAL_ERROR };
  }

  const [target] = await db
    .select({ id: profiles.id, role: profiles.role })
    .from(profiles)
    .where(eq(profiles.id, input.targetUserId))
    .limit(1);
  if (!target) return { error: "Usuario destino no encontrado." };
  if (target.role === "vet") return { error: "El usuario ya es veterinario." };

  if (await hasPendingOfType(input.targetUserId, "role_upgrade_vet")) {
    return { error: "Ya hay una solicitud pendiente para este usuario." };
  }

  let payload: unknown;
  try {
    payload = validateApprovalPayload("role_upgrade_vet", {
      matricula_number: input.matriculaNumber.trim(),
      matricula_jurisdiccion: input.matriculaJurisdiccion.trim(),
      especialidad: input.especialidad?.trim() || null,
      anos_experiencia:
        typeof input.anosExperiencia === "number" && Number.isFinite(input.anosExperiencia)
          ? input.anosExperiencia
          : null,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Payload inválido." };
  }

  const publicToken = await generateUniqueToken(
    approvalRequests,
    approvalRequests.publicToken,
    generateApprovalRequestToken,
  );
  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  await db.transaction(async (tx) => {
    await tx.insert(approvalRequests).values({
      publicToken,
      type: "role_upgrade_vet",
      status: "pending",
      applicantUserId: input.targetUserId,
      initiatedBy: "authority",
      initiatedByUserId: actorUserId,
      targetUserId: input.targetUserId,
      jurisdictionProvince: opProvince,
      jurisdictionLocality: opLocality,
      payload,
    });
    pendingNotifications.push({
      userId: input.targetUserId,
      notificationType: "approval_request_proposed_authority",
      title: "Te propusieron el rol veterinario",
      body: "Una autoridad inició una solicitud para verificar tu matrícula. Vas a recibir una respuesta cuando se decida.",
      severity: "info",
      ctaLabel: "Ver detalle",
      ctaUrl: "/cuenta/upgrade",
    });
  });

  if (pendingNotifications.length > 0) {
    try {
      await db.insert(notifications).values(pendingNotifications);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  return { ok: true, publicToken };
}
