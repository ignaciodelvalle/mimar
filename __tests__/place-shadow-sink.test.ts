// The shadow sink (localidades-por-id D1): one row per (consumer, subject,
// kind), counted, pruned after 30 days unseen. Rolled back (shared DB).

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { recordShadowDisagreement } from "@/lib/place/shadow-sink";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof TransactionRollbackError)) throw e;
    });
}

describe("recordShadowDisagreement", () => {
  it("counts a repeat instead of adding a row, and keeps kinds apart", async () => {
    await inRolledBackTx(async (tx) => {
      const base = {
        consumer: "routing" as const,
        subjectTable: "routing:fence",
        subjectKey: "shadow-sink-fence",
        nameResult: ["a"],
        idResult: ["b"],
      };
      await recordShadowDisagreement({ ...base, kind: "homonym_split" }, tx);
      await recordShadowDisagreement({ ...base, kind: "homonym_split", idResult: ["c"] }, tx);
      await recordShadowDisagreement({ ...base, kind: "other" }, tx);
      const rows = (await tx.execute(sql`
        select kind, seen_count, id_result from public.place_shadow_disagreements
         where subject_key = 'shadow-sink-fence' order by kind
      `)) as unknown as Array<{ kind: string; seen_count: number; id_result: unknown }>;
      expect(rows).toEqual([
        { kind: "homonym_split", seen_count: 2, id_result: ["c"] },
        { kind: "other", seen_count: 1, id_result: ["b"] },
      ]);
    });
  });

  it("prunes rows unseen for more than 30 days", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`
        insert into public.place_shadow_disagreements
          (consumer, kind, subject_table, subject_key, name_result, id_result, first_seen_at, last_seen_at)
        values ('scope', 'other', 'pets', 'shadow-sink-stale', '[]', '[]',
                now() - interval '40 days', now() - interval '31 days')
      `);
      await recordShadowDisagreement(
        {
          consumer: "scope",
          kind: "spelling_join",
          subjectTable: "pets",
          subjectKey: "shadow-sink-fresh",
          nameResult: [],
          idResult: [],
        },
        tx,
      );
      const keys = (await tx.execute(sql`
        select subject_key from public.place_shadow_disagreements
         where subject_key like 'shadow-sink-%' order by subject_key
      `)) as unknown as Array<{ subject_key: string }>;
      expect(keys.map((k) => k.subject_key)).toEqual(["shadow-sink-fresh"]);
    });
  });
});
