// Fence: the web and the app route the same lost animal to the same place.
//
// R4 of the 2026-09-25 localities audit. The web's `setPetLostAction` read only
// the pin and the address text: the (province, locality) its own map had just
// reverse-geocoded was on the form and never read, so the lost case fell back
// to the animal's HOME. The app sends the pair from its picker and the case
// lands where the animal went missing. A dog from CABA lost in Villa María
// (Córdoba) opened a CABA case from the web and a Córdoba case from the app;
// only one set of organisations and authorities was ever told.
//
// Both doors are driven here with the same pin and the same place, and what
// each hands the lost writer must be the same place — the incident's, never
// the home's (spec: bite-and-lost-reporting "Same pin, same unit, any
// channel"; place-capture-contract "Lost report — web" and "— app").
//
// The writer is captured, not run: this file pins what each DOOR decides.
// The catalogue is the real local one (Villa María, Córdoba = INDEC 14042170;
// its homonym in Buenos Aires, 06021060, must never be the answer).

import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setPetLostWriter: vi.fn(),
  updateLostLastSeen: vi.fn(),
  requirePetAccess: vi.fn(),
  resolvePetHolderAccess: vi.fn(),
  reverseGeocode: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/infra/pet-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/pet-access")>();
  return {
    ...actual,
    requirePetAccess: mocks.requirePetAccess,
    resolvePetHolderAccess: mocks.resolvePetHolderAccess,
  };
});

vi.mock("@/src/modules/events/application/lifecycle/set-pet-lost-use-case", () => ({
  setPetLostWriter: mocks.setPetLostWriter,
}));

vi.mock("@/src/modules/events/application/lifecycle/update-lost-last-seen-use-case", () => ({
  updateLostLastSeen: mocks.updateLostLastSeen,
}));

// The app's last-seen door probes the open episode before it writes.
vi.mock("@/lib/infra/case-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/case-helpers")>();
  return { ...actual, findOpenCaseForPetAndKind: async () => ({ id: "case-1" }) };
});

vi.mock("@/lib/infra/lost-pet-broadcast", () => ({ broadcastLostPet: vi.fn() }));

// No network: each test says what the geocoder answers for its pin.
vi.mock("@/lib/infra/geocoding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/geocoding")>();
  return { ...actual, reverseGeocode: mocks.reverseGeocode };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { runLostCommand } from "@/app/api/v1/pets/[publicToken]/lost/commands";
import { arLocalities, db } from "@/db";
import { setPetLostAction, updateLostLastSeenAction } from "@/src/modules/events/actions";
import { lostCommandInputSchema } from "@dim/contract/input";

const TOKEN = "DIM-TEST-0004";
const VILLA_MARIA_CORDOBA = "14042170";
const VILLA_MARIA_BUENOS_AIRES = "06021060";

/** A dog that lives in CABA. */
const PET = {
  id: "00000000-0000-4000-8000-00000000c0de",
  publicToken: TOKEN,
  name: "Rex",
  sex: "male",
  status: "active",
  species: "dog",
  breed: null,
  color: null,
  jurisdictionProvince: "CABA",
  jurisdictionLocality: "Palermo",
};

const DISCLOSURE = {
  discloseFirstNameWhenLost: true,
  disclosePhoneWhenLost: true,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: true,
  allowFinderFormWhenLost: true,
};

type Row = { id: string; lat: number; lng: number };
let pin: { lat: number; lng: number };
let cordobaRow: Row;
let buenosAiresRow: Row;

async function catalogueRow(indecId: string): Promise<Row> {
  const [row] = await db
    .select({ id: arLocalities.id, lat: arLocalities.latitude, lng: arLocalities.longitude })
    .from(arLocalities)
    .where(eq(arLocalities.indecId, indecId));
  expect(row, `INDEC ${indecId} must be in the local catalogue`).toBeDefined();
  return { id: row.id, lat: Number(row.lat), lng: Number(row.lng) };
}

