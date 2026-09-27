// jurisdiction-admin, Phase 5 — the audit history by PLACE, and what the
// jurisdiction admin may read of it (PO decision M1, 2026-09-27).
//
// The appointee oversees misuse in their province: who ran a people search,
// who opened a welfare location, who exported, when. They read WHAT and WHEN
// — never the search text, a DNI HMAC, an address, or any other third party's
// data a payload carries. This file proves it through EVERY path the
// appointee has to a row:
//
//   1. the audit_log TABLE through the real `authenticated` role (the 0269
//      raw branch is gone — migration 0271);
//   2. public.jurisdiction_admin_audit_trail(), their PostgREST read;
//   3. the redaction helpers themselves (owner-only, not an API);
//   4. /gob/historial — the history query AND the rendered page, driven
//      through its real data path.
//
// Final review follow-ups (migration 0272): the approval request someone
// else's row names never reaches the appointee (LOW-2), and an arbitrary id in
// ?actor= never comes back as a name unless it is a funcionario's (LOW-3).
//
// The negative fixture is the PO's own: a `pii_queried` row whose query is
// "Juan Perez", written by a funcionario of the appointee's province.
//
// And the place rules (task 5.5/5.6): a funcionario's act stays visible after
// they are transferred out; a foreign province's row never is; a row written
// before the stamp existed is read from the place it names; an unplaced row is
// hidden.
//
// NO RESIDUE. Every fixture lives in ONE transaction per test, always rolled
// back. The page reads through `@/db`, which this file points at that same
// transaction (see the mock below), so the page sees exactly the fixtures and
// nothing is ever committed.

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

type RealDb = typeof import("@/db")["db"];
type Tx = Parameters<Parameters<RealDb["transaction"]>[0]>[0];

const state = vi.hoisted(() => ({
  realDb: null as unknown,
  tx: null as unknown,
  session: null as unknown,
}));

// `db` follows the test's transaction while one is open, so the page's own
// queries (and every helper it calls) read the rolled-back fixtures.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  state.realDb = actual.db;
  const db = new Proxy(actual.db, {
    get(target, key) {
      const exec = (state.tx ?? target) as object;
      const value = Reflect.get(exec, key, exec);
      return typeof value === "function" ? value.bind(exec) : value;
    },
  });
  return { ...actual, db };
});

