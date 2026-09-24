// `/api/v1/adoptions` and `/api/v1/adoptions/{petToken}` — the adoption surface
// over a bearer token.
//
// WHAT THIS FILE EXISTS TO STOP
// ---------------------------------------------------------------------------
// THE FIFTH SOFT-DELETE LEAK. This repo has closed four surfaces where an erased
// subject's animal kept answering (`dim-interno:docs/agents/open-work.md`), and a public
// catalogue with a per-pet ficha is the shape all four had. The reader is what
// carries the art. 16 guard; what this file pins is that the HANDLER does not
// undo it — that "gone" leaves as a 404 and not as a soft page naming the
// animal, which is the way a leak would arrive here dressed as kindness.
//
// AND THE THREE SOFT ANSWERS BEING THREE. A pet adopted last week, a pet the
// shelter paused, and a pet that never existed are different facts. Collapsing
// any pair of them is the failure spec D7.2 was written about: somebody follows
// a WhatsApp link and is told the animal never existed.
//
// AND `canApply` COMING FROM THE SERVER. The rule `pets/{token}/profile` set for
// this surface is that a client must never draw a control the write would
// refuse. Both refusals need state the phone does not have, so the handler has
// to compute them — and a handler that reported `canApply: true` unconditionally
// would render a form, take a letter, and throw it away.
//
// Mocked at the READER and the USE-CASE, not at the database: what is pinned is
// the handler's contract with them, and a live version would need a seeded
// shelter, a seeded pet and a seeded applicant per case on a shared Supabase.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  cookieDoorTouched: false,
  limiterThrows: null as null | (() => never),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  live: null as unknown,
  /** Everything the handler reported as an incident. */
  reported: [] as string[],
}));

vi.mock("@/lib/infra/report-error", () => ({
  reportError: (label: string) => {
    control.reported.push(label);
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/adoptions read the COOKIE client — bearer only");
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/adoptions read cookies() — bearer only");
  },
  headers: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/adoptions read next/headers headers()");
  },
}));

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

// STUBBED SO THIS FILE DOES NOT BUILD A REAL SUPABASE CLIENT, which is a fact
// about the HARNESS and not about the route.
//
// `createClientFromBearer` calls `createClient()` from supabase-js, which reads
// `NEXT_PUBLIC_SUPABASE_ANON_KEY` and throws `supabaseKey is required.` when it
// is absent. `__tests__/setup-env.ts` forces `NEXT_PUBLIC_SUPABASE_URL` and
// `SUPABASE_SERVICE_ROLE_KEY` and NOT that one, so in a worktree with no
// `.env.local` — which is every fresh worktree, the file being gitignored — this
// file went 37-red across its two siblings with a credential-shaped error on a
// route that touches no RLS policy at all. That is the FOURTH red signature
// `/CLAUDE.md` names, in the one direction that makes a red unreadable: it looks
// exactly like a real authorization failure.
//
// MEASURED, not inferred: with the key unset these two route files reported 37
// failures and `api-v1-me-appointments-route.test.ts` — which already carries
// this mock — reported 36/36 green in the same run.
//
// The route's own contract is untouched. `{ ok: false, reason: "MISSING" }` for
// a null header is what makes the `auth_required` case below still exercise the
// handler's real branch; the client object is opaque to this route, which only
// passes it to `requireLiveUser`, itself stubbed above.
vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

vi.mock("@/lib/infra/live-user", () => ({
  requireLiveUser: async () => control.live,
}));

const mockListing = vi.fn();
vi.mock("@/src/modules/adoption/infrastructure/adoption-listing-read", () => ({
  queryAdoptionListing: (...args: unknown[]) => mockListing(...args),
}));

const mockDetail = vi.fn();
vi.mock("@/src/modules/adoption/infrastructure/adoption-detail-read", () => ({
  readAdoptionDetail: (...args: unknown[]) => mockDetail(...args),
}));

const mockSubmit = vi.fn();
vi.mock("@/src/modules/adoption/application/submit-adoption-application", () => ({
  submitAdoptionApplication: (...args: unknown[]) => mockSubmit(...args),
}));