beforeAll(async () => {
  cordobaRow = await catalogueRow(VILLA_MARIA_CORDOBA);
  buenosAiresRow = await catalogueRow(VILLA_MARIA_BUENOS_AIRES);
  pin = { lat: cordobaRow.lat, lng: cordobaRow.lng };
});

/** The geocoder names the Villa María the pin is actually in. */
function geocoderAnswers(province: string) {
  mocks.reverseGeocode.mockResolvedValue({
    display_name: `Villa María, ${province}, Argentina`,
    province,
    locality: "Villa María",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setPetLostWriter.mockResolvedValue({ error: null });
  mocks.updateLostLastSeen.mockResolvedValue({ error: null, wasDuplicate: false });
  mocks.requirePetAccess.mockResolvedValue({
    ok: true,
    user: { id: "user-1" },
    pet: PET,
    eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  });
  mocks.resolvePetHolderAccess.mockResolvedValue({ kind: "owner", pet: PET, holderRole: "owner" });
  geocoderAnswers("Córdoba");
});

type WriterPlace = {
  eventJurisdictionProvince?: string | null;
  eventJurisdictionLocality?: string | null;
  eventLocalityId?: string | null;
};

function writerPlace(): WriterPlace {
  expect(mocks.setPetLostWriter).toHaveBeenCalledTimes(1);
  const [params] = mocks.setPetLostWriter.mock.calls[0] as [WriterPlace];
  return {
    eventJurisdictionProvince: params.eventJurisdictionProvince ?? null,
    eventJurisdictionLocality: params.eventJurisdictionLocality ?? null,
    eventLocalityId: params.eventLocalityId ?? null,
  };
}

/** What the web's wizard posts: the pair its map reverse-geocoded, no INDEC id. */
async function viaWeb(): Promise<WriterPlace> {
  const fd = new FormData();
  fd.set("provinceCode", "AR-X");
  fd.set("provinceName", "Córdoba");
  fd.set("localityName", "Villa María");
  fd.set("localityNameIndecId", "");
  fd.set("locationLat", String(pin.lat));
  fd.set("locationLng", String(pin.lng));
  fd.set("locationAddress", "Plaza Independencia, Villa María");
  fd.set("noRedirect", "1");
  const res = await setPetLostAction(TOKEN, { error: null }, fd);
  expect(res.error).toBeNull();
  return writerPlace();
}

/** What the app posts: the picker's trio, INDEC id included, and the same pin. */
async function viaApp(at: { lat: number; lng: number } = pin): Promise<WriterPlace> {
  const input = lostCommandInputSchema.parse({
    command: "mark_lost",
    disclosure: DISCLOSURE,
    provinceCode: "AR-X",
    localityName: "Villa María",
    localityIndecId: VILLA_MARIA_CORDOBA,
    locationLat: at.lat,
    locationLng: at.lng,
    locationDescription: "Plaza Independencia, Villa María",
  });
  const res = await runLostCommand({
    publicToken: TOKEN,
    userId: "user-1",
    idempotencyKey: null,
    input,
  });
  expect(res.status).toBe(200);
  return writerPlace();
}

describe("lost routing: same pin, same place, any channel", () => {
  it("the app files the case where the animal went missing", async () => {
    expect(await viaApp()).toMatchObject({
      eventJurisdictionProvince: "Córdoba",
      eventJurisdictionLocality: "Villa María",
    });
  });

  it("the web files the case where the animal went missing, not at its home", async () => {
    expect(await viaWeb()).toEqual({
      eventJurisdictionProvince: "Córdoba",
      eventJurisdictionLocality: "Villa María",
      eventLocalityId: cordobaRow.id,
    });
  });

  it("both doors hand the writer the identical place", async () => {
    const web = await viaWeb();
    vi.clearAllMocks();
    mocks.setPetLostWriter.mockResolvedValue({ error: null });
    mocks.resolvePetHolderAccess.mockResolvedValue({
      kind: "owner",
      pet: PET,
      holderRole: "owner",
    });
    const app = await viaApp();
    expect(web).toEqual(app);
  });
});

describe("the app door (localidades-por-id A3)", () => {
  it("the case carries the catalogue row the picker resolved", async () => {
    expect(await viaApp()).toEqual({
      eventJurisdictionProvince: "Córdoba",
      eventJurisdictionLocality: "Villa María",
      eventLocalityId: cordobaRow.id,
    });
  });

  it("a pin that contradicts the picker is re-read: the case goes where the pin is", async () => {
    // The picker says Córdoba's Villa María; the pin sits on Buenos Aires' one.
    // The two answers came from the same person and only the pin is a fact
    // about the ground — and it is what the web would file for the same pin.
    geocoderAnswers("Buenos Aires");
    expect(await viaApp({ lat: buenosAiresRow.lat, lng: buenosAiresRow.lng })).toEqual({
      eventJurisdictionProvince: "Buenos Aires",
      eventJurisdictionLocality: "Villa María",
      eventLocalityId: buenosAiresRow.id,
    });
  });

  it("a pair without its INDEC id never reaches the writer, so no homonym is ever guessed", () => {
    // The contract refuses a partial trio (LOST_JURISDICTION_INCOMPLETE) before
    // any lookup: "Buenos Aires / Mechita" alone names two partidos.
    const parsed = lostCommandInputSchema.safeParse({
      command: "mark_lost",
      disclosure: DISCLOSURE,
      provinceCode: "AR-B",
      localityName: "Mechita",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toContain("LOST_JURISDICTION_INCOMPLETE");
  });
});

// localidades-por-id A5 (spec: "Last-seen update — update links, does not
// rewrite"). An update is resolved like any report and its place travels on
// the NEW note — never written back onto the case or the original report.
describe("last-seen updates keep their own place (A5)", () => {
  function placeHandedToUpdate(): Record<string, unknown> {
    expect(mocks.updateLostLastSeen).toHaveBeenCalledTimes(1);
    const [params] = mocks.updateLostLastSeen.mock.calls[0] as [
      { place?: Record<string, unknown> },
    ];
    return params.place ?? {};
  }

  it("the web update resolves its pair against its pin", async () => {
    const lostPet = { ...PET, status: "lost" };
    mocks.requirePetAccess.mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
      pet: lostPet,
      eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
    });
    const fd = new FormData();
    fd.set("provinceCode", "AR-X");
    fd.set("localityName", "Villa María");
    fd.set("locationLat", String(pin.lat));
    fd.set("locationLng", String(pin.lng));
    fd.set("locationAddress", "Plaza Independencia");
    const res = await updateLostLastSeenAction(TOKEN, { error: null }, fd);
    expect(res.error).toBeNull();
    expect(placeHandedToUpdate()).toEqual({
      entered: { province: "AR-X", locality: "Villa María", indec_id: null },
      resolved: { locality_id: cordobaRow.id, province_code: "AR-X", method: "exact_name_unique" },
    });
  });

  it("the app update resolves its pin, and lands on the same row", async () => {
    const lostPet = { ...PET, status: "lost" };
    mocks.resolvePetHolderAccess.mockResolvedValue({
      kind: "owner",
      pet: lostPet,
      holderRole: "owner",
    });
    const input = lostCommandInputSchema.parse({
      command: "report_last_seen",
      locationLat: pin.lat,
      locationLng: pin.lng,
      locationDescription: "Plaza Independencia",
    });
    const res = await runLostCommand({
      publicToken: TOKEN,
      userId: "user-1",
      idempotencyKey: "key-1",
      input,
    });
    expect(res.status).toBe(200);
    expect(placeHandedToUpdate()).toEqual({
      entered: { province: null, locality: null, indec_id: null },
      resolved: { locality_id: cordobaRow.id, province_code: "AR-X", method: "geocode_unique" },
    });
  });
});
