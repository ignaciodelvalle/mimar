// Full use-case body for the PPP CABA RUPPPA registration PDF (Chunk F, F2).
// Moved verbatim from app/actions/ppp-export-caba.ts (strangler 36/61, 2026-06-30).
//
// Decision F-D3+D4 (CABA only): validates pet.jurisdictionProvince === "Ciudad Autónoma de
//   Buenos Aires". Prov BA is NOT implemented in this PR.
//   TODO(F2-prov-ba-v2): when Prov BA PPP support is added, extend the guard below.
//
// Role gate: LEGAL owner only (`ownerships.role = 'owner'`, open row). A foster
//   or caretaker also holds an open ownership row; before security review
//   2026-09 any of them could call this directly and get the certificate the
//   page only offers the titular (lib/domain/ppp-export-eligibility.ts). No
//   org-path access — PPP registration is the titular's personal duty.
//
// Decision F-D5: audit_log action = "ppp_export_generated" (snake_case).
// Decision F-D6: storage bucket = "ppp-exports" (private, separate from welfare-exports).
//
// NOTE: auth (requireUserOrRedirect + supabase.auth.getUser) is kept inline —
// it is interleaved with validation and business logic in the original action.
// DO NOT lift any guard into the shim; that would reorder checks and change behavior.

import { and, eq, isNull } from "drizzle-orm";

import { auditLog, db, ownerships, pets, profiles } from "@/db";
import {
  CABA_PROVINCE,
  PPP_EXPORT_SCHEMA_VERSION,
  generatePppCabaPdf,
} from "@/lib/analytics/ppp-exports";
import { createSignedExportUrl, uploadExportToStorage } from "@/lib/analytics/welfare-exports";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { formatDateTimeLegal } from "@/lib/utils/format";

import type { GeneratePppExportResult } from "./types";

// 24h TTL for the export PDF signed URL.
const EXPORT_URL_TTL_SECONDS = 24 * 60 * 60;

/**
 * Generates a PPP CABA RUPPPA registration PDF for the pet identified by
 * `petPublicToken`. The authenticated user MUST be the pet's owner.
 *
 * CABA jurisdiction gate (F-D3+D4): the pet's jurisdictionProvince must equal
 * "Ciudad Autónoma de Buenos Aires". Prov BA pets receive error "ppp_prov_ba_not_implemented".
 * TODO(F2-prov-ba-v2): extend when Ley 14.107 municipal registry support is added.
 */
