// Use-case: `completeIdentityForUser` — signup step 2, with no transport in it.
//
// WHY IT WAS EXTRACTED (PO decision, 2026-09-05)
// ---------------------------------------------------------------------------
// `completeIdentityAction` (./complete-identity.ts) is a Next SERVER ACTION: it
// takes `FormData`, reads the caller from a cookie-backed Supabase client, and
// answers `IdentityFormState` — three couplings to a browser request, and the
// reason `apps/mobile/app/identidad-pendiente.tsx` could say for months that
// "there is no `/api/v1` door for step 2" and be right. A native screen for a
// use-case with no endpoint is a form that cannot submit.
//
// The identity step now happens IN THE APP, so the core had to stop being a
// server action. What is left there is the adapter — FormData in, the DNI's own
// validation and its own error copy, `IdentityFormState` out — and what is here
// is the act: validate two names, write them, report who the caller now is.
//
// WHAT IT WRITES, AND WHY EACH COLUMN IS ON THE SAME UPDATE
// ---------------------------------------------------------------------------
//   display_name     — the whole point. `${firstName} ${lastName}`, joined by
//                      `identityDisplayName` in the contract so the web form and
//                      the phone cannot join it two different ways.
//   dni_hash/_last4  — ONLY when the caller passes a DNI, which today is only the
//                      web action. Never plaintext (`lib/utils/dni-hash.ts`), and
//                      `dni_verified` stays false: verification is its own flow.
//   tos_accepted_at  — provable consent (Ley 25.326 art. 5). Both surfaces
//     / tos_version    require the checkbox in step 1 and neither can reach step
//                      2 without it, so arriving here means consent was given.
//                      BOTH are conditional on `tos_accepted_at IS NULL` — the
//                      timestamp through COALESCE, the version through a CASE —
//                      so a retry preserves the original pair. Until the
//                      2026-09-05 security review only the timestamp was, and a
//                      second call after a LEGAL_VERSION bump therefore recorded
//                      (original instant, NEW version): a row asserting that
//                      somebody accepted a document that did not yet exist.
//
// One statement, because they are one act. Splitting the DNI out would mean a
// second UPDATE on the same row from the same request, and a window in which the
// name is stored and the DNI is not.
//
// `.returning()` AND NOT A SECOND SELECT. The caller needs the fresh `MeV1User`
// — that is the whole reason the native screen can redirect without a second
// login — and Postgres hands back the updated row for free. A follow-up read
// would be a second round trip AND a second answer: between the write and the
// read, `updateProfileForUser` or an admin could move the same columns, and the
// user this function reported would not be the one it wrote.
//
// THERE IS AN AUDIT ROW, AND IT WAS ADDED BECAUSE OF WHERE THE NAME IS READ
// ---------------------------------------------------------------------------
// The first cut of this function had none, on the argument that
// `scripts/check-audit-log-coverage.ts` scopes its rule to OPERATOR authority
// and this is a citizen writing their own name on their own row. The fence's
// scope was the right reading and the conclusion was wrong, because
// `profiles.display_name` is not only this person's label:
// `lib/infra/audit-history-query.ts` resolves the ACTOR NAMES shown in
// `/gob/historial` from this column at READ time. A rename therefore relabels
// every historical row that person appears in — retroactively, silently, and
// through a door that (unlike the web's step 2) a bearer token can address
// directly. The `profile_self_updated` row written below is the only thing that
// says the relabelling happened and what the previous label was.
//
// `profile_self_updated` is already in the `audit_log` CHECK (migration 0184),
// which is the same action the sibling writer onto this column uses. No
// migration, one transaction, and a failed audit row rolls the rename back.
//
// THE CALLER'S ID IS A PARAMETER AND IT MUST COME FROM A GUARD. Same rule as
// `updateProfileForUser`, and the same reason `app/actions/profile.ts` refuses to
// export a bare writer: a `userId` taken from a request body would let any client
// rename any account by UUID. Both callers pass an id resolved by
// `requireLiveUser` or by `supabase.auth.getUser()`, never one off the wire.

import { eq, sql } from "drizzle-orm";

