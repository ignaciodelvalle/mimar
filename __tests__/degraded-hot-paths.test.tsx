// The degraded branches of the six hot paths bounded on 2026-10 (engram
// infra/postgres-pipelining-supavisor-hang), rendered with their loaders HUNG.
//
// The loaders are mocked to return promises that never settle: the shape a
// pipelined zero-row query takes through Supavisor, and the shape any read
// takes on a degraded pooler. loadWithTimeout is the REAL one, driven by fake
// timers, so what is under test is the whole chain: the page wires the budget
// around the right read, the budget fires, and the page renders an honest
// state (or, for /inicio, redirects to a page that has one) instead of
// waiting forever. A page that forgot its budget would hang this test.
//
// The omnibox's degraded state is pinned in op-omnibox.test.tsx.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANALYTICS_LOAD_TIMEOUT_MS } from "@/lib/analytics/analytics-load";

/** A promise that never settles. */
function hung<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const NEVER = Symbol("never");

const { selectResults, mocks } = vi.hoisted(() => ({
  /** One entry per `db.select()` call, in order; NEVER (or an empty queue) hangs. */
  selectResults: [] as unknown[],
  mocks: {
    orgProfile: vi.fn(),
    offerings: vi.fn(),
    adoptionListing: vi.fn(),
    libretaEvents: vi.fn(),
    identifications: vi.fn(),
    libretaFaceData: vi.fn(),
    livePets: vi.fn(),
    compliance: vi.fn(),
  },
}));

// ---- framework -------------------------------------------------------------

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-real-ip" ? "198.51.100.7" : null),
  })),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  // loadWithTimeout re-throws Next's own control-flow errors through this.
  unstable_rethrow: () => {},
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

vi.mock("@/lib/observability/report-error", () => ({ reportError: vi.fn() }));

// ---- database: every select chain answers from `selectResults` ---------------

vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  function chain(result: unknown): unknown {
    const settle = (resolve: (v: unknown) => void) => {
      if (result !== NEVER) resolve(result);
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => settle(resolve);
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  }
  return {
    ...schema,
    db: {
      select: () => chain(selectResults.length > 0 ? selectResults.shift() : NEVER),
    },
  };
});

// ---- collaborators ---------------------------------------------------------

vi.mock("@/lib/infra/public-token-throttle", () => ({
  isPublicTokenReadThrottled: async () => false,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/infra/org-public-profile", () => ({
  queryOrgPublicProfile: () => mocks.orgProfile(),
}));
vi.mock("@/lib/infra/org-public-offerings", () => ({
  queryPublicOfferings: () => mocks.offerings(),
}));
vi.mock("@/src/modules/adoption/infrastructure/adoption-listing-read", () => ({
  queryAdoptionListing: () => mocks.adoptionListing(),
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return { ...actual, enforceRateLimit: async () => undefined };
});
vi.mock("@/lib/infra/libreta-share-events", () => ({
  loadSharedLibretaEvents: () => mocks.libretaEvents(),
}));
vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: () => mocks.identifications(),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireOrgAccessByToken: async () => ({ organization: { id: "org-1" } }),
  requireUserOrRedirect: async () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  requireCapability: async () => ({
    error: null,
    organization: { id: "org-1", displayName: "Refugio Uno" },
  }),
}));

vi.mock("@/src/modules/pets/application/tab-data/get-libreta-face-data", () => ({
  getLibretaFaceData: () => mocks.libretaFaceData(),
}));

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: async () => ({ role: "owner" }),
}));
vi.mock("@/lib/infra/role-landing", () => ({ resolveVetLanding: async () => "/org/x" }));
vi.mock("@/lib/analytics/owner-dashboard", () => ({
  fetchLivePetsForCarouselRanking: () => mocks.livePets(),
  fetchComplianceStatesForPets: () => mocks.compliance(),
}));

// ---- harness ---------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  selectResults.length = 0;
  for (const m of Object.values(mocks)) m.mockReset().mockImplementation(() => hung());
});

afterEach(() => {
  vi.useRealTimers();
});

/** Starts `render`, lets every budget expire, and returns its settled outcome. */
async function settleAfterBudgets<T>(render: () => Promise<T>): Promise<T> {
  const pending = render();
  // Attach a handler now so a rejection is never reported as unhandled while
  // the timers advance.
  pending.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(ANALYTICS_LOAD_TIMEOUT_MS + 1_000);
  return pending;
}

async function renderPage(render: () => Promise<React.ReactNode>): Promise<string> {
  const element = await settleAfterBudgets(render);
  return renderToStaticMarkup(element);
}

// ---- the pages ---------------------------------------------------------------

