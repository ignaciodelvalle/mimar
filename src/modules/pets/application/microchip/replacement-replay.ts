// Replay check before state guard (plan A5c), for the three microchip-replace
// server actions (owner, org, admin).
//
// A PURE REVOCATION leaves the animal with no active chip. Each action refuses
// "no tiene microchip registrado" when there is no chip to replace — and that
// is exactly the state the FIRST successful revocation leaves behind, so its
// retry (same key, the response lost) was refused on its own success. The v1
// events route already asked the ledger first (append-special-kinds.ts); all
// four doors now ask through this one helper.
//
// Scoped to the ACTOR as well as the pet and key: a key some other person used
// on this animal must not answer this caller as if it were theirs.

import { findExistingByKey } from "@/lib/events/event-idempotency";

/** The `microchip_replaced` this caller's key already wrote on the pet, or null. */
export async function findReplayedReplacement(
  petId: string,
  clientIdempotencyKey: string | null,
  userId: string,
): Promise<{ id: string } | null> {
  if (!clientIdempotencyKey) return null;
  const original = await findExistingByKey(petId, "microchip_replaced", clientIdempotencyKey);
  return original !== null && original.recordedByUserId === userId ? { id: original.id } : null;
}
