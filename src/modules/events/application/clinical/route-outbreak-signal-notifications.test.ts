// Unit tests for routeOutbreakSignalNotifications — WHERE an outbreak signal's
// authority notice goes (PO S10, 2026-09-26) and what it says about its origin.

import { beforeEach, describe, expect, it, vi } from "vitest";

const findAuthorities = vi.fn();
vi.mock("@/lib/infra/approval-routing", () => ({
  findAuthoritiesForJurisdiction: (...args: unknown[]) => findAuthorities(...args),
}));

import type { NewNotification } from "../types";
import { routeOutbreakSignalNotifications } from "./route-outbreak-signal-notifications";

const ALBERTI = "11111111-1111-4111-8111-111111111111";
const HOME = "22222222-2222-4222-8222-222222222222";

/** A tx whose locality lookup answers `localityRows` and profile read `profileRows`. */
function makeTx(localityRows: unknown[], profileRows: unknown[]) {
  const where = vi.fn(() =>
    Object.assign(Promise.resolve(profileRows), {
      limit: vi.fn(() => Promise.resolve(localityRows)),
    }),
  );
  return { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) };
}

const PET = {
  id: "pet-1",
  publicToken: "DIM-TEST-0001",
  jurisdictionCountry: "AR",
  jurisdictionProvince: "Córdoba",
  jurisdictionLocality: "Río Cuarto",
  species: "dog",
  localityId: HOME,
};

function signal(payload: Record<string, unknown>) {
  return { id: "sig-1", payload } as never;
}

const DISEASE = {
  disease_code: "leptospirosis",
  disease_label: "Leptospirosis",
  high_count: 1,
  medium_count: 0,
};

beforeEach(() => {
  findAuthorities.mockReset();
  findAuthorities.mockResolvedValue(["gov-1"]);
});

describe("routeOutbreakSignalNotifications — where (S10)", () => {
  it("a signal with a resolved place goes to that place, not the pet's home", async () => {
    const tx = makeTx([{ localityName: "Mechita" }], [{ id: "gov-1", role: "govt" }]);
    const pending: NewNotification[] = [];
    await routeOutbreakSignalNotifications(
      tx as never,
      {
        signalEvent: signal({
          triggered_by: "direct_diagnosis",
          place: {
            entered: { province: "Buenos Aires", locality: "Mechita", indec_id: null },
            resolved: { locality_id: ALBERTI, province_code: "AR-B", method: "catalogue_id" },
          },
        }),
        pet: PET,
        disease: DISEASE,
      },
      pending,
    );
    expect(findAuthorities).toHaveBeenCalledWith({
      province: "Buenos Aires",
      locality: "Mechita",
      localityId: ALBERTI,
    });
    expect(pending[0]?.title).toContain("Mechita");
  });

  it("an unresolved place is a province-level notice, never the home", async () => {
    const tx = makeTx([], [{ id: "gov-1", role: "govt" }]);
    await routeOutbreakSignalNotifications(
      tx as never,
      {
        signalEvent: signal({
          triggered_by: "matcher",
          place: {
            entered: { province: "Santa Fe", locality: "?", indec_id: null },
            resolved: null,
          },
        }),
        pet: PET,
        disease: DISEASE,
      },
      [],
    );
    expect(findAuthorities).toHaveBeenCalledWith({
      province: "Santa Fe",
      locality: "",
      localityId: null,
    });
  });

  it("with no place, the pet's home is the fallback", async () => {
    const tx = makeTx([], [{ id: "gov-1", role: "govt" }]);
    await routeOutbreakSignalNotifications(
      tx as never,
      { signalEvent: signal({ triggered_by: "matcher" }), pet: PET, disease: DISEASE },
      [],
    );
    expect(findAuthorities).toHaveBeenCalledWith({
      province: "Córdoba",
      locality: "Río Cuarto",
      localityId: HOME,
    });
  });
});

describe("routeOutbreakSignalNotifications — what it says about the origin", () => {
  it("a diagnosis-derived signal says a vet diagnosed it, not that an owner self-reported", async () => {
    const tx = makeTx([], [{ id: "gov-1", role: "govt" }]);
    const pending: NewNotification[] = [];
    await routeOutbreakSignalNotifications(
      tx as never,
      { signalEvent: signal({ triggered_by: "direct_diagnosis" }), pet: PET, disease: DISEASE },
      pending,
    );
    expect(pending[0]?.body).toContain("Diagnóstico registrado por un veterinario");
    expect(pending[0]?.body).not.toContain("dueño");
    expect(pending[0]?.body).not.toContain("No es diagnóstico");
  });

  it("a welfare-report signal says it came from a denuncia", async () => {
    const tx = makeTx([], [{ id: "gov-1", role: "govt" }]);
    const pending: NewNotification[] = [];
    await routeOutbreakSignalNotifications(
      tx as never,
      {
        signalEvent: signal({ triggered_by: "matcher" }),
        pet: PET,
        disease: DISEASE,
        origin: "witness",
      },
      pending,
    );
    expect(pending[0]?.body).toContain("denuncia de bienestar animal");
    expect(pending[0]?.body).toContain("No es diagnóstico");
  });
});
