// FIX-25 #1 (PO, 2026-09-25) — web location provenance parity with the app/API
// path. The sighting form posts a `locationSource` hidden field; a hand-crafted
// POST can set it to "geocodificada", which lib/domain/provenance.ts ranks
// "verificado" for officials. The server stores only what it can stand behind:
// the point came from the client, so the payload says `pin_manual`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const insertEventIdempotentMock = vi.fn();
const selectQueue: unknown[][] = [];

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

vi.mock("@/db", () => {
  const chain = () => {
    const c = {
      from: () => c,
      where: () => c,
      limit: async () => selectQueue.shift() ?? [],
    };
    return c;
  };
  return {
    attachments: {},
    cases: { id: "id", primaryPetId: "p", caseKind: "k", status: "s" },
    pets: {},
    db: {
      select: vi.fn(() => chain()),
      insert: vi.fn(() => ({ values: vi.fn() })),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
    },
  };
});

vi.mock("@/lib/domain/location-normalize", () => ({
  CoordError: class extends Error {},
  normalizeLocationForWrite: vi
    .fn()
    .mockResolvedValue({ province: null, locality: null, lat: -34.6, lng: -58.4 }),
}));

vi.mock("@/lib/domain/location-value", () => ({
  parseLocationFromFormData: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/events/event-idempotency", () => ({
  insertEventIdempotent: (...args: unknown[]) => insertEventIdempotentMock(...args),
}));

vi.mock("@/lib/infra/notification-service", () => ({
  createNotificationsBulk: vi.fn(async () => undefined),
}));

vi.mock("@/lib/infra/pet-alert-recipients", () => ({
  resolveLostPetAlertRecipients: vi.fn(async () => []),
}));

vi.mock("@/lib/infra/public-pet-lookup", () => ({
  publicPetByToken: vi.fn(() => ({})),
}));

vi.mock("@/lib/infra/rate-limit", () => ({
  RateLimitError: class extends Error {},
  callerIp: vi.fn(() => "127.0.0.1"),
  enforceRateLimit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/infra/uploads", () => ({
  uploadAttachmentIfPresent: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import { reportPetSighting } from "./report-pet-sighting";

function sightingForm(locationSource: string): FormData {
  const fd = new FormData();
  fd.set("description", "La vi en la plaza");
  fd.set("locationSource", locationSource);
  return fd;
}

describe("reportPetSighting — a client-claimed location source is never stored", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    // 1st select: the pet; 2nd select: the open lost_pet_episode case.
    selectQueue.push(
      [{ id: "pet-1", name: "Firulais", status: "lost", inCustodyDispute: false, seedTag: null }],
      [],
    );
    insertEventIdempotentMock.mockResolvedValue({ event: { id: "ev-1" }, wasNoop: false });
  });

  it.each(["geocodificada", "gps", "pin_manual", ""])(
    "a form claiming %j stores location_source = pin_manual",
    async (claimed) => {
      const result = await reportPetSighting(
        "tok-1",
        { ok: false, error: null },
        sightingForm(claimed),
      );

      expect(result.ok).toBe(true);
      expect(insertEventIdempotentMock).toHaveBeenCalledTimes(1);
      const row = insertEventIdempotentMock.mock.calls[0][0] as {
        payload: { location_source?: unknown };
      };
      expect(row.payload.location_source).toBe("pin_manual");
    },
  );
});
