// Use-case types for replaceMicrochipForUser (strangler migration 13/61).

import { IDEMPOTENCY_KEY_PATTERN } from "@dim/contract/api";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const replaceMicrochipSchema = z.object({
  petId: z.string().uuid(),
  previousChipNumber: z.string().min(1),
  newChipNumber: z.string().nullable(),
  reason: z.enum([
    "damaged",
    "unreadable",
    "duplicate_detected",
    "fraud_detected",
    "owner_request",
    "device_failure",
    "other",
  ]),
  replacedBy: z.string().nullable().optional(),
  replacedAt: z.string(),
  notes: z.string().nullable().optional(),
  // Idempotency guard (projection-writes audit §6): stable UUID per form
  // session. When present, a re-submit returns the original event instead of
  // emitting a second microchip_replaced + flipping canonical rows again.
  //
  // THE CONTRACT'S PATTERN AND NOT `z.string().uuid()`, WHICH IS THE STRICTER
  // OF TWO DEFINITIONS THIS PATH USED TO CARRY. `POST /api/v1/pets/{token}/
  // events` admits any 8-4-4-4-12 hex on purpose — its docblock says "ANY
  // version… what is refused is anything that would not survive the cast" —
  // and `client_idempotency_key` is a Postgres `uuid`, which accepts the same
  // set. Zod 4's versionless `.uuid()` is narrower than both: it pins the
  // version nibble to [1-8] and the variant nibble to [89abAB], so a key from
  // a naive random-hex generator passed the door, threw HERE, and came back as
  // a bare `{ error }` with no `denied` flag — which the endpoint reports as
  // 500 + Sentry, forever, on every retry of an idempotent request. A refusal
  // the caller cannot see and cannot fix is exactly the failure class the
  // `denied` flag below was added to remove; a third definition of the key
  // would have re-introduced it one kind at a time.
  clientIdempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN).nullable().optional(),
  actorContext: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("owner") }),
    z.object({ kind: z.literal("vet_in_org"), organizationId: z.string().uuid() }),
    z.object({ kind: z.literal("admin") }),
  ]),
});

export type ReplaceMicrochipInput = z.infer<typeof replaceMicrochipSchema>;

export type ReplaceMicrochipResult =
  | { ok: true; eventId: string; caseId: string | null; wasDuplicate: boolean }
  // `denied` marks the actor-pet gate's own refusal — the caller is
  // authenticated and the body is well-formed, they simply do not hold this pet
  // in a role the act allows. An HTTP door answers 403 for that and 500 for the
  // rest; without the flag it could only tell them apart by message text.
  | { error: string; denied?: boolean };
