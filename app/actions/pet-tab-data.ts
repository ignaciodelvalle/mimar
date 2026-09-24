"use server";

// pet-tab-data.ts — thin shim (strangler migration 25/61). Business logic
// lives in src/modules/pets/application/tab-data/; this file adds the auth
// guard (requirePetAccess owner or org) and re-exports types.
// CRITICAL: every runtime export here must be async; types use `export type`.

import { requirePetAccess } from "@/lib/infra/pet-access";
import { getLibretaFaceData as _getLibretaFaceData } from "@/src/modules/pets/application/tab-data/get-libreta-face-data";
import type { LibretaFaceData } from "@/src/modules/pets/application/tab-data/types";

export type {
  HistorialEventRow,
  LibretaFaceData,
} from "@/src/modules/pets/application/tab-data/types";

// Amendment enrichment moved INTO the use-case (projection-cron audit
// 2026-07-03 A): overlayAmendments (lib/infra/amendment.ts — a lib helper,
// so the pets module still takes no events-module dependency) projects
// corrected payloads + amendedAt over the already-fetched stream. The old
// shim-side enrichment only set the badge and left payloads pre-correction.

// Libreta face (Face 2, two-face redesign 2026-07-01). Unlike the old
// getLibretaTabData/getVacunasTabData/getHistorialTabData (removed — see
// design deletion list), this guard allows accessPath === "org" too — org
// viewers get a lens-clamped read-only face (design ADR-6); activeShares
// stays owner-gated in the use-case.
export async function getLibretaFaceData(
  publicToken: string,
): Promise<{ ok: true; data: LibretaFaceData } | { ok: false; error: string }> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return { ok: false, error: "Acceso denegado" };
  const { user, pet, accessPath, organization } = access;
  return _getLibretaFaceData({ user, pet, accessPath, organization });
}
