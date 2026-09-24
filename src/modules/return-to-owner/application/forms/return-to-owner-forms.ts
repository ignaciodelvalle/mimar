// Form-adapter use-cases for the return-to-owner flow (strangler 37/61).
// Whole-body verbatim move from app/actions/return-to-owner-form.ts.
// These adapt proposeReturnToOwnerAction / ownerAcceptReturnAction /
// ownerRejectReturnAction / actorCancelProposalAction to the
// (staticArg, _prev, formData) signature required by useActionState.

import {
  actorCancelProposalAction,
  ownerAcceptReturnAction,
  ownerProposeReturnToOrgAction,
  ownerRejectReturnAction,
  proposeReturnToOwnerAction,
} from "@/app/actions/return-to-owner";
import type { ProposeReturnFormState } from "@/app/org/[orgToken]/mascotas/[publicToken]/devolver-al-dueno/ProposeReturnForm";

import type {
  AcceptReturnFormState,
  CancelProposalFormState,
  OwnerProposeReturnToOrgFormState,
  RejectReturnFormState,
} from "./types";

// ---------------------------------------------------------------------------
// proposeReturnToOwnerFormAction — for refugio's ProposeReturnForm
// ---------------------------------------------------------------------------

// @no-auth-required: thin wrapper to adapt the signature for useActionState.
// Auth runs inside `proposeReturnToOwnerAction`, which this delegates to.
export async function proposeReturnToOwnerFormAction(
  orgToken: string,
  petPublicToken: string,
  _prev: ProposeReturnFormState,
  formData: FormData,
): Promise<ProposeReturnFormState> {
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const result = await proposeReturnToOwnerAction({
    petPublicToken,
    actorMode: "refugio",
    orgToken,
    notes,
  });

  if ("error" in result) return { error: result.error };
  return { error: null, success: true };
}

// ---------------------------------------------------------------------------
// ownerAcceptReturnFormAction — for owner's ReturnAcceptanceCard
// ---------------------------------------------------------------------------

// @no-auth-required: thin wrapper to adapt the signature for useActionState.
// Auth runs inside `ownerAcceptReturnAction`, which this delegates to.
export async function ownerAcceptReturnFormAction(
  petPublicToken: string,
  _prev: AcceptReturnFormState,
  _formData: FormData,
): Promise<AcceptReturnFormState> {
  const result = await ownerAcceptReturnAction({ petPublicToken });

  if ("error" in result) return { error: result.error };
  if (result.ok && "autoCancelled" in result && result.autoCancelled) {
    return { error: null, autoCancelled: true, autoCancelReason: result.reason };
  }
  return { error: null };
}

// ---------------------------------------------------------------------------
// ownerRejectReturnFormAction — for owner's reject inline form
// ---------------------------------------------------------------------------

// @no-auth-required: thin wrapper to adapt the signature for useActionState.
// Auth runs inside `ownerRejectReturnAction`, which this delegates to.
export async function ownerRejectReturnFormAction(
  petPublicToken: string,
  _prev: RejectReturnFormState,
  formData: FormData,
): Promise<RejectReturnFormState> {
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Ingresá un motivo para el rechazo." };

  const result = await ownerRejectReturnAction({ petPublicToken, reason });

  if ("error" in result) return { error: result.error };
  return { error: null, success: true };
}

// ---------------------------------------------------------------------------
// ownerProposeReturnToOrgFormAction — for owner's OwnerInitiateReturnForm
// ---------------------------------------------------------------------------

// Mirror of OwnerInitiateReturnForm's RETURN_REASONS options.
const OWNER_RETURN_REASONS = new Set([
  "post_adoption_failed_return",
  "space_constraint",
  "specialization_needed",
  "other",
]);

// @no-auth-required: thin wrapper to adapt the signature for useActionState.
// Auth runs inside `ownerProposeReturnToOrgAction`, which this delegates to.
export async function ownerProposeReturnToOrgFormAction(
  petPublicToken: string,
  _prev: OwnerProposeReturnToOrgFormState,
  formData: FormData,
): Promise<OwnerProposeReturnToOrgFormState> {
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Elegí un motivo para la devolución." };
  // Only the reasons the form offers — other custodyTransferReason enum
  // values are valid for the event schema but wrong for this flow.
  if (!OWNER_RETURN_REASONS.has(reason)) return { error: "Motivo inválido." };

  const notes = String(formData.get("notes") ?? "").trim() || null;
  const proposedAt = String(formData.get("proposedAt") ?? "").trim();
  const proposedAtDate = proposedAt ? new Date(proposedAt) : new Date();
  if (Number.isNaN(proposedAtDate.getTime())) {
    return { error: "Fecha inválida." };
  }

  const result = await ownerProposeReturnToOrgAction({
    petPublicToken,
    reason,
    notes,
    proposedAt: proposedAtDate.toISOString(),
  });

  if ("error" in result) return { error: result.error };
  return { error: null, success: true };
}

// ---------------------------------------------------------------------------
// actorCancelProposalFormAction — for actor's cancel UI
// ---------------------------------------------------------------------------

// @no-auth-required: thin wrapper to adapt the signature for useActionState.
// Auth runs inside `actorCancelProposalAction`, which this delegates to.
export async function actorCancelProposalFormAction(
  petPublicToken: string,
  orgToken: string | undefined,
  _prev: CancelProposalFormState,
  formData: FormData,
): Promise<CancelProposalFormState> {
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Ingresá un motivo para la cancelación." };

  const result = await actorCancelProposalAction({ petPublicToken, reason, orgToken });

  if ("error" in result) return { error: result.error };
  return { error: null, success: true };
}
