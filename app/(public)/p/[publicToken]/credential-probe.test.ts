// One visit to /p/{token} = ONE throttle charge and ONE pet-row read
// (2026-09-23, the property the pre-push review made mandatory).
//
// The landing layout's 404 gate, the page's door and `generateMetadata` all
// need the same two facts — "is this caller over the limit?" and "does this
// token resolve?" — in the same request. The limiter INCREMENTS on every call,
// so three honest callers were three charges until both answers were memoised
// per request with `React.cache`.
//
// WHY `cache` IS REPLACED HERE. Outside a React server render (vitest, route
// handlers, scripts) React's `cache` does not memoise — it is a passthrough —
// so a test over the real one could not tell a memoised call from a repeated
// one. The stand-in below is the same contract (per-scope memo keyed by
// argument identity, a fresh scope per request) with the scope made explicit:
// `newRequest()` is what Next does between two HTTP requests.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// React.cache stand-in — an explicit per-request scope.
// ---------------------------------------------------------------------------

const cacheScope = vi.hoisted(() => ({ store: new Map<unknown, Map<string, unknown>>() }));

// Next's server runtime installs `AsyncLocalStorage` on globalThis before any
// of its storage modules load (next/dist/server/node-environment); vitest does
// not. Installed here, BEFORE the imports below evaluate, so the real
// work-store module builds a real storage instead of its throwing stub.
await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        let memo = cacheScope.store.get(fn);
        if (!memo) {
          memo = new Map();
          cacheScope.store.set(fn, memo);
        }
        // Primitive and module-constant arguments only (the contract the
        // real callers keep), so identity of each argument is the key.
        const key = args
          .map((a) => (typeof a === "object" ? `obj:${objectId(a)}` : String(a)))
          .join("|");
        if (!memo.has(key)) memo.set(key, fn(...args));
        return memo.get(key) as R;
      },
  };
});

const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;
function objectId(o: unknown): number {
  const obj = o as object;
  let id = objectIds.get(obj);
  if (id === undefined) {
    nextObjectId += 1;
    id = nextObjectId;
    objectIds.set(obj, id);
  }
  return id;
}

function newRequest() {
  cacheScope.store = new Map();
}

// ---------------------------------------------------------------------------
// The limiter's storage and the database — counted, not faked in behaviour.
// ---------------------------------------------------------------------------

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-real-ip": "198.51.100.7" })),
}));

const { mockEnforceRateLimit } = vi.hoisted(() => ({
  mockEnforceRateLimit: vi.fn(),
}));
vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: (bucket: string, key: string, cfg: unknown) =>
      mockEnforceRateLimit(bucket, key, cfg),
  };
});

const { mockSelect, rowResult } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  rowResult: { current: [] as unknown[] | Error },
}));
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: async () => {
      if (rowResult.current instanceof Error) throw rowResult.current;
      return rowResult.current;
    },
  };
  return {
    ...actual,
    db: {
      select: (...args: unknown[]) => {
        mockSelect(...args);
        return chain;
      },
    },
  };
});

const mockReportError = vi.fn();
vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

vi.mock("@/src/modules/pets/application/read/load-public-credential", () => ({
  loadCredentialViewData: vi.fn(async () => ({ stub: "view-data" })),
}));

import {
  PUBLIC_TOKEN_READ_LIMIT,
  isPublicTokenReadThrottled,
  publicTokenThrottle,
} from "@/lib/infra/public-token-throttle";
import { RateLimitError } from "@/lib/infra/rate-limit";
import { lookupPublicCredential } from "@/src/modules/pets/application/read/lookup-public-credential";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";

import {
  credentialSurfaceFromPath,
  isRouterPrefetchRender,
  pageLookupDeps,
  probePublicCredential,
} from "./credential-probe";

const TOKEN = "DIM-PAMP-0001";
const PET = { id: "pet-1", publicToken: TOKEN, name: "Pampa", status: "active" };
const ROW = { pet: PET, photo: null };

