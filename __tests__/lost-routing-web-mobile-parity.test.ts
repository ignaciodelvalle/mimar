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
  requirePetAccess: vi.fn(),
  resolvePetHolderAccess: vi.fn(),
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

vi.mock("@/lib/infra/lost-pet-broadcast", () => ({ broadcastLostPet: vi.fn() }));

// No network: a pin this file sends is reverse-geocoded to the place it is in.
vi.mock("@/lib/infra/geocoding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/geocoding")>();
  return {
    ...actual,
    reverseGeocode: vi.fn(async () => ({
      display_name: "Villa María, Córdoba, Argentina",
      province: "Córdoba",
      locality: "Villa María",
    })),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { runLostCommand } from "@/app/api/v1/pets/[publicToken]/lost/commands";
import { arLocalities, db } from "@/db";
import { setPetLostAction } from "@/src/modules/events/actions";
import { lostCommandInputSchema } from "@dim/contract/input";

const TOKEN = "DIM-TEST-0004";
const VILLA_MARIA_CORDOBA = "14042170";

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

let pin: { lat: number; lng: number };

beforeAll(async () => {
  const [row] = await db
    .select({ lat: arLocalities.latitude, lng: arLocalities.longitude })
    .from(arLocalities)
    .where(eq(arLocalities.indecId, VILLA_MARIA_CORDOBA));
  expect(row, "Villa María (Córdoba) must be in the local catalogue").toBeDefined();
  pin = { lat: Number(row.lat), lng: Number(row.lng) };
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setPetLostWriter.mockResolvedValue({ error: null });
  mocks.requirePetAccess.mockResolvedValue({
    ok: true,
    user: { id: "user-1" },
    pet: PET,
    eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  });
  mocks.resolvePetHolderAccess.mockResolvedValue({ kind: "owner", pet: PET, holderRole: "owner" });
});

type WriterPlace = {
  eventJurisdictionProvince?: string | null;
  eventJurisdictionLocality?: string | null;
};

function writerPlace(): WriterPlace {
  expect(mocks.setPetLostWriter).toHaveBeenCalledTimes(1);
  const [params] = mocks.setPetLostWriter.mock.calls[0] as [WriterPlace];
  return {
    eventJurisdictionProvince: params.eventJurisdictionProvince ?? null,
    eventJurisdictionLocality: params.eventJurisdictionLocality ?? null,
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
async function viaApp(): Promise<WriterPlace> {
  const input = lostCommandInputSchema.parse({
    command: "mark_lost",
    disclosure: DISCLOSURE,
    provinceCode: "AR-X",
    localityName: "Villa María",
    localityIndecId: VILLA_MARIA_CORDOBA,
    locationLat: pin.lat,
    locationLng: pin.lng,
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
    expect(await viaApp()).toEqual({
      eventJurisdictionProvince: "Córdoba",
      eventJurisdictionLocality: "Villa María",
    });
  });

  it("the web files the case where the animal went missing, not at its home", async () => {
    expect(await viaWeb()).toEqual({
      eventJurisdictionProvince: "Córdoba",
      eventJurisdictionLocality: "Villa María",
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