const mockFlush = vi.fn(async () => undefined);
vi.mock("@/src/modules/adoption/infrastructure/notification-flush", () => ({
  flushAdoptionNotifications: (...args: unknown[]) => mockFlush(...(args as [])),
}));

const mockProfile = vi.fn();
const mockExisting = vi.fn();
vi.mock("@/src/modules/adoption/infrastructure/adoption-repository", () => ({
  AdoptionRepository: {
    findApplicantProfile: (...args: unknown[]) => mockProfile(...args),
    findExistingApplication: (...args: unknown[]) => mockExisting(...args),
  },
}));

import { DbBudgetExceededError } from "@/lib/infra/db-budget";
import { RateLimitError } from "@/lib/infra/rate-limit";
import { ADOPTION_APPLICATION_RATE_LIMITED_COPY } from "@/src/modules/adoption/application/adoption-application-limits";

import { GET as GET_DETAIL, POST } from "@/app/api/v1/adoptions/[petToken]/route";
import { GET as GET_CATALOGUE } from "@/app/api/v1/adoptions/route";

const SUBJECT = "0f3f2e4a-2222-4222-8222-abcdefabcdef";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.fake.signature";
const PET_TOKEN = "DIM-ABCD-2345";
const PET_ROW_ID = "8f1d4f4e-0000-4000-8000-000000000001";

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

const params = { params: Promise.resolve({ petToken: PET_TOKEN }) };

/** A listed ficha as the reader hands it over. */
function listedRead() {
  return {
    state: "listed" as const,
    petToken: PET_TOKEN,
    petId: PET_ROW_ID,
    pet: {
      publicToken: PET_TOKEN,
      name: "Lola",
      species: "dog",
      breed: "Mestiza",
      sex: "female",
      color: "Negra",
      distinguishingFeatures: null,
      jurisdictionLocality: "San Carlos de Bariloche",
      jurisdictionProvince: "Río Negro",
      adoptionAgeBucket: "adult" as const,
      adoptionSizeEstimate: "medium" as const,
      adoptionEnergyLevel: "high" as const,
      adoptionStory: null,
      adoptionRequirements: null,
      adoptionGoodWithKids: true,
      adoptionGoodWithDogs: null,
      adoptionGoodWithCats: null,
      adoptionNeedsYard: null,
      adoptionFeeArs: null,
      discloseConditionsPublicly: false,
      permanentConditions: [],
      permanentConditionsOther: null,
    },
    org: {
      publicToken: "ORG-1234",
      displayName: "Refugio Patitas",
      jurisdictionLocality: "Dina Huapi",
      jurisdictionProvince: "Río Negro",
    },
    photoUrls: [],
    health: { hasVaccinations: true, isSterilized: false, hasMicrochip: false },
    livesWithFamily: false,
    custodySince: new Date("2026-07-07T00:00:00.000Z"),
  };
}

const VALID_APPLICATION = {
  housingType: "casa_con_patio",
  motivation: "Quiero adoptar porque tengo tiempo y espacio para cuidarla todos los dias.",
  priorPets: "yes_before",
  profileSharingConsent: true,
};

beforeEach(() => {
  control.cookieDoorTouched = false;
  control.limiterThrows = null;
  control.limits = [];
  control.reported = [];
  control.live = { ok: true, user: { id: SUBJECT } };
  mockListing.mockReset();
  mockDetail.mockReset();
  mockSubmit.mockReset();
  mockFlush.mockClear();
  mockProfile.mockReset().mockResolvedValue({ accountType: "personal" });
  mockExisting.mockReset().mockResolvedValue(null);
});

