// T1-C1: marking a pet lost or found marks the pages it changes as stale.
//
// Neither action revalidated anything until 2026-09-18, unlike every sibling
// pet mutation (lost-mode, tier2-public, service-dog, physical-tag-interest).
// The owner could land back on a profile still showing the lost-case block for
// an animal the database already had as active — the stale page that
// `ensurePetFound` in e2e/demo/_helpers.ts documents, and the most probable
// cause of the flaky cleanup in crisis-owner-lost-flow and owner-ia-p6.
//
// The use-cases are faked: this file pins the ACTION edge, i.e. the exact paths
// handed to next/cache, and that nothing is revalidated when the write refused.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePetAccess: vi.fn(),
  setPetLostWriter: vi.fn(),
  setPetFound: vi.fn(),
  updateLostLastSeen: vi.fn(),
  resolveFoundConfirmationRecipient: vi.fn(),
  findBroadcastRecipientUserIds: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/infra/pet-access", () => ({
  requirePetAccess: mocks.requirePetAccess,
  requireAlivePetAccess: vi.fn(),
}));

vi.mock("@/src/modules/events/application/lifecycle/set-pet-lost-use-case", () => ({
  setPetLostWriter: mocks.setPetLostWriter,
}));

vi.mock("@/src/modules/events/application/lifecycle/set-pet-found-use-case", () => ({
  setPetFound: mocks.setPetFound,
}));

vi.mock("@/src/modules/events/application/lifecycle/update-lost-last-seen-use-case", () => ({
  updateLostLastSeen: mocks.updateLostLastSeen,
}));

vi.mock("@/src/modules/events/application/lifecycle/found-notification-audience", () => ({
  resolveFoundConfirmationRecipient: mocks.resolveFoundConfirmationRecipient,
  findBroadcastRecipientUserIds: mocks.findBroadcastRecipientUserIds,
}));

vi.mock("@/lib/infra/lost-pet-broadcast", () => ({ broadcastLostPet: vi.fn() }));

vi.mock("@/src/modules/events/infrastructure/events-repository", () => ({
  EventsRepository: class {},
}));

// The REAL schema under a fake client — see set-pet-lost-coord-range.test.ts
// for why a hand-listed subset is not safe here.
vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  return { ...schema, db: { transaction: vi.fn() } };
});

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
  revalidateTag: mocks.revalidateTag,
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import {
  setPetFoundAction,
  setPetLostAction,
  updateLostLastSeenAction,
} from "@/src/modules/events/actions";

const TOKEN = "DIM-TEST-0003";

const access = {
  ok: true as const,
  user: { id: "user-1" },
  pet: {
    id: "pet-1",
    publicToken: TOKEN,
    name: "Rex",
    sex: "male",
    status: "active",
    species: "dog",
    breed: null,
    color: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
  },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
};

function lostForm(): FormData {
  const fd = new FormData();
  fd.set("locationAddress", "Plaza Moreno, La Plata");
  return fd;
}

function revalidatedPaths(): string[] {
  return mocks.revalidatePath.mock.calls.map((c) => c[0] as string).sort();
}

const EXPECTED = ["/mis-mascotas", `/mis-mascotas/${TOKEN}`, `/p/${TOKEN}`].sort();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePetAccess.mockResolvedValue(access);
  mocks.setPetLostWriter.mockResolvedValue({ error: null, ok: true });
  mocks.setPetFound.mockResolvedValue({ ok: true, alreadyActive: false });
  mocks.updateLostLastSeen.mockResolvedValue({ error: null, ok: true });
  mocks.resolveFoundConfirmationRecipient.mockResolvedValue("user-1");
});

describe("setPetLostAction — revalidation", () => {
  it("revalidates the owner page, the public credential and the pet list", async () => {
    const res = await setPetLostAction(TOKEN, { error: null }, lostForm());
    expect(res.error).toBeNull();
    expect(revalidatedPaths()).toEqual(EXPECTED);
  });

  it("revalidates on the inline (noRedirect) path too", async () => {
    const fd = lostForm();
    fd.set("noRedirect", "1");
    await setPetLostAction(TOKEN, { error: null }, fd);
    expect(revalidatedPaths()).toEqual(EXPECTED);
  });

  it("revalidates nothing when the write refused", async () => {
    mocks.setPetLostWriter.mockResolvedValue({ error: "Esta mascota ya está perdida." });
    const res = await setPetLostAction(TOKEN, { error: null }, lostForm());
    expect(res.error).toBe("Esta mascota ya está perdida.");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setPetFoundAction — revalidation", () => {
  it("revalidates the owner page, the public credential and the pet list", async () => {
    const res = await setPetFoundAction(TOKEN, { error: null }, new FormData());
    expect(res).toEqual({ error: null, ok: true, redirectTo: `/mis-mascotas/${TOKEN}` });
    expect(mocks.setPetFound).toHaveBeenCalledTimes(1);
    expect(revalidatedPaths()).toEqual(EXPECTED);
  });

  it("revalidates nothing when access is refused", async () => {
    mocks.requirePetAccess.mockResolvedValue({ ok: false, error: "Sin acceso." });
    await setPetFoundAction(TOKEN, { error: null }, new FormData());
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

// The owner moving the last-seen point of a LOST pet changes the same two
// pages the lost flip does: their profile and the public lost poster. Without
// this the redirect lands on the old point, which reads as "did not save".
describe("updateLostLastSeenAction — revalidation", () => {
  const lostAccess = { ...access, pet: { ...access.pet, status: "lost" } };

  it("revalidates the owner page, the public credential and the pet list", async () => {
    mocks.requirePetAccess.mockResolvedValue(lostAccess);
    const res = await updateLostLastSeenAction(TOKEN, { error: null }, lostForm());
    expect(res).toEqual({ error: null, ok: true, redirectTo: `/mis-mascotas/${TOKEN}` });
    expect(mocks.updateLostLastSeen).toHaveBeenCalledTimes(1);
    expect(revalidatedPaths()).toEqual(EXPECTED);
  });

  it("revalidates nothing when the write refused", async () => {
    mocks.requirePetAccess.mockResolvedValue(lostAccess);
    mocks.updateLostLastSeen.mockResolvedValue({ error: "La mascota no está perdida." });
    const res = await updateLostLastSeenAction(TOKEN, { error: null }, lostForm());
    expect(res.error).toBe("La mascota no está perdida.");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