vi.mock("@/lib/infra/auth-guards", () => ({
  requireGobReadAccessOrRedirect: async () => state.session,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/gob/historial",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import GobHistorialPage from "@/app/gob/historial/page";
import { auditLog, db } from "@/db";
import {
  type AuditHistoryScope,
  auditHistoryRowColumns,
  buildAuditHistoryWhere,
  resolveAuditHistoryActorOptions,
} from "@/lib/infra/audit-history-query";
import { fetchJurisdictionActorIds } from "@/lib/infra/govt-audit-scope";

import { expectDbError } from "./_helpers/expect-db-error";

const ROLLBACK = new Error("jurisdiction-admin-audit-visibility: rollback");
const SEARCHED = "Juan Perez";
const HMAC = "hmac-de-un-dni-ajeno";

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  const realDb = state.realDb as RealDb;
  try {
    await realDb.transaction(async (tx) => {
      state.tx = tx;
      try {
        await body(tx);
      } finally {
        state.tx = null;
        state.session = null;
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

function inSavepoint<T>(tx: Tx, body: (sp: Tx) => Promise<T>): Promise<T> {
  return tx.transaction(body);
}

async function rows<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)) as unknown as T[];
}

type Role = "admin" | "govt" | "owner";

async function insertProfile(tx: Tx, role: Role, name: string): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`
    insert into public.profiles (id, display_name, role, account_type)
    values (${id}::uuid, ${name}, ${role}, ${role === "owner" ? "personal" : "institutional"})`);
  return id;
}

async function insertGrant(
  tx: Tx,
  userId: string,
  province: string,
  locality: string,
  grantedBy: string | null,
): Promise<string> {
  const [row] = await rows<{ id: string }>(
    tx,
    sql`insert into public.govt_assignments
          (user_id, jurisdiction_province, jurisdiction_locality, granted_by_user_id)
        values (${userId}::uuid, ${province}, ${locality}, ${grantedBy}::uuid)
        returning id::text as id`,
  );
  return row.id;
}

type World = {
  admin: string;
  /** Mendoza whole-province govt, appointed jurisdiction admin of AR-M. */
  mza: string;
  /** A Mendoza funcionario (one locality) — the appointee's peer. */
  mzaPlain: string;
  /** A San Juan funcionario. */
  sj: string;
  /** Two citizens: personal accounts. */
  citizen: string;
  citizen2: string;
};

async function world(tx: Tx): Promise<World> {
  const admin = await insertProfile(tx, "admin", "JA5 probe platform admin");
  const mza = await insertProfile(tx, "govt", "JA5 probe Mendoza appointee");
  const mzaPlain = await insertProfile(tx, "govt", "JA5 probe Mendoza funcionario");
  const sj = await insertProfile(tx, "govt", "JA5 probe San Juan funcionario");
  const citizen = await insertProfile(tx, "owner", "JA5 probe citizen Ana");
  const citizen2 = await insertProfile(tx, "owner", "JA5 probe citizen Beto");
  const grant = await insertGrant(tx, mza, "Mendoza", "", admin);
  await insertGrant(tx, mzaPlain, "Mendoza", "Godoy Cruz", admin);
  await insertGrant(tx, sj, "San Juan", "", admin);
  await tx.execute(sql`
    insert into public.jurisdiction_admin_appointments
      (user_id, province_code, govt_assignment_id, grant_created, appointed_by_user_id,
       appointment_reason)
    values (${mza}::uuid, 'AR-M', ${grant}::uuid, true, ${admin}::uuid, 'Designación de prueba')`);
  return { admin, mza, mzaPlain, sj, citizen, citizen2 };
}

async function writeAudit(
  tx: Tx,
  a: {
    actor: string | null;
    action: string;
    payload?: Record<string, unknown>;
    targetUser?: string | null;
    approvalRequest?: string | null;
  },
): Promise<{ id: string; province_code: string | null }> {
  const [row] = await rows<{ id: string; province_code: string | null }>(
    tx,
    sql`insert into public.audit_log
          (actor_user_id, action, target_user_id, approval_request_id, payload)
        values (${a.actor}::uuid, ${a.action}, ${a.targetUser ?? null}::uuid,
                ${a.approvalRequest ?? null}::uuid, ${JSON.stringify(a.payload ?? {})}::jsonb)
        returning id::text as id, province_code`,
  );
  return row;
}

/** Run `query` as the real `authenticated` role with `userId`'s token claims. */
async function asUser<T>(
  tx: Tx,
  userId: string,
  query: ReturnType<typeof sql>,
  aal: "aal1" | "aal2" = "aal2",
): Promise<T[]> {
  await tx.execute(
    sql`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: userId,
      role: "authenticated",
      aal,
    })}, true)`,
  );
  await tx.execute(sql`set local role authenticated`);
  // No `finally`: a failed query aborts the (sav)epoint, and its rollback
  // already undoes the SET LOCAL.
  const out = await rows<T>(tx, query);
  await tx.execute(sql`reset role`);
  return out;
}

type TrailRow = {
  id: string;
  action: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  province_code: string;
  payload: Record<string, unknown>;
};

const trailOf = (tx: Tx, userId: string, aal: "aal1" | "aal2" = "aal2") =>
  asUser<TrailRow>(
    tx,
    userId,
    sql`select id::text as id, action, actor_user_id::text as actor_user_id,
               target_user_id::text as target_user_id, province_code, payload
          from public.jurisdiction_admin_audit_trail(null, null, 500)`,
    aal,
  );

/** The /gob/historial query for `scope`, exactly as the page builds it. */
async function historyQuery(tx: Tx, scope: AuditHistoryScope, actorFilter: string | null = null) {
  const cols = auditHistoryRowColumns(scope);
  return tx
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorUserId: cols.actorUserId,
      actorHidden: cols.actorHidden,
      targetUserId: cols.targetUserId,
      targetHidden: cols.targetHidden,
      approvalRequestId: cols.approvalRequestId,
      payload: cols.payload,
    })
    .from(auditLog)
    .where(buildAuditHistoryWhere(scope, { actionFilters: [], actorFilter, cursor: null }));
}

