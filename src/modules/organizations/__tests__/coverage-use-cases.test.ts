// Unit tests for organizations coverage use-cases (WU-4, task 4.1):
//   - addCoverageZone
//   - removeCoverageZone
//   - setPrimaryCoverageZone
//
// Strategy: mock repo; test pure business logic only.
// Auth is NOT in use-cases — done at the action edge.
//
// TDD: tests written before use-case files exist (RED phase).

import { describe, expect, it, vi } from "vitest";

import { addCoverageZone } from "@/src/modules/organizations/application/add-coverage-zone";
import { removeCoverageZone } from "@/src/modules/organizations/application/remove-coverage-zone";
import { setPrimaryCoverageZone } from "@/src/modules/organizations/application/set-primary-coverage-zone";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeCoverage(overrides: Record<string, unknown> = {}) {
  return {
    id: "cov-1",
    organizationId: "org-1",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: null,
    isPrimary: false,
    createdAt: new Date("2024-01-01"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// addCoverageZone
// ---------------------------------------------------------------------------

describe("addCoverageZone", () => {
  function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      findDupCoverage: vi.fn().mockResolvedValue(null),
      insertCoverage: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  const listLocalitiesByProvince = vi
    .fn()
    .mockResolvedValue([{ name: "Tigre" }, { name: "Pilar" }]);

  const validProvinces = new Set(["Buenos Aires", "CABA", "Córdoba"]);

  it("inserts a province-level coverage (no locality)", async () => {
    const repo = makeRepo();
    const result = await addCoverageZone(
      {
        organizationId: "org-1",
        province: "Buenos Aires",
        locality: null,
        provinceCode: "AR-B",
      },
      { repo, listLocalitiesByProvince, validProvinces },
    );
    expect(result.ok).toBe(true);
    expect(repo.insertCoverage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        province: "Buenos Aires",
        locality: null,
      }),
    );
  });

  it("inserts a locality-level coverage", async () => {
    const repo = makeRepo();
    const result = await addCoverageZone(
      {
        organizationId: "org-1",
        province: "Buenos Aires",
        locality: "Tigre",
        provinceCode: "AR-B",
      },
      { repo, listLocalitiesByProvince, validProvinces },
    );
    expect(result.ok).toBe(true);
    expect(repo.insertCoverage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        province: "Buenos Aires",
        locality: "Tigre",
      }),
    );
  });

  it("returns error for invalid province", async () => {
    const repo = makeRepo();
    const result = await addCoverageZone(
      {
        organizationId: "org-1",
        province: "Atlantida",
        locality: null,
        provinceCode: "AR-Z",
      },
      { repo, listLocalitiesByProvince, validProvinces },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "La provincia indicada no es válida.",
    );
  });

  it("returns error when locality does not belong to province", async () => {
    const repo = makeRepo();
    const result = await addCoverageZone(
      {
        organizationId: "org-1",
        province: "Buenos Aires",
        locality: "Mendoza Capital",
        provinceCode: "AR-B",
      },
      { repo, listLocalitiesByProvince, validProvinces },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "La localidad indicada no pertenece a la provincia seleccionada.",
    );
  });

  it("returns error for duplicate coverage", async () => {
    const repo = makeRepo({ findDupCoverage: vi.fn().mockResolvedValue(makeCoverage()) });
    const result = await addCoverageZone(
      {
        organizationId: "org-1",
        province: "Buenos Aires",
        locality: null,
        provinceCode: "AR-B",
      },
      { repo, listLocalitiesByProvince, validProvinces },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "Esa zona ya está registrada para esta organización.",
    );
  });

  it("skips locality check when locality is null", async () => {
    const noLocalityList = vi.fn(); // should NOT be called
    const repo = makeRepo();
    await addCoverageZone(
      {
        organizationId: "org-1",
        province: "Buenos Aires",
        locality: null,
        provinceCode: "AR-B",
      },
      { repo, listLocalitiesByProvince: noLocalityList, validProvinces },
    );
    expect(noLocalityList).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// removeCoverageZone
// ---------------------------------------------------------------------------

describe("removeCoverageZone", () => {
  function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      deleteCoverageScoped: vi.fn().mockResolvedValue([{ id: "cov-1" }]),
      ...overrides,
    };
  }

  it("deletes and returns ok", async () => {
    const repo = makeRepo();
    const result = await removeCoverageZone(
      { organizationId: "org-1", coverageId: "cov-1" },
      { repo },
    );
    expect(result.ok).toBe(true);
    expect(repo.deleteCoverageScoped).toHaveBeenCalledWith("cov-1", "org-1");
  });

  it("returns error when zone not found (ownership OR nonexistent)", async () => {
    const repo = makeRepo({ deleteCoverageScoped: vi.fn().mockResolvedValue([]) });
    const result = await removeCoverageZone(
      { organizationId: "org-1", coverageId: "cov-missing" },
      { repo },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe("Zona no encontrada.");
  });
});

// ---------------------------------------------------------------------------
// setPrimaryCoverageZone
// ---------------------------------------------------------------------------

describe("setPrimaryCoverageZone", () => {
  const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb({});
  });

  function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      clearPrimaryScoped: vi.fn().mockResolvedValue(undefined),
      setPrimaryScoped: vi.fn().mockResolvedValue([{ id: "cov-1" }]),
      ...overrides,
    };
  }

  it("clears existing primary then sets new primary", async () => {
    const repo = makeRepo();
    const result = await setPrimaryCoverageZone(
      { organizationId: "org-1", coverageId: "cov-1" },
      { repo, transaction: txFn },
    );
    expect(result.ok).toBe(true);
    expect(repo.clearPrimaryScoped).toHaveBeenCalledWith("org-1", expect.anything());
    expect(repo.setPrimaryScoped).toHaveBeenCalledWith("cov-1", "org-1", expect.anything());
  });

  it("returns error when zone not found (ownership OR nonexistent)", async () => {
    const repo = makeRepo({ setPrimaryScoped: vi.fn().mockResolvedValue([]) });
    const result = await setPrimaryCoverageZone(
      { organizationId: "org-1", coverageId: "cov-missing" },
      { repo, transaction: txFn },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe("Zona no encontrada.");
  });
});
