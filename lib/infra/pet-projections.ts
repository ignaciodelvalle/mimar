// Perf projections for the pets table.
//
// These are PERFORMANCE projections, not security boundaries — every caller
// is already behind an auth guard that enforces access control. The purpose
// is to avoid transferring all 68 columns of the pets table when a page only
// needs 8-10 of them.
//
// Naming convention: PET_<SURFACE>_SELECT, mirroring welfare-org-projection.ts.
// For one-off surfaces, prefer inlining the projection object directly in the
// query rather than exporting a named constant.

import { attachments, pets } from "@/db";

// ---------------------------------------------------------------------------
// Pet list card — /mis-mascotas list view.
//
// Consumed by: app/(app)/mis-mascotas/page.tsx
// Fields needed: id (reminder lookup), name, status (filter + lnStatus),
//   species (speciesLabelShort), breed (breedLine), sex (breedLine),
//   pregnancyStatus (lnStatus), publicToken (href).
// The photo storagePath comes from the attachments join — not a pets column.
// ---------------------------------------------------------------------------
export const PET_CARD_SELECT = {
  id: pets.id,
  name: pets.name,
  status: pets.status,
  species: pets.species,
  breed: pets.breed,
  sex: pets.sex,
  pregnancyStatus: pets.pregnancyStatus,
  publicToken: pets.publicToken,
} as const;

// ---------------------------------------------------------------------------
// Pet observation detail — /admin/observaciones/[publicToken]
//
// Consumed by: app/admin/observaciones/[publicToken]/page.tsx
// Fields needed: id (event query), name (header + breadcrumb), species (card),
//   publicToken (guard query + form bind), rabiesObservationStatus (guard),
//   jurisdictionProvince (scope check), jurisdictionLocality (scope check + card).
// ---------------------------------------------------------------------------
export const PET_OBSERVATION_SELECT = {
  id: pets.id,
  name: pets.name,
  species: pets.species,
  publicToken: pets.publicToken,
  rabiesObservationStatus: pets.rabiesObservationStatus,
  jurisdictionProvince: pets.jurisdictionProvince,
  jurisdictionLocality: pets.jurisdictionLocality,
} as const;

// ---------------------------------------------------------------------------
// Pet libreta share — /libreta/compartir/[shareToken]
//
// Consumed by: app/libreta/compartir/[shareToken]/page.tsx
// Fields needed: id (photo + event queries), name (callout + identity header),
//   species (TerminalShell label + identity header), breed (identity header),
//   sex (identity header), publicToken (identity header + LibretaSanitariaView),
//   status (deceased branch), primaryPhotoId (photo query).
// ---------------------------------------------------------------------------
export const PET_LIBRETA_SHARE_SELECT = {
  id: pets.id,
  name: pets.name,
  species: pets.species,
  breed: pets.breed,
  sex: pets.sex,
  publicToken: pets.publicToken,
  status: pets.status,
  primaryPhotoId: pets.primaryPhotoId,
} as const;

// ---------------------------------------------------------------------------
// Pet card photo attachment — used alongside PET_CARD_SELECT.
// ---------------------------------------------------------------------------
export const PET_CARD_PHOTO_SELECT = {
  storagePath: attachments.storagePath,
} as const;
