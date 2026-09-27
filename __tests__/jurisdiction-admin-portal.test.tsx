// jurisdiction-admin, Phase 6 — the jurisdiction admin's portal and the
// widened action guards.
//
// Phase 6 opened two doors: /gob/administracion (funcionarios and authority
// units of ONE province) and requireAdministrationPrincipalOrRedirect on the
// admin-institutional and authority-units actions a jurisdiction admin shares
// with the platform admin. This file proves both doors admit exactly who they
// should, through the REAL guard (session and profile read from the database,
// authority from the database twin):
//
//   - a plain govt and a revoked appointee are sent home from every page of
//     /gob/administracion and from every newly widened action;
//   - a live appointee reaches no platform-only action — the widened guard
//     sits only on the delegated ones (the inventory of which action carries
//     which guard is pinned by scripts/check-admin-authority.ts, rule 4);
//   - through a widened action, the appointee still cannot act outside their
//     province or create a platform role (the writers' own refusal);
//   - the platform admin's new reversals work, and are theirs alone.
//
// NO RESIDUE. Every case runs inside ONE transaction that is always rolled
// back; `db` follows it (the proxy below), so the guard, the pages and the
// actions all read and write the rolled-back fixtures.

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RealDb = typeof import("@/db")["db"];
type Tx = Parameters<Parameters<RealDb["transaction"]>[0]>[0];

const state = vi.hoisted(() => ({
  realDb: null as unknown,
  tx: null as unknown,
  userId: null as string | null,
}));

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

// WHO is signed in: the one thing faked. Everything the guard decides after
// that (profile, role, deactivation, appointment) is read from the database.
vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      state.userId
        ? { ok: true, supabase: {}, user: { id: state.userId, email: "probe@dim.test" } }
        : { ok: false, reason: "NO_SESSION" },
  };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/gob/administracion",
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/ui/portal-base", () => ({ portalBase: async () => "/gob" }));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import * as institutionalActions from "@/app/actions/admin-institutional";
import * as reversalActions from "@/app/actions/authority-unit-reversals";
import * as unitActions from "@/app/actions/authority-units";
import * as appointmentActions from "@/app/actions/jurisdiction-admin";
import FuncionarioPage from "@/app/gob/administracion/funcionarios/[userId]/page";
import NuevoFuncionarioPage from "@/app/gob/administracion/funcionarios/nuevo/page";
import FuncionariosPage from "@/app/gob/administracion/funcionarios/page";
import AdministracionPage from "@/app/gob/administracion/page";
import UnidadPage from "@/app/gob/administracion/unidades/[unitId]/page";
import UnidadesPage from "@/app/gob/administracion/unidades/page";
import EditRulePage from "@/app/gob/reglas/[country]/[province]/[locality]/editar/[ruleId]/page";
import NewRulePage from "@/app/gob/reglas/[country]/[province]/[locality]/nueva/page";
import JurisdictionReglasPage from "@/app/gob/reglas/[country]/[province]/[locality]/page";
import { authorityUnits, govtAssignments, profiles } from "@/db";
import { requireAdministrationPrincipalOrRedirect } from "@/lib/infra/auth-guards";
import { JURISDICTION_ADMIN_WRITER_COPY } from "@/lib/ui/jurisdiction-admin-copy";
import { appointJurisdictionAdmin } from "@/src/modules/organizations/application/admin-authority/appoint";
import { revokeJurisdictionAdmin } from "@/src/modules/organizations/application/admin-authority/revoke";
import {
  confirmAuthorityUnit,
  createAuthorityUnit,
  moveLocalityToUnit,
} from "@/src/modules/organizations/application/authority-units/manage-units";
import { createBusinessRuleWriter } from "@/src/modules/organizations/application/business-rules/create-business-rule";

