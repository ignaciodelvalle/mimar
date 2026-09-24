// A GoTrue-shaped access token for tests that need to age a SESSION.
//
// The 8-hour operator shift (B9) is keyed on `amr[].timestamp` — the
// per-session authentication time — and `lib/infra/operator-shift.ts` documents
// why the two plausible alternatives (`iat`, `user.last_sign_in_at`) are wrong.
// A test that wants to exercise the shift therefore has to hand the guard a
// token carrying that claim; there is no other input.
//
// The shape is not invented: __tests__/operator-shift.test.ts measured it
// against a local GoTrue v2.188.1 (`amr: [{ method: "password", timestamp:
// <unix seconds> }]`) and that file keeps the primary pin on it. This helper
// exists so the guard tests that came later — the institutional API gates —
// borrow the same shape instead of each writing their own base64url encoder,
// which is how two "identical" fixtures start disagreeing about a claim.
//
// Header and signature are inert: `verifiedSessionStart` decodes without
// verifying, by design, and may only be called with a token `auth.getUser()`
// has already had GoTrue validate.

/** A JWT whose payload carries `claims`. Header/signature are inert. */
export function tokenWithClaims(claims: Record<string, unknown>): string {
  const b64url = (value: string) =>
    Buffer.from(value, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
    JSON.stringify(claims),
  )}.not-a-real-signature`;
}

/**
 * A token that says its session authenticated `hoursAgo` hours before `now`.
 *
 * `now` defaults to the real clock so a caller that is not freezing time still
 * gets a meaningful age.
 */
export function amrToken(hoursAgo: number, now: Date = new Date()): string {
  const seconds = Math.floor((now.getTime() - hoursAgo * 60 * 60 * 1000) / 1000);
  return tokenWithClaims({
    sub: "user-001",
    session_id: "session-001",
    amr: [{ method: "password", timestamp: seconds }],
  });
}
