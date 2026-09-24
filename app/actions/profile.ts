"use server";

// profile.ts — thin shim (strangler migration 19/61).
//
// Business logic moved to: src/modules/pets/application/profile/
//
// This file provides thin Action wrappers that add the auth guard +
// revalidatePath. The bare ForUser writers (updateProfileForUser,
// uploadAvatarForUser) are NOT exported here (authz triage 2026-07-04):
// every export of a "use server" file is an independently-addressable server
// action, so a bare writer taking a caller-supplied userId would let any
// client update ANY user's profile by UUID. Callers import the writers from
// src/modules/pets/application/profile/ directly.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import {
  type UpdateEmergencyContactsInput,
  updateEmergencyContactsForPet as _updateEmergencyContactsForPet,
} from "@/src/modules/pets/application/profile/update-emergency-contacts";
import { updateProfileForUser as _updateProfileForUser } from "@/src/modules/pets/application/profile/update-profile";
import { uploadAvatarAndSign as _uploadAvatarAndSign } from "@/src/modules/pets/application/profile/upload-avatar";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  UpdateProfileResult,
  UploadAvatarResult,
} from "@/src/modules/pets/application/profile/types";
export type { UpdateEmergencyContactsInput } from "@/src/modules/pets/application/profile/update-emergency-contacts";

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

export async function updateProfileAction(input: {
  displayName: string;
  phone?: string;
  preferredVetName?: string;
  preferredVetPhone?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
}) {
  const { user } = await requireUserOrRedirect();
  const result = await _updateProfileForUser(user.id, input);
  if ("ok" in result) {
    revalidatePath("/cuenta");
  }
  return result;
}

/**
 * Thin delegation. The upload-and-sign composition lives in the application
 * layer (`uploadAvatarAndSign`) because `check-action-line-budget` freezes this
 * file's size and its message says exactly where logic belongs instead.
 */
export async function uploadAvatarAction(input: {
  fileBlob: Blob;
  fileName: string;
  mimeType: string;
  fileSize: number;
}): Promise<{ error: string } | { ok: true; avatarUrl: string | null }> {
  const { user } = await requireUserOrRedirect();
  const result = await _uploadAvatarAndSign(user.id, input);
  if ("ok" in result) revalidatePath("/cuenta");
  return result;
}

// updateEmergencyContactsAction — narrow write for the pet profile's
// `?sheet=emergencia` (owner-ia-redesign P2, PO decision 2). Writes the
// PET-LEVEL override columns (not the account default). Logic + ownership
// scoping live in update-emergency-contacts.ts; this wrapper only adds the
// auth guard and revalidatePath.
export async function updateEmergencyContactsAction(
  petPublicToken: string,
  input: UpdateEmergencyContactsInput,
) {
  const { user } = await requireUserOrRedirect();
  const result = await _updateEmergencyContactsForPet(user.id, petPublicToken, input);
  if ("ok" in result) {
    revalidatePath(`/mis-mascotas/${petPublicToken}`);
  }
  return result;
}
