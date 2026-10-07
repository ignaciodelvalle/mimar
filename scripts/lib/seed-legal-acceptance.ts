// Stamps the CURRENT legal acceptance on a SEED account (2026-10-07).
//
// WHY. A personal account whose `profiles.tos_version` is not `LEGAL_VERSION`
// is sent to the re-acceptance screen before it can use the owner portal or the
// app (lib/domain/legal-acceptance.ts) — including accounts with NO acceptance
// recorded at all, which is what an account created through the admin SDK is:
// the signup form never ran. Every seed persona and e2e account is such an
// account, so without this every e2e and demo login would land on
// /aceptar-condiciones instead of the page it is testing.
//
// ONLY THE IDS THE SEED ITSELF ENSURES. This never sweeps the profiles table:
// the same seeds run against staging, where a real person's acceptance must
// only ever come from that person. It records synthetic personas of this repo
// as having accepted the current version, which is what they stand for.
//
// Idempotent: an account already on the current version is left alone, so a
// re-seed does not move its acceptance instant. A version change rewrites the
// instant too — never the pair (old instant, new version).
//
// Takes the caller's `db` because every seed imports `../db` dynamically, after
// its env is loaded; this module must not import it at the top level.

import { LEGAL_VERSION } from "@dim/contract/reference";
import { type SQL, sql } from "drizzle-orm";

type Executor = { execute: (query: SQL) => Promise<unknown> };

export async function stampSeedLegalAcceptance(db: Executor, userId: string): Promise<void> {
  await db.execute(sql`
    UPDATE public.profiles
       SET tos_accepted_at = now(), tos_version = ${LEGAL_VERSION}, updated_at = now()
     WHERE id = ${userId}::uuid
       AND account_type = 'personal'
       AND tos_version IS DISTINCT FROM ${LEGAL_VERSION}
  `);
}
