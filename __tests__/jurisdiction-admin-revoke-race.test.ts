// jurisdiction-admin, Phase 4 (task 4.7, design vector 13) — a revocation
// racing a delegated write, against a real database, on two connections.
//
// THE PROPERTY
// ---------------------------------------------------------------------------
// loadAdminAuthority (the one authority loader every delegated writer calls
// inside its own transaction) locks the actor's ACTIVE appointment row FOR
// SHARE before asking the database twin. So:
//   A. a writer that has read its authority holds the row: a revocation (an
//      UPDATE of that row) started afterwards WAITS until the writer commits —
//      it can never land between the check and the write it authorizes;
//   B. a revocation that is still uncommitted makes the loader WAIT, and once
//      it commits the loader answers `none` — never the authority the
//      revocation was taking away.
// Both are observed, not inferred: the waiting backend must be seen in
// pg_stat_activity with wait_event_type = 'Lock'. Remove the FOR SHARE and
// both cases fail (nobody waits; B reads the old authority).
//
// WHY COMMITTED ROWS, AND HOW THEY GO AWAY
// ---------------------------------------------------------------------------
// Two connections only see committed rows, so this file — unlike every other
// jurisdiction-admin test — commits its fixtures: two profiles (no auth user),
// a whole-province grant and an appointment per case, in San Luis (AR-D): no
// other test appoints there, and no notification fan-out test places an event
// there (a committed whole-province govt is a recipient for as long as it
// lives — Tierra del Fuego, the first choice, broke eno-trigger's "nobody in
// scope" fallback). The appointment table is append-only (its trigger refuses
// DELETE), so the sweep deletes the rows inside ONE transaction that disables
// that trigger, deletes, and re-enables it before committing. DDL is
// transactional: no other session ever sees the trigger disabled — ALTER
// TABLE takes an ACCESS EXCLUSIVE lock, so any other writer of the table
// waits for the commit, by which time the trigger is back. The sweep runs
// BEFORE the cases too, by the fixtures' display-name prefix, so a run that
// died before its cleanup (a mutant, a killed worker) is healed by the next
// one instead of leaving a live appointee behind. The post-sweep assertion
// proves the trigger is enabled again.

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";
import { postgresTlsOption } from "@/db/tls";
import { DEFAULT_LOCAL_URL } from "@/scripts/_db-target";
import { loadAdminAuthority } from "@/src/modules/organizations/application/admin-authority/authority";

const PROVINCE = "AR-D";
/** Every fixture profile carries it: the sweep finds them by it. */
const MARK = "JA4 race fixture";

const revoker = postgres(process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL, {
  max: 2,
  connect_timeout: 5,
  ssl: postgresTlsOption(process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL),
});

const admin = randomUUID();
const appointee = randomUUID();
const appointmentIds: string[] = [];

/** Commit a fresh whole-province grant + active appointment for the appointee. */
async function appointFresh(): Promise<string> {
  // The whole-province grant outlives a revoked appointment: reuse it.
  let [grant] = await revoker<{ id: string }[]>`
    select id::text as id from public.govt_assignments
     where user_id = ${appointee}::uuid and revoked_at is null`;
  if (!grant) {
    [grant] = await revoker<{ id: string }[]>`
      insert into public.govt_assignments (user_id, jurisdiction_province, jurisdiction_locality)
      values (${appointee}::uuid, public.ar_province_name(${PROVINCE}), '')
      returning id::text as id`;
  }
  const [appointment] = await revoker<{ id: string }[]>`
    insert into public.jurisdiction_admin_appointments
      (user_id, province_code, govt_assignment_id, grant_created, appointed_by_user_id,
       appointment_reason)
    values (${appointee}::uuid, ${PROVINCE}, ${grant.id}::uuid, true, ${admin}::uuid,
            'Designación de prueba para la carrera de revocación')
    returning id::text as id`;
  appointmentIds.push(appointment.id);
  return appointment.id;
}

/** Is backend `pid` waiting on a lock — and, when given, running a statement like `queryLike`? */
async function isWaitingOnLock(pid: number, queryLike?: string): Promise<boolean> {
  const rows = await revoker<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
     where pid = ${pid} and wait_event_type = 'Lock'
       and (${queryLike ?? null}::text is null or query ilike ${queryLike ?? null}::text)`;
  return rows[0].n > 0;
}

async function waitUntilWaiting(pid: number, who: string, queryLike?: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await isWaitingOnLock(pid, queryLike)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${who} never waited on a lock — the appointment row was not held`);
}

function revoke(conn: postgres.Sql | postgres.TransactionSql, appointmentId: string) {
  return conn`
    update public.jurisdiction_admin_appointments
       set revoked_at = now(), revoked_by_user_id = ${admin}::uuid,
           revocation_reason = 'Revocación de prueba en carrera'
     where id = ${appointmentId}::uuid and revoked_at is null`;
}