describe("GET /api/v1/adoptions — the catalogue", () => {
  it("answers with the cards and never with an internal row id", () => {
    mockListing.mockResolvedValue({
      items: [
        {
          petId: PET_ROW_ID,
          petPublicToken: PET_TOKEN,
          name: "Lola",
          species: "dog",
          breed: null,
          sex: "female",
          color: null,
          primaryPhotoId: null,
          primaryPhotoStoragePath: null,
          jurisdictionProvince: null,
          jurisdictionLocality: null,
          hasMicrochip: false,
          adoptionListedAt: new Date("2026-08-01T12:00:00.000Z"),
          adoptionStory: null,
          adoptionRequirements: null,
          adoptionEnergyLevel: null,
          adoptionSizeEstimate: null,
          adoptionAgeBucket: null,
          adoptionGoodWithKids: null,
          adoptionGoodWithDogs: null,
          adoptionGoodWithCats: null,
          adoptionNeedsYard: null,
          adoptionFeeArs: null,
          orgId: "8f1d4f4e-0000-4000-8000-000000000002",
          orgPublicToken: "ORG-1234",
          orgDisplayName: "Refugio Patitas",
          orgAvatarUrl: null,
          isSterilized: false,
          livesWithFamily: false,
        },
      ],
      nextCursor: null,
    });

    return GET_CATALOGUE(request("https://x.test/api/v1/adoptions"))
      .then((res) => Promise.all([res.status, res.json()]))
      .then(([status, body]) => {
        expect(status).toBe(200);
        expect(body.items).toHaveLength(1);
        expect(body.items[0].petToken).toBe(PET_TOKEN);
        expect(JSON.stringify(body)).not.toContain(PET_ROW_ID);
        expect(control.cookieDoorTouched).toBe(false);
      });
  });

  it("passes the web's own filters through, and drops one nobody offers", async () => {
    // A filter is a VIEW, not an assertion: an unrecognised parameter must not
    // 400 a client one release behind out of the catalogue entirely.
    mockListing.mockResolvedValue({ items: [], nextCursor: null });
    const res = await GET_CATALOGUE(
      request("https://x.test/api/v1/adoptions?species=dog&inventado=si"),
    );
    expect(res.status).toBe(200);
    const [filters] = mockListing.mock.calls[0] as [Record<string, unknown>];
    expect(filters.species).toBe("dog");
    expect(filters).not.toHaveProperty("inventado");
  });

  it("echoes the cursor back in the web's own encoding", async () => {
    mockListing.mockResolvedValue({
      items: [],
      nextCursor: { listedAt: "2026-08-01T12:00:00.000Z", id: PET_ROW_ID },
    });
    const res = await GET_CATALOGUE(request("https://x.test/api/v1/adoptions"));
    const body = await res.json();
    expect(body.nextCursor).toBe(`2026-08-01T12:00:00.000Z|${PET_ROW_ID}`);
  });

  it("refuses a caller with no bearer before it reads anything", async () => {
    const res = await GET_CATALOGUE(new Request("https://x.test/api/v1/adoptions"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
    expect(mockListing).not.toHaveBeenCalled();
  });

  it("spends the browse bucket on the caller IP before the guard runs", async () => {
    mockListing.mockResolvedValue({ items: [], nextCursor: null });
    await GET_CATALOGUE(request("https://x.test/api/v1/adoptions"));
    expect(control.limits[0].endpoint).toBe("api_v1_adoptions_read_ip");
    expect(control.limits.some((l) => l.identifier === SUBJECT)).toBe(true);
  });

  it("answers 429 without reading the catalogue when the budget is spent", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(Date.now() + 60_000), "api_v1_adoptions_read_ip");
    };
    const res = await GET_CATALOGUE(request("https://x.test/api/v1/adoptions"));
    expect(res.status).toBe(429);
    expect(mockListing).not.toHaveBeenCalled();
  });

  it("FAILS OPEN when the limiter itself is broken, and says so", async () => {
    // THE DOCBLOCK ON `spendBudget` ARGUES THIS AT LENGTH AND NOTHING MEASURED
    // IT. Five sibling route files carry a test named almost exactly this; the
    // adoption door shipped without one, which is the same reserve the turnos
    // endpoint entered the debts table with.
    //
    // The distinction being pinned: a `RateLimitError` is a SPENT BUDGET and
    // refuses (the test above); anything else is the limiter's own outage —
    // `rate_limit_buckets` unreachable, the pooler saturated — and a browse
    // request must not be refused because our counter is sick.
    //
    // MUTATION APPLIED: `return false` in `spendBudget`'s catch. Red — the
    // catalogue answers 429 during an outage that has nothing to do with the
    // caller. A second mutation, deleting the `reportError` call, is red on the
    // second assertion: failing open SILENTLY is how an outage becomes
    // permanent.
    control.limiterThrows = () => {
      throw new Error("rate_limit_buckets unreachable");
    };
    mockListing.mockResolvedValue({ items: [], nextCursor: null });
    const res = await GET_CATALOGUE(request("https://x.test/api/v1/adoptions"));
    expect(res.status).toBe(200);
    expect(mockListing).toHaveBeenCalled();
    expect(control.reported).toContain("api-v1-adoptions/api_v1_adoptions_read_ip");
  });
});