const ROLLBACK = new Error("jurisdiction-admin-portal: rollback");
const REASON = "Designación de prueba por resolución ministerial";
const WHY = "Cambio de prueba del administrador de la plataforma";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  const realDb = state.realDb as RealDb;
  try {
    await realDb.transaction(async (tx) => {
      state.tx = tx;
      try {
        await body(tx);
      } finally {
        state.tx = null;
        state.userId = null;
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

function signedInAs(userId: string): void {
  state.userId = userId;
}

async function insertProfile(tx: Tx, role: "admin" | "govt", name: string): Promise<string> {
  const id = randomUUID();
  await tx.insert(profiles).values({ id, displayName: name, role, accountType: "institutional" });
  return id;
}

async function insertGrant(
  tx: Tx,
  userId: string,
  province: string,
  locality: string,
  grantedBy: string,
): Promise<void> {
  await tx.insert(govtAssignments).values({
    userId,
    jurisdictionProvince: province,
    jurisdictionLocality: locality,
    grantedByUserId: grantedBy,
  });
}

function ok<T>(r: T): Extract<T, { ok: true }> {
  expect(r).toMatchObject({ ok: true });
  return r as Extract<T, { ok: true }>;
}

type World = {
  admin: string;
  /** Live jurisdiction admin of Córdoba (AR-X). */
  cba: string;
  /** Appointed to Santa Fe, then revoked: a plain govt again. */
  revoked: string;
  /** Plain Córdoba funcionario — no appointment. */
  cbaGovt: string;
  /** Plain Santa Fe funcionario. */
  sfeGovt: string;
  cbaUnit: string;
  sfeUnit: string;
};

async function world(tx: Tx): Promise<World> {
  const admin = await insertProfile(tx, "admin", "JA6 probe platform admin");
  const cba = await insertProfile(tx, "govt", "JA6 probe Córdoba admin");
  const revoked = await insertProfile(tx, "govt", "JA6 probe revoked admin");
  const cbaGovt = await insertProfile(tx, "govt", "JA6 probe Córdoba govt");
  const sfeGovt = await insertProfile(tx, "govt", "JA6 probe Santa Fe govt");
  await insertGrant(tx, cba, "Córdoba", "", admin);
  await insertGrant(tx, revoked, "Santa Fe", "", admin);
  await insertGrant(tx, cbaGovt, "Córdoba", "JA6 probe localidad Córdoba", admin);
  await insertGrant(tx, sfeGovt, "Santa Fe", "JA6 probe localidad Santa Fe", admin);

  ok(
    await appointJurisdictionAdmin(tx, admin, {
      userId: cba,
      provinceCode: "AR-X",
      reason: REASON,
    }),
  );
  const gone = ok(
    await appointJurisdictionAdmin(tx, admin, {
      userId: revoked,
      provinceCode: "AR-S",
      reason: REASON,
    }),
  );
  ok(
    await revokeJurisdictionAdmin(tx, admin, { appointmentId: gone.appointmentId, reason: REASON }),
  );

  const unit = async (code: string, name: string) => {
    const r = ok(
      await createAuthorityUnit(tx, admin, { kind: "municipio", provinceCode: code, name }),
    );
    ok(await confirmAuthorityUnit(tx, admin, { unitId: r.unitId }));
    return r.unitId;
  };
  return {
    admin,
    cba,
    revoked,
    cbaGovt,
    sfeGovt,
    cbaUnit: await unit("AR-X", "JA6 probe unidad Córdoba"),
    sfeUnit: await unit("AR-S", "JA6 probe unidad Santa Fe"),
  };
}

/** Every page of the portal, with params that would render for its province. */
function portalPages(w: World): Array<[string, () => Promise<unknown>]> {
  return [
    ["/gob/administracion", () => AdministracionPage()],
    ["/gob/administracion/funcionarios", () => FuncionariosPage()],
    ["/gob/administracion/funcionarios/nuevo", () => NuevoFuncionarioPage()],
    [
      "/gob/administracion/funcionarios/[userId]",
      () => FuncionarioPage({ params: Promise.resolve({ userId: w.cbaGovt }) }),
    ],
    ["/gob/administracion/unidades", () => UnidadesPage()],
    [
      "/gob/administracion/unidades/[unitId]",
      () => UnidadPage({ params: Promise.resolve({ unitId: w.cbaUnit }) }),
    ],
  ];
}

/** Every action Phase 6 widened, called with an input it would accept in P. */
function widenedActions(w: World): Array<[string, () => Promise<unknown>]> {
  return [
    [
      "createInstitutionalAccountAction",
      () =>
        institutionalActions.createInstitutionalAccountAction({
          role: "govt",
          email: `ja6-${randomUUID()}@dim.test`,
          displayName: "JA6 probe nuevo",
          initialLocalities: [],
        }),
    ],
    [
      "deactivateGovtAction",
      () =>
        institutionalActions.deactivateGovtAction({
          targetGovtUserId: w.cbaGovt,
          motivo: WHY,
          attachmentIds: [],
        }),
    ],
    [
      "assignGovtLocalityAction",
      () =>
        institutionalActions.assignGovtLocalityAction({
          targetUserId: w.cbaGovt,
          province: "Córdoba",
          locality: "",
        }),
    ],
    [
      "moveLocalityToUnitAction",
      () =>
        unitActions.moveLocalityToUnitAction({
          localityId: randomUUID(),
          toUnitId: w.cbaUnit,
          reason: WHY,
        }),
    ],
    [
      "removeLocalityFromUnitAction",
      () =>
        unitActions.removeLocalityFromUnitAction({
          localityId: randomUUID(),
          unitId: w.cbaUnit,
          reason: WHY,
        }),
    ],
    [
      "createAuthorityUnitAction",
      () =>
        unitActions.createAuthorityUnitAction({
          kind: "municipio",
          provinceCode: "AR-X",
          name: "JA6 probe otra unidad",
        }),
    ],
    [
      "renameAuthorityUnitAction",
      () => unitActions.renameAuthorityUnitAction({ unitId: w.cbaUnit, name: "JA6 renombrada" }),
    ],
    [
      "confirmAuthorityUnitAction",
      () => unitActions.confirmAuthorityUnitAction({ unitId: w.cbaUnit }),
    ],
    [
      "confirmGrantUnitAction",
      () =>
        unitActions.confirmGrantUnitAction({
          userId: w.cbaGovt,
          unitId: w.cbaUnit,
          reason: WHY,
          acceptAdded: [],
        }),
    ],
  ];
}

/** Every platform-only action a jurisdiction admin must never reach. */
function platformOnlyActions(w: World): Array<[string, () => Promise<unknown>]> {
  return [
    [
      "deactivateAdminAction",
      () =>
        institutionalActions.deactivateAdminAction({
          targetAdminUserId: w.admin,
          motivo: WHY,
          attachmentIds: [],
        }),
    ],
    [
      "resetInstitutionalCredentialsAction",
      () =>
        institutionalActions.resetInstitutionalCredentialsAction({
          targetUserId: w.cbaGovt,
          reason: WHY,
        }),
    ],
    [
      "resetMfaFactorsAction",
      () => institutionalActions.resetMfaFactorsAction({ targetUserId: w.cbaGovt, reason: WHY }),
    ],
    [
      "closeRemovedLocalityMembershipAction",
      () =>
        unitActions.closeRemovedLocalityMembershipAction({
          localityId: randomUUID(),
          unitId: w.cbaUnit,
          reason: WHY,
        }),
    ],
    [
      "resolvePlaceFromQueueAction",
      () =>
        unitActions.resolvePlaceFromQueueAction({
          subjectTable: "cases",
          subjectId: randomUUID(),
          localityId: randomUUID(),
          reason: WHY,
        }),
    ],
    [
      "unconfirmAuthorityUnitAction",
      () => reversalActions.unconfirmAuthorityUnitAction({ unitId: w.cbaUnit, reason: WHY }),
    ],
    [
      "unconfirmGrantUnitAction",
      () =>
        reversalActions.unconfirmGrantUnitAction({
          userId: w.cbaGovt,
          unitId: w.cbaUnit,
          reason: WHY,
        }),
    ],
    [
      "appointJurisdictionAdminAction",
      () =>
        appointmentActions.appointJurisdictionAdminAction({
          userId: w.cbaGovt,
          provinceCode: "AR-X",
          reason: REASON,
        }),
    ],
    [
      "revokeJurisdictionAdminAction",
      () =>
        appointmentActions.revokeJurisdictionAdminAction({
          appointmentId: randomUUID(),
          reason: REASON,
        }),
    ],
  ];
}

describe("requireAdministrationPrincipalOrRedirect — who is admitted", () => {
  it("admits the platform admin and a live appointee, with the authority each holds", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      signedInAs(w.admin);
      expect((await requireAdministrationPrincipalOrRedirect()).authority).toEqual({
        kind: "platform",
      });
      signedInAs(w.cba);
      expect((await requireAdministrationPrincipalOrRedirect()).authority).toEqual({
        kind: "jurisdiction",
        provinceCode: "AR-X",
      });
    });
  });

  it("sends a plain govt and a revoked appointee home", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      for (const who of [w.cbaGovt, w.revoked]) {
        signedInAs(who);
        await expect(requireAdministrationPrincipalOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
      }
    });
  });

  it("sends an appointee home the moment their account is deactivated", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await tx.update(profiles).set({ deactivatedAt: sql`now()` }).where(eq(profiles.id, w.cba));
      signedInAs(w.cba);
      await expect(requireAdministrationPrincipalOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
    });
  });
});

