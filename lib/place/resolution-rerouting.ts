// Re-routing an OPEN case after its place is resolved — localidades-por-id D9.
//
// While a case's place is unresolved, the id path reaches only its province's
// unit (P1). When a platform admin resolves it from the queue
// (lib/place/unresolved-queue.ts), the units that govern the resolved row may
// now reach it too — the municipality whose case it really is. They are told,
// once: a notification per newly covering authority, keyed so a retry never
// sends it twice. Nobody who already had it is ever "un-notified": the
// provincial holders keep what they saw.
//
// Only on the id path (flag `routing` = 'id', or an explicit mode): on the
// name path a resolution changes no routing at all — the names are the same.
//
// Subjects: a case directly, or a welfare report through the case it opened.
// A closed or merged case is left alone.

import { sql } from "drizzle-orm";

import type { db } from "@/db";
import { govtAuthoritiesForPlace } from "@/lib/infra/approval-routing";
import {
  type CreateNotificationInput,
  createNotificationsBulk,
} from "@/lib/infra/notification-service";
import { type PlaceReadMode, readPlaceFlag } from "@/lib/place/flags";

import type { QueueSubjectTable } from "./unresolved-queue";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export const PLACE_RESOLVED_NOTIFICATION_TYPE = "case_place_resolved_authority";

type OpenCase = {
  id: string;
  publicCode: string;
  province: string | null;
  locality: string | null;
};

async function openCaseOf(
  exec: Executor,
  subjectTable: QueueSubjectTable,
  subjectId: string,
): Promise<OpenCase | null> {
  const where =
    subjectTable === "cases"
      ? sql`c.id = ${subjectId}::uuid`
      : sql`c.welfare_report_id = ${subjectId}::uuid`;
  const rows = (await exec.execute(sql`
    select c.id::text as id, c.public_code as "publicCode",
           c.jurisdiction_province as province, c.jurisdiction_locality as locality
      from public.cases c
     where ${where} and c.status in ('open', 'escalated')
     order by c.opened_at desc
     limit 1
  `)) as unknown as OpenCase[];
  return rows[0] ?? null;
}

/**
 * Notify the authorities the resolved row reaches that the unresolved place
 * did not. Returns who was newly notified (empty on the name path, for a
 * closed case, or when no one new covers it).
 */
export async function notifyNewlyCoveringAuthorities(
  exec: Executor,
  input: { subjectTable: QueueSubjectTable; subjectId: string; localityId: string },
  opts: { mode?: PlaceReadMode } = {},
): Promise<{ notified: string[] }> {
  const mode = opts.mode ?? (await readPlaceFlag("routing"));
  if (mode !== "id") return { notified: [] };
  const found = await openCaseOf(exec, input.subjectTable, input.subjectId);
  if (!found) return { notified: [] };

  const place = { province: found.province ?? "", locality: found.locality ?? "" };
  const context = { mode: "id" as const, exec, route: "case_place_resolved" };
  const before = new Set(await govtAuthoritiesForPlace({ ...place, localityId: null }, context));
  const after = await govtAuthoritiesForPlace({ ...place, localityId: input.localityId }, context);
  const newly = after.filter((id) => !before.has(id));
  if (newly.length === 0) return { notified: [] };

  const inputs: CreateNotificationInput[] = newly.map((userId) => ({
    userId,
    notificationType: PLACE_RESOLVED_NOTIFICATION_TYPE,
    severity: "warning",
    title: "Un caso quedó ubicado en tu jurisdicción",
    body: `El caso ${found.publicCode} tenía el lugar sin resolver y ahora está asignado a ${found.locality ?? "una localidad"} de ${found.province ?? "tu provincia"}.`,
    ctaLabel: "Ver caso",
    ctaUrl: `/casos/${found.publicCode}`,
    relatedCaseId: found.id,
    dedupeKey: `place-resolved:${found.id}:${userId}`,
  }));
  await createNotificationsBulk(inputs, exec);
  return { notified: newly };
}
