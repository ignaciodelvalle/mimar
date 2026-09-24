// Three anonymous pages that spent no rate-limit bucket at all until 2026-09-18
// (audit 2026-09-fresh, A03-G7 and A03-3):
//
//   /perdidas              the bulk lost-pet feed           → `lost_listing`
//   /refugios/{orgToken}   a shelter's public profile      → `org_public_profile`
//   /r/invite/{token}      an organization invitation      → `invite_resolve`
//
// For each: the bucket is keyed on the caller's address with the derived
// ceiling, it runs BEFORE the first read, a throttled caller gets a notice and
// causes no read at all, and a limiter that is itself failing lets the page
// through (fail-open, the contract of `isPublicTokenReadThrottled`).
//
// The limiter is mocked at `enforceRateLimit`, one layer below the helper the
// pages call, so the IP derivation, the budget race and the fail-open branch
// in lib/infra/public-token-throttle.ts are the real ones. Every expected
// ceiling is written out here rather than imported.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CALLER_IP = "198.51.100.23";

const {
  MockRateLimitError,
  callOrder,
  mockEnforceRateLimit,
  mockQueryLost,
  mockCountAll,
  mockCountWindow,
  mockOrgProfile,
  mockOfferings,
  mockAdoptionListing,
  mockGetUser,
  inviteRows,
} = vi.hoisted(() => {
  class MockRateLimitError extends Error {
    resetAt: Date;
    reason: string;
    constructor(resetAt: Date, reason: string) {
      super(`Rate limit exceeded: ${reason}`);
      this.name = "RateLimitError";
      this.resetAt = resetAt;
      this.reason = reason;
    }
  }
  return {
    MockRateLimitError,
    callOrder: [] as string[],
    mockEnforceRateLimit: vi.fn(),
    mockQueryLost: vi.fn(),
    mockCountAll: vi.fn(),
    mockCountWindow: vi.fn(),
    mockOrgProfile: vi.fn(),
    mockOfferings: vi.fn(),
    mockAdoptionListing: vi.fn(),
    mockGetUser: vi.fn(),
    inviteRows: { value: [] as unknown[] },
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-real-ip" ? CALLER_IP : null),
  })),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: (endpoint: string, id: string, cfg: unknown) => {
      callOrder.push("limiter");
      return mockEnforceRateLimit(endpoint, id, cfg);
    },
    RateLimitError: MockRateLimitError,
  };
});

// The fail-open branch reports the limiter failure; the report is not the
// subject here.
vi.mock("@/lib/infra/report-error", () => ({ reportError: vi.fn() }));

// --- /perdidas collaborators ------------------------------------------------

vi.mock("@/src/modules/lost/infrastructure/lost-listing-read", () => ({
  queryLostListing: (...args: unknown[]) => {
    callOrder.push("lost-listing");
    return mockQueryLost(...args);
  },
  countAllLost: () => mockCountAll(),
  countLostInWindow: (ms: number) => mockCountWindow(ms),
}));

// A client component with a locality picker behind it; the page's own
// markup is what is under test.
vi.mock("@/app/(public)/perdidas/LostFiltersBar", () => ({
  LostFiltersBar: () => <div data-testid="filters-bar" />,
}));

// --- /refugios/{orgToken} collaborators -------------------------------------

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    callOrder.push("session");
    return { auth: { getUser: mockGetUser } };
  },
}));

vi.mock("@/lib/infra/org-public-profile", () => ({
  queryOrgPublicProfile: (...args: unknown[]) => {
    callOrder.push("org-profile");
    return mockOrgProfile(...args);
  },
}));

vi.mock("@/lib/infra/org-public-offerings", () => ({
  queryPublicOfferings: (...args: unknown[]) => mockOfferings(...args),
}));

vi.mock("@/src/modules/adoption/infrastructure/adoption-listing-read", () => ({
  queryAdoptionListing: (...args: unknown[]) => mockAdoptionListing(...args),
}));

// --- /r/invite/{token} collaborator: the invitation read --------------------

vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => inviteRows.value,
  };
  return {
    ...schema,
    db: {
      select: () => {
        callOrder.push("db-select");
        return chain;
      },
    },
  };
});

import PerdidasPage from "@/app/(public)/perdidas/page";
import RefugioPage from "@/app/(public)/refugios/[orgToken]/page";
import InviteAcceptPage from "@/app/r/invite/[token]/page";