// ---------------------------------------------------------------------------
// M1 — "Juan Perez" never reaches the appointee
// ---------------------------------------------------------------------------

describe("M1 — the appointee reads WHAT and WHEN of their province, never a third party's data", () => {
  it("through the table and the trail: the search text, the HMAC and the citizens never arrive; the platform admin keeps full detail", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const search = await writeAudit(tx, {
        actor: w.mzaPlain,
        action: "pii_queried",
        payload: { query: SEARCHED, surface: "gob_personas", result_count: 1, dni_hmac: HMAC },
      });
      expect(search.province_code).toBe("AR-M");
      // A citizen's access trail that names the province, about another citizen.
      const citizenRow = await writeAudit(tx, {
        actor: w.citizen,
        action: "welfare_location_viewed",
        targetUser: w.citizen2,
        payload: { province: "Mendoza", reference_code: SEARCHED },
      });
      expect(citizenRow.province_code).toBe("AR-M");
      const ids = [search.id, citizenRow.id];
      const byId = sql.join(
        ids.map((i) => sql`${i}::uuid`),
        sql`, `,
      );

      // 1. The table: the 0269 branch is gone — the appointee reads neither.
      const table = await asUser<Record<string, unknown>>(
        tx,
        w.mza,
        sql`select * from public.audit_log where id in (${byId})`,
      );
      expect(table).toEqual([]);

      // 2. The trail: both rows, redacted.
      const trail = await trailOf(tx, w.mza);
      const got = new Map(trail.map((r) => [r.id, r]));
      expect(got.get(search.id)).toMatchObject({
        action: "pii_queried",
        actor_user_id: w.mzaPlain, // a funcionario: shown
        province_code: "AR-M",
        payload: { surface: "gob_personas", result_count: 1 },
      });
      expect(Object.keys(got.get(search.id)?.payload ?? {}).sort()).toEqual([
        "result_count",
        "surface",
      ]);
      expect(got.get(citizenRow.id)).toMatchObject({
        action: "welfare_location_viewed",
        actor_user_id: null, // a citizen: never shown
        target_user_id: null,
        payload: {},
      });
      const everything = JSON.stringify(trail);
      expect(everything).not.toContain(SEARCHED);
      expect(everything).not.toContain(HMAC);
      expect(everything).not.toContain(w.citizen);
      expect(everything).not.toContain(w.citizen2);

      // Below aal2 the trail answers nothing; a plain govt, nothing either.
      expect(await trailOf(tx, w.mza, "aal1")).toEqual([]);
      expect(await trailOf(tx, w.mzaPlain)).toEqual([]);
      expect(await trailOf(tx, w.sj)).toEqual([]);

      // The platform admin keeps the full row (investigations).
      const full = await asUser<{ payload: { query: string } }>(
        tx,
        w.admin,
        sql`select payload from public.audit_log where id = ${search.id}::uuid`,
      );
      expect(full[0]?.payload.query).toBe(SEARCHED);
    });
  });

  // Asserted from the CATALOG, never by calling a helper as a denied role: on
  // the local Supabase image a denied call of a STABLE function segfaults the
  // backend and restarts every connection of the shared database (see the
  // note in migration 0271). The one call below is IMMUTABLE, which denies
  // cleanly.
  it("the redaction helpers are not an API; the trail is not anon's", async () => {
    const privileges = async (fn: string) => {
      const [row] = (await db.execute(
        sql`select has_function_privilege('anon', ${fn}, 'EXECUTE') as anon,
                   has_function_privilege('authenticated', ${fn}, 'EXECUTE') as authn,
                   exists (select 1
                             from pg_proc p,
                                  lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                            where p.oid = ${fn}::regprocedure
                              and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public`,
      )) as unknown as Array<{ anon: boolean; authn: boolean; public: boolean }>;
      return row;
    };
    for (const fn of [
      "public.audit_payload_redacted(text, jsonb)",
      "public.audit_institutional_or_null(uuid)",
      "public.audit_place_province(text, jsonb, uuid)",
    ]) {
      expect(await privileges(fn), fn).toEqual({ anon: false, authn: false, public: false });
    }
    expect(
      await privileges("public.jurisdiction_admin_audit_trail(timestamptz, uuid, integer)"),
    ).toEqual({ anon: false, authn: true, public: false });

    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await expectDbError(
        inSavepoint(tx, (sp) =>
          asUser(
            sp,
            w.mza,
            sql`select public.audit_payload_redacted('pii_queried', '{"query":"x"}'::jsonb)`,
          ),
        ),
        { code: "42501" },
      );
    });
  });

  it("/gob/historial: the history query selects someone else's row redacted, and the rendered page never shows the search", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const search = await writeAudit(tx, {
        actor: w.mzaPlain,
        action: "pii_queried",
        payload: { query: SEARCHED, surface: "gob_personas", result_count: 1, dni_hmac: HMAC },
      });
      const citizenRow = await writeAudit(tx, {
        actor: w.citizen,
        action: "welfare_location_viewed",
        targetUser: w.citizen2,
        payload: { province: "Mendoza", reference_code: SEARCHED },
      });
      const own = await writeAudit(tx, {
        actor: w.mza,
        action: "pii_queried",
        payload: { query: "mi propia búsqueda", surface: "gob_personas", result_count: 0 },
      });

      const scope: AuditHistoryScope = {
        kind: "govt",
        actorIds: await fetchJurisdictionActorIds([{ province: "Mendoza", locality: "" }]),
        viewerId: w.mza,
        provinceCode: "AR-M",
      };
      const history = await historyQuery(tx, scope);
      const byId = new Map(history.map((r) => [r.id, r]));
      expect(byId.get(search.id)?.payload).toEqual({ surface: "gob_personas", result_count: 1 });
      expect(byId.get(citizenRow.id)).toMatchObject({
        actorUserId: null,
        actorHidden: true,
        targetUserId: null,
        targetHidden: true,
        payload: {},
      });
      // The viewer's own row is theirs.
      expect(byId.get(own.id)?.payload).toMatchObject({ query: "mi propia búsqueda" });
      expect(JSON.stringify(history.filter((r) => r.id !== own.id))).not.toContain(SEARCHED);

      // A PLAIN govt peer reads the same colleague row redacted too.
      const plain = await historyQuery(tx, {
        kind: "govt",
        actorIds: scope.actorIds,
        viewerId: w.sj,
      });
      expect(plain.find((r) => r.id === search.id)?.payload).toEqual({
        surface: "gob_personas",
        result_count: 1,
      });

      // A citizen's id in the ?actor= filter answers nothing.
      expect(await historyQuery(tx, scope, w.citizen)).toEqual([]);
      expect((await historyQuery(tx, scope, w.mzaPlain)).map((r) => r.id)).toContain(search.id);

      // The page itself, through its real data path.
      state.session = {
        user: { id: w.mza },
        profile: { id: w.mza, role: "govt" },
        jurisdictions: [{ province: "Mendoza", locality: "" }],
      };
      // An explicit, wide range: the default window ends at the HOST clock,
      // and these rows carry the DATABASE clock (never compare the two).
      const element = await GobHistorialPage({
        searchParams: Promise.resolve({ period: "custom", from: "2000-01-01", to: "2099-12-31" }),
      });
      const html = renderToStaticMarkup(element as React.ReactElement);
      expect(html).toContain("gob_personas");
      expect(html).toContain("Persona usuaria");
      expect(html).toContain("todo lo ocurrido en Mendoza");
      expect(html).not.toContain(SEARCHED);
      expect(html).not.toContain(HMAC);
      expect(html).not.toContain("JA5 probe citizen");
    });
  });
});

