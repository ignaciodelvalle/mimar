// Reporter-access capability for a welfare denuncia — "sin cuenta ≠ sin
// autenticación".
//
// WHY THIS EXISTS. `/denuncias/codigo/[code]` used to be the whole story: the
// DEN-XXXX-XXXX reference code was simultaneously the identifier AND the
// credential, and it rendered the denunciante's free text, the description of
// the accused, the locality, a coarse map point and signed URLs to the evidence
// to ANY holder of the code. The mitigations in place protected the wrong
// subject: redacting the pet's name and the operators' names lowers
// re-identification of the animal and the staff, while the fields that identify
// the ACCUSED — an unverified allegation of a crime that carries prison under
// Ley 14.346 art. 1 — were exactly the ones on screen. A shareable string is
// not an identity, and "anyone with the link" is not an audience a criminal
// allegation may be published to.
//
// The function that page served is real and had to survive: a person can report
// cruelty and follow their case WITHOUT creating an account. So the capability
// moved off the code and onto this token, with three properties the code never
// had:
//
//   1. It binds to a SUBJECT, not to a case. The token authorises "the
//      reporter's own view of report X" — never the expediente. See
//      lib/domain/denuncia-reporter-view.ts for the field boundary it unlocks.
//   2. It is a SECOND FACTOR. An `access_link` token is only ever minted into
//      an email the reporter already left on the record; holding the reference
//      code is not enough, and the code page no longer displays the contact so
//      it cannot be read off the screen either.
//   3. It EXPIRES, and fast. 30 minutes for the emailed link, 60 for the
//      session it redeems into. A leaked URL stops being a capability while the
//      leak is still fresh.
//
// PURPOSE SEPARATION is load-bearing. The MAC covers the purpose string, so an
// `access_link` token (which travels through an inbox, a mail relay, and a URL
// bar) cannot be replayed as a `session` cookie, and a stolen session cookie
// cannot be turned back into a shareable link. Dropping `purpose` from the
// payload would silently collapse the two.
//
// Token format:  base64url(hex(hmac)) + "." + timestamp(ms)   — mirrors
// apply-intent.ts / microchip-force-token.ts / tattoo-ack-token.ts so there is
// one shape to audit in this repo, not four.
//
// Signing key: DENUNCIA_REPORTER_SECRET → SUPABASE_SERVICE_ROLE_KEY → dev
// fallback, failing closed in production. Same resolution order as its three
// siblings. Rotating the secret invalidates outstanding links and sessions,
// which is the desired blast radius: it is a global revoke.
//
// NOT PERSISTED. There is no token table, therefore no per-token revocation
// list. Revocation is expressed three other ways, and the seguimiento page
// enforces all three on every render: the TTL above, the live status re-read
// (see reporterAccessRevoked), and the secret rotation.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Emailed magic link — the second factor. Short by design. */
export const REPORTER_ACCESS_LINK_TTL_MS = 30 * 60 * 1000;

/** Session redeemed from a link, or minted directly at submission time. */
export const REPORTER_SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * httpOnly cookie holding the redeemed session. Value shape:
 * `${reportId}.${token}` — the uuid carries no dots, so the last dot in the
 * token is still an unambiguous separator for the timestamp.
 */
export const REPORTER_SESSION_COOKIE_NAME = "denuncia_reporter_session";

export type ReporterTokenPurpose = "access_link" | "session";

function ttlFor(purpose: ReporterTokenPurpose): number {
  return purpose === "access_link" ? REPORTER_ACCESS_LINK_TTL_MS : REPORTER_SESSION_TTL_MS;
}

function getSigningKey(): string {
  if (process.env.DENUNCIA_REPORTER_SECRET) return process.env.DENUNCIA_REPORTER_SECRET;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DENUNCIA_REPORTER_SECRET (or SUPABASE_SERVICE_ROLE_KEY) must be set in production.",
    );
  }
  return "dim-dev-fallback-key-not-for-production";
}

function payload(purpose: ReporterTokenPurpose, reportId: string, ts: string): string {
  return `denuncia_reporter:${purpose}:${reportId}:${ts}`;
}

/** Mint a capability for `reportId` under `purpose`. */
export function generateReporterToken(
  purpose: ReporterTokenPurpose,
  reportId: string,
  atMs: number = Date.now(),
): string {
  const ts = atMs.toString();
  const mac = createHmac("sha256", getSigningKey())
    .update(payload(purpose, reportId, ts))
    .digest("hex");
  return `${Buffer.from(mac, "hex").toString("base64url")}.${ts}`;
}

/**
 * True when `token` is a live capability for exactly `purpose` + `reportId`.
 *
 * Fails closed on every malformed input. Comparison is timing-safe, and the
 * length check before it is required: timingSafeEqual throws on unequal
 * lengths, which would surface as a 500 instead of a denial.
 */
