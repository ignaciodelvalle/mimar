// Where a WEB bite happened — what each door hands its writer.
//
// localidades-por-id A2. Both web bite doors used to canonicalise the pair with
// `normalizeLocationForWrite(…, "soft")` and nothing else: the pin that came
// with it was never compared with it, and the resolved catalogue row was only
// as good as the NAME (a homonym settled on the alphabetically first
// department). They now resolve the place the way every report does
// (lib/place/reported-place.ts), each with the rule that fits its form:
//
//   - the OWNER form is a map (LocationFields l2): its pair is the client's
//     reverse geocode of the SAME pin, so a disagreement re-reads the pin
//     (`resolveMapFormPlace`);
//   - the ORG form's pair comes from a catalogue picker, a source independent
//     of its optional pin, so a disagreement leaves the place province-level
//     rather than trusting either (`resolveReportedPlace`, soft).
//
// The resolver itself is pinned in lib/place/reported-place.test.ts; this file
// pins which one each door calls and that the place reaches the writer whole.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reportBite: vi.fn(),
  reportBiteFromOrg: vi.fn(),
  findPetByToken: vi.fn(),
  resolveMapFormPlace: vi.fn(),
  resolveReportedPlace: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: { transaction: vi.fn(), insert: vi.fn(() => ({ values: vi.fn() })) },
  notifications: {},
}));
vi.mock("./infrastructure/surveillance-repository", () => ({
  SurveillanceRepository: class {
    findPetByToken = (...args: unknown[]) => mocks.findPetByToken(...args);
  },
}));
vi.mock("@/lib/infra/pet-access", () => ({ requireAlivePetAccess: vi.fn() }));
vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  requireCapabilityForOrgToken: vi.fn(),
}));
vi.mock("./application/report-bite", () => ({ reportBite: mocks.reportBite }));
vi.mock("./application/report-bite-from-org", () => ({
  reportBiteFromOrg: mocks.reportBiteFromOrg,
}));
vi.mock("@/lib/place/reported-place", () => ({
  resolveMapFormPlace: mocks.resolveMapFormPlace,
  resolveReportedPlace: mocks.resolveReportedPlace,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

import { requireAlivePetAccess } from "@/lib/infra/pet-access";
import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { reportBiteAction, reportBiteFromOrgAction } from "./actions";

const PET = {
  id: "pet-1",
  publicToken: "tok-1",
  name: "Firulais",
  species: "dog",
  status: "alive",
  rabiesObservationStatus: null,
  jurisdictionProvince: "CABA",
  jurisdictionLocality: "Palermo",
};

const VILLA_MARIA_CBA = {
  province: "Córdoba",
  locality: "Villa María",
  localityId: "loc-vm-cba",
  method: "exact_name_unique",
  unresolvedReason: null,
  mismatch: false,
  entered: { province: "AR-X", locality: "Villa María", indecId: null },
};

function biteForm(): FormData {
  const fd = new FormData();
  fd.set("occurredAt", "2026-07-01");
  fd.set("victimKind", "human");
  fd.set("severity", "minor");
  fd.set("confirmObservation", "on");
  fd.set("provinceCode", "AR-X");
  fd.set("provinceName", "Córdoba");
  fd.set("localityName", "Villa María");
  fd.set("localityNameIndecId", "14042170");
  fd.set("locationLat", "-32.41");
  fd.set("locationLng", "-63.24");
  return fd;
}

type WriterPlace = {
  eventJurisdictionProvince: string | null;
  eventJurisdictionLocality: string | null;
  eventLocalityId?: string | null;
};

function placeHandedTo(writer: ReturnType<typeof vi.fn>) {
  expect(writer).toHaveBeenCalledTimes(1);
  const [input] = writer.mock.calls[0] as [WriterPlace];
  return {
    eventJurisdictionProvince: input.eventJurisdictionProvince,
    eventJurisdictionLocality: input.eventJurisdictionLocality,
    eventLocalityId: input.eventLocalityId ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveMapFormPlace.mockResolvedValue(VILLA_MARIA_CBA);
  mocks.resolveReportedPlace.mockResolvedValue(VILLA_MARIA_CBA);
  mocks.reportBite.mockResolvedValue({
    ok: true,
    value: { casePublicCode: "CAS-AAAA-BBBB" },
    notifications: [],
  });
  mocks.reportBiteFromOrg.mockResolvedValue({
    ok: true,
    value: { casePublicCode: "CAS-AAAA-BBBB" },
    notifications: [],
  });
  mocks.findPetByToken.mockResolvedValue(PET);
  (requireAlivePetAccess as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    pet: PET,
    user: { id: "user-1" },
    eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  });
  (requireCapabilityForOrgToken as ReturnType<typeof vi.fn>).mockResolvedValue({
    error: null,
    user: { id: "user-1" },
    organization: { id: "org-1", displayName: "Refugio", orgType: "shelter", verified: true },
  });
});

describe("owner bite (map form)", () => {
  it("resolves the place as a map form: the pair, checked against its own pin", async () => {
    await reportBiteAction("tok-1", { error: null }, biteForm()).catch(() => {});
    expect(mocks.resolveMapFormPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        provinceCode: "AR-X",
        locality: "Villa María",
        localityIndecId: "14042170",
        lat: -32.41,
        lng: -63.24,
      }),
    );
    expect(mocks.resolveReportedPlace).not.toHaveBeenCalled();
  });

  it("hands the writer the resolved place whole, catalogue row included", async () => {
    await reportBiteAction("tok-1", { error: null }, biteForm()).catch(() => {});
    expect(placeHandedTo(mocks.reportBite)).toEqual({
      eventJurisdictionProvince: "Córdoba",
      eventJurisdictionLocality: "Villa María",
      eventLocalityId: "loc-vm-cba",
    });
  });

  it("a province-level place travels as one, with no locality and no id", async () => {
    mocks.resolveMapFormPlace.mockResolvedValue({
      ...VILLA_MARIA_CBA,
      province: "Buenos Aires",
      locality: null,
      localityId: null,
      method: "unresolved",
      unresolvedReason: "ambiguous",
    });
    await reportBiteAction("tok-1", { error: null }, biteForm()).catch(() => {});
    expect(placeHandedTo(mocks.reportBite)).toEqual({
      eventJurisdictionProvince: "Buenos Aires",
      eventJurisdictionLocality: null,
      eventLocalityId: null,
    });
  });
});

describe("org bite (catalogue picker + optional pin)", () => {
  it("resolves the picker's pair without letting the pin overrule it", async () => {
    const fd = biteForm();
    fd.set("petPublicToken", "tok-1");
    await reportBiteFromOrgAction("org-tok", { error: null }, fd).catch(() => {});
    expect(mocks.resolveReportedPlace).toHaveBeenCalledWith(
      expect.objectContaining({ localityIndecId: "14042170" }),
      { pair: "soft" },
    );
    expect(mocks.resolveMapFormPlace).not.toHaveBeenCalled();
  });

  it("hands the writer the resolved place whole, catalogue row included", async () => {
    const fd = biteForm();
    fd.set("petPublicToken", "tok-1");
    await reportBiteFromOrgAction("org-tok", { error: null }, fd).catch(() => {});
    expect(placeHandedTo(mocks.reportBiteFromOrg)).toEqual({
      eventJurisdictionProvince: "Córdoba",
      eventJurisdictionLocality: "Villa María",
      eventLocalityId: "loc-vm-cba",
    });
  });
});
