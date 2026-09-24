// Physical-tag read helpers (physical-tag-lifecycle D3).
//
// Two reads, both PII-safe BY CONSTRUCTION:
//
//   lookupTagBySerial       — resolves a serial to {status, publicToken?} and
//                             NOTHING else. The projection never includes
//                             activation_code_hash, pet name, or any owner
//                             field, so no caller (including the public
//                             /t/[serial] resolver) can leak them.
//
//   tagActivationCodeMatches — proof-of-possession check for activation. The
//                             attempted code is hashed in JS and compared
//                             INSIDE the SQL predicate with a constant
//                             projection (chip-lookup.ts attemptedChipMatchesPet
//                             shape): the stored hash is never SELECTed, the
//                             code is never echoed, and there is no string
//                             comparison in JS to time.

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, petTags, pets } from "@/db";
import type { PetTagStatus } from "@/db/schema";
import { hashTagActivationCode } from "@/lib/utils/tag-code-hash";

export type TagLookupResult = {
  status: PetTagStatus;
  /**
   * Public token of the linked pet — present only once a pet is linked AND
   * that pet still resolves publicly. PO-4 (2026-08-05): a soft-deleted pet
   * yields `null` here even on an ACTIVE tag, so the resolver page renders its
   * neutral "no disponible" state instead of bouncing the scanner into a 404.
   */
  publicToken: string | null;
} | null;

/** Normalize user/URL input to the canonical serial shape (TAG-XXXX-XXXX). */
export function normalizeTagSerial(raw: string): string {
  return raw.trim().toUpperCase();
}

// Pure DB lookup — no auth, no session. Callers gate capability and rate-limit.
export async function lookupTagBySerial(serial: string): Promise<TagLookupResult> {
  const normalized = normalizeTagSerial(serial ?? "");
  if (!normalized) return null;

  const [row] = await db
    .select({
      status: petTags.status,
      publicToken: pets.publicToken,
    })
    .from(petTags)
    // The join carries the soft-delete filter (PO-4): an erased subject's pet
    // must not hand this projection a token that no public page will honour.
    // Filtering HERE and not at the page keeps the tag row itself readable —
    // the resolver still knows the chapa is active and can say something
    // honest — while the destination simply stops existing.
    .leftJoin(pets, and(eq(pets.id, petTags.petId), isNull(pets.deletedAt)))
    .where(eq(petTags.serial, normalized))
    .limit(1);

  if (!row) return null;

  return { status: row.status, publicToken: row.publicToken ?? null };
}

/** Minimal executor shape so the predicate can run inside a transaction. */
type SqlExecutor = Pick<typeof db, "select">;

/**
 * Does `attemptedCode` match the stored activation-code hash for this tag row?
 *
 * Returns false for an empty attempt and for an unknown tag id: a uniform "no"
 * that says nothing about which of the two it was. Pass the enclosing
 * transaction as `executor` when calling from a writer so the check shares the
 * FOR UPDATE row lock's consistency.
 */
export async function tagActivationCodeMatches(
  tagId: string,
  attemptedCode: string,
  executor: SqlExecutor = db,
): Promise<boolean> {
  const code = attemptedCode?.trim();
  if (!tagId || !code) return false;

  const [row] = await executor
    .select({ present: sql<number>`1` })
    .from(petTags)
    .where(and(eq(petTags.id, tagId), eq(petTags.activationCodeHash, hashTagActivationCode(code))))
    .limit(1);

  return row !== undefined;
}
