// Did THIS session come out of the password-recovery flow, recently? (A04-1)
//
// The recovery form (/recuperar/actualizar → updatePasswordAction) sets a new
// password WITHOUT asking for the current one. That is only sound when the
// session proves control of the mailbox — i.e. it was minted by the recovery
// mail. Before this module the action accepted ANY live session, so a borrowed
// or stolen session could silently take the account over by POSTing here.
//
// THE PROOF IS GoTrue's `amr` CLAIM, measured on local GoTrue v2.188.1:
//
//   recovery link, PKCE (/auth/callback → exchangeCodeForSession) → `recovery`
//   recovery token_hash or six-digit code (verifyOtp type=recovery) → `otp`
//   password sign-in                                                 → `password`
//
// `amr` survives `grant_type=refresh_token` unchanged, so the method alone would
// let a recovery session stay a password-change licence for as long as it is
// refreshed. The WINDOW bounds that: the recovery method must have been used in
// the last 30 minutes — long enough to open the mail and type a password, short
// enough that a session left open on a shared desk stops being one.
//
// A session with no timestamp on the method (RFC-8176 plain strings) does NOT
// pass: here an unknown instant fails CLOSED. The cost is one more recovery mail;
// the alternative is the takeover this module exists to stop.

/** One `amr` entry, as lib/infra/verified-token-claims.ts normalises it. */
export type AuthMethodReference = { method: string; timestamp: number | null };

/** amr methods GoTrue records for a session minted by the recovery mail. */
export const RECOVERY_PROOF_METHODS: ReadonlySet<string> = new Set(["recovery", "otp"]);

/** How long a recovery-minted session may still set a password without the old one. */
export const RECOVERY_PROOF_WINDOW_MS = 30 * 60 * 1000;

export function hasFreshRecoveryProof(
  methods: ReadonlyArray<AuthMethodReference>,
  now: Date = new Date(),
): boolean {
  return methods.some((entry) => {
    if (!RECOVERY_PROOF_METHODS.has(entry.method)) return false;
    if (entry.timestamp === null) return false;
    const age = now.getTime() - entry.timestamp * 1000;
    // A token from the future (clock skew) is not stale; GoTrue bounds it anyway.
    return age <= RECOVERY_PROOF_WINDOW_MS;
  });
}