/** What one render of /p/{token} does, in the order Next may run it. */
async function renderCredentialPage(token = TOKEN) {
  // 1. layout.tsx — the 404 gate
  const gate = await probePublicCredential(token, "page");
  // 2. page.tsx — the door, with the page's own throttle port and deps
  const lookup = await lookupPublicCredential(
    { publicToken: token, throttle: publicTokenThrottle("public_token_page") },
    pageLookupDeps,
  );
  // 3. generateMetadata — the same probe
  const metadataProbe = await probePublicCredential(token, "page");
  return { gate, lookup, metadataProbe };
}

beforeEach(() => {
  vi.clearAllMocks();
  newRequest();
  mockEnforceRateLimit.mockResolvedValue(undefined);
  rowResult.current = [ROW];
});

describe("one render = one throttle charge and one row read", () => {
  it("layout + page door + metadata charge `public_token_page` ONCE and read the row ONCE", async () => {
    const { gate, lookup, metadataProbe } = await renderCredentialPage();

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      "public_token_page",
      "198.51.100.7",
      PUBLIC_TOKEN_READ_LIMIT,
    );
    expect(mockSelect).toHaveBeenCalledTimes(1);

    expect(gate).toEqual({ status: "found", row: ROW });
    expect(metadataProbe).toBe(gate);
    expect(lookup).toMatchObject({ status: "ok", pet: PET, data: { stub: "view-data" } });
  });

  it("is PER REQUEST, not global: a second request is charged again", async () => {
    await renderCredentialPage();
    newRequest();
    await renderCredentialPage();
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("CONTROL: without the per-request memo the same render would charge three times", async () => {
    // Proves the assertion above has teeth: each caller really does reach the
    // limiter on its own when nothing is shared.
    await probePublicCredential(TOKEN, "page");
    newRequest();
    await lookupPublicCredential(
      { publicToken: TOKEN, throttle: publicTokenThrottle("public_token_page") },
      pageLookupDeps,
    );
    newRequest();
    await probePublicCredential(TOKEN, "page");
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(3);
  });

  it("a sibling (/encontre) pays ONE charge on its OWN bucket and nothing on public_token_page", async () => {
    // layout gate for the /encontre render, then the page's own direct guard
    await probePublicCredential(TOKEN, credentialSurfaceFromPath(`/p/${TOKEN}/encontre`));
    await isPublicTokenReadThrottled("public_token_encontre");

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      "public_token_encontre",
      "198.51.100.7",
      PUBLIC_TOKEN_READ_LIMIT,
    );
  });
});

describe("each surface charges its OWN literal bucket", () => {
  it.each([
    ["page", "public_token_page"],
    ["encontre", "public_token_encontre"],
    ["sighting", "public_token_sighting"],
  ] as const)("%s → %s, once", async (surface, bucket) => {
    await probePublicCredential(TOKEN, surface);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      bucket,
      "198.51.100.7",
      PUBLIC_TOKEN_READ_LIMIT,
    );
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });
});

