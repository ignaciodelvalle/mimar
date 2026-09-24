// Route tests for GET /transparencia/datos/[dataset].
//
// The DB-backed dataset build is mocked (targeted vitest — no DB). We assert the
// route's contract: 404 for an unknown slug, format negotiation (json default /
// csv), download filename, the self-describing metadata headers, the per-IP
// rate limit (429 shape, limiter mocked), and the generic-500 error path (no
// internal detail leaked to an anonymous caller).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { type BuiltDataset, OPEN_DATA_LICENSE } from "@/lib/open-data/datasets";

// unstable_cache: pass the function through unchanged (no data cache in tests).
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

// Mock only the DB-backed builder; keep isDatasetId / DATASET_IDS real.
// vi.hoisted so the fn exists before the hoisted vi.mock factory runs.
const { buildDataset } = vi.hoisted(() => ({ buildDataset: vi.fn() }));
vi.mock("@/lib/open-data/datasets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/open-data/datasets")>();
  return { ...actual, buildDataset };
});

// Mock the rate limiter so tests control its outcome without touching the DB.
// callerIp is stubbed to a fixed value; RateLimitError is the REAL class (so
// `instanceof` checks in the route still work against instances we throw).
const { enforceRateLimit } = vi.hoisted(() => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return { ...actual, enforceRateLimit, callerIp: () => "203.0.113.1" };
});

import { RateLimitError } from "@/lib/infra/rate-limit";
import { GET } from "../route";

const fakeBuilt: BuiltDataset = {
  meta: {
    id: "mortalidad",
    title: "Fallecimientos registrados",
    summary: "resumen",
    unit: "una fila por provincia",
    cadence: "diaria",
    license: OPEN_DATA_LICENSE,
    methodologyUrl: "https://www.mimar.gob.ar/transparencia#metodologia",
    dictionaryUrl: "https://www.mimar.gob.ar/transparencia#diccionario",
    generatedAt: "2026-07-15T00:00:00.000Z",
    suppression: { k: 5, marker: "suprimido por privacidad", rule: "regla" },
    columns: [],
    rowCount: 1,
    suppressedCount: 0,
  },
  rows: [{ provincia: "Córdoba", codigo_iso: "AR-X", fallecimientos_registrados: 42 }],
};

function req(url: string): Request {
  return new Request(url);
}

function params(dataset: string) {
  return { params: Promise.resolve({ dataset }) };
}

beforeEach(() => {
  buildDataset.mockReset();
  buildDataset.mockResolvedValue(fakeBuilt);
  enforceRateLimit.mockReset();
  enforceRateLimit.mockResolvedValue(undefined);
});

describe("GET /transparencia/datos/[dataset]", () => {
  it("404s an unknown dataset slug and lists the valid ids", async () => {
    const res = await GET(req("https://x/transparencia/datos/nope"), params("nope"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("unknown_dataset");
    expect(body.datasets).toContain("mortalidad");
    expect(buildDataset).not.toHaveBeenCalled();
  });

  it("rate-limits unknown-id probing (429 before the 404) so enumeration is not free", async () => {
    // The limiter runs BEFORE slug validation: an unknown id under rate-limit
    // pressure gets 429, not a free 404. Guards against unknown-id scrape bursts.
    enforceRateLimit.mockRejectedValueOnce(new RateLimitError(new Date(), "test"));
    const res = await GET(req("https://x/transparencia/datos/nope"), params("nope"));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: "rate_limited" });
  });

  it("defaults to JSON with { meta, data } and metadata headers", async () => {
    const res = await GET(req("https://x/transparencia/datos/mortalidad"), params("mortalidad"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("X-License")).toBe("CC-BY-4.0");
    expect(res.headers.get("X-Methodology-Url")).toContain("/transparencia#metodologia");
    // Daily cache (24h) — audit fix, was 6h (21600).
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=86400");
    const body = await res.json();
    expect(body.meta.id).toBe("mortalidad");
    expect(body.data[0].fallecimientos_registrados).toBe(42);
  });

  it("serves CSV with an attachment filename when ?format=csv", async () => {
    const res = await GET(
      req("https://x/transparencia/datos/mortalidad?format=csv"),
      params("mortalidad"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="mortalidad.csv"');
    const text = await res.text();
    expect(text).toContain("# licencia:");
    expect(text).toContain("Córdoba,AR-X,42");
  });

  it("429s with a generic body when the per-IP rate limit is exceeded", async () => {
    enforceRateLimit.mockRejectedValueOnce(new RateLimitError(new Date(), "test"));
    const res = await GET(req("https://x/transparencia/datos/mortalidad"), params("mortalidad"));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: "rate_limited" });
    expect(res.headers.get("Retry-After")).toBe("60");
    // Rate limit is checked before the (cached) DB build runs.
    expect(buildDataset).not.toHaveBeenCalled();
  });

  it("500s with a generic body and no internal detail when the build fails", async () => {
    buildDataset.mockRejectedValueOnce(new Error("db exploded: connection refused at 10.0.0.5"));
    const res = await GET(req("https://x/transparencia/datos/mortalidad"), params("mortalidad"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "unavailable" });
    const text = JSON.stringify(body);
    expect(text).not.toContain("db exploded");
    expect(text).not.toContain("10.0.0.5");
  });
});
