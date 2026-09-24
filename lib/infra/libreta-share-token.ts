// Validates the state of a libreta-sanitaria share token before any
// downstream fetch is allowed. Pure function — no DB calls — so the public
// page (app/libreta/compartir/[shareToken]/page.tsx) and the view-logger
// server action share the same precedence rules.
//
// Precedence: revoked > expired > valid. Revocation must always win over
// expiry so that a deliberate "stop sharing" action by the owner is never
// silenced by an older expiry timestamp.

import type { LibretaShareToken } from "@/db";

export type ShareTokenStatus = "valid" | "expired" | "revoked" | "not_found";

type ShareTokenLike = Pick<LibretaShareToken, "expiresAt" | "revokedAt"> | null | undefined;

export function validateShareToken(
  token: ShareTokenLike,
  now: Date = new Date(),
): ShareTokenStatus {
  if (!token) return "not_found";
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && token.expiresAt < now) return "expired";
  return "valid";
}
