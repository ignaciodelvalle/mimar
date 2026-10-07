// The digest a denuncia's client key is stored and replayed under (plan A5f,
// migration 0289).
//
// WHY A DIGEST. `welfare_reports.client_key_digest` is what a retry is matched
// against. Storing the key itself would hand anyone who can read the row an
// input that, sent back through the form, answers as the original submitter.
// The digest is one-way: reading it gives nothing to submit.
//
// WHY THE SCOPE IS INSIDE IT. An identified reporter's key is scoped to their
// account (`user:<id>`), and an org member's to the org they file for as well
// (`org:<orgId>:user:<id>`), so another account — or the same member filing
// for another org — reaches a different digest and replays nothing. An
// anonymous submit — including a logged-in person who chose "Enviar anónima" —
// is scoped `anon`: the anonymous flow
// has nothing both stable across a retry and safe to store beside a denuncia
// (the reporter session is minted after the report exists; the rate-limit
// fingerprint is the caller's IP, and an IPv4 hash is a lookup table away from
// the IP). So the anonymous scope is the key alone, and two things carry it:
//   - entropy: the web mints crypto.randomUUID() (122 random bits), and a key
//     shorter than REPORT_KEY_MIN_LENGTH is never stored or replayed at all —
//     a short or guessable key would be a slot anyone could squat on;
//   - an anonymous replay returns nothing about the original (no reference
//     code, no reporter session), so even a stolen key reveals only that a
//     report under it was received.
// Keeping the scope inside the digest (not as an index column) also means a
// reporter_user_id going NULL (account deletion, reporter-side purge) never
// moves a row into another scope or collides with anyone.

import { createHash } from "node:crypto";

/** Below this a client key is ignored for the report-level replay. A UUID is 36. */
export const REPORT_KEY_MIN_LENGTH = 32;

/**
 * The stored digest for (key, reporter[, org]), or null when the key cannot
 * claim a slot (absent or too short) — such a submit files as it always did.
 * The org only scopes an identified reporter; an anonymous submit has none.
 */
export function reportKeyDigest(
  clientIdempotencyKey: string | null,
  reporterUserId: string | null,
  reporterOrganizationId: string | null = null,
): string | null {
  if (!clientIdempotencyKey || clientIdempotencyKey.length < REPORT_KEY_MIN_LENGTH) return null;
  const user = reporterUserId ? `user:${reporterUserId}` : null;
  const scope = !user
    ? "anon"
    : reporterOrganizationId
      ? `org:${reporterOrganizationId}:${user}`
      : user;
  return createHash("sha256")
    .update(`welfare-report-key:v1:${scope}:${clientIdempotencyKey}`)
    .digest("hex");
}
