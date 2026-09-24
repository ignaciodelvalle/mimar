// Use-case types for the physical-tag lifecycle writers
// (activate-tag.ts / revoke-tag.ts / issue-tag-batch.ts).

import { z } from "zod/v4";

import { PET_TAG_REVOKE_REASONS } from "@/db/schema";

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export const activateTagSchema = z.object({
  serial: z.string().min(1),
  // The wrapper-printed proof-of-possession code. NEVER echoed back: writers
  // hash it (lib/utils/tag-code-hash.ts) and compare inside a SQL predicate.
  activationCode: z.string().min(1),
  petId: z.string().uuid(),
  // Idempotency guard: stable UUID per form session. A re-submit returns the
  // original event instead of double-activating.
  clientIdempotencyKey: z.string().uuid().nullable().optional(),
});

export type ActivateTagInput = z.infer<typeof activateTagSchema>;

export type ActivateTagResult = { ok: true; eventId: string } | { error: string };

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export const revokeTagSchema = z.object({
  serial: z.string().min(1),
  revokeReason: z.enum(PET_TAG_REVOKE_REASONS),
  // Serial of the tag replacing this one (transfer/replacement flows), if any.
  replacementSerial: z.string().nullable().optional(),
  clientIdempotencyKey: z.string().uuid().nullable().optional(),
});

export type RevokeTagInput = z.infer<typeof revokeTagSchema>;

export type RevokeTagResult = { ok: true; eventId: string } | { error: string };

// ---------------------------------------------------------------------------
// Admin batch issuance (design D9, minimal scope)
// ---------------------------------------------------------------------------

export const issueTagBatchSchema = z.object({
  count: z.number().int().min(1).max(500),
  loteId: z.string().min(1).max(64),
});

export type IssueTagBatchInput = z.infer<typeof issueTagBatchSchema>;

export type IssuedTagRow = {
  serial: string;
  // Plaintext activation code — exists ONLY in this in-memory return value for
  // the issuance CSV response. Never persisted, never logged, never selected.
  activationCode: string;
};

export type IssueTagBatchResult = { ok: true; rows: IssuedTagRow[] } | { error: string };

// ---------------------------------------------------------------------------
// Shared failure copy
// ---------------------------------------------------------------------------

// UNIFORM activation failure (es-AR UI copy): wrong code, unknown serial and
// non-activatable state MUST all return this exact string so the response is
// not an oracle for which of the three it was.
export const ACTIVATION_FAILED_MESSAGE =
  "No pudimos activar la chapa. Revisá el número de serie y el código del envoltorio.";

// ---------------------------------------------------------------------------
// Writer failures
// ---------------------------------------------------------------------------

/**
 * A DELIBERATE, caller-facing refusal thrown by a tag writer — "this pet is not
 * yours", "only an active chapa can be revoked". Its message was written to be
 * returned.
 *
 * WHY THE MARKER EXISTS (error-hygiene audit, S1): both writers used to end
 * their transaction in a single `catch` that returned
 * `${err instanceof Error ? err.message : String(err)}` verbatim. That branch
 * cannot tell a refusal apart from a driver fault, so ANY unexpected failure —
 * a constraint violation naming a column, a Postgres error quoting the failing
 * statement, a bug's stack message — was handed to the browser and rendered in
 * the form's error banner. Marking the intended refusals lets everything else
 * be replaced by UNKNOWN_ERROR_FALLBACK without flattening the messages a user
 * can actually act on.
 *
 * NOT for the uniform evidence gate: activate-tag.ts keeps its own
 * UniformActivationFailure so wrong code / unknown serial / wrong state stay
 * indistinguishable.
 */
export class TagWriterRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TagWriterRefusal";
  }
}
