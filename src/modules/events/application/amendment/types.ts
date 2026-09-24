// Use-case types for amendment actions (strangler migration 27/61).
// Moved verbatim from app/actions/amendment.ts.

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * What `amendEvent` is asked to write.
 *
 * NAMED `Command`, NOT `Input`, since 2026-08-25 (WU-J review FI-8). There was
 * an `AmendEventInput` in `@dim/contract/input` too, and the two are different
 * shapes for different sides of the same correction: the wire one carries
 * `{field, value}` and no identity (both are path segments), this one carries
 * `{field, old, new}` plus `publicToken` and `targetEventId`. Two exported types
 * with one name is an auto-import away from a file that compiles against the
 * wrong half — and the amend route imports from BOTH modules.
 */
export type AmendEventCommand = {
  publicToken: string;
  targetEventId: string;
  reason: string | null;
  changes: Array<{ field: string; old: unknown; new: unknown }>;
  /**
   * A caller-supplied idempotency key, when the transport has one.
   *
   * ABSENT ON THE WEB, AND THAT IS THE DEFAULT: a form post has no header to
   * carry one, so the writer derives its own from (target, actor, changes) —
   * which dedupes a double-clicked "Corregir" and nothing else. That derived key
   * is unchanged and still the fallback.
   *
   * PRESENT ON `/api/v1`, where `Idempotency-Key` is REQUIRED, because the
   * client this endpoint exists for is a phone on a subway: the retry that
   * matters is the one after a timeout, where the first request may well have
   * committed and the phone never heard the answer. The derived key cannot help
   * there — it dedupes identical CORRECTIONS, not identical REQUESTS, so an
   * owner who corrects a lot number, sees a timeout, and re-sends the same
   * correction is deduped by accident rather than by contract.
   *
   * The cost of honouring it, stated: the uniqueness index is
   * `(pet_id, event_type, client_idempotency_key)`, so a client that reused ONE
   * key for two DIFFERENT corrections on the same animal would silently no-op
   * the second. That is the standard idempotency contract — same key means same
   * request — and it is why the native client scopes its key to one correction
   * ATTEMPT rather than to a screen.
   */
  clientIdempotencyKey?: string | null;
};

/**
 * WHY a correction was refused, as something a caller can branch on.
 *
 * The failure arm used to be an untyped `string` carrying es-AR prose written
 * for a web form, and `/api/v1` had exactly one thing it could do with that:
 * answer `amend_failed` 500 to all of it. Two of these are the CALLER's fault
 * and one is the RECORD's — none of the three is a server incident, and telling
 * a phone "500, retry with the same key" for a reason it will never satisfy by
 * retrying is the loop `session_shift_expired` was split out to avoid.
 *
 * - `target_not_found` — no such event on this animal. 404 on the wire.
 * - `not_amendable`    — the record's type is outside the allowlist. The route
 *                        checks this BEFORE the write too, so reaching it here
 *                        means the two reads raced; 409 either way.
 * - `unknown_field` — a change names a field the target's payload schema does
 *   not have (T3-A2b): erasure classifies a correction by the target's rule for
 *   that field, so an unknown field would carry an unclassified value.
 * - `changes_required` — a correction that changes nothing. The wire schema
 *                        already refuses it (`CHANGES_REQUIRED`), so this is the
 *                        backstop for the web, whose form has no such parse.
 * - `reason_required`  — D5: an admin/govt actor must state a reason of at least
 *                        five characters. A fact about WHO is asking, which is
 *                        why it cannot live in the wire schema — the client does
 *                        not know its own role's rule until the server says so.
 * - `authorship_refused` — PO decision 3B: the actor may write on this animal
 *                        but not correct THIS record — an owner correcting a
 *                        record a professional wrote or corrected, or one
 *                        another person wrote. A fact about who is asking AND
 *                        whose record it is; `error` names which. See
 *                        `amendAuthorshipRefusal` in lib/infra/amendment.ts.
 * - `write_failed`     — the transaction itself failed. The only one that is a
 *                        server incident, the only one worth reporting, and the
 *                        only one a client should retry.
 * - `not_permitted`    — the WEB SHIM's own access gate refused
 *                        (`requireAlivePetAccess`). It is here because
 *                        `amendEventAction` declares this result type, not
 *                        because the use-case can produce it: `/api/v1` resolves
 *                        access itself, before the call, and never reaches this
 *                        arm. A consumer that maps it anyway should answer what
 *                        it answers for an unresolvable pet.
 */
export type AmendEventFailureCode =
  | "target_not_found"
  | "not_amendable"
  | "changes_required"
  | "unknown_field"
  | "reason_required"
  | "authorship_refused"
  | "write_failed"
  | "not_permitted";

export type AmendEventResult =
  | {
      ok: true;
      amendmentEventId: string;
      /**
       * True when the idempotency key resolved to a correction that ALREADY
       * existed, so nothing was appended and no side effect ran.
       *
       * Reported rather than swallowed: a replay and a first write are different
       * facts, and a caller that cannot tell them apart re-fires whatever it
       * does on success. The web ignores it (its form only branches on `ok`);
       * `/api/v1` puts it on the wire, which is where a retrying phone needs it.
       */
      wasDuplicate: boolean;
    }
  | {
      ok: false;
      /** The machine-readable half. See `AmendEventFailureCode`. */
      code: AmendEventFailureCode;
      /** The es-AR sentence the web form renders. Never put on a wire. */
      error: string;
    };

// ---------------------------------------------------------------------------
// Query helper type
// ---------------------------------------------------------------------------

export type AmendmentSummary = {
  targetEventId: string;
  amendmentId: string;
  occurredAt: Date;
  reason: string | null;
  actorRole: string;
  changes: Array<{ field: string; old: unknown; new: unknown }>;
};
