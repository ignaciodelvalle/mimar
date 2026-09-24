// Physical tag (chapa) payload schemas — migration 0169.
//
// Split out of event-schemas.ts, which is at its file-size ratchet
// (scripts/file-size-baseline.json). The registry in event-schemas.ts imports
// these two and maps them to `tag_activated` / `tag_revoked`; nothing else
// changes about how they are validated.
//
// SECURITY INVARIANT: neither payload may EVER carry the activation code —
// plaintext or hashed, under any field name. `.strict()` enforces it: an
// accidental `code` / `activation_code` key throws at validate() time before
// the row reaches the immutable spine.

import { z } from "zod";

import { withVersion } from "./payload-version";

/**
 * Owner self-activation of a manufactured tag. `source` is fixed to "self" in
 * v1 (admin-assisted activation would be a new source value, not a new type).
 */
export const tagActivated = z
  .object(
    withVersion({
      serial: z.string().min(1),
      lote_id: z.string().nullable(),
      source: z.literal("self"),
    }),
  )
  .strict();

/**
 * Owner revocation of an ACTIVE tag (design D4: blank tags cannot be revoked —
 * there is no pet to hang the event on).
 *
 * The payload key is `revoke_reason`, NOT `reason`. HISTORICAL NOTE: until
 * migration 0240 (T3-A2b), erase_subject_data sentinel-redacted the key
 * `reason` across ALL event types, which would have destroyed this enum fact
 * (design D5). Since 0240 erasure acts on each key's privacy class
 * (lib/events/payload-privacy.ts), so the name no longer matters; it stays.
 * `replacement_serial` links to the new tag when the owner revokes to replace
 * (e.g. after a custody transfer).
 */
export const tagRevoked = z
  .object(
    withVersion({
      serial: z.string().min(1),
      revoke_reason: z.enum(["lost", "damaged", "transfer", "fraud", "owner_request", "other"]),
      replacement_serial: z.string().nullable(),
    }),
  )
  .strict();