const throttle = () =>
  mockEnforceRateLimit.mockRejectedValue(new MockRateLimitError(new Date(), "test"));

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockQueryLost.mockResolvedValue({ items: [], nextCursor: null });
  mockCountAll.mockResolvedValue(0);
  mockCountWindow.mockResolvedValue(0);
  mockOrgProfile.mockResolvedValue(null);
  mockOfferings.mockResolvedValue([]);
  mockAdoptionListing.mockResolvedValue({ items: [], nextCursor: null });
  mockGetUser.mockResolvedValue({ data: { user: null } });
  inviteRows.value = [];
});

describe("/perdidas — lost_listing", () => {
  const render = async () =>
    renderToStaticMarkup(await PerdidasPage({ searchParams: Promise.resolve({}) }));

  it("keys the bucket on the caller's address at 120/min + 3,600/hr, before the listing read", async () => {
    await render();
    expect(mockEnforceRateLimit).toHaveBeenCalledWith("lost_listing", CALLER_IP, {
      maxPerMinute: 120,
      maxPerHour: 3_600,
    });
    expect(callOrder.indexOf("limiter")).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf("limiter")).toBeLessThan(callOrder.indexOf("lost-listing"));
  });

  it("throttled: keeps the page's chrome, says so, and reads nothing", async () => {
    throttle();
    const html = await render();

    expect(html).toContain("Recibimos muchas consultas desde tu conexión");
    expect(html).toContain("Esperá un minuto");
    // The chrome is still there: heading, filters, the owner CTA.
    expect(html).toContain("perdidas");
    expect(html).toContain('data-testid="filters-bar"');
    expect(html).toContain("¿Perdiste a tu mascota?");
    // Neither of the two states that would lie about the board.
    expect(html).not.toContain("No hay mascotas reportadas como perdidas");
    expect(html).not.toContain("No pudimos cargar el listado");

    expect(mockQueryLost).not.toHaveBeenCalled();
    expect(mockCountAll).not.toHaveBeenCalled();
    expect(mockCountWindow).not.toHaveBeenCalled();
  });

  it("fails open when the limiter itself is down", async () => {
    mockEnforceRateLimit.mockRejectedValue(new Error("pooler down"));
    const html = await render();
    expect(mockQueryLost).toHaveBeenCalledTimes(1);
    expect(html).not.toContain("Recibimos muchas consultas");
  });
});

describe("/refugios/{orgToken} — org_public_profile", () => {
  const params = { params: Promise.resolve({ orgToken: "ORG-REFU-2345" }) };

  it("keys the bucket on the caller's address at 120/min + 3,600/hr, before the session and every query", async () => {
    await expect(RefugioPage(params)).rejects.toThrow("NOT_FOUND");
    expect(mockEnforceRateLimit).toHaveBeenCalledWith("org_public_profile", CALLER_IP, {
      maxPerMinute: 120,
      maxPerHour: 3_600,
    });
    expect(callOrder[0]).toBe("limiter");
    expect(callOrder).toContain("session");
    expect(callOrder).toContain("org-profile");
  });

  it("throttled: a notice, no GoTrue round-trip, no query", async () => {
    throttle();
    const html = renderToStaticMarkup(await RefugioPage(params));

    expect(html).toContain("Demasiadas consultas");
    expect(html).toContain("Esperá un minuto");
    expect(callOrder).toEqual(["limiter"]);
    expect(mockOrgProfile).not.toHaveBeenCalled();
    expect(mockAdoptionListing).not.toHaveBeenCalled();
    expect(mockOfferings).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("fails open when the limiter itself is down", async () => {
    mockEnforceRateLimit.mockRejectedValue(new Error("pooler down"));
    await expect(RefugioPage(params)).rejects.toThrow("NOT_FOUND");
    expect(mockOrgProfile).toHaveBeenCalledWith("ORG-REFU-2345");
  });
});

describe("/r/invite/{token} — invite_resolve", () => {
  const params = { params: Promise.resolve({ token: "INV-ABCD-2345" }) };

  it("keys the bucket on the caller's address at 60/min + 300/hr, before the invitation read", async () => {
    const html = renderToStaticMarkup(await InviteAcceptPage(params));
    expect(html).toContain("Invitación no encontrada");
    expect(mockEnforceRateLimit).toHaveBeenCalledWith("invite_resolve", CALLER_IP, {
      maxPerMinute: 60,
      maxPerHour: 300,
    });
    expect(callOrder.slice(0, 2)).toEqual(["limiter", "db-select"]);
  });

  it("throttled: a notice, and the invitation is never read", async () => {
    throttle();
    const html = renderToStaticMarkup(await InviteAcceptPage(params));
    expect(html).toContain("Demasiadas consultas");
    expect(html).toContain("volvé a abrir el link de la invitación");
    expect(callOrder).toEqual(["limiter"]);
    // None of the four states the oracle used to answer with.
    expect(html).not.toContain("Invitación no encontrada");
  });
});