/** Delete every fixture this file ever committed (this run's or a dead run's). */
async function sweep(): Promise<void> {
  await revoker.begin(async (t) => {
    await t`set local lock_timeout = '10s'`;
    const users = (
      await t<{ id: string }[]>`
        select id::text as id from public.profiles where display_name like ${`${MARK}%`}`
    ).map((r) => r.id);
    if (users.length === 0) return;
    await t`alter table public.jurisdiction_admin_appointments
              disable trigger jurisdiction_admin_appointments_append_only`;
    await t`delete from public.jurisdiction_admin_appointments
             where user_id = any(${users}::uuid[]) or appointed_by_user_id = any(${users}::uuid[])`;
    await t`alter table public.jurisdiction_admin_appointments
              enable trigger jurisdiction_admin_appointments_append_only`;
    await t`delete from public.govt_assignments where user_id = any(${users}::uuid[])`;
    await t`delete from public.notifications where user_id = any(${users}::uuid[])`;
    await t`delete from public.profiles where id = any(${users}::uuid[])`;
  });
  const [trigger] = await revoker<{ enabled: string }[]>`
    select tgenabled as enabled from pg_trigger
     where tgname = 'jurisdiction_admin_appointments_append_only'`;
  expect(trigger.enabled).toBe("O");
}

beforeAll(async () => {
  await sweep();
  await revoker`
    insert into public.profiles (id, display_name, role, account_type) values
      (${admin}::uuid, ${`${MARK} platform admin`}, 'admin', 'institutional'),
      (${appointee}::uuid, ${`${MARK} appointee`}, 'govt', 'institutional')`;
}, 30_000);

afterAll(async () => {
  try {
    await sweep();
    expect(appointmentIds.length).toBeGreaterThan(0);
  } finally {
    await revoker.end();
  }
}, 30_000);

describe("a revocation racing a delegated write (FOR SHARE on the appointment)", () => {
  it("A — once a writer has read its authority, a revocation waits for the writer to finish", async () => {
    const appointmentId = await appointFresh();
    const revocation = await revoker.reserve();
    try {
      const [{ pid }] = await revocation<{ pid: number }[]>`select pg_backend_pid() as pid`;
      let revoking: Promise<unknown> | null = null;
      await db.transaction(async (tx) => {
        expect(await loadAdminAuthority(tx, appointee)).toEqual({
          kind: "jurisdiction",
          provinceCode: PROVINCE,
        });
        revoking = revoke(revocation, appointmentId);
        revoking.catch(() => undefined);
        await waitUntilWaiting(pid, "the revocation");
        // Still inside the writer: the authority it acts on is intact.
        const [row] = (await tx.execute(sql`
          select revoked_at from public.jurisdiction_admin_appointments
           where id = ${appointmentId}::uuid`)) as unknown as Array<{ revoked_at: Date | null }>;
        expect(row.revoked_at).toBeNull();
      });
      await revoking;
      expect(await loadAdminAuthority(db, appointee)).toEqual({ kind: "none" });
    } finally {
      revocation.release();
    }
  }, 20_000);

  it("B — a revocation in flight makes the loader wait, and the loader then answers none", async () => {
    const appointmentId = await appointFresh();
    let loading: Promise<unknown> | null = null;
    // ONE observer, and the commit waits for it. This case used to run two
    // probes of the same wait: the loader's own (by pid) and a second one here
    // (by query text) that committed the revocation as soon as IT saw the
    // wait. Whichever probe won, the other lost: when this side saw the wait
    // first, the commit released the loader before its pid probe ever ran,
    // and that probe then polled a backend that was no longer waiting until
    // its deadline — "never waited on a lock", although it had (CI run
    // 36552956434 failed in 4024 ms, under this side's 5000 ms deadline, so
    // this side HAD seen the wait). A 300 ms delay before the pid probe
    // reproduces it on every run. Now the commit is gated on the loader's
    // probe: the revocation cannot commit before that probe has seen the wait.
    let loaderSeenWaiting!: () => void;
    let loaderNotSeen!: (e: unknown) => void;
    const loaderWaiting = new Promise<void>((resolve, reject) => {
      loaderSeenWaiting = resolve;
      loaderNotSeen = reject;
    });
    await revoker.begin(async (t) => {
      await revoke(t, appointmentId);
      loading = db.transaction(async (tx) => {
        const [{ pid }] = (await tx.execute(
          sql`select pg_backend_pid() as pid`,
        )) as unknown as Array<{ pid: number }>;
        const authority = loadAdminAuthority(tx, appointee);
        authority.catch(() => undefined);
        await waitUntilWaiting(
          pid,
          "the authority loader",
          "%jurisdiction_admin_appointments%for share%",
        );
        loaderSeenWaiting();
        return authority;
      });
      // A loader that fails before it is seen waiting fails the wait too
      // (a no-op once loaderSeenWaiting has run).
      loading.catch(loaderNotSeen);
      // Commit only once the loader has been seen waiting on the row.
      await loaderWaiting;
    });
    expect(await loading).toEqual({ kind: "none" });
  }, 20_000);
});
