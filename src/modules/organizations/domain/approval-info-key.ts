// The dedupe key of an "información pedida" notification is the ONLY place that
// records which approval request a reviewer's ask belongs to on a row the
// applicant owns.
//
// It has to be a shared pair rather than a template on one side and a
// `split(":")[1]` on the other. requestInfoForAuthority (the producer) lives in
// the application layer and /cuenta/solicitudes (the consumer) is a page; a
// format agreed between two files that never reference each other is a format
// that drifts, and when this one drifts the failure is silent — the applicant
// simply stops being shown that anything was asked of them, which is the exact
// bug this key was introduced to fix.
//
// Why the applicant's notification and not audit_log: the audit policy exposes
// rows to actor_user_id or admins, and the applicant is the TARGET of the ask,
// not its actor. Reading audit_log on a citizen route would work only because
// the server connection bypasses RLS.

const PREFIX = "approval-info";

/**
 * `approval-info:{requestId}:{messageHash}` — the hash keeps the key stable
 * across retries of the SAME message while letting two distinct asks on one
 * request coexist as separate notifications.
 */
export function approvalInfoDedupeKey(requestId: string, messageHash: string): string {
  return `${PREFIX}:${requestId}:${messageHash}`;
}

/**
 * Returns null for anything this module did not mint — other notification types
 * share the column, and a malformed key must read as "no ask" rather than as an
 * ask against some other request's id.
 */
export function approvalRequestIdFromDedupeKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const parts = key.split(":");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  return parts[1].length > 0 ? parts[1] : null;
}

/**
 * The notification body wraps the reviewer's message in a sentence, because a
 * notification has to stand alone in an inbox. A screen that already says
 * "Información pedida el 20/08" and then renders the body verbatim stacks two
 * lead-ins and two colons on the one surface whose job is to be unambiguous, so
 * the wrapper is a shared pair too: composed here, stripped here.
 */
const BODY_PREFIX = "Necesitamos más información para avanzar con tu solicitud: ";

export function approvalInfoBody(message: string): string {
  return `${BODY_PREFIX}${message}`;
}

/**
 * Falls back to the body as-is rather than to null: an older row written before
 * this wrapper existed, or one whose copy changed, must still show the applicant
 * something. Losing the message is the failure this whole path exists to end.
 */
export function messageFromApprovalInfoBody(body: string | null | undefined): string | null {
  if (!body) return null;
  return body.startsWith(BODY_PREFIX) ? body.slice(BODY_PREFIX.length) : body;
}