// ---------------------------------------------------------------------------
// Final review LOW-2 / LOW-3 — the request a row names, and the ?actor= name
// ---------------------------------------------------------------------------

/** A citizen's pending matrícula application in Mendoza; returns its id and token. */
async function insertRequest(tx: Tx, applicant: string): Promise<{ id: string; token: string }> {
  const token = `JA-REQ-${randomUUID()}`;
  const [row] = await rows<{ id: string }>(
    tx,
    sql`insert into public.approval_requests
          (public_token, type, applicant_user_id, target_user_id,
           jurisdiction_province, jurisdiction_locality, payload)
        values (${token}, 'role_upgrade_vet', ${applicant}::uuid, ${applicant}::uuid,
                'Mendoza', 'Godoy Cruz',
                '{"payload_version":1,"matricula_number":"MN-JA-PROBE"}'::jsonb)
        returning id::text as id`,
  );
  return { id: row.id, token };
}

describe("LOW-2 — the approval request of someone else's row never reaches the appointee", () => {
  it("through the trail, the history query and the rendered page; their own row keeps its link", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const peerRequest = await insertRequest(tx, w.citizen);
      const ownRequest = await insertRequest(tx, w.citizen2);
      // A funcionario opens a citizen's application; the citizen withdraws
      // it; the appointee opens another one.
      const decided = await writeAudit(tx, {
        actor: w.mzaPlain,
        action: "request_viewed",
        approvalRequest: peerRequest.id,
      });
      const withdrawn = await writeAudit(tx, {
        actor: w.citizen,
        action: "approval_request_withdrawn_by_applicant",
        approvalRequest: peerRequest.id,
        payload: { province: "Mendoza" },
      });
      const own = await writeAudit(tx, {
        actor: w.mza,
        action: "request_viewed",
        approvalRequest: ownRequest.id,
      });
      for (const row of [decided, withdrawn, own]) expect(row.province_code).toBe("AR-M");

      // 1. The trail (0272).
      const trail = await asUser<{ id: string; approval_request_id: string | null }>(
        tx,
        w.mza,
        sql`select id::text as id, approval_request_id::text as approval_request_id
              from public.jurisdiction_admin_audit_trail(null, null, 500)`,
      );
      const inTrail = new Map(trail.map((r) => [r.id, r.approval_request_id]));
      expect(inTrail.has(decided.id)).toBe(true);
      expect(inTrail.get(decided.id)).toBeNull();
      expect(inTrail.has(withdrawn.id)).toBe(true);
      expect(inTrail.get(withdrawn.id)).toBeNull();
      expect(inTrail.get(own.id)).toBe(ownRequest.id);
      expect(JSON.stringify(trail)).not.toContain(peerRequest.id);

      // 2. The /gob/historial query.
      const scope: AuditHistoryScope = {
        kind: "govt",
        actorIds: await fetchJurisdictionActorIds([{ province: "Mendoza", locality: "" }]),
        viewerId: w.mza,
        provinceCode: "AR-M",
      };
      const history = new Map((await historyQuery(tx, scope)).map((r) => [r.id, r]));
      expect(history.get(decided.id)).toMatchObject({ approvalRequestId: null });
      expect(history.get(withdrawn.id)).toMatchObject({ approvalRequestId: null });
      expect(history.get(own.id)?.approvalRequestId).toBe(ownRequest.id);
      // The platform admin keeps the request.
      const full = new Map((await historyQuery(tx, { kind: "admin" })).map((r) => [r.id, r]));
      expect(full.get(decided.id)?.approvalRequestId).toBe(peerRequest.id);

      // 3. The rendered page.
      state.session = {
        user: { id: w.mza },
        profile: { id: w.mza, role: "govt" },
        jurisdictions: [{ province: "Mendoza", locality: "" }],
      };
      const element = await GobHistorialPage({
        searchParams: Promise.resolve({ period: "custom", from: "2000-01-01", to: "2099-12-31" }),
      });
      const html = renderToStaticMarkup(element as React.ReactElement);
      expect(html).toContain(`/gob/cola/${ownRequest.token}`);
      expect(html).not.toContain(peerRequest.token);
      expect(html).not.toContain(peerRequest.id.slice(0, 8));
    });
  });
});

