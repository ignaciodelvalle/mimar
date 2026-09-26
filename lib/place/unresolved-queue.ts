// The unresolved-place queue — localidades-por-id D9 (design "Unresolved
// queue", spec "unresolved-place-queue").
//
// A place that did not resolve to ONE catalogue row is never dropped and never
// guessed: it reaches only its province (govt_scope, routing, RLS) and waits
// here for a platform admin. The admin sees what was entered and the rows it
// could mean — every live catalogue row of the province whose folded name
// matches, labelled with its department, none pre-chosen (P1) — and picks one.
//
// A resolution writes, in one transaction:
//   - a place_resolutions row (append-only: who, why, method 'admin_queue',
//     and the earlier resolution it supersedes, if any);
//   - the subject row's DECLARED cache columns: locality_id and
//     place_method = 'admin_queue'. The entered text (jurisdiction_locality)
//     stays as entered, and the event that recorded the place is never
//     touched (P2).
//
// Subjects: cases and welfare_reports — rows written once at capture whose
// place columns nothing re-derives. Pets are NOT resolved here: pets.locality_id
// is a cache of the event spine (rederivePetCache would read an admin write as
// drift), so a pet's place is corrected by a move event, not by this queue.
//
// Executor-first, so tests roll back; the "use server" shim is
// app/actions/place-queue.ts.

import { sql } from "drizzle-orm";
import { z } from "zod/v4";

import { type db, profiles } from "@/db";
import { type ActorProfile, canAssignGovtLocality } from "@/lib/domain/institutional-scope";
import { provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type QueueExecutor = typeof db | Tx;

export const QUEUE_SUBJECT_TABLES = ["cases", "welfare_reports"] as const;
export type QueueSubjectTable = (typeof QUEUE_SUBJECT_TABLES)[number];

export type QueueCandidate = { localityId: string; name: string; department: string | null };

export type QueueItem = {
  subjectTable: QueueSubjectTable;
  subjectId: string;
  province: string;
  enteredLocality: string;
  createdAt: Date;
  candidates: QueueCandidate[];
};

export type QueueError =
  | "CAPABILITY_DENIED"
  | "NOT_FOUND"
  | "NOT_UNRESOLVED"
  | "PROVINCE_MISMATCH"
  | `VALIDATION_ERROR: ${string}`;

const QUEUE_LIMIT = 200;

/**
 * The province's unresolved rows, oldest first, each with its candidates.
 * A row leaves the queue when its locality_id is set (by this queue or by a
 * later writer).
 */
export async function listUnresolvedPlaces(
  exec: QueueExecutor,
  input: { provinceCode: string },
): Promise<QueueItem[]> {
  const province = provinceByCode(input.provinceCode);
  if (!province) return [];
  const rows = (await exec.execute(sql`
    select q.subject_table as "subjectTable", q.subject_id::text as "subjectId",
           q.province, q.entered as "enteredLocality", q.created_at as "createdAt",
           coalesce(
             (select json_agg(json_build_object(
                       'localityId', l.id::text, 'name', l.locality_name,
                       'department', l.department_name)
                     order by l.department_name nulls first, l.id)
                from public.ar_localities l
               where l.province_code = ${province.code}
                 and l.removed_at is null
                 and l.locality_name_norm = btrim(regexp_replace(lower(translate(
                       public.immutable_unaccent(q.entered), '.', '')), '\\s+', ' ', 'g'))),
             '[]'::json) as candidates
      from (
        select 'cases'::text as subject_table, c.id as subject_id,
               c.jurisdiction_province as province, c.jurisdiction_locality as entered,
               c.created_at
          from public.cases c
         where c.locality_id is null
           and c.jurisdiction_province = ${province.name}
           and nullif(btrim(c.jurisdiction_locality), '') is not null
        union all
        select 'welfare_reports', w.id, w.jurisdiction_province, w.jurisdiction_locality,
               w.created_at
          from public.welfare_reports w
         where w.locality_id is null
           and w.jurisdiction_province = ${province.name}
           and nullif(btrim(w.jurisdiction_locality), '') is not null
      ) q
     order by q.created_at, q.subject_id
     limit ${QUEUE_LIMIT}
  `)) as unknown as Array<Omit<QueueItem, "createdAt"> & { createdAt: Date | string }>;
  return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
}

async function isActiveAdmin(exec: QueueExecutor, actorUserId: string): Promise<boolean> {
  const rows = await exec
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(sql`${profiles.id} = ${actorUserId}::uuid`)
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  return canAssignGovtLocality({
    id: row.id,
    role: row.role as ActorProfile["role"],
    accountType: row.accountType as ActorProfile["accountType"],
    deactivatedAt: row.deactivatedAt,
  });
}

const inputSchema = z.object({
  subjectTable: z.enum(QUEUE_SUBJECT_TABLES),
  subjectId: z.string().uuid(),
  localityId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(1, "Contá por qué el lugar es esa localidad.")
    .max(1000, "El motivo admite hasta 1000 caracteres."),
});

/** Resolve one queued row to one catalogue locality of its own province. */
export async function resolvePlaceFromQueue(
  exec: QueueExecutor,
  actorUserId: string,
  input: { subjectTable: QueueSubjectTable; subjectId: string; localityId: string; reason: string },
): Promise<{ ok: true } | { error: QueueError }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `VALIDATION_ERROR: ${parsed.error.issues[0]?.message ?? "datos inválidos"}` };
  }
  if (!z.string().uuid().safeParse(actorUserId).success) return { error: "CAPABILITY_DENIED" };
  if (!(await isActiveAdmin(exec, actorUserId))) return { error: "CAPABILITY_DENIED" };
  const { subjectTable, subjectId, localityId, reason } = parsed.data;
  const table = sql.raw(`public.${subjectTable}`);

  return exec.transaction(async (tx) => {
    const subject = (await tx.execute(sql`
      select jurisdiction_province as province, locality_id::text as "localityId"
        from ${table} where id = ${subjectId}::uuid for update
    `)) as unknown as Array<{ province: string | null; localityId: string | null }>;
    const row = subject[0];
    if (!row) return { error: "NOT_FOUND" as const };
    if (row.localityId !== null) return { error: "NOT_UNRESOLVED" as const };

    const locality = (await tx.execute(sql`
      select province_code as "provinceCode" from public.ar_localities
       where id = ${localityId}::uuid and removed_at is null
    `)) as unknown as Array<{ provinceCode: string }>;
    if (!locality[0]) return { error: "NOT_FOUND" as const };
    if (provinceByName(row.province)?.code !== locality[0].provinceCode) {
      return { error: "PROVINCE_MISMATCH" as const };
    }

    await tx.execute(sql`
      insert into public.place_resolutions
        (subject_table, subject_id, locality_id, method, actor_user_id, reason, supersedes_id)
      values (${subjectTable}, ${subjectId}::uuid, ${localityId}::uuid, 'admin_queue',
              ${actorUserId}::uuid, ${reason},
              (select r.id from public.place_resolutions r
                where r.subject_table = ${subjectTable} and r.subject_id = ${subjectId}::uuid
                order by r.created_at desc limit 1))
    `);
    await tx.execute(sql`
      update ${table}
         set locality_id = ${localityId}::uuid, place_method = 'admin_queue'
       where id = ${subjectId}::uuid
    `);
    return { ok: true as const };
  });
}
