// Fence: custody history and the event spine cannot be emptied or cascaded
// away (custody audit K, W6 + W7, migration 0266).
//
//   - TRUNCATE is refused on every append-only table: no TRUNCATE privilege
//     for anon / authenticated / service_role, and a BEFORE TRUNCATE trigger
//     that stops even the owner (the privilege alone is not durable —
//     scripts/deploy-provision.ts re-grants `all` on every provision).
//   - A hard delete of a profile or an organization that still has custody
//     history is refused (ON DELETE RESTRICT) instead of cascading it away.
//
// Everything runs inside a transaction that is rolled back: the local
// database is shared by every worktree, and a TRUNCATE that slipped through
// must not reach anybody else.

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { organizations, ownerships, petCaretakerGrants, petTransfers } from "@/db";

import { type Tx, inRolledBackTx, rows, seedPet, seedUser } from "./_helpers/erasure-tx";

const APPEND_ONLY_TABLES = [
  "pet_events",
  "case_events",
  "audit_log",
  "place_resolutions",
  "place_repair_preimages",
] as const;

/** The error a savepoint-wrapped statement raised (message chain + code), or null. */
async function errorOf(tx: Tx, statement: ReturnType<typeof sql>): Promise<string | null> {
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(statement);
    });
    return null;
  } catch (e) {
    let cur = e as { message?: string; code?: string; cause?: unknown } | null;
    const parts: string[] = [];
    while (cur) {
      if (cur.code) parts.push(`[${cur.code}]`);
      if (cur.message) parts.push(cur.message);
      cur = (cur.cause as typeof cur) ?? null;
    }
    return parts.join(" | ");
  }
}