describe("LOW-3 — ?actor= names only a funcionario (or the viewer)", () => {
  it("a citizen's id in the URL never comes back as a name to a govt viewer; the platform admin is unchanged", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const appointee: AuditHistoryScope = {
        kind: "govt",
        actorIds: [w.mzaPlain],
        viewerId: w.mza,
        provinceCode: "AR-M",
      };
      const plain: AuditHistoryScope = { kind: "govt", actorIds: [w.mzaPlain], viewerId: w.sj };
      const names = async (scope: AuditHistoryScope, actor: string) =>
        (await resolveAuditHistoryActorOptions(scope, [], new Map(), actor)).map((o) => o.name);

      for (const scope of [appointee, plain]) {
        expect(await names(scope, w.citizen)).toEqual(["JA5 probe Mendoza funcionario"]);
      }
      // A funcionario outside the peer list, and the viewer themself: named.
      expect(await names(appointee, w.sj)).toContain("JA5 probe San Juan funcionario");
      expect(await names(appointee, w.mza)).toContain("JA5 probe Mendoza appointee");
      // Universal scope keeps resolving any id (the platform admin).
      expect(await names({ kind: "admin" }, w.citizen)).toEqual(["JA5 probe citizen Ana"]);
    });
  });
});

// ---------------------------------------------------------------------------
// 5.5 / 5.6 — visibility by the place of the act
// ---------------------------------------------------------------------------