describe("/refugios/[orgToken] with its profile reads hung", () => {
  it("renders a notice with a retry and the way back, not a page that never finishes", async () => {
    const { default: RefugioPage } = await import("@/app/(public)/refugios/[orgToken]/page");
    const html = await renderPage(() =>
      RefugioPage({ params: Promise.resolve({ orgToken: "ORG-1" }) }),
    );
    expect(html).toContain("El perfil del refugio está tardando más de lo normal");
    expect(html).toContain('href="/refugios/ORG-1"');
    expect(html).toContain("Ver todos los refugios");
  });

  it("gives generateMetadata a generic title instead of holding the response", async () => {
    const { generateMetadata } = await import("@/app/(public)/refugios/[orgToken]/page");
    const metadata = await settleAfterBudgets(() =>
      generateMetadata({ params: Promise.resolve({ orgToken: "ORG-1" }) }),
    );
    expect(metadata).toEqual({ title: "Refugio — miMAR" });
  });
});

describe("/libreta/compartir/[shareToken] with its reads hung", () => {
  it("share row hung: a retry notice that does not vouch for the link", async () => {
    const { default: SharePage } = await import("@/app/libreta/compartir/[shareToken]/page");
    const html = await renderPage(() =>
      SharePage({ params: Promise.resolve({ shareToken: "SHARE-1" }) }),
    );
    expect(html).toContain("La libreta está tardando más de lo normal");
    expect(html).toContain('href="/libreta/compartir/SHARE-1"');
    expect(html).not.toContain("sigue siendo válido");
  });

  it("events hung after a valid share: the notice says the link is still valid", async () => {
    selectResults.push(
      [
        {
          id: "s1",
          petId: "p1",
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date(0),
          ownerDisplayName: "Ana",
        },
      ],
      [
        {
          id: "p1",
          name: "Luna",
          species: "dog",
          breed: null,
          sex: "female",
          publicToken: "DIM-AAAA-0001",
          status: "active",
          primaryPhotoId: null,
        },
      ],
    );
    const { default: SharePage } = await import("@/app/libreta/compartir/[shareToken]/page");
    const html = await renderPage(() =>
      SharePage({ params: Promise.resolve({ shareToken: "SHARE-1" }) }),
    );
    expect(html).toContain("La libreta está tardando más de lo normal");
    expect(html).toContain("El enlace sigue siendo válido.");
    // Nothing of the libreta, and no view logged for it.
    expect(html).not.toContain("Vista de solo lectura");
  });
});

describe("/org/[orgToken]/agenda with its reads hung", () => {
  it("keeps the crumbs, header and day navigation, and shows the fallback with a retry", async () => {
    const { default: AgendaPage } = await import("@/app/org/[orgToken]/agenda/page");
    const html = await renderPage(() =>
      AgendaPage({
        params: Promise.resolve({ orgToken: "ORG-1" }),
        searchParams: Promise.resolve({ fecha: "2026-10-06" }),
      }),
    );
    expect(html).toContain("Agenda del día");
    expect(html).toContain("Refugio Uno");
    expect(html).toContain('href="/org/ORG-1/agenda?fecha=2026-10-05"');
    expect(html).toContain('href="/org/ORG-1/agenda?fecha=2026-10-07"');
    expect(html).toContain("Los datos están tardando más de lo normal");
    expect(html).toContain('href="/org/ORG-1/agenda?fecha=2026-10-06"');
    expect(html).not.toContain("Cupos del día");
  });
});

describe("the Libreta face with its read hung", () => {
  it("says the libreta is taking too long instead of a skeleton that never resolves", async () => {
    const { LibretaFaceSection } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/LibretaFaceSection"
    );
    type Props = Parameters<typeof LibretaFaceSection>[0];
    const props = {
      user: { id: "user-1" },
      pet: { publicToken: "DIM-AAAA-0001" },
      accessPath: "owner",
      organization: null,
      holderRole: "titular",
      isOwner: true,
      emergencyContacts: null,
    } as unknown as Props;
    const html = await renderPage(() => LibretaFaceSection(props));
    expect(html).toContain("La libreta está tardando más de lo normal.");
    expect(html).toContain('role="alert"');
  });
});

describe("/inicio with its reads hung", () => {
  const searchParams = Promise.resolve({ sheet: "anotar" });

  it("live-pets read hung: lands on the index, query forwarded", async () => {
    const { default: InicioPage } = await import("@/app/(app)/inicio/page");
    await expect(settleAfterBudgets(() => InicioPage({ searchParams }))).rejects.toThrow(
      "REDIRECT:/mis-mascotas?sheet=anotar",
    );
  });

  it("compliance read hung: lands on the index too, never on a partially ranked pet", async () => {
    mocks.livePets.mockImplementation(async () => [
      { id: "p1", publicToken: "DIM-AAAA-0001", status: "active", pregnancyStatus: null },
    ]);
    const { default: InicioPage } = await import("@/app/(app)/inicio/page");
    await expect(settleAfterBudgets(() => InicioPage({ searchParams }))).rejects.toThrow(
      "REDIRECT:/mis-mascotas?sheet=anotar",
    );
  });
});
