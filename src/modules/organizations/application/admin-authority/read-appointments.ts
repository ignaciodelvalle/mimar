// Reads for /admin/designaciones (SDD jurisdiction-admin, Phase 3): the active
// appointment of each province, and who could be appointed to one.
//
// Read-only and never an authorization: the page is gated by the /admin
// layout, and appoint/revoke re-check everything inside their transaction.
// Executor-first, like the writers, so tests read inside their rollback.

import { sql } from "drizzle-orm";

import type { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AppointmentReadExecutor = typeof db | Tx;

export type ActiveAppointment = {
  appointmentId: string;
  provinceCode: string;
  userId: string;
  displayName: string;
  appointedAt: Date;
  appointmentReason: string;
  appointedByName: string | null;
  /** The twin's answer: false when the appointment row stands but its
   * authority broke (grant revoked, account deactivated, …) — fails closed. */
  authorityLive: boolean;
};

/** Every ACTIVE appointment, one per province at most (unique index). */
export async function listActiveAppointments(
  exec: AppointmentReadExecutor,
): Promise<ActiveAppointment[]> {
  const rows = (await exec.execute(sql`
    select a.id::text as appointment_id,
           a.province_code,
           a.user_id::text as user_id,
           p.display_name,
           a.appointed_at,
           a.appointment_reason,
           ap.display_name as appointed_by_name,
           public.jurisdiction_admin_province(a.user_id) is not distinct from a.province_code
             as authority_live
      from public.jurisdiction_admin_appointments a
      join public.profiles p on p.id = a.user_id
      left join public.profiles ap on ap.id = a.appointed_by_user_id
     where a.revoked_at is null
     order by a.province_code`)) as unknown as Array<{
    appointment_id: string;
    province_code: string;
    user_id: string;
    display_name: string;
    appointed_at: Date | string;
    appointment_reason: string;
    appointed_by_name: string | null;
    authority_live: boolean;
  }>;
  return rows.map((r) => ({
    appointmentId: r.appointment_id,
    provinceCode: r.province_code,
    userId: r.user_id,
    displayName: r.display_name,
    appointedAt: new Date(r.appointed_at),
    appointmentReason: r.appointment_reason,
    appointedByName: r.appointed_by_name,
    authorityLive: r.authority_live,
  }));
}

export type AppointmentCandidate = {
  userId: string;
  displayName: string;
  /** Already holds the whole-province grant (it is reused, not created). */
  hasWholeProvinceGrant: boolean;
};

/**
 * Active institutional govts who could be appointed for `provinceCode`: no
 * active appointment, at least one active grant in the province and none
 * outside it (design D3). The writer re-checks all of it.
 */
export async function listAppointmentCandidates(
  exec: AppointmentReadExecutor,
  provinceCode: string,
): Promise<AppointmentCandidate[]> {
  const rows = (await exec.execute(sql`
    select p.id::text as user_id,
           p.display_name,
           bool_or(public.govt_grant_is_whole_province(g.jurisdiction_province,
                                                       g.jurisdiction_locality))
             as has_whole
      from public.profiles p
      join public.govt_assignments g on g.user_id = p.id and g.revoked_at is null
     where p.role = 'govt'
       and p.account_type = 'institutional'
       and p.deactivated_at is null
       and p.deleted_at is null
       and not exists (
         select 1 from public.jurisdiction_admin_appointments a
          where a.user_id = p.id and a.revoked_at is null)
     group by p.id, p.display_name
    having bool_and(public.ar_province_code(g.jurisdiction_province) is not distinct from ${provinceCode})
     order by p.display_name`)) as unknown as Array<{
    user_id: string;
    display_name: string;
    has_whole: boolean;
  }>;
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    hasWholeProvinceGrant: r.has_whole,
  }));
}
