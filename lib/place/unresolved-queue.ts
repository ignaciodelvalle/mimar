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
// THE RECORD OF RECORD is place_resolutions, deliberately (stage D security
// review): append-only by trigger, and it carries exactly what an audit row
// would — who (actor_user_id), why (reason), when (created_at) and which
// earlier resolution it replaces (supersedes_id). Writing an audit_log row as
// well would be a second, driftable copy of the same fact. Note for the
// fences: lint:audit-log detects mutations by Drizzle .insert/.update/.delete
// only, so these raw-SQL writes are not measured by it either way.
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

import type { db } from "@/db";
import { provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";
import { requirePlatformAdmin } from "@/src/modules/organizations/application/admin-authority/authority";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type QueueExecutor = typeof db | Tx;

export const QUEUE_SUBJECT_TABLES = ["cases", "welfare_reports"] as const;
export type QueueSubjectTable = (typeof QUEUE_SUBJECT_TABLES)[number];

export type QueueCandidate = {
  localityId: string;
  name: string;
  department: string | null;
  /** Catalogue centroid; the distance from the pin is derived from it. */
  latitude: number | null;
  longitude: number | null;
};

export type QueueItem = {
  subjectTable: QueueSubjectTable;
  subjectId: string;
  province: string;
  enteredLocality: string;
  createdAt: Date;
  candidates: QueueCandidate[];
  /**
   * What the admin needs to decide, next to the button. Role and kind only:
   * no creator name, no contact, no DNI (the queue adds no PII).
   */
  context: QueueContext;
};

export type QueueContext = {
  /** Public code (case) or reference code (denuncia), the way the admin screens show it. */
  code: string | null;
  /** Raw case_kind / welfare kind; labelled by lib/place/queue-context. */
  kind: string | null;
  /** Public code of the case to link to; null when the subject has none. */
  caseCode: string | null;
  /** Denuncia id, to link to its moderation view when there is no case. */
  welfareReportId: string | null;
  creatorRole: string | null;
  creatorViaOrganization: boolean;
  /** The pin, when the subject recorded coordinates. */
  lat: number | null;
  lng: number | null;
  address: string | null;
  /** Home locality of the subject pet, when there is a pet. */
  petLocality: { name: string; department: string | null } | null;
  /** The place the linked case / denuncia recorded, as entered text. */
  linkedPlace: string | null;
};

export type QueueError =
  | "CAPABILITY_DENIED"
  | "NOT_FOUND"
  | "NOT_UNRESOLVED"
  | "PROVINCE_MISMATCH"
  | `VALIDATION_ERROR: ${string}`;

const QUEUE_LIMIT = 200;

/**
 * "Name (Department)" of a live catalogue locality, for the confirmation banner
 * after a resolution. Null when the id is not a uuid or names no live row, so a
 * forged `?resuelto=` renders nothing.
 */
export async function resolvedPlaceLabel(
  exec: QueueExecutor,
  localityId: string | undefined,
): Promise<string | null> {
  const parsed = z.string().uuid().safeParse(localityId);
  if (!parsed.success) return null;
  const rows = (await exec.execute(sql`
    select locality_name as name, department_name as department
      from public.ar_localities
     where id = ${parsed.data}::uuid and removed_at is null
  `)) as unknown as Array<{ name: string; department: string | null }>;
  const row = rows[0];
  if (!row) return null;
  return row.department ? `${row.name} (${row.department})` : row.name;
}

/**
 * The provinces whose unresolved queue a govt user may READ (D9): those a
 * provincial authority unit grant covers — the only grants an unresolved
 * place reaches on the id path. A municipal or legacy grant reads none here.
 */
export function readableQueueProvinces(
  scope: ReadonlyArray<{ source: string; provinceCode: string | null }>,
): string[] {
  const codes = scope
    .filter((r) => r.source === "province" && r.provinceCode)
    .map((r) => r.provinceCode as string);
  return [...new Set(codes)].sort();
}

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
                       'department', l.department_name,
                       'latitude', l.latitude::float8, 'longitude', l.longitude::float8)
                     order by l.department_name nulls first, l.id)
                from public.ar_localities l
               where l.province_code = ${province.code}
                 and l.removed_at is null
                 and l.locality_name_norm = btrim(regexp_replace(lower(translate(
                       public.immutable_unaccent(q.entered), '.', '')), '\\s+', ' ', 'g'))),
             '[]'::json) as candidates,
           json_build_object(
             'code', q.code, 'kind', q.kind, 'caseCode', q.case_code,
             'welfareReportId', q.welfare_report_id,
             'creatorRole', q.creator_role,
             'creatorViaOrganization', q.creator_org,
             'lat', q.lat::float8, 'lng', q.lng::float8, 'address', q.address,
             'petLocality', (select json_build_object('name', pl.locality_name,
                                                      'department', pl.department_name)
                               from public.pets pt
                               join public.ar_localities pl on pl.id = pt.locality_id
                              where pt.id = q.pet_id),
             'linkedPlace', q.linked_place) as context
      from (
        select 'cases'::text as subject_table, c.id as subject_id,
               c.jurisdiction_province as province, c.jurisdiction_locality as entered,
               c.created_at,
               c.public_code as code, c.case_kind as kind, c.public_code as case_code,
               c.welfare_report_id::text as welfare_report_id,
               (select pr.role::text from public.profiles pr where pr.id = c.opened_by_user_id)
                 as creator_role,
               (c.opened_by_organization_id is not null) as creator_org,
               c.location_lat as lat, c.location_lng as lng, null::text as address,
               c.primary_pet_id as pet_id,
               (select concat_ws(', ', nullif(btrim(w.location_address), ''),
                                 nullif(btrim(w.jurisdiction_locality), ''),
                                 nullif(btrim(w.jurisdiction_province), ''))
                  from public.welfare_reports w where w.id = c.welfare_report_id) as linked_place
          from public.cases c
         where c.locality_id is null
           and c.jurisdiction_province = ${province.name}
           and nullif(btrim(c.jurisdiction_locality), '') is not null
        union all
        select 'welfare_reports', w.id, w.jurisdiction_province, w.jurisdiction_locality,
               w.created_at,
               w.reference_code, w.kind::text, lc.public_code, w.id::text,
               (select pr.role::text from public.profiles pr where pr.id = w.reporter_user_id),
               (w.reporter_organization_id is not null),
               w.location_lat, w.location_lng, w.location_address,
               w.subject_pet_id,
               (select concat_ws(', ', nullif(btrim(c2.jurisdiction_locality), ''),
                                 nullif(btrim(c2.jurisdiction_province), ''))
                  from public.cases c2 where c2.welfare_report_id = w.id limit 1)
          from public.welfare_reports w
          left join lateral (select c3.public_code from public.cases c3
                              where c3.welfare_report_id = w.id order by c3.created_at limit 1) lc
            on true
         where w.locality_id is null
           and w.jurisdiction_province = ${province.name}
           and nullif(btrim(w.jurisdiction_locality), '') is not null
      ) q
     order by q.created_at, q.subject_id
     limit ${QUEUE_LIMIT}
  `)) as unknown as Array<Omit<QueueItem, "createdAt"> & { createdAt: Date | string }>;
  return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
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
  const { subjectTable, subjectId, localityId, reason } = parsed.data;
  const table = sql.raw(`public.${subjectTable}`);

  return exec.transaction(async (tx) => {
    // Platform-only (the queue is never delegated), checked in the same
    // transaction as the resolution it authorizes. A malformed actor id is
    // refused by the loader, not by a query error.
    if (!(await requirePlatformAdmin(tx, actorUserId))) {
      return { error: "CAPABILITY_DENIED" as const };
    }
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