describe("/gob/administracion — only a live appointee gets in", () => {
  it("a plain govt and a revoked appointee are sent home from every page", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      for (const who of [w.cbaGovt, w.revoked]) {
        signedInAs(who);
        for (const [route, render] of portalPages(w)) {
          await expect(render(), `${route} as ${who}`).rejects.toThrow(/^NEXT_REDIRECT:\/$/);
        }
      }
    });
  });

  it("the platform admin is sent to /admin, where every province is theirs", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      signedInAs(w.admin);
      for (const [route, render] of portalPages(w)) {
        await expect(render(), route).rejects.toThrow("NEXT_REDIRECT:/admin");
      }
    });
  });

  it("the appointee sees their province, its funcionarios and its units — and nothing of another", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      signedInAs(w.cba);

      const home = renderToStaticMarkup((await AdministracionPage()) as React.ReactElement);
      expect(home).toContain("Administración de Córdoba");
      expect(home).toContain("Solo podés actuar dentro de");

      const list = renderToStaticMarkup((await FuncionariosPage()) as React.ReactElement);
      expect(list).toContain("JA6 probe Córdoba govt");
      expect(list).toContain(`/gob/administracion/funcionarios/${w.cbaGovt}`);
      expect(list).not.toContain("JA6 probe Santa Fe govt");
      // The appointee is listed as themself, with no link to act on it.
      expect(list).toContain("Tu cuenta");
      expect(list).not.toContain(`/gob/administracion/funcionarios/${w.cba}"`);

      const units = renderToStaticMarkup((await UnidadesPage()) as React.ReactElement);
      expect(units).toContain("JA6 probe unidad Córdoba");
      expect(units).not.toContain("JA6 probe unidad Santa Fe");

      // A change the platform admin made, with its reason: the appointee reads
      // who and when in the unit's change log, never the reason (operator
      // prose written by someone else).
      const [loc] = (await tx.execute(sql`
        select id::text as id from public.ar_localities
         where province_code = 'AR-X' and removed_at is null order by id limit 1`)) as unknown as Array<{
        id: string;
      }>;
      ok(
        await moveLocalityToUnit(tx, w.admin, {
          localityId: loc.id,
          toUnitId: w.cbaUnit,
          reason: "JA6 motivo reservado de la plataforma",
        }),
      );
      const unit = renderToStaticMarkup(
        (await UnidadPage({
          params: Promise.resolve({ unitId: w.cbaUnit }),
        })) as React.ReactElement,
      );
      expect(unit).toContain("JA6 probe unidad Córdoba");
      expect(unit).toContain("Localidad sumada");
      expect(unit).not.toContain("JA6 motivo reservado de la plataforma");
      // The platform's reversals are not on the appointee's page.
      expect(unit).not.toContain("Volver a borrador");
      expect(unit).not.toContain("Sacar de la unidad");
    });
  });

  it("a funcionario or unit of another province answers 404, like one that does not exist", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      signedInAs(w.cba);
      for (const userId of [w.sfeGovt, w.revoked, randomUUID()]) {
        await expect(FuncionarioPage({ params: Promise.resolve({ userId }) })).rejects.toThrow(
          "NEXT_NOT_FOUND",
        );
      }
      for (const unitId of [w.sfeUnit, randomUUID()]) {
        await expect(UnidadPage({ params: Promise.resolve({ unitId }) })).rejects.toThrow(
          "NEXT_NOT_FOUND",
        );
      }
    });
  });

  it("the appointee's own page offers no act on themself", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      signedInAs(w.cba);
      const own = renderToStaticMarkup(
        (await FuncionarioPage({
          params: Promise.resolve({ userId: w.cba }),
        })) as React.ReactElement,
      );
      expect(own).toContain("Es tu propia cuenta");
      expect(own).not.toContain("Desactivar la cuenta");
      expect(own).not.toContain("Asignar nueva localidad");

      const other = renderToStaticMarkup(
        (await FuncionarioPage({
          params: Promise.resolve({ userId: w.cbaGovt }),
        })) as React.ReactElement,
      );
      expect(other).toContain("Desactivar la cuenta");
      expect(other).toContain("Asignar nueva localidad");
    });
  });
});