import { db, profiles } from "@/db";
import { isIdentityPending, toMeV1User } from "@/lib/domain/identity-completeness";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { LEGAL_VERSION } from "@/lib/reference/legal-version";
import { dniLast4, hashDni } from "@/lib/utils/dni-hash";
import type { MeV1User } from "@dim/contract/api";
import {
  type CompleteIdentityInputCode,
  type IdentityNameField,
  completeIdentityInputSchema,
  firstCompleteIdentityIssue,
  identityDisplayName,
} from "@dim/contract/input";

export type CompleteIdentityForUserInput = {
  /** From the auth guard. NEVER from a request body — see the header. */
  userId: string;
  /** The caller's address, for the still-provisional check. */
  email: string | null | undefined;
  firstName: string;
  lastName: string;
  /**
   * Digits only, already format-checked by the caller. Optional because only the
   * web step collects one; the native step deliberately does not (PO 2026-09-05).
   */
  dni?: string | null;
};

export type CompleteIdentityForUserResult =
  | { ok: true; user: MeV1User }
  /**
   * The schema refused. `field` names the box to put the red border on and
   * `code` is the contract's own refusal, so an adapter can pick a sentence
   * instead of assuming which rule fired — the web action used to answer "es
   * demasiado largo" to every one of them, including `NAME_INVALID`.
   */
  | { ok: false; error: "VALIDATION"; field: IdentityNameField; code: CompleteIdentityInputCode }
  /** The names join into something `isIdentityPending` would still refuse. */
  | { ok: false; error: "STILL_PROVISIONAL" }
  /** No `profiles` row matched, or the driver refused. */
  | { ok: false; error: "WRITE_FAILED" };

