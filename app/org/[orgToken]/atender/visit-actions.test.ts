// "Iniciar atención" / "Terminar atención" (vet-visit-record): the walk-in
// boundary first, the modality and the appointment validated, the visit id
// never taken from the form. The resolution rules themselves are pinned
// against the real database in src/modules/visits/__tests__.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockResolveAtenderPet = vi.hoisted(() => vi.fn());
vi.mock("./atender-access", () => ({ resolveAtenderPet: mockResolveAtenderPet }));

const mockOpenAtenderVisit = vi.hoisted(() => vi.fn());
vi.mock("./atender-visit", () => ({ openAtenderVisit: mockOpenAtenderVisit }));

const mockCloseVisitOfPet = vi.hoisted(() => vi.fn());
vi.mock("@/src/modules/visits/infrastructure/visit-service", () => ({
  closeVisitOfPet: mockCloseVisitOfPet,
}));

import { atenderCloseVisitAction, atenderStartVisitAction } from "./visit-actions";

const ACCESS = {
  ok: true as const,
  user: { id: "vet-1" },
  organizationId: "org-1",
  isOrgAdmin: false,
  pet: { id: "pet-1", publicToken: "DIM-TEST-0001" },
};
const VISIT_ID = "3f0c1f5e-2b7a-4c55-9a0e-6f1d2c3b4a59";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const start = (fields: Record<string, string>) =>
  atenderStartVisitAction("ORG", "DIM-TEST-0001", { error: null }, fd(fields));

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveAtenderPet.mockResolvedValue(ACCESS);
});

describe("atenderStartVisitAction", () => {
  it("opens the visit with the chosen modality and appointment", async () => {
    mockOpenAtenderVisit.mockResolvedValue({ ok: true, visit: {}, created: true });
    const result = await start({ modality: "home", appointmentId: VISIT_ID });
    expect(result).toEqual({ error: null, ok: true });
    expect(mockOpenAtenderVisit).toHaveBeenCalledWith(ACCESS, {
      modality: "home",
      appointmentId: VISIT_ID,
    });
  });

  it("refuses a modality outside clinic/home without opening anything", async () => {
    const result = await start({ modality: "moon" });
    expect(result.error).toContain("en la clínica o a domicilio");
    expect(mockOpenAtenderVisit).not.toHaveBeenCalled();
  });

  it("says so when the appointment is not this pet's at this organization", async () => {
    mockOpenAtenderVisit.mockResolvedValue({ ok: false, reason: "foreign_appointment" });
    const result = await start({ modality: "clinic", appointmentId: VISIT_ID });
    expect(result.error).toBe("Ese turno no es de esta mascota en esta organización.");
  });

  it("withholds everything when the walk-in authorization is refused", async () => {
    mockResolveAtenderPet.mockResolvedValue({ ok: false, reason: "NO_CAPABILITY", error: "No." });
    expect(await start({ modality: "clinic" })).toEqual({ error: "No." });
    expect(mockOpenAtenderVisit).not.toHaveBeenCalled();
  });
});

describe("atenderCloseVisitAction", () => {
  it("closes through this pet and organization only", async () => {
    mockCloseVisitOfPet.mockResolvedValue({ ok: true, visit: {}, alreadyClosed: false });
    const result = await atenderCloseVisitAction(
      "ORG",
      "DIM-TEST-0001",
      VISIT_ID,
      { error: null },
      fd({}),
    );
    expect(result).toEqual({ error: null, ok: true });
    expect(mockCloseVisitOfPet).toHaveBeenCalledWith({
      visitId: VISIT_ID,
      petId: "pet-1",
      organizationId: "org-1",
      actorUserId: "vet-1",
      isOrgAdmin: false,
    });
  });

  it("forwards isOrgAdmin so an admin can close a colleague's visit", async () => {
    mockResolveAtenderPet.mockResolvedValue({ ...ACCESS, isOrgAdmin: true });
    mockCloseVisitOfPet.mockResolvedValue({ ok: true, visit: {}, alreadyClosed: false });
    const result = await atenderCloseVisitAction(
      "ORG",
      "DIM-TEST-0001",
      VISIT_ID,
      { error: null },
      fd({}),
    );
    expect(result).toEqual({ error: null, ok: true });
    expect(mockCloseVisitOfPet).toHaveBeenCalledWith(expect.objectContaining({ isOrgAdmin: true }));
  });

  it("a visit of another pet or org reads as not found", async () => {
    mockCloseVisitOfPet.mockResolvedValue({ ok: false, reason: "not_found" });
    const result = await atenderCloseVisitAction(
      "ORG",
      "DIM-TEST-0001",
      VISIT_ID,
      { error: null },
      fd({}),
    );
    expect(result.error).toBe("No encontramos esa atención.");
  });

  it("refuses a colleague who is neither the visit's vet nor an admin, with a clear reason", async () => {
    mockCloseVisitOfPet.mockResolvedValue({ ok: false, reason: "not_authorized" });
    const result = await atenderCloseVisitAction(
      "ORG",
      "DIM-TEST-0001",
      VISIT_ID,
      { error: null },
      fd({}),
    );
    expect(result.error).toBe(
      "Solo quien atendió esta visita, o un administrador de la organización, puede cerrarla.",
    );
  });

  it("a malformed id never reaches the database", async () => {
    const result = await atenderCloseVisitAction(
      "ORG",
      "DIM-TEST-0001",
      "x",
      { error: null },
      fd({}),
    );
    expect(result.error).toBe("No encontramos esa atención.");
    expect(mockCloseVisitOfPet).not.toHaveBeenCalled();
  });
});
