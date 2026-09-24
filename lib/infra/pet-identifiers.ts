// Canonical pet-identifier helpers.
//
// All readers that need chip/tattoo values MUST use these helpers instead of
// querying pets.microchip_* / pets.tattoo_* legacy columns directly.
// The legacy columns are kept only for double-write compatibility until the
// next PR drops them.
//
// Single-pet fetch:  fetchActiveIdentifications(petId)
// Batch fetch:       batchFetchActiveIdentifications(petIds)
//
// Both return the same { microchip?, tattoo? } shape. Callers that only need
// one kind can destructure what they need.

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db, petIdentifications } from "@/db";

// ---------------------------------------------------------------------------
// Return shapes
// ---------------------------------------------------------------------------

export type ActiveMicrochip = {
  code: string;
  isoCountryCode: string | null;
  recordedAt: string | null; // YYYY-MM-DD (maps to legacy microchipImplantedAt)
  recordedByLabel: string | null; // maps to legacy microchipImplantedBy
  implantationSite: string | null; // canonical enum; maps to legacy microchipLocation
};

export type ActiveTattoo = {
  code: string | null;
  tattooLocation: string | null;
  tattooDescription: string | null;
  recordedAt: string | null; // YYYY-MM-DD (maps to legacy tattooRecordedAt)
  recordedByLabel: string | null; // maps to legacy tattooRecordedBy
  photoId: string | null;
};

export type ActiveIdentifications = {
  microchip: ActiveMicrochip | null;
  tattoo: ActiveTattoo | null;
};

// ---------------------------------------------------------------------------
// Single-pet fetch
// ---------------------------------------------------------------------------

/**
 * Return the active chip and/or tattoo rows for one pet.
 * Fires a single query (two rows max — one per kind).
 */
export async function fetchActiveIdentifications(petId: string): Promise<ActiveIdentifications> {
  const rows = await db
    .select({
      kind: petIdentifications.kind,
      code: petIdentifications.code,
      isoCountryCode: petIdentifications.isoCountryCode,
      recordedAt: petIdentifications.recordedAt,
      recordedByLabel: petIdentifications.recordedByLabel,
      implantationSite: petIdentifications.implantationSite,
      tattooLocation: petIdentifications.tattooLocation,
      tattooDescription: petIdentifications.tattooDescription,
      photoId: petIdentifications.photoId,
    })
    .from(petIdentifications)
    .where(
      and(
        eq(petIdentifications.petId, petId),
        eq(petIdentifications.status, "active"),
        inArray(petIdentifications.kind, ["microchip_iso", "tattoo"]),
      ),
    )
    // Defensa en profundidad. El modelo es una fila activa por kind, y los
    // writers ahora superseden antes de insertar — pero si alguna vez quedan
    // dos, sin ORDER BY cuál gana depende del orden físico de Postgres, o sea
    // que la credencial mostraría el dato viejo o el nuevo de forma
    // no-determinística entre requests. Con orden, gana el más reciente.
    .orderBy(desc(petIdentifications.recordedAt), desc(petIdentifications.createdAt));

  // The single-pet projection omits petId (the WHERE already filters by it),
  // so rowsToIdentifications keys these rows under SINGLE_PET_KEY — indexing
  // by the UUID here would always miss and return empty identifications.
  return rowsToIdentifications(rows)[SINGLE_PET_KEY] ?? { microchip: null, tattoo: null };
}

/**
 * Existence-only microchip check: does this pet have an active chip row?
 *
 * PO-1 (2026-08-05) — the public adoption ficha may state THAT a pet is
 * chipped, never any part of the number. `fetchActiveIdentifications` would
 * answer the same question, but it SELECTs `code`, so the canonical national
 * identifier would land in server memory on an ungated route for no reason.
 * This projection is a constant (`1`): it cannot leak the code even if a
 * future caller renders whatever it gets back.
 *
 * Match semantics are identical to the microchip branch of
 * `rowsToIdentifications`: kind='microchip_iso', status='active', code present.
 */
export async function hasActiveMicrochip(petId: string): Promise<boolean> {
  const [row] = await db
    .select({ present: sql<number>`1` })
    .from(petIdentifications)
    .where(
      and(
        eq(petIdentifications.petId, petId),
        eq(petIdentifications.status, "active"),
        eq(petIdentifications.kind, "microchip_iso"),
        isNotNull(petIdentifications.code),
      ),
    )
    .limit(1);

  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Batch fetch
// ---------------------------------------------------------------------------

/**
 * Return active chip/tattoo rows for many pets in a single query.
 * Returns a Map keyed by petId. Missing pets are absent from the map (callers
 * should default to { microchip: null, tattoo: null }).
 */
export async function batchFetchActiveIdentifications(
  petIds: string[],
): Promise<Map<string, ActiveIdentifications>> {
  if (petIds.length === 0) return new Map();

  const rows = await db
    .select({
      petId: petIdentifications.petId,
      kind: petIdentifications.kind,
      code: petIdentifications.code,
      isoCountryCode: petIdentifications.isoCountryCode,
      recordedAt: petIdentifications.recordedAt,
      recordedByLabel: petIdentifications.recordedByLabel,
      implantationSite: petIdentifications.implantationSite,
      tattooLocation: petIdentifications.tattooLocation,
      tattooDescription: petIdentifications.tattooDescription,
      photoId: petIdentifications.photoId,
    })
    .from(petIdentifications)
    .where(
      and(
        inArray(petIdentifications.petId, petIds),
        eq(petIdentifications.status, "active"),
        inArray(petIdentifications.kind, ["microchip_iso", "tattoo"]),
      ),
    );

  const byPet = rowsToIdentifications(rows);
  return new Map(Object.entries(byPet));
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

type IdentificationRow = {
  petId?: string;
  kind: string;
  code: string | null;
  isoCountryCode: string | null;
  recordedAt: string | null;
  recordedByLabel: string | null;
  implantationSite: string | null;
  tattooLocation: string | null;
  tattooDescription: string | null;
  photoId: string | null;
};

// Accepts rows with or without a `petId` column (single vs. batch). For the
// single-pet case we accept the petId as the Map key via the caller's petId arg;
// we use a sentinel key here.
const SINGLE_PET_KEY = "__single__";

function rowsToIdentifications(rows: IdentificationRow[]): Record<string, ActiveIdentifications> {
  const out: Record<string, ActiveIdentifications> = {};

  for (const row of rows) {
    const key = row.petId ?? SINGLE_PET_KEY;
    if (!out[key]) out[key] = { microchip: null, tattoo: null };

    if (row.kind === "microchip_iso" && row.code) {
      out[key].microchip = {
        code: row.code,
        isoCountryCode: row.isoCountryCode,
        recordedAt: row.recordedAt,
        recordedByLabel: row.recordedByLabel,
        implantationSite: row.implantationSite,
      };
    } else if (row.kind === "tattoo") {
      out[key].tattoo = {
        code: row.code,
        tattooLocation: row.tattooLocation,
        tattooDescription: row.tattooDescription,
        recordedAt: row.recordedAt,
        recordedByLabel: row.recordedByLabel,
        photoId: row.photoId,
      };
    }
  }

  return out;
}
