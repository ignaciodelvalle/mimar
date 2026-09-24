// The landing layout's 404 gate (2026-09-23; reworked after pre-push review).
//
// An unknown token under `/p/[publicToken]` answered HTTP 200 with the
// not-found body: `loading.tsx` wraps the page (and `/encontre`, `/sighting`)
// in a Suspense boundary, so the page's own `notFound()` fired after a 200 had
// streamed. The layout wraps that boundary, so a `notFound()` thrown HERE still
// sets a real 404. It reads through the memoised, throttled probe
// (./credential-probe.ts) — this file pins the DECISION the layout takes on
// each probe answer and the surface it charges; credential-probe.test.ts pins
// the one-charge-per-render property. The wire-level status is proven by curl
// against `next start` (see the commit), which Vitest cannot run.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: the probe — the one thing this test controls per case. The pure
// surface mapper stays REAL, so the bucket choice is exercised end to end.
// ---------------------------------------------------------------------------

const mockProbe = vi.fn();
let prefetchRender = false;
vi.mock("@/app/(public)/p/[publicToken]/credential-probe", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/(public)/p/[publicToken]/credential-probe")>();
  return {
    ...actual,
    probePublicCredential: (token: string, surface: string) => mockProbe(token, surface),
    // Its real reading of Next's work store is pinned in credential-probe.test.ts.
    isRouterPrefetchRender: () => prefetchRender,
  };
});

let xPathname: string | null = "/p/DIM-PAMP-0001";
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers(xPathname === null ? {} : { "x-pathname": xPathname })),
}));

// ---------------------------------------------------------------------------
// Mock: session read — irrelevant to this gate, stubbed to "logged out".
// ---------------------------------------------------------------------------

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}));

// AppShell — JSX creation never invokes it; the stub keeps its dependency tree out.
function MockAppShell({ children }: { children?: unknown }) {
  return children ?? null;
}
vi.mock("@/components/layout/AppShell", () => ({ AppShell: MockAppShell }));

async function renderLayout(publicToken = "DIM-PAMP-0001") {
  const { default: Layout } = await import("@/app/(public)/p/[publicToken]/layout");
  return Layout({ children: "CHILD", params: Promise.resolve({ publicToken }) });
}

/** The `children` the layout handed to AppShell, read off the returned element. */
function renderedChildren(element: unknown): unknown {
  return (element as { props: { children: unknown } }).props.children;
}

describe("PublicCredentialLandingLayout — 404 gate outside the Suspense boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    xPathname = "/p/DIM-PAMP-0001";
    prefetchRender = false;
  });

  it("throws notFound() (digest ;404) when the probe answers not_found", async () => {
    mockProbe.mockResolvedValue({ status: "not_found" });
    await expect(renderLayout("DIM-0000-0000")).rejects.toMatchObject({
      digest: expect.stringContaining(";404"),
    });
  });

  it.each([
    ["found", { status: "found", row: { pet: {}, photo: null } }],
    [
      "throttled — the page shows its own notice; a limited caller learns nothing",
      {
        status: "throttled",
      },
    ],
    [
      "unavailable — an outage is never 'does not exist'; the page degrades",
      {
        status: "unavailable",
        error: new Error("db down"),
      },
    ],
  ])("renders children and does NOT 404 when the probe answers %s", async (_label, answer) => {
    mockProbe.mockResolvedValue(answer);
    const element = await renderLayout();
    expect(renderedChildren(element)).toBe("CHILD");
  });

  it("probes with the RAW route param — canonicalisation is middleware's job", async () => {
    mockProbe.mockResolvedValue({ status: "found", row: { pet: {}, photo: null } });
    await renderLayout("DIM-PAMP-0001");
    expect(mockProbe).toHaveBeenCalledWith("DIM-PAMP-0001", "page");
  });

  it.each([
    ["/p/DIM-PAMP-0001", "page"],
    ["/p/DIM-PAMP-0001/encontre", "encontre"],
    ["/p/DIM-PAMP-0001/sighting", "sighting"],
    [null, "page"],
  ])(
    "charges the bucket of the route rendering (%s → %s), never a second one",
    async (path, surface) => {
      xPathname = path;
      mockProbe.mockResolvedValue({ status: "found", row: { pet: {}, photo: null } });
      await renderLayout();
      expect(mockProbe).toHaveBeenCalledTimes(1);
      expect(mockProbe).toHaveBeenCalledWith("DIM-PAMP-0001", surface);
    },
  );
});

describe("PublicCredentialLandingLayout — router prefetches are never probed (re-review F1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xPathname = "/p/DIM-PAMP-0001";
    prefetchRender = false;
  });

  it("skips the probe on a router prefetch and renders children — nothing read, no limiter spent", async () => {
    prefetchRender = true;
    mockProbe.mockResolvedValue({ status: "not_found" });
    const element = await renderLayout("DIM-0000-0000");
    expect(mockProbe).not.toHaveBeenCalled();
    expect(renderedChildren(element)).toBe("CHILD");
  });

  it("CONTROL: the same request that is NOT a prefetch is probed and 404s", async () => {
    prefetchRender = false;
    mockProbe.mockResolvedValue({ status: "not_found" });
    await expect(renderLayout("DIM-0000-0000")).rejects.toMatchObject({
      digest: expect.stringContaining(";404"),
    });
    expect(mockProbe).toHaveBeenCalledTimes(1);
  });
});

describe("PublicCredentialLandingLayout — the probe wait is bounded (re-review F5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xPathname = "/p/DIM-PAMP-0001";
    prefetchRender = false;
  });

  it("falls through to children after LAYOUT_PROBE_BUDGET_MS when the probe hangs", async () => {
    const { LAYOUT_PROBE_BUDGET_MS } = await import(
      "@/app/(public)/p/[publicToken]/credential-probe"
    );
    expect(LAYOUT_PROBE_BUDGET_MS).toBe(1500);
    vi.useFakeTimers();
    try {
      mockProbe.mockReturnValue(new Promise(() => {})); // a hung DB
      const pending = renderLayout();
      await vi.advanceTimersByTimeAsync(LAYOUT_PROBE_BUDGET_MS - 1);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(renderedChildren(await pending)).toBe("CHILD");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a not_found that arrives inside the budget still 404s", async () => {
    vi.useFakeTimers();
    try {
      mockProbe.mockReturnValue(
        new Promise((resolve) => setTimeout(() => resolve({ status: "not_found" }), 1000)),
      );
      const pending = renderLayout("DIM-0000-0000");
      const assertion = expect(pending).rejects.toMatchObject({
        digest: expect.stringContaining(";404"),
      });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a not_found that arrives AFTER the budget (1600ms) renders children instead of 404ing — the documented trade-off", async () => {
    // Unlike the case above (answer at 1000ms, inside the 1500ms budget), this
    // probe resolves not_found at 1600ms — past LAYOUT_PROBE_BUDGET_MS. The
    // header comment's "WHAT THE GATE COSTS A VISITOR" section says exactly
    // this: what a timeout gives up is the real 404 for that one slow request;
    // an unknown token then falls through to the page's own in-stream
    // not-found body with a 200, which is what this test pins — the layout
    // itself must not 404 once its own budget has already elapsed.
    vi.useFakeTimers();
    try {
      mockProbe.mockReturnValue(
        new Promise((resolve) => setTimeout(() => resolve({ status: "not_found" }), 1600)),
      );
      const pending = renderLayout("DIM-0000-0000");
      await vi.advanceTimersByTimeAsync(1500);
      expect(renderedChildren(await pending)).toBe("CHILD");
    } finally {
      vi.useRealTimers();
    }
  });
});
