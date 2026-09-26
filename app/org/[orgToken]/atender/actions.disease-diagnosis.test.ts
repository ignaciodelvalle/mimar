// The clinic panel's ENO diagnosis door (PO S2, 2026-09-26): only a signer
// with a validated matrícula records it; the fields are the shared parser's;
// the SAME writer as the web runs; and the walk-in exit tells the owner.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventFormState } from "@/src/modules/events/actions";

const mockResolveAtenderPet = vi.hoisted(() => vi.fn());
vi.mock("./atender-access", () => ({
  ATENDER_TOKEN_PATTERN: /^DIM-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
  normalizeAtenderToken: (s: string) => s,
  resolveAtenderPet: mockResolveAtenderPet,
}));

vi.mock("@/db", () => ({
  db: {
    transaction: vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
  },
}));

const mockNotifyOwners = vi.hoisted(() => vi.fn().mockResolvedValue({ delivered: 1 }));
vi.mock("@/lib/infra/notify-owners-of-clinical-event", () => ({
  notifyOwnersOfClinicalEvent: mockNotifyOwners,
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const mockWriter = vi.hoisted(() => vi.fn());
vi.mock("@/src/modules/events/application/clinical/record-disease-diagnosis-use-case", () => ({
  recordDiseaseDiagnosisWriter: mockWriter,
}));

vi.mock("@/src/modules/events/infrastructure/events-repository", () => ({
  EventsRepository: class EventsRepository {},
}));

vi.mock("@/src/modules/surveillance/infrastructure/surveillance-repository", () => ({
  SurveillanceRepository: class SurveillanceRepository {
    findPetByToken = vi.fn().mockResolvedValue({
      id: "pet-1",
      publicToken: "DIM-TEST-0001",
      species: "dog",
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      localityId: null,
      placeMethod: null,
    });
  },
}));

function access(eventAuthorship: Record<string, unknown>) {
  return {
    ok: true as const,
    user: { id: "vet-user-1" },
    organizationId: "org-1",
    organizationName: "Clínica del Parque",
    pet: {
      id: "pet-1",
      publicToken: "DIM-TEST-0001",
      name: "Firulais",
      species: "dog",
      status: "active",
      dateOfBirth: "2020-01-01",
    },
    signer: { label: "Dra. Test", matriculaVerified: eventAuthorship.authorVerified === true },
    eventAuthorship,
  };
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const VALID = { diseaseCode: "leptospirosis", diagnosisDate: "2026-09-20", method: "clinico" };

type Actions = typeof import("./actions");
let actions: Actions;
const call = (fields: Record<string, string>): Promise<EventFormState> =>
  actions.atenderDiseaseDiagnosisAction(
    "ORG-1",
    "DIM-TEST-0001",
    { error: null },
    formData(fields),
  );

beforeEach(async () => {
  vi.clearAllMocks();
  actions = await import("./actions");
});

describe("atenderDiseaseDiagnosisAction (S2)", () => {
  it("refuses a signer without a validated matrícula, before writing anything", async () => {
    mockResolveAtenderPet.mockResolvedValue(
      access({ authorRole: "org_member", authorOrganizationId: "org-1", authorVerified: false }),
    );
    const result = await call(VALID);
    expect(result.error).toContain("matrícula validada");
    expect(mockWriter).not.toHaveBeenCalled();
    expect(mockNotifyOwners).not.toHaveBeenCalled();
  });

  it("refuses a disease that is not notifiable (the shared parser)", async () => {
    mockResolveAtenderPet.mockResolvedValue(
      access({ authorRole: "vet", authorOrganizationId: "org-1", authorVerified: true }),
    );
    const result = await call({ ...VALID, diseaseCode: "parvovirus" });
    expect(result.error).toBe("Esa enfermedad no es de notificación obligatoria.");
    expect(mockWriter).not.toHaveBeenCalled();
  });

  it("a matriculated vet's diagnosis runs the writer and closes through the walk-in receipt", async () => {
    mockResolveAtenderPet.mockResolvedValue(
      access({ authorRole: "vet", authorOrganizationId: "org-1", authorVerified: true }),
    );
    mockWriter.mockResolvedValue({
      ok: true,
      diagnosisEventId: "evt-dx",
      signalEventId: "evt-sig",
      ownerNotificationsDelivered: 0,
    });
    const result = await call({ ...VALID, method: "laboratorio", labName: "INPPAZ" });

    expect(result.error).toBeNull();
    expect(result.redirectTo).toBe("/org/ORG-1/atender/DIM-TEST-0001?firmado=1");
    expect(mockWriter).toHaveBeenCalledTimes(1);
    expect(mockWriter.mock.calls[0][0]).toMatchObject({
      petId: "pet-1",
      vetUserId: "vet-user-1",
      diseaseCode: "leptospirosis",
      confirmedByLab: true,
      labName: "INPPAZ",
      petJurisdictionProvince: "Buenos Aires",
    });
    expect(mockNotifyOwners).toHaveBeenCalledTimes(1);
    expect(mockNotifyOwners.mock.calls[0][0]).toMatchObject({
      eventId: "evt-dx",
      eventType: "clinical_info_logged",
    });
  });
});
