"use server";

// libreta-share.ts — thin shim (strangler migration 32/61).
//
// Business logic moved to:
//   src/modules/pets/application/libreta-share/
//
// This file provides the action wrappers used by UI components plus
// logLibretaShareViewForToken (token-credentialed telemetry) and the public
// types. The bare ForUser writers (createLibretaShareForUser,
// revokeLibretaShareForUser) are NOT exported here (authz triage 2026-07-04):
// every export of a "use server" file is an independently-addressable server
// action, so a bare writer taking a caller-supplied userId would let any
// client mint a Tier-2 MEDICAL share as the victim. Callers import the
// writers from src/modules/pets/application/libreta-share/ directly.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import type { LibretaShareToken } from "@/db";
import { requireLiveUser } from "@/lib/infra/live-user";
import { requirePetAccess, requireTitularAccess } from "@/lib/infra/pet-access";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { createLibretaShareForUser as _createLibretaShareForUser } from "@/src/modules/pets/application/libreta-share/create-libreta-share";
import { getActiveLibretaShares as _getActiveLibretaShares } from "@/src/modules/pets/application/libreta-share/get-active-libreta-shares";
import { logLibretaShareViewForToken as _logLibretaShareViewForToken } from "@/src/modules/pets/application/libreta-share/log-libreta-share-view";
import {
  findPetPublicTokenForShare as _findPetPublicTokenForShare,
  revokeLibretaShareForUser as _revokeLibretaShareForUser,
} from "@/src/modules/pets/application/libreta-share/revoke-libreta-share";
import type {
  CreateShareInput,
  CreateShareResult,
  RevokeShareResult,
} from "@/src/modules/pets/application/libreta-share/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  CreateShareInput,
  CreateShareResult,
  RevokeShareResult,
} from "@/src/modules/pets/application/libreta-share/types";

// ---------------------------------------------------------------------------
// Token-credentialed view-counter writer — the share token itself is the
// credential (validated inside the module writer before any DB write).
// Since migration 0167 (TEL-1) this bumps the token's cached counters and
// records nothing about the viewer.
// ---------------------------------------------------------------------------

export async function logLibretaShareViewForToken(input: {
  shareToken: string;
}): Promise<void> {
  return _logLibretaShareViewForToken(input);
}

// ---------------------------------------------------------------------------
// Form-action wrappers — read auth session, delegate to inner writers.
// ---------------------------------------------------------------------------

export async function createLibretaShareAction(
  input: CreateShareInput,
): Promise<CreateShareResult> {
  // Deny-list row libreta-share-minting (custodia-temporal): a libreta share is
  // a bearer-readable public link to the animal's medical record — titular-only.
  //
  // This used to authorize on a bare `supabase.auth.getUser()` while the module
  // writer joined `ownerships` with NO role filter, so an active caretaker would
  // have minted one. requireTitularAccess closes that AND makes the action
  // deletion-aware for free (it funnels through requirePetAccess), which the
  // bare getUser never was.
  const titular = await requireTitularAccess(input.petPublicToken);
  if (!titular.ok) return { error: titular.error };
  const user = titular.user;

  const result = await _createLibretaShareForUser(user.id, input);
  if ("shareToken" in result) {
    revalidatePath(`/mis-mascotas/${input.petPublicToken}`);
  }
  return result;
}

export async function revokeLibretaShareAction(
  shareTokenRowId: string,
): Promise<RevokeShareResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  const result = await _revokeLibretaShareForUser(user.id, shareTokenRowId);
  if ("ok" in result) {
    const petPublicToken = await _findPetPublicTokenForShare(shareTokenRowId);
    if (petPublicToken) revalidatePath(`/mis-mascotas/${petPublicToken}`);
  }
  return result;
}

// @no-auth-required: view count from a public share link. The token itself is
// the credential; auth lives in `logLibretaShareViewForToken`, which validates
// the token before writing.
export async function logLibretaShareViewAction(input: {
  shareToken: string;
}): Promise<void> {
  // Per-(shareToken, IP) rate limit BEFORE the delegated write. This action is
  // independently invocable — an attacker can POST it directly (bypassing the
  // page's own `libreta_share_page` guard) to hammer the view-counter update.
  // Cap it at the same generous rate
  // as the page render so a legitimate viewer refreshing is never affected, then
  // silently drop on breach (telemetry is best-effort; ViewLogger swallows the
  // outcome regardless).
  let ip = "unknown";
  try {
    ip = callerIp(await headers());
  } catch {
    // Non-request context (e.g. direct test invocation) — fall back to "unknown".
  }
  try {
    await enforceRateLimit(`libreta_share_view:${input.shareToken}`, ip, {
      maxPerMinute: 30,
      maxPerHour: 200,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return;
    throw err;
  }

  await _logLibretaShareViewForToken(input);
}

// ---------------------------------------------------------------------------
// getActiveLibretaSharesAction — narrow read for MergedShareSheet (ADR-14).
//
// SharesManager moved out of LibretaFace into the `?sheet=compartir` sheet
// (SheetMounter is a sibling of PetDetailTabsPanel, so it can't read the
// Libreta face's deferred client-fetched data). This action reuses the SAME
// owner-only active-shares query get-libreta-face-data.ts runs, scoped down
// to just that slice, so MergedShareSheet can self-fetch on mount instead of
// forking SharesManager's data contract.
// ---------------------------------------------------------------------------

export async function getActiveLibretaSharesAction(
  petPublicToken: string,
): Promise<{ ok: true; shares: LibretaShareToken[] } | { ok: false; error: string }> {
  const access = await requirePetAccess(petPublicToken);
  if (!access.ok) return { ok: false, error: "Acceso denegado" };
  if (access.accessPath !== "owner") return { ok: true, shares: [] };

  const shares = await _getActiveLibretaShares(access.pet.id);
  return { ok: true, shares };
}