export async function generatePppExport(petPublicToken: string): Promise<GeneratePppExportResult> {
  const { supabase, user } = await requireUserOrRedirect();

  // Ownership check: pet must exist and this user must be its LEGAL owner.
  const [ownerRow] = await db
    .select({
      petId: pets.id,
      petName: pets.name,
      petSpecies: pets.species,
      petBreed: pets.breed,
      petDateOfBirth: pets.dateOfBirth,
      petPotentiallyDangerousBreed: pets.potentiallyDangerousBreed,
      petJurisdictionProvince: pets.jurisdictionProvince,
      petJurisdictionLocality: pets.jurisdictionLocality,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, petPublicToken),
        eq(ownerships.ownerUserId, user.id),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);

  if (!ownerRow) return { ok: false, error: "not_found" };

  // PPP eligibility check: only pets with potentiallyDangerousBreed = true can
  // generate a PPP export document.
  if (!ownerRow.petPotentiallyDangerousBreed) {
    return { ok: false, error: "pet_not_ppp_for_jurisdiction" };
  }

  // Jurisdiction gate (F-D3+D4 — CABA only in v1).
  if (ownerRow.petJurisdictionProvince !== CABA_PROVINCE) {
    // TODO(F2-prov-ba-v2): when Prov BA PPP support is implemented, handle
    // jurisdictionProvince === "Buenos Aires" here with a separate PDF template
    // and bucket path `${petPublicToken}/prov_ba/${timestamp}.pdf`.
    return { ok: false, error: "ppp_prov_ba_not_implemented" };
  }

  // Load owner profile and canonical chip in parallel.
  const [ownerProfile, identifications] = await Promise.all([
    db
      .select({
        displayName: profiles.displayName,
        // Wave 5 Item 25a: no DNI in plaintext. PPP PDF shows last-4 only.
        // If the legal form ever requires the full DNI, it must be fetched
        // on-demand from Mi Argentina (see TODO 25b) — never from this DB.
        dniLast4: profiles.dniLast4,
        dniVerified: profiles.dniVerified,
      })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1)
      .then((rows) => rows[0]),
    fetchActiveIdentifications(ownerRow.petId),
  ]);

  // Get auth email from Supabase Auth (not stored in profiles by default).
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  const ownerEmail = authUser?.email ?? "email no disponible";

  const exportGeneratedAt = new Date();

  // Build DTO and render PDF.
  const dto = {
    petName: ownerRow.petName,
    petPublicToken,
    petSpecies: ownerRow.petSpecies,
    petBreed: ownerRow.petBreed ?? null,
    petDateOfBirth: ownerRow.petDateOfBirth ?? null,
    petMicrochipId: identifications.microchip?.code ?? null,
    petPotentiallyDangerousBreed: ownerRow.petPotentiallyDangerousBreed,
    ownerDisplayName: ownerProfile?.displayName ?? "Propietario",
    // Wave 5 Item 25a: PPP PDF now receives last-4 only (no plaintext DNI).
    // TODO(25b): if RUPPPA requires the full DNI, fetch it on-demand from
    // Mi Argentina claims — never store it.
    // Wave 5 Item 25a (A7 fix): derive masked DNI display from dniVerified + dniLast4.
    // NEVER reconstruct or expose a full DNI — it was removed in migration 0106.
    // Verified owner → masked last-4 with source attribution.
    // Unverified owner → null (renderer shows the "organismo" fallback message).
    ownerDniNumber:
      ownerProfile?.dniVerified && ownerProfile.dniLast4
        ? `DNI ····${ownerProfile.dniLast4} — verificado por Mi Argentina`
        : null,
    ownerEmail,
    jurisdictionProvince: ownerRow.petJurisdictionProvince ?? CABA_PROVINCE,
    jurisdictionLocality: ownerRow.petJurisdictionLocality ?? null,
    // AR-pinned legal timestamp with explicit "(hora de Argentina)" label
    // (bug 4, staging validation 2026-07-04) — a bare toLocaleString used the
    // server's ambient zone (UTC) on a legal document.
    exportGeneratedAt: formatDateTimeLegal(exportGeneratedAt),
  };

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generatePppCabaPdf(dto);
  } catch (err) {
    console.error("[ppp-export-caba] PDF render failed:", err);
    return { ok: false, error: "pdf_render_failed" };
  }

  // Upload to ppp-exports bucket.
  const timestamp = exportGeneratedAt.getTime();
  const storagePath = `${petPublicToken}/caba/${timestamp}.pdf`;

  // Storage runs as service role (migration 0172) — the strict ownership check
  // above is the authorization; the bucket has no authenticated policy.
  const uploadResult = await uploadExportToStorage("ppp-exports", storagePath, pdfBytes);
  if ("error" in uploadResult) {
    console.error("[ppp-export-caba] Storage upload failed:", uploadResult.error);
    return { ok: false, error: "storage_upload_failed" };
  }

  // Create signed URL (24h).
  const signedUrl = await createSignedExportUrl("ppp-exports", storagePath, EXPORT_URL_TTL_SECONDS);
  if (!signedUrl) {
    return { ok: false, error: "signed_url_failed" };
  }

  // Audit log.
  await db.insert(auditLog).values({
    actorUserId: user.id,
    action: "ppp_export_generated",
    payload: {
      petId: ownerRow.petId,
      petPublicToken,
      targetJurisdiction: "caba",
      breed: ownerRow.petBreed ?? null,
      schemaVersion: PPP_EXPORT_SCHEMA_VERSION,
    },
  });

  return {
    ok: true,
    signedUrl,
    expiresAt: new Date(Date.now() + EXPORT_URL_TTL_SECONDS * 1000),
  };
}