describe("GET /api/v1/adoptions/{petToken} — the ficha's four answers", () => {
  it("answers 404 for a pet the reader reports gone — an erased pet included", async () => {
    // THE FIFTH SOFT-DELETE SURFACE. The reader is what applies the art. 16
    // filter; this asserts the handler does not soften "gone" into a page that
    // names the animal, which is how a leak would arrive here looking helpful.
    mockDetail.mockResolvedValue({ state: "gone" });
    const res = await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("answers `recently_adopted` with a name and no organization", async () => {
    // Somebody followed a stale share link. The web's own screen says only the
    // pet's name; naming a shelter invites a message it cannot act on.
    mockDetail.mockResolvedValue({
      state: "recently_adopted",
      petToken: PET_TOKEN,
      name: "Lola",
    });
    const res = await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detail.state).toBe("recently_adopted");
    expect(body.detail.name).toBe("Lola");
    expect(body.detail.orgName).toBeNull();
  });

  it("answers `paused` naming the organization that paused it", async () => {
    mockDetail.mockResolvedValue({
      state: "paused",
      petToken: PET_TOKEN,
      name: "Lola",
      orgName: "Refugio Patitas",
    });
    const res = await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    const body = await res.json();
    expect(body.detail.state).toBe("paused");
    expect(body.detail.orgName).toBe("Refugio Patitas");
  });

  it("answers 503 and NOT 404 when the read exceeds its budget", async () => {
    // "Answering 404 to a read failure is the worst lie a public surface can
    // tell" — here it would report an animal as gone to somebody looking for
    // one, and a client cannot tell that apart from a pet that was never
    // listed. The budget error is the one the route is built to translate;
    // anything else propagates, which is Next's 500 and also not a 404.
    mockDetail.mockRejectedValue(new DbBudgetExceededError("api-v1-adoption-detail", 8000));
    const res = await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
  });

  it("answers 503 and NOT an empty catalogue when the listing read times out", async () => {
    // The sibling failure, on the sibling route: "todavía no hay animales en
    // adopción" over a pooler outage tells somebody looking for a companion
    // that the country has none.
    mockListing.mockRejectedValue(new DbBudgetExceededError("api-v1-adoptions-listing", 8000));
    const res = await GET_CATALOGUE(request("https://x.test/api/v1/adoptions"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
  });

  // ---------------------------------------------------------------------------
  // A11-1 — the ficha reused the catalogue's per-IP bucket and spent no
  // per-user one at all: any signed-in account could loop this endpoint at
  // 600/min from one IP with no ceiling across rotating addresses, while every
  // other read in the `authenticated-read` family caps the account at 120/min.
  // ---------------------------------------------------------------------------
  it("spends both the IP and the per-user bucket, reusing the catalogue's user bucket", async () => {
    mockDetail.mockResolvedValue(listedRead());
    await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    expect(control.limits).toEqual([
      { endpoint: "api_v1_adoptions_read_ip", identifier: expect.any(String) },
      { endpoint: "api_v1_adoptions_read_user", identifier: SUBJECT },
    ]);
  });

  it("answers 429 without reading the ficha when a budget is exhausted", async () => {
    mockDetail.mockResolvedValue(listedRead());
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(Date.now() + 60_000), "api_v1_adoptions_read_user");
    };
    const res = await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    expect(res.status).toBe(429);
    expect(mockDetail).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/adoptions/{petToken} — who may apply", () => {
  it("says the caller may apply when nothing blocks them", async () => {
    mockDetail.mockResolvedValue(listedRead());
    const res = await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    const body = await res.json();
    expect(body.detail.canApply).toBe(true);
    expect(body.detail.applyBlockedReason).toBeNull();
  });

  it("blocks an institutional account and says which refusal it is", async () => {
    mockDetail.mockResolvedValue(listedRead());
    mockProfile.mockResolvedValue({ accountType: "institutional" });
    const res = await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    const body = await res.json();
    expect(body.detail.canApply).toBe(false);
    expect(body.detail.applyBlockedReason).toBe("institutional_account");
  });

  it("blocks a caller who already has an unresolved application for THIS pet", async () => {
    mockDetail.mockResolvedValue(listedRead());
    mockExisting.mockResolvedValue({ id: "evt-existing" });
    const res = await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    const body = await res.json();
    expect(body.detail.canApply).toBe(false);
    expect(body.detail.applyBlockedReason).toBe("already_applied");
    // Asked about the pet in the URL and the caller from the GUARD — never a
    // pet id or a user id from anywhere else.
    expect(mockExisting).toHaveBeenCalledWith(PET_ROW_ID, SUBJECT);
  });

  it("never carries a canonical microchip, only the boolean", async () => {
    const read = listedRead();
    read.health.hasMicrochip = true;
    mockDetail.mockResolvedValue(read);
    const res = await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    const body = await res.json();
    expect(body.detail.health.hasMicrochip).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/\d{15}/);
  });
});

describe("GET /api/v1/adoptions/{petToken} — the liveness gate", () => {
  // THE ASYMMETRY THIS CLOSES, measured by mutation before these were written
  // (open-work.md, accepted as a reserve at the 2026-08-30 gate):
  // `if (!live.ok && false) return liveUserRefusal(live.reason);` in the GET
  // handler left 86 files / 1514 tests green, while the identical mutation in
  // POST turned two red — both liveness cases sat inside the POST describe and
  // the two GET describes had none. `createClientFromBearer` parses only the
  // SHAPE of the header and an erased account keeps a syntactically valid JWT
  // (erasure is state in the database, not revocation), so `requireLiveUser` is
  // the single barrier between that account and an adoption ficha — the art. 16
  // class this repo has already been burned by four times. Copied from the POST
  // cases below, plus the half they imply: the read must never have run.
  it("refuses a deactivated account before the read", async () => {
    control.live = { ok: false, reason: "DEACTIVATED" };
    const res = await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_deactivated" });
    expect(mockDetail).not.toHaveBeenCalled();
  });

  it("refuses an erased account before the read", async () => {
    control.live = { ok: false, reason: "ACCOUNT_ERASED" };
    const res = await GET_DETAIL(request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_erased" });
    expect(mockDetail).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/adoptions/{petToken} — postularse", () => {
  function applyRequest(body: unknown) {
    return request(`https://x.test/api/v1/adoptions/${PET_TOKEN}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("submits with the pet from the PATH and the applicant from the GUARD", async () => {
    // The body carries no pet token and the schema has no field for one. A
    // client that tried to name a second animal would be parsed into nothing.
    mockSubmit.mockResolvedValue({ ok: true, value: { eventId: "evt-42" }, notifications: [] });
    const res = await POST(
      applyRequest({ ...VALID_APPLICATION, petPublicToken: "DIM-OTRO-9999" }),
      params,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ applicationId: "evt-42" });
    const [input, deps] = mockSubmit.mock.calls[0] as [
      { petPublicToken: string },
      { applicant: { userId: string } },
    ];
    expect(input.petPublicToken).toBe(PET_TOKEN);
    expect(deps.applicant.userId).toBe(SUBJECT);
  });

  it("flushes the org fan-out after the write, never before it", async () => {
    mockSubmit.mockResolvedValue({
      ok: true,
      value: { eventId: "evt-42" },
      notifications: [{ userId: "coord" }],
    });
    await POST(applyRequest(VALID_APPLICATION), params);
    expect(mockFlush).toHaveBeenCalledOnce();
  });

  it("does not flush anything when the use-case refused", async () => {
    mockSubmit.mockResolvedValue({ ok: false, error: "Ya postulaste para esta mascota." });
    const res = await POST(applyRequest(VALID_APPLICATION), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "adoption_application_refused" });
    expect(mockFlush).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // A5-ciudadanas-02 — an exhausted budget is a 429, not a shelter's refusal
  // -------------------------------------------------------------------------
  //
  // The applicant's own budget (5/min · 15/hr · 30/day) is spent INSIDE the
  // use-case, which reports it as one more `{ ok: false }`. Coming back as
  // `adoption_application_refused` 409 made the app say "El refugio no pudo
  // tomar tu postulación. Volvé a la ficha para ver por qué." — blaming the
  // shelter for a limit the registry imposed, sending the person to a ficha
  // whose `canApply` is still true and still offers "Postularme", and spending
  // more budget on every retry while never saying the real answer, which is wait.
  it("answers an exhausted applicant budget with rate_limited 429", async () => {
    mockSubmit.mockResolvedValue({
      ok: false,
      error: ADOPTION_APPLICATION_RATE_LIMITED_COPY,
    });
    const res = await POST(applyRequest(VALID_APPLICATION), params);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it("says nothing about WHICH budget ran out", async () => {
    // `apiV1Error`'s own docblock: the per-IP and per-user rate-limit answers
    // must stay byte-identical, because only one of them could set an honest
    // `retry-after` and a differing pair tells a caller which bucket it hit.
    mockSubmit.mockResolvedValue({ ok: false, error: ADOPTION_APPLICATION_RATE_LIMITED_COPY });
    const perUser = await POST(applyRequest(VALID_APPLICATION), params);

    control.limiterThrows = () => {
      throw new RateLimitError(new Date(Date.now() + 60_000), "api_v1_adoption_apply_ip");
    };
    const perIp = await POST(applyRequest(VALID_APPLICATION), params);

    expect(perIp.status).toBe(perUser.status);
    expect(await perIp.json()).toEqual(await perUser.json());
    expect(perUser.headers.get("retry-after")).toBeNull();
    expect(perIp.headers.get("retry-after")).toBeNull();
  });

  it("still answers 409 for every OTHER domain refusal", async () => {
    // NON-VACUITY: the new arm keys on the exported constant, not on "the
    // use-case said no".
    mockSubmit.mockResolvedValue({ ok: false, error: "Ya postulaste para esta mascota." });
    const res = await POST(applyRequest(VALID_APPLICATION), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "adoption_application_refused" });
  });

  it("refuses a body the contract schema rejects, without reaching the use-case", async () => {
    const res = await POST(applyRequest({ ...VALID_APPLICATION, motivation: "corto" }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("refuses a submission with consent withheld", async () => {
    // Ley 25.326: consent is an act, not a default. The schema takes
    // `z.literal(true)`, so `false` never reaches the use-case.
    const res = await POST(
      applyRequest({ ...VALID_APPLICATION, profileSharingConsent: false }),
      params,
    );
    expect(res.status).toBe(400);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("spends the APPLY bucket and not the browse one", async () => {
    // The board's WU-U row: the application flow earns its own rate limit. A
    // POST that spent `api_v1_adoptions_read_ip` would run at ten times its
    // intended ceiling and read as deliberate in the family map.
    mockSubmit.mockResolvedValue({ ok: true, value: { eventId: "evt-42" }, notifications: [] });
    await POST(applyRequest(VALID_APPLICATION), params);
    expect(control.limits[0].endpoint).toBe("api_v1_adoption_apply_ip");
    expect(control.limits.map((l) => l.endpoint)).not.toContain("api_v1_adoptions_read_ip");
  });

  it("answers 429 without submitting when the per-IP budget is spent", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(Date.now() + 60_000), "api_v1_adoption_apply_ip");
    };
    const res = await POST(applyRequest(VALID_APPLICATION), params);
    expect(res.status).toBe(429);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("FAILS OPEN on the WRITE too, and the reason is that a second bucket is still closed", async () => {
    // THE HALF OF THE CLAIM THAT NEEDED PROVING. `spendBudget`'s docblock says a
    // limiter outage "does not open unmetered writes into a shelter's queue; it
    // opens a wider pipe to a counter that is still refusing" — the per-APPLICANT
    // budget inside `submitAdoptionApplication`, which fails CLOSED
    // (`applicant-budget-fails-closed.test.ts` pins that half; the two
    // directions are asserted against each other there).
    //
    // Failing open HERE is only defensible because of that. If somebody ever
    // makes the use-case's budget fail open too, this pair of tests is where the
    // combination becomes visible: an outage would then be unmetered writes into
    // every shelter's review queue.
    //
    // MUTATION APPLIED: `return false` in `spendBudget`'s catch. Red. A second,
    // deleting the `reportError` call, is red on the last assertion — a WRITE
    // door that opens silently during an outage is how the outage becomes
    // permanent, and this one opens wider than the read door does.
    control.limiterThrows = () => {
      throw new Error("rate_limit_buckets unreachable");
    };
    mockSubmit.mockResolvedValue({ ok: true, value: { eventId: "evt-42" }, notifications: [] });
    const res = await POST(applyRequest(VALID_APPLICATION), params);
    expect(res.status).toBe(201);
    expect(mockSubmit).toHaveBeenCalled();
    expect(control.reported).toContain("api-v1-adoptions/api_v1_adoption_apply_ip");
  });

  it("answers the envelope, not a raw 500, when the write itself throws", async () => {
    // `adoption_application_failed` WAS DECLARED, DOCUMENTED AND UNREACHABLE.
    // The contract gives it a paragraph, the app gives it es-AR copy, and no
    // path produced it — which was not merely a dead code, it was a hole:
    // `submitAdoptionApplication` returns `{ ok: false }` only for DOMAIN
    // refusals, so a transaction that throws propagated out of the handler and
    // Next answered with something that is not the one-key `{ error }` envelope
    // every `/api/v1` failure is required to be.
    //
    // 500 AND NOT 409, and that distinction is what the app's copy turns into
    // "volvé a intentar" instead of "volvé a la ficha para ver por qué".
    //
    // MUTATIONS APPLIED, both red: delete the try/catch (the handler rejects and
    // this test fails on the rejection), and answer 409
    // `adoption_application_refused` from the catch (a database fault would tell
    // the person the shelter turned them down).
    mockSubmit.mockRejectedValue(new Error("deadlock detected"));
    const res = await POST(applyRequest(VALID_APPLICATION), params);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "adoption_application_failed" });
    expect(control.reported).toContain("api-v1-adoptions/submit");
  });

  it("still answers 409 for a DOMAIN refusal, so the two are not one code", async () => {
    // NON-VACUITY for the test above: a catch that swallowed every non-ok result
    // into 500 would make the refusal unreachable instead, and the app would
    // tell somebody who already applied that something broke.
    mockSubmit.mockResolvedValue({ ok: false, error: "Ya te postulaste para esta mascota." });
    const res = await POST(applyRequest(VALID_APPLICATION), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "adoption_application_refused" });
  });

  it("refuses a deactivated account before the write", async () => {
    control.live = { ok: false, reason: "DEACTIVATED" };
    const res = await POST(applyRequest(VALID_APPLICATION), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_deactivated" });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("refuses an erased account before the write", async () => {
    control.live = { ok: false, reason: "ACCOUNT_ERASED" };
    const res = await POST(applyRequest(VALID_APPLICATION), params);
    expect(res.status).toBe(403);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