export function validateReporterToken(
  purpose: ReporterTokenPurpose,
  reportId: string,
  token: string,
): boolean {
  try {
    if (!reportId || !token) return false;
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return false;
    const macPart = token.slice(0, dotIdx);
    const tsPart = token.slice(dotIdx + 1);
    const ts = Number.parseInt(tsPart, 10);
    if (Number.isNaN(ts)) return false;
    // Reject future-dated timestamps too: a clock-skewed or hand-crafted `ts`
    // must not be able to buy a longer window than the TTL grants.
    const age = Date.now() - ts;
    if (age < 0 || age > ttlFor(purpose)) return false;

    const expectedMac = createHmac("sha256", getSigningKey())
      .update(payload(purpose, reportId, tsPart))
      .digest("hex");
    const expectedBuf = Buffer.from(expectedMac, "hex");
    const actualBuf = Buffer.from(macPart, "base64url");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

/** Serialize a session for the cookie jar. */
export function encodeReporterSessionCookie(reportId: string, token: string): string {
  return `${reportId}.${token}`;
}

/**
 * Parse a session cookie AND verify it in one step, so no call site can read
 * the reportId out of the cookie without having checked the MAC over it. The
 * reportId is used to fetch a cruelty complaint; an unverified read of it would
 * be an unauthenticated object reference.
 */
export function readReporterSessionCookie(
  raw: string | undefined | null,
): { reportId: string } | null {
  if (!raw) return null;
  const firstDot = raw.indexOf(".");
  if (firstDot <= 0) return null;
  const reportId = raw.slice(0, firstDot);
  const token = raw.slice(firstDot + 1);
  if (!validateReporterToken("session", reportId, token)) return null;
  return { reportId };
}

/**
 * The cookie descriptor, in ONE place.
 *
 * It was briefly written out at all three call sites — the submit action, the
 * link-redemption route and the "Salir" action — which is a bug with a fuse on
 * it: a cookie deleted under a different `path` than it was written under
 * silently deletes nothing, and "Salir" would have become a button that lies.
 * Pass `null` to mint the deletion form.
 *
 * `sameSite: "lax"` is required, not incidental: the reporter arrives by
 * clicking a link in their mail client, which is a cross-site top-level
 * navigation. `strict` would drop the cookie on exactly the hop that matters.
 * The `path` scope keeps it off every other route in the product.
 */
export function reporterSessionCookie(reportId: string | null): {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    name: REPORTER_SESSION_COOKIE_NAME,
    value: reportId
      ? encodeReporterSessionCookie(reportId, generateReporterToken("session", reportId))
      : "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/denuncias",
    maxAge: reportId ? Math.floor(REPORTER_SESSION_TTL_MS / 1000) : 0,
  };
}

/**
 * Hand a just-submitted anonymous reporter a session, in place.
 *
 * WHY THIS IS AUTHENTICATION AND NOT A LOOPHOLE. Since
 * `legal/denuncias-despublicadas` the reference code identifies a denuncia but
 * no longer opens it, so /denuncias/seguimiento needs a second factor. The
 * person completing the submit request has already satisfied one, in the
 * strongest form available: they are the one submitting. Sending them to an
 * inbox to read back what they typed thirty seconds ago would add friction with
 * no security gain — and it would leave the reporter who denounced ANONYMOUSLY
 * (no email, no phone, no channel that exists) with no window onto their own
 * denuncia at all. This is that window: one hour, httpOnly, and the only one
 * such a reporter will ever get.
 *
 * Never throws. A submitted denuncia must not fail over a cookie; the reporter
 * still holds the code and can request an emailed link later.
 */
export async function mintFreshReporterSession(reportId: string): Promise<void> {
  try {
    const { cookies } = await import("next/headers");
    (await cookies()).set(reporterSessionCookie(reportId));
  } catch (err) {
    console.error("[denuncias] could not set reporter session cookie (non-fatal):", err);
  }
}

/**
 * Grace period after a denuncia closes during which the reporter can still
 * reach their view.
 *
 * DELIBERATE DEVIATION from the "revoked when the case closes" instruction,
 * flagged rather than smuggled. A literal revoke-on-close denies the reporter
 * the single fact they are most entitled to — that the state finished with the
 * report they made, and when. So the capability survives the close by 30 days
 * (long enough that a reporter who checks monthly still learns the outcome) and
 * then stops. The reporter never gains anything by waiting: what they see after
 * the close is the same coarse "Cerrada" + date the timeline always showed, no
 * resolution grounds. See lib/domain/denuncia-reporter-view.ts.
 */
export const REPORTER_ACCESS_POST_CLOSE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Live-state half of revocation, re-evaluated on EVERY render rather than
 * baked into the token. A capability minted before the close must not outlive
 * the grace period just because it was minted early.
 */
export function reporterAccessRevoked(
  closedAt: Date | string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!closedAt) return false;
  const closedMs = new Date(closedAt).getTime();
  if (Number.isNaN(closedMs)) return false;
  return now - closedMs > REPORTER_ACCESS_POST_CLOSE_GRACE_MS;
}