describe("the widened actions — the guard admits only the administration principal", () => {
  it("a plain govt and a revoked appointee are sent home from every widened action", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      for (const who of [w.cbaGovt, w.revoked]) {
        signedInAs(who);
        for (const [name, call] of widenedActions(w)) {
          await expect(call(), `${name} as ${who}`).rejects.toThrow(/^NEXT_REDIRECT:\/$/);
        }
      }
      // Nothing any of them tried was written.
      const [row] = await tx
        .select({ name: authorityUnits.name })
        .from(authorityUnits)
        .where(eq(authorityUnits.id, w.cbaUnit));
      expect(row.name).toBe("JA6 probe unidad Córdoba");
    });
  });

  it("a live appointee reaches no platform-only action", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      signedInAs(w.cba);
      for (const [name, call] of platformOnlyActions(w)) {
        await expect(call(), name).rejects.toThrow(/^NEXT_REDIRECT:\/$/);
      }
      const [unit] = await tx
        .select({ status: authorityUnits.status })
        .from(authorityUnits)
        .where(eq(authorityUnits.id, w.cbaUnit));
      expect(unit.status).toBe("confirmed");
    });
  });

  it("through a widened action the appointee still acts only inside their province", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      signedInAs(w.cba);

      ok(await unitActions.renameAuthorityUnitAction({ unitId: w.cbaUnit, name: "JA6 nueva" }));
      expect(
        await unitActions.renameAuthorityUnitAction({ unitId: w.sfeUnit, name: "JA6 ajena" }),
      ).toEqual({ error: "OUT_OF_PROVINCE" });
      expect(
        await unitActions.createAuthorityUnitAction({
          kind: "municipio",
          provinceCode: "AR-S",
          name: "JA6 probe ajena",
        }),
      ).toEqual({ error: "OUT_OF_PROVINCE" });

      for (const role of ["admin", "national"] as const) {
        const email = `ja6-${randomUUID()}@dim.test`;
        expect(
          await institutionalActions.createInstitutionalAccountAction({
            role,
            email,
            displayName: "JA6 probe escalada",
            initialLocalities: [],
          }),
        ).toEqual({ error: JURISDICTION_ADMIN_WRITER_COPY.CREATE_PLATFORM_ROLE });
      }
      const escalated = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.displayName, "JA6 probe escalada"));
      expect(escalated).toEqual([]);
    });
  });

  it("the platform admin's reversals work through their actions (6.4)", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      signedInAs(w.admin);
      ok(await reversalActions.unconfirmAuthorityUnitAction({ unitId: w.cbaUnit, reason: WHY }));
      const [unit] = await tx
        .select({ status: authorityUnits.status })
        .from(authorityUnits)
        .where(eq(authorityUnits.id, w.cbaUnit));
      expect(unit.status).toBe("draft");
      expect(
        await reversalActions.unconfirmGrantUnitAction({
          userId: w.cbaGovt,
          unitId: w.cbaUnit,
          reason: WHY,
        }),
      ).toEqual({ error: "NOT_ON_UNIT" });
    });
  });
});

