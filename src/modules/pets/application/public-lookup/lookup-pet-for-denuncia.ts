// Public pet lookup for anonymous flows (handoff P4-2a).
//
// Wraps lib/chip-lookup with IP rate-limit and returns a minimal,
// non-leaky projection so anon users (denuncia wizard) can confirm
// "this microchip / token belongs to a registered pet" without
// exposing the owner record.
//
// Two query modes auto-detected from input shape:
//   - 15 digits → microchip
//   - DIM-XXXX-XXXX → public token
//   - anything else → not_found (no fuzzy matching to avoid scraping)

import { headers } from "next/headers";

import { db, pets } from "@/db";
import { DIM_TOKEN_PATTERN, normalizeDimTokenInput } from "@/lib/domain/dim-token";
import { lookupByChip } from "@/lib/infra/chip-lookup";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";

import type { PublicLookupResult } from "./types";

const MICROCHIP_PATTERN = /^\d{15}$/;

async function callerIpAddress(): Promise<string> {
  try {
    const reqHeaders = await headers();
    return callerIp(reqHeaders);
  } catch {
    return "unknown";
  }
}

// @no-auth-required: public lookup for the denuncia anon wizard.
// Returns ONLY {found, petName, petStatus} — nothing about the owner at all,
// and nothing else about the pet. Rate-limited per IP (60/min, 200/hour) to
// slow enumeration scraping — though note the rate limit was never the real
// defence here: the token is printed on the tag, so the attacker who matters
// is standing next to the animal and needs exactly one lookup.
export async function lookupPetForDenuncia(query: string): Promise<PublicLookupResult> {
  // ASCII-only case folding (lib/domain/dim-token.ts): Unicode `toUpperCase()`
  // turned lookalikes such as a dotless `ı` into a real token's letters.
  const trimmed = normalizeDimTokenInput(query);
  if (!trimmed) return { found: false };

  const ip = await callerIpAddress();
  try {
    await enforceRateLimit("denuncia_lookup", ip, { maxPerMinute: 60, maxPerHour: 200 });
  } catch (err) {
    if (err instanceof RateLimitError) return { found: false };
    throw err;
  }

  // Microchip path — uses the existing helper with the partial index.
  // `lookupByChip` also resolves the owner; this projection deliberately drops
  // everything it returns about them (see types.ts).
  if (MICROCHIP_PATTERN.test(trimmed)) {
    const result = await lookupByChip(trimmed);
    if (!result) return { found: false };
    return {
      found: true,
      petName: result.pet.name,
      petStatus: result.pet.status,
    };
  }

  // Token path — direct query against pets.public_token.
  //
  // NO JOIN TO THE OWNER. This used to leftJoin `ownerships` → `profiles` to
  // read `displayName` for the initials. With the initials gone the joins have
  // no purpose, and removing them makes the privacy property STRUCTURAL rather
  // than a matter of remembering not to return a field: an anonymous caller
  // cannot be leaked what the query never selects.
  if (DIM_TOKEN_PATTERN.test(trimmed)) {
    const [row] = await db
      .select({
        petName: pets.name,
        petStatus: pets.status,
      })
      .from(pets)
      // Art. 16 (PO-4): the canonical predicate, not a hand-rolled eq — an
      // erased pet answered here with its NAME until this was closed (it was
      // the declared debt in public-soft-delete-resolution.test.ts).
      .where(publicPetByToken(trimmed))
      .limit(1);
    if (!row) return { found: false };
    return {
      found: true,
      petName: row.petName,
      petStatus: row.petStatus as "active" | "lost" | "deceased",
    };
  }

  return { found: false };
}
