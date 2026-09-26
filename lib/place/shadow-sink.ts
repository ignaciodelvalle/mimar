// The shadow sink — localidades-por-id D1.
//
// A consumer in 'shadow' mode serves the name path and hands every
// disagreement with the id path here. One row per (consumer, subject, kind):
// a repeat bumps last_seen_at and seen_count instead of piling up rows, and
// rows unseen for 30 days are pruned on write (design: 30-day retention).
//
// Never throws. Shadow mode must not be able to break the request it
// observes; a failed write is logged and dropped. Record on the pool (the
// default executor), not inside the caller's transaction: a failed statement
// would abort that transaction even though the error is swallowed here.

import { sql } from "drizzle-orm";

import { db, placeShadowDisagreements } from "@/db";
import type { PlaceReadConsumer } from "@/lib/place/flags";
import type { ShadowKind } from "@/lib/place/shadow";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type ShadowDisagreement = {
  consumer: PlaceReadConsumer;
  kind: ShadowKind;
  /** The table (or kind of subject) compared, e.g. `pets`, `routing:bite`. */
  subjectTable: string;
  /** Which subject: a row id, or a place key for routing and rules. */
  subjectKey: string;
  nameResult: unknown;
  idResult: unknown;
};

export const SHADOW_RETENTION_DAYS = 30;

export async function recordShadowDisagreement(
  input: ShadowDisagreement,
  exec: Executor = db,
): Promise<void> {
  try {
    await exec
      .insert(placeShadowDisagreements)
      .values({
        consumer: input.consumer,
        kind: input.kind,
        subjectTable: input.subjectTable.slice(0, 64),
        subjectKey: input.subjectKey.slice(0, 200),
        nameResult: input.nameResult ?? [],
        idResult: input.idResult ?? [],
      })
      .onConflictDoUpdate({
        target: [
          placeShadowDisagreements.consumer,
          placeShadowDisagreements.subjectTable,
          placeShadowDisagreements.subjectKey,
          placeShadowDisagreements.kind,
        ],
        set: {
          nameResult: sql`excluded.name_result`,
          idResult: sql`excluded.id_result`,
          lastSeenAt: sql`now()`,
          seenCount: sql`${placeShadowDisagreements.seenCount} + 1`,
        },
      });
    await exec.execute(sql`
      delete from public.place_shadow_disagreements
       where last_seen_at < now() - make_interval(days => ${SHADOW_RETENTION_DAYS})
    `);
  } catch (error) {
    console.error("[place-shadow] could not record a disagreement", error);
  }
}