/** A province-wide rule the platform admin placed in `province`. */
async function provinceRule(tx: Tx, admin: string, province: string): Promise<string> {
  const created = await createBusinessRuleWriter(
    {
      actorUserId: admin,
      ruleType: "due_soon_window",
      jurisdictionCountry: "AR",
      jurisdictionProvince: province,
      jurisdictionLocality: null,
      rulePayload: { days: 21 },
      notes: null,
      legalAnchorIds: [],
    },
    tx,
  );
  expect(created).toMatchObject({ ok: true, ruleId: expect.any(String) });
  return (created as { ruleId: string }).ruleId;
}

function placeParams(province: string) {
  return Promise.resolve({ country: "AR", province: encodeURIComponent(province), locality: "_" });
}

describe("/gob/reglas editor pages — a jurisdiction admin opens only their province", () => {
  it("a place or a rule of another province, or the whole country, answers 404", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const sfeRule = await provinceRule(tx, w.admin, "Santa Fe");
      signedInAs(w.cba);
      const attempts: Array<[string, () => Promise<unknown>]> = [
        ["list Santa Fe", () => JurisdictionReglasPage({ params: placeParams("Santa Fe") })],
        ["list country", () => JurisdictionReglasPage({ params: placeParams("_") })],
        [
          "new Santa Fe",
          () =>
            NewRulePage({
              params: placeParams("Santa Fe"),
              searchParams: Promise.resolve({ ruleType: "due_soon_window" }),
            }),
        ],
        [
          "edit Santa Fe rule",
          () =>
            EditRulePage({
              params: Promise.resolve({
                country: "AR",
                province: encodeURIComponent("Santa Fe"),
                locality: "_",
                ruleId: sfeRule,
              }),
            }),
        ],
      ];
      for (const [name, open] of attempts) {
        await expect(open(), name).rejects.toThrow("NEXT_NOT_FOUND");
      }
    });
  });

  it("their own province's place and rule open", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const cbaRule = await provinceRule(tx, w.admin, "Córdoba");
      signedInAs(w.cba);
      const list = renderToStaticMarkup(
        (await JurisdictionReglasPage({ params: placeParams("Córdoba") })) as React.ReactElement,
      );
      expect(list).toContain("Reglas para");
      expect(list).toContain(`/editar/${cbaRule}`);
      const edit = renderToStaticMarkup(
        (await EditRulePage({
          params: Promise.resolve({
            country: "AR",
            province: encodeURIComponent("Córdoba"),
            locality: "_",
            ruleId: cbaRule,
          }),
        })) as React.ReactElement,
      );
      expect(edit).toContain("Editar regla");
    });
  });

  it("a plain govt and a revoked appointee are sent home; the platform admin opens any place", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      for (const who of [w.cbaGovt, w.revoked]) {
        signedInAs(who);
        await expect(JurisdictionReglasPage({ params: placeParams("Córdoba") })).rejects.toThrow(
          /^NEXT_REDIRECT:\/$/,
        );
      }
      signedInAs(w.admin);
      const html = renderToStaticMarkup(
        (await JurisdictionReglasPage({ params: placeParams("Santa Fe") })) as React.ReactElement,
      );
      expect(html).toContain("Reglas para");
    });
  });
});