describe("isRouterPrefetchRender — reads the flag Next records for the render", () => {
  // Next hides the prefetch HEADERS from `headers()` (measured on the wire; see
  // the docblock), so the helper reads Next's own work store. These run it
  // against the REAL store module, not a stand-in, so a Next upgrade that
  // moves or renames it fails here before it fails in production.
  type Store = Parameters<typeof workAsyncStorage.run>[0];
  const run = (flag: boolean | undefined) =>
    workAsyncStorage.run({ isPrefetchRequest: flag } as unknown as Store, () =>
      isRouterPrefetchRender(),
    );

  it("true inside a prefetch render", () => {
    expect(run(true)).toBe(true);
  });

  it.each([false, undefined])(
    "false when the flag is %s — the probe runs (fails toward charging)",
    (flag) => {
      expect(run(flag)).toBe(false);
    },
  );

  it("false outside any render (no store at all)", () => {
    expect(isRouterPrefetchRender()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CANARY — the wiring `isRouterPrefetchRender` depends on, read from Next's OWN
// installed source rather than trusted from behaviour.
//
// WHY A CANARY AND NOT JUST THE TEST ABOVE. `run()` above proves this file
// reads `workAsyncStorage.getStore()?.isPrefetchRequest` correctly — but it
// asserts against a HARNESS the test itself builds (`workAsyncStorage.run({
// isPrefetchRequest: flag }, …)`), which would keep passing even if Next
// stopped setting that field from the request header at all. The docblock on
// `isRouterPrefetchRender` claims this is "pinned three ways": the Next
// version is locked (package.json, checked in the test below too — a caret
// range would let `pnpm install` silently move the file this reads), this
// suite exercises the real store, and the commit carries curl evidence. None
// of the three previously re-read Next's actual source on every run — an
// engine bump could rewrite `app-render.js` and nothing here would notice
// until the wire behaviour changed in production. This describe block reads
// the installed `next` package's source directly and fails loudly if either
// line it depends on is gone.
// ---------------------------------------------------------------------------

describe("CANARY — Next's own source still wires isPrefetchRequest the way this file assumes", () => {
  const NEXT_ROOT = join(__dirname, "..", "..", "..", "..", "node_modules", "next");

  it("pins the exact installed Next version this canary was written against", () => {
    const { version } = JSON.parse(readFileSync(join(NEXT_ROOT, "package.json"), "utf8"));
    expect(version).toBe("15.5.24");
  });

  it("app-render.js still assigns isPrefetchRequest from the prefetch header", () => {
    const src = readFileSync(join(NEXT_ROOT, "dist/server/app-render/app-render.js"), "utf8");
    // The exact shape today: `const isPrefetchRequest = … headers[…
    // NEXT_ROUTER_PREFETCH_HEADER] === '1';`. A regex, not a plain substring,
    // because the LHS and the header check are what this file's contract
    // depends on — an unrelated line merely mentioning the header must not
    // satisfy this.
    expect(src).toMatch(/isPrefetchRequest\s*=[^;]*NEXT_ROUTER_PREFETCH_HEADER\]\s*===\s*'1'/);
  });

  it("work-store.js still threads isPrefetchRequest into the store createWorkStore returns", () => {
    const src = readFileSync(join(NEXT_ROOT, "dist/server/async-storage/work-store.js"), "utf8");
    // createWorkStore takes isPrefetchRequest as a named parameter AND places
    // it on the object it builds — both required, or the store this file reads
    // (`workAsyncStorage.getStore()?.isPrefetchRequest`) would be undefined.
    expect(src).toMatch(/function createWorkStore\([^)]*\bisPrefetchRequest\b[^)]*\)/);
    const occurrences = src.split("isPrefetchRequest").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe("the probe's four answers", () => {
  it("throttled: no pet row is read, and the door answers throttled on the same charge", async () => {
    mockEnforceRateLimit.mockRejectedValue(new RateLimitError(new Date(), "minute"));
    const { gate, lookup, metadataProbe } = await renderCredentialPage();

    expect(gate).toEqual({ status: "throttled" });
    expect(metadataProbe).toEqual({ status: "throttled" });
    expect(lookup).toEqual({ status: "throttled" });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
  });

  it("not_found: the gate and the door agree", async () => {
    rowResult.current = [];
    const { gate, lookup } = await renderCredentialPage("DIM-0000-0000");
    expect(gate).toEqual({ status: "not_found" });
    expect(lookup).toEqual({ status: "not_found" });
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("unavailable: an outage is not 'not found' — the door degrades and reports ONCE", async () => {
    const boom = new Error("db down");
    rowResult.current = boom;
    const { gate, lookup } = await renderCredentialPage();

    expect(gate).toEqual({ status: "unavailable", error: boom });
    expect(lookup).toEqual({ status: "degraded", publicToken: TOKEN });
    // The probe itself stays silent; the door reports the one failure.
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith("public-credential/pet-row", boom, {
      publicToken: TOKEN,
    });
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });
});

describe("credentialSurfaceFromPath", () => {
  it.each([
    [`/p/${TOKEN}`, "page"],
    [`/p/${TOKEN}/encontre`, "encontre"],
    [`/p/${TOKEN}/sighting`, "sighting"],
    [`/p/${TOKEN}/sighting/`, "sighting"],
    [`/p/${TOKEN}/encontrex`, "page"],
    [`/p/${TOKEN}/opengraph-image`, "page"],
    [null, "page"],
    [undefined, "page"],
  ])("%s → %s", (path, surface) => {
    expect(credentialSurfaceFromPath(path)).toBe(surface);
  });
});