export async function completeIdentityForUser(
  input: CompleteIdentityForUserInput,
): Promise<CompleteIdentityForUserResult> {
  // THE CONTRACT'S OWN SCHEMA, not a hand-written pair of `if (!x)` checks. It
  // trims, it bounds each half against the column the two halves share, and it is
  // the SAME parse the native screen runs locally before spending a request — so
  // a name this refuses is a name the phone already refused, and the two can only
  // disagree if one of them stops importing the contract.
  const parsed = completeIdentityInputSchema.safeParse({
    firstName: input.firstName,
    lastName: input.lastName,
  });
  if (!parsed.success) {
    // ONE RESOLVER, IN THE CONTRACT. The first refusal and the box it belongs to
    // used to be reconstructed here from the issue path and in the app from the
    // draft's own lengths — two answers to one question, and the shared
    // `NAME_INVALID` code is what made them disagree.
    const issue = firstCompleteIdentityIssue(parsed.error);
    return {
      ok: false,
      error: "VALIDATION",
      field: issue?.field ?? "firstName",
      // A parse that failed for something outside the declared vocabulary is a
      // CONTRACT violation, not a user error. `FIRST_NAME_REQUIRED` is the least
      // wrong thing to say about a body this schema could not read at all.
      code: issue?.code ?? "FIRST_NAME_REQUIRED",
    };
  }

  const displayName = identityDisplayName(parsed.data.firstName, parsed.data.lastName);

  // THE CHECK THAT CANNOT LIVE IN THE SCHEMA, because it needs the caller's
  // ADDRESS and a wire schema has none. Writing a name that still satisfies
  // `isIdentityPending` would answer 200 to a request whose only purpose was to
  // make that predicate false, and the client would flip its stored user to
  // `profilePending: false` while `/me` kept saying the opposite — a gate that
  // bounces on the next cold start, for a person who did nothing wrong.
  //
  // It runs against the value that is about to be STORED, not against the raw
  // input: `"  perez  "` and `"perez"` are the same stored name.
  if (isIdentityPending({ displayName, email: input.email })) {
    return { ok: false, error: "STILL_PROVISIONAL" };
  }

  let updated:
    | {
        displayName: string;
        role: "owner" | "vet" | "govt" | "admin" | "national";
        accountType: "personal" | "institutional";
      }
    | undefined;
  try {
    updated = await db.transaction(async (tx) => {
      // THE PRIOR NAME, READ INSIDE THE TRANSACTION. Not to decide anything —
      // the doors do that — but because an audit row without a `before` cannot
      // answer the question it exists for: WHAT was this account called before.
      // `lib/infra/audit-history-query.ts` resolves operator labels from
      // `profiles.display_name` at READ time, so a rename relabels every past
      // `/gob/historial` row that person appears in; this row is the only record
      // that the relabelling happened and what it replaced.
      const [current] = await tx
        .select({ displayName: profiles.displayName })
        .from(profiles)
        .where(eq(profiles.id, input.userId))
        .limit(1);
      if (current === undefined) return undefined;

      const [row] = await tx
        .update(profiles)
        .set({
          displayName,
          ...(input.dni ? { dniHash: hashDni(input.dni), dniLast4: dniLast4(input.dni) } : {}),
          // THE TWO CONSENT COLUMNS MOVE TOGETHER OR NEITHER MOVES, and until
          // the 2026-09-05 security review only the timestamp was conditional.
          // `tosAcceptedAt` has always been COALESCE'd so a retry preserves the
          // ORIGINAL instant (Ley 25.326 art. 5); `tosVersion` was stamped
          // unconditionally, so a second call after a `LEGAL_VERSION` bump wrote
          // the pair (original instant, NEW version) — a record asserting that
          // somebody accepted a document that did not exist when they accepted.
          // The CASE puts the version under the timestamp's own condition, so
          // the row either records a first acceptance in full or is left alone.
          //
          // What it deliberately does NOT do is re-consent on a version bump.
          // Re-acceptance is a product decision with its own screen, not a side
          // effect of somebody correcting their surname.
          tosAcceptedAt: sql`COALESCE(${profiles.tosAcceptedAt}, now())`,
          tosVersion: sql`CASE WHEN ${profiles.tosAcceptedAt} IS NULL THEN ${LEGAL_VERSION} ELSE ${profiles.tosVersion} END`,
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, input.userId))
        .returning({
          displayName: profiles.displayName,
          role: profiles.role,
          accountType: profiles.accountType,
        });
      if (row === undefined) return undefined;

      // ONE TRANSACTION, exactly like the sibling writer onto this column
      // (`src/modules/pets/application/profile/update-profile.ts`). This route is
      // the SECOND door onto `profiles.display_name` and it was the only one
      // with no trail: a rename through it was indistinguishable from the name
      // always having been that, in a system whose audit history renders
      // operator labels from this very column.
      //
      // `changed_fields` is computed rather than assumed: an idempotent retry
      // that stores the same name says so, instead of claiming a change.
      const changedFields = current.displayName === displayName ? [] : ["displayName"];
      await writeAuditLog(tx, {
        action: "profile_self_updated",
        actorUserId: input.userId,
        targetUserId: input.userId,
        payload: { changed_fields: changedFields, via: "identity_completion" },
        before: { displayName: current.displayName },
        after: { displayName },
      });

      return row;
    });
  } catch {
    // ONE FAILURE ARM FOR EVERY CAUSE, and on the web path that is a SECURITY
    // property rather than laziness — see `completeIdentityAction`'s own note.
    // A distinct "ese DNI ya está registrado" would confirm to an authenticated
    // attacker which DNIs exist, turning `profiles_dni_hash_unique` (migration
    // 0106) into an oracle. The duplicate is still prevented: the index rejects
    // the write, which is what brought us here.
    //
    // A FAILED AUDIT ROW NOW ROLLS THE RENAME BACK, and that is the intended
    // direction: `writeAuditLog` does not swallow its errors, and a display name
    // changed with no record of the change is the exact state this transaction
    // exists to make impossible.
    return { ok: false, error: "WRITE_FAILED" };
  }

  // NO ROW MATCHED. Unreachable through either door as they stand — both resolve
  // the caller from a live session and `handle_new_user` guarantees the row — but
  // a service-role delete between the guard's read and this write produces it,
  // and an `undefined` flowing into `toMeV1User` would be a 500 with no sentence.
  if (updated === undefined) return { ok: false, error: "WRITE_FAILED" };

  // The SHARED projection, not a hand-built union. `toMeV1User` is what makes
  // "one type, one answer" a fact across `/me`, `/auth/login` and now this write;
  // the last time two handlers each built it by hand they disagreed about the
  // same account in the same second.
  return {
    ok: true,
    user: toMeV1User({
      id: input.userId,
      email: input.email,
      profile: {
        displayName: updated.displayName,
        role: updated.role,
        accountType: updated.accountType,
      },
    }),
  };
}
