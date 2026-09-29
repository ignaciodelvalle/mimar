// VisitsRepository — the Drizzle side of the visits module (migration 0273).
//
// Thin: no auth, no resolution rules (application/ensure-open-visit.ts owns
// those). Every method runs on the caller's transaction, because the open
// decision is only correct under the advisory lock lockVisitKey takes, and
// that lock ends with the transaction.
//
// Every time comparison and every close timestamp comes from the DATABASE
// clock (now(), interval arithmetic in SQL), never from `new Date()` — the
// columns are defaulted from Postgres's now(), and a host clock would drift
// against them.

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { appointments, type db, visits } from "@/db";

import type { InsertVisitArgs, OpenVisit, VisitsRepositoryPort } from "../application/ports";
import type { Visit, VisitCloseReason, VisitKey, VisitModality } from "../domain/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const VISIT_COLUMNS = {
  id: visits.id,
  petId: visits.petId,
  organizationId: visits.organizationId,
  vetUserId: visits.vetUserId,
  modality: visits.modality,
  appointmentId: visits.appointmentId,
  openedAt: visits.openedAt,
  closedAt: visits.closedAt,
  closeReason: visits.closeReason,
};

type VisitSelect = {
  id: string;
  petId: string;
  organizationId: string;
  vetUserId: string | null;
  modality: string;
  appointmentId: string | null;
  openedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
};

function toVisit(row: VisitSelect): Visit {
  return {
    ...row,
    // The CHECK constraints make these the only values the column can hold.
    modality: row.modality as VisitModality,
    closeReason: row.closeReason as VisitCloseReason | null,
  };
}

function lockKeyText(key: VisitKey): string {
  return `visit:${key.petId}:${key.organizationId}:${key.vetUserId}`;
}

// `implements` keeps a renamed method or a changed return shape from compiling
// while the use-case tests still pass against a stale fake.
export class VisitsRepository implements VisitsRepositoryPort {
  async lockVisitKey(key: VisitKey, tx: unknown): Promise<void> {
    await (tx as Tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKeyText(key)}, 0))`,
    );
  }

  async insertVisitIfAbsent(
    args: InsertVisitArgs,
    tx: unknown,
  ): Promise<{ visit: Visit; inserted: boolean }> {
    const client = tx as Tx;
    const values = {
      ...(args.id ? { id: args.id } : {}),
      petId: args.petId,
      organizationId: args.organizationId,
      vetUserId: args.vetUserId,
      modality: args.modality,
      appointmentId: args.appointmentId,
    };
    const inserted = await client
      .insert(visits)
      .values(values)
      .onConflictDoNothing({ target: visits.id })
      .returning(VISIT_COLUMNS);
    if (inserted[0]) return { visit: toVisit(inserted[0]), inserted: true };

    // Only reachable with a caller-supplied id that already exists.
    if (!args.id) throw new Error("VisitsRepository.insertVisitIfAbsent: insert returned no rows");
    const existing = await this.findVisitById(args.id, client);
    if (!existing) {
      throw new Error(
        `VisitsRepository.insertVisitIfAbsent: visit ${args.id} conflicted but is gone`,
      );
    }
    return { visit: existing, inserted: false };
  }

  async findVisitById(id: string, tx: unknown): Promise<Visit | null> {
    const [row] = await (tx as Tx)
      .select(VISIT_COLUMNS)
      .from(visits)
      .where(eq(visits.id, id))
      .limit(1);
    return row ? toVisit(row) : null;
  }

  async findOpenVisits(key: VisitKey, staleHours: number, tx: unknown): Promise<OpenVisit[]> {
    const rows = await (tx as Tx)
      .select({
        ...VISIT_COLUMNS,
        stale: sql<boolean>`${visits.openedAt} < now() - make_interval(hours => ${staleHours}::int)`,
      })
      .from(visits)
      .where(
        and(
          eq(visits.petId, key.petId),
          eq(visits.organizationId, key.organizationId),
          eq(visits.vetUserId, key.vetUserId),
          isNull(visits.closedAt),
        ),
      )
      .orderBy(desc(visits.openedAt), desc(visits.createdAt), desc(visits.id));
    return rows.map(({ stale, ...row }) => ({ ...toVisit(row), stale: stale === true }));
  }

  async expireVisit(id: string, tx: unknown): Promise<void> {
    await (tx as Tx).execute(sql`
      UPDATE public.visits v
         SET closed_at = coalesce(
               (SELECT max(e.recorded_at) FROM public.pet_events e WHERE e.visit_id = v.id),
               v.opened_at),
             close_reason = 'expired'
       WHERE v.id = ${id}::uuid
         AND v.closed_at IS NULL
    `);
  }

  async supersedeVisit(id: string, tx: unknown): Promise<void> {
    await (tx as Tx)
      .update(visits)
      .set({ closedAt: sql`now()`, closeReason: "superseded" })
      .where(and(eq(visits.id, id), isNull(visits.closedAt)));
  }

  async setModalityIfEmpty(id: string, modality: VisitModality, tx: unknown): Promise<boolean> {
    const rows = await (tx as Tx)
      .update(visits)
      .set({ modality })
      .where(
        and(
          eq(visits.id, id),
          sql`NOT EXISTS (SELECT 1 FROM public.pet_events e WHERE e.visit_id = ${visits.id})`,
        ),
      )
      .returning({ id: visits.id });
    return rows.length > 0;
  }

  async findAppointmentModality(
    appointmentId: string,
    key: Pick<VisitKey, "petId" | "organizationId">,
    tx: unknown,
  ): Promise<VisitModality | null> {
    const [row] = await (tx as Tx)
      .select({ modality: appointments.modality })
      .from(appointments)
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.petId, key.petId),
          eq(appointments.organizationId, key.organizationId),
        ),
      )
      .limit(1);
    return row ? (row.modality as VisitModality) : null;
  }

  async closeVisit(
    args: { id: string; organizationId: string; closedByUserId: string },
    tx: unknown,
  ): Promise<{ visit: Visit; closedNow: boolean } | null> {
    const client = tx as Tx;
    const [closed] = await client
      .update(visits)
      .set({ closedAt: sql`now()`, closeReason: "vet", closedByUserId: args.closedByUserId })
      .where(
        and(
          eq(visits.id, args.id),
          eq(visits.organizationId, args.organizationId),
          isNull(visits.closedAt),
        ),
      )
      .returning(VISIT_COLUMNS);
    if (closed) return { visit: toVisit(closed), closedNow: true };

    const existing = await this.findVisitById(args.id, client);
    if (!existing || existing.organizationId !== args.organizationId) return null;
    return { visit: existing, closedNow: false };
  }
}
