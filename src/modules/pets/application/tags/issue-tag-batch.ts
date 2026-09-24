// Use-case: issueTagBatchForAdmin — physical-tag lifecycle (design D9).
//
// Pure writer: admin gate → generate serial + activation code per row → hash
// the code → insert blank (unactivated) rows with unique-violation retry →
// ONE audit row `tag.lote_issue {lote_id, count}`.
//
// NO pet events: a blank tag has no pet yet — the spine learns about the tag
// only at activation.
//
// SECURITY: the plaintext activation codes exist ONLY in this function's
// return value, which the admin surface turns into the issuance CSV. They are
// never persisted (only the peppered HMAC hash reaches the DB), never logged,
// and never SELECTable afterwards.

import { eq } from "drizzle-orm";

import { auditLog, db, petTags, profiles } from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";
import { generateTagActivationCode, generateTagSerial } from "@/lib/infra/publicToken";
import { hashTagActivationCode } from "@/lib/utils/tag-code-hash";

import { issueTagBatchSchema } from "./types";
import type { IssueTagBatchInput, IssueTagBatchResult, IssuedTagRow } from "./types";

// Serial-collision retries per row. 31^8 space makes even one collision rare;
// three misses in a row means something is systemically wrong — abort loudly.
const MAX_SERIAL_RETRIES = 3;

export async function issueTagBatchForAdmin(
  userId: string,
  rawInput: IssueTagBatchInput,
): Promise<IssueTagBatchResult> {
  let parsed: IssueTagBatchInput;
  try {
    parsed = issueTagBatchSchema.parse(rawInput);
  } catch (err) {
    return {
      error: `Invalid input: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const rows = await db.transaction(async (tx) => {
      // Admin gate (replace-microchip admin branch shape).
      const [profile] = await tx
        .select({
          role: profiles.role,
          accountType: profiles.accountType,
          deactivatedAt: profiles.deactivatedAt,
        })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1);
      if (
        !profile ||
        profile.role !== "admin" ||
        profile.accountType !== "institutional" ||
        profile.deactivatedAt !== null
      ) {
        throw new Error("Caller does not have active admin role.");
      }

      const issued: IssuedTagRow[] = [];
      for (let i = 0; i < parsed.count; i++) {
        const activationCode = generateTagActivationCode();
        const activationCodeHash = hashTagActivationCode(activationCode);

        let inserted = false;
        for (let attempt = 0; attempt < MAX_SERIAL_RETRIES && !inserted; attempt++) {
          const serial = generateTagSerial();
          try {
            // Nested transaction = SAVEPOINT: a unique violation must not
            // poison the outer transaction (Postgres aborts a tx after any
            // failed statement unless the failure is savepoint-scoped).
            await tx.transaction(async (sp) => {
              await sp.insert(petTags).values({
                serial,
                activationCodeHash,
                loteId: parsed.loteId,
              });
            });
            issued.push({ serial, activationCode });
            inserted = true;
          } catch (err) {
            // 23505 = unique_violation on pet_tags_serial_unique → regenerate.
            if (pgErrorCode(err) === "23505") continue;
            throw err;
          }
        }
        if (!inserted) {
          throw new Error(
            `Serial collision persisted after ${MAX_SERIAL_RETRIES} retries — aborting batch.`,
          );
        }
      }

      // ONE audit row per batch. Never the codes, never the serials in bulk —
      // lote + count identify the batch; the rows themselves carry the serials.
      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "tag.lote_issue",
        payload: {
          lote_id: parsed.loteId,
          count: issued.length,
        },
      });

      return issued;
    });

    return { ok: true, rows };
  } catch (err) {
    return {
      error: `issueTagBatchForAdmin failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