describe("the audit history by place (tasks 5.5, 5.6)", () => {
  it("a funcionario's act stays visible after their transfer out; a foreign row never is", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const leaver = await insertProfile(tx, "govt", "JA5 probe transferred funcionario");
      const leaverGrant = await insertGrant(tx, leaver, "Mendoza", "Maipú", w.admin);
      const act = await writeAudit(tx, { actor: leaver, action: "evidence_viewed" });
      expect(act.province_code).toBe("AR-M");
      const foreign = await writeAudit(tx, { actor: w.sj, action: "evidence_viewed" });
      expect(foreign.province_code).toBe("AR-J");

      // Transferred to San Juan.
      await tx.execute(sql`update public.govt_assignments
                              set revoked_at = now(), revoked_by_user_id = ${w.admin}::uuid,
                                  revocation_reason = 'Traslado'
                            where id = ${leaverGrant}::uuid`);
      await insertGrant(tx, leaver, "San Juan", "Rivadavia", w.admin);

      const peers = await fetchJurisdictionActorIds([{ province: "Mendoza", locality: "" }]);
      expect(peers).not.toContain(leaver);
      const place = (
        await historyQuery(tx, {
          kind: "govt",
          actorIds: peers,
          viewerId: w.mza,
          provinceCode: "AR-M",
        })
      ).map((r) => r.id);
      expect(place).toContain(act.id);
      expect(place).not.toContain(foreign.id);
      // The peer rule alone would have lost it: the place is what keeps it.
      const peersOnly = (
        await historyQuery(tx, { kind: "govt", actorIds: peers, viewerId: w.mza })
      ).map((r) => r.id);
      expect(peersOnly).not.toContain(act.id);

      const trail = (await trailOf(tx, w.mza)).map((r) => r.id);
      expect(trail).toContain(act.id);
      expect(trail).not.toContain(foreign.id);
    });
  });

  it("a row written before the stamp is read from the place it names; an unplaced row stays hidden", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      // The rule the row names does not exist yet when the row is written, so
      // nothing stamps it — exactly an unstamped historic row.
      const ruleId = randomUUID();
      const historic = await writeAudit(tx, {
        actor: w.admin,
        action: "govt_business_rule_updated",
        payload: { ruleId },
      });
      expect(historic.province_code).toBeNull();
      await tx.execute(sql`
        insert into public.govt_business_rules
          (id, jurisdiction_province, jurisdiction_locality, rule_type, rule_payload,
           created_by_user_id, updated_by_user_id)
        values (${ruleId}::uuid, 'Mendoza', ${`JA5 probe ${ruleId}`}, 'ppp_breed_list',
                '{"breeds":["Probe"]}'::jsonb, ${w.admin}::uuid, ${w.admin}::uuid)`);
      const unplaced = await writeAudit(tx, { actor: w.admin, action: "pii_queried" });
      expect(unplaced.province_code).toBeNull();

      const scope: AuditHistoryScope = {
        kind: "govt",
        actorIds: [],
        viewerId: w.mza,
        provinceCode: "AR-M",
      };
      const place = (await historyQuery(tx, scope)).map((r) => r.id);
      expect(place).toContain(historic.id);
      expect(place).not.toContain(unplaced.id);
      const trail = (await trailOf(tx, w.mza)).map((r) => r.id);
      expect(trail).toContain(historic.id);
      expect(trail).not.toContain(unplaced.id);
    });
  });
});
