"use server";

// tags.ts — thin shim for the physical-tag lifecycle writers.
//
// Business logic lives in src/modules/pets/application/tags/. The inner
// writers are deliberately NOT exported from this "use server" file —
// exporting them would make each an independently-addressable server action
// accepting an attacker-supplied userId (authz triage 2026-07-04).
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { headers } from "next/headers";

import { requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { normalizeTagSerial } from "@/lib/infra/tag-lookup";
import { activateTagForUser as _activateTagForUser } from "@/src/modules/pets/application/tags/activate-tag";
import { issueTagBatchForAdmin as _issueTagBatchForAdmin } from "@/src/modules/pets/application/tags/issue-tag-batch";
import { revokeTagForUser as _revokeTagForUser } from "@/src/modules/pets/application/tags/revoke-tag";
import type {
  ActivateTagInput,
  ActivateTagResult,
  IssueTagBatchInput,
  IssueTagBatchResult,
  RevokeTagInput,
  RevokeTagResult,
} from "@/src/modules/pets/application/tags/types";

export type {
  ActivateTagInput,
  ActivateTagResult,
  IssueTagBatchInput,
  IssueTagBatchResult,
  RevokeTagInput,
  RevokeTagResult,
} from "@/src/modules/pets/application/tags/types";

const RATE_LIMITED_MESSAGE = "Demasiados intentos. Esperá unos minutos y volvé a intentar.";

export async function activateTagAction(rawInput: ActivateTagInput): Promise<ActivateTagResult> {
  // The three tag writers gate on active ownership but never consult
  // profiles.deleted_at, so the erasure lockout belongs at this boundary. It
  // used to be a hand-copied pair of lines in each of the three.
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  // Brute-force budget on the evidence gate: per-IP AND per-serial, so a
  // botnet cannot spread serial-guessing across IPs nor hammer one serial.
  try {
    const reqHeaders = await headers();
    const ip = callerIp(reqHeaders);
    await enforceRateLimit("tag_activate_ip", ip, { maxPerMinute: 5, maxPerHour: 20 });
    await enforceRateLimit("tag_activate_serial", normalizeTagSerial(rawInput?.serial ?? ""), {
      maxPerMinute: 3,
      maxPerHour: 10,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return { error: RATE_LIMITED_MESSAGE };
    throw err;
  }

  return _activateTagForUser(user.id, rawInput);
}

export async function revokeTagAction(rawInput: RevokeTagInput): Promise<RevokeTagResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  // Revocation had NO budget at all (abuse-surface audit, S1). It is a
  // destructive, TERMINAL write — a revoked chapa can never be reactivated —
  // and each call takes a FOR UPDATE row lock, appends to the spine and fans
  // out a notification per co-owner, so an unbounded loop is both a data and a
  // load problem even though every call is authenticated.
  //
  // Budgets are looser than activation's on purpose. Activation's numbers
  // (5/min · 20/hour per IP) size a BRUTE-FORCE window: the attacker is
  // guessing a wrapper code. There is nothing to guess here — the caller has
  // already proven an active ownership on the linked pet — so the limit only
  // has to bound a runaway client, not an attacker, and a household or a
  // rescue clearing a batch of chapas after a transfer must not be locked out.
  //
  // The per-SERIAL budget is deliberately kept AT activation's numbers: a given
  // serial can be revoked exactly once, so anything past a couple of retries on
  // the same one is a client that will not succeed on the next attempt either.
  try {
    const reqHeaders = await headers();
    const ip = callerIp(reqHeaders);
    await enforceRateLimit("tag_revoke_ip", ip, { maxPerMinute: 10, maxPerHour: 40 });
    await enforceRateLimit("tag_revoke_serial", normalizeTagSerial(rawInput?.serial ?? ""), {
      maxPerMinute: 3,
      maxPerHour: 10,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return { error: RATE_LIMITED_MESSAGE };
    throw err;
  }

  return _revokeTagForUser(user.id, rawInput);
}

// Admin batch issuance (design D9). The writer re-verifies the admin role
// inside the transaction; this shim only resolves the session. The returned
// rows carry the PLAINTEXT activation codes exactly once, for the issuance
// CSV — they are never persisted or logged.
export async function issueTagBatchAction(
  rawInput: IssueTagBatchInput,
): Promise<IssueTagBatchResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  return _issueTagBatchForAdmin(user.id, rawInput);
}
