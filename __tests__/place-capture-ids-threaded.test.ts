// The catalogue id a picker resolved reaches the location gate — web forms that
// hardcoded `localityIndecId: null`.
//
// localidades-por-id A7 (R5 of the 2026-09-25 localities audit). The vet
// upgrade form and the org / clinic creation forms use the cascade picker
// (LocationFields l1), which posts the INDEC id of the row the person picked as
// `localityNameIndecId`; the admin "proponer vet" form had no picker at all.
// Every one of their writers then called the strict gate with
// `localityIndecId: null`, so for a name two localities share (Mechita, in
// partido Alberti and in partido Bragado) the gate had nothing to decide with:
// before A9 it filed the alphabetically first one, since A9 it refuses the
// name outright — a vet from Bragado's Mechita could not be registered at all.
//
// Each door is driven from its server action, through its REAL writer, to a
// gate that records what it was handed and then stops the write — so the
// assertion is exactly "the id the form posted is the id the gate saw", with no
// database row created.

import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/domain/location-normalize", () => {
  class JurisdictionValidationError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    JurisdictionValidationError,
    CoordError: class CoordError extends Error {},
    normalizeLocationForWrite: async (loc: Record<string, unknown>) => {
      gate.calls.push(loc);
      throw new JurisdictionValidationError("INVALID_LOCALITY", "STOP_AFTER_GATE");
    },
  };
});

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () => ({
      ok: true,
      supabase: {},
      user: { id: "user-1" },
      profile: null,
    }),
  };
});

vi.mock("@/lib/infra/auth-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/auth-guards")>();
  return {
    ...actual,
    requireAdminOrGovtOrRedirect: async () => ({ user: { id: "admin-1" } }),
  };
});

vi.mock("@/src/modules/organizations/application/admin-proposals/helpers", async (orig) => {
  const actual =
    await orig<typeof import("@/src/modules/organizations/application/admin-proposals/helpers")>();
  return {
    ...actual,
    loadActorAuthority: async () => ({
      profile: { id: "admin-1", role: "admin" as const },
      jurisdictions: [],
    }),
  };
});

// Org creation reads the creator's profile and memberships, and mints two
// tokens, BEFORE it reaches the gate.
vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  const rows = [{ dniVerified: true, matriculaVerified: false }];
  const chain = { from: () => chain, where: () => chain, limit: async () => rows };
  return { ...schema, db: { select: () => chain } };
});
vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", async (orig) => {
  const actual =
    await orig<typeof import("@/src/modules/organizations/infrastructure/authz-resolver")>();
  return { ...actual, getActiveMemberships: async () => [] };
});
vi.mock("@/lib/infra/unique-token", () => ({ generateUniqueToken: async () => "TOKEN" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

import { proposeVetUpgradeAction } from "@/app/actions/admin-proposals";
import {
  createClinicAction,
  createOrganizationAction,
  requestVetUpgradeAction,
} from "@/app/actions/upgrade";

const MECHITA_BRAGADO = "06112080";

/** What LocationFields (l1, cascade) posts for a picked catalogue row. */
function pickedMechita(fd: FormData): FormData {
  fd.set("provinceCode", "AR-B");
  fd.set("provinceName", "Buenos Aires");
  fd.set("localityName", "Mechita");
  fd.set("localityNameIndecId", MECHITA_BRAGADO);
  return fd;
}

function orgForm(): FormData {
  const fd = new FormData();
  fd.set("name", "Refugio Mechita");
  fd.set("legalName", "Refugio Mechita AC");
  fd.set("orgType", "shelter");
  fd.set("email", "refugio@mechita.test");
  return pickedMechita(fd);
}

function gateSaw(): Record<string, unknown> {
  expect(gate.calls).toHaveLength(1);
  return gate.calls[0];
}

beforeEach(() => {
  gate.calls = [];
});

describe("the picker's id reaches the gate", () => {
  it("vet upgrade (/cuenta/upgrade)", async () => {
    const fd = new FormData();
    fd.set("matriculaNumber", "MP-1234");
    fd.set("matriculaJurisdiccion", "Buenos Aires");
    const result = await requestVetUpgradeAction({ error: null }, pickedMechita(fd));
    expect(result.error).toBe("STOP_AFTER_GATE");
    expect(gateSaw()).toMatchObject({ locality: "Mechita", localityIndecId: MECHITA_BRAGADO });
  });

  it("organization creation (/cuenta/upgrade)", async () => {
    const result = await createOrganizationAction({ error: null }, orgForm());
    expect(result.error).toBe("STOP_AFTER_GATE");
    expect(gateSaw()).toMatchObject({ locality: "Mechita", localityIndecId: MECHITA_BRAGADO });
  });

  it("clinic creation (/cuenta/crear-consultorio)", async () => {
    const result = await createClinicAction({ error: null }, orgForm());
    expect(result.error).toBe("STOP_AFTER_GATE");
    expect(gateSaw()).toMatchObject({ locality: "Mechita", localityIndecId: MECHITA_BRAGADO });
  });

  it("admin / govt vet proposal (/gob/usuarios)", async () => {
    const result = await proposeVetUpgradeAction({
      targetUserId: "00000000-0000-4000-8000-0000000000aa",
      matriculaNumber: "MP-1234",
      matriculaJurisdiccion: "Buenos Aires",
      operationalProvince: "Buenos Aires",
      operationalLocality: "Mechita",
      operationalLocalityIndecId: MECHITA_BRAGADO,
    });
    expect(result).toEqual({ error: "STOP_AFTER_GATE" });
    expect(gateSaw()).toMatchObject({ locality: "Mechita", localityIndecId: MECHITA_BRAGADO });
  });

  it("a form that sent no id still reaches the gate by name, with no id invented", async () => {
    const fd = new FormData();
    fd.set("matriculaNumber", "MP-1234");
    fd.set("matriculaJurisdiccion", "Buenos Aires");
    fd.set("provinceCode", "AR-B");
    fd.set("localityName", "La Plata");
    await requestVetUpgradeAction({ error: null }, fd);
    expect(gateSaw()).toMatchObject({ locality: "La Plata", localityIndecId: null });
  });
});