describe("W6 — the append-only tables cannot be truncated", () => {
  it.each(APPEND_ONLY_TABLES)("%s: authenticated has no TRUNCATE privilege", async (table) => {
    const verdict = await inRolledBackTx(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL ROLE authenticated`);
      return errorOf(tx, sql.raw(`TRUNCATE public.${table}`));
    });
    expect(verdict).toMatch(/\[42501\]|permission denied/);
  });

  it("no API role holds TRUNCATE on any append-only table", async () => {
    const granted = await inRolledBackTx((tx) =>
      rows(
        tx,
        sql`SELECT r.rolname || '/' || c.relname AS grant
              FROM pg_class c
             CROSS JOIN pg_roles r
             WHERE c.relnamespace = 'public'::regnamespace
               AND c.relname = ANY(${`{${APPEND_ONLY_TABLES.join(",")}}`}::text[])
               AND r.rolname IN ('anon', 'authenticated', 'service_role')
               AND has_table_privilege(r.oid, c.oid, 'TRUNCATE')
             ORDER BY 1`,
      ),
    );
    expect(granted).toEqual([]);
  });

  it.each(APPEND_ONLY_TABLES)("%s: even the owner is stopped by the trigger", async (table) => {
    const verdict = await inRolledBackTx(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      // CASCADE so the foreign keys pointing at the table do not refuse first:
      // the refusal under test is the trigger's.
      return errorOf(tx, sql.raw(`TRUNCATE public.${table} CASCADE`));
    });
    expect(verdict).toMatch(/append-only: TRUNCATE refused/);
  });

  it("every table with a row-level append-only trigger also has a BEFORE TRUNCATE trigger", async () => {
    const found = await inRolledBackTx((tx) =>
      rows(
        tx,
        sql`SELECT DISTINCT tr.tgrelid::regclass::text AS tbl,
                   EXISTS (
                     SELECT 1 FROM pg_trigger t2
                      WHERE t2.tgrelid = tr.tgrelid
                        AND NOT t2.tgisinternal
                        AND (t2.tgtype & 32) <> 0
                        AND (t2.tgtype & 2) <> 0
                   ) AS guarded
              FROM pg_trigger tr
              JOIN pg_proc p ON p.oid = tr.tgfoid
             WHERE NOT tr.tgisinternal
               AND p.proname LIKE 'enforce\\_%append\\_only'
             ORDER BY 1`,
      ),
    );
    // Non-vacuous: the five tables this fence names are all discovered.
    expect(found.map((r) => r.tbl)).toEqual(expect.arrayContaining([...APPEND_ONLY_TABLES]));
    expect(found.filter((r) => r.guarded !== true)).toEqual([]);
  });
});

describe("W7 — deleting a person or an organization cannot erase custody history", () => {
  it("every foreign key from a person into custody history is ON DELETE RESTRICT", async () => {
    const fks = await inRolledBackTx((tx) =>
      rows(
        tx,
        sql`SELECT c.conrelid::regclass::text || '.' || a.attname AS col,
                   c.confdeltype AS on_delete,
                   c.convalidated AS validated
              FROM pg_constraint c
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
             WHERE c.contype = 'f'
               AND c.confrelid IN ('public.profiles'::regclass, 'public.organizations'::regclass)
               AND c.conrelid IN ('public.ownerships'::regclass,
                                  'public.pet_transfers'::regclass,
                                  'public.pet_caretaker_grants'::regclass)
             ORDER BY 1`,
      ),
    );
    const byCol = Object.fromEntries(fks.map((r) => [r.col, r]));
    for (const col of [
      "ownerships.owner_user_id",
      "ownerships.owner_organization_id",
      "pet_transfers.from_owner_id",
      "pet_caretaker_grants.granted_by_user_id",
    ]) {
      expect(byCol[col], col).toMatchObject({ on_delete: "r", validated: true });
    }
    // The recipient-side columns keep SET NULL: the row survives the person.
    expect(byCol["pet_transfers.to_owner_id"]).toMatchObject({ on_delete: "n" });
    expect(byCol["pet_caretaker_grants.caretaker_user_id"]).toMatchObject({ on_delete: "n" });
  });

  it("control: a profile with no custody history can still be deleted", async () => {
    const verdict = await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx, "w7-control");
      return errorOf(tx, sql`DELETE FROM public.profiles WHERE id = ${userId}::uuid`);
    });
    expect(verdict).toBeNull();
  });

  it("a profile that holds a pet cannot be hard-deleted", async () => {
    const verdict = await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx, "w7-owner");
      await seedPet(tx, userId);
      return errorOf(tx, sql`DELETE FROM public.profiles WHERE id = ${userId}::uuid`);
    });
    expect(verdict).toMatch(/\[23503\].*ownerships_owner_user_id_restrict_fk/);
  });

  it("a profile whose only custody row is ENDED — pure history — cannot be hard-deleted either", async () => {
    const verdict = await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx, "w7-former");
      await seedPet(tx, userId, { endedAt: new Date(Date.now() - 86_400_000) });
      return errorOf(tx, sql`DELETE FROM public.profiles WHERE id = ${userId}::uuid`);
    });
    expect(verdict).toMatch(/\[23503\].*ownerships_owner_user_id_restrict_fk/);
  });

  it("a profile that sent a transfer, or granted a caretaker invitation, cannot be hard-deleted", async () => {
    const verdicts = await inRolledBackTx(async (tx) => {
      const titular = await seedUser(tx, "w7-titular");
      const petId = await seedPet(tx, titular);
      const sender = await seedUser(tx, "w7-sender");
      const grantor = await seedUser(tx, "w7-grantor");
      await tx.insert(petTransfers).values({
        publicToken: `PTR-w7-${randomUUID().slice(0, 10)}`,
        petId,
        fromOwnerId: sender,
        toOwnerEmail: "w7-recipient@dim-test.local",
        status: "cancelled",
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      });
      await tx.insert(petCaretakerGrants).values({
        publicToken: `CG-w7-${randomUUID().slice(0, 8)}`,
        petId,
        grantedByUserId: grantor,
        caretakerEmail: "w7-caretaker@dim-test.local",
        status: "cancelled",
        endsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      return {
        sender: await errorOf(tx, sql`DELETE FROM public.profiles WHERE id = ${sender}::uuid`),
        grantor: await errorOf(tx, sql`DELETE FROM public.profiles WHERE id = ${grantor}::uuid`),
      };
    });
    expect(verdicts.sender).toMatch(/\[23503\].*pet_transfers_from_owner_id_restrict_fk/);
    expect(verdicts.grantor).toMatch(
      /\[23503\].*pet_caretaker_grants_granted_by_user_id_restrict_fk/,
    );
  });

  it("an organization that held a pet cannot be hard-deleted", async () => {
    const verdict = await inRolledBackTx(async (tx) => {
      const titular = await seedUser(tx, "w7-org-titular");
      const petId = await seedPet(tx, titular);
      const token = `DIM-W7ORG-${randomUUID().slice(0, 6).toUpperCase()}`;
      const [org] = await tx
        .insert(organizations)
        .values({
          publicToken: token,
          legalName: `W7 Refugio ${token}`,
          displayName: `W7 Refugio ${token}`,
          orgType: "shelter",
          email: `${token.toLowerCase()}@dim-test.local`,
        })
        .returning({ id: organizations.id });
      await tx.insert(ownerships).values({
        petId,
        ownerOrganizationId: org.id,
        role: "shelter_custody",
        endedAt: new Date(),
      });
      return errorOf(tx, sql`DELETE FROM public.organizations WHERE id = ${org.id}::uuid`);
    });
    expect(verdict).toMatch(/\[23503\].*ownerships_owner_organization_id_restrict_fk/);
  });
});
