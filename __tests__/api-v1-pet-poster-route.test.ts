// `GET /api/v1/pets/{publicToken}/poster` — the native app's lost-pet poster (M13).
//
// What is pinned: the door (bearer, limiter buckets, the holder guard answering
// 404 for strangers), the two states (not lost → `available: false`, lost →
// finished HTML), and that the HTML is the shared renderer's output over the
// shared loader's data — the loader is mocked here because it is the web page's
// own resolver, moved verbatim, and the renderer is held to the web component by
// the parity block in PosterPreview.test.tsx.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  limiterThrows: null as null | (() => never),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  access: null as null | (() => unknown),
  load: null as null | (() => unknown),
  loads: 0,
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live
        ? control.live()
        : { ok: true, supabase: {}, user: { id: OWNER_ID }, profile: null },
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limits.push({ endpoint, identifier });
      control.limiterThrows?.();
    },
  };
});

vi.mock("@/lib/infra/pet-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/pet-access")>();
  return {
    ...actual,
    resolvePetHolderAccess: async () =>
      control.access ? control.access() : { kind: "owner", pet: petRow(), holderRole: "owner" },
  };
});

vi.mock("@/src/modules/lost/infrastructure/lost-poster-read", () => ({
  loadLostPoster: async () => {
    control.loads += 1;
    return control.load ? control.load() : posterData();
  },
}));

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

import { RateLimitError } from "@/lib/infra/rate-limit";
import { PET_POSTER_PAYLOAD_VERSION, type PetPosterV1 } from "@dim/contract/api";

import { GET } from "@/app/api/v1/pets/[publicToken]/poster/route";
import {
  type LostPosterData,
  renderLostPosterHtml,
} from "@/src/modules/lost/application/lost-poster-html";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "DIM-PAMP-0001";

function petRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    publicToken: TOKEN,
    name: "Pampa",
    status: "lost",
    species: "dog",
    sex: "female",
    ...overrides,
  };
}

function posterData(overrides: Partial<LostPosterData> = {}): LostPosterData {
  return {
    publicToken: TOKEN,
    petName: "Pampa",
    species: "Perro",
    breed: null,
    sex: "Hembra",
    sexRaw: "female",
    age: "3 años",
    color: "negra",
    distinguishingFeatures: null,
    photoUrl: "https://cdn.test/pampa.jpg",
    placeName: "Plaza Moreno",
    lastSeenAt: new Date("2026-09-20T15:00:00Z"),
    ownerFirstName: "Ana",
    ownerPhone: "221 555 0000",
    locationDisclosed: true,
    qrSvg: '<svg data-testid="qr"></svg>',
    ...overrides,
  };
}

async function call(headers: Record<string, string> = { authorization: "Bearer tok" }) {
  return GET(new Request(`https://www.mimar.com.ar/api/v1/pets/${TOKEN}/poster`, { headers }), {
    params: Promise.resolve({ publicToken: TOKEN }),
  });
}

beforeEach(() => {
  control.live = null;
  control.limiterThrows = null;
  control.limits = [];
  control.access = null;
  control.load = null;
  control.loads = 0;
});

describe("GET /api/v1/pets/{token}/poster — the door", () => {
  it("refuses a request with no bearer before spending a limiter write", async () => {
    const res = await call({});
    expect(res.status).toBe(401);
    expect(control.limits).toEqual([]);
  });

  it("counts the IP and then the user, each in the poster's own bucket", async () => {
    await call();
    expect(control.limits).toEqual([
      { endpoint: "api_v1_pet_poster_ip", identifier: expect.any(String) },
      { endpoint: "api_v1_pet_poster_user", identifier: OWNER_ID },
    ]);
  });

  it("answers 429 when the limiter says so", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "api_v1_pet_poster_ip");
    };
    expect((await call()).status).toBe(429);
  });

  it("answers 404 for a pet the caller does not hold — like one that does not exist", async () => {
    control.access = () => ({ kind: "none" });
    const res = await call();
    expect(res.status).toBe(404);
    expect(control.loads).toBe(0);
  });

  it("maps an erased account to 403, as every sibling does", async () => {
    control.live = () => ({ ok: false, reason: "ACCOUNT_ERASED" });
    expect((await call()).status).toBe(403);
  });
});

describe("GET /api/v1/pets/{token}/poster — the two states", () => {
  it("says there is no poster while the animal is not lost, and reads nothing more", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "active" }),
      holderRole: "owner",
    });
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as PetPosterV1;
    expect(body).toEqual({
      payloadVersion: PET_POSTER_PAYLOAD_VERSION,
      publicToken: TOKEN,
      available: false,
      petName: "Pampa",
    });
    expect(control.loads).toBe(0);
  });

  it("hands over the shared renderer's HTML over the shared loader's data", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as PetPosterV1;
    expect(body.available).toBe(true);
    if (!body.available) return;
    expect(body.hasPhoto).toBe(true);
    expect(body.html).toBe(renderLostPosterHtml(posterData()));
    expect(body.html).toContain("Ana · 221 555 0000");
    expect(body.html).toContain('data-testid="qr"');
  });

  it("reports a poster with no photo, so the app can warn as the web does", async () => {
    control.load = () => posterData({ photoUrl: null });
    const body = (await (await call()).json()) as PetPosterV1;
    expect(body.available && body.hasPhoto).toBe(false);
  });

  it("serves a caretaker too — the loader, not the door, keeps their contact off the poster", async () => {
    control.access = () => ({ kind: "owner", pet: petRow(), holderRole: "caretaker" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(control.loads).toBe(1);
  });
});
