// Use-case: `acceptLegalTermsForUser` — an EXISTING account accepts the current
// legal version (2026-10-07).
//
// WHY IT EXISTS
// ---------------------------------------------------------------------------
// Legal review 2026-10-02 (rows P10, P11 and D5; PO decision D2 = b, a
// conservative interim that counsel may loosen):
//   · a substantive change of the Terms needs a NEW acceptance, not an email
//     (Disp. 377/2026 inc. b), and
//   · the international transfer must be consented in its own, prominent box
//     (Dec. 1558/2001 art. 5 inc. 1) — which accounts created before this
//     version never ticked.
// A personal account whose recorded `tos_version` is not the current one is
// sent to a screen with the same three boxes signup has (Terms and Privacy;
// transfer to Brasil and Estados Unidos; 18 or older), and this is what that
// screen's submit does. Who is sent there: `isLegalAcceptancePending`.
//
// WHAT IT WRITES
// ---------------------------------------------------------------------------
// `profiles.tos_accepted_at = now()` and `profiles.tos_version = LEGAL_VERSION`,
// in ONE UPDATE, plus ONE `audit_log` row in the same transaction carrying the
// previous pair. The profile holds the latest acceptance; the audit row is the
// history, so replacing the original instant loses nothing — it is in `before`.
// No migration: the two consent columns (0087) already say "which version,
// when", and from 2026-10-07 a version means the three separate boxes were
// ticked (see packages/contract/src/reference/legal-version.ts).
//
// ONLY THE SERVER'S CURRENT VERSION IS RECORDED. The caller says which version
// it displayed and anything else is refused (`VERSION_MISMATCH`): recording an
// older one would leave the person on the gate forever, and recording the
// current one for a client that showed an older sentence would be a consent
// to a text they never saw.
//
// IDEMPOTENT. An account already on the current version gets its user back
// with no write and no audit row: a lost response retried must not claim a
// second acceptance.
//
// THE CALLER'S ID MUST COME FROM A GUARD, never from a request body — same
// rule as `completeIdentityForUser`.

import { eq } from "drizzle-orm";

import { db, profiles } from "@/db";
import { toMeV1User } from "@/lib/domain/identity-completeness";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { LEGAL_VERSION } from "@/lib/reference/legal-version";
import type { MeV1User } from "@dim/contract/api";

export type AcceptLegalTermsInput = {
  /** From the auth guard. NEVER from a request body. */
  userId: string;
  /** The caller's address, for the identity-pending projection. */
  email: string | null | undefined;
  tosAccepted: boolean;
  transferAccepted: boolean;
  adultDeclared: boolean;
  /** The legal version the client DISPLAYED. Must equal `LEGAL_VERSION`. */
  legalVersion: string;
};

export type AcceptLegalTermsResult =
  | { ok: true; user: MeV1User; recorded: boolean }
  | { ok: false; error: "NOT_ACCEPTED" | "VERSION_MISMATCH" | "WRITE_FAILED" };

export async function acceptLegalTermsForUser(
  input: AcceptLegalTermsInput,
): Promise<AcceptLegalTermsResult> {
  // Three boxes, each required, none defaulted. The adapters parse with the
  // contract's schema first; this is the use-case not trusting its caller.
  if (!input.tosAccepted || !input.transferAccepted || !input.adultDeclared) {
    return { ok: false, error: "NOT_ACCEPTED" };
  }
  if (input.legalVersion !== LEGAL_VERSION) {
    return { ok: false, error: "VERSION_MISMATCH" };
  }

  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          displayName: profiles.displayName,
          role: profiles.role,
          accountType: profiles.accountType,
          tosAcceptedAt: profiles.tosAcceptedAt,
          tosVersion: profiles.tosVersion,
        })
        .from(profiles)
        .where(eq(profiles.id, input.userId))
        .limit(1);
      if (current === undefined) return { ok: false, error: "WRITE_FAILED" } as const;

      // Already on the current version: answer, do not write.
      if (current.tosAcceptedAt !== null && current.tosVersion === LEGAL_VERSION) {
        return {
          ok: true,
          recorded: false,
          user: toMeV1User({ id: input.userId, email: input.email, profile: current }),
        } as const;
      }

      const [row] = await tx
        .update(profiles)
        .set({ tosAcceptedAt: new Date(), tosVersion: LEGAL_VERSION, updatedAt: new Date() })
        .where(eq(profiles.id, input.userId))
        .returning({
          displayName: profiles.displayName,
          role: profiles.role,
          accountType: profiles.accountType,
          tosAcceptedAt: profiles.tosAcceptedAt,
          tosVersion: profiles.tosVersion,
        });
      if (row === undefined) return { ok: false, error: "WRITE_FAILED" } as const;

      // `profile_self_updated`, the action every self-write onto `profiles`
      // uses (already in the audit_log CHECK, migration 0184), so no migration.
      // `via` names the act; `before` keeps the acceptance this one replaces.
      await writeAuditLog(tx, {
        action: "profile_self_updated",
        actorUserId: input.userId,
        targetUserId: input.userId,
        payload: {
          changed_fields: ["tosAcceptedAt", "tosVersion"],
          via: "legal_reacceptance",
          boxes: ["terms_privacy", "international_transfer", "adult_declaration"],
        },
        before: {
          tosAcceptedAt: current.tosAcceptedAt?.toISOString() ?? null,
          tosVersion: current.tosVersion,
        },
        after: {
          tosAcceptedAt: row.tosAcceptedAt?.toISOString() ?? null,
          tosVersion: row.tosVersion,
        },
      });

      return {
        ok: true,
        recorded: true,
        user: toMeV1User({ id: input.userId, email: input.email, profile: row }),
      } as const;
    });
  } catch {
    // A failed audit row rolls the acceptance back, which is the intended
    // direction: an acceptance with no record of what it replaced is the
    // state this transaction exists to prevent.
    return { ok: false, error: "WRITE_FAILED" };
  }
}
